/*---------------------------------------------------------------------------------------------
 *  日志索引管理器
 *  负责 index.json 的读取、写入、更新和重建
 *  索引文件路径: <baseDir>/usages/index.json
 *  用于快速浏览日期列表，无需加载每个日期的完整统计
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { AtomicJsonFile } from '../atomicJsonFile';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile, TokenStats } from './types';

/**
 * 日志索引管理器
 * 管理 index.json 文件的读写操作
 */
export class LogIndexManager {
    private readonly baseDir: string;
    private needsRecovery = false;
    private hasPartialIndex = false;

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
     * 获取代码版本时间戳
     * @returns 版本时间戳，不存在时返回 null
     */
    async getVersionTimestamp(): Promise<number | null> {
        const indexPath = this.getIndexPath();
        // 与写入共用同一文件的串行锁，避免 rename 时被本进程 readFile 句柄占用导致 EPERM
        const index = await AtomicJsonFile.runExclusive(indexPath, () => this.readIndexFile(indexPath));
        if (!index) {
            return null;
        }
        return index.versionTimestamp ?? null;
    }

    /**
     * 设置代码版本时间戳
     * @param versionTimestamp 代码版本时间戳
     */
    async setVersionTimestamp(versionTimestamp: number): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                let index = await this.readIndexFile(indexPath);
                if (!index) {
                    index = { dates: {} };
                    this.hasPartialIndex = true;
                }

                index.versionTimestamp = versionTimestamp;

                await this.saveIndexUnlocked(indexPath, index);
            });

            StatusLogger.debug(
                `[LogIndexManager] Updated version timestamp: ${new Date(versionTimestamp).toISOString()}`
            );
        } catch (err) {
            StatusLogger.warn('[LogIndexManager] Failed to set version timestamp', err);
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
        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);
            if (!index?.dates || typeof index.dates !== 'object' || Array.isArray(index.dates)) {
                throw new Error('Invalid date index');
            }
            for (const entry of Object.values(index.dates)) {
                if (
                    !entry ||
                    typeof entry !== 'object' ||
                    Array.isArray(entry) ||
                    ![
                        entry.total_input,
                        entry.total_cache,
                        entry.total_output,
                        entry.total_requests,
                        entry.total_cost
                    ].every(Number.isFinite) ||
                    [entry.total_cost_rmb, entry.native_total_cost, entry.native_total_cost_rmb].some(
                        value => value !== undefined && !Number.isFinite(value)
                    )
                ) {
                    throw new Error('Invalid date index entry');
                }
            }
            StatusLogger.debug(`[LogIndexManager] Read date index with ${Object.keys(index.dates).length} dates`);
            return index;
        } catch (err) {
            this.needsRecovery = true;
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                StatusLogger.warn('[LogIndexManager] Failed to read date index', err);
            }
            return null;
        }
    }

    private async saveIndexUnlocked(indexPath: string, index: DateIndex): Promise<void> {
        try {
            // 确保基础目录存在
            await this.ensureDirectoryExists(this.baseDir);

            // 写入索引文件
            await AtomicJsonFile.writeJsonAtomically(indexPath, index);
            StatusLogger.debug(`[LogIndexManager] Saved date index with ${Object.keys(index.dates).length} dates`);
        } catch (err) {
            this.needsRecovery = true;
            StatusLogger.warn('[LogIndexManager] Failed to save date index', err);
            throw err;
        }
    }

    private buildDateIndexEntry(total: TokenStats): DateIndexEntry {
        return {
            total_input: total.actualInput,
            total_cache: total.cacheTokens,
            total_output: total.outputTokens,
            total_requests: total.requests,
            total_cost: total.estimatedCost,
            total_cost_rmb: total.estimatedCostRmb,
            native_total_cost: total.nativeCosts?.totalUsd,
            native_total_cost_rmb: total.nativeCosts?.totalRmb
        };
    }

    private isSameDateIndexEntry(left: DateIndexEntry | undefined, right: DateIndexEntry): boolean {
        return (
            !!left &&
            left.total_input === right.total_input &&
            left.total_cache === right.total_cache &&
            left.total_output === right.total_output &&
            left.total_requests === right.total_requests &&
            left.total_cost === right.total_cost &&
            left.total_cost_rmb === right.total_cost_rmb &&
            left.native_total_cost === right.native_total_cost &&
            left.native_total_cost_rmb === right.native_total_cost_rmb
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
                let index = await this.readIndexFile(indexPath);
                if (!index) {
                    index = { dates: {} };
                    this.hasPartialIndex = true;
                }

                index.dates[dateStr] = this.buildDateIndexEntry(total);

                await this.saveIndexUnlocked(indexPath, index);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] Failed to update date index: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    // 仅在已知异常时对账，避免高频刷新扫描全部日期。
    async getIndexFast(): Promise<Record<string, DateIndexEntry>> {
        const indexPath = this.getIndexPath();
        return AtomicJsonFile.runExclusive(indexPath, async () => {
            const index = await this.readIndexFile(indexPath);
            if (!this.needsRecovery && index) {
                return index.dates;
            }
            try {
                return await this.reconcileIndexUnlocked(indexPath, index);
            } catch (err) {
                if (!index || this.hasPartialIndex) {
                    throw err;
                }
                StatusLogger.warn('[LogIndexManager] Recovery failed, using the saved date index', err);
                return index.dates;
            }
        });
    }

    async repairIfNeeded(): Promise<void> {
        if (!this.needsRecovery) {
            return;
        }
        const indexPath = this.getIndexPath();
        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                if (this.needsRecovery) {
                    await this.reconcileIndexUnlocked(indexPath, await this.readIndexFile(indexPath));
                }
            });
        } catch (err) {
            // 索引补偿失败不能阻断已经可用的日期统计，保留状态供下次重试。
            StatusLogger.warn('[LogIndexManager] Failed to repair date index', err);
        }
    }

    /**
     * 从索引中删除指定日期
     * 在删除统计数据后调用
     */
    async removeDate(dateStr: string): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await AtomicJsonFile.runExclusive(indexPath, async () => {
                const index = await this.readIndexFile(indexPath);
                if (!index?.dates[dateStr]) {
                    return;
                }

                delete index.dates[dateStr];
                await this.saveIndexUnlocked(indexPath, index);
                StatusLogger.debug(`[LogIndexManager] Removed date from index: ${dateStr}`);
            });
        } catch (err) {
            StatusLogger.warn(`[LogIndexManager] Failed to remove date from index: ${dateStr}`, err);
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
            const index = await this.readIndexFile(indexPath);
            return this.reconcileIndexUnlocked(indexPath, index);
        });
    }

    private async reconcileIndexUnlocked(
        indexPath: string,
        index: DateIndex | null
    ): Promise<Record<string, DateIndexEntry>> {
        this.needsRecovery = true;
        const actualDates = await this.getAllStatsDates();
        const summaries: Record<string, DateIndexEntry> = {};
        let hasChanges = !index;

        for (const dateStr of actualDates) {
            const stats = await this.loadStats(dateStr);
            if (!stats) {
                continue;
            }

            const actualEntry = this.buildDateIndexEntry(stats.total);
            summaries[dateStr] = actualEntry;
            if (!this.isSameDateIndexEntry(index?.dates[dateStr], actualEntry)) {
                hasChanges = true;
                StatusLogger.debug(`[LogIndexManager] Reconciled date summary: ${dateStr}`);
            }
        }

        if (index && Object.keys(index.dates).some(dateStr => !(dateStr in summaries))) {
            hasChanges = true;
        }

        if (hasChanges) {
            const nextIndex: DateIndex = { dates: summaries };
            if (index?.versionTimestamp !== undefined) {
                nextIndex.versionTimestamp = index.versionTimestamp;
            }
            await this.saveIndexUnlocked(indexPath, nextIndex);
        }

        this.needsRecovery = false;
        this.hasPartialIndex = false;
        return summaries;
    }

    /**
     * 获取所有已保存的日期列表
     */
    private async getAllStatsDates(): Promise<string[]> {
        try {
            // 读取所有日期目录
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
            const dates: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // 检查是否是有效的日期格式
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        dates.push(dateStr);
                    }
                }
            }

            return dates.sort().reverse(); // 倒序(最新的在前)
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            StatusLogger.error('[LogIndexManager] Failed to get stats date list', err);
            throw err;
        }
    }

    /**
     * 加载日期统计
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const statsPath = path.join(this.baseDir, dateStr, 'stats.json');
        try {
            // 与写入共用同一文件的串行锁，避免 rename 时被本进程 readFile 句柄占用导致 EPERM
            const content = await AtomicJsonFile.runExclusive(statsPath, () => fs.readFile(statsPath, 'utf-8'));
            const stats: TokenUsageStatsFromFile = JSON.parse(content);
            if (!stats?.total || typeof stats.total !== 'object' || Array.isArray(stats.total)) {
                throw new Error(`Invalid date stats: ${dateStr}`);
            }
            return stats;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return null;
            }
            StatusLogger.warn(`[LogIndexManager] Failed to read date stats: ${dateStr}`, err);
            throw err;
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
                StatusLogger.debug(`[LogIndexManager] Created directory: ${dirPath}`);
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
