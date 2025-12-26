/*---------------------------------------------------------------------------------------------
 *  统计查询服务
 *  统一管理各种统计数据的查询逻辑，避免重复代码
 *--------------------------------------------------------------------------------------------*/

import { StatusLogger } from '../../utils/statusLogger';
import { LogReadManager } from './readManager';
import { DailyStatsManager } from './dailyStatsManager';
import type { TokenUsageStatsFromFile } from './types';

/**
 * 统计查询服务
 * 统一管理统计数据的查询和持久化
 * 注: 缓存由上层调用者(usagesStatusBar等)维护
 */
export class StatsQueryService {
    constructor(
        private readManager: LogReadManager,
        private dailyStatsManager: DailyStatsManager,
        private getTodayDateString: () => string
    ) {}

    /**
     * 获取日期统计
     * 优先尝试从持久化文件读取，否则从日志文件计算
     * 多实例通过监听 stats.json 文件变化来实时同步
     */
    async getDateStats(dateStr: string, fromFile: boolean = false): Promise<TokenUsageStatsFromFile> {
        const today = this.getTodayDateString();
        const isTodayOrHistory = dateStr === today;

        // 优先尝试从持久化文件读取（如果不是直接计算模式）
        if (!fromFile) {
            const saved = await this.dailyStatsManager.loadStats(dateStr);
            if (saved) {
                StatusLogger.debug(`[StatsQueryService] 从缓存读取统计: ${dateStr}`);
                return saved;
            }
        }

        // 从日志文件计算统计
        StatusLogger.debug(`[StatsQueryService] 计算${isTodayOrHistory ? '今日' : '历史'}统计: ${dateStr}`);
        const stats = await this.readManager.calculateDateStats(dateStr);

        // 保存到持久化文件
        if (!isTodayOrHistory) {
            // 始终保存，便于多实例通过 stats.json 同步
            await this.dailyStatsManager.saveDateStats(dateStr, stats);
        }

        return stats;
    }

    /**
     * 获取小时统计
     * 优先从持久化文件读取，多实例通过监听 stats.json 来同步
     * 优化：一次性计算小时和日期统计，避免重复读取日志
     * 支持增量更新：根据小时文件修改时间戳判断是否需要重新计算
     */
    async getHourStats(dateStr: string, hour: number): Promise<TokenUsageStatsFromFile> {
        // 一次读取：尝试获取已持久化的统计（包含hourlyModified）
        const saved = await this.dailyStatsManager.loadStats(dateStr, hour);
        if (saved) {
            StatusLogger.debug(`[StatsQueryService] 从缓存读取小时统计: ${dateStr} ${hour}:00`);
            return saved;
        }

        // 读取日期统计以获取现有的 hourlyModified 时间戳
        const dateStats = await this.dailyStatsManager.loadStats(dateStr);
        const existingHourlyModified = dateStats?.hourlyModified;

        // 一次性计算小时和日期统计（支持增量更新）
        const [hourStats, newDateStats, updatedHourlyModified] = await this.readManager.calculateHourAndDateStats(
            dateStr,
            hour,
            existingHourlyModified
        );

        // 更新日期统计中的 hourlyModified 和小时统计
        newDateStats.hourlyModified = updatedHourlyModified;

        // 一次性保存小时和日期统计
        await this.dailyStatsManager.saveHourAndDateStats(dateStr, hour, hourStats, newDateStats);

        return hourStats;
    }

    /**
     * 使日期相关的所有缓存失效（重新计算）
     */
    async invalidateDateCaches(dateStr: string): Promise<void> {
        StatusLogger.debug(`[StatsQueryService] 已清除日期缓存: ${dateStr}`);
    }

    /**
     * 刷新日期统计（重新计算并更新）
     */
    async refreshDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 重新计算
        const stats = await this.readManager.calculateDateStats(dateStr);

        // 保存到文件
        await this.dailyStatsManager.saveDateStats(dateStr, stats);

        return stats;
    }

    /**
     * 刷新小时统计（重新计算并更新）
     * 优化：一次性计算小时和日期统计，避免重复读取日志
     * 支持增量更新：根据小时文件修改时间戳判断是否需要重新计算
     */
    async refreshHourStats(dateStr: string, hour: number): Promise<TokenUsageStatsFromFile> {
        // 读取日期统计以获取现有的 hourlyModified 时间戳
        const dateStats = await this.dailyStatsManager.loadStats(dateStr);
        const existingHourlyModified = dateStats?.hourlyModified;

        // 一次性计算小时和日期统计（支持增量更新）
        const [hourStats, newDateStats, updatedHourlyModified] = await this.readManager.calculateHourAndDateStats(
            dateStr,
            hour,
            existingHourlyModified
        );

        // 更新日期统计中的 hourlyModified 和小时统计
        newDateStats.hourlyModified = updatedHourlyModified;

        // 保存
        await this.dailyStatsManager.saveHourAndDateStats(dateStr, hour, hourStats, newDateStats);

        return hourStats;
    }
}
