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
import { AtomicJsonFile, WritePermissionLostError } from '../atomicJsonFile';
import { indexFiles, readStatisticsFile } from '../persistence/statisticsFiles';
import { IndexTransaction, IndexVersionChangedError } from '../persistence/indexTransaction';
import { getFileVersionSync, type JsonFileSnapshot } from '../persistence/versionedJsonFile';
import type { DateIndex, DateIndexEntry, TokenUsageStatsFromFile, TokenStats } from './types';

/**
 * 日志索引管理器
 * 管理 index.json 文件的读写操作
 */
export class LogIndexManager {
    private readonly baseDir: string;
    private needsRecovery = true;
    private hasPartialIndex = false;
    private readonly transaction: IndexTransaction;

    constructor(baseDir: string, capturePermission: () => () => boolean = () => () => true) {
        this.baseDir = path.join(baseDir, 'usages');
        this.transaction = new IndexTransaction(this.getIndexPath(), capturePermission);
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
            const updated = await this.transaction.run(async canWrite => {
                if (!canWrite()) {
                    return false;
                }
                let index = await this.readIndexFile(indexPath, false);
                if (!index) {
                    index = { dates: {} };
                    this.hasPartialIndex = true;
                }

                index.versionTimestamp = versionTimestamp;

                await this.saveIndexUnlocked(indexPath, index, canWrite);
                return true;
            });

            if (updated) {
                StatusLogger.debug(
                    `[LogIndexManager] Updated version timestamp: ${new Date(versionTimestamp).toISOString()}`
                );
            }
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

    private async readIndexFile(indexPath: string, allowRecovery = true): Promise<DateIndex | null> {
        try {
            const snapshot = await indexFiles.read(indexPath);
            this.transaction.observe(snapshot.version);
            return snapshot.value;
        } catch (err) {
            this.needsRecovery = true;
            if (!allowRecovery && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
            this.transaction.observe(getFileVersionSync(indexPath));
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                StatusLogger.warn('[LogIndexManager] Failed to read date index', err);
            }
            return null;
        }
    }

    private async saveIndexUnlocked(
        indexPath: string,
        index: DateIndex,
        canWrite: () => boolean,
        sources?: ReadonlyMap<string, string>,
        dates?: string[]
    ): Promise<void> {
        const guard = this.transaction.guard(canWrite, sources, dates);
        try {
            // 确保基础目录存在
            await this.ensureDirectoryExists(this.baseDir);

            // 写入索引文件
            await AtomicJsonFile.writeJsonAtomically(indexPath, index, undefined, guard);
            indexFiles.invalidate(indexPath);
            StatusLogger.debug(`[LogIndexManager] Saved date index with ${Object.keys(index.dates).length} dates`);
        } catch (err) {
            this.needsRecovery = true;
            if (err instanceof IndexVersionChangedError) {
                StatusLogger.trace('[LogIndexManager] Retrying changed date index observations');
            } else if (!(err instanceof WritePermissionLostError)) {
                StatusLogger.warn('[LogIndexManager] Failed to save date index', err);
            }
            throw err;
        }
    }

    private buildDateIndexEntry(total: TokenStats): DateIndexEntry {
        return {
            total_input: total.actualInput,
            total_cache: total.cacheTokens,
            total_output: total.outputTokens,
            total_requests: total.requests,
            total_cost: total.estimatedCost ?? 0,
            total_cost_rmb: total.estimatedCostRmb ?? 0,
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
    async updateIndex(
        dateStr: string,
        total?: TokenStats,
        canWrite?: () => boolean
    ): Promise<Pick<TokenUsageStatsFromFile, 'total'> | undefined> {
        const indexPath = this.getIndexPath();

        try {
            return await this.transaction.run(async permission => {
                if (!permission()) {
                    this.needsRecovery = true;
                    return;
                }
                let index = await this.readIndexFile(indexPath, false);
                if (!index) {
                    index = { dates: {} };
                    this.hasPartialIndex = true;
                }

                const stats = total === undefined ? await this.loadStats(dateStr) : undefined;
                const summary = total ?? stats?.value.total;
                if (!summary) {
                    this.needsRecovery = true;
                    return;
                }
                const sources =
                    stats ? new Map([[path.join(this.baseDir, dateStr, 'stats.json'), stats.version]]) : undefined;
                index.dates[dateStr] = this.buildDateIndexEntry(summary);

                await this.saveIndexUnlocked(indexPath, index, permission, sources);
                return stats?.value;
            }, canWrite);
        } catch (err) {
            this.needsRecovery = true;
            if (err instanceof WritePermissionLostError) {
                return;
            }
            StatusLogger.warn(`[LogIndexManager] Failed to update date index: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    // 仅在已知异常时对账，避免高频刷新扫描全部日期。
    async getIndexFast(): Promise<Record<string, DateIndexEntry>> {
        const indexPath = this.getIndexPath();
        return this.transaction.run(async canWrite => {
            const index = await this.readIndexFile(indexPath);
            if (!this.needsRecovery && index) {
                return index.dates;
            }
            try {
                return await this.reconcileIndexUnlocked(indexPath, index, canWrite);
            } catch (err) {
                if (err instanceof IndexVersionChangedError) {
                    throw err;
                }
                if (!index || this.hasPartialIndex) {
                    throw err;
                }
                StatusLogger.warn('[LogIndexManager] Recovery failed, using the saved date index', err);
                return index.dates;
            }
        });
    }

    async repairIfNeeded(): Promise<boolean> {
        if (!this.needsRecovery) {
            return true;
        }
        const indexPath = this.getIndexPath();
        try {
            await this.transaction.run(async canWrite => {
                if (this.needsRecovery) {
                    await this.reconcileIndexUnlocked(indexPath, await this.readIndexFile(indexPath), canWrite);
                }
            });
        } catch (err) {
            // 索引补偿失败不能阻断已经可用的日期统计，保留状态供下次重试。
            StatusLogger.warn('[LogIndexManager] Failed to repair date index', err);
        }
        return !this.needsRecovery;
    }

    /**
     * 从索引中删除指定日期
     * 在删除统计数据后调用
     */
    async removeDate(dateStr: string): Promise<void> {
        const indexPath = this.getIndexPath();

        try {
            await this.transaction.run(async canWrite => {
                if (!canWrite()) {
                    return;
                }
                const index = await this.readIndexFile(indexPath, false);
                if (!index?.dates[dateStr]) {
                    return;
                }

                delete index.dates[dateStr];
                await this.saveIndexUnlocked(indexPath, index, canWrite);
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
        return this.transaction.run(async canWrite => {
            const index = await this.readIndexFile(indexPath);
            return this.reconcileIndexUnlocked(indexPath, index, canWrite);
        });
    }

    private async reconcileIndexUnlocked(
        indexPath: string,
        index: DateIndex | null,
        canWrite: () => boolean
    ): Promise<Record<string, DateIndexEntry>> {
        this.needsRecovery = true;
        const actualDates = await this.getAllStatsDates();
        const summaries: Record<string, DateIndexEntry> = {};
        const sources = new Map<string, string>();
        let hasChanges = !index;

        for (const dateStr of actualDates) {
            const stats = await this.loadStats(dateStr);
            sources.set(path.join(this.baseDir, dateStr, 'stats.json'), stats?.version ?? 'missing');
            if (!stats) {
                continue;
            }

            const actualEntry = this.buildDateIndexEntry(stats.value.total);
            summaries[dateStr] = actualEntry;
            if (!this.isSameDateIndexEntry(index?.dates[dateStr], actualEntry)) {
                hasChanges = true;
                StatusLogger.debug(`[LogIndexManager] Reconciled date summary: ${dateStr}`);
            }
        }

        if (index && Object.keys(index.dates).some(dateStr => !(dateStr in summaries))) {
            hasChanges = true;
        }

        let persisted = !hasChanges;
        if (hasChanges && canWrite()) {
            const nextIndex: DateIndex = { dates: summaries };
            if (index?.versionTimestamp !== undefined) {
                nextIndex.versionTimestamp = index.versionTimestamp;
            }
            try {
                await this.saveIndexUnlocked(indexPath, nextIndex, canWrite, sources, actualDates);
                persisted = true;
            } catch (error) {
                if (!(error instanceof WritePermissionLostError) || canWrite()) {
                    throw error;
                }
            }
        }

        if (persisted) {
            this.needsRecovery = false;
            this.hasPartialIndex = false;
        }
        return !hasChanges && index ? index.dates : summaries;
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
    private async loadStats(dateStr: string): Promise<JsonFileSnapshot<Pick<TokenUsageStatsFromFile, 'total'>> | null> {
        const statsPath = path.join(this.baseDir, dateStr, 'stats.json');
        try {
            return await readStatisticsFile(statsPath);
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
