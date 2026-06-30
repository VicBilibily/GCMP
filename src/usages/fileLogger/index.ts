/*---------------------------------------------------------------------------------------------
 *  Token文件日志系统 - 主管理器
 *  整合路径管理、写入管理、读取管理、统计管理
 *--------------------------------------------------------------------------------------------*/

/**
 * 用量缓存版本时间戳
 * ⚠️ 手动更新：当代码有导致缓存格式不兼容的变更时，需要手动更新此时间戳
 * 缓存判断逻辑：stats.json 修改时间 >= 缓存时间时，需要重新计算
 * 更新后首次运行会自动用当前时间创建新缓存，后续使用存储的缓存时间
 */
const USAGES_CACHE_VERSION_TIMESTAMP = new Date('2026-03-05T21:35:00+08:00').getTime();

import * as vscode from 'vscode';
import * as fsSync from 'fs';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { LogWriteManager } from './logWriteManager';
import { LogReadManager } from './logReadManager';
import { LogCleanupManager } from './logCleanupManager';
import { LogIndexManager } from './logIndexManager';
import { LogStatsManager } from './logStatsManager';
import { SnapshotManager } from './snapshotManager';
import { DateUtils } from './dateUtils';
import { EventEmitter } from 'events';
import { onLiveMetrics, type LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import type { DateIndexEntry, TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * Token文件日志管理器
 * 主入口,提供完整的日志记录和统计功能
 */
export class TokenFileLogger {
    // 启动时将 2 天前及更早的日志整理为 requests.jsonl。
    private readonly startupHistoricalCompactionDaysThreshold = 2;

    private readonly pathManager: LogPathManager;
    private readonly writeManager: LogWriteManager;
    private readonly readManager: LogReadManager;
    private readonly cleanupManager: LogCleanupManager;
    private readonly indexManager: LogIndexManager;
    private readonly logStatsManager: LogStatsManager;
    private readonly snapshotManager: SnapshotManager;
    private readonly eventEmitter: EventEmitter;

    // live metrics 订阅：仅驱动当前实例的 realtime UI / 内存态
    private readonly liveMetricsDisposable: vscode.Disposable;

    // 内存中的待更新日志(requestId -> log)
    private pendingLogs = new Map<string, TokenRequestLog>();

    // pendingLogs 清理任务
    private pendingLogsCleanupTimer: ReturnType<typeof setInterval> | null = null;
    private readonly pendingLogsTTL: number = 5 * 60 * 1000; // 5分钟 TTL
    private readonly pendingLogsCleanupInterval: number = 60 * 1000; // 1分钟检查一次

    // refreshCurrentStats 防抖：突发完成时合并为一次重算
    private statsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly statsRefreshDebounceMs = 1000; // 1秒防抖窗口

    constructor(private context: vscode.ExtensionContext) {
        const storageDir = context.globalStorageUri.fsPath;

        this.pathManager = new LogPathManager(storageDir);
        this.writeManager = new LogWriteManager(this.pathManager);
        this.readManager = new LogReadManager(this.pathManager);
        this.indexManager = new LogIndexManager(storageDir);
        this.cleanupManager = new LogCleanupManager(this.pathManager, this.indexManager);
        this.snapshotManager = new SnapshotManager(this.pathManager);
        this.logStatsManager = new LogStatsManager(
            this.readManager,
            storageDir,
            this.indexManager,
            this.snapshotManager
        );
        this.eventEmitter = new EventEmitter();

        // 订阅 live metrics streaming 事件：仅更新内存 pendingLog，不写文件。
        // 当前实例的实时指标通过 onLiveMetrics 事件总线直接驱动 liveMetricsRenderer（DOM 覆盖），
        // 无需文件 I/O。
        this.liveMetricsDisposable = onLiveMetrics((event: LiveStreamMetricEvent) => {
            if (event.type === 'firstChunk' || event.type === 'streamingUpdate') {
                this.updateStreamingMetrics(event);
            }
        });
    }

    /**
     * 初始化日志系统
     */
    async initialize(): Promise<void> {
        const startTime = Date.now();
        StatusLogger.info('[TokenFileLogger] File logging system initialization started');

        const baseDir = this.pathManager.getBaseDir();
        StatusLogger.info(`[TokenFileLogger] Base directory: ${baseDir}`);

        // 初始化缓存版本时间戳
        await this.initCacheVersionTimestamp();

        // 启动 pendingLogs 清理任务
        this.startPendingLogsCleanup();

        // 启动后后台清理历史日志。
        // 不 await，避免拖慢扩展初始化；阈值为 2，只处理 2 天前及更早的日期，
        // 今天/昨天只读原始 hourly .jsonl，不生成 requests.jsonl。
        void this.snapshotManager
            .compactHistoricalDates(this.startupHistoricalCompactionDaysThreshold)
            .then(compactedCount => {
                if (compactedCount > 0) {
                    StatusLogger.info(
                        `[TokenFileLogger] Startup historical snapshot compaction cleaned ${compactedCount} date folders`
                    );
                }
            })
            .catch(err => StatusLogger.warn('[TokenFileLogger] Startup historical snapshot compaction failed:', err));

        const elapsed = Date.now() - startTime;
        StatusLogger.info(`[TokenFileLogger] File logging system initialization completed (elapsed: ${elapsed}ms)`);
    }

    /**
     * 初始化缓存版本时间戳
     * 从 index.json 读取版本时间戳，若不存在或落后于代码版本则更新
     * 判断逻辑：
     * - 如果没有版本时间戳（旧缓存），需要重新计算
     * - 如果版本时间戳 < 代码版本时间，需要重新计算
     */
    private async initCacheVersionTimestamp(): Promise<void> {
        // 读取 index.json 中存储的版本时间戳
        const versionTimestamp = await this.indexManager.getVersionTimestamp();

        // 判断是否需要更新版本时间戳
        // 条件：没有版本时间戳（旧缓存）或版本时间戳小于代码版本时间
        const needsUpdate = !versionTimestamp || versionTimestamp < USAGES_CACHE_VERSION_TIMESTAMP;

        if (needsUpdate) {
            await this.indexManager.setVersionTimestamp(USAGES_CACHE_VERSION_TIMESTAMP);
            StatusLogger.debug(
                `[TokenFileLogger] Updated version timestamp: ${new Date(USAGES_CACHE_VERSION_TIMESTAMP).toISOString()}`
            );
        } else {
            StatusLogger.debug(
                `[TokenFileLogger] Using existing version timestamp: ${new Date(versionTimestamp).toISOString()}`
            );
        }

        // 同步代码版本时间戳到 LogStatsManager
        this.logStatsManager.updateCodeVersionTimestamp(USAGES_CACHE_VERSION_TIMESTAMP);
    }

    /**
     * 启动 pendingLogs 清理任务
     * 定期清除超过 TTL 的待更新日志，防止内存泄漏
     */
    private startPendingLogsCleanup(): void {
        // 定期检查并清理过期的 pendingLogs
        this.pendingLogsCleanupTimer = setInterval(() => {
            this.cleanupExpiredPendingLogs();
        }, this.pendingLogsCleanupInterval);

        StatusLogger.debug(
            `[TokenFileLogger] Pending logs cleanup task started (TTL: ${this.pendingLogsTTL}ms, interval: ${this.pendingLogsCleanupInterval}ms)`
        );
    }

    /**
     * 清理过期的 pendingLogs
     */
    private cleanupExpiredPendingLogs(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];
        for (const [requestId, log] of this.pendingLogs.entries()) {
            const age = now - log.timestamp;
            if (age > this.pendingLogsTTL) {
                expiredKeys.push(requestId);
            }
        }

        if (expiredKeys.length > 0) {
            for (const requestId of expiredKeys) {
                this.pendingLogs.delete(requestId);
                StatusLogger.warn(
                    `[TokenFileLogger] Removed expired pending log: ${requestId} (not updated for more than ${this.pendingLogsTTL}ms)`
                );
            }
            StatusLogger.info(`[TokenFileLogger] Removed ${expiredKeys.length} expired pending logs`);
        }
    }

    /**
     * 获取存储目录路径
     */
    getStorageDir(): string {
        return this.pathManager.getBaseDir();
    }

    // ==================== 写入操作 ====================

    /**
     * 判断指定日期是否应从原始 hourly .jsonl 读取。
     * 仅“今天”和“昨天”读 raw .jsonl；更早的日期统一读 requests.jsonl 快照。
     * 使用日历日对比，避免跨 48h 边界时把已整理为快照的日期误判为 raw。
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
     * 获取提供商显示名称（处理特殊情况）
     * 例如：providerKey 为 "kimi" 时，显示名称应为 "Kimi"
     */
    private getProviderDisplayName(providerKey: string, providerName: string): string {
        // 特殊处理：kimi 显示为 Kimi
        if (providerKey === 'kimi') {
            return 'Kimi';
        }
        return providerName;
    }

    /**
     * 记录预估token(请求前调用)
     */
    async recordEstimatedTokens(params: {
        requestId: string;
        providerKey: string;
        providerName: string;
        modelId: string;
        modelName: string;
        estimatedInput: number;
        estimatedIncrement?: number;
        maxInputTokens?: number;
        requestKind?: string; // 请求来源类型
        sessionId?: string;
        requestInitiator?: string;
        capturingTokenCorrelationId?: string;
        otelTraceContext?: TokenRequestLog['otelTraceContext'];
        timestamp?: number; // 可选: 自定义时间戳(用于测试数据生成)
    }): Promise<void> {
        const now = params.timestamp ?? Date.now();

        // 获取显示名称（处理特殊情况）
        const displayName = this.getProviderDisplayName(params.providerKey, params.providerName);

        const log: TokenRequestLog = {
            requestId: params.requestId,
            timestamp: now,
            isoTime: new Date(now).toISOString(),
            providerKey: params.providerKey,
            providerName: displayName,
            modelId: params.modelId,
            modelName: params.modelName,
            estimatedInput: params.estimatedInput,
            estimatedIncrement: params.estimatedIncrement,
            rawUsage: null,
            status: 'estimated',
            maxInputTokens: params.maxInputTokens,
            requestKind: params.requestKind,
            sessionId: params.sessionId,
            requestInitiator: params.requestInitiator,
            capturingTokenCorrelationId: params.capturingTokenCorrelationId,
            otelTraceContext: params.otelTraceContext
        };

        // 暂存到内存
        this.pendingLogs.set(params.requestId, log);

        // 写入文件
        await this.writeManager.appendLog(log);

        // 通知状态栏有新的预估请求
        this.notifyUpdate();

        StatusLogger.info(
            `[TokenFileLogger] 记录预估token: ${params.requestId}, model=${params.modelName}, tokens=${params.estimatedInput}`
        );
    }

    /**
     * 更新实际token(请求完成后调用)
     * 只有当前实例在请求完成时才计算统计并保存
     */
    async updateActualTokens(params: {
        requestId: string;
        sessionId?: string;
        rawUsage?: TokenRequestLog['rawUsage'];
        status: 'completed' | 'failed' | 'cancelled';
        /** 流开始时间 (毫秒时间戳) */
        streamStartTime?: number;
        /** 流结束时间 (毫秒时间戳) */
        streamEndTime?: number;
    }): Promise<void> {
        const pendingLog = this.pendingLogs.get(params.requestId);

        if (!pendingLog) {
            StatusLogger.warn(`[TokenFileLogger] No pending log found for update: ${params.requestId}`);
            return;
        }

        // 更新时间戳逻辑:
        // - 如果当前时间与原始记录时间相同（毫秒级），则在原始时间戳基础上+1毫秒
        // - 否则使用当前时间戳
        // 这样可以确保相同毫秒内的多次更新能保持顺序，不同时刻的更新使用准确的当前时间
        const now = Date.now();
        const originalTimestamp = pendingLog.timestamp;
        const isSameTime = now === originalTimestamp;
        if (isSameTime) {
            // 同一毫秒内，+1ms保持顺序
            pendingLog.timestamp = originalTimestamp + 1;
        } else {
            // 不同时刻，使用当前时间
            pendingLog.timestamp = now;
        }

        pendingLog.isoTime = new Date(pendingLog.timestamp).toISOString();

        // 更新日志对象
        pendingLog.rawUsage = params.rawUsage ?? null;
        pendingLog.status = params.status;
        // 补充 sessionId（新会话首条消息时 estimated 记录无 sessionId，由 Handler 生成后补充）
        if (params.sessionId && !pendingLog.sessionId) {
            pendingLog.sessionId = params.sessionId;
        }

        // 更新流时间信息（如果提供）
        if (params.streamStartTime !== undefined) {
            pendingLog.streamStartTime = params.streamStartTime;
        }
        if (params.streamEndTime !== undefined) {
            pendingLog.streamEndTime = params.streamEndTime;
        }

        // 写入文件(追加新行,形成流水记录)
        await this.writeManager.appendLog(pendingLog);

        // 从内存移除
        this.pendingLogs.delete(params.requestId);

        // 触发统计刷新（防抖，1s 内多次完成合并为一次重算）
        this.refreshCurrentStats();

        // 通知本实例的监听者
        this.notifyUpdate();

        StatusLogger.info(
            `[TokenFileLogger] Updated actual tokens: ${params.requestId}, status=${params.status}, rawUsage=${params.rawUsage ? 'recorded' : 'not recorded'}`
        );
    }

    // ==================== 读取和统计操作 ====================

    /**
     * 获取今日统计
     */
    async getTodayStats(): Promise<TokenUsageStatsFromFile> {
        const dateStr = DateUtils.getTodayDateString();
        return this.logStatsManager.getDateStats(dateStr);
    }

    /**
     * 获取指定日期的统计
     * 优先从缓存读取
     */
    async getDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.logStatsManager.getDateStats(dateStr);
    }

    /**
     * 获取指定日期的统计(优先走缓存，由签名机制保证正确性)
     * 适用于详情界面：refreshCurrentStats 已在请求路径上更新了 stats.json，
     * 这里走 needsRegeneration 检查即可命中缓存，避免重复 calculateDateStats
     */
    async getDateStatsFromFile(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.logStatsManager.getDateStats(dateStr);
    }

    /**
     * 获取指定日期的所有小时统计
     */
    async getAllHourStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        // 尝试从持久化的统计文件读取完整的日期统计（包含所有小时）
        const saved = await this.logStatsManager.getDateStats(dateStr);
        if (saved && saved.hourly && Object.keys(saved.hourly).length > 0) {
            StatusLogger.debug(
                `[TokenFileLogger] Loaded all hourly stats from cache: ${dateStr}, hourCount=${Object.keys(saved.hourly).length}`
            );
            return saved;
        }
        // 如果没有持久化的统计文件，返回 null，让调用方决定是否需要计算
        return null;
    }

    /**
     * 检查并重新生成过期的统计数据
     * 在打开统计页面时调用，确保所有日期的 stats.json 都是最新的
     * @returns 成功重新生成的日期统计
     */
    async regenerateOutdatedStats(): Promise<Record<string, TokenUsageStatsFromFile>> {
        return this.logStatsManager.regenerateOutdatedStats();
    }

    /**
     * 读取指定日期的原始日志
     */
    async readDateLogs(dateStr: string): Promise<TokenRequestLog[]> {
        return this.readManager.readDateLogs(dateStr);
    }

    /**
     * 获取请求详情列表(每个requestId的最终状态)
     * 用于详情页面展示。
     * 今天/昨天直接读取原始 hourly .jsonl；更早的日期读取 requests.jsonl，必要时从 jsonl 构建。
     * 兜底：raw jsonl 可能因手动清理/迁移已被删除，若不存在 raw 文件则尝试历史 requests.jsonl 快照。
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        if (this.shouldReadRawJsonl(dateStr)) {
            const hasRaw = this.hasRawJsonlFiles(dateStr);
            if (hasRaw) {
                return this.readManager.getRequestDetails(dateStr);
            }
            // raw jsonl 已被清理：尝试 snapshot 兜底，避免该日期请求记录显示为空
            const snapshotRecords = await this.snapshotManager.read(dateStr);
            if (snapshotRecords) {
                return snapshotRecords;
            }
            return [];
        }

        // 历史日期：从 requests.jsonl 读取，回退到 JSONL 合并并构建历史快照。
        const snapshotRecords = await this.snapshotManager.read(dateStr);
        if (snapshotRecords) {
            return snapshotRecords;
        }
        const details = await this.readManager.getRequestDetails(dateStr);
        if (details.length > 0) {
            this.snapshotManager
                .buildSnapshotFromLogs(dateStr, details)
                .catch(err =>
                    StatusLogger.warn(`[TokenFileLogger] Failed to build requests snapshot from logs: ${dateStr}`, err)
                );
        }
        return details;
    }

    /**
     * 判断指定日期目录是否存在原始 hourly .jsonl 文件。
     */
    private hasRawJsonlFiles(dateStr: string): boolean {
        const dateFolder = this.pathManager.getDateFolderPath(dateStr);
        if (!fsSync.existsSync(dateFolder)) {
            return false;
        }
        try {
            const files = fsSync.readdirSync(dateFolder);
            return files.some((f: string) => /^\d{2}\.jsonl$/.test(f));
        } catch {
            return false;
        }
    }

    /**
     * 获取最近的请求详情（性能优化版本）
     * 仅读取最近 N 条请求，避免在有大量日志时加载整个日期的数据
     * 用于状态栏等需要快速响应的场景
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        const pendingLogs = this.getPendingLogs();
        const pendingRequestIds = new Set(pendingLogs.map(l => l.requestId));

        if (this.shouldReadRawJsonl(dateStr)) {
            // 若 raw hourly .jsonl 存在，优先用它；仅在 raw 被清理后才 fallback snapshot，
            // 避免今天/昨天有 raw 时仍读到旧的 requests.jsonl 快照。
            const useRaw = this.hasRawJsonlFiles(dateStr);
            if (useRaw) {
                const details = await this.readManager.getRecentRequestDetails(dateStr, limit);
                const completed = details.filter(l => !pendingRequestIds.has(l.requestId));
                return [...completed, ...pendingLogs].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
            }
            // raw jsonl 已被清理：用 snapshot 兜底，仍按限制返回
            const snapshotRecords = await this.snapshotManager.read(dateStr);
            if (snapshotRecords) {
                const completed = snapshotRecords.filter(l => !pendingRequestIds.has(l.requestId));
                return [...completed, ...pendingLogs].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
            }
            return pendingLogs.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
        }

        // 历史日期：先读 requests.jsonl 快照（更快）
        const snapshotRecords = await this.snapshotManager.read(dateStr);
        if (snapshotRecords) {
            // 合并 pending logs（内存中未完成的请求）
            const completed = snapshotRecords.filter(l => !pendingRequestIds.has(l.requestId));
            const all = [...completed, ...pendingLogs].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
            return all;
        }
        // 回退路径
        const details = await this.readManager.getRecentRequestDetails(dateStr, limit);
        // 异步构建 requests.jsonl 快照（buildSnapshotFromLogs 内部已处理今天不删 .jsonl）
        if (details.length > 0) {
            this.readManager
                .getRequestDetails(dateStr)
                .then(full => {
                    if (full.length > 0) {
                        this.snapshotManager.buildSnapshotFromLogs(dateStr, full).catch(() => {});
                    }
                })
                .catch(() => {});
        }
        return details;
    }

    /**
     * 获取还在进行中的 pending 日志（内存中的请求）
     * 这些请求已记录预估值但还未完成
     */
    getPendingLogs(): TokenRequestLog[] {
        return Array.from(this.pendingLogs.values());
    }

    /**
     * 获取所有日期的摘要信息
     * 用于日期列表显示，避免加载完整的 stats.json
     */
    async getIndex(): Promise<Record<string, DateIndexEntry>> {
        return this.indexManager.getIndex();
    }

    // ==================== 清理操作 ====================

    /**
     * 清理过期日志和统计(保留最近N天)
     * 先将 2 天前及更早的历史日期整理为 requests.jsonl 快照并删除原始 .jsonl
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        // 与读取策略保持一致：今天/昨天保留 raw .jsonl，更早历史优先整理为 requests.jsonl 快照
        await this.snapshotManager
            .compactHistoricalDates(this.startupHistoricalCompactionDaysThreshold)
            .catch(err => StatusLogger.warn('[TokenFileLogger] Historical snapshot compaction failed:', err));

        return this.cleanupManager.cleanupExpiredLogs(retentionDays);
    }

    // ==================== 管理操作 ====================

    /**
     * 刷新写入队列
     */
    async flush(): Promise<void> {
        await this.writeManager.flush();
    }

    /**
     * 销毁日志系统
     */
    async dispose(): Promise<void> {
        try {
            // 停止 pendingLogs 清理任务
            if (this.pendingLogsCleanupTimer) {
                clearInterval(this.pendingLogsCleanupTimer);
                this.pendingLogsCleanupTimer = null;
                StatusLogger.debug('[TokenFileLogger] Pending logs cleanup task stopped');
            }

            // 取消待触发的统计刷新（如有），避免 dispose 后再触发
            if (this.statsRefreshTimer) {
                clearTimeout(this.statsRefreshTimer);
                this.statsRefreshTimer = null;
                StatusLogger.debug('[TokenFileLogger] Stats refresh timer cancelled');
            }

            // 检查是否有待处理的日志
            const pendingLogCount = this.pendingLogs.size;
            if (pendingLogCount > 0) {
                StatusLogger.warn(
                    `[TokenFileLogger] Found ${pendingLogCount} pending log records during dispose; they may contain unfinished requests`
                );
                // 清理待处理日志
                this.pendingLogs.clear();
            }

            // 取消 live metrics 订阅
            this.liveMetricsDisposable.dispose();
            StatusLogger.debug('[TokenFileLogger] Live metrics subscription disposed');

            // 清理事件监听器
            this.eventEmitter.removeAllListeners();
            StatusLogger.debug('[TokenFileLogger] Event listeners cleaned up');

            // 等待写入队列完成并销毁
            await this.writeManager.dispose();
            StatusLogger.debug('[TokenFileLogger] Write manager disposed');

            // 清理历史快照管理器缓存
            this.snapshotManager.clearCache();
            StatusLogger.debug('[TokenFileLogger] Snapshot manager cache cleared');

            StatusLogger.info('[TokenFileLogger] File logging system disposed');
        } catch (error) {
            StatusLogger.error('[TokenFileLogger] Failed to dispose logging system:', error);
            throw error;
        }
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
    private notifyUpdate(): void {
        this.eventEmitter.emit('update');
    }

    /**
     * 处理 streaming 实时指标更新：仅更新内存 pendingLog，不写文件。
     *
     * 当前实例的实时指标通过 onLiveMetrics 事件总线直接驱动 liveMetricsRenderer，
     * 后者在表格行上覆盖 DOM（TTFT / 输出速度 / 最近输出增量），无需文件 I/O。
     * streaming 期间的中间指标只用于当前实例的实时展示，不参与持久化同步。
     */
    private updateStreamingMetrics(event: LiveStreamMetricEvent): void {
        const pendingLog = this.pendingLogs.get(event.requestId);
        if (!pendingLog) {
            return; // 请求已结束（updateActualTokens 已清除 pendingLog）
        }

        // 仅更新内存中的实时指标字段，供 getRecentRequestDetails（状态栏）合并使用
        if (event.streamStartTime !== undefined) {
            pendingLog.streamStartTime = event.streamStartTime;
        }
        if (event.tokensPerSecond !== undefined) {
            pendingLog.outputSpeed = event.tokensPerSecond;
        }
        if (event.estimatedOutputTokens !== undefined) {
            pendingLog.outputTokens = event.estimatedOutputTokens;
        }
    }

    // ==================== Private Helper Methods ====================

    /**
     * 刷新当前日期的统计（请求结束后调用，带 1s 防抖）
     *
     * 防抖理由：突发完成（如批量 tool-use）会在数百毫秒内触发多次 updateActualTokens，
     * 每次都调 getDateStats 会重复读 compact + 签名比对 + 写 stats.json。
     * 合并为窗口末尾的一次重算，期间多次完成的签名变化都会被捕获。
     */
    private refreshCurrentStats(): void {
        if (this.statsRefreshTimer) {
            return; // 已有待触发的刷新，复用即可（窗口末尾会看到最新数据）
        }
        this.statsRefreshTimer = setTimeout(() => {
            this.statsRefreshTimer = null;
            void this.doRefreshCurrentStats();
        }, this.statsRefreshDebounceMs);
    }

    private async doRefreshCurrentStats(): Promise<void> {
        const dateStr = DateUtils.getTodayDateString();

        try {
            // 等待写入队列完成
            await this.writeManager.flush();

            // 计算并保存统计（getDateStats 会自动处理增量更新和保存）
            await this.logStatsManager.getDateStats(dateStr, true);

            // 通知本实例的监听者
            this.notifyUpdate();

            StatusLogger.debug(`[TokenFileLogger] Refreshed hourly stats: ${dateStr}`);
        } catch (err) {
            StatusLogger.warn('[TokenFileLogger] Failed to refresh stats:', err);
        }
    }
}

// 导出类型
export type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

// 导出统计计算器
export { StatsCalculator } from './statsCalculator';
