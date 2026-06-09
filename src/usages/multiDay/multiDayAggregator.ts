/*---------------------------------------------------------------------------------------------
 *  多天长周期用量分析 - 跨日聚合引擎
 *--------------------------------------------------------------------------------------------*/

import { TokenFileLogger } from '../fileLogger';
import type { TokenUsageStatsFromFile } from '../fileLogger/types';
import { StatusLogger } from '../../utils/statusLogger';
import type {
    MultiDayAnalysisResult,
    MultiDayDateStats,
    MultiDayProviderStats,
    MultiDayModelStats,
    TrendSeries
} from './types';

/** 分析区间最大天数上限 */
const MAX_DATE_RANGE_DAYS = 365;

/**
 * 跨日数据聚合器
 */
export class MultiDayAggregator {
    private fileLogger: TokenFileLogger;

    constructor(fileLogger: TokenFileLogger) {
        this.fileLogger = fileLogger;
    }

    async aggregate(dateFrom: string, dateTo: string): Promise<MultiDayAnalysisResult> {
        StatusLogger.debug(`[MultiDayAggregator] Aggregating ${dateFrom} → ${dateTo}`);

        // 区间上限校验
        const fromMs = new Date(dateFrom + 'T00:00:00').getTime();
        const toMs = new Date(dateTo + 'T00:00:00').getTime();
        const rangeDays = Math.ceil((toMs - fromMs) / 86400000) + 1;
        if (rangeDays > MAX_DATE_RANGE_DAYS) {
            throw new Error(
                `Date range exceeds maximum of ${MAX_DATE_RANGE_DAYS} days (requested: ${rangeDays} days). Please narrow your selection.`
            );
        }

        const index = await this.fileLogger.getIndex();
        const dateKeys = Object.keys(index)
            .filter(d => d >= dateFrom && d <= dateTo)
            .sort();

        if (dateKeys.length === 0) {
            return this.emptyResult(dateFrom, dateTo);
        }

        // === 读取每日数据 ===
        const entries = await Promise.all(
            dateKeys.map(async date => {
                try {
                    const stats = await this.fileLogger.getDateStatsFromFile(date);
                    return { date, stats };
                } catch (error) {
                    StatusLogger.warn(`[MultiDayAggregator] Failed to load stats for ${date}: ${error}`);
                    return { date, stats: null };
                }
            })
        );
        const statsMap = new Map<string, TokenUsageStatsFromFile>();
        const missingDates: string[] = [];
        for (const entry of entries) {
            if (entry.stats) {
                statsMap.set(entry.date, entry.stats);
            } else {
                missingDates.push(entry.date);
            }
        }
        if (missingDates.length > 0) {
            StatusLogger.warn(
                `[MultiDayAggregator] ${missingDates.length}/${dateKeys.length} days failed to load, result will be partial`
            );
        }

        // === 合并 ===
        const dates: MultiDayDateStats[] = [];
        let grandTokens = 0,
            grandInput = 0,
            grandCache = 0,
            grandOutput = 0,
            grandRequests = 0,
            grandCompleted = 0;
        const providerAcc = new Map<string, { name: string; input: number; cache: number; output: number }>();
        const modelAcc = new Map<
            string,
            {
                providerName: string;
                modelName: string;
                displayName: string;
                requests: number;
                input: number;
                cache: number;
                output: number;
            }
        >();

        for (const date of dateKeys) {
            const stats = statsMap.get(date);
            if (!stats) continue;
            const d = new Date(date + 'T00:00:00');
            const dayOfWeek = d.getDay();
            const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

            const ds = this.buildFromStats(date, dayOfWeek, isWeekend, stats);
            dates.push(ds);
            grandTokens += ds.totalTokens;
            grandInput += ds.totalInput;
            grandCache += ds.totalCache;
            grandOutput += ds.totalOutput;
            grandRequests += ds.totalRequests;
            grandCompleted += ds.completedRequests;
            for (const [k, ps] of Object.entries(stats.providers)) {
                const pi = ps.actualInput || ps.estimatedInput || 0;
                const pc = ps.cacheTokens || 0;
                const po = ps.outputTokens || 0;
                const prev = providerAcc.get(k);
                providerAcc.set(k, {
                    name: ps.providerName,
                    input: (prev?.input || 0) + pi,
                    cache: (prev?.cache || 0) + pc,
                    output: (prev?.output || 0) + po
                });
                for (const [mk, ms] of Object.entries(ps.models)) {
                    const mi = ms.actualInput || ms.estimatedInput || 0;
                    const mc = ms.cacheTokens || 0;
                    const mo = ms.outputTokens || 0;
                    const globalModelKey = `${k}/${mk}`;
                    const pv = modelAcc.get(globalModelKey);
                    modelAcc.set(globalModelKey, {
                        providerName: ps.providerName,
                        modelName: ms.modelName,
                        displayName: `${ps.providerName}/${ms.modelName}`,
                        requests: (pv?.requests || 0) + ms.requests,
                        input: (pv?.input || 0) + mi,
                        cache: (pv?.cache || 0) + mc,
                        output: (pv?.output || 0) + mo
                    });
                }
            }
        }

        // === 构建排名 ===
        const totalAllTokens = grandTokens || 1;
        const providerRanking = Array.from(providerAcc.entries())
            .map(([k, v]) => {
                const tokens = v.input + v.cache + v.output;
                return {
                    key: k,
                    name: v.name,
                    totalInput: v.input,
                    totalCache: v.cache,
                    totalOutput: v.output,
                    totalTokens: tokens,
                    share: tokens / totalAllTokens
                };
            })
            .sort((a, b) => b.totalTokens - a.totalTokens);
        const modelRanking = Array.from(modelAcc.entries())
            .map(([id, v]) => {
                const tokens = v.input + v.cache + v.output;
                return {
                    id,
                    name: v.displayName,
                    providerName: v.providerName,
                    modelName: v.modelName,
                    totalInput: v.input,
                    totalCache: v.cache,
                    totalOutput: v.output,
                    totalRequests: v.requests,
                    totalTokens: tokens
                };
            })
            .sort((a, b) => b.totalTokens - a.totalTokens);

        // === 汇总 ===
        const dayCount = dates.length;
        const dailyAvgTokens = dayCount > 0 ? Math.round(grandTokens / dayCount) : 0;
        const successRate = grandRequests > 0 ? grandCompleted / grandRequests : 0;
        const topProvider =
            providerRanking[0] ?
                { key: providerRanking[0].key, name: providerRanking[0].name, share: providerRanking[0].share }
            :   null;
        const topModel =
            modelRanking[0] ?
                {
                    id: modelRanking[0].id,
                    name: modelRanking[0].name,
                    share: grandRequests > 0 ? modelRanking[0].totalRequests / grandRequests : 0
                }
            :   null;

        const trendSeries = this.buildTrendSeries(dates);

        return {
            dateFrom,
            dateTo,
            dayCount,
            missingDates,
            dates,
            trendSeries,
            summary: {
                totalTokens: grandTokens,
                totalInput: grandInput,
                totalCache: grandCache,
                totalOutput: grandOutput,
                totalRequests: grandRequests,
                successRate,
                dailyAvgTokens,
                topProvider,
                topModel,
                tokensChangePct: null
            },
            providerRanking,
            modelRanking
        };
    }

    private buildFromStats(
        date: string,
        dayOfWeek: number,
        isWeekend: boolean,
        stats: TokenUsageStatsFromFile
    ): MultiDayDateStats {
        const ti = stats.total.actualInput || stats.total.estimatedInput || 0;
        const tc = stats.total.cacheTokens || 0;
        const to = stats.total.outputTokens || 0;
        const tr = stats.total.requests;
        const cr = stats.total.completedRequests;
        const fr = stats.total.failedRequests;
        const frate = tr > 0 ? fr / tr : 0;
        const tt = ti + tc + to;
        const chr = ti + to + tc > 0 ? tc / (ti + to + tc) : 0;

        const providers: Record<string, MultiDayProviderStats> = {};
        for (const [k, ps] of Object.entries(stats.providers)) {
            const pi = ps.actualInput || ps.estimatedInput || 0;
            const pc = ps.cacheTokens || 0;
            const po = ps.outputTokens || 0;
            const models: Record<string, MultiDayModelStats> = {};
            for (const [mk, ms] of Object.entries(ps.models)) {
                const mi = ms.actualInput || ms.estimatedInput || 0;
                const mc = ms.cacheTokens || 0;
                const mo = ms.outputTokens || 0;
                models[mk] = {
                    modelName: ms.modelName,
                    totalInput: mi,
                    totalCache: mc,
                    totalOutput: mo,
                    totalTokens: mi + mc + mo,
                    totalRequests: ms.requests,
                    avgSpeed: ms.outputSpeeds || 0,
                    avgLatency: ms.firstTokenLatency || 0
                };
            }
            providers[k] = {
                providerKey: k,
                providerName: ps.providerName,
                totalInput: pi,
                totalCache: pc,
                totalOutput: po,
                totalTokens: pi + pc + po,
                totalRequests: ps.requests,
                avgSpeed: ps.outputSpeeds || 0,
                avgLatency: ps.firstTokenLatency || 0,
                models
            };
        }
        return {
            date,
            dayOfWeek,
            isWeekend,
            totalInput: ti,
            totalCache: tc,
            totalOutput: to,
            totalTokens: tt,
            totalRequests: tr,
            completedRequests: cr,
            failedRequests: fr,
            failureRate: frate,
            cacheHitRate: chr,
            providers
        };
    }

    private buildTrendSeries(dates: MultiDayDateStats[]): TrendSeries {
        return {
            dates: dates.map(d => d.date),
            totalTokens: dates.map(d => d.totalTokens),
            inputTokens: dates.map(d => d.totalInput),
            outputTokens: dates.map(d => d.totalOutput),
            cacheTokens: dates.map(d => d.totalCache),
            requests: dates.map(d => d.totalRequests),
            failureRate: dates.map(d => d.failureRate),
            cacheHitRate: dates.map(d => d.cacheHitRate)
        };
    }

    private emptyResult(dateFrom: string, dateTo: string): MultiDayAnalysisResult {
        return {
            dateFrom,
            dateTo,
            dayCount: 0,
            missingDates: [],
            dates: [],
            trendSeries: {
                dates: [],
                totalTokens: [],
                inputTokens: [],
                outputTokens: [],
                cacheTokens: [],
                requests: [],
                failureRate: [],
                cacheHitRate: []
            },
            summary: {
                totalTokens: 0,
                totalInput: 0,
                totalCache: 0,
                totalOutput: 0,
                totalRequests: 0,
                successRate: 0,
                dailyAvgTokens: 0,
                topProvider: null,
                topModel: null,
                tokensChangePct: null
            },
            providerRanking: [],
            modelRanking: []
        };
    }
}
