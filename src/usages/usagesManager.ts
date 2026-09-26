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
    SessionRecoverySource,
    TokenRequestLog
} from './fileLogger/types';
import type { MultiDayAnalysisResult } from './multiDay/types';
import { MultiDayAggregator } from './multiDay/multiDayAggregator';
import { TrendCalculator } from './multiDay/trendCalculator';
import {
    buildNativeCostSplitIndex,
    buildRequestTotals,
    buildSessionGroupSummaries,
    filterRecordsBySession,
    sliceRecordsPage,
    sortRecordsByTimestampDesc,
    summarizeSessionRecords,
    summarizeSessionRecoveryDebugInfo,
    UNKNOWN_SESSION_ID
} from '../ui/usagesView/aggregation';
import { UsagesQueryCoordinator } from './query/usagesQueryCoordinator';
import { normalizeUsagesPendingRecords } from './query/validation';
import type {
    UsagesDateOverview,
    UsagesPendingRecord,
    UsagesQuery,
    UsagesQueryResult,
    UsagesRecordsPageResult,
    UsagesTrackRecordsResult
} from './query/types';

const MAX_SESSION_TITLE_LOOKBACK_DAYS = 7;
const SESSION_TITLE_MISS_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_DATE_RECORD_CACHE_ENTRIES = 2;
const MAX_DATE_RECORD_CACHE_RECORDS = 20_000;
const INITIAL_RECORDS_PAGE_SIZE = 20;

interface HistoricalSessionTitleCacheEntry {
    title: string | null;
    checkedAt: number;
}

interface DateRecordsCacheEntry {
    signature: string;
    records: ExtendedTokenRequestLog[];
}

/** updateActualTokens 参数（请求完成后调用） */
export interface UpdateActualTokensParams {
    requestId: string;
    sessionId?: string;
    sessionTitle?: string;
    rawUsage?: RawUsageData;
    status: 'completed' | 'failed' | 'cancelled';
    /** 实际发起上游请求的时间戳（不含限流排队） */
    requestMetricStartTime?: number;
    /** 本次请求是否经历过限流排队/等待 */
    wasThrottled?: boolean;
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
    private usagesQueryCoordinator: UsagesQueryCoordinator | undefined;
    private leaderChangeDisposable: vscode.Disposable | undefined;
    private cacheInvalidationDisposable: vscode.Disposable | undefined;
    private dateRecordsCache = new Map<string, DateRecordsCacheEntry>();
    private dateRecordsBuilds = new Map<string, Promise<ExtendedTokenRequestLog[]>>();
    private cachedDateRecords = 0;
    private dateRecordsCacheGeneration = 0;
    private backgroundSessionTitleIds = new Set<string>();
    private backgroundSessionTitleHydration: Promise<void> | undefined;

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

        this.usagesQueryCoordinator = new UsagesQueryCoordinator(
            (query, pendingRecords, isRemote) => this.executeUsagesQuery(query, pendingRecords, isRemote),
            () => {
                this.fileLogger.clearDetailCaches();
                this.clearDateRecordsCache();
            },
            (query, expectedPendingRecords) => {
                if (query.kind === 'sessionTitle') {
                    return true;
                }
                const date = 'date' in query ? query.date : undefined;
                const pendingLogs = this.fileLogger.getPendingLogs();
                if (
                    pendingLogs.some(
                        log =>
                            log.status !== 'estimated' &&
                            (!date || DateUtils.formatDate(new Date(log.timestamp)) === date)
                    )
                ) {
                    return false;
                }
                if (!expectedPendingRecords) {
                    return true;
                }
                const currentPendingRecords = normalizeUsagesPendingRecords(this.getEstimatedPendingRecords(date));
                return (
                    currentPendingRecords !== undefined &&
                    this.arePendingRecordsEqual(expectedPendingRecords, currentPendingRecords)
                );
            }
        );
        this.leaderChangeDisposable = LeaderElectionService.onLeaderChanged(isLeader => {
            if (!isLeader) {
                this.fileLogger.clearDetailCaches();
                this.clearDateRecordsCache();
            }
        });
        this.cacheInvalidationDisposable = InterInstanceBus.subscribe('tokenUsageUpdated', event => {
            const date = (event.payload as { date?: unknown }).date;
            if (typeof date === 'string') {
                this.fileLogger.invalidateDetailCaches(date);
                this.clearDateRecordsCache(date);
            }
        });

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
        const timestamp = params.timestamp ?? Date.now();
        const recordDate = DateUtils.formatDate(new Date(timestamp));

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
                    timestamp
                })
                .finally(() => {
                    this.clearDateRecordsCache(recordDate);
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
            const pendingLog = this.fileLogger.getPendingLogs().find(log => log.requestId === params.requestId);
            const recordDate =
                pendingLog ?
                    DateUtils.formatDate(new Date(pendingLog.timestamp))
                :   this.getRequestDate(params.requestId);
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
                    requestMetricStartTime: params.requestMetricStartTime,
                    wasThrottled: params.wasThrottled,
                    streamStartTime: params.streamStartTime,
                    streamEndTime: params.streamEndTime,
                    estimatedCost: params.estimatedCost,
                    costBreakdown: params.costBreakdown
                })
                .finally(() => {
                    this.clearDateRecordsCache(recordDate);
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
        const summariesMap = await this.fileLogger.getIndexFast();
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
        if (this.usagesQueryCoordinator) {
            const pendingRecords = await this.flushBeforeRemoteQuery();
            return this.usagesQueryCoordinator.run({ kind: 'recentRecords', limit }, pendingRecords);
        }
        return this.getRecentRecordsLocal(limit);
    }

    private async getRecentRecordsLocal(
        limit: number,
        pendingRecords: readonly UsagesPendingRecord[] = [],
        throwOnFailure = false
    ): Promise<ExtendedTokenRequestLog[]> {
        const today = DateUtils.getTodayDateString();
        // 使用性能优化版本，只读取最近 limit*2 条（以防过滤后不足）
        const details = await this.fileLogger.getRecentRequestDetails(today, limit * 2, throwOnFailure);
        const allLogs = this.mergePendingLogs(details, pendingRecords);
        this.seedSessionTitlesFromLogs(allLogs, pendingRecords);
        await this.hydrateSessionTitles(this.collectSessionIds(allLogs));

        // 扩展记录，添加便捷访问方法
        const extended = this.enrichSessionTitles(UsageParser.extendLogs(allLogs), pendingRecords);
        // 返回最近的 N 条记录
        return extended.slice(0, limit);
    }

    async getDateOverview(date: string): Promise<UsagesDateOverview> {
        if (!this.usagesQueryCoordinator) {
            return this.buildDateOverview(await this.getDateRecordsForQuery(date));
        }
        const pendingRecords = await this.flushBeforeRemoteQuery(date);
        const overview = await this.usagesQueryCoordinator.run({ kind: 'dateOverview', date }, pendingRecords);
        if (this.initialized) {
            for (const group of overview.sessionGroups) {
                if (group.title && !SessionTitleService.instance.getTitle(group.sessionId)) {
                    SessionTitleService.instance.rememberResolvedTitle(group.sessionId, group.title);
                }
            }
            const records = overview.initialRecordsPage?.records ?? [];
            this.seedSessionTitlesFromLogs(records, pendingRecords);
            this.scheduleSessionTitleHydration(
                overview.sessionGroups
                    .filter(group => {
                        const terminalCount =
                            group.summary.completedCount + group.summary.failedCount + group.summary.cancelledCount;
                        return group.sessionId !== UNKNOWN_SESSION_ID && terminalCount > 0;
                    })
                    .map(group => group.sessionId)
            );
            this.enrichSessionTitles(records, pendingRecords);
        }
        return overview;
    }

    async getRecordsPage(params: {
        date: string;
        mode: 'all' | 'session';
        sessionId?: string;
        page: number;
        pageSize: number;
    }): Promise<UsagesRecordsPageResult> {
        if (!this.usagesQueryCoordinator) {
            return this.buildRecordsPage(await this.getDateRecordsForQuery(params.date), params);
        }
        const pendingRecords = await this.flushBeforeRemoteQuery(params.date);
        const page = await this.usagesQueryCoordinator.run({ kind: 'recordsPage', ...params }, pendingRecords);
        if (this.initialized) {
            this.seedSessionTitlesFromLogs(page.records, pendingRecords);
            this.scheduleSessionTitleHydration(
                this.collectSessionIds(page.records.filter(record => record.status !== 'estimated'))
            );
            this.enrichSessionTitles(page.records, pendingRecords);
        }
        return page;
    }

    async getTrackRecords(params: {
        date: string;
        sessionIds: string[];
        limitPerSession: number;
    }): Promise<UsagesTrackRecordsResult> {
        if (!this.usagesQueryCoordinator) {
            return this.buildTrackRecords(await this.getDateRecordsForQuery(params.date), params);
        }
        const pendingRecords = await this.flushBeforeRemoteQuery(params.date);
        const result = await this.usagesQueryCoordinator.run({ kind: 'trackRecords', ...params }, pendingRecords);
        if (this.initialized) {
            const records = result.groups.flatMap(group => group.records);
            this.seedSessionTitlesFromLogs(records, pendingRecords);
            this.scheduleSessionTitleHydration(
                this.collectSessionIds(records.filter(record => record.status !== 'estimated'))
            );
            this.enrichSessionTitles(records, pendingRecords);
        }
        return result;
    }

    /**
     * 获取指定日期的请求记录
     */
    async getDateRecords(
        date: string,
        pendingRecords: readonly UsagesPendingRecord[] = []
    ): Promise<ExtendedTokenRequestLog[]> {
        return this.getDateRecordsInternal(date, pendingRecords, true);
    }

    private getDateRecordsForQuery(
        date: string,
        pendingRecords: readonly UsagesPendingRecord[] = [],
        scheduleTitleHydration = true
    ): Promise<ExtendedTokenRequestLog[]> {
        return this.getDateRecordsInternal(date, pendingRecords, false, scheduleTitleHydration);
    }

    private async getDateRecordsInternal(
        date: string,
        pendingRecords: readonly UsagesPendingRecord[],
        waitForSessionTitles: boolean,
        scheduleTitleHydration = true
    ): Promise<ExtendedTokenRequestLog[]> {
        const datePending = pendingRecords.filter(log => DateUtils.formatDate(new Date(log.timestamp)) === date);
        const hasLocalPending = this.fileLogger
            .getPendingLogs()
            .some(log => DateUtils.formatDate(new Date(log.timestamp)) === date);
        if (datePending.length > 0 || hasLocalPending) {
            const records = await this.buildDateRecords(date, datePending);
            return this.completeDateRecords(records, datePending, waitForSessionTitles, scheduleTitleHydration);
        }

        this.dateRecordsCache ??= new Map();
        this.dateRecordsBuilds ??= new Map();
        this.cachedDateRecords ??= 0;
        this.dateRecordsCacheGeneration ??= 0;

        const signature = this.fileLogger.getDetailSourceSignature(date);
        const cached = this.dateRecordsCache.get(date);
        if (cached?.signature === signature) {
            this.dateRecordsCache.delete(date);
            this.dateRecordsCache.set(date, cached);
            return this.completeDateRecords(cached.records, [], waitForSessionTitles, scheduleTitleHydration);
        }
        if (cached) {
            this.deleteDateRecordsCacheEntry(date);
        }

        const buildKey = `${date}\0${signature}`;
        const existingBuild = this.dateRecordsBuilds.get(buildKey);
        if (existingBuild) {
            return this.completeDateRecords(await existingBuild, [], waitForSessionTitles, scheduleTitleHydration);
        }

        const generation = this.dateRecordsCacheGeneration;
        const build = this.buildDateRecords(date, datePending)
            .then(records => {
                const signatureAfter = this.fileLogger.getDetailSourceSignature(date);
                const stillStable = !this.fileLogger
                    .getPendingLogs()
                    .some(log => DateUtils.formatDate(new Date(log.timestamp)) === date);
                if (generation === this.dateRecordsCacheGeneration && signatureAfter === signature && stillStable) {
                    this.setDateRecordsCache(date, signature, records);
                }
                return records;
            })
            .finally(() => {
                if (this.dateRecordsBuilds.get(buildKey) === build) {
                    this.dateRecordsBuilds.delete(buildKey);
                }
            });
        this.dateRecordsBuilds.set(buildKey, build);
        return this.completeDateRecords(await build, [], waitForSessionTitles, scheduleTitleHydration);
    }

    private async buildDateRecords(
        date: string,
        pendingRecords: readonly UsagesPendingRecord[]
    ): Promise<ExtendedTokenRequestLog[]> {
        const details = await this.fileLogger.getRequestDetails(date);
        const allLogs = this.mergePendingLogs(details, pendingRecords, date);
        this.seedSessionTitlesFromLogs(allLogs, pendingRecords);
        return UsageParser.extendLogs(allLogs);
    }

    private async completeDateRecords(
        records: ExtendedTokenRequestLog[],
        pendingRecords: readonly UsagesPendingRecord[],
        waitForSessionTitles: boolean,
        scheduleTitleHydration: boolean
    ): Promise<ExtendedTokenRequestLog[]> {
        const sessionIds = this.collectSessionIds(records);
        if (waitForSessionTitles) {
            await this.hydrateSessionTitles(sessionIds);
        } else if (scheduleTitleHydration) {
            this.scheduleSessionTitleHydration(sessionIds);
        }
        return this.enrichSessionTitles(records, pendingRecords);
    }

    private scheduleSessionTitleHydration(sessionIds: Iterable<string>): void {
        this.backgroundSessionTitleIds ??= new Set();
        for (const sessionId of sessionIds) {
            if (sessionId && !SessionTitleService.instance.getTitle(sessionId)) {
                this.backgroundSessionTitleIds.add(sessionId);
            }
        }
        if (this.backgroundSessionTitleIds.size === 0 || this.backgroundSessionTitleHydration) {
            return;
        }

        let titlesChanged = false;
        const hydration = (async () => {
            while (this.backgroundSessionTitleIds.size > 0) {
                const pendingIds = [...this.backgroundSessionTitleIds];
                this.backgroundSessionTitleIds.clear();
                await this.hydrateSessionTitles(pendingIds);
                titlesChanged ||= pendingIds.some(sessionId => !!SessionTitleService.instance.getTitle(sessionId));
            }
        })();
        this.backgroundSessionTitleHydration = hydration;
        void hydration
            .catch(error => {
                StatusLogger.warn('[UsagesManager] Background session title hydration failed:', error);
            })
            .finally(() => {
                if (this.backgroundSessionTitleHydration === hydration) {
                    this.backgroundSessionTitleHydration = undefined;
                }
                if (titlesChanged && this.initialized) {
                    this.eventEmitter.emit('update');
                }
                if (this.backgroundSessionTitleIds.size > 0) {
                    this.scheduleSessionTitleHydration([]);
                }
            });
    }

    private mergePendingLogs(
        details: TokenRequestLog[],
        pendingRecords: readonly UsagesPendingRecord[],
        date?: string
    ): TokenRequestLog[] {
        const terminalIds = new Set(details.filter(log => log.status !== 'estimated').map(log => log.requestId));
        // 在途快照不能把已经落盘的终态回退为 estimated。
        const pending = new Map<string, TokenRequestLog>(
            pendingRecords.filter(log => !terminalIds.has(log.requestId)).map(log => [log.requestId, log])
        );
        for (const log of this.fileLogger.getPendingLogs()) {
            if (!date || DateUtils.formatDate(new Date(log.timestamp)) === date) {
                pending.set(log.requestId, log);
            }
        }
        if (pending.size === 0) {
            return details;
        }
        return [...details.filter(log => !pending.has(log.requestId)), ...pending.values()].sort(
            (a, b) => b.timestamp - a.timestamp
        );
    }

    async hydrateSessionTitle(sessionId: string): Promise<string | undefined> {
        const localTitle = SessionTitleService.instance.getTitle(sessionId);
        if (localTitle) {
            this.setHistoricalSessionTitleCache(sessionId, localTitle);
            return localTitle;
        }
        const historicalTitle = this.historicalSessionTitleCache.get(sessionId)?.title;
        if (historicalTitle) {
            SessionTitleService.instance.rememberResolvedTitle(sessionId, historicalTitle);
            return historicalTitle;
        }
        if (this.usagesQueryCoordinator) {
            const title = await this.usagesQueryCoordinator.run({ kind: 'sessionTitle', sessionId });
            const resolvedLocally = SessionTitleService.instance.getTitle(sessionId);
            if (resolvedLocally) {
                this.setHistoricalSessionTitleCache(sessionId, resolvedLocally);
                return resolvedLocally;
            }
            if (title) {
                SessionTitleService.instance.rememberResolvedTitle(sessionId, title);
                this.setHistoricalSessionTitleCache(sessionId, title);
            }
            return title;
        }
        return this.hydrateSessionTitleLocal(sessionId);
    }

    private async hydrateSessionTitleLocal(sessionId: string): Promise<string | undefined> {
        await this.hydrateSessionTitles([sessionId]);
        return SessionTitleService.instance.getTitle(sessionId);
    }

    private async flushBeforeRemoteQuery(date?: string): Promise<UsagesPendingRecord[]> {
        if (!LeaderElectionService.isLeader() && InterInstanceBus.hasCompatibleUsagesQueryTransport()) {
            const pendingRecords = this.getEstimatedPendingRecords(date);
            await this.fileLogger.flush();
            return pendingRecords;
        }
        return [];
    }

    private getEstimatedPendingRecords(date?: string): UsagesPendingRecord[] {
        return this.fileLogger
            .getPendingLogs()
            .filter(
                log => log.status === 'estimated' && (!date || DateUtils.formatDate(new Date(log.timestamp)) === date)
            )
            .map(log => ({
                ...log,
                status: 'estimated' as const,
                rawUsage: null,
                sessionTitle:
                    (log.sessionId ? SessionTitleService.instance.getTitle(log.sessionId) : undefined) ??
                    log.sessionTitle
            }));
    }

    private arePendingRecordsEqual(
        expected: readonly UsagesPendingRecord[],
        current: readonly UsagesPendingRecord[]
    ): boolean {
        if (expected.length !== current.length) {
            return false;
        }
        const expectedRecords = expected.map(record => JSON.stringify(record)).sort();
        const currentRecords = current.map(record => JSON.stringify(record)).sort();
        return expectedRecords.every((record, index) => record === currentRecords[index]);
    }

    private async executeUsagesQuery(
        query: UsagesQuery,
        pendingRecords: readonly UsagesPendingRecord[] = [],
        isRemote = false
    ): Promise<UsagesQueryResult> {
        switch (query.kind) {
            case 'dateOverview':
                return {
                    kind: query.kind,
                    value: this.buildDateOverview(
                        await this.getDateRecordsForQuery(query.date, pendingRecords, !isRemote)
                    )
                };
            case 'recordsPage':
                return {
                    kind: query.kind,
                    value: this.buildRecordsPage(
                        await this.getDateRecordsForQuery(query.date, pendingRecords, !isRemote),
                        query
                    )
                };
            case 'trackRecords':
                return {
                    kind: query.kind,
                    value: this.buildTrackRecords(
                        await this.getDateRecordsForQuery(query.date, pendingRecords, !isRemote),
                        query
                    )
                };
            case 'recentRecords':
                return {
                    kind: query.kind,
                    value: await this.getRecentRecordsLocal(query.limit, pendingRecords, isRemote)
                };
            case 'sessionTitle':
                return { kind: query.kind, value: await this.hydrateSessionTitleLocal(query.sessionId) };
        }
    }

    private buildDateOverview(records: ExtendedTokenRequestLog[]): UsagesDateOverview {
        const allSummary = summarizeSessionRecords(records);
        const allTotals = buildRequestTotals(records);
        const initialPage = sliceRecordsPage(records, 1, INITIAL_RECORDS_PAGE_SIZE);
        return {
            allSummary,
            allTotals,
            nativeSplitIndex: buildNativeCostSplitIndex(records),
            sessionGroups: buildSessionGroupSummaries(records),
            initialRecordsPage: {
                mode: 'all',
                page: 1,
                pageSize: INITIAL_RECORDS_PAGE_SIZE,
                totalItems: initialPage.totalItems,
                records: initialPage.records,
                summary: allSummary,
                totals: allTotals,
                recoveryDebug: summarizeSessionRecoveryDebugInfo(records)
            }
        };
    }

    private buildRecordsPage(
        records: ExtendedTokenRequestLog[],
        params: {
            mode: 'all' | 'session';
            sessionId?: string;
            page: number;
            pageSize: number;
        }
    ): UsagesRecordsPageResult {
        const effectiveMode = params.mode === 'session' && params.sessionId ? 'session' : 'all';
        const source = effectiveMode === 'session' ? filterRecordsBySession(records, params.sessionId!) : records;
        const page = sliceRecordsPage(source, params.page, params.pageSize);
        return {
            mode: effectiveMode,
            sessionId: effectiveMode === 'session' ? params.sessionId : undefined,
            page: params.page,
            pageSize: params.pageSize,
            totalItems: page.totalItems,
            records: page.records,
            summary: summarizeSessionRecords(source),
            totals: buildRequestTotals(source),
            recoveryDebug: summarizeSessionRecoveryDebugInfo(source)
        };
    }

    private buildTrackRecords(
        records: ExtendedTokenRequestLog[],
        params: { sessionIds: string[]; limitPerSession: number }
    ): UsagesTrackRecordsResult {
        return {
            groups: params.sessionIds.map(sessionId => ({
                sessionId,
                records: sortRecordsByTimestampDesc(filterRecordsBySession(records, sessionId)).slice(
                    0,
                    params.limitPerSession
                )
            }))
        };
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
            } else {
                this.clearDateRecordsCache(this.getRequestDate(requestId));
            }
        } catch (error) {
            StatusLogger.warn(
                `[UsagesManager] Failed to backfill late session title for request ${requestId}: ${error}`
            );
        }
    }

    private seedSessionTitlesFromLogs(
        logs: ReadonlyArray<
            Pick<ExtendedTokenRequestLog, 'requestId' | 'status' | 'sessionId' | 'sessionTitle' | 'timestamp'>
        >,
        pendingRecords: readonly UsagesPendingRecord[] = []
    ): void {
        // 远端 pending 的请求时间不是标题版本，不能写入长期缓存。
        const remotePendingIds = new Set(pendingRecords.map(log => log.requestId));
        for (const log of logs) {
            if (
                !log.sessionId ||
                !log.sessionTitle ||
                (log.status === 'estimated' && remotePendingIds.has(log.requestId))
            ) {
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

        let historyReadFailed = false;
        for (let daysAgo = 0; daysAgo <= MAX_SESSION_TITLE_LOOKBACK_DAYS; daysAgo++) {
            if (unresolved.size === 0) {
                break;
            }
            const date = DateUtils.getDateStringDaysAgo(daysAgo);
            let details: TokenRequestLog[];
            try {
                details = await this.fileLogger.getRequestDetails(date);
            } catch (error) {
                historyReadFailed = true;
                StatusLogger.warn(`[UsagesManager] Failed to read historical session titles for ${date}:`, error);
                continue;
            }
            this.seedSessionTitlesFromLogs(details);
            for (const record of details) {
                if (!record.sessionId || !unresolved.has(record.sessionId) || !record.sessionTitle) {
                    continue;
                }
                unresolved.delete(record.sessionId);
            }
        }

        if (!historyReadFailed) {
            for (const sessionId of unresolved) {
                this.setHistoricalSessionTitleCache(sessionId, null);
            }
        }
    }

    private setHistoricalSessionTitleCache(sessionId: string, title: string | null): void {
        this.historicalSessionTitleCache.set(sessionId, {
            title,
            checkedAt: Date.now()
        });
    }

    private setDateRecordsCache(date: string, signature: string, records: ExtendedTokenRequestLog[]): void {
        this.deleteDateRecordsCacheEntry(date);
        if (records.length > MAX_DATE_RECORD_CACHE_RECORDS) {
            return;
        }
        this.dateRecordsCache.set(date, { signature, records });
        this.cachedDateRecords += records.length;
        while (
            this.dateRecordsCache.size > MAX_DATE_RECORD_CACHE_ENTRIES ||
            this.cachedDateRecords > MAX_DATE_RECORD_CACHE_RECORDS
        ) {
            const oldestDate = this.dateRecordsCache.keys().next().value;
            if (typeof oldestDate !== 'string') {
                break;
            }
            this.deleteDateRecordsCacheEntry(oldestDate);
        }
    }

    private deleteDateRecordsCacheEntry(date: string): void {
        const cached = this.dateRecordsCache.get(date);
        if (!cached) {
            return;
        }
        this.dateRecordsCache.delete(date);
        this.cachedDateRecords -= cached.records.length;
    }

    private clearDateRecordsCache(date?: string): void {
        this.dateRecordsCache ??= new Map();
        this.dateRecordsBuilds ??= new Map();
        this.cachedDateRecords ??= 0;
        this.dateRecordsCacheGeneration = (this.dateRecordsCacheGeneration ?? 0) + 1;
        if (date) {
            this.deleteDateRecordsCacheEntry(date);
            return;
        }
        this.dateRecordsCache.clear();
        this.cachedDateRecords = 0;
    }

    private getRequestDate(requestId: string): string | undefined {
        const timestamp = Number(requestId.split('_', 1)[0]);
        return Number.isFinite(timestamp) && timestamp > 0 ? DateUtils.formatDate(new Date(timestamp)) : undefined;
    }

    private enrichSessionTitles(
        records: ExtendedTokenRequestLog[],
        pendingRecords: readonly UsagesPendingRecord[] = []
    ): ExtendedTokenRequestLog[] {
        const pendingTitles = new Map<string, string>();
        if (pendingRecords.length > 0) {
            const activeIds = new Set(
                records.filter(record => record.status === 'estimated').map(record => record.requestId)
            );
            for (const record of pendingRecords) {
                if (activeIds.has(record.requestId) && record.sessionId && record.sessionTitle) {
                    pendingTitles.set(record.sessionId, record.sessionTitle);
                }
            }
        }
        for (const record of records) {
            if (!record.sessionId) {
                continue;
            }
            const title =
                pendingTitles.get(record.sessionId) ?? SessionTitleService.instance.getTitle(record.sessionId);
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
        this.usagesQueryCoordinator?.dispose();
        this.usagesQueryCoordinator = undefined;
        this.leaderChangeDisposable?.dispose();
        this.leaderChangeDisposable = undefined;
        this.cacheInvalidationDisposable?.dispose();
        this.cacheInvalidationDisposable = undefined;
        this.clearDateRecordsCache();
        this.dateRecordsBuilds.clear();
        this.backgroundSessionTitleIds.clear();
        await this.fileLogger.dispose();
        this.initialized = false;
    }
}
