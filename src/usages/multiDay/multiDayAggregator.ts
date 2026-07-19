/*---------------------------------------------------------------------------------------------
 *  多天长周期用量分析 - 跨日聚合引擎
 *--------------------------------------------------------------------------------------------*/

import { TokenFileLogger } from '../fileLogger';
import { createEmptyNativeCostSplit, mergeNativeCostSplit } from '../fileLogger/nativeCostSplit';
import type { NativeCostSplit, TokenUsageStatsFromFile } from '../fileLogger/types';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import type {
    MultiDayAnalysisResult,
    MultiDayDateStats,
    MultiDayProviderStats,
    MultiDayModelStats,
    TrendSeries
} from './types';

/** 分析区间最大天数上限 */
const MAX_DATE_RANGE_DAYS = 365;

function cloneNativeCostSplit(source?: NativeCostSplit): NativeCostSplit {
    const target = createEmptyNativeCostSplit();
    if (source) {
        mergeNativeCostSplit(target, source);
    }
    return target;
}

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
            grandCompleted = 0,
            grandCancelled = 0,
            grandCost = 0,
            grandCostRmb = 0;
        const grandNativeCosts = createEmptyNativeCostSplit();
        const providerAcc = new Map<
            string,
            {
                name: string;
                input: number;
                cache: number;
                output: number;
                nativeCosts: NativeCostSplit;
                estimatedCost: number;
                estimatedCostRmb: number;
                inputCost: number;
                inputCostRmb: number;
                outputCost: number;
                outputCostRmb: number;
                cacheReadCost: number;
                cacheReadCostRmb: number;
                cacheWriteCost: number;
                cacheWriteCostRmb: number;
            }
        >();
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
                nativeCosts: NativeCostSplit;
                estimatedCost: number;
                estimatedCostRmb: number;
                inputCost: number;
                inputCostRmb: number;
                outputCost: number;
                outputCostRmb: number;
                cacheReadCost: number;
                cacheReadCostRmb: number;
                cacheWriteCost: number;
                cacheWriteCostRmb: number;
            }
        >();

        for (const date of dateKeys) {
            const stats = statsMap.get(date);
            if (!stats) {
                continue;
            }
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
            grandCancelled += ds.cancelledRequests;
            grandCost += ds.estimatedCost;
            grandCostRmb += ds.estimatedCostRmb;
            if (stats.total.nativeCosts) {
                mergeNativeCostSplit(grandNativeCosts, stats.total.nativeCosts);
            }
            for (const [k, ps] of Object.entries(stats.providers)) {
                const pi = ps.actualInput || ps.estimatedInput || 0;
                const pc = ps.cacheTokens || 0;
                const po = ps.outputTokens || 0;
                const prev = providerAcc.get(k);
                const providerNativeCosts = cloneNativeCostSplit(prev?.nativeCosts);
                if (ps.nativeCosts) {
                    mergeNativeCostSplit(providerNativeCosts, ps.nativeCosts);
                }
                providerAcc.set(k, {
                    name: ps.providerName,
                    input: (prev?.input || 0) + pi,
                    cache: (prev?.cache || 0) + pc,
                    output: (prev?.output || 0) + po,
                    nativeCosts: providerNativeCosts,
                    estimatedCost: (prev?.estimatedCost || 0) + (ps.estimatedCost || 0),
                    estimatedCostRmb: (prev?.estimatedCostRmb || 0) + (ps.estimatedCostRmb || 0),
                    inputCost: (prev?.inputCost || 0) + (ps.inputCost || 0),
                    inputCostRmb: (prev?.inputCostRmb || 0) + (ps.inputCostRmb || 0),
                    outputCost: (prev?.outputCost || 0) + (ps.outputCost || 0),
                    outputCostRmb: (prev?.outputCostRmb || 0) + (ps.outputCostRmb || 0),
                    cacheReadCost: (prev?.cacheReadCost || 0) + (ps.cacheReadCost || 0),
                    cacheReadCostRmb: (prev?.cacheReadCostRmb || 0) + (ps.cacheReadCostRmb || 0),
                    cacheWriteCost: (prev?.cacheWriteCost || 0) + (ps.cacheWriteCost || 0),
                    cacheWriteCostRmb: (prev?.cacheWriteCostRmb || 0) + (ps.cacheWriteCostRmb || 0)
                });
                for (const [mk, ms] of Object.entries(ps.models)) {
                    const mi = ms.actualInput || ms.estimatedInput || 0;
                    const mc = ms.cacheTokens || 0;
                    const mo = ms.outputTokens || 0;
                    const globalModelKey = `${k}/${mk}`;
                    const pv = modelAcc.get(globalModelKey);
                    const modelNativeCosts = cloneNativeCostSplit(pv?.nativeCosts);
                    if (ms.nativeCosts) {
                        mergeNativeCostSplit(modelNativeCosts, ms.nativeCosts);
                    }
                    modelAcc.set(globalModelKey, {
                        providerName: ps.providerName,
                        modelName: ms.modelName,
                        displayName: `${ps.providerName}/${ms.modelName}`,
                        requests: (pv?.requests || 0) + ms.requests,
                        input: (pv?.input || 0) + mi,
                        cache: (pv?.cache || 0) + mc,
                        output: (pv?.output || 0) + mo,
                        nativeCosts: modelNativeCosts,
                        estimatedCost: (pv?.estimatedCost || 0) + (ms.estimatedCost || 0),
                        estimatedCostRmb: (pv?.estimatedCostRmb || 0) + (ms.estimatedCostRmb || 0),
                        inputCost: (pv?.inputCost || 0) + (ms.inputCost || 0),
                        inputCostRmb: (pv?.inputCostRmb || 0) + (ms.inputCostRmb || 0),
                        outputCost: (pv?.outputCost || 0) + (ms.outputCost || 0),
                        outputCostRmb: (pv?.outputCostRmb || 0) + (ms.outputCostRmb || 0),
                        cacheReadCost: (pv?.cacheReadCost || 0) + (ms.cacheReadCost || 0),
                        cacheReadCostRmb: (pv?.cacheReadCostRmb || 0) + (ms.cacheReadCostRmb || 0),
                        cacheWriteCost: (pv?.cacheWriteCost || 0) + (ms.cacheWriteCost || 0),
                        cacheWriteCostRmb: (pv?.cacheWriteCostRmb || 0) + (ms.cacheWriteCostRmb || 0)
                    });
                }
            }
        }

        // === 构建排名 ===
        const totalAllTokens = grandTokens || 1;
        const providerRanking = Array.from(providerAcc.entries())
            .map(([k, v]) => {
                const tokens = v.input + v.output;
                return {
                    key: k,
                    name: v.name,
                    totalInput: v.input,
                    totalCache: v.cache,
                    totalOutput: v.output,
                    totalTokens: tokens,
                    share: tokens / totalAllTokens,
                    nativeCosts: cloneNativeCostSplit(v.nativeCosts),
                    estimatedCost: v.estimatedCost,
                    estimatedCostRmb: v.estimatedCostRmb,
                    inputCost: v.inputCost,
                    inputCostRmb: v.inputCostRmb,
                    outputCost: v.outputCost,
                    outputCostRmb: v.outputCostRmb,
                    cacheReadCost: v.cacheReadCost,
                    cacheReadCostRmb: v.cacheReadCostRmb,
                    cacheWriteCost: v.cacheWriteCost,
                    cacheWriteCostRmb: v.cacheWriteCostRmb
                };
            })
            .sort((a, b) => b.totalTokens - a.totalTokens);
        const modelRanking = Array.from(modelAcc.entries())
            .map(([id, v]) => {
                const tokens = v.input + v.output;
                return {
                    id,
                    name: v.displayName,
                    providerName: v.providerName,
                    modelName: v.modelName,
                    totalInput: v.input,
                    totalCache: v.cache,
                    totalOutput: v.output,
                    totalRequests: v.requests,
                    totalTokens: tokens,
                    nativeCosts: cloneNativeCostSplit(v.nativeCosts),
                    estimatedCost: v.estimatedCost,
                    estimatedCostRmb: v.estimatedCostRmb,
                    inputCost: v.inputCost,
                    inputCostRmb: v.inputCostRmb,
                    outputCost: v.outputCost,
                    outputCostRmb: v.outputCostRmb,
                    cacheReadCost: v.cacheReadCost,
                    cacheReadCostRmb: v.cacheReadCostRmb,
                    cacheWriteCost: v.cacheWriteCost,
                    cacheWriteCostRmb: v.cacheWriteCostRmb
                };
            })
            .sort((a, b) => b.totalTokens - a.totalTokens);

        // === 汇总 ===
        const dayCount = dates.length;
        const dailyAvgTokens = dayCount > 0 ? Math.round(grandTokens / dayCount) : 0;
        const dailyAvgCost = dayCount > 0 ? grandCost / dayCount : 0;
        const dailyAvgCostRmb = dayCount > 0 ? grandCostRmb / dayCount : 0;
        // 成功率/失败率分母排除已中止的请求（用户主动取消，不应计入系统成功率/失败率）
        const effectiveTotal = grandRequests - grandCancelled;
        const successRate = effectiveTotal > 0 ? grandCompleted / effectiveTotal : 0;
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
                nativeCosts: cloneNativeCostSplit(grandNativeCosts),
                totalCost: grandCost,
                totalCostRmb: grandCostRmb,
                dailyAvgCost,
                dailyAvgCostRmb,
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
        const cancelR = stats.total.cancelledRequests;
        // 失败率分母排除已中止的请求（用户主动取消，不应计入系统失败率）
        const frate = tr > cancelR ? fr / (tr - cancelR) : 0;
        const tt = ti + to;
        const chr = ti > 0 ? tc / ti : 0;

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
                    totalTokens: mi + mo,
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
                totalTokens: pi + po,
                totalRequests: ps.requests,
                avgSpeed: ps.outputSpeeds || 0,
                avgLatency: ps.firstTokenLatency || 0,
                estimatedCost: ps.estimatedCost || 0,
                estimatedCostRmb: ps.estimatedCostRmb || 0,
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
            cancelledRequests: cancelR,
            failureRate: frate,
            cacheHitRate: chr,
            estimatedCost: stats.total.estimatedCost || 0,
            estimatedCostRmb: stats.total.estimatedCostRmb || 0,
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
            cacheHitRate: dates.map(d => d.cacheHitRate),
            estimatedCost: dates.map(d => d.estimatedCost),
            estimatedCostRmb: dates.map(d => d.estimatedCostRmb)
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
                cacheHitRate: [],
                estimatedCost: [],
                estimatedCostRmb: []
            },
            summary: {
                totalTokens: 0,
                totalInput: 0,
                totalCache: 0,
                totalOutput: 0,
                totalRequests: 0,
                successRate: 0,
                dailyAvgTokens: 0,
                nativeCosts: createEmptyNativeCostSplit(),
                totalCost: 0,
                totalCostRmb: 0,
                dailyAvgCost: 0,
                dailyAvgCostRmb: 0,
                topProvider: null,
                topModel: null,
                tokensChangePct: null
            },
            providerRanking: [],
            modelRanking: []
        };
    }
}
