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
                failedRequests: 0
            },
            providers: {}
        };

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

            // 累加流耗时信息用于计算平均输出速度（只统计有完整时间记录的）
            // 累加首Token延迟信息用于计算平均首Token延迟（只统计有完整时间记录的）
            if (parsed.streamDuration && parsed.streamDuration > 0) {
                stats.total.totalStreamDuration = (stats.total.totalStreamDuration || 0) + parsed.streamDuration;
                stats.total.validStreamRequests = (stats.total.validStreamRequests || 0) + 1;
                stats.total.validStreamOutputTokens = (stats.total.validStreamOutputTokens || 0) + parsed.outputTokens;

                if (log.streamStartTime !== undefined && log.timestamp !== undefined) {
                    const firstTokenLatency = log.streamStartTime - log.timestamp;
                    if (Number.isFinite(firstTokenLatency) && firstTokenLatency >= 0) {
                        stats.total.totalFirstTokenLatency =
                            (stats.total.totalFirstTokenLatency || 0) + firstTokenLatency;
                    }
                }
            }

            // 更新提供商的 token 统计
            providerStats.estimatedInput += log.estimatedInput;
            providerStats.actualInput += parsed.actualInput;
            providerStats.cacheTokens += parsed.cacheReadTokens;
            providerStats.outputTokens += parsed.outputTokens;

            // 累加提供商级别的流耗时信息（只统计有完整时间记录的）
            // 累加提供商级别的首Token延迟信息（只统计有完整时间记录的）
            if (parsed.streamDuration && parsed.streamDuration > 0) {
                providerStats.totalStreamDuration = (providerStats.totalStreamDuration || 0) + parsed.streamDuration;
                providerStats.validStreamRequests = (providerStats.validStreamRequests || 0) + 1;
                providerStats.validStreamOutputTokens =
                    (providerStats.validStreamOutputTokens || 0) + parsed.outputTokens;

                if (log.streamStartTime !== undefined && log.timestamp !== undefined) {
                    const firstTokenLatency = log.streamStartTime - log.timestamp;
                    if (Number.isFinite(firstTokenLatency) && firstTokenLatency >= 0) {
                        providerStats.totalFirstTokenLatency =
                            (providerStats.totalFirstTokenLatency || 0) + firstTokenLatency;
                    }
                }
            }

            // 按模型聚合(仅成功的请求)
            if (!providerStats.models[log.modelId]) {
                providerStats.models[log.modelId] = {
                    modelName: log.modelName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0
                };
            }

            const modelStats = providerStats.models[log.modelId];
            modelStats.estimatedInput += log.estimatedInput;
            modelStats.actualInput += parsed.actualInput;
            modelStats.cacheTokens += parsed.cacheReadTokens;
            modelStats.outputTokens += parsed.outputTokens;
            modelStats.requests++;

            // 累加模型级别的流耗时信息（只统计有完整时间记录的）
            // 累加模型级别的首Token延迟信息（只统计有完整时间记录的）
            if (parsed.streamDuration && parsed.streamDuration > 0) {
                modelStats.totalStreamDuration = (modelStats.totalStreamDuration || 0) + parsed.streamDuration;
                modelStats.validStreamRequests = (modelStats.validStreamRequests || 0) + 1;
                modelStats.validStreamOutputTokens = (modelStats.validStreamOutputTokens || 0) + parsed.outputTokens;

                if (log.streamStartTime !== undefined && log.timestamp !== undefined) {
                    const firstTokenLatency = log.streamStartTime - log.timestamp;
                    if (Number.isFinite(firstTokenLatency) && firstTokenLatency >= 0) {
                        modelStats.totalFirstTokenLatency =
                            (modelStats.totalFirstTokenLatency || 0) + firstTokenLatency;
                    }
                }
            }
        }

        return stats;
    }
}
