/*---------------------------------------------------------------------------------------------
 *  Token文件日志系统 - 主管理器
 *  整合路径管理、写入管理、读取管理、统计管理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../../utils/statusLogger';
import { LogPathManager } from './logPathManager';
import { LogWriteManager } from './logWriteManager';
import { LogReadManager } from './logReadManager';
import { LogCleanupManager } from './logCleanupManager';
import { LogIndexManager } from './logIndexManager';
import { LogStatsManager } from './logStatsManager';
import { DateUtils } from './dateUtils';
import { EventEmitter } from 'events';
import type { DateIndexEntry, TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * Token文件日志管理器
 * 主入口,提供完整的日志记录和统计功能
 */
export class TokenFileLogger {
    private readonly pathManager: LogPathManager;
    private readonly writeManager: LogWriteManager;
    private readonly readManager: LogReadManager;
    private readonly cleanupManager: LogCleanupManager;
    private readonly indexManager: LogIndexManager;
    private readonly logStatsManager: LogStatsManager;
    private readonly eventEmitter: EventEmitter;

    // 内存中的待更新日志(requestId -> log)
    private pendingLogs = new Map<string, TokenRequestLog>();

    // pendingLogs 清理任务
    private pendingLogsCleanupTimer: ReturnType<typeof setInterval> | null = null;
    private readonly pendingLogsTTL: number = 5 * 60 * 1000; // 5分钟 TTL
    private readonly pendingLogsCleanupInterval: number = 60 * 1000; // 1分钟检查一次

    constructor(private context: vscode.ExtensionContext) {
        const storageDir = context.globalStorageUri.fsPath;

        this.pathManager = new LogPathManager(storageDir);
        this.writeManager = new LogWriteManager(this.pathManager);
        this.readManager = new LogReadManager(this.pathManager);
        this.indexManager = new LogIndexManager(storageDir);
        this.cleanupManager = new LogCleanupManager(this.pathManager, this.indexManager);
        this.logStatsManager = new LogStatsManager(this.readManager, storageDir, this.indexManager);
        this.eventEmitter = new EventEmitter();
    }

    /**
     * 初始化日志系统
     */
    async initialize(): Promise<void> {
        const startTime = Date.now();
        StatusLogger.info('[TokenFileLogger] 文件日志系统初始化');

        const baseDir = this.pathManager.getBaseDir();
        StatusLogger.info(`[TokenFileLogger] 基础目录: ${baseDir}`);

        // 启动 pendingLogs 清理任务
        this.startPendingLogsCleanup();

        const elapsed = Date.now() - startTime;
        StatusLogger.info(`[TokenFileLogger] 文件日志系统初始化完成 (耗时: ${elapsed}ms)`);
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
            `[TokenFileLogger] pendingLogs 清理任务已启动 (TTL: ${this.pendingLogsTTL}ms, 检查间隔: ${this.pendingLogsCleanupInterval}ms)`
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
                    `[TokenFileLogger] 清理过期的 pendingLog: ${requestId} (超过 ${this.pendingLogsTTL}ms 未更新)`
                );
            }
            StatusLogger.info(`[TokenFileLogger] 清理了 ${expiredKeys.length} 个过期的 pendingLogs`);
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
     * 记录预估token(请求前调用)
     */
    async recordEstimatedTokens(params: {
        requestId: string;
        providerKey: string;
        providerName: string;
        modelId: string;
        modelName: string;
        estimatedInput: number;
        maxInputTokens?: number;
        requestType?: 'chat' | 'completion' | 'fim' | 'nes';
        timestamp?: number; // 可选: 自定义时间戳(用于测试数据生成)
    }): Promise<void> {
        const now = params.timestamp ?? Date.now();

        const log: TokenRequestLog = {
            requestId: params.requestId,
            timestamp: now,
            isoTime: new Date(now).toISOString(),
            providerKey: params.providerKey,
            providerName: params.providerName,
            modelId: params.modelId,
            modelName: params.modelName,
            estimatedInput: params.estimatedInput,
            rawUsage: null,
            status: 'estimated',
            maxInputTokens: params.maxInputTokens,
            requestType: params.requestType
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
        rawUsage?: TokenRequestLog['rawUsage'];
        status: 'completed' | 'failed';
    }): Promise<void> {
        const pendingLog = this.pendingLogs.get(params.requestId);

        if (!pendingLog) {
            StatusLogger.warn(`[TokenFileLogger] 未找到待更新的日志: ${params.requestId}`);
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

        // 写入文件(追加新行,形成流水记录)
        await this.writeManager.appendLog(pendingLog);

        // 从内存移除
        this.pendingLogs.delete(params.requestId);

        // 只有当前实例在请求完成时立即计算统计
        // 这样可以避免多实例同时计算的问题
        await this.refreshCurrentStats();

        // 通知本实例的监听者
        this.notifyUpdate();

        StatusLogger.info(
            `[TokenFileLogger] 更新实际token: ${params.requestId}, status=${params.status}, rawUsage=${params.rawUsage ? '已记录' : '未记录'}`
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
     * 获取指定日期的统计(直接计算，忽略缓存)
     * 适用于详情界面,确保显示最新的准确数据
     */
    async getDateStatsFromFile(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.logStatsManager.getDateStats(dateStr, true);
    }

    /**
     * 获取指定日期的所有小时统计
     */
    async getAllHourStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        // 尝试从持久化的统计文件读取完整的日期统计（包含所有小时）
        const saved = await this.logStatsManager.getDateStats(dateStr);
        if (saved && saved.hourly && Object.keys(saved.hourly).length > 0) {
            StatusLogger.debug(
                `[TokenFileLogger] 从缓存读取所有小时统计: ${dateStr}, 小时数=${Object.keys(saved.hourly).length}`
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
     * 用于详情页面展示
     */
    async getRequestDetails(dateStr: string): Promise<TokenRequestLog[]> {
        return this.readManager.getRequestDetails(dateStr);
    }

    /**
     * 获取最近的请求详情（性能优化版本）
     * 仅读取最近 N 条请求，避免在有大量日志时加载整个日期的数据
     * 用于状态栏等需要快速响应的场景
     */
    async getRecentRequestDetails(dateStr: string, limit: number = 100): Promise<TokenRequestLog[]> {
        return this.readManager.getRecentRequestDetails(dateStr, limit);
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
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
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
                StatusLogger.debug('[TokenFileLogger] pendingLogs 清理任务已停止');
            }

            // 检查是否有待处理的日志
            const pendingLogCount = this.pendingLogs.size;
            if (pendingLogCount > 0) {
                StatusLogger.warn(
                    `[TokenFileLogger] 销毁时发现 ${pendingLogCount} 个待处理的日志记录，这些记录可能包含未完成的请求`
                );
                // 清理待处理日志
                this.pendingLogs.clear();
            }

            // 清理事件监听器
            this.eventEmitter.removeAllListeners();
            StatusLogger.debug('[TokenFileLogger] 事件监听器已清理');

            // 等待写入队列完成并销毁
            await this.writeManager.dispose();
            StatusLogger.debug('[TokenFileLogger] 写入管理器已销毁');

            StatusLogger.info('[TokenFileLogger] 文件日志系统已销毁');
        } catch (error) {
            StatusLogger.error('[TokenFileLogger] 销毁日志系统时出错:', error);
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

    // ==================== Private Helper Methods ====================

    /**
     * 刷新当前日期的统计（请求结束后立即调用）
     * 确保统计是最新的，缓存由上层调用者(usagesStatusBar)维护
     */
    private async refreshCurrentStats(): Promise<void> {
        const dateStr = DateUtils.getTodayDateString();

        try {
            // 等待写入队列完成
            await this.writeManager.flush();

            // 计算并保存统计（getDateStats 会自动处理增量更新和保存）
            await this.logStatsManager.getDateStats(dateStr, true);

            // 通知本实例的监听者
            this.notifyUpdate();

            StatusLogger.debug(`[TokenFileLogger] 已刷新小时统计: ${dateStr}`);
        } catch (err) {
            StatusLogger.warn('[TokenFileLogger] 刷新统计失败:', err);
        }
    }
}

// 导出类型
export type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

// 导出统计计算器
export { StatsCalculator } from './statsCalculator';
