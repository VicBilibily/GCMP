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
import { canReuseHourlyDetailsCache } from './hourlyCachePolicy';
import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';
import {
    normalizeRequestClassification,
    normalizeRequestContinuity
} from '../../handlers/classification/requestClassification';

/**
 * 日志读取管理器
 * 只负责文件 I/O，统计计算委托给 StatsCalculator
 */
export class LogReadManager {
    private static readonly MAX_HOUR_DETAILS_CACHE_ENTRIES = 48;
    private static readonly MAX_HOUR_DETAILS_CACHE_RECORDS = 30_000;
    private static readonly HOUR_DETAILS_READ_CONCURRENCY = 4;
    private readonly pathManager: LogPathManager;
    private readonly hourDetailsCache = new Map<string, { mtime: number; details: TokenRequestLog[] }>();
    private cachedHourDetailsRecords = 0;
    private cacheGeneration = 0;
    private disposed = false;

    constructor(pathManager: LogPathManager) {
        this.pathManager = pathManager;
    }

    invalidateHourCache(dateStr: string, hour: number): void {
        this.cacheGeneration += 1;
        this.deleteHourDetailsCacheEntry(`${dateStr}:${hour}`);
    }

    invalidateDateCache(dateStr: string): void {
        this.cacheGeneration += 1;
        const prefix = `${dateStr}:`;
        for (const cacheKey of this.hourDetailsCache.keys()) {
            if (cacheKey.startsWith(prefix)) {
                this.deleteHourDetailsCacheEntry(cacheKey);
            }
        }
    }

    clearCache(): void {
        this.cacheGeneration += 1;
        this.hourDetailsCache.clear();
        this.cachedHourDetailsRecords = 0;
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

    async findLatestRequestLog(dateStr: string, requestId: string): Promise<TokenRequestLog | undefined> {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return undefined;
        }

        for (const file of (await this.listHourFiles(dateFolder)).reverse()) {
            const hour = parseInt(path.basename(file, '.jsonl'), 10);
            const logs = await this.readHourLogs(dateStr, hour, true);
            for (let index = logs.length - 1; index >= 0; index--) {
                if (logs[index].requestId === requestId) {
                    return logs[index];
                }
            }
        }
        return undefined;
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
        const protectedCacheKeys = new Set<string>();
        const hourDetailsByIndex = new Array<TokenRequestLog[] | undefined>(hourFiles.length);
        const indexedFiles = hourFiles.map((file, index) => ({ file, index })).reverse();
        for (let offset = 0; offset < indexedFiles.length; offset += LogReadManager.HOUR_DETAILS_READ_CONCURRENCY) {
            const batch = indexedFiles.slice(offset, offset + LogReadManager.HOUR_DETAILS_READ_CONCURRENCY);
            const batchDetails = await Promise.all(
                batch.map(({ file }) => {
                    const hour = parseInt(path.basename(file, '.jsonl'), 10);
                    return this.readHourDetails(dateStr, hour, file, reuseStats, cacheGeneration, protectedCacheKeys);
                })
            );
            for (let index = 0; index < batch.length; index++) {
                hourDetailsByIndex[batch[index].index] = batchDetails[index];
            }
        }

        const logs: TokenRequestLog[] = [];
        for (let index = 0; index < hourDetailsByIndex.length; index++) {
            const hourDetails = hourDetailsByIndex[index] ?? [];
            hourDetailsByIndex[index] = undefined;
            for (const detail of hourDetails) {
                logs.push(detail);
            }
        }
        const mergedMap = StatsCalculator.mergeLogsByRequestId(logs);
        // 转换为数组并按时间戳倒序排序(最新的在前)
        const details = Array.from(mergedMap.values());
        details.sort((a, b) => b.timestamp - a.timestamp);
        StatusLogger.trace(
            `[LogReadManager] getRequestDetails(${dateStr}) hours=${hourFiles.length}, reused=${reuseStats.reusedHours}, recomputed=${reuseStats.recomputedHours}, requests=${details.length}, elapsed=${Date.now() - startTime}ms`
        );
        return details;
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
        protectedCacheKeys: Set<string>
    ): Promise<TokenRequestLog[]> {
        if (!fsSync.existsSync(filePath)) {
            throw new Error(`Hourly log disappeared before reading: ${filePath}`);
        }

        const cacheKey = `${dateStr}:${hour}`;
        const sourceMtime = fsSync.statSync(filePath).mtimeMs;
        const cached = this.hourDetailsCache.get(cacheKey);
        if (cached && canReuseHourlyDetailsCache(cached.mtime, sourceMtime)) {
            this.hourDetailsCache.delete(cacheKey);
            this.hourDetailsCache.set(cacheKey, cached);
            protectedCacheKeys.add(cacheKey);
            if (reuseStats) {
                reuseStats.reusedHours += 1;
            }
            return cached.details;
        }

        const hourLogs = await this.readHourLogs(dateStr, hour, true);
        const mergedMap = StatsCalculator.mergeLogsByRequestId(hourLogs);
        const details = Array.from(mergedMap.values());
        if (this.disposed || this.cacheGeneration !== cacheGeneration) {
            if (reuseStats) {
                reuseStats.recomputedHours += 1;
            }
            return details;
        }
        this.deleteHourDetailsCacheEntry(cacheKey);
        while (
            this.hourDetailsCache.size + 1 > LogReadManager.MAX_HOUR_DETAILS_CACHE_ENTRIES ||
            this.cachedHourDetailsRecords + details.length > LogReadManager.MAX_HOUR_DETAILS_CACHE_RECORDS
        ) {
            const oldestKey = this.findOldestUnprotectedCacheKey(protectedCacheKeys);
            if (!oldestKey) {
                if (reuseStats) {
                    reuseStats.recomputedHours += 1;
                }
                return details;
            }
            this.deleteHourDetailsCacheEntry(oldestKey);
        }
        this.hourDetailsCache.set(cacheKey, { mtime: sourceMtime, details });
        this.cachedHourDetailsRecords += details.length;
        protectedCacheKeys.add(cacheKey);
        if (reuseStats) {
            reuseStats.recomputedHours += 1;
        }
        return details;
    }

    private deleteHourDetailsCacheEntry(cacheKey: string): void {
        const cached = this.hourDetailsCache.get(cacheKey);
        if (!cached) {
            return;
        }
        this.hourDetailsCache.delete(cacheKey);
        this.cachedHourDetailsRecords -= cached.details.length;
    }

    private findOldestUnprotectedCacheKey(protectedCacheKeys: ReadonlySet<string>): string | undefined {
        for (const cacheKey of this.hourDetailsCache.keys()) {
            if (!protectedCacheKeys.has(cacheKey)) {
                return cacheKey;
            }
        }
        return undefined;
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
                log.requestClassification = normalizeRequestClassification(log.requestClassification);
                log.requestContinuity = normalizeRequestContinuity(log.requestContinuity);
                logs.push(log);
            } catch {
                // StatusLogger.warn('[LogReadManager] 解析日志行失败,跳过', err);
            }
        }
        return logs;
    }
}
