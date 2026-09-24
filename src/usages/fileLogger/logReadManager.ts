/*---------------------------------------------------------------------------------------------
 *  日志读取管理器
 *  读取JSONL格式的日志文件,负责所有文件 I/O 操作
 *  统计计算逻辑已迁移到 StatsCalculator
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { LogPathManager } from './logPathManager';
import { DateUtils } from './dateUtils';
import { canReuseHourlyDetailsCache } from './hourlyCachePolicy';
import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';

/**
 * 日志读取管理器
 * 只负责文件 I/O，统计计算委托给 StatsCalculator
 */
export class LogReadManager {
    private static readonly MAX_HOUR_DETAILS_CACHE_ENTRIES = 48;
    private readonly pathManager: LogPathManager;
    private readonly hourDetailsCache = new Map<string, { mtime: number; details: TokenRequestLog[] }>();
    private cacheGeneration = 0;
    private disposed = false;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    invalidateDateCache(dateStr: string): void {
        this.cacheGeneration += 1;
        const prefix = `${dateStr}:`;
        for (const cacheKey of this.hourDetailsCache.keys()) {
            if (cacheKey.startsWith(prefix)) {
                this.hourDetailsCache.delete(cacheKey);
            }
        }
    }

    clearCache(): void {
        this.cacheGeneration += 1;
        this.hourDetailsCache.clear();
    }

    dispose(): void {
        this.disposed = true;
        this.clearCache();
    }

    /**
     * 读取指定小时的所有日志
     */
    async readHourLogs(dateStr: string, hour: number, throwOnFailure = false): Promise<TokenRequestLog[]> {
        const filePath = this.pathManager.getHourFilePath(dateStr, hour);
        if (!throwOnFailure && !fsSync.existsSync(filePath)) {
            return [];
        }

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return this.parseJsonlContent(content);
        } catch (err) {
            StatusLogger.error(`[LogReadManager] Failed to read hourly log: ${filePath}`, err);
            if (throwOnFailure) {
                throw err;
            }
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
            const hourFiles = files.filter(f => /^\d{2}\.jsonl$/.test(f)).sort();
            // 并行读取所有文件
            const readPromises = hourFiles.map(file => {
                const filePath = path.join(dateFolder, file);
                return fs
                    .readFile(filePath, 'utf-8')
                    .then(content => this.parseJsonlContent(content))
                    .catch(err => {
                        StatusLogger.warn(`[LogReadManager] Failed to read hourly log: ${filePath}`, err);
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
            StatusLogger.error(`[LogReadManager] Failed to read daily logs: ${dateFolder}`, err);
            return [];
        }
    }

    /**
     * 获取请求详情列表(合并后的最终状态)
     * 用于详情页面展示
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return [];
        }

        const startTime = Date.now();
        const reuseStats = { reusedHours: 0, recomputedHours: 0 };
        const cacheGeneration = this.cacheGeneration;

        const hourFiles = await this.listHourFiles(dateFolder);
        const mergedHourDetails = await Promise.all(
            hourFiles.map(file => {
                const hour = parseInt(path.basename(file, '.jsonl'), 10);
                return this.readHourDetails(dateStr, hour, file, reuseStats, cacheGeneration);
            })
        );

        const logs = mergedHourDetails.flat();
        const mergedMap = StatsCalculator.mergeLogsByRequestId(logs);
        // 转换为数组并按时间戳倒序排序(最新的在前)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);
        StatusLogger.trace(
            `[LogReadManager] getRequestDetails(${dateStr}) hours=${hourFiles.length}, reused=${reuseStats.reusedHours}, recomputed=${reuseStats.recomputedHours}, requests=${details.length}, elapsed=${Date.now() - startTime}ms`
        );
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
            const startTime = Date.now();
            const reuseStats = { reusedHours: 0, recomputedHours: 0 };
            const cacheGeneration = this.cacheGeneration;
            // 从最新的小时开始反向读取
            for (let hour = startHour; hour >= 0 && logs.length < limit; hour--) {
                const filePath = this.pathManager.getHourFilePath(dateStr, hour);
                const hourDetails = await this.readHourDetails(
                    dateStr,
                    hour,
                    filePath,
                    reuseStats,
                    cacheGeneration,
                    true
                );
                if (hourDetails.length === 0) {
                    continue;
                }

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
            const result = logs.slice(0, limit);
            StatusLogger.trace(
                `[LogReadManager] getRecentRequestDetails(${dateStr}, ${limit}) reused=${reuseStats.reusedHours}, recomputed=${reuseStats.recomputedHours}, scanned=${logs.length}, returned=${result.length}, elapsed=${Date.now() - startTime}ms`
            );
            return result;
        } catch (err) {
            StatusLogger.error(`[LogReadManager] Failed to get recent request details: ${dateStr}`, err);
            return [];
        }
    }

    private async listHourFiles(dateFolder: string): Promise<string[]> {
        const files = await fs.readdir(dateFolder);
        return files
            .filter(f => /^\d{2}\.jsonl$/.test(f))
            .sort()
            .map(file => path.join(dateFolder, file));
    }

    private async readHourDetails(
        dateStr: string,
        hour: number,
        filePath: string,
        reuseStats: { reusedHours: number; recomputedHours: number },
        cacheGeneration: number,
        skipReadFailure = false
    ): Promise<TokenRequestLog[]> {
        if (!fsSync.existsSync(filePath)) {
            if (!skipReadFailure) {
                throw new Error(`Hourly log disappeared before reading: ${filePath}`);
            }
            return [];
        }

        const cacheKey = `${dateStr}:${hour}`;
        const sourceMtime = fsSync.statSync(filePath).mtimeMs;
        const cached = this.hourDetailsCache.get(cacheKey);
        if (cached && canReuseHourlyDetailsCache(cached.mtime, sourceMtime)) {
            this.hourDetailsCache.delete(cacheKey);
            this.hourDetailsCache.set(cacheKey, cached);
            if (reuseStats) {
                reuseStats.reusedHours += 1;
            }
            return cached.details;
        }

        let hourLogs: TokenRequestLog[];
        try {
            hourLogs = await this.readHourLogs(dateStr, hour, true);
        } catch (err) {
            if (!skipReadFailure) {
                throw err;
            }
            return [];
        }
        const mergedMap = StatsCalculator.mergeLogsByRequestId(hourLogs);
        const details = Array.from(mergedMap.values());
        if (this.disposed || this.cacheGeneration !== cacheGeneration) {
            if (reuseStats) {
                reuseStats.recomputedHours += 1;
            }
            return details;
        }
        this.hourDetailsCache.delete(cacheKey);
        this.hourDetailsCache.set(cacheKey, { mtime: sourceMtime, details });
        while (this.hourDetailsCache.size > LogReadManager.MAX_HOUR_DETAILS_CACHE_ENTRIES) {
            const oldestKey = this.hourDetailsCache.keys().next().value;
            if (typeof oldestKey !== 'string') {
                break;
            }
            this.hourDetailsCache.delete(oldestKey);
        }
        if (reuseStats) {
            reuseStats.recomputedHours += 1;
        }
        return details;
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
