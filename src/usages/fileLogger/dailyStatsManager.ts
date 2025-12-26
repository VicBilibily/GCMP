/*---------------------------------------------------------------------------------------------
 *  统计结果管理器
 *  负责每日和每小时统计结果的存储和读取
 *  目录结构:
 *    - 统计汇总: <baseDir>/usages/YYYY-MM-DD/stats.json
 *     包含 daily (每日统计) 和 hourly (小时统计) 两部分
 *    - 日期索引: <baseDir>/usages/index.json
 *     记录所有日期的总token情况，用于快速浏览日期列表
 *  与日志文件在同一天目录下,便于管理
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { StatusLogger } from '../../utils/statusLogger';
import { DateUtils } from './dateUtils';
import type { TokenUsageStatsFromFile, DateIndex, DateIndexEntry } from './types';

/**
 * 统计结果管理器
 * 管理每日和小时的统计数据持久化
 */
export class DailyStatsManager {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = path.join(baseDir, 'usages');
    }

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
            await this.updateDateIndex(dateStr, stats.total);

            StatusLogger.debug(`[DailyStatsManager] 已保存日期统计到 stats.json: ${dateStr}`);
        } catch (err) {
            StatusLogger.error(`[DailyStatsManager] 保存日期统计失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 一次性保存小时和日期统计结果
     * 优化：避免重复读取和写入文件
     *
     * @param dateStr 日期字符串
     * @param hour 小时数
     * @param hourStats 小时统计（只包含 total，HourlyStats 直接就是 total 结构）
     * @param dateStats 日期统计（包含完整的提供商和模型统计）
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

            // 更新指定小时的统计数据 - 只保存 total，不保存 providers
            const hourKey = String(hour).padStart(2, '0');
            if (!statsData.hourly) {
                statsData.hourly = {};
            }
            statsData.hourly[hourKey] = hourStats.total; // 直接保存 total 结构

            // 更新 daily 统计（保存完整的提供商和模型统计）
            statsData.total = dateStats.total;
            statsData.providers = dateStats.providers;

            // 写入文件
            await fs.writeFile(filePath, JSON.stringify(statsData, null, 2), 'utf-8');

            // 更新索引文件
            await this.updateDateIndex(dateStr, dateStats.total);

            StatusLogger.debug(`[DailyStatsManager] 已保存小时和日期统计到 stats.json: ${dateStr} ${hourKey}:00`);
        } catch (err) {
            StatusLogger.error(`[DailyStatsManager] 保存小时和日期统计失败: ${dateStr} ${hour}:00`, err);
            throw err;
        }
    }

    /**
     * 读取统计结果
     * @param dateStr 日期字符串
     * @param hour 可选的小时数，如果提供则返回该小时的统计，否则返回完整的日期统计
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

                // 返回小时统计（只包含 total）
                const result: TokenUsageStatsFromFile = {
                    total: hourStats,
                    providers: {} // 小时级别没有提供商统计
                };

                StatusLogger.debug(`[DailyStatsManager] 已从 stats.json 读取小时统计: ${dateStr} ${hourKey}:00`);
                return result;
            }

            // 返回完整的日期统计
            StatusLogger.debug(`[DailyStatsManager] 已从 stats.json 读取日期统计: ${dateStr}`);
            return statsData;
        } catch (err) {
            StatusLogger.warn(
                `[DailyStatsManager] 读取统计失败: ${dateStr}${hour !== undefined ? ` ${hour}:00` : ''}`,
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
     * 获取所有已保存的日期列表
     */
    async getAllStatsDates(): Promise<string[]> {
        if (!fsSync.existsSync(this.baseDir)) {
            return [];
        }

        try {
            // 读取所有日期目录
            const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
            const dates: string[] = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dateStr = entry.name;
                    // 检查是否是有效的日期格式
                    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                        // 检查该日期目录下是否有统计文件
                        const statsFile = path.join(this.baseDir, dateStr, 'stats.json');
                        if (fsSync.existsSync(statsFile)) {
                            dates.push(dateStr);
                        }
                    }
                }
            }

            return dates.sort().reverse(); // 倒序(最新的在前)
        } catch (err) {
            StatusLogger.error('[DailyStatsManager] 获取统计日期列表失败', err);
            return [];
        }
    }

    /**
     * 获取所有日期的摘要信息（从索引文件读取）
     * 返回格式: { date: { total_input, total_cache, total_output, total_requests } }
     */
    async getAllDateSummaries(): Promise<Record<string, DateIndexEntry>> {
        // 获取所有实际的日期文件夹
        const actualDates = await this.getAllStatsDates();
        const actualDateSet = new Set(actualDates);

        // 读取现有索引
        const index = await this.readDateIndex();
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
                    StatusLogger.debug(`[DailyStatsManager] 索引中的日期文件夹不存在，已移除: ${dateStr}`);
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
                        StatusLogger.debug(`[DailyStatsManager] 新日期文件夹已添加到索引: ${dateStr}`);
                    }
                } catch (err) {
                    StatusLogger.warn(`[DailyStatsManager] 获取日期摘要失败: ${dateStr}`, err);
                }
            }
        }

        // 如果有变化（新增或删除），更新索引文件
        if (hasChanges) {
            await this.saveDateIndex({ dates: summaries });
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
            await this.removeDateFromIndex(dateStr);
            StatusLogger.info(`[DailyStatsManager] 已删除每日统计: ${dateStr}`);
        } catch (err) {
            StatusLogger.error(`[DailyStatsManager] 删除每日统计失败: ${dateStr}`, err);
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

        const allDates = await this.getAllStatsDates();
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
            await this.rebuildDateIndex();
        }

        return deletedCount;
    }

    // ==================== Private Helper Methods ====================

    /**
     * 获取统计文件路径
     * 路径: <baseDir>/usages/YYYY-MM-DD/stats.json
     * 包含 daily 和 hourly 两部分
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
                StatusLogger.debug(`[DailyStatsManager] 创建目录: ${dirPath}`);
            }
        } catch (err) {
            // 忽略已存在错误
            const error = err as NodeJS.ErrnoException;
            if (error.code !== 'EEXIST') {
                throw err;
            }
        }
    }

    /**
     * 获取索引文件路径
     * 路径: <baseDir>/usages/index.json
     */
    private getIndexFilePath(): string {
        return path.join(this.baseDir, 'index.json');
    }

    /**
     * 更新日期索引
     * 在保存统计数据后调用，更新索引文件
     */
    private async updateDateIndex(dateStr: string, total: TokenUsageStatsFromFile['total']): Promise<void> {
        const indexPath = this.getIndexFilePath();

        try {
            // 读取现有索引
            let index: DateIndex = { dates: {} };

            if (fsSync.existsSync(indexPath)) {
                const content = await fs.readFile(indexPath, 'utf-8');
                try {
                    index = JSON.parse(content);
                } catch {
                    // 如果解析失败，使用空索引
                }
            }

            // 更新索引条目
            index.dates[dateStr] = {
                total_input: total.actualInput,
                total_cache: total.cacheTokens,
                total_output: total.outputTokens,
                total_requests: total.requests
            };

            // 使用统一的保存方法
            await this.saveDateIndex(index);
        } catch (err) {
            StatusLogger.warn(`[DailyStatsManager] 更新日期索引失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 读取日期索引
     * 用于快速获取所有日期的摘要信息
     */
    async readDateIndex(): Promise<DateIndex | null> {
        const indexPath = this.getIndexFilePath();

        if (!fsSync.existsSync(indexPath)) {
            return null;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);
            StatusLogger.debug(`[DailyStatsManager] 已读取日期索引，共 ${Object.keys(index.dates).length} 个日期`);
            return index;
        } catch (err) {
            StatusLogger.warn('[DailyStatsManager] 读取日期索引失败', err);
            return null;
        }
    }

    /**
     * 保存日期索引
     * 直接保存索引文件，不进行额外检查
     */
    private async saveDateIndex(index: DateIndex): Promise<void> {
        const indexPath = this.getIndexFilePath();

        try {
            // 确保基础目录存在
            await this.ensureDirectoryExists(this.baseDir);

            // 写入索引文件
            await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
            StatusLogger.debug(`[DailyStatsManager] 已保存日期索引，共 ${Object.keys(index.dates).length} 个日期`);
        } catch (err) {
            StatusLogger.warn('[DailyStatsManager] 保存日期索引失败', err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 重新构建日期索引
     * 扫描所有日期目录，重新生成索引文件
     */
    async rebuildDateIndex(): Promise<void> {
        try {
            const dates = await this.getAllStatsDates();
            const summaries: Record<string, DateIndexEntry> = {};

            for (const dateStr of dates) {
                try {
                    const stats = await this.loadStats(dateStr);
                    if (stats) {
                        summaries[dateStr] = {
                            total_input: stats.total.actualInput,
                            total_cache: stats.total.cacheTokens,
                            total_output: stats.total.outputTokens,
                            total_requests: stats.total.requests
                        };
                    }
                } catch (err) {
                    StatusLogger.warn(`[DailyStatsManager] 重建索引时获取日期摘要失败: ${dateStr}`, err);
                }
            }

            await this.saveDateIndex({ dates: summaries });
            StatusLogger.info(`[DailyStatsManager] 已重新构建日期索引，共 ${Object.keys(summaries).length} 个日期`);
        } catch (err) {
            StatusLogger.error('[DailyStatsManager] 重新构建日期索引失败', err);
        }
    }

    /**
     * 从索引中删除指定日期
     * 在删除统计数据后调用
     */
    private async removeDateFromIndex(dateStr: string): Promise<void> {
        const indexPath = this.getIndexFilePath();

        if (!fsSync.existsSync(indexPath)) {
            return;
        }

        try {
            const content = await fs.readFile(indexPath, 'utf-8');
            const index: DateIndex = JSON.parse(content);

            if (index.dates[dateStr]) {
                delete index.dates[dateStr];
                // 使用统一的保存方法
                await this.saveDateIndex(index);
                StatusLogger.debug(`[DailyStatsManager] 已从索引中删除日期: ${dateStr}`);
            }
        } catch (err) {
            StatusLogger.warn(`[DailyStatsManager] 从索引中删除日期失败: ${dateStr}`, err);
            // 不抛出错误，索引更新失败不影响主流程
        }
    }

    /**
     * 检查指定日期的 stats.json 是否需要更新
     * 如果 stats.json 不存在，或者修改时间早于任意日志文件，则需要更新
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
                        `[DailyStatsManager] 日期 ${dateStr} 的 stats.json 过期 (日志文件 ${logFile} 更新时间: ${new Date(logStats.mtimeMs).toISOString()})`
                    );
                    return true;
                }
            }

            return false;
        } catch (err) {
            StatusLogger.warn(`[DailyStatsManager] 检查日期 ${dateStr} 是否需要更新失败:`, err);
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
            StatusLogger.error('[DailyStatsManager] 获取过期日期列表失败', err);
            return outdatedDates;
        }
    }
}
