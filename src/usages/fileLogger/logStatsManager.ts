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
import { DateUtils } from './dateUtils';
import { StatsCalculator } from './statsCalculator';
import type {
    TokenUsageStatsFromFile,
    DateIndexEntry,
    HourlyStats,
    FileLoggerProviderStats,
    TokenStats
} from './types';

/**
 * 日志统计管理器
 * 统一管理统计数据的查询、计算和持久化
 * 注: 缓存由上层调用者(usagesStatusBar等)维护
 */
export class LogStatsManager {
    private readonly baseDir: string;
    private readonly indexManager: LogIndexManager;

    constructor(
        private readManager: LogReadManager,
        baseDir: string,
        indexManager: LogIndexManager
    ) {
        this.baseDir = path.join(baseDir, 'usages');
        this.indexManager = indexManager;
    }

    // ==================== 统计查询方法 ====================

    /**
     * 计算指定日期的统计（包含小时统计和日期统计）
     * 支持增量更新：根据小时文件的修改时间戳判断是否需要重新计算
     * 自动遍历所有小时文件，只重新计算已改变的小时
     * 日期统计（total 和 providers）从小时缓存结果聚合计算
     * 返回: 包含日期统计、所有小时统计（含 modifiedTime 和 providers）的完整对象
     */
    async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 读取现有的统计数据
        const existingStats = await this.loadStats(dateStr);
        const existingHourly = existingStats?.hourly || {};

        // 获取日期文件夹中所有存在的小时文件
        const dateFolder = path.join(this.baseDir, dateStr);
        let hourFiles: number[] = [];
        try {
            const files = await fs.readdir(dateFolder);
            hourFiles = files
                .filter(f => f.endsWith('.jsonl'))
                .map(f => parseInt(f.slice(0, 2), 10))
                .filter(h => !isNaN(h) && h >= 0 && h <= 23)
                .sort((a, b) => a - b);
        } catch {
            // 日期文件夹不存在或无法读取
            StatusLogger.debug(`[LogStatsManager] 日期文件夹不存在或无法读取: ${dateStr}`);
        }

        // 初始化小时统计结果
        const hourly: Record<string, HourlyStats> = { ...existingHourly };
        // 遍历所有小时文件，进行增量更新
        for (const hour of hourFiles) {
            const hourKey = String(hour).padStart(2, '0');
            const hourFileModified = await this.readManager.getHourFileModifiedTime(dateStr, hour);
            const existingModified = existingHourly[hourKey]?.modifiedTime;
            // 检查时间戳：如果一致，说明文件未改变，可以跳过此小时的计算
            if (existingModified !== undefined && existingModified === hourFileModified) {
                // 时间戳一致，保留现有统计
                StatusLogger.debug(`[LogStatsManager] 小时文件未改变，跳过计算: ${dateStr} ${hourKey}:00`);
                continue;
            }

            // 时间戳不一致或不存在，需要读取并计算
            StatusLogger.debug(`[LogStatsManager] 小时文件已改变，重新计算: ${dateStr} ${hourKey}:00`);
            const logs = await this.readManager.readHourLogs(dateStr, hour);
            const hourStats = StatsCalculator.aggregateLogs(logs);
            // 更新该小时的统计（包含 modifiedTime 和 providers）
            hourly[hourKey] = {
                ...hourStats.total,
                modifiedTime: hourFileModified,
                providers: hourStats.providers
            };
        }

        // 从小时统计聚合计算日期统计（避免重复读取日志）
        // 初始化总计
        const total: TokenStats = {
            estimatedInput: 0,
            actualInput: 0,
            cacheTokens: 0,
            outputTokens: 0,
            requests: 0,
            completedRequests: 0,
            failedRequests: 0
        };

        // 初始化提供商统计
        const providers: Record<string, FileLoggerProviderStats> = {};
        // 遍历所有小时统计，聚合计算
        for (const hourStats of Object.values(hourly)) {
            // 累加总计
            total.estimatedInput += hourStats.estimatedInput;
            total.actualInput += hourStats.actualInput;
            total.cacheTokens += hourStats.cacheTokens;
            total.outputTokens += hourStats.outputTokens;
            total.requests += hourStats.requests;
            total.completedRequests += hourStats.completedRequests;
            total.failedRequests += hourStats.failedRequests;

            // 聚合提供商统计
            if (hourStats.providers) {
                for (const [providerKey, providerStats] of Object.entries(hourStats.providers)) {
                    if (!providers[providerKey]) {
                        providers[providerKey] = {
                            providerName: providerStats.providerName,
                            estimatedInput: 0,
                            actualInput: 0,
                            cacheTokens: 0,
                            outputTokens: 0,
                            requests: 0,
                            completedRequests: 0,
                            failedRequests: 0,
                            models: {}
                        };
                    }

                    const provider = providers[providerKey];
                    // 累加提供商统计
                    provider.estimatedInput += providerStats.estimatedInput;
                    provider.actualInput += providerStats.actualInput;
                    provider.cacheTokens += providerStats.cacheTokens;
                    provider.outputTokens += providerStats.outputTokens;
                    provider.requests += providerStats.requests;
                    provider.completedRequests += providerStats.completedRequests;
                    provider.failedRequests += providerStats.failedRequests;

                    // 聚合模型统计
                    if (providerStats.models) {
                        for (const [modelKey, modelStats] of Object.entries(providerStats.models)) {
                            if (!provider.models[modelKey]) {
                                provider.models[modelKey] = {
                                    modelName: modelStats.modelName,
                                    estimatedInput: 0,
                                    actualInput: 0,
                                    cacheTokens: 0,
                                    outputTokens: 0,
                                    requests: 0
                                };
                            }

                            const model = provider.models[modelKey];
                            // 累加模型统计
                            model.estimatedInput += modelStats.estimatedInput;
                            model.actualInput += modelStats.actualInput;
                            model.cacheTokens += modelStats.cacheTokens;
                            model.outputTokens += modelStats.outputTokens;
                            model.requests += modelStats.requests;
                        }
                    }
                }
            }
        }

        // 返回完整的 TokenUsageStatsFromFile 结构
        return { total, providers, hourly };
    }

    /**
     * 获取日期统计
     * 优先尝试从持久化文件读取，否则进行增量差分计算并保存
     */
    async getDateStats(dateStr: string, fromFile: boolean = false): Promise<TokenUsageStatsFromFile> {
        // 优先尝试从持久化文件读取（如果不是直接计算模式）
        if (!fromFile) {
            const saved = await this.loadStats(dateStr);
            if (saved) {
                StatusLogger.debug(`[LogStatsManager] 从缓存读取统计: ${dateStr}`);
                return saved;
            }
        }

        // 进行增量差分计算（仅重算改变的小时，从小时缓存聚合日期统计）
        StatusLogger.debug(`[LogStatsManager] 增量计算统计: ${dateStr}`);
        const stats = await this.calculateDateStats(dateStr);

        // 保存到持久化文件
        await this.saveDateStats(dateStr, stats);

        return stats;
    }

    /**
     * 刷新日期统计（重新计算并更新）
     */
    async refreshDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 强制重新计算（删除现有缓存，重新计算所有小时）
        StatusLogger.debug(`[LogStatsManager] 刷新统计: ${dateStr}`);
        const stats = await this.calculateDateStats(dateStr);

        // 保存到文件
        await this.saveDateStats(dateStr, stats);

        return stats;
    }

    // ==================== 统计持久化方法 ====================

    /**
     * 保存每日统计结果
     * 保存到: <baseDir>/usages/YYYY-MM-DD/stats.json
     * 保存完整的日期统计和小时统计（包含 providers）
     */
    async saveDateStats(dateStr: string, stats: TokenUsageStatsFromFile): Promise<void> {
        const filePath = this.getStatsFilePath(dateStr);

        try {
            // 确保日期目录存在
            const dateFolder = path.join(this.baseDir, dateStr);
            await this.ensureDirectoryExists(dateFolder);

            // 写入完整的统计数据
            await fs.writeFile(filePath, JSON.stringify(stats, null, 2), 'utf-8');

            // 更新索引文件
            await this.indexManager.updateIndex(dateStr, stats.total);

            StatusLogger.debug(`[LogStatsManager] 已保存日期统计到 stats.json: ${dateStr}`);
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] 保存日期统计失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 读取统计结果
     */
    async loadStats(dateStr: string, hour?: number): Promise<TokenUsageStatsFromFile | null> {
        const filePath = this.getStatsFilePath(dateStr);

        if (!fsSync.existsSync(filePath)) {
            return null;
        }

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const statsData: TokenUsageStatsFromFile = JSON.parse(content);

            // 如果指定了小时，返回该小时的统计
            if (hour !== undefined) {
                if (!statsData.hourly) {
                    return null;
                }

                const hourKey = String(hour).padStart(2, '0');
                const hourStats = statsData.hourly[hourKey];

                if (!hourStats) {
                    return null;
                }

                // 返回小时统计（包含 modifiedTime 和 providers）
                const result: TokenUsageStatsFromFile = {
                    total: hourStats,
                    providers: hourStats.providers || {},
                    hourly: {
                        [hourKey]: hourStats
                    }
                };

                StatusLogger.debug(`[LogStatsManager] 已从 stats.json 读取小时统计: ${dateStr} ${hourKey}:00`);
                return result;
            }

            // 返回完整的日期统计
            StatusLogger.debug(`[LogStatsManager] 已从 stats.json 读取日期统计: ${dateStr}`);
            return statsData;
        } catch (err) {
            StatusLogger.warn(
                `[LogStatsManager] 读取统计失败: ${dateStr}${hour !== undefined ? ` ${hour}:00` : ''}`,
                err
            );
            return null;
        }
    }

    /**
     * 检查每日统计是否存在
     */
    async hasDailyStats(dateStr: string): Promise<boolean> {
        const filePath = this.getStatsFilePath(dateStr);
        return fsSync.existsSync(filePath);
    }

    /**
     * 获取所有日期的摘要信息（从索引文件读取）
     */
    async getAllDateSummaries(): Promise<Record<string, DateIndexEntry>> {
        // 获取所有实际的日期文件夹
        const actualDates = await this.indexManager.getAllStatsDates();
        const actualDateSet = new Set(actualDates);

        // 读取现有索引
        const index = await this.indexManager.readIndex();
        const summaries: Record<string, DateIndexEntry> = {};
        let hasChanges = false;

        if (index) {
            // 验证索引中的日期是否仍然存在，移除不存在的日期
            for (const [dateStr, entry] of Object.entries(index.dates)) {
                const dateFolder = path.join(this.baseDir, dateStr);
                if (fsSync.existsSync(dateFolder)) {
                    summaries[dateStr] = entry;
                    actualDateSet.delete(dateStr); // 从待添加集合中移除已存在的
                } else {
                    hasChanges = true;
                    StatusLogger.debug(`[LogStatsManager] 索引中的日期文件夹不存在，已移除: ${dateStr}`);
                }
            }
        }

        // 将新出现的日期文件夹添加到索引中
        for (const dateStr of actualDates) {
            if (actualDateSet.has(dateStr)) {
                try {
                    const stats = await this.loadStats(dateStr);
                    if (stats) {
                        summaries[dateStr] = {
                            total_input: stats.total.actualInput,
                            total_cache: stats.total.cacheTokens,
                            total_output: stats.total.outputTokens,
                            total_requests: stats.total.requests
                        };
                        hasChanges = true;
                        StatusLogger.debug(`[LogStatsManager] 新日期文件夹已添加到索引: ${dateStr}`);
                    }
                } catch (err) {
                    StatusLogger.warn(`[LogStatsManager] 获取日期摘要失败: ${dateStr}`, err);
                }
            }
        }

        // 如果有变化（新增或删除），更新索引文件
        if (hasChanges) {
            await this.indexManager.saveIndex({ dates: summaries });
        }

        return summaries;
    }

    /**
     * 删除指定日期的统计
     */
    async deleteDailyStats(dateStr: string): Promise<void> {
        const filePath = this.getStatsFilePath(dateStr);

        if (!fsSync.existsSync(filePath)) {
            return;
        }

        try {
            await fs.unlink(filePath);
            // 从索引中删除
            await this.indexManager.removeDate(dateStr);
            StatusLogger.info(`[LogStatsManager] 已删除每日统计: ${dateStr}`);
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] 删除每日统计失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 清理过期统计
     */
    async cleanupExpiredStats(retentionDays: number): Promise<number> {
        if (retentionDays === 0) {
            return 0; // 永久保留
        }

        const allDates = await this.indexManager.getAllStatsDates();
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        const cutoffDateStr = DateUtils.formatDate(cutoffDate);

        let deletedCount = 0;

        for (const dateStr of allDates) {
            if (dateStr < cutoffDateStr) {
                await this.deleteDailyStats(dateStr);
                deletedCount++;
            }
        }

        // 清理过期数据后，更新索引文件
        if (deletedCount > 0) {
            await this.indexManager.rebuildIndex(dateStr => this.loadStats(dateStr));
        }

        return deletedCount;
    }

    /**
     * 检查指定日期的 stats.json 是否需要更新
     */
    async needsRegeneration(dateStr: string): Promise<boolean> {
        const statsFilePath = this.getStatsFilePath(dateStr);

        // 如果 stats.json 不存在，需要生成
        if (!fsSync.existsSync(statsFilePath)) {
            return true;
        }

        try {
            // 获取 stats.json 的修改时间
            const statsStats = fsSync.statSync(statsFilePath);
            const statsMtime = statsStats.mtimeMs;

            // 获取日期文件夹路径
            const dateFolder = path.join(this.baseDir, dateStr);

            // 检查日期文件夹是否存在
            if (!fsSync.existsSync(dateFolder)) {
                return false;
            }

            // 读取日期文件夹中的所有文件
            const files = await fs.readdir(dateFolder);
            const logFiles = files.filter(f => f.endsWith('.jsonl'));

            // 检查是否有任何日志文件的修改时间晚于 stats.json
            for (const logFile of logFiles) {
                const logFilePath = path.join(dateFolder, logFile);
                const logStats = fsSync.statSync(logFilePath);
                if (logStats.mtimeMs > statsMtime) {
                    StatusLogger.debug(
                        `[LogStatsManager] 日期 ${dateStr} 的 stats.json 过期 (日志文件 ${logFile} 更新时间: ${new Date(logStats.mtimeMs).toISOString()})`
                    );
                    return true;
                }
            }

            return false;
        } catch (err) {
            StatusLogger.warn(`[LogStatsManager] 检查日期 ${dateStr} 是否需要更新失败:`, err);
            return false;
        }
    }

    /**
     * 获取所有需要重新生成的日期列表
     */
    async getOutdatedDates(): Promise<string[]> {
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
            StatusLogger.error('[LogStatsManager] 获取过期日期列表失败', err);
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
     * 确保目录存在(递归创建)
     */
    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        try {
            // 同步检查避免竞态条件
            if (!fsSync.existsSync(dirPath)) {
                await fs.mkdir(dirPath, { recursive: true });
                StatusLogger.debug(`[LogStatsManager] 创建目录: ${dirPath}`);
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
