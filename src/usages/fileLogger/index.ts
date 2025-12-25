/*---------------------------------------------------------------------------------------------
 *  Token文件日志系统 - 主管理器
 *  整合路径管理、写入管理、读取管理、统计管理
 *  支持文件监听，实时更新今日统计
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../../utils/logger';
import { LogPathManager } from './pathManager';
import { LogWriteManager } from './writeManager';
import { LogReadManager } from './readManager';
import { DailyStatsManager } from './dailyStatsManager';
import { StatsQueryService } from './statsService';
import { EventEmitter } from 'events';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * Token文件日志管理器
 * 主入口,提供完整的日志记录和统计功能
 * 支持文件变更监听，实时更新统计
 */
export class TokenFileLogger {
    private readonly pathManager: LogPathManager;
    private readonly writeManager: LogWriteManager;
    private readonly readManager: LogReadManager;
    private readonly dailyStatsManager: DailyStatsManager;
    private readonly statsService: StatsQueryService;
    private readonly eventEmitter: EventEmitter;

    // 内存中的待更新日志(requestId -> log)
    private pendingLogs = new Map<string, TokenRequestLog>();

    // 文件监听
    private fileWatcher: vscode.FileSystemWatcher | null = null;
    private lastUpdateTime: number = 0;
    private updateThrottleMs: number = 500; // 500ms 内去重

    constructor(private context: vscode.ExtensionContext) {
        // 使用 globalStorageUri 而非 logUri,确保日志不会被清理
        const storageDir = context.globalStorageUri.fsPath;

        this.pathManager = new LogPathManager(storageDir);
        this.writeManager = new LogWriteManager(this.pathManager);
        this.readManager = new LogReadManager(this.pathManager);
        this.dailyStatsManager = new DailyStatsManager(storageDir);
        this.statsService = new StatsQueryService(this.readManager, this.dailyStatsManager, () =>
            this.pathManager.getTodayDateString()
        );
        this.eventEmitter = new EventEmitter();
    }

    /**
     * 初始化日志系统
     */
    async initialize(): Promise<void> {
        const startTime = Date.now();
        Logger.info('[TokenFileLogger] 文件日志系统初始化');

        const baseDir = this.pathManager.getBaseDir();
        Logger.info(`[TokenFileLogger] 基础目录: ${baseDir}`);

        // 启动文件监听
        this.startFileWatcher();

        const elapsed = Date.now() - startTime;
        Logger.info(`[TokenFileLogger] 文件日志系统初始化完成 (耗时: ${elapsed}ms)`);
    }

    /**
     * 启动文件监听，实时监听今日日志文件变化
     */
    private startFileWatcher(): void {
        const baseDir = this.pathManager.getBaseDir();
        const todayDateString = this.pathManager.getTodayDateString();

        // 监听今日日志文件的变化
        const pattern = new vscode.RelativePattern(baseDir, `logs/${todayDateString}/*.log`);
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        // 文件变更时的处理
        this.fileWatcher.onDidChange(async uri => {
            this.handleLogFileChange(uri);
        });

        // 文件创建时的处理
        this.fileWatcher.onDidCreate(async uri => {
            this.handleLogFileChange(uri);
        });

        Logger.debug('[TokenFileLogger] 文件监听已启动，监听今日日志文件变化');
    }

    /**
     * 处理日志文件变更
     * 使用节流防止频繁更新
     */
    private async handleLogFileChange(uri: vscode.Uri): Promise<void> {
        const now = Date.now();

        // 节流：500ms 内只处理一次
        if (now - this.lastUpdateTime < this.updateThrottleMs) {
            return;
        }

        this.lastUpdateTime = now;

        try {
            const todayDateString = this.pathManager.getTodayDateString();
            Logger.trace(`[TokenFileLogger] 检测到日志文件变更: ${uri.fsPath}`);

            // 刷新今日的统计
            await this.statsService.refreshDateStats(todayDateString);

            // 同时刷新当前小时的统计
            const hour = new Date().getHours();
            await this.statsService.refreshHourStats(todayDateString, hour);

            // 通知统计更新
            this.notifyUpdate();

            Logger.debug('[TokenFileLogger] 统计已实时更新');
        } catch (err) {
            Logger.warn('[TokenFileLogger] 处理日志文件变更失败:', err);
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

        Logger.info(
            `[TokenFileLogger] 记录预估token: ${params.requestId}, model=${params.modelName}, tokens=${params.estimatedInput}`
        );
    }

    /**
     * 更新实际token(请求完成后调用)
     * 请求结束后立即统计当前小时
     */
    async updateActualTokens(params: {
        requestId: string;
        rawUsage?: TokenRequestLog['rawUsage'];
        status: 'completed' | 'failed';
    }): Promise<void> {
        const pendingLog = this.pendingLogs.get(params.requestId);

        if (!pendingLog) {
            Logger.warn(`[TokenFileLogger] 未找到待更新的日志: ${params.requestId}`);
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

        // 立即统计当前小时
        await this.refreshCurrentHourStats();

        Logger.info(
            `[TokenFileLogger] 更新实际token: ${params.requestId}, status=${params.status}, rawUsage=${params.rawUsage ? '已记录' : '未记录'}`
        );
    }

    /**
     * 更新请求的时间戳(用于测试数据生成)
     * 警告: 此方法仅用于测试/开发,会修改已写入日志的时间戳
     */
    async updateRequestTimestamp(requestId: string, newTimestamp: number): Promise<void> {
        const pendingLog = this.pendingLogs.get(requestId);

        if (!pendingLog) {
            Logger.warn(`[TokenFileLogger] 未找到待更新的日志: ${requestId}`);
            return;
        }

        // 更新时间戳
        pendingLog.timestamp = newTimestamp;
        pendingLog.isoTime = new Date(newTimestamp).toISOString();

        // 重新写入文件(覆盖之前的记录)
        await this.writeManager.appendLog(pendingLog);

        // 从内存移除
        this.pendingLogs.delete(requestId);

        Logger.info(`[TokenFileLogger] 更新请求时间戳: ${requestId}, newTimestamp=${newTimestamp}`);
    }

    // ==================== 读取和统计操作 ====================

    /**
     * 获取今日统计(带缓存)
     */
    async getTodayStats(): Promise<TokenUsageStatsFromFile> {
        const dateStr = this.pathManager.getTodayDateString();
        return this.getDateStats(dateStr);
    }

    /**
     * 获取指定日期的统计
     * 优先尝试从持久化文件读取，否则从日志文件计算
     * 适用于状态栏等需要快速响应的场景
     */
    async getDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.statsService.getDateStats(dateStr);
    }

    /**
     * 获取指定日期的统计(直接计算)
     * 适用于详情界面,确保显示最新的准确数据
     * 不使用缓存，直接从日志文件计算
     */
    async getDateStatsFromFile(dateStr: string): Promise<TokenUsageStatsFromFile> {
        return this.statsService.getDateStats(dateStr, true);
    }

    /**
     * 获取指定日期的所有小时统计
     * 适用于界面显示小时用量列表
     */
    async getAllHourStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        // 尝试从持久化的统计文件读取完整的日期统计（包含所有小时）
        const saved = await this.dailyStatsManager.loadStats(dateStr);
        if (saved && saved.hourly && Object.keys(saved.hourly).length > 0) {
            Logger.info(
                `[TokenFileLogger] 从持久化文件读取所有小时统计: ${dateStr}, 小时数=${Object.keys(saved.hourly).length}`
            );
            return saved;
        }

        // 如果没有持久化的统计文件，返回 null，让调用方决定是否需要计算
        return null;
    }

    /**
     * 获取指定小时的统计(带缓存)
     */
    async getHourStats(dateStr: string, hour: number): Promise<TokenUsageStatsFromFile> {
        return this.statsService.getHourStats(dateStr, hour);
    }

    /**
     * 获取所有日期列表
     */
    async getAllDates(): Promise<string[]> {
        return this.readManager.getAllDates();
    }

    /**
     * 获取所有日期的摘要信息
     * 用于日期列表显示，避免加载完整的 stats.json
     */
    async getAllDateSummaries(): Promise<
        Record<string, { total_input: number; total_cache: number; total_output: number; total_requests: number }>
    > {
        return this.dailyStatsManager.getAllDateSummaries();
    }

    /**
     * 检查并重新生成过期的统计数据
     * 在打开统计页面时调用，确保所有日期的 stats.json 都是最新的
     */
    async regenerateOutdatedStats(): Promise<void> {
        const startTime = Date.now();

        try {
            // 获取所有需要重新生成的日期列表
            const outdatedDates = await this.dailyStatsManager.getOutdatedDates();

            if (outdatedDates.length === 0) {
                Logger.info('[TokenFileLogger] 所有统计数据都是最新的，无需重新生成');
                return;
            }

            Logger.info(`[TokenFileLogger] 发现 ${outdatedDates.length} 个日期的统计数据需要重新生成`);

            let regeneratedCount = 0;

            for (const dateStr of outdatedDates) {
                try {
                    // 重新计算该日期的统计数据
                    const stats = await this.readManager.calculateDateStats(dateStr);

                    // 保存统计数据
                    await this.dailyStatsManager.saveDateStats(dateStr, stats);

                    regeneratedCount++;
                    Logger.debug(`[TokenFileLogger] 已重新生成日期 ${dateStr} 的统计数据`);
                } catch (err) {
                    Logger.warn(`[TokenFileLogger] 重新生成日期 ${dateStr} 的统计数据失败:`, err);
                    // 继续处理下一个日期
                }
            }

            const elapsed = Date.now() - startTime;
            Logger.info(
                `[TokenFileLogger] 统计数据重新生成完成: ${regeneratedCount}/${outdatedDates.length} 个成功 (耗时: ${elapsed}ms)`
            );
        } catch (err) {
            Logger.error('[TokenFileLogger] 检查并重新生成过期统计数据失败:', err);
        }
    }

    /**
     * 计算并保存指定日期的统计
     * 用于主动归档历史统计
     */
    async calculateAndSaveDailyStats(dateStr: string): Promise<void> {
        const stats = await this.readManager.calculateDateStats(dateStr);
        await this.dailyStatsManager.saveDateStats(dateStr, stats);
        Logger.info(`[TokenFileLogger] 已计算并保存每日统计: ${dateStr}`);
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

    // ==================== 清理操作 ====================

    /**
     * 删除指定日期的所有日志和统计
     */
    async deleteDateLogs(dateStr: string): Promise<void> {
        await this.readManager.deleteDateLogs(dateStr);
        await this.dailyStatsManager.deleteDailyStats(dateStr);

        Logger.info(`[TokenFileLogger] 已删除日期日志和统计: ${dateStr}`);
    }

    /**
     * 清理过期日志和统计(保留最近N天)
     */
    async cleanupExpiredLogs(retentionDays: number): Promise<number> {
        const deletedCount = await this.readManager.cleanupExpiredLogs(retentionDays);

        // 清理过期统计
        await this.dailyStatsManager.cleanupExpiredStats(retentionDays);

        return deletedCount;
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
        // 销毁文件监听
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
            this.fileWatcher = null;
            Logger.debug('[TokenFileLogger] 文件监听已停止');
        }

        // 销毁事件监听器
        this.eventEmitter.removeAllListeners();

        await this.writeManager.dispose();
        Logger.info('[TokenFileLogger] 文件日志系统已销毁');
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
     * 刷新当前小时的统计（请求结束后立即调用）
     * 确保统计是最新的，缓存由上层调用者(usagesStatusBar)维护
     */
    private async refreshCurrentHourStats(): Promise<void> {
        const now = new Date();
        const dateStr = this.pathManager.getTodayDateString();
        const hour = now.getHours();

        try {
            // 等待写入队列完成
            await this.writeManager.flush();

            // 使用 StatsQueryService 刷新统计
            await this.statsService.refreshHourStats(dateStr, hour);

            Logger.debug(`[TokenFileLogger] 已刷新小时统计: ${dateStr} ${hour}:00`);
        } catch (err) {
            Logger.warn('[TokenFileLogger] 刷新统计失败:', err);
        }
    }
}

// 导出类型
export type { TokenRequestLog, TokenUsageStatsFromFile } from './types';
