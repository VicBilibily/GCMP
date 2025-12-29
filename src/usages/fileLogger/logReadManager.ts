/*---------------------------------------------------------------------------------------------
 *  日志读取管理器
 *  读取JSONL格式的日志文件,负责所有文件 I/O 操作
 *  统计计算逻辑已迁移到 StatsCalculator
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { DateUtils } from './dateUtils';
import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';

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
    async readHourLogs(dateStr: string, hour: number): Promise<TokenRequestLog[]> {
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
        const today = DateUtils.getTodayDateString();
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
     * 获取小时日志文件的修改时间戳（毫秒）
     * 如果文件不存在，返回 0
     */
    async getHourFileModifiedTime(dateStr: string, hour: number): Promise<number> {
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
}
