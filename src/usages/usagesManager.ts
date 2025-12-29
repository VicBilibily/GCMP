/*---------------------------------------------------------------------------------------------
 *  Token Usages Manager
 *  Token 用量管理器 - 基于 fileLogger,无存储限制
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';
import { TokenFileLogger, TokenUsageStatsFromFile } from './fileLogger';
import { UsageParser, ExtendedTokenRequestLog } from './fileLogger/usageParser';
import { DateUtils } from './fileLogger/dateUtils';
import { EventEmitter } from 'events';
import type { DateSummary } from './types';
import type { GenericUsageData, RawUsageData, DateIndexEntry } from './fileLogger/types';

/**
 * Token 用量管理器
 * 全局静态对象，管理 Token 消耗统计
 */
export class TokenUsagesManager {
    private fileLogger!: TokenFileLogger;
    private eventEmitter: EventEmitter;
    private initialized: boolean = false;

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
            StatusLogger.trace('[UsagesManager] Token用量管理器已初始化，跳过重复初始化');
            return;
        }

        const startTime = Date.now();

        // 初始化文件日志系统
        this.fileLogger = new TokenFileLogger(context);
        await this.fileLogger.initialize();

        this.initialized = true;

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(`[UsagesManager] Token用量管理器初始化完成 (耗时: ${elapsed}ms)`);

        // 异步后台清理过期数据（不阻塞初始化）
        this.scheduleBackgroundCleanup();
    }

    /**
     * 调度后台清理任务
     */
    private scheduleBackgroundCleanup(): void {
        // 使用 setImmediate 确保在下一个事件循环中执行，不阻塞当前流程
        setImmediate(async () => {
            try {
                const config = vscode.workspace.getConfiguration('gcmp.usages');
                const retentionDays = config.get<number>('retentionDays', 100);
                if (retentionDays > 0) {
                    StatusLogger.trace(`[UsagesManager] 开始后台清理过期数据 (保留 ${retentionDays} 天)`);
                    const deletedCount = await this.fileLogger.cleanupExpiredLogs(retentionDays);
                    if (deletedCount > 0) {
                        StatusLogger.debug(`[UsagesManager] 后台清理完成: 删除了 ${deletedCount} 个过期日期的数据`);
                    } else {
                        StatusLogger.trace('[UsagesManager] 后台清理完成: 无需清理的数据');
                    }
                } else {
                    StatusLogger.trace('[UsagesManager] 数据保留设置为永久保留，跳过清理');
                }
            } catch (error) {
                StatusLogger.warn(`[UsagesManager] 后台清理过期数据失败: ${error}`);
            }
        });
    }

    /**
     * 获取存储目录路径
     */
    getStorageDir(): string {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager 尚未初始化，请先调用 initialize() 方法');
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
        maxInputTokens?: number;
        requestType?: 'chat' | 'completion' | 'fim' | 'nes';
        timestamp?: number; // 可选: 自定义时间戳(用于测试数据生成)
    }): Promise<string> {
        if (!this.initialized) {
            throw new Error('TokenUsagesManager 尚未初始化，请先调用 initialize() 方法');
        }

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
                    maxInputTokens: params.maxInputTokens,
                    requestType: params.requestType,
                    timestamp: params.timestamp
                })
                .finally(() => {
                    // 通知更新
                    this.notifyUpdate();
                });

            StatusLogger.debug(
                `[Usages] 记录预估 token: ${params.providerKey}/${params.modelName}, ${params.estimatedInputTokens} tokens, requestId=${requestId}`
            );

            return requestId;
        } catch (err) {
            StatusLogger.warn('[Usages] 记录预估 token 失败:', err);
            throw err;
        }
    }

    /**
     * 更新实际 token 使用情况（请求完成后调用）
     */
    async updateActualTokens(params: {
        requestId: string;
        rawUsage?: RawUsageData;
        status: 'completed' | 'failed';
    }): Promise<void> {
        if (!this.initialized) {
            StatusLogger.warn('TokenUsagesManager 尚未初始化，跳过 token 统计更新');
            return;
        }

        try {
            // 将 rawUsage 中的 null 值转换为 undefined（适配 fileLogger 的期望类型）
            let normalizedUsage: GenericUsageData | undefined;
            if (params.rawUsage) {
                normalizedUsage = this.normalizeUsageData(params.rawUsage);
            }

            // 更新文件日志系统（不等待结果）
            this.fileLogger
                .updateActualTokens({
                    requestId: params.requestId,
                    rawUsage: normalizedUsage,
                    status: params.status
                })
                .finally(() => {
                    // 通知更新
                    this.notifyUpdate();
                });

            StatusLogger.debug(
                `[Usages] 更新实际 token: requestId=${params.requestId}, ` +
                    `rawUsage=${params.rawUsage ? '已记录' : '未记录'}, ` +
                    `status=${params.status}`
            );
        } catch (err) {
            StatusLogger.warn('[Usages] 更新实际 token 失败:', err);
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
                total_requests: entry.total_requests
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

        // 扩展记录，添加便捷访问方法
        const extended = UsageParser.extendLogs(allLogs);
        // 返回最近的 N 条记录
        return extended.slice(0, limit);
    }

    /**
     * 获取指定日期的请求记录
     */
    async getDateRecords(date: string): Promise<ExtendedTokenRequestLog[]> {
        const details = await this.fileLogger.getRequestDetails(date);
        return UsageParser.extendLogs(details);
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
    }

    /**
     * 获取文件日志系统实例
     */
    getFileLogger(): TokenFileLogger {
        return this.fileLogger;
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
