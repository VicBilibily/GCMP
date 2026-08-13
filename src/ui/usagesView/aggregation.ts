/*---------------------------------------------------------------------------------------------
 *  UsagesView 纯聚合模块（扩展侧与 WebView 共享）
 *  只允许依赖 node 内置 + 纯逻辑模块；禁止 vscode / window / document / locale 依赖。
 *  聚合函数由扩展侧执行，摘要结果经 postMessage 推送 WebView。
 *--------------------------------------------------------------------------------------------*/

import {
    createEmptyNativeCostSplit,
    getLogNativeCostSplit,
    hasNativeCostSplit,
    mergeNativeCostSplit
} from '../../usages/fileLogger/nativeCostSplit';
import { convertUsdToRmb, sumCosts } from '../../utils/pricing/pricingCurrency';
import type { NativeCostSplit } from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog } from '../../usages/fileLogger/usageParser';
import type {
    NativeCostSplitIndex,
    RequestTotals,
    SessionGroup,
    SessionGroupSummary,
    SessionRecoveryDebugSummary,
    SessionSummary
} from './types';

export const UNKNOWN_SESSION_ID = 'unknown';

export type { NativeCostSplit } from '../../usages/fileLogger/types';
export type { SessionRecoveryDebugSummary } from './types';

export function getRecordNativeCostSplit(record: ExtendedTokenRequestLog): NativeCostSplit | undefined {
    return getLogNativeCostSplit(record);
}

export function sortRecordsByTimestampDesc(records: ExtendedTokenRequestLog[]): ExtendedTokenRequestLog[] {
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * 获取单条记录用于汇总的 Token 数，优先实际值，缺失时退回预估值
 */
function getRecordTotalTokens(record: ExtendedTokenRequestLog): number {
    if (record.totalTokens > 0) {
        return record.totalTokens;
    }

    return Math.max(record.estimatedInput || 0, 0);
}

/**
 * 基于中位数偏离度的加权均值（鲁棒统计量）。
 *
 * 算法：
 * 1. 计算中位数作为中心估计
 * 2. 计算 MAD（Median Absolute Deviation）作为鲁棒尺度
 * 3. 每个值根据其偏离中位数的程度赋予权重：w = exp(-k * ((x - median) / MAD)^2)
 *    - 当前 k = 2 时，偏离 1 MAD 的权重 ≈ 0.135，偏离 2 MAD 的权重 ≈ 0.0003
 * 4. 返回加权均值
 *
 * 相比 IQR 硬截断，该方法：
 * - 不完全丢弃异常值，而是根据偏离程度平滑降权
 * - 对小样本（≥2）同样有效，无需硬性阈值
 * - MAD 比标准差对异常值更鲁棒
 */
export function meanWithoutOutliers(values: number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    if (values.length === 1) {
        return values[0];
    }

    const sorted = [...values].sort((a, b) => a - b);

    // 中位数
    const mid = (sorted.length - 1) / 2;
    const lo = Math.floor(mid);
    const median = sorted[lo] + (sorted[lo + 1] - sorted[lo]) * (mid - lo);

    // MAD = median(|x - median|)
    const absDevs = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const madMid = (absDevs.length - 1) / 2;
    const madLo = Math.floor(madMid);
    const mad = absDevs[madLo] + (absDevs[madLo + 1] - absDevs[madLo]) * (madMid - madLo);

    // MAD 退化为 0 时，说明至少半数样本与中位数重合。
    // 此时返回中位数，避免“多数正常值 + 少数极端异常值”退回算术均值。
    if (mad < 1e-10) {
        return median;
    }

    // 高斯权重：当前 K = 2，偏离 2 MAD 时权重约为 0.0003
    const K = 2;
    let totalWeight = 0;
    let weightedSum = 0;
    for (const v of values) {
        const w = Math.exp(-K * ((v - median) / mad) ** 2);
        totalWeight += w;
        weightedSum += w * v;
    }
    return weightedSum / totalWeight;
}

/**
 * 汇总一组会话记录，生成展示所需的统计信息
 *
 * 注意：token 与速度等"统计字段"仅基于 status === 'completed' 的记录聚合；
 * 未完成（estimated）、取消（cancelled）、失败（failed）的请求不参与统计。
 * requestCount、各状态计数、时间范围等元信息字段仍覆盖全部记录。
 *
 * 单次遍历完成全部聚合，避免每次刷新时对记录做多次 filter/reduce 扫描。
 */
export function summarizeSessionRecords(records: ExtendedTokenRequestLog[]): SessionSummary {
    let completedCount = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    // 底部统计口径：仅 completed 请求参与 token/速度聚合
    let totalTokens = 0;
    let startTime: number | undefined;
    let endTime: number | undefined;
    const speeds: number[] = [];

    for (const record of records) {
        if (Number.isFinite(record.timestamp)) {
            startTime = startTime === undefined ? record.timestamp : Math.min(startTime, record.timestamp);
            endTime = endTime === undefined ? record.timestamp : Math.max(endTime, record.timestamp);
        }

        if (record.status === 'completed') {
            completedCount += 1;
            totalTokens += getRecordTotalTokens(record);
            if ((record.outputSpeed || 0) > 0) {
                speeds.push(record.outputSpeed!);
            }
        } else if (record.status === 'failed') {
            failedCount += 1;
        } else if (record.status === 'cancelled') {
            cancelledCount += 1;
        }
    }

    return {
        requestCount: records.length,
        totalTokens,
        startTime,
        endTime,
        completedCount,
        failedCount,
        cancelledCount,
        avgSpeed: speeds.length > 0 ? meanWithoutOutliers(speeds) : undefined
    };
}

export function summarizeSessionRecoveryDebugInfo(
    records: Array<Pick<ExtendedTokenRequestLog, 'sessionRecoverySource'>>
): SessionRecoveryDebugSummary {
    let bridgeCount = 0;
    let newUuidCount = 0;

    for (const record of records) {
        if (
            record.sessionRecoverySource === 'trace-bridge' ||
            record.sessionRecoverySource === 'turn-bridge' ||
            record.sessionRecoverySource?.startsWith('summary-bridge-')
        ) {
            bridgeCount += 1;
        } else if (record.sessionRecoverySource === 'new-uuid') {
            newUuidCount += 1;
        }
    }

    return {
        bridgeCount,
        newUuidCount
    };
}

/**
 * 底部统计口径：仅 status === 'completed' 的请求参与 token/成本/延迟/耗时聚合；
 * 未完成（estimated）、取消（cancelled）、失败（failed）的请求不参与统计。
 */
export function buildRequestTotals(records: ExtendedTokenRequestLog[]): RequestTotals {
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let totalCost = 0;
    let totalCostRmb = 0;
    const nativeCosts = createEmptyNativeCostSplit();
    let costedRequests = 0;
    let rmbExactRequests = 0;
    const latencies: number[] = [];
    const durations: number[] = [];

    records
        .filter(record => record.status === 'completed')
        .forEach(record => {
            const hasActualUsage = !!record.rawUsage && record.totalTokens > 0;
            inputTokens +=
                hasActualUsage ? Math.max(record.actualInput || 0, 0) : Math.max(record.estimatedInput || 0, 0);
            cacheTokens += Math.max(record.cacheReadTokens || 0, 0);
            outputTokens += Math.max(record.outputTokens || 0, 0);

            if (record.estimatedCost !== undefined && record.estimatedCost > 0) {
                const split = getRecordNativeCostSplit(record);
                totalCost = sumCosts([totalCost, record.estimatedCost]);
                totalCostRmb = sumCosts([
                    totalCostRmb,
                    record.costBreakdown?.currencies?.RMB?.total ?? convertUsdToRmb(record.estimatedCost)
                ]);
                if (split) {
                    mergeNativeCostSplit(nativeCosts, split);
                }
                costedRequests += 1;
                if (record.costBreakdown?.currencies?.RMB?.total !== undefined) {
                    rmbExactRequests += 1;
                }
            }

            if (record.streamDuration !== undefined && record.streamDuration > 0) {
                durations.push(record.streamDuration);
            }

            if (record.streamStartTime !== undefined && record.timestamp !== undefined) {
                const latency = record.streamStartTime - record.timestamp;
                if (Number.isFinite(latency) && latency >= 0) {
                    latencies.push(latency);
                }
            }
        });

    return {
        inputTokens,
        cacheTokens,
        outputTokens,
        avgLatency: meanWithoutOutliers(latencies),
        avgDuration: meanWithoutOutliers(durations),
        totalCost,
        totalCostRmb,
        nativeCosts,
        costedRequests,
        rmbExactRequests
    };
}

export function buildNativeCostSplitIndex(records: ExtendedTokenRequestLog[]): NativeCostSplitIndex {
    const index: NativeCostSplitIndex = {
        total: createEmptyNativeCostSplit(),
        providers: {},
        models: {},
        hours: {},
        hourProviders: {},
        hourModels: {}
    };

    records.forEach(record => {
        const split = getRecordNativeCostSplit(record);
        if (!hasNativeCostSplit(split)) {
            return;
        }

        mergeNativeCostSplit(index.total, split);

        const providerKey = record.providerKey;
        index.providers[providerKey] ??= createEmptyNativeCostSplit();
        mergeNativeCostSplit(index.providers[providerKey], split);

        index.models[providerKey] ??= {};
        index.models[providerKey][record.modelId] ??= createEmptyNativeCostSplit();
        mergeNativeCostSplit(index.models[providerKey][record.modelId], split);

        const hourKey = String(new Date(record.timestamp).getHours()).padStart(2, '0');
        index.hours[hourKey] ??= createEmptyNativeCostSplit();
        mergeNativeCostSplit(index.hours[hourKey], split);

        index.hourProviders[hourKey] ??= {};
        index.hourProviders[hourKey][providerKey] ??= createEmptyNativeCostSplit();
        mergeNativeCostSplit(index.hourProviders[hourKey][providerKey], split);

        index.hourModels[hourKey] ??= {};
        index.hourModels[hourKey][providerKey] ??= {};
        index.hourModels[hourKey][providerKey][record.modelId] ??= createEmptyNativeCostSplit();
        mergeNativeCostSplit(index.hourModels[hourKey][providerKey][record.modelId], split);
    });

    return index;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 判断字符串是否为标准 UUID
 */
function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/**
 * 判断记录是否具备可用于识别对话会话的 OTel Trace 上下文
 */
function hasConversationTraceContext(record: Pick<ExtendedTokenRequestLog, 'otelTraceContext'>): boolean {
    return Boolean(record.otelTraceContext?.traceId && record.otelTraceContext?.spanId);
}

function extractNormalizedSessionId(sessionId: string): string | undefined {
    const value = sessionId.trim();
    if (!value) {
        return undefined;
    }

    if (isUuid(value)) {
        return value.toLowerCase();
    }

    const sessionIndex = value.lastIndexOf('_session_');
    if (sessionIndex !== -1) {
        const extracted = value.slice(sessionIndex + '_session_'.length).trim();
        if (isUuid(extracted)) {
            return extracted.toLowerCase();
        }
    }

    return undefined;
}

/**
 * 仅当记录包含 otelTraceContext 时，才将原始 sessionId 归一化为统一可分组的值。
 */
export function normalizeSessionId(
    record: Pick<ExtendedTokenRequestLog, 'sessionId' | 'otelTraceContext' | 'requestKind' | 'sessionTitle'>
): string {
    const value = record.sessionId?.trim();
    if (!value) {
        return UNKNOWN_SESSION_ID;
    }

    const normalizedSessionId = extractNormalizedSessionId(value);
    if (!normalizedSessionId) {
        return UNKNOWN_SESSION_ID;
    }

    if (hasConversationTraceContext(record)) {
        return normalizedSessionId;
    }

    return UNKNOWN_SESSION_ID;
}

/**
 * 生成会话短展示 ID，规则与 Git short hash 类似
 */
export function getSessionDisplayId(sessionId: string): string {
    if (!sessionId || sessionId === UNKNOWN_SESSION_ID) {
        return UNKNOWN_SESSION_ID;
    }

    return sessionId.slice(0, 7);
}

/**
 * 按归一化后的 sessionId 对请求记录分组，并附带汇总结果
 */
export function groupRecordsBySession(records: ExtendedTokenRequestLog[]): SessionGroup[] {
    const groups = new Map<string, ExtendedTokenRequestLog[]>();

    records.forEach(record => {
        const sessionId = normalizeSessionId(record);
        const sessionRecords = groups.get(sessionId);
        if (sessionRecords) {
            sessionRecords.push(record);
            return;
        }

        groups.set(sessionId, [record]);
    });

    return Array.from(groups.entries())
        .map(([sessionId, sessionRecords]) => {
            const sortedRecords = sortRecordsByTimestampDesc(sessionRecords);
            return {
                sessionId,
                displayId: getSessionDisplayId(sessionId),
                // 记录已按时间倒序排列，取最新一条带标题快照的记录作为会话标题
                title: sortedRecords.find(record => record.sessionTitle)?.sessionTitle,
                records: sortedRecords,
                summary: summarizeSessionRecords(sortedRecords),
                totals: buildRequestTotals(sortedRecords)
            };
        })
        .sort((a, b) => (b.summary.endTime || 0) - (a.summary.endTime || 0));
}

/**
 * 构建不含明细记录的会话分组摘要（传输与 UI 展示用）
 */
export function buildSessionGroupSummaries(records: ExtendedTokenRequestLog[]): SessionGroupSummary[] {
    const groups = new Map<string, ExtendedTokenRequestLog[]>();

    records.forEach(record => {
        const sessionId = normalizeSessionId(record);
        const sessionRecords = groups.get(sessionId);
        if (sessionRecords) {
            sessionRecords.push(record);
            return;
        }

        groups.set(sessionId, [record]);
    });

    return Array.from(groups.entries())
        .map(([sessionId, sessionRecords]) => {
            const sortedRecords = sortRecordsByTimestampDesc(sessionRecords);
            return {
                sessionId,
                displayId: getSessionDisplayId(sessionId),
                // 记录已按时间倒序排列，取最新一条带标题快照的记录作为会话标题
                title: sortedRecords.find(record => record.sessionTitle)?.sessionTitle,
                summary: summarizeSessionRecords(sortedRecords),
                totals: buildRequestTotals(sortedRecords),
                recordCount: sortedRecords.length,
                recoveryDebug: summarizeSessionRecoveryDebugInfo(sortedRecords)
            };
        })
        .sort((a, b) => (b.summary.endTime || 0) - (a.summary.endTime || 0));
}

/**
 * 按与分组一致的归一化口径过滤出指定会话的记录（保持输入顺序）
 */
export function filterRecordsBySession(
    records: ExtendedTokenRequestLog[],
    sessionId: string
): ExtendedTokenRequestLog[] {
    return records.filter(record => normalizeSessionId(record) === sessionId);
}

export interface RecordsPageSlice {
    records: ExtendedTokenRequestLog[];
    totalItems: number;
}

/**
 * 按 1-based 页码切片（输入 records 应为已按时间倒序排列）
 */
export function sliceRecordsPage(records: ExtendedTokenRequestLog[], page: number, pageSize: number): RecordsPageSlice {
    const totalItems = records.length;
    const start = (page - 1) * pageSize;
    return {
        records: records.slice(start, start + pageSize),
        totalItems
    };
}
