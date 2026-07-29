/*---------------------------------------------------------------------------------------------
 *  Token Usages Manager
 *  Token 用量管理器 - 基于 fileLogger,无存储限制
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { TokenFileLogger, TokenUsageStatsFromFile } from './fileLogger';
import { UsageParser, ExtendedTokenRequestLog } from './fileLogger/usageParser';
import { DateUtils } from './fileLogger/dateUtils';
import { SessionTitleService } from './sessionTitleService';
import { InterInstanceBus } from '../interInstance';
import { LeaderElectionService } from '../status/leaderElectionService';
import { EventEmitter } from 'events';
import type { DateSummary } from './types';
import type {
    CostBreakdownLog,
    DateIndexEntry,
    GenericUsageData,
    OTelTraceContextLog,
    RawUsageData,
    SessionRecoverySource
} from './fileLogger/types';
import type { MultiDayAnalysisResult } from './multiDay/types';
import { MultiDayAggregator } from './multiDay/multiDayAggregator';
import { TrendCalculator } from './multiDay/trendCalculator';

const MAX_SESSION_TITLE_LOOKBACK_DAYS = 7;
const SESSION_TITLE_MISS_CACHE_TTL_MS = 30 * 60 * 1000;

interface HistoricalSessionTitleCacheEntry {
    title: string | null;
    checkedAt: number;
}

/** updateActualTokens 参数（请求完成后调用） */
export interface UpdateActualTokensParams {
    requestId: string;
    sessionId?: string;
    sessionTitle?: string;
    rawUsage?: RawUsageData;
    status: 'completed' | 'failed' | 'cancelled';
    /** 流开始时间 (毫秒时间戳) */
    streamStartTime?: number;
    /** 流结束时间 (毫秒时间戳) */
    streamEndTime?: number;
    /** 客户端预估成本，由 Handler 通过 calculateCostWithBreakdown 计算，单位 USD */
    estimatedCost?: number;
    /** 成本计算明细（命中单价、成本组成等） */
    costBreakdown?: CostBreakdownLog;
}

/**
 * Token 用量管理器
 * 全局静态对象，管理 Token 消耗统计
 */
export class TokenUsagesManager {
    private fileLogger!: TokenFileLogger;
    private eventEmitter: EventEmitter;
    private initialized: boolean = false;
    private readonly historicalSessionTitleCache = new Map<string, HistoricalSessionTitleCacheEntry>();

    private constructor() {
        this.eventEmitter = new EventEmitter();
    }

    /**
     * 全局实例
     */
    static readonly instance = new TokenUsagesManager();

    /**
     * 异步初始化（应在扩展激活时调用）
     */
    async initialize(context: vscode.ExtensionContext): Promise<void> {
        if (this.initialized) {
            StatusLogger.trace(
                '[UsagesManager] Token usage manager already initialized, skipping duplicate initialization'
            );
            return;
        }

        const startTime = Date.now();

        // 初始化文件日志系统
        this.fileLogger = new TokenFileLogger(context);
        await this.fileLogger.initialize();

        this.initialized = true;

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(`[UsagesManager] Token usage manager initialization completed (elapsed: ${elapsed}ms)`);

        // 异步后台清理过期数据（不阻塞初始化）
        this.scheduleBackgroundCleanup();
    }

    /**
     * 调度后台清理任务。
     * 仅由 Leader 实例执行（通过 Leader 周期任务驱动，内部已保证仅 Leader 运行），
     * 避免多窗口下清理整目录与 Leader 的 stats 写入/历史压缩交叉竞态；
     * 周期任务每分钟触发，清理逻辑按固定间隔节流。
     */
    private scheduleBackgroundCleanup(): void {
        const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时最多执行一次
        let lastCleanupTime = 0;
        LeaderElectionService.registerPeriodicTask(async () => {
            if (Date.now() - lastCleanupTime < CLEANUP_INTERVAL_MS) {
                return;
            }
            lastCleanupTime = Date.now();
            try {
                const config = vscode.workspace.getConfiguration('gcmp.usages');
                const retentionDays = config.get<number>('retentionDays', 100);
                if (retentionDays > 0) {
                    StatusLogger.trace(
                        `[UsagesManager] Starting background cleanup for expired data (retaining ${retentionDays} days)`
                    );
                    const deletedCount = await this.fileLogger.cleanupExpiredLogs(retentionDays);
                    if (deletedCount > 0) {
                        StatusLogger.debug(
                            `[UsagesManager] Background cleanup completed: deleted data for ${deletedCount} expired dates`
                        );
                    } else {
                        StatusLogger.trace('[UsagesManager] Background cleanup completed: no expired data to remove');
                    }
                } else {
                    StatusLogger.trace('[UsagesManager] Data retention is set to keep forever, skipping cleanup');
                }
            } catch (error) {
                StatusLogger.warn(`[UsagesManager] Background cleanup for expired data failed: ${error}`);
            }
        });
    }

    /**
     * 获取存储目录路径
     */
    getStorageDir(): string {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager is not initialized. Call initialize() first.');
        }
        return this.fileLogger.getStorageDir();
    }

    /**
     * 记录预估的输入 token（请求前调用）
     */
    async recordEstimatedTokens(params: {
        providerKey: string;
        displayName: string;
        modelId: string;
        modelName: string;
        estimatedInputTokens: number;
        estimatedIncrement?: number;
        maxInputTokens?: number;
        requestKind?: string;
        sessionId?: string;
        sessionRecoverySource?: SessionRecoverySource;
        sessionTitle?: string;
        requestInitiator?: string;
        capturingTokenCorrelationId?: string;
        otelTraceContext?: OTelTraceContextLog;
        telemetryTurn?: number;
        timestamp?: number; // 可选: 自定义时间戳(用于测试数据生成)
    }): Promise<string> {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager is not initialized. Call initialize() first.');
        }

        // requestId 仅用于日志关联、内存索引和 UI 的 data-request-id；
        // OpenCode 请求头会通过 formatOpenCodeId 进一步格式化，无需额外做文件名级字符限制。
        const requestId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

        try {
            // 记录到文件日志系统（不等待结果）
            this.fileLogger
                .recordEstimatedTokens({
                    requestId,
                    providerKey: params.providerKey,
                    providerName: params.displayName,
                    modelId: params.modelId,
                    modelName: params.modelName,
                    estimatedInput: params.estimatedInputTokens,
                    estimatedIncrement: params.estimatedIncrement,
                    maxInputTokens: params.maxInputTokens,
                    requestKind: params.requestKind,
                    sessionId: params.sessionId,
                    sessionRecoverySource: params.sessionRecoverySource,
                    sessionTitle: params.sessionTitle,
                    requestInitiator: params.requestInitiator,
                    capturingTokenCorrelationId: params.capturingTokenCorrelationId,
                    otelTraceContext: params.otelTraceContext,
                    telemetryTurn: params.telemetryTurn,
                    timestamp: params.timestamp
                })
                .finally(() => {
                    // 通知更新
                    this.notifyUpdate();
                });

            StatusLogger.debug(
                `[Usages] Recorded estimated tokens: ${params.providerKey}/${params.modelName}, ${params.estimatedInputTokens} tokens, requestId=${requestId}`
            );

            return requestId;
        } catch (err) {
            StatusLogger.warn('[Usages] Failed to record estimated tokens:', err);
            throw err;
        }
    }

    /**
     * 更新实际 token 使用情况（请求完成后调用）。
     * 同步方法：文件写盘在内部 fire-and-forget，调用方无需也不应 await，
     * 以免阻塞响应完成/取消/失败链路的 Promise 结束。
     */
    updateActualTokens(params: UpdateActualTokensParams): void {
        if (!this.initialized) {
            StatusLogger.warn('TokenUsagesManager is not initialized, skipping token usage update');
            return;
        }

        try {
            // 将 rawUsage 中的 null 值转换为 undefined（适配 fileLogger 的期望类型）
            let normalizedUsage: GenericUsageData | undefined;
            if (params.rawUsage) {
                normalizedUsage = this.normalizeUsageData(params.rawUsage);
            }

            const currentSessionTitle =
                params.sessionTitle ??
                (params.sessionId ? SessionTitleService.instance.getTitle(params.sessionId) : undefined);
            if (params.sessionId) {
                SessionTitleService.instance.markSessionCompleted(params.sessionId);
            }

            // 更新文件日志系统（不等待结果）
            this.fileLogger
                .updateActualTokens({
                    requestId: params.requestId,
                    sessionId: params.sessionId,
                    sessionTitle: currentSessionTitle,
                    rawUsage: normalizedUsage,
                    status: params.status,
                    streamStartTime: params.streamStartTime,
                    streamEndTime: params.streamEndTime,
                    estimatedCost: params.estimatedCost,
                    costBreakdown: params.costBreakdown
                })
                .finally(() => {
                    // 通知更新
                    this.notifyUpdate();
                });

            // 计算流耗时信息（如果有）
            let durationInfo = '';
            if (params.streamStartTime && params.streamEndTime) {
                const duration = params.streamEndTime - params.streamStartTime;
                durationInfo = `, duration=${duration}ms`;
            }

            StatusLogger.debug(
                `[Usages] 更新实际 token: requestId=${params.requestId}, ` +
                    `rawUsage=${params.rawUsage ? 'recorded' : 'not recorded'}, ` +
                    `status=${params.status}${durationInfo}`
            );
        } catch (err) {
            StatusLogger.warn('[Usages] Failed to update actual tokens:', err);
            // 即使更新失败也要通知，让状态栏反应错误状态
            this.notifyUpdate();
        }
    }

    /**
     * 标准化 usage 数据 - 将 null 转换为 undefined
     */
    private normalizeUsageData(usage: RawUsageData): GenericUsageData {
        const normalized: GenericUsageData = {};

        for (const [key, value] of Object.entries(usage)) {
            // 跳过 null 值，保留 undefined 和其他值
            if (value !== null) {
                normalized[key as keyof GenericUsageData] = value as number | undefined | object;
            }
        }

        return normalized;
    }

    /**
     * 获取指定日期的统计数据(带缓存)
     * 适用于状态栏等需要快速响应的场景
     */
    async getDateStats(date: string): Promise<TokenUsageStatsFromFile & { date: string; lastUpdated: number }> {
        const stats = await this.fileLogger.getDateStats(date);
        return {
            ...stats,
            date,
            lastUpdated: Date.now()
        };
    }

    /**
     * 获取指定日期的统计数据(从文件直接读取,无缓存)
     * 适用于详情界面,确保显示最新的准确数据
     */
    async getDateStatsFromFile(date: string): Promise<TokenUsageStatsFromFile & { date: string; lastUpdated: number }> {
        const stats = await this.fileLogger.getDateStatsFromFile(date);
        return {
            ...stats,
            date,
            lastUpdated: Date.now()
        };
    }

    /**
     * 获取所有日期的统计摘要
     */
    async getAllDateSummaries(): Promise<DateSummary[]> {
        // 使用索引文件快速获取所有日期的摘要
        const summariesMap = await this.fileLogger.getIndex();
        const summaries: DateSummary[] = [];

        for (const [date, entry] of Object.entries(summariesMap) as [string, DateIndexEntry][]) {
            summaries.push({
                date,
                total_input: entry.total_input,
                total_cache: entry.total_cache,
                total_output: entry.total_output,
                total_requests: entry.total_requests,
                total_cost: entry.total_cost,
                total_cost_rmb: entry.total_cost_rmb,
                native_total_cost: entry.native_total_cost,
                native_total_cost_rmb: entry.native_total_cost_rmb
            });
        }

        // 按日期倒序排列
        summaries.sort((a, b) => b.date.localeCompare(a.date));
        return summaries;
    }

    /**
     * 获取最近的请求记录
     * 包括已完成的记录和仍在进行中的 pending 记录
     * 性能优化：只读取最近 limit*2 条已完成请求，减少大量日志场景下的内存占用
     */
    async getRecentRecords(limit: number = 100): Promise<ExtendedTokenRequestLog[]> {
        const today = DateUtils.getTodayDateString();
        // 使用性能优化版本，只读取最近 limit*2 条（以防过滤后不足）
        const details = await this.fileLogger.getRecentRequestDetails(today, limit * 2);
        // 获取内存中的 pending 日志（还未完成的请求）
        const pendingLogs = this.fileLogger.getPendingLogs();
        // 创建一个 pending requestId 的集合，用于快速查找
        const pendingRequestIds = new Set(pendingLogs.map(log => log.requestId));
        // 过滤文件中的日志：只保留那些不在 pending 中的（已完成的）
        const completedRequests = details.filter(log => !pendingRequestIds.has(log.requestId));
        // 合并完成的请求和仍在进行中的 pending 请求
        const allLogs = [...completedRequests, ...pendingLogs];
        // 按时间戳倒序排序（最新的在前）
        allLogs.sort((a, b) => b.timestamp - a.timestamp);
        this.seedSessionTitlesFromLogs(allLogs);
        await this.hydrateSessionTitles(this.collectSessionIds(allLogs));

        // 扩展记录，添加便捷访问方法
        const extended = this.enrichSessionTitles(UsageParser.extendLogs(allLogs));
        // 返回最近的 N 条记录
        return extended.slice(0, limit);
    }

    /**
     * 获取指定日期的请求记录
     */
    async getDateRecords(date: string): Promise<ExtendedTokenRequestLog[]> {
        const details = await this.fileLogger.getRequestDetails(date);
        this.seedSessionTitlesFromLogs(details);
        await this.hydrateSessionTitles(this.collectSessionIds(details));
        return this.enrichSessionTitles(UsageParser.extendLogs(details));
    }

    async hydrateSessionTitle(sessionId: string): Promise<string | undefined> {
        await this.hydrateSessionTitles([sessionId]);
        return SessionTitleService.instance.getTitle(sessionId);
    }

    async backfillResolvedSessionTitle(sessionId: string, title: string, requestId?: string): Promise<void> {
        if (!sessionId || !title || !this.initialized) {
            return;
        }

        this.setHistoricalSessionTitleCache(sessionId, title);

        if (!requestId) {
            return;
        }

        try {
            const persisted = await this.fileLogger.backfillSessionTitle({
                requestId,
                sessionId,
                sessionTitle: title
            });
            if (!persisted) {
                StatusLogger.debug(
                    `[UsagesManager] Skip late session title backfill because request log was not found: ${requestId}`
                );
            }
        } catch (error) {
            StatusLogger.warn(
                `[UsagesManager] Failed to backfill late session title for request ${requestId}: ${error}`
            );
        }
    }

    async backfillRequestSession(requestId: string, sessionId: string, sessionTitle?: string): Promise<void> {
        if (!requestId || !sessionId || !this.initialized) {
            return;
        }

        if (sessionTitle) {
            SessionTitleService.instance.rememberResolvedTitle(sessionId, sessionTitle);
            this.setHistoricalSessionTitleCache(sessionId, sessionTitle);
        }

        try {
            const persisted = await this.fileLogger.backfillRequestSession({
                requestId,
                sessionId,
                sessionTitle
            });
            if (!persisted) {
                StatusLogger.debug(
                    `[UsagesManager] Skip request session backfill because request log was not found: ${requestId}`
                );
            }
        } catch (error) {
            StatusLogger.warn(`[UsagesManager] Failed to backfill request session for ${requestId}: ${error}`);
        }
    }

    private seedSessionTitlesFromLogs(
        logs: ReadonlyArray<Pick<ExtendedTokenRequestLog, 'sessionId' | 'sessionTitle' | 'timestamp'>>
    ): void {
        for (const log of logs) {
            if (!log.sessionId || !log.sessionTitle) {
                continue;
            }
            SessionTitleService.instance.rememberResolvedTitle(log.sessionId, log.sessionTitle, log.timestamp);
            this.setHistoricalSessionTitleCache(log.sessionId, log.sessionTitle);
        }
    }

    private collectSessionIds(logs: ReadonlyArray<Pick<ExtendedTokenRequestLog, 'sessionId'>>): ReadonlyArray<string> {
        const sessionIds = new Set<string>();
        for (const log of logs) {
            if (log.sessionId) {
                sessionIds.add(log.sessionId);
            }
        }
        return [...sessionIds];
    }

    private async hydrateSessionTitles(sessionIds: Iterable<string>): Promise<void> {
        const unresolved = new Set<string>();
        const now = Date.now();

        for (const sessionId of sessionIds) {
            if (!sessionId) {
                continue;
            }
            const currentTitle = SessionTitleService.instance.getTitle(sessionId);
            if (currentTitle) {
                this.setHistoricalSessionTitleCache(sessionId, currentTitle);
                continue;
            }
            const cachedEntry = this.historicalSessionTitleCache.get(sessionId);
            if (cachedEntry) {
                if (cachedEntry.title) {
                    SessionTitleService.instance.rememberResolvedTitle(sessionId, cachedEntry.title);
                    continue;
                }
                if (now - cachedEntry.checkedAt < SESSION_TITLE_MISS_CACHE_TTL_MS) {
                    continue;
                }
            }
            unresolved.add(sessionId);
        }

        if (unresolved.size === 0) {
            return;
        }

        const summaries = await this.getAllDateSummaries();
        const oldestAllowedDate = DateUtils.getDateStringDaysAgo(MAX_SESSION_TITLE_LOOKBACK_DAYS);
        for (const summary of summaries) {
            if (unresolved.size === 0) {
                break;
            }
            if (summary.date < oldestAllowedDate) {
                break;
            }
            const details = await this.fileLogger.getRequestDetails(summary.date);
            this.seedSessionTitlesFromLogs(details);
            for (const record of details) {
                if (!record.sessionId || !unresolved.has(record.sessionId) || !record.sessionTitle) {
                    continue;
                }
                unresolved.delete(record.sessionId);
            }
        }

        for (const sessionId of unresolved) {
            this.setHistoricalSessionTitleCache(sessionId, null);
        }
    }

    private setHistoricalSessionTitleCache(sessionId: string, title: string | null): void {
        this.historicalSessionTitleCache.set(sessionId, {
            title,
            checkedAt: Date.now()
        });
    }

    private enrichSessionTitles(records: ExtendedTokenRequestLog[]): ExtendedTokenRequestLog[] {
        // 以当前进程内 SessionTitleService 的权威映射覆盖日志快照：
        // 标题请求晚到时，已完成请求在本窗口内仍可立即显示正式标题。
        for (const record of records) {
            if (!record.sessionId) {
                continue;
            }
            const title = SessionTitleService.instance.getTitle(record.sessionId);
            if (title) {
                record.sessionTitle = title;
            }
        }
        return records;
    }

    /**
     * 监听统计更新事件
     */
    onStatsUpdate(listener: () => void): vscode.Disposable {
        this.eventEmitter.on('update', listener);
        return {
            dispose: () => {
                this.eventEmitter.off('update', listener);
            }
        };
    }

    /**
     * 通知统计更新
     */
    private notifyUpdate() {
        this.eventEmitter.emit('update');

        // 异步广播跨实例 Token 用量更新
        const today = DateUtils.getTodayDateString();
        void this.fileLogger
            .getTodayStats()
            .then(stats => {
                InterInstanceBus.publish({
                    type: 'tokenUsageUpdated',
                    payload: {
                        date: today,
                        totalTokens: (stats.total.actualInput ?? 0) + (stats.total.outputTokens ?? 0),
                        totalRequests: stats.total.requests ?? 0
                    }
                });
            })
            .catch(error => {
                StatusLogger.trace(`[UsagesManager] Failed to publish token usage update: ${error}`);
            });
    }

    /**
     * 对外暴露的统计更新通知入口
     * 供跨实例协调场景调用（如主实例收到 statsRefreshRequested 完成刷新后广播）
     */
    notifyStatsUpdate(): void {
        this.notifyUpdate();
    }

    /**
     * 获取文件日志系统实例
     */
    getFileLogger(): TokenFileLogger {
        return this.fileLogger;
    }

    /**
     * 多日统计聚合
     */
    async getMultiDayStats(dateFrom: string, dateTo: string): Promise<MultiDayAnalysisResult> {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager is not initialized. Call initialize() first.');
        }
        const startTime = Date.now();

        // 确保最近几天的 stats.json 是最新的（异步写入可能还没落盘）
        await this.fileLogger.regenerateOutdatedStats();

        const aggregator = new MultiDayAggregator(this.fileLogger);
        const base = await aggregator.aggregate(dateFrom, dateTo);

        // 趋势计算
        const trendCalc = new TrendCalculator();
        const trendSeries = trendCalc.enrich(base.trendSeries);

        // 计算环比
        const dayCount = base.dayCount;
        let tokensChangePct: number | null = null;
        if (base.missingDates.length === 0 && dayCount > 0 && base.summary.totalTokens > 0) {
            // 与上一等长周期对比
            const prevFrom = new Date(dateFrom);
            prevFrom.setDate(prevFrom.getDate() - dayCount);
            const prevTo = new Date(dateFrom);
            prevTo.setDate(prevTo.getDate() - 1);
            const prevStr = (d: Date) => d.toISOString().slice(0, 10);
            try {
                const prevResult = await aggregator.aggregate(prevStr(prevFrom), prevStr(prevTo));
                if (prevResult.missingDates.length === 0) {
                    tokensChangePct = trendCalc.calcPeriodOverPeriod(
                        base.summary.totalTokens,
                        prevResult.summary.totalTokens
                    );
                }
            } catch {
                /* ignore prev period errors */
            }
        }

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(
            `[UsagesManager] Multi-day aggregation ${dateFrom}→${dateTo} (${base.dayCount}d) in ${elapsed}ms`
        );

        return { ...base, trendSeries, summary: { ...base.summary, tokensChangePct } };
    }

    /**
     * 释放资源
     */
    async dispose() {
        if (!this.initialized) {
            return;
        }
        await this.fileLogger.dispose();
        this.initialized = false;
    }
}
