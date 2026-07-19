import { sumCosts } from '../../utils/pricingCurrency';

function addCost(current: number, delta: number | undefined): number {
    return sumCosts([current, delta]);
}
/*---------------------------------------------------------------------------------------------
 *  日志统计管理器
 *  统一管理统计数据的查询、计算和持久化
 *  目录结构:
 *    - 统计汇总: <baseDir>/usages/YYYY-MM-DD/stats.json
 *     包含 daily (每日统计) 和 hourly (小时统计) 两部分
 *    - 日期索引: <baseDir>/usages/index.json
 *     记录所有日期的总token情况，用于快速浏览日期列表
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { LogReadManager } from './logReadManager';
import { LogIndexManager } from './logIndexManager';
import { createEmptyNativeCostSplit, mergeNativeCostSplit } from './nativeCostSplit';
import { StatsCalculator } from './statsCalculator';
import { AtomicJsonFile } from '../atomicJsonFile';
import { SnapshotManager } from './snapshotManager';
import { DateUtils } from './dateUtils';
import { WritePermissionGate } from './writePermissionGate';
import type {
    FileLoggerModelStats,
    FileLoggerProviderStats,
    HourlyStats,
    TokenRequestLog,
    TokenStats,
    TokenUsageStatsFromFile
} from './types';

/**
 * 日志统计管理器
 * 统一管理统计数据的查询、计算和持久化
 * 注: 缓存由上层调用者(usagesStatusBar等)维护
 */
export class LogStatsManager {
    private readonly baseDir: string;
    private readonly indexManager: LogIndexManager;
    private readonly inFlightRegenerations = new Map<string, Promise<TokenUsageStatsFromFile>>();
    private readonly writePermissionGate = new WritePermissionGate();
    // 代码版本时间戳：用于判断缓存是否由当前版本代码生成
    private _codeVersionTimestamp: number = 0;
    /**
     * 写盘守卫：返回 true 时允许写 stats.json/index.json。
     * 多实例环境下，只有主实例（Leader）才允许写，避免跨进程并发写覆盖。
     * 默认返回 true（单实例或未注入时保持原行为）。
     */
    private _canWriteStats: () => boolean = () => true;

    constructor(
        private readManager: LogReadManager,
        baseDir: string,
        indexManager: LogIndexManager,
        private snapshotManager: SnapshotManager
    ) {
        this.baseDir = path.join(baseDir, 'usages');
        this.indexManager = indexManager;
    }

    /**
     * 设置写盘守卫
     * @param canWriteStats 返回 true 时允许写盘；false 时跳过写盘（仅返回内存计算结果）
     */
    setCanWriteStats(canWriteStats: () => boolean): void {
        this._canWriteStats = canWriteStats;
        this.writePermissionGate.setEvaluator(canWriteStats);
    }

    /**
     * 在临时强制写盘作用域内执行操作。
     * 仅用于已确认 Leader 不可达、需要本地兜底落盘的场景。
     */
    async runWithForcedWrites<T>(operation: () => Promise<T>): Promise<T> {
        return this.writePermissionGate.runWithForcedWrites(operation);
    }

    /**
     * 当前实例是否被允许写 stats.json
     */
    private canWriteStats(): boolean {
        return this.writePermissionGate.canWrite();
    }

    /**
     * 更新代码版本时间戳
     * @param codeVersionTimestamp 代码版本时间戳
     */
    updateCodeVersionTimestamp(codeVersionTimestamp: number): void {
        this._codeVersionTimestamp = codeVersionTimestamp;
    }

    /**
     * 获取当前代码版本时间戳
     */
    private getCodeVersionTimestamp(): number {
        return this._codeVersionTimestamp;
    }

    /**
     * 获取日期统计
     * 优先尝试从持久化文件读取，否则进行全量计算并保存
     * 如果版本时间戳变化或缓存过期，则全量重新计算
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @param ignoreCache 是否忽略缓存，强制重新计算
     */
    async getDateStats(dateStr: string, ignoreCache: boolean = false): Promise<TokenUsageStatsFromFile> {
        // 优先尝试从持久化文件读取（如果不忽略缓存）
        if (!ignoreCache) {
            const saved = await this.loadStats(dateStr);
            if (saved) {
                // 检查版本时间戳是否有效，如果无效需要全量重新计算
                const needsRegen = await this.needsRegeneration(dateStr);
                if (!needsRegen) {
                    // needsRegeneration 检查与第一次读取之间允许写入插入。
                    // 最小修复：命中缓存前再读取一次当前文件，避免返回已被更新覆盖的旧快照。
                    const latest = await this.loadStats(dateStr);
                    StatusLogger.debug(`[LogStatsManager] Read stats from cache: ${dateStr}`);
                    return latest ?? saved;
                }
                // 版本变化或缓存过期，需要全量重新计算
                StatusLogger.debug(`[LogStatsManager] Cache expired, recalculating from scratch: ${dateStr}`);
            }
        }

        return this.getOrCreateDateRegeneration(dateStr);
    }

    /**
     * 获取或创建指定日期的重算任务
     * 避免同一天被多个调用方并发重算时，旧快照在后写入覆盖新快照
     */
    private getOrCreateDateRegeneration(dateStr: string): Promise<TokenUsageStatsFromFile> {
        const inFlight = this.inFlightRegenerations.get(dateStr);
        if (inFlight) {
            StatusLogger.trace(`[LogStatsManager] Reusing in-flight stats regeneration task: ${dateStr}`);
            return inFlight;
        }

        const regenerationPromise = (async () => {
            StatusLogger.debug(`[LogStatsManager] Regenerating stats: ${dateStr}`);
            const stats = await this.calculateDateStats(dateStr);
            // calculateDateStats 在签名一致时会直接返回 existingStats（未重算）。
            // 此时若版本戳已是当前代码版本，说明磁盘内容完全有效，跳过 saveDateStats 的重写 I/O。
            if (
                stats.recordSignature &&
                stats.versionTimestamp !== undefined &&
                stats.versionTimestamp >= this.getCodeVersionTimestamp()
            ) {
                StatusLogger.trace(`[LogStatsManager] Stats unchanged, skip save: ${dateStr}`);
                return stats;
            }
            await this.saveDateStats(dateStr, stats);
            return stats;
        })();

        const sharedPromise = regenerationPromise.finally(() => {
            if (this.inFlightRegenerations.get(dateStr) === sharedPromise) {
                this.inFlightRegenerations.delete(dateStr);
            }
        });

        this.inFlightRegenerations.set(dateStr, sharedPromise);
        return sharedPromise;
    }

    /**
     * 判断指定日期是否应优先读取原始 hourly .jsonl。
     * 仅“今天”和“昨天”读 raw .jsonl；更早的日期统一读 requests.jsonl 快照。
     * 与 TokenFileLogger.shouldReadRawJsonl 保持一致，避免今天/昨天统计读到旧 snapshot。
     */
    private shouldReadRawJsonl(dateStr: string): boolean {
        const today = DateUtils.getTodayDateString();
        if (dateStr === today) {
            return true;
        }
        const yesterday = DateUtils.getDateStringDaysAgo(1);
        return dateStr === yesterday;
    }

    /**
     * 计算指定日期的统计（包含小时统计和日期统计）
     * 支持增量更新：根据小时文件的修改时间戳判断是否需要重新计算
     * 如果版本变化，则跳过旧的 hourly 缓存，全部重新计算
     * 日期统计（total 和 providers）从小时缓存聚合计算
     *
     * 口径说明：
     * - `StatsCalculator.aggregateLogs()` 只负责计算并写入“模型级别”的聚合值：
     *   - `outputSpeeds`: 模型小时内请求速度的鲁棒均值（用于规避极端值）。
     *   - `firstTokenLatency`: 模型小时内首 token 延迟的算术平均（不做置信/鲁棒处理）。
     * - 本方法在“小时缓存”就绪后，从 models 回填每小时 provider/hour 与 hour total 的聚合值。
     * - daily 的 `outputSpeeds/firstTokenLatency` 均为“小时聚合值的算术平均”（均值的均值，不加权）。
     * - `totalStreamDuration/validStreamRequests/...` 等中间计数仅用于运行时计算（已不再写入缓存）。
     *
     * @private 内部使用，通过 getDateStats 访问
     */
    private async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 今天/昨天优先从 raw hourly .jsonl 读取，避免读到旧的 requests.jsonl 快照；
        // 更早日期优先从 requests.jsonl 快照读取（缓存命中时零 I/O），全量按小时分桶聚合。
        const snapshotRecords = this.shouldReadRawJsonl(dateStr) ? null : await this.snapshotManager.read(dateStr);

        // 计算快照记录指纹：records:completed:failed:cancelled:maxStreamEndTime
        // - records 变化：有新请求
        // - completed/failed/cancelled 变化：状态转移（estimated → completed/failed/cancelled）
        // - maxStreamEndTime 变化：有新的实际 token 数据写入（updateActualTokens 触发）
        // 仅 snapshotRecords 存在时启用签名快返；JSONL fallback 必须实际读取日志，避免旧 "0:0:0:0" 误命中。
        let signature: string | undefined;
        if (snapshotRecords) {
            let totalRecords = 0;
            let completedCount = 0;
            let failedCount = 0;
            let cancelledCount = 0;
            let maxStreamEndTime = 0;
            for (const r of snapshotRecords) {
                totalRecords++;
                if (r.status === 'completed') {
                    completedCount++;
                } else if (r.status === 'failed') {
                    failedCount++;
                } else if (r.status === 'cancelled') {
                    cancelledCount++;
                }
                if (r.streamEndTime && r.streamEndTime > maxStreamEndTime) {
                    maxStreamEndTime = r.streamEndTime;
                }
            }
            signature = `${totalRecords}:${completedCount}:${failedCount}:${cancelledCount}:${maxStreamEndTime}`;
        }

        // 签名一致且版本戳有效：跳过全量聚合，直接返回现有 stats（消除无意义的重算与 stats.json 重写）
        // 必须同时校验 versionTimestamp：否则代码升级（统计口径变化）后，
        // 只要 signature 恰好一致，旧版本生成的 stats 会被原样返回并保存（versionTimestamp 被刷新），
        // 导致新口径永远不会重算。versionTimestamp 由 needsRegeneration/getCodeVersionTimestamp 控制。
        const existingStats = await this.loadStats(dateStr);
        if (
            signature &&
            existingStats &&
            existingStats.recordSignature === signature &&
            existingStats.versionTimestamp !== undefined &&
            existingStats.versionTimestamp >= this.getCodeVersionTimestamp()
        ) {
            StatusLogger.trace(`[LogStatsManager] Stats unchanged (sig: ${signature}), skip: ${dateStr}`);
            return existingStats;
        }

        const hourly: Record<string, HourlyStats> = {};

        if (snapshotRecords && snapshotRecords.length > 0) {
            // 按小时分桶（使用本地时区，与历史 .jsonl 文件名口径一致）
            const recordsByHour = new Map<string, TokenRequestLog[]>();
            for (const record of snapshotRecords) {
                const hour = new Date(record.timestamp).getHours();
                const hourKey = String(hour).padStart(2, '0');
                let bucket = recordsByHour.get(hourKey);
                if (!bucket) {
                    bucket = [];
                    recordsByHour.set(hourKey, bucket);
                }
                bucket.push(record);
            }

            // 逐小时聚合
            for (const [hourKey, hourRecords] of recordsByHour) {
                const hourStats = StatsCalculator.aggregateLogs(hourRecords);
                hourly[hourKey] = {
                    ...hourStats.total,
                    modifiedTime: Date.now(),
                    providers: hourStats.providers
                };
            }
        } else {
            // 回退：从 JSONL 读取（首次安装等尚无 requests.jsonl 快照的场景）
            StatusLogger.debug(`[LogStatsManager] No snapshot data for ${dateStr}, falling back to JSONL`);
            const dateFolder = path.join(this.baseDir, dateStr);
            try {
                const files = await fs.readdir(dateFolder);
                const hourFiles = files
                    .filter(f => /^\d{2}\.jsonl$/.test(f))
                    .map(f => parseInt(f.slice(0, 2), 10))
                    .filter(h => !Number.isNaN(h) && h >= 0 && h <= 23)
                    .sort((a, b) => a - b);
                for (const hour of hourFiles) {
                    const hourKey = String(hour).padStart(2, '0');
                    const logs = await this.readManager.readHourLogs(dateStr, hour);
                    const hourStats = StatsCalculator.aggregateLogs(logs);
                    hourly[hourKey] = {
                        ...hourStats.total,
                        modifiedTime: Date.now(),
                        providers: hourStats.providers
                    };
                }
            } catch {
                StatusLogger.debug(`[LogStatsManager] Date folder does not exist or cannot be read: ${dateStr}`);
            }
        }

        // 小时缓存就绪后：
        // 1) 先基于“小时+models”计算每小时的 provider/hour 与 hour total 聚合值
        // 2) 再遍历小时计算 daily 的均值（均值的均值，不做加权）
        interface AvgAcc {
            mean: number;
            n: number;
        }
        const addAvg = (acc: AvgAcc | undefined, value: number): AvgAcc => {
            const next = acc ?? { mean: 0, n: 0 };
            next.n += 1;
            next.mean += (value - next.mean) / next.n;
            return next;
        };
        const getAvg = (acc: AvgAcc | undefined): number => (acc && acc.n > 0 ? acc.mean : 0);

        // 从小时统计聚合计算日期统计（避免重复读取日志）
        // 初始化总计
        const total: TokenStats = {
            estimatedInput: 0,
            actualInput: 0,
            cacheTokens: 0,
            outputTokens: 0,
            requests: 0,
            completedRequests: 0,
            costedRequests: 0,
            rmbExactRequests: 0,
            failedRequests: 0,
            cancelledRequests: 0,
            firstTokenLatency: 0,
            outputSpeeds: 0,
            estimatedCost: 0,
            estimatedCostRmb: 0,
            inputCost: 0,
            inputCostRmb: 0,
            outputCost: 0,
            outputCostRmb: 0,
            cacheReadCost: 0,
            cacheReadCostRmb: 0,
            cacheWriteCost: 0,
            cacheWriteCostRmb: 0
        };

        let totalSpeedAcc: AvgAcc | undefined;
        let totalFirstTokenLatencyAcc: AvgAcc | undefined;

        // 初始化提供商统计
        const providers: Record<string, FileLoggerProviderStats> = {};
        const providerMetricAccByDay = new WeakMap<FileLoggerProviderStats, { speed?: AvgAcc; latency?: AvgAcc }>();
        const modelMetricAccByDay = new WeakMap<FileLoggerModelStats, { speed?: AvgAcc; latency?: AvgAcc }>();
        // 遍历所有小时统计，聚合计算
        for (const hourStats of Object.values(hourly)) {
            // 1) 回填每小时 provider/hour 的聚合值：只从模型的已聚合值计算
            let hourTotalSpeedAcc: AvgAcc | undefined;
            let hourTotalLatencyAcc: AvgAcc | undefined;
            for (const providerStats of Object.values(hourStats.providers || {})) {
                let providerSpeedAcc: AvgAcc | undefined;
                let providerLatencyAcc: AvgAcc | undefined;
                for (const modelStats of Object.values(providerStats.models || {})) {
                    if (modelStats.firstTokenLatency && modelStats.firstTokenLatency > 0) {
                        providerLatencyAcc = addAvg(providerLatencyAcc, modelStats.firstTokenLatency);
                        hourTotalLatencyAcc = addAvg(hourTotalLatencyAcc, modelStats.firstTokenLatency);
                    }
                    if (modelStats.outputSpeeds && modelStats.outputSpeeds > 0) {
                        providerSpeedAcc = addAvg(providerSpeedAcc, modelStats.outputSpeeds);
                        hourTotalSpeedAcc = addAvg(hourTotalSpeedAcc, modelStats.outputSpeeds);
                    }
                }
                providerStats.firstTokenLatency = getAvg(providerLatencyAcc);
                providerStats.outputSpeeds = getAvg(providerSpeedAcc);
            }

            hourStats.firstTokenLatency = getAvg(hourTotalLatencyAcc);
            hourStats.outputSpeeds = getAvg(hourTotalSpeedAcc);

            // 2) tokens/requests 仍做累加
            total.estimatedInput += hourStats.estimatedInput;
            total.actualInput += hourStats.actualInput;
            total.cacheTokens += hourStats.cacheTokens;
            total.outputTokens += hourStats.outputTokens;
            total.requests += hourStats.requests;
            total.costedRequests += hourStats.costedRequests || 0;
            total.rmbExactRequests += hourStats.rmbExactRequests || 0;
            total.completedRequests += hourStats.completedRequests;
            total.failedRequests += hourStats.failedRequests;
            total.cancelledRequests += hourStats.cancelledRequests;
            total.estimatedCost = addCost(total.estimatedCost, hourStats.estimatedCost || 0);
            total.estimatedCostRmb = addCost(total.estimatedCostRmb || 0, hourStats.estimatedCostRmb || 0);
            total.inputCost = addCost(total.inputCost, hourStats.inputCost || 0);
            total.inputCostRmb = addCost(total.inputCostRmb || 0, hourStats.inputCostRmb || 0);
            total.outputCost = addCost(total.outputCost, hourStats.outputCost || 0);
            total.outputCostRmb = addCost(total.outputCostRmb || 0, hourStats.outputCostRmb || 0);
            total.cacheReadCost = addCost(total.cacheReadCost, hourStats.cacheReadCost || 0);
            total.cacheReadCostRmb = addCost(total.cacheReadCostRmb || 0, hourStats.cacheReadCostRmb || 0);
            total.cacheWriteCost = addCost(total.cacheWriteCost, hourStats.cacheWriteCost || 0);
            total.cacheWriteCostRmb = addCost(total.cacheWriteCostRmb || 0, hourStats.cacheWriteCostRmb || 0);
            if (hourStats.nativeCosts) {
                total.nativeCosts ??= createEmptyNativeCostSplit();
                mergeNativeCostSplit(total.nativeCosts, hourStats.nativeCosts);
            }

            // 3) daily total：对每小时的聚合值做算术平均（不加权）
            if (hourStats.firstTokenLatency && hourStats.firstTokenLatency > 0) {
                totalFirstTokenLatencyAcc = addAvg(totalFirstTokenLatencyAcc, hourStats.firstTokenLatency);
            }
            if (hourStats.outputSpeeds && hourStats.outputSpeeds > 0) {
                totalSpeedAcc = addAvg(totalSpeedAcc, hourStats.outputSpeeds);
            }

            // 4) providers/models：累加 tokens，并对每小时聚合值做均值
            for (const [providerKey, providerHour] of Object.entries(hourStats.providers || {})) {
                if (!providers[providerKey]) {
                    providers[providerKey] = {
                        providerName: providerHour.providerName,
                        estimatedInput: 0,
                        actualInput: 0,
                        cacheTokens: 0,
                        outputTokens: 0,
                        requests: 0,
                        costedRequests: 0,
                        rmbExactRequests: 0,
                        completedRequests: 0,
                        failedRequests: 0,
                        cancelledRequests: 0,
                        firstTokenLatency: 0,
                        outputSpeeds: 0,
                        estimatedCost: 0,
                        estimatedCostRmb: 0,
                        inputCost: 0,
                        inputCostRmb: 0,
                        outputCost: 0,
                        outputCostRmb: 0,
                        cacheReadCost: 0,
                        cacheReadCostRmb: 0,
                        cacheWriteCost: 0,
                        cacheWriteCostRmb: 0,
                        models: {}
                    };
                }

                const provider = providers[providerKey];
                provider.estimatedInput += providerHour.estimatedInput;
                provider.actualInput += providerHour.actualInput;
                provider.cacheTokens += providerHour.cacheTokens;
                provider.outputTokens += providerHour.outputTokens;
                provider.requests += providerHour.requests;
                provider.costedRequests += providerHour.costedRequests || 0;
                provider.rmbExactRequests += providerHour.rmbExactRequests || 0;
                provider.completedRequests += providerHour.completedRequests;
                provider.failedRequests += providerHour.failedRequests;
                provider.cancelledRequests += providerHour.cancelledRequests;
                provider.estimatedCost = addCost(provider.estimatedCost, providerHour.estimatedCost || 0);
                provider.estimatedCostRmb = addCost(provider.estimatedCostRmb || 0, providerHour.estimatedCostRmb || 0);
                provider.inputCost = addCost(provider.inputCost, providerHour.inputCost || 0);
                provider.inputCostRmb = addCost(provider.inputCostRmb || 0, providerHour.inputCostRmb || 0);
                provider.outputCost = addCost(provider.outputCost, providerHour.outputCost || 0);
                provider.outputCostRmb = addCost(provider.outputCostRmb || 0, providerHour.outputCostRmb || 0);
                provider.cacheReadCost = addCost(provider.cacheReadCost, providerHour.cacheReadCost || 0);
                provider.cacheReadCostRmb = addCost(provider.cacheReadCostRmb || 0, providerHour.cacheReadCostRmb || 0);
                provider.cacheWriteCost = addCost(provider.cacheWriteCost, providerHour.cacheWriteCost || 0);
                provider.cacheWriteCostRmb = addCost(
                    provider.cacheWriteCostRmb || 0,
                    providerHour.cacheWriteCostRmb || 0
                );
                if (providerHour.nativeCosts) {
                    provider.nativeCosts ??= createEmptyNativeCostSplit();
                    mergeNativeCostSplit(provider.nativeCosts, providerHour.nativeCosts);
                }

                const pAcc = providerMetricAccByDay.get(provider) ?? {};
                if (providerHour.firstTokenLatency && providerHour.firstTokenLatency > 0) {
                    pAcc.latency = addAvg(pAcc.latency, providerHour.firstTokenLatency);
                }
                if (providerHour.outputSpeeds && providerHour.outputSpeeds > 0) {
                    pAcc.speed = addAvg(pAcc.speed, providerHour.outputSpeeds);
                }
                providerMetricAccByDay.set(provider, pAcc);

                for (const [modelKey, modelHour] of Object.entries(providerHour.models || {})) {
                    if (!provider.models[modelKey]) {
                        provider.models[modelKey] = {
                            modelName: modelHour.modelName,
                            estimatedInput: 0,
                            actualInput: 0,
                            cacheTokens: 0,
                            outputTokens: 0,
                            requests: 0,
                            costedRequests: 0,
                            rmbExactRequests: 0,
                            firstTokenLatency: 0,
                            outputSpeeds: 0,
                            estimatedCost: 0,
                            estimatedCostRmb: 0,
                            inputCost: 0,
                            inputCostRmb: 0,
                            outputCost: 0,
                            outputCostRmb: 0,
                            cacheReadCost: 0,
                            cacheReadCostRmb: 0,
                            cacheWriteCost: 0,
                            cacheWriteCostRmb: 0
                        };
                    }

                    const model = provider.models[modelKey];
                    model.estimatedInput += modelHour.estimatedInput;
                    model.actualInput += modelHour.actualInput;
                    model.cacheTokens += modelHour.cacheTokens;
                    model.outputTokens += modelHour.outputTokens;
                    model.requests += modelHour.requests;
                    model.costedRequests += modelHour.costedRequests || 0;
                    model.rmbExactRequests += modelHour.rmbExactRequests || 0;
                    model.estimatedCost = addCost(model.estimatedCost, modelHour.estimatedCost || 0);
                    model.estimatedCostRmb = addCost(model.estimatedCostRmb || 0, modelHour.estimatedCostRmb || 0);
                    model.inputCost = addCost(model.inputCost, modelHour.inputCost || 0);
                    model.inputCostRmb = addCost(model.inputCostRmb || 0, modelHour.inputCostRmb || 0);
                    model.outputCost = addCost(model.outputCost, modelHour.outputCost || 0);
                    model.outputCostRmb = addCost(model.outputCostRmb || 0, modelHour.outputCostRmb || 0);
                    model.cacheReadCost = addCost(model.cacheReadCost, modelHour.cacheReadCost || 0);
                    model.cacheReadCostRmb = addCost(model.cacheReadCostRmb || 0, modelHour.cacheReadCostRmb || 0);
                    model.cacheWriteCost = addCost(model.cacheWriteCost, modelHour.cacheWriteCost || 0);
                    model.cacheWriteCostRmb = addCost(model.cacheWriteCostRmb || 0, modelHour.cacheWriteCostRmb || 0);
                    if (modelHour.nativeCosts) {
                        model.nativeCosts ??= createEmptyNativeCostSplit();
                        mergeNativeCostSplit(model.nativeCosts, modelHour.nativeCosts);
                    }

                    const mAcc = modelMetricAccByDay.get(model) ?? {};
                    if (modelHour.firstTokenLatency && modelHour.firstTokenLatency > 0) {
                        mAcc.latency = addAvg(mAcc.latency, modelHour.firstTokenLatency);
                    }
                    if (modelHour.outputSpeeds && modelHour.outputSpeeds > 0) {
                        mAcc.speed = addAvg(mAcc.speed, modelHour.outputSpeeds);
                    }
                    modelMetricAccByDay.set(model, mAcc);
                }
            }
        }

        total.outputSpeeds = getAvg(totalSpeedAcc);
        total.firstTokenLatency = getAvg(totalFirstTokenLatencyAcc);

        for (const provider of Object.values(providers)) {
            const pAcc = providerMetricAccByDay.get(provider);
            provider.firstTokenLatency = getAvg(pAcc?.latency);
            provider.outputSpeeds = getAvg(pAcc?.speed);
            for (const model of Object.values(provider.models)) {
                const mAcc = modelMetricAccByDay.get(model);
                model.firstTokenLatency = getAvg(mAcc?.latency);
                model.outputSpeeds = getAvg(mAcc?.speed);
            }
        }

        const result: TokenUsageStatsFromFile = { total, providers, hourly };
        if (signature) {
            result.recordSignature = signature;
        }
        return result;
    }

    /**
     * 保存每日统计结果
     * 保存到: <baseDir>/usages/YYYY-MM-DD/stats.json
     * 保存完整的日期统计和小时统计（包含 providers）
     * @private 内部使用，通过 getDateStats 访问
     */
    private async saveDateStats(dateStr: string, stats: TokenUsageStatsFromFile): Promise<void> {
        // 多实例写盘守卫：非主实例不写盘，避免跨进程并发写覆盖 stats.json/index.json。
        // 内存计算结果仍返回给本实例使用（如详情界面立即展示），主实例会通过 IPC 请求刷新写盘。
        if (!this.canWriteStats()) {
            StatusLogger.trace(`[LogStatsManager] Skip saving stats (non-leader instance): ${dateStr}`);
            return;
        }

        const filePath = this.getStatsFilePath(dateStr);

        try {
            // 写入版本时间戳
            stats.versionTimestamp = this.getCodeVersionTimestamp();

            // 在目标文件路径上串行化写入，再通过临时文件 rename 原子替换，避免并发覆盖与半截 JSON
            await AtomicJsonFile.runExclusive(filePath, async () => {
                await AtomicJsonFile.writeJsonAtomically(filePath, stats);
            });

            // 更新索引文件
            await this.indexManager.updateIndex(dateStr, stats.total);

            StatusLogger.debug(
                `[LogStatsManager] Saved daily stats to stats.json: ${dateStr}, version=${new Date(stats.versionTimestamp).toISOString()}`
            );
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] Failed to save daily stats: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 检查并重新生成过期的统计数据
     * 在打开统计页面时调用，确保所有日期的 stats.json 都是最新的
     * @returns 成功重新生成的日期统计，key 为日期字符串
     */
    async regenerateOutdatedStats(): Promise<Record<string, TokenUsageStatsFromFile>> {
        const startTime = Date.now();

        // 获取所有需要重新生成的日期列表
        const outdatedDates = await this.getOutdatedDates();
        if (outdatedDates.length === 0) {
            StatusLogger.debug('[LogStatsManager] All stats are up to date; no regeneration needed');
            return {};
        }

        StatusLogger.debug(`[LogStatsManager] Found ${outdatedDates.length} dates that require stats regeneration`);

        const results: Record<string, TokenUsageStatsFromFile> = {};
        for (const dateStr of outdatedDates) {
            try {
                // 重新计算该日期的统计数据（使用 getDateStats 自动处理计算和保存）
                const stats = await this.getDateStats(dateStr);

                // 记录结果
                results[dateStr] = stats;
                StatusLogger.debug(`[LogStatsManager] Regenerated stats for date ${dateStr}`);
            } catch (err) {
                StatusLogger.warn(`[LogStatsManager] Failed to regenerate stats for date ${dateStr}:`, err);
            }
        }

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(
            `[LogStatsManager] Stats regeneration finished: ${Object.keys(results).length}/${outdatedDates.length} succeeded (elapsed: ${elapsed}ms)`
        );
        return results;
    }

    /**
     * 获取所有需要重新生成的日期列表
     * @private 内部使用，通过 regenerateOutdatedStats 访问
     */
    private async getOutdatedDates(): Promise<string[]> {
        const outdatedDates: string[] = [];

        if (!fsSync.existsSync(this.baseDir)) {
            return outdatedDates;
        }

        try {
            // 读取所有日期目录
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // 检查是否是有效的日期格式
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        // 检查是否需要重新生成
                        if (await this.needsRegeneration(dateStr)) {
                            outdatedDates.push(dateStr);
                        }
                    }
                }
            }

            return outdatedDates;
        } catch (err) {
            StatusLogger.error('[LogStatsManager] Failed to get outdated date list', err);
            return outdatedDates;
        }
    }

    // ==================== Private Helper Methods ====================

    /**
     * 获取统计文件路径
     */
    private getStatsFilePath(dateStr: string): string {
        return path.join(this.baseDir, dateStr, 'stats.json');
    }

    /**
     * 从持久化文件读取日期统计结果
     * 读取 <baseDir>/usages/YYYY-MM-DD/stats.json 文件
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @returns 统计对象，不存在时返回 null
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const filePath = this.getStatsFilePath(dateStr);
        if (!fsSync.existsSync(filePath)) {
            return null;
        }

        try {
            // 读取与写入共用同一 filePath 的串行锁，避免 Windows 上 rename 替换目标文件时
            // 被本进程的 readFile 句柄占用导致 EPERM。
            const content = await AtomicJsonFile.runExclusive(filePath, () => fs.readFile(filePath, 'utf-8'));
            const statsData: TokenUsageStatsFromFile = JSON.parse(content);
            StatusLogger.debug(`[LogStatsManager] Read daily stats from stats.json: ${dateStr}`);
            return statsData;
        } catch (err) {
            StatusLogger.warn(`[LogStatsManager] Failed to read stats: ${dateStr}`, err);
            return null;
        }
    }

    /**
     * 检查指定日期的统计文件是否需要重新生成
     * 判断逻辑：
     * 1. 如果 stats.json 不存在，需要生成
     * 2. 如果没有 versionTimestamp（旧格式缓存），需要重新生成
     * 3. 如果 versionTimestamp < 代码版本时间戳，需要重新生成（代码更新了）
     * 4. 检查是否有更新的日志文件（snapshot / hourly jsonl）
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @returns true 表示需要重新生成，false 表示无需重新生成
     */
    private async needsRegeneration(dateStr: string): Promise<boolean> {
        const statsFilePath = this.getStatsFilePath(dateStr);
        // 如果 stats.json 不存在，需要生成
        if (!fsSync.existsSync(statsFilePath)) {
            return true;
        }

        try {
            // 读取 stats.json 内容，检查 versionTimestamp
            // 与写入共用同一文件的串行锁，避免 rename 时被本进程 readFile 句柄占用导致 EPERM
            const content = await AtomicJsonFile.runExclusive(statsFilePath, () => fs.readFile(statsFilePath, 'utf-8'));
            const statsData: TokenUsageStatsFromFile = JSON.parse(content);

            // 检查版本时间戳
            const savedVersionTimestamp = statsData.versionTimestamp;
            const codeVersionTimestamp = this.getCodeVersionTimestamp();

            // 步骤2: 如果没有 versionTimestamp（旧格式缓存），需要重新生成
            if (savedVersionTimestamp === undefined) {
                StatusLogger.debug(
                    `[LogStatsManager] stats.json for ${dateStr} requires recalculation (missing version timestamp, legacy cache)`
                );
                return true;
            }

            // 步骤3: 如果缓存版本 < 代码版本，需要重新生成
            if (savedVersionTimestamp < codeVersionTimestamp) {
                StatusLogger.debug(
                    `[LogStatsManager] stats.json for ${dateStr} requires recalculation (cache version: ${new Date(savedVersionTimestamp).toISOString()}, code version: ${new Date(codeVersionTimestamp).toISOString()})`
                );
                return true;
            }

            // 步骤4: 检查是否有更新的数据源
            const statsStats = fsSync.statSync(statsFilePath);
            const statsMtime = statsStats.mtimeMs;
            const dateFolder = path.join(this.baseDir, dateStr);
            if (!fsSync.existsSync(dateFolder)) {
                return false;
            }

            // 新 snapshot 数据源：requests.jsonl
            // mtime 用 >= 比较：同毫秒写入时（低精度文件系统/写入突发）严格大于会漏判过期
            const snapshotPath = path.join(dateFolder, 'requests.jsonl');
            const snapshotSourcePath = fsSync.existsSync(snapshotPath) ? snapshotPath : null;
            if (snapshotSourcePath) {
                const snapshotStats = fsSync.statSync(snapshotSourcePath);
                if (snapshotStats.mtimeMs >= statsMtime) {
                    StatusLogger.debug(`[LogStatsManager] stats.json for ${dateStr} is outdated (snapshot changed)`);
                    return true;
                }
            }

            // 旧 JSONL 数据源：兼容尚未整理的历史/回退路径
            const files = await fs.readdir(dateFolder);
            const logFiles = files.filter(f => /^\d{2}\.jsonl$/.test(f));
            for (const logFile of logFiles) {
                const logFilePath = path.join(dateFolder, logFile);
                const logStats = fsSync.statSync(logFilePath);
                if (logStats.mtimeMs >= statsMtime) {
                    StatusLogger.debug(
                        `[LogStatsManager] stats.json for ${dateStr} is outdated (log file ${logFile} changed)`
                    );
                    return true;
                }
            }

            // 没有更新的数据源，缓存有效
            return false;
        } catch (err) {
            StatusLogger.warn(`[LogStatsManager] Failed to check whether date ${dateStr} needs regeneration:`, err);
            return false;
        }
    }
}
