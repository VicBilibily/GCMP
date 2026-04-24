/*---------------------------------------------------------------------------------------------
 *  日志索引管理器
 *  负责 index.json 的读取、写入、更新和重建
 *  索引文件路径: <baseDir>/usages/index.json
 *  用于快速浏览日期列表，无需加载每个日期的完整统计
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { AtomicJsonFile } from '../atomicJsonFile';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile, TokenStats } from './types';

/**
 * 日志索引管理器
 * 管理 index.json 文件的读写操作
 */
export class LogIndexManager {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

    /**
     * 获取索引文件路径
     * 路径: <baseDir>/usages/index.json
     */
    getIndexPath(): string {
        return path.join(this.baseDir, 'index.json');
    }

    /**
     * 获取缓存时间戳信息
     * @returns 版本时间戳和缓存创建时间戳
     */
    async getCacheTimestamps(): Promise<{ versionTimestamp: number | null; cacheTimestamp: number | null }> {
        const index = await this.readIndex();
        if (!index) {
            return { versionTimestamp: null, cacheTimestamp: null };
        }
        return {
            versionTimestamp: index.versionTimestamp ?? null,
            cacheTimestamp: index.cacheTimestamp ?? null
        };
    }

    /**
     * 设置缓存时间戳
     * 同时设置版本时间戳和缓存创建时间戳
     * @param versionTimestamp 代码版本时间戳
     * @param cacheTimestamp 缓存创建时间戳（通常为 Date.now()）
     */
    async setCacheTimestamps(versionTimestamp: number, cacheTimestamp: number): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = (await this.readIndexFile(indexPath)) ?? { dates: {} };

                index.versionTimestamp = versionTimestamp;
                index.cacheTimestamp = cacheTimestamp;

                await this.saveIndexUnlocked(indexPath, index);
            });

            StatusLogger.debug(
                `[LogIndexManager] 已更新缓存时间戳: version=${new Date(versionTimestamp).toISOString()}, cache=${new Date(cacheTimestamp).toISOString()}`
            );
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] 设置缓存时间戳失败', err);
            throw err;
        }
    }

    /**
     * 读取日期索引
     * 用于快速获取所有日期的摘要信息
     */
    private async readIndex(): Promise<DateIndex | null> {
        const indexPath = this.getIndexPath();
        return this.readIndexFile(indexPath);
    }

    private async readIndexFile(indexPath: string): Promise<DateIndex | null> {
        if (!fsSync.existsSync(indexPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);
            StatusLogger.debug(`[LogIndexManager] 已读取日期索引，共 ${Object.keys(index.dates).length} 个日期`);
            return index;
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] 读取日期索引失败', err);
            return null;
        }
    }

    private async saveIndexUnlocked(indexPath: string, index: DateIndex): Promise<void> {
        try {
            // 确保基础目录存在
            await this.ensureDirectoryExists(this.baseDir);

            // 写入索引文件
            await AtomicJsonFile.writeJsonAtomically(indexPath, index);
            StatusLogger.debug(`[LogIndexManager] 已保存日期索引，共 ${Object.keys(index.dates).length} 个日期`);
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] 保存日期索引失败', err);
            throw err;
        }
    }

    private buildDateIndexEntry(total: TokenStats): DateIndexEntry {
        return {
            total_input: total.actualInput,
            total_cache: total.cacheTokens,
            total_output: total.outputTokens,
            total_requests: total.requests
        };
    }

    private isSameDateIndexEntry(left: DateIndexEntry | undefined, right: DateIndexEntry): boolean {
        return (
            !!left &&
            left.total_input === right.total_input &&
            left.total_cache === right.total_cache &&
            left.total_output === right.total_output &&
            left.total_requests === right.total_requests
        );
    }

    /**
     * 更新日期索引
     * 在保存统计数据后调用，更新索引文件
     */
    async updateIndex(dateStr: string, total: TokenStats): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = (await this.readIndexFile(indexPath)) ?? { dates: {} };

                index.dates[dateStr] = this.buildDateIndexEntry(total);

                await this.saveIndexUnlocked(indexPath, index);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 更新日期索引失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 从索引中删除指定日期
     * 在删除统计数据后调用
     */
    async removeDate(dateStr: string): Promise<void> {
        const indexPath = this.getIndexPath();
        if (!fsSync.existsSync(indexPath)) {
            return;
        }

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = await this.readIndexFile(indexPath);
                if (!index?.dates[dateStr]) {
                    return;
                }

                delete index.dates[dateStr];
                await this.saveIndexUnlocked(indexPath, index);
                StatusLogger.debug(`[LogIndexManager] 已从索引中删除日期: ${dateStr}`);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 从索引中删除日期失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 获取所有日期的摘要信息
     * 自动同步索引与实际日期文件夹，添加缺失的日期，移除不存在的日期
     */
    async getIndex(): Promise<Record<string, DateIndexEntry>> {
        const indexPath = this.getIndexPath();

        return AtomicJsonFile.runExclusive(indexPath, async () => {
            // 获取所有实际的日期文件夹
            const actualDates = await this.getAllStatsDates();
            const actualDateSet = new Set(actualDates);

            // 读取现有索引
            const index = await this.readIndexFile(indexPath);
            const summaries: Record<string, DateIndexEntry> = {};
            let hasChanges = false;

            // 基于实际 stats.json 对账全部索引条目，修复先前更新失败留下的脏摘要
            for (const dateStr of actualDates) {
                actualDateSet.delete(dateStr);

                try {
                    const stats = await this.loadStats(dateStr);
                    if (!stats) {
                        continue;
                    }

                    const actualEntry = this.buildDateIndexEntry(stats.total);
                    const indexedEntry = index?.dates[dateStr];
                    summaries[dateStr] = actualEntry;

                    if (!this.isSameDateIndexEntry(indexedEntry, actualEntry)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] 日期摘要已对账修复: ${dateStr}`);
                    }
                } catch (err) {
                    StatusLogger.warn(`[LogIndexManager] 获取日期摘要失败: ${dateStr}`, err);
                }
            }

            if (index) {
                // 验证索引中的日期条目：移除目录不存在或 stats.json 缺失的脏条目
                for (const dateStr of Object.keys(index.dates)) {
                    // 已通过对账覆盖的条目无需再检
                    if (dateStr in summaries) {
                        continue;
                    }

                    const dateFolder = path.join(this.baseDir, dateStr);
                    if (!fsSync.existsSync(dateFolder)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] 索引中的日期文件夹不存在，已移除: ${dateStr}`);
                        continue;
                    }

                    // 目录在但 stats.json 缺失或不可读，也属于脏条目
                    const statsFile = path.join(dateFolder, 'stats.json');
                    if (!fsSync.existsSync(statsFile)) {
                        hasChanges = true;
                        StatusLogger.debug(`[LogIndexManager] 索引中日期的 stats.json 缺失，已移除: ${dateStr}`);
                    }
                }
            }

            // 如果有变化（新增或删除），更新索引文件
            if (hasChanges) {
                const nextIndex: DateIndex = { dates: summaries };
                if (index?.versionTimestamp !== undefined) {
                    nextIndex.versionTimestamp = index.versionTimestamp;
                }
                if (index?.cacheTimestamp !== undefined) {
                    nextIndex.cacheTimestamp = index.cacheTimestamp;
                }
                await this.saveIndexUnlocked(indexPath, nextIndex);
            }

            return summaries;
        });
    }

    /**
     * 获取所有已保存的日期列表
     */
    private async getAllStatsDates(): Promise<string[]> {
        if (!fsSync.existsSync(this.baseDir)) {
            return [];
        }

        try {
            // 读取所有日期目录
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
            const dates: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // 检查是否是有效的日期格式
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        // 检查该日期目录下是否有统计文件
                        const statsFile = path.join(this.baseDir, dateStr, 'stats.json');
                        if (fsSync.existsSync(statsFile)) {
                            dates.push(dateStr);
                        }
                    }
                }
            }

            return dates.sort().reverse(); // 倒序(最新的在前)
        } catch (err) {
            StatusLogger.error('[LogIndexManager] 获取统计日期列表失败', err);
            return [];
        }
    }

    /**
     * 加载日期统计
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const statsPath = path.join(this.baseDir, dateStr, 'stats.json');
        if (!fsSync.existsSync(statsPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(statsPath, 'utf-8');
            return JSON.parse(content) as TokenUsageStatsFromFile;
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] 读取日期统计失败: ${dateStr}`, err);
            return null;
        }
    }

    /**
     * 确保目录存在(递归创建)
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            // 同步检查避免竞态条件
            if (!fsSync.existsSync(dirPath)) {
                await fs.mkdir(dirPath, { recursive: true });
                StatusLogger.debug(`[LogIndexManager] 创建目录: ${dirPath}`);
            }
        } catch (err) {
            // 忽略已存在错误
            const error = err as NodeJS.ErrnoException;
            if (error.code !== 'EEXIST') {
                throw err;
            }
        }
    }
}
