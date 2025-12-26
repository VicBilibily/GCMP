/*---------------------------------------------------------------------------------------------
 *  日志读取管理器
 *  读取JSONL格式的日志文件,负责所有文件 I/O 操作
 *  统计计算逻辑已迁移到 StatsCalculator
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './pathManager';
import { DateUtils } from './dateUtils';
import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * 日志读取管理器
 * 只负责文件 I/O，统计计算委托给 StatsCalculator
 */
export class LogReadManager {
    private readonly pathManager: LogPathManager;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    /**
     * 读取指定小时的所有日志
     */
    private async readHourLogs(dateStr: string, hour: number): Promise<TokenRequestLog[]> {
        const filePath = this.pathManager.getHourFilePath(dateStr, hour);
        if (!fsSync.existsSync(filePath)) {
            return [];
        }

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return this.parseJsonlContent(content);
        } catch (err) {
            StatusLogger.error(`[LogReadManager] 读取小时日志失败: ${filePath}`, err);
            return [];
        }
    }

    /**
     * 读取指定日期的所有日志
     * 优化：使用 Promise.all 并行读取所有小时文件
     */
    async readDateLogs(dateStr: string): Promise<TokenRequestLog[]> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return [];
        }

        try {
            const files = await fs.readdir(dateFolder);
            const hourFiles = files.filter(f => f.endsWith('.jsonl')).sort();
            // 并行读取所有文件
            const readPromises = hourFiles.map(file => {
                const filePath = path.join(dateFolder, file);
                return fs
                    .readFile(filePath, 'utf-8')
                    .then(content => this.parseJsonlContent(content))
                    .catch(err => {
                        StatusLogger.warn(`[LogReadManager] 读取小时日志失败: ${filePath}`, err);
                        return [];
                    });
            });

            const allLogsArrays = await Promise.all(readPromises);
            const allLogs: TokenRequestLog[] = [];
            for (const logs of allLogsArrays) {
                allLogs.push(...logs);
            }
            return allLogs;
        } catch (err) {
            StatusLogger.error(`[LogReadManager] 读取日期日志失败: ${dateFolder}`, err);
            return [];
        }
    }

    /**
     * 获取请求详情列表(合并后的最终状态)
     * 用于详情页面展示
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        const logs = await this.readDateLogs(dateStr);
        const mergedMap = StatsCalculator.mergeLogsByRequestId(logs);
        // 转换为数组并按时间戳倒序排序(最新的在前)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);
        return details;
    }

    /**
     * 获取最近的请求详情（性能优化版本）
     * 只读取最近的 N 条请求，避免在有大量日志时加载整个日期的数据
     * 用于状态栏等需要快速响应的场景
     * 优化策略：从最新的小时开始反向读取，找到足够的记录就停止
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        const now = new Date();
        const currentHour = now.getHours();
        const today = this.pathManager.getTodayDateString();
        const isToday = dateStr === today;

        // 获取需要检查的小时范围
        // 如果是今天，从当前小时开始；否则从 23 小时开始
        const startHour = isToday ? currentHour : 23;
        const logs: TokenRequestLog[] = [];
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return [];
        }

        try {
            // 从最新的小时开始反向读取
            for (let hour = startHour; hour >= 0 && logs.length < limit; hour--) {
                const hourLogs = await this.readHourLogs(dateStr, hour);
                if (hourLogs.length === 0) {
                    continue;
                }

                // 合并日志
                const mergedMap = StatsCalculator.mergeLogsByRequestId(hourLogs);
                const hourDetails = Array.from(mergedMap.values());
                // 合并到结果中
                logs.push(...hourDetails);
                // 如果已经收集了足够多的记录，提前结束
                if (logs.length >= limit) {
                    break;
                }
            }

            // 按时间戳倒序排序（最新的在前）
            logs.sort((a, b) => b.timestamp - a.timestamp);
            // 只返回最近的 limit 条
            return logs.slice(0, limit);
        } catch (err) {
            StatusLogger.error(`[LogReadManager] 获取最近请求详情失败: ${dateStr}`, err);
            return [];
        }
    }

    /**
     * 统计指定日期的数据
     */
    async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        const logs = await this.readDateLogs(dateStr);
        return StatsCalculator.aggregateLogs(logs);
    }

    /**
     * 一次性计算指定日期的小时和日期统计
     * 优化：只读取一次日期的所有日志，然后分别计算小时和日期统计
     * 支持增量更新：根据小时文件的修改时间戳判断是否需要重新计算
     * 返回: [小时统计, 日期统计, 更新后的hourlyModified时间戳]
     */
    async calculateHourAndDateStats(
        dateStr: string,
        hour: number,
        existingHourlyModified?: Record<string, number>
    ): Promise<[TokenUsageStatsFromFile, TokenUsageStatsFromFile, Record<string, number>]> {
        // 获取小时文件的修改时间戳
        const hourKey = String(hour).padStart(2, '0');
        const hourFileModified = await this.getHourFileModifiedTime(dateStr, hour);
        const existingModified = existingHourlyModified?.[hourKey];

        // 检查时间戳：如果一致，说明文件未改变，可以跳过此小时的计算
        let hourStats: TokenUsageStatsFromFile;

        if (existingModified !== undefined && existingModified === hourFileModified) {
            // 时间戳一致，跳过计算，使用空统计
            StatusLogger.debug(`[LogReadManager] 小时文件未改变，跳过计算: ${dateStr} ${hourKey}:00`);
            hourStats = {
                total: {
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    completedRequests: 0,
                    failedRequests: 0
                },
                providers: {}
            };
        } else {
            // 时间戳不一致或不存在，需要读取并计算
            const logs = await this.readHourLogs(dateStr, hour);
            hourStats = StatsCalculator.aggregateLogs(logs);
        }

        // 一次性读取整个日期的所有日志
        const allDateLogs = await this.readDateLogs(dateStr);

        // 计算日期统计
        const dateStats = StatsCalculator.aggregateLogs(allDateLogs);

        // 更新 hourlyModified 时间戳
        const updatedHourlyModified = {
            ...existingHourlyModified,
            [hourKey]: hourFileModified
        };

        return [hourStats, dateStats, updatedHourlyModified];
    }

    /**
     * 获取所有日期列表
     */
    async getAllDates(): Promise<string[]> {
        const baseDir = this.pathManager.getBaseDir();

        if (!fsSync.existsSync(baseDir)) {
            return [];
        }

        try {
            const entries = await fs.readdir(baseDir, { withFileTypes: true });
            const dates = entries
                .filter(entry => entry.isDirectory())
                .map(entry => entry.name)
                .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
                .sort()
                .reverse(); // 倒序(最新的在前)

            return dates;
        } catch (err) {
            StatusLogger.error('[LogReadManager] 获取日期列表失败', err);
            return [];
        }
    }

    /**
     * 删除指定日期的所有日志文件
     */
    async deleteDateLogs(dateStr: string): Promise<number> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);

        if (!fsSync.existsSync(dateFolder)) {
            return 0;
        }

        try {
            const files = await fs.readdir(dateFolder);
            const count = files.length;

            // 删除整个文件夹
            await fs.rm(dateFolder, { recursive: true, force: true });

            StatusLogger.info(`[LogReadManager] 已删除日期日志: ${dateStr} (${count} 个文件)`);
            return count;
        } catch (err) {
            StatusLogger.error(`[LogReadManager] 删除日期日志失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 清理过期日志(保留最近N天)
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        if (retentionDays === 0) {
            return 0; // 永久保留
        }

        const allDates = await this.getAllDates();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = DateUtils.formatDate(cutoffDate);

        let deletedCount = 0;

        for (const dateStr of allDates) {
            if (dateStr < cutoffDateStr) {
                const count = await this.deleteDateLogs(dateStr);
                deletedCount += count;
            }
        }

        return deletedCount;
    }

    // ==================== Private Helper Methods ====================

    /**
     * 解析JSONL内容
     * 同一requestId可能有多条记录,返回所有流水记录
     */
    private parseJsonlContent(content: string): TokenRequestLog[] {
        const lines = content.split('\n').filter(line => line.trim());
        const logs: TokenRequestLog[] = [];
        for (const line of lines) {
            try {
                const log = JSON.parse(line) as TokenRequestLog;
                logs.push(log);
            } catch {
                // StatusLogger.warn('[LogReadManager] 解析日志行失败,跳过', err);
            }
        }
        return logs;
    }

    /**
     * 获取小时日志文件的修改时间戳（毫秒）
     * 如果文件不存在，返回 0
     */
    private async getHourFileModifiedTime(dateStr: string, hour: number): Promise<number> {
        const filePath = this.pathManager.getHourFilePath(dateStr, hour);

        if (!fsSync.existsSync(filePath)) {
            return 0;
        }

        try {
            const stats = await fs.stat(filePath);
            return stats.mtime.getTime();
        } catch (err) {
            StatusLogger.warn(`[LogReadManager] 获取文件修改时间失败: ${filePath}`, err);
            return 0;
        }
    }
}
