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
import { StatsCalculator } from './statsCalculator';
import type {
    FileLoggerModelStats,
    FileLoggerProviderStats,
    HourlyStats,
    TokenStats,
    TokenUsageStatsFromFile
} from './types';

/**
 * 日志统计管理器
 * 统一管理统计数据的查询、计算和持久化
 * 注: 缓存由上层调用者(usagesStatusBar等)维护
 */
export class LogStatsManager {
    private readonly baseDir: string;
    private readonly indexManager: LogIndexManager;
    // 缓存创建时间戳：用于判断缓存是否比日志文件更新
    private _cacheVersionTimestamp: number = 0;
    // 代码版本时间戳：用于判断缓存是否由当前版本代码生成
    private _codeVersionTimestamp: number = 0;

    constructor(
        private readManager: LogReadManager,
        baseDir: string,
        indexManager: LogIndexManager
    ) {
        this.baseDir = path.join(baseDir, 'usages');
        this.indexManager = indexManager;
    }

    /**
     * 更新缓存版本时间戳
     * @param cacheTimestamp 缓存创建时间戳
     * @param codeVersionTimestamp 代码版本时间戳
     */
    updateCacheVersionTimestamp(cacheTimestamp: number, codeVersionTimestamp: number): void {
        this._cacheVersionTimestamp = cacheTimestamp;
        this._codeVersionTimestamp = codeVersionTimestamp;
    }

    /**
     * 获取当前缓存创建时间戳
     */
    private getCacheVersionTimestamp(): number {
        return this._cacheVersionTimestamp;
    }

    /**
     * 获取当前代码版本时间戳
     */
    private getCodeVersionTimestamp(): number {
        return this._codeVersionTimestamp;
    }

    /**
     * 获取日期统计
     * 优先尝试从持久化文件读取，否则进行全量计算并保存
     * 如果版本时间戳变化或缓存过期，则全量重新计算
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @param ignoreCache 是否忽略缓存，强制重新计算
     */
    async getDateStats(dateStr: string, ignoreCache: boolean = false): Promise<TokenUsageStatsFromFile> {
        // 优先尝试从持久化文件读取（如果不忽略缓存）
        if (!ignoreCache) {
            const saved = await this.loadStats(dateStr);
            if (saved) {
                // 检查版本时间戳是否有效，如果无效需要全量重新计算
                const needsRegen = await this.needsRegeneration(dateStr);
                if (!needsRegen) {
                    StatusLogger.debug(`[LogStatsManager] 从缓存读取统计: ${dateStr}`);
                    return saved;
                }
                // 版本变化或缓存过期，需要全量重新计算
                StatusLogger.debug(`[LogStatsManager] 缓存已过期，全量重新计算: ${dateStr}`);
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
     * 计算指定日期的统计（包含小时统计和日期统计）
     * 支持增量更新：根据小时文件的修改时间戳判断是否需要重新计算
     * 如果版本变化，则跳过旧的 hourly 缓存，全部重新计算
     * 日期统计（total 和 providers）从小时缓存聚合计算
     *
     * 口径说明：
     * - `StatsCalculator.aggregateLogs()` 只负责计算并写入“模型级别”的聚合值：
     *   - `outputSpeeds`: 模型小时内请求速度的鲁棒均值（用于规避极端值）。
     *   - `firstTokenLatency`: 模型小时内首 token 延迟的算术平均（不做置信/鲁棒处理）。
     * - 本方法在“小时缓存”就绪后，从 models 回填每小时 provider/hour 与 hour total 的聚合值。
     * - daily 的 `outputSpeeds/firstTokenLatency` 均为“小时聚合值的算术平均”（均值的均值，不加权）。
     * - `totalStreamDuration/validStreamRequests/...` 等中间计数仅用于运行时计算（已不再写入缓存）。
     *
     * @private 内部使用，通过 getDateStats 访问
     */
    private async calculateDateStats(dateStr: string): Promise<TokenUsageStatsFromFile> {
        // 读取现有的统计数据
        const existingStats = await this.loadStats(dateStr);

        // 检查是否需要跳过旧缓存：
        // - 没有缓存
        // - 缓存没有 versionTimestamp（旧格式）
        // - 缓存版本 < 当前代码版本
        const hasValidCache =
            existingStats &&
            existingStats.versionTimestamp !== undefined &&
            existingStats.versionTimestamp >= this.getCodeVersionTimestamp();
        const existingHourly = hasValidCache ? existingStats.hourly || {} : {};
        if (!hasValidCache) {
            StatusLogger.debug(`[LogStatsManager] 版本无效，不使用旧缓存，全量重新计算: ${dateStr}`);
        }

        // 获取日期文件夹中所有存在的小时文件
        const dateFolder = path.join(this.baseDir, dateStr);
        let hourFiles: number[] = [];
        try {
            const files = await fs.readdir(dateFolder);
            hourFiles = files
                .filter(f => f.endsWith('.jsonl'))
                .map(f => parseInt(f.slice(0, 2), 10))
                .filter(h => !Number.isNaN(h) && h >= 0 && h <= 23)
                .sort((a, b) => a - b);
        } catch {
            StatusLogger.debug(`[LogStatsManager] 日期文件夹不存在或无法读取: ${dateStr}`);
        }

        // 初始化小时统计结果
        const hourly: Record<string, HourlyStats> = { ...existingHourly };

        // 遍历所有小时文件，增量更新 hourly cache
        for (const hour of hourFiles) {
            const hourKey = String(hour).padStart(2, '0');
            const hourFileModified = await this.readManager.getHourFileModifiedTime(dateStr, hour);
            const existingHourlyStats = existingHourly[hourKey];
            const existingModified = existingHourlyStats?.modifiedTime;

            // 检查是否需要重新计算：
            // 1. 如果没有现有统计，需要计算
            // 2. 如果文件修改时间变了，需要重新计算
            const needsRecalculate = !existingHourlyStats || existingModified !== hourFileModified;
            if (!needsRecalculate) {
                // 文件未改变，保留现有统计
                StatusLogger.trace(`[LogStatsManager] 小时文件未改变，跳过计算: ${dateStr} ${hourKey}:00`);
                continue;
            }

            // 需要重新计算
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

        // 小时缓存就绪后：
        // 1) 先基于“小时+models”计算每小时的 provider/hour 与 hour total 聚合值
        // 2) 再遍历小时计算 daily 的均值（均值的均值，不做加权）
        interface AvgAcc {
            mean: number;
            n: number;
        }
        const addAvg = (acc: AvgAcc | undefined, value: number): AvgAcc => {
            const next = acc ?? { mean: 0, n: 0 };
            next.n += 1;
            next.mean += (value - next.mean) / next.n;
            return next;
        };
        const getAvg = (acc: AvgAcc | undefined): number => (acc && acc.n > 0 ? acc.mean : 0);

        // 从小时统计聚合计算日期统计（避免重复读取日志）
        // 初始化总计
        const total: TokenStats = {
            estimatedInput: 0,
            actualInput: 0,
            cacheTokens: 0,
            outputTokens: 0,
            requests: 0,
            completedRequests: 0,
            failedRequests: 0,
            firstTokenLatency: 0,
            outputSpeeds: 0
        };

        let totalSpeedAcc: AvgAcc | undefined;
        let totalFirstTokenLatencyAcc: AvgAcc | undefined;

        // 初始化提供商统计
        const providers: Record<string, FileLoggerProviderStats> = {};
        const providerMetricAccByDay = new WeakMap<FileLoggerProviderStats, { speed?: AvgAcc; latency?: AvgAcc }>();
        const modelMetricAccByDay = new WeakMap<FileLoggerModelStats, { speed?: AvgAcc; latency?: AvgAcc }>();
        // 遍历所有小时统计，聚合计算
        for (const hourStats of Object.values(hourly)) {
            // 1) 回填每小时 provider/hour 的聚合值：只从模型的已聚合值计算
            let hourTotalSpeedAcc: AvgAcc | undefined;
            let hourTotalLatencyAcc: AvgAcc | undefined;
            for (const providerStats of Object.values(hourStats.providers || {})) {
                let providerSpeedAcc: AvgAcc | undefined;
                let providerLatencyAcc: AvgAcc | undefined;
                for (const modelStats of Object.values(providerStats.models || {})) {
                    if (modelStats.firstTokenLatency && modelStats.firstTokenLatency > 0) {
                        providerLatencyAcc = addAvg(providerLatencyAcc, modelStats.firstTokenLatency);
                        hourTotalLatencyAcc = addAvg(hourTotalLatencyAcc, modelStats.firstTokenLatency);
                    }
                    if (modelStats.outputSpeeds && modelStats.outputSpeeds > 0) {
                        providerSpeedAcc = addAvg(providerSpeedAcc, modelStats.outputSpeeds);
                        hourTotalSpeedAcc = addAvg(hourTotalSpeedAcc, modelStats.outputSpeeds);
                    }
                }
                providerStats.firstTokenLatency = getAvg(providerLatencyAcc);
                providerStats.outputSpeeds = getAvg(providerSpeedAcc);
            }

            hourStats.firstTokenLatency = getAvg(hourTotalLatencyAcc);
            hourStats.outputSpeeds = getAvg(hourTotalSpeedAcc);

            // 2) tokens/requests 仍做累加
            total.estimatedInput += hourStats.estimatedInput;
            total.actualInput += hourStats.actualInput;
            total.cacheTokens += hourStats.cacheTokens;
            total.outputTokens += hourStats.outputTokens;
            total.requests += hourStats.requests;
            total.completedRequests += hourStats.completedRequests;
            total.failedRequests += hourStats.failedRequests;

            // 3) daily total：对每小时的聚合值做算术平均（不加权）
            if (hourStats.firstTokenLatency && hourStats.firstTokenLatency > 0) {
                totalFirstTokenLatencyAcc = addAvg(totalFirstTokenLatencyAcc, hourStats.firstTokenLatency);
            }
            if (hourStats.outputSpeeds && hourStats.outputSpeeds > 0) {
                totalSpeedAcc = addAvg(totalSpeedAcc, hourStats.outputSpeeds);
            }

            // 4) providers/models：累加 tokens，并对每小时聚合值做均值
            for (const [providerKey, providerHour] of Object.entries(hourStats.providers || {})) {
                if (!providers[providerKey]) {
                    providers[providerKey] = {
                        providerName: providerHour.providerName,
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
                provider.estimatedInput += providerHour.estimatedInput;
                provider.actualInput += providerHour.actualInput;
                provider.cacheTokens += providerHour.cacheTokens;
                provider.outputTokens += providerHour.outputTokens;
                provider.requests += providerHour.requests;
                provider.completedRequests += providerHour.completedRequests;
                provider.failedRequests += providerHour.failedRequests;

                const pAcc = providerMetricAccByDay.get(provider) ?? {};
                if (providerHour.firstTokenLatency && providerHour.firstTokenLatency > 0) {
                    pAcc.latency = addAvg(pAcc.latency, providerHour.firstTokenLatency);
                }
                if (providerHour.outputSpeeds && providerHour.outputSpeeds > 0) {
                    pAcc.speed = addAvg(pAcc.speed, providerHour.outputSpeeds);
                }
                providerMetricAccByDay.set(provider, pAcc);

                for (const [modelKey, modelHour] of Object.entries(providerHour.models || {})) {
                    if (!provider.models[modelKey]) {
                        provider.models[modelKey] = {
                            modelName: modelHour.modelName,
                            estimatedInput: 0,
                            actualInput: 0,
                            cacheTokens: 0,
                            outputTokens: 0,
                            requests: 0
                        };
                    }

                    const model = provider.models[modelKey];
                    model.estimatedInput += modelHour.estimatedInput;
                    model.actualInput += modelHour.actualInput;
                    model.cacheTokens += modelHour.cacheTokens;
                    model.outputTokens += modelHour.outputTokens;
                    model.requests += modelHour.requests;

                    const mAcc = modelMetricAccByDay.get(model) ?? {};
                    if (modelHour.firstTokenLatency && modelHour.firstTokenLatency > 0) {
                        mAcc.latency = addAvg(mAcc.latency, modelHour.firstTokenLatency);
                    }
                    if (modelHour.outputSpeeds && modelHour.outputSpeeds > 0) {
                        mAcc.speed = addAvg(mAcc.speed, modelHour.outputSpeeds);
                    }
                    modelMetricAccByDay.set(model, mAcc);
                }
            }
        }

        total.outputSpeeds = getAvg(totalSpeedAcc);
        total.firstTokenLatency = getAvg(totalFirstTokenLatencyAcc);

        for (const provider of Object.values(providers)) {
            const pAcc = providerMetricAccByDay.get(provider);
            provider.firstTokenLatency = getAvg(pAcc?.latency);
            provider.outputSpeeds = getAvg(pAcc?.speed);
            for (const model of Object.values(provider.models)) {
                const mAcc = modelMetricAccByDay.get(model);
                model.firstTokenLatency = getAvg(mAcc?.latency);
                model.outputSpeeds = getAvg(mAcc?.speed);
            }
        }

        return { total, providers, hourly };
    }

    /**
     * 保存每日统计结果
     * 保存到: <baseDir>/usages/YYYY-MM-DD/stats.json
     * 保存完整的日期统计和小时统计（包含 providers）
     * @private 内部使用，通过 getDateStats 访问
     */
    private async saveDateStats(dateStr: string, stats: TokenUsageStatsFromFile): Promise<void> {
        const filePath = this.getStatsFilePath(dateStr);

        try {
            // 确保日期目录存在
            const dateFolder = path.join(this.baseDir, dateStr);
            await this.ensureDirectoryExists(dateFolder);

            // 写入版本时间戳
            stats.versionTimestamp = this.getCodeVersionTimestamp();

            // 写入完整的统计数据
            await fs.writeFile(filePath, JSON.stringify(stats, null, 2), 'utf-8');

            // 更新索引文件
            await this.indexManager.updateIndex(dateStr, stats.total);

            StatusLogger.debug(
                `[LogStatsManager] 已保存日期统计到 stats.json: ${dateStr}, version=${new Date(stats.versionTimestamp).toISOString()}`
            );
        } catch (err) {
            StatusLogger.error(`[LogStatsManager] 保存日期统计失败: ${dateStr}`, err);
            throw err;
        }
    }

    /**
     * 检查并重新生成过期的统计数据
     * 在打开统计页面时调用，确保所有日期的 stats.json 都是最新的
     * @returns 成功重新生成的日期统计，key 为日期字符串
     */
    async regenerateOutdatedStats(): Promise<Record<string, TokenUsageStatsFromFile>> {
        const startTime = Date.now();

        // 获取所有需要重新生成的日期列表
        const outdatedDates = await this.getOutdatedDates();
        if (outdatedDates.length === 0) {
            StatusLogger.debug('[LogStatsManager] 所有统计数据都是最新的，无需重新生成');
            return {};
        }

        StatusLogger.debug(`[LogStatsManager] 发现 ${outdatedDates.length} 个日期的统计数据需要重新生成`);

        const results: Record<string, TokenUsageStatsFromFile> = {};
        for (const dateStr of outdatedDates) {
            try {
                // 重新计算该日期的统计数据（使用 getDateStats 自动处理计算和保存）
                const stats = await this.getDateStats(dateStr);

                // 记录结果
                results[dateStr] = stats;
                StatusLogger.debug(`[LogStatsManager] 已重新生成日期 ${dateStr} 的统计数据`);
            } catch (err) {
                StatusLogger.warn(`[LogStatsManager] 重新生成日期 ${dateStr} 的统计数据失败:`, err);
            }
        }

        const elapsed = Date.now() - startTime;
        StatusLogger.debug(
            `[LogStatsManager] 统计数据重新生成完成: ${Object.keys(results).length}/${outdatedDates.length} 个成功 (耗时: ${elapsed}ms)`
        );
        return results;
    }

    /**
     * 获取所有需要重新生成的日期列表
     * @private 内部使用，通过 regenerateOutdatedStats 访问
     */
    private async getOutdatedDates(): Promise<string[]> {
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
     * 从持久化文件读取日期统计结果
     * 读取 <baseDir>/usages/YYYY-MM-DD/stats.json 文件
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @returns 统计对象，不存在时返回 null
     */
    private async loadStats(dateStr: string): Promise<TokenUsageStatsFromFile | null> {
        const filePath = this.getStatsFilePath(dateStr);
        if (!fsSync.existsSync(filePath)) {
            return null;
        }

        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const statsData: TokenUsageStatsFromFile = JSON.parse(content);
            StatusLogger.debug(`[LogStatsManager] 已从 stats.json 读取日期统计: ${dateStr}`);
            return statsData;
        } catch (err) {
            StatusLogger.warn(`[LogStatsManager] 读取统计失败: ${dateStr}`, err);
            return null;
        }
    }

    /**
     * 检查指定日期的统计文件是否需要重新生成
     * 判断逻辑：
     * 1. 如果 stats.json 不存在，需要生成
     * 2. 如果没有 versionTimestamp（旧格式缓存），需要重新生成
     * 3. 如果 versionTimestamp < 代码版本时间戳，需要重新生成（代码更新了）
     * 4. 如果 stats.json 修改时间 < 缓存创建时间，说明是缓存重建前生成的旧统计，需要重新生成
     * 5. 如果 stats.json 修改时间 >= 缓存创建时间，检查是否有更新的日志文件
     * @param dateStr 日期字符串 (YYYY-MM-DD)
     * @returns true 表示需要重新生成，false 表示无需重新生成
     */
    private async needsRegeneration(dateStr: string): Promise<boolean> {
        const statsFilePath = this.getStatsFilePath(dateStr);
        // 如果 stats.json 不存在，需要生成
        if (!fsSync.existsSync(statsFilePath)) {
            return true;
        }

        try {
            // 读取 stats.json 内容，检查 versionTimestamp
            const content = await fs.readFile(statsFilePath, 'utf-8');
            const statsData: TokenUsageStatsFromFile = JSON.parse(content);

            // 检查版本时间戳
            const savedVersionTimestamp = statsData.versionTimestamp;
            const codeVersionTimestamp = this.getCodeVersionTimestamp();

            // 步骤2: 如果没有 versionTimestamp（旧格式缓存），需要重新生成
            if (savedVersionTimestamp === undefined) {
                StatusLogger.debug(
                    `[LogStatsManager] 日期 ${dateStr} 的 stats.json 需要重新计算 (无版本时间戳，旧格式缓存)`
                );
                return true;
            }

            // 步骤3: 如果缓存版本 < 代码版本，需要重新生成
            if (savedVersionTimestamp < codeVersionTimestamp) {
                StatusLogger.debug(
                    `[LogStatsManager] 日期 ${dateStr} 的 stats.json 需要重新计算 (缓存版本: ${new Date(savedVersionTimestamp).toISOString()}, 代码版本: ${new Date(codeVersionTimestamp).toISOString()})`
                );
                return true;
            }

            // 步骤4: 检查缓存是否比日志文件更新
            const statsStats = fsSync.statSync(statsFilePath);
            const statsMtime = statsStats.mtimeMs;
            const cacheVersionTimestamp = this.getCacheVersionTimestamp();

            // 如果 stats.json 修改时间 < 缓存创建时间，说明是缓存重建前生成的旧统计，需要重新生成
            if (statsMtime < cacheVersionTimestamp) {
                return true;
            }

            // stats.json 修改时间 >= 缓存创建时间，检查是否有更新的日志文件
            const dateFolder = path.join(this.baseDir, dateStr);
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
                        `[LogStatsManager] 日期 ${dateStr} 的 stats.json 过期 (日志文件 ${logFile} 更新)`
                    );
                    return true;
                }
            }

            // 没有更新的日志文件，缓存有效
            return false;
        } catch (err) {
            StatusLogger.warn(`[LogStatsManager] 检查日期 ${dateStr} 是否需要更新失败:`, err);
            return false;
        }
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
