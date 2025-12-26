/*---------------------------------------------------------------------------------------------
 *  日志读取和统计管理器
 *  读取JSONL格式的日志文件,计算统计数据
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './pathManager';
import { UsageParser } from './usageParser';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * 日志读取管理器
 * 读取JSONL文件并计算统计数据
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
        const mergedMap = this.mergeLogsByRequestId(logs);

        // 转换为数组并按时间戳倒序排序(最新的在前)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);

        return details;
    }

    /**
     * 获取最近的请求详情（性能优化版本）
     * 仅读取最近 N 条请求，避免在有大量日志时加载整个日期的数据
     * 用于状态栏等需要快速响应的场景
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        const logs = await this.readDateLogs(dateStr);
        const mergedMap = this.mergeLogsByRequestId(logs);

        // 转换为数组并按时间戳倒序排序(最新的在前)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);

        // 只返回最近的 limit 条
        return details.slice(0, limit);
    }

    /**
     * 获取指定小时的请求详情列表
     */
    async getHourRequestDetails(dateStr: string, hour: number): Promise<TokenRequestLog[]> {
        const logs = await this.readHourLogs(dateStr, hour);
        const mergedMap = this.mergeLogsByRequestId(logs);

        // 转换为数组并按时间戳倒序排序
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);

        return details;
    }

    /**
     * 统计指定小时的数据
     */
    async calculateHourStats(dateStr: string, hour: number): Promise<TokenUsageStatsFromFile> {
        const logs = await this.readHourLogs(dateStr, hour);
        return this.aggregateLogs(logs);
    }

    /**
     * 统计指定日期的数据
     */
    async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        const logs = await this.readDateLogs(dateStr);
        return this.aggregateLogs(logs);
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
        const cutoffDateStr = this.formatDate(cutoffDate);

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
            } catch (err) {
                StatusLogger.warn('[LogReadManager] 解析日志行失败,跳过', err);
            }
        }

        return logs;
    }

    /**
     * 合并同一requestId的多条流水记录,取最终状态
     * 保留最后一条记录的状态（completed/failed），但使用第一条记录的时间戳（请求开始时间）
     * @param logs 流水记录列表
     * @returns 按requestId合并后的记录Map
     */
    private mergeLogsByRequestId(logs: TokenRequestLog[]): Map<string, TokenRequestLog> {
        const mergedMap = new Map<string, TokenRequestLog>();

        for (const log of logs) {
            const existing = mergedMap.get(log.requestId);

            if (!existing) {
                // 第一次遇到此requestId，记录初始时间戳
                mergedMap.set(log.requestId, { ...log });
            } else {
                // 已存在，保留时间戳更早的（请求开始时间），但更新其他字段为最新状态
                if (log.timestamp < existing.timestamp) {
                    // 当前记录时间戳更早，更新时间戳但保留其他字段
                    existing.timestamp = log.timestamp;
                    existing.isoTime = log.isoTime;
                }
                // 无论时间戳如何，都更新为最新状态（completed/failed 和 rawUsage）
                existing.status = log.status;
                existing.rawUsage = log.rawUsage;
            }
        }

        return mergedMap;
    }

    /**
     * 聚合日志为统计数据
     * 1. 先按requestId合并流水记录,取最终状态
     * 2. 只统计成功(completed)的请求
     * 3. 从 rawUsage 解析 token 统计
     */
    private aggregateLogs(logs: TokenRequestLog[]): TokenUsageStatsFromFile {
        const stats: TokenUsageStatsFromFile = {
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

        // 1. 按requestId合并,取最终状态
        const mergedMap = this.mergeLogsByRequestId(logs);
        const finalLogs = Array.from(mergedMap.values());

        // 2. 遍历合并后的日志
        for (const log of finalLogs) {
            // 统计所有请求的状态
            stats.total.requests++;

            if (log.status === 'completed') {
                stats.total.completedRequests++;
            } else if (log.status === 'failed') {
                stats.total.failedRequests++;
            }

            // 只统计成功的请求到token用量
            if (log.status !== 'completed' || !log.rawUsage) {
                // 如果没有 rawUsage，使用预估的 input
                if (log.status === 'completed') {
                    stats.total.estimatedInput += log.estimatedInput;
                    stats.total.actualInput += log.estimatedInput;
                }
                continue;
            }

            // 从 rawUsage 解析 token 统计
            const parsed = UsageParser.parseFromLog(log);

            // 更新总计(仅成功的请求)
            stats.total.estimatedInput += log.estimatedInput;
            stats.total.actualInput += parsed.actualInput;
            stats.total.cacheTokens += parsed.cacheReadTokens;
            stats.total.outputTokens += parsed.outputTokens;

            // 按提供商聚合(仅成功的请求)
            if (!stats.providers[log.providerKey]) {
                stats.providers[log.providerKey] = {
                    providerName: log.providerName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    models: {}
                };
            }

            const providerStats = stats.providers[log.providerKey];
            providerStats.estimatedInput += log.estimatedInput;
            providerStats.actualInput += parsed.actualInput;
            providerStats.cacheTokens += parsed.cacheReadTokens;
            providerStats.outputTokens += parsed.outputTokens;
            providerStats.requests++;

            // 按模型聚合(仅成功的请求)
            if (!providerStats.models[log.modelId]) {
                providerStats.models[log.modelId] = {
                    modelName: log.modelName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0
                };
            }

            const modelStats = providerStats.models[log.modelId];
            modelStats.estimatedInput += log.estimatedInput;
            modelStats.actualInput += parsed.actualInput;
            modelStats.cacheTokens += parsed.cacheReadTokens;
            modelStats.outputTokens += parsed.outputTokens;
            modelStats.requests++;
        }

        return stats;
    }

    /**
     * 格式化日期为 YYYY-MM-DD
     */
    private formatDate(date: Date): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
}
