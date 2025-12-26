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
import type { TokenUsageStatsFromFile, DateIndexEntry, HourlyStats } from './types';

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
     * 统计指定日期的数据
     */
    async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        const logs = await this.readManager.readDateLogs(dateStr);
        return StatsCalculator.aggregateLogs(logs);
    }

    /**
     * 计算指定日期的统计（包含小时统计和日期统计）
     * 支持增量更新：根据小时文件的修改时间戳判断是否需要重新计算
     * 自动遍历所有小时文件，只重新计算已改变的小时
     * 返回: 包含日期统计、所有小时统计和hourlyModified时间戳的完整对象
     */
    async calculateStats(dateStr: string, existingStats?: TokenUsageStatsFromFile): Promise<TokenUsageStatsFromFile> {
        // 获取现有的统计数据和时间戳
        const existingHourlyModified = existingStats?.hourlyModified;
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

        // 初始化结果
        const hourly: Record<string, HourlyStats> = { ...existingHourly };
        const updatedHourlyModified: Record<string, number> = { ...existingHourlyModified };

        // 遍历所有小时文件，进行增量更新
        for (const hour of hourFiles) {
            const hourKey = String(hour).padStart(2, '0');
            const hourFileModified = await this.readManager.getHourFileModifiedTime(dateStr, hour);
            const existingModified = existingHourlyModified?.[hourKey];

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

            // 更新该小时的统计
            hourly[hourKey] = {
                ...hourStats.total,
                modifiedTime: hourFileModified
            };

            // 更新时间戳
            updatedHourlyModified[hourKey] = hourFileModified;
        }

        // 一次性读取整个日期的所有日志
        const allDateLogs = await this.readManager.readDateLogs(dateStr);

        // 计算日期统计
        const dateStats = StatsCalculator.aggregateLogs(allDateLogs);

        // 返回完整的 TokenUsageStatsFromFile 结构
        return {
            total: dateStats.total,
            providers: dateStats.providers,
            hourly,
            hourlyModified: updatedHourlyModified
        };
    }

    /**
     * 获取日期统计
     * 优先尝试从持久化文件读取，否则从日志文件计算
     */
    async getDateStats(dateStr: string, fromFile: boolean = false): Promise<TokenUsageStatsFromFile> {
        const today = DateUtils.getTodayDateString();
        const isTodayOrHistory = dateStr === today;

        // 优先尝试从持久化文件读取（如果不是直接计算模式）
        if (!fromFile) {
            const saved = await this.loadStats(dateStr);
            if (saved) {
                StatusLogger.debug(`[LogStatsManager] 从缓存读取统计: ${dateStr}`);
                return saved;
            }
        }

        // 从日志文件计算统计
        StatusLogger.debug(`[LogStatsManager] 计算${isTodayOrHistory ? '今日' : '历史'}统计: ${dateStr}`);
        const stats = await this.calculateDateStats(dateStr);

        // 保存到持久化文件
        if (!isTodayOrHistory) {
            // 始终保存历史统计到文件
            await this.saveDateStats(dateStr, stats);
        }

        return stats;
    }

    /**
     * 刷新日期统计（重新计算并更新）
     */
    async refreshDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 重新计算
        const stats = await this.calculateDateStats(dateStr);

        // 保存到文件
        await this.saveDateStats(dateStr, stats);

        return stats;
    }

    // ==================== 统计持久化方法 ====================

    /**
     * 保存每日统计结果
     * 保存到: <baseDir>/usages/YYYY-MM-DD/stats.json
     * 仅更新日期统计，不修改小时统计
     */
    async saveDateStats(dateStr: string, stats: TokenUsageStatsFromFile): Promise<void> {
        const filePath = this.getStatsFilePath(dateStr);

        try {
            // 确保日期目录存在
            const dateFolder = path.join(this.baseDir, dateStr);
            await this.ensureDirectoryExists(dateFolder);

            // 读取现有的统计数据
            let statsData: TokenUsageStatsFromFile = {
                total: {
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    completedRequests: 0,
                    failedRequests: 0
                },
                providers: {},
                hourly: {}
            };

            if (fsSync.existsSync(filePath)) {
                const content = await fs.readFile(filePath, 'utf-8');
                try {
                    const existing = JSON.parse(content) as TokenUsageStatsFromFile;
                    statsData = {
                        total: existing.total || statsData.total,
                        providers: existing.providers || statsData.providers,
                        hourly: existing.hourly || statsData.hourly
                    };
                } catch {
                    // 如果解析失败,使用空对象
                }
            }

            // 更新每日统计
            statsData.total = stats.total;
            statsData.providers = stats.providers;

            // 写入文件
            await fs.writeFile(filePath, JSON.stringify(statsData, null, 2), 'utf-8');

            // 更新索引文件
            await this.indexManager.updateIndex(dateStr, stats.total);

            StatusLogger.debug(`[LogStatsManager] 已保存日期统计到 stats.json: ${dateStr}`);
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] 保存日期统计失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 一次性保存小时和日期统计结果
     * 优化：避免重复读取和写入文件
     */
    async saveHourAndDateStats(
        dateStr: string,
        hour: number,
        hourStats: TokenUsageStatsFromFile,
        dateStats: TokenUsageStatsFromFile
    ): Promise<void> {
        const filePath = this.getStatsFilePath(dateStr);

        try {
            // 确保日期目录存在
            const dateFolder = path.join(this.baseDir, dateStr);
            await this.ensureDirectoryExists(dateFolder);

            // 读取现有的统计数据
            let statsData: TokenUsageStatsFromFile = {
                total: {
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    completedRequests: 0,
                    failedRequests: 0
                },
                providers: {},
                hourly: {},
                hourlyModified: {}
            };

            if (fsSync.existsSync(filePath)) {
                const content = await fs.readFile(filePath, 'utf-8');
                try {
                    const existing = JSON.parse(content) as TokenUsageStatsFromFile;
                    statsData = {
                        total: existing.total || statsData.total,
                        providers: existing.providers || statsData.providers,
                        hourly: existing.hourly || statsData.hourly,
                        hourlyModified: existing.hourlyModified || statsData.hourlyModified
                    };
                } catch {
                    // 如果解析失败,使用空对象
                }
            }

            // 更新指定小时的统计数据 - 保存包含 modifiedTime 的完整结构
            const hourKey = String(hour).padStart(2, '0');
            if (!statsData.hourly) {
                statsData.hourly = {};
            }
            // 从 hourStats 中获取该小时的统计（包含 modifiedTime）
            const hourData = hourStats.hourly?.[hourKey];
            if (hourData) {
                statsData.hourly[hourKey] = hourData;
            }

            // 更新 daily 统计（保存完整的提供商和模型统计）
            statsData.total = dateStats.total;
            statsData.providers = dateStats.providers;

            // 更新 hourlyModified 时间戳
            if (dateStats.hourlyModified) {
                if (!statsData.hourlyModified) {
                    statsData.hourlyModified = {};
                }
                statsData.hourlyModified = dateStats.hourlyModified;
            }

            // 写入文件
            await fs.writeFile(filePath, JSON.stringify(statsData, null, 2), 'utf-8');

            // 更新索引文件
            await this.indexManager.updateIndex(dateStr, dateStats.total);

            StatusLogger.debug(`[LogStatsManager] 已保存小时和日期统计到 stats.json: ${dateStr} ${hourKey}:00`);
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] 保存小时和日期统计失败: ${dateStr} ${hour}:00`, err);
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

                // 返回小时统计（包含 modifiedTime）
                const result: TokenUsageStatsFromFile = {
                    total: hourStats,
                    providers: {}, // 小时级别没有提供商统计
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
