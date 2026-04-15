/*---------------------------------------------------------------------------------------------
 *  统计计算器
 *  专门负责日志聚合和统计计算，不涉及文件 I/O
 *  设计为静态类，所有方法直接调用，无需实例化
 *--------------------------------------------------------------------------------------------*/

import { UsageParser } from './usageParser';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * 统计计算器
 * 负责日志聚合和统计计算的核心逻辑
 * 静态类，无需实例化
 */
export abstract class StatsCalculator {
    private constructor() {
        // 私有构造函数，防止实例化
    }

    /** 计算算术均值（忽略非正/非有限值） */
    static calculateMean(values: number[]): number {
        const cleaned = (values || []).filter(v => Number.isFinite(v) && v > 0);
        if (cleaned.length === 0) {
            return 0;
        }
        return cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length;
    }

    /**
     * 计算鲁棒均值：先在 log 空间用 MAD 过滤离群点；若出现明显断层则保留包含中位数的主簇。
     */
    static calculateRobustMean(values: number[]): number {
        const cleaned = (values || []).filter(v => Number.isFinite(v) && v > 0);
        if (cleaned.length === 0) {
            return 0;
        }

        const mean = (arr: number[]): number => arr.reduce((sum, v) => sum + v, 0) / arr.length;
        const medianOfSorted = (sorted: number[]): number => {
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        };

        // 样本太少时直接算术平均
        if (cleaned.length < 5) {
            return mean(cleaned);
        }

        // 在 log 空间做鲁棒离群点检测（倍率异常更显著）
        const pairs = cleaned.map(v => ({ v, log: Math.log(v) })).sort((a, b) => a.log - b.log);
        const logs = pairs.map(p => p.log);
        const medLog = medianOfSorted(logs);
        const absDevs = logs.map(l => Math.abs(l - medLog));
        const mad = medianOfSorted([...absDevs].sort((a, b) => a - b));

        // MAD=0 说明数据极度集中，直接平均即可
        if (!Number.isFinite(mad) || mad <= 0) {
            return mean(cleaned);
        }

        // 将 MAD 标准化为近似标准差（正态近似常数）
        const sigma = mad * 1.4826;
        // 对速度类右偏数据，k=3.5 在 log 空间过于宽松（容忍 ~33x 倍率），
        // 降至 1.5 可将过滤阈值控制在约 4.5x，能更严格地拦截极端离群值。
        const k = 1.5;

        const madFiltered = pairs.filter(p => Math.abs(p.log - medLog) / sigma <= k).map(p => p.v);
        // 过滤后仍保留至少一半样本即可信任该结果，否则降级到断层识别
        if (madFiltered.length >= Math.max(3, Math.floor(cleaned.length * 0.5))) {
            return mean(madFiltered);
        }

        // 断层识别：如果排序后存在巨大间隙，自动选主簇（包含中位数的簇）
        const diffs: number[] = [];
        for (let i = 0; i < logs.length - 1; i++) {
            diffs.push(logs[i + 1] - logs[i]);
        }
        if (diffs.length === 0) {
            return mean(cleaned);
        }

        const sortedDiffs = [...diffs].sort((a, b) => a - b);
        const medDiff = medianOfSorted(sortedDiffs);
        const absDiffDevs = sortedDiffs.map(d => Math.abs(d - medDiff));
        const madDiff = medianOfSorted([...absDiffDevs].sort((a, b) => a - b));

        // gapThreshold 同时考虑绝对倍率（>2x）和相对“异常间隙”
        const minGap = Math.log(2); // 相邻点倍率 >= 2
        const gapThreshold = Math.max(minGap, medDiff + 6 * (madDiff || 0));

        let bestGapIndex = -1;
        let bestGapValue = 0;
        for (let i = 0; i < diffs.length; i++) {
            if (diffs[i] >= gapThreshold && diffs[i] > bestGapValue) {
                bestGapValue = diffs[i];
                bestGapIndex = i;
            }
        }

        if (bestGapIndex >= 0) {
            // 以中位数所在位置确定保留哪一侧（主簇）
            const midIndex = Math.floor((logs.length - 1) / 2);
            const keepLeft = bestGapIndex >= midIndex;
            const start = keepLeft ? 0 : bestGapIndex + 1;
            const end = keepLeft ? bestGapIndex + 1 : pairs.length;
            const cluster = pairs.slice(start, end).map(p => p.v);
            if (cluster.length >= 3) {
                return mean(cluster);
            }
        }

        // 最终兜底：算术平均
        return mean(cleaned);
    }

    /**
     * 合并同一requestId的多条流水记录,取最终状态
     * 保留最后一条记录的状态（completed/failed），但使用第一条记录的时间戳（请求开始时间）
     * @param logs 流水记录列表
     * @returns 按requestId合并后的记录Map
     */
    static mergeLogsByRequestId(logs: TokenRequestLog[]): Map<string, TokenRequestLog> {
        const mergedMap = new Map<string, TokenRequestLog>();

        for (const log of logs) {
            const existing = mergedMap.get(log.requestId);

            if (!existing) {
                // 第一次遇到此requestId，记录初始时间戳
                mergedMap.set(log.requestId, { ...log });
            } else {
                // 已存在，保留时间戳更早的（请求开始时间），但更新其他字段为最新状态
                if (log.timestamp < existing.timestamp) {
                    // 当前记录时间戳更早，更新时间戳但保留其他字段
                    existing.timestamp = log.timestamp;
                    existing.isoTime = log.isoTime;
                }
                // 无论时间戳如何，都更新为最新状态（completed/failed 和 rawUsage）
                existing.status = log.status;
                existing.rawUsage = log.rawUsage;
                // 更新流时间信息
                if (log.streamStartTime !== undefined) {
                    existing.streamStartTime = log.streamStartTime;
                }
                if (log.streamEndTime !== undefined) {
                    existing.streamEndTime = log.streamEndTime;
                } else {
                    // 旧数据兼容：历史记录可能只有最终状态更新而未单独记录 streamEndTime。
                    // 此处用该条流水记录时间作为结束时间兜底，避免历史数据在耗时/速度统计中完全缺失。
                    existing.streamEndTime = log.timestamp;
                }
            }
        }

        return mergedMap;
    }

    /**
     * 聚合日志为统计数据
     * 1. 先按requestId合并流水记录,取最终状态
     * 2. 只统计成功(completed)的请求
     * 3. 从 rawUsage 解析 token 统计
     */
    static aggregateLogs(logs: TokenRequestLog[]): TokenUsageStatsFromFile {
        const stats: TokenUsageStatsFromFile = {
            total: {
                estimatedInput: 0,
                actualInput: 0,
                cacheTokens: 0,
                outputTokens: 0,
                requests: 0,
                completedRequests: 0,
                failedRequests: 0,
                firstTokenLatency: 0,
                outputSpeeds: 0
            },
            providers: {}
        };

        // 仅收集“模型级别”的请求速度；提供商/总计速度只对模型每小时速度做算术平均。
        const modelSpeedValues: Record<string, Record<string, number[]>> = {};
        // 首 Token 延迟不做置信处理：模型/提供商/总计均为算术平均。
        const modelFirstTokenLatencyAcc: Record<string, Record<string, { sum: number; count: number }>> = {};

        // 1. 按requestId合并,取最终状态
        const mergedMap = this.mergeLogsByRequestId(logs);
        const finalLogs = Array.from(mergedMap.values());

        // 2. 遍历合并后的日志
        for (const log of finalLogs) {
            // 统计所有请求的状态到总计
            stats.total.requests++;

            if (log.status === 'completed') {
                stats.total.completedRequests++;
            } else if (log.status === 'failed') {
                stats.total.failedRequests++;
            }

            // 初始化提供商统计（确保所有提供商都被记录，即使请求失败）
            if (!stats.providers[log.providerKey]) {
                stats.providers[log.providerKey] = {
                    providerName: log.providerName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    completedRequests: 0,
                    failedRequests: 0,
                    firstTokenLatency: 0,
                    outputSpeeds: 0,
                    models: {}
                };
            }

            const providerStats = stats.providers[log.providerKey];
            providerStats.requests++;

            if (log.status === 'completed') {
                providerStats.completedRequests++;
            } else if (log.status === 'failed') {
                providerStats.failedRequests++;
            }

            // 只统计成功的请求到 token 用量和速度
            if (log.status !== 'completed' || !log.rawUsage) {
                // 如果没有 rawUsage，使用预估的 input
                if (log.status === 'completed') {
                    stats.total.estimatedInput += log.estimatedInput;
                    stats.total.actualInput += log.estimatedInput;
                    providerStats.estimatedInput += log.estimatedInput;
                    providerStats.actualInput += log.estimatedInput;
                }
                continue;
            }

            // 从 rawUsage 解析 token 统计
            const parsed = UsageParser.parseFromLog(log);

            // 更新总计(仅成功的请求)
            stats.total.estimatedInput += log.estimatedInput;
            stats.total.actualInput += parsed.actualInput;
            stats.total.cacheTokens += parsed.cacheReadTokens;
            stats.total.outputTokens += parsed.outputTokens;

            // 更新提供商的 token 统计
            providerStats.estimatedInput += log.estimatedInput;
            providerStats.actualInput += parsed.actualInput;
            providerStats.cacheTokens += parsed.cacheReadTokens;
            providerStats.outputTokens += parsed.outputTokens;

            // 按模型聚合(仅成功的请求)
            if (!providerStats.models[log.modelId]) {
                providerStats.models[log.modelId] = {
                    modelName: log.modelName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    firstTokenLatency: 0,
                    outputSpeeds: 0
                };
            }

            const modelStats = providerStats.models[log.modelId];
            modelStats.estimatedInput += log.estimatedInput;
            modelStats.actualInput += parsed.actualInput;
            modelStats.cacheTokens += parsed.cacheReadTokens;
            modelStats.outputTokens += parsed.outputTokens;
            modelStats.requests++;

            // 速度样本仅收集到“模型”维度。
            if (parsed.outputSpeed && parsed.outputSpeed > 0) {
                if (!modelSpeedValues[log.providerKey]) {
                    modelSpeedValues[log.providerKey] = {};
                }
                if (!modelSpeedValues[log.providerKey][log.modelId]) {
                    modelSpeedValues[log.providerKey][log.modelId] = [];
                }
                modelSpeedValues[log.providerKey][log.modelId].push(parsed.outputSpeed);
            }

            // 首 Token 延迟样本同样仅收集到“模型”维度（不做置信处理）。
            if (log.streamStartTime !== undefined && log.timestamp !== undefined) {
                const firstTokenLatency = log.streamStartTime - log.timestamp;
                if (Number.isFinite(firstTokenLatency) && firstTokenLatency >= 0) {
                    if (!modelFirstTokenLatencyAcc[log.providerKey]) {
                        modelFirstTokenLatencyAcc[log.providerKey] = {};
                    }
                    if (!modelFirstTokenLatencyAcc[log.providerKey][log.modelId]) {
                        modelFirstTokenLatencyAcc[log.providerKey][log.modelId] = { sum: 0, count: 0 };
                    }
                    modelFirstTokenLatencyAcc[log.providerKey][log.modelId].sum += firstTokenLatency;
                    modelFirstTokenLatencyAcc[log.providerKey][log.modelId].count += 1;
                }
            }
        }

        // 仅计算并写入“模型级别”的聚合值；provider/total 的聚合由上层在 hourly 缓存完成后统一计算。
        for (const [providerKey, providerStats] of Object.entries(stats.providers)) {
            for (const [modelId, modelStats] of Object.entries(providerStats.models)) {
                const speedValues = modelSpeedValues[providerKey]?.[modelId] || [];
                modelStats.outputSpeeds = this.calculateRobustMean(speedValues);

                const acc = modelFirstTokenLatencyAcc[providerKey]?.[modelId];
                modelStats.firstTokenLatency = acc && acc.count > 0 ? acc.sum / acc.count : 0;
            }
        }

        return stats;
    }
}
