/**
 * UsagesView 工具函数
 */

import {
    createEmptyNativeCostSplit,
    getLogNativeCostSplit,
    hasNativeCostSplit,
    mergeNativeCostSplit
} from '../../usages/fileLogger/nativeCostSplit';
import { convertUsdToRmb, sumCosts, USD_TO_RMB_RATE } from '../../utils/pricingCurrency';
import type { BaseStats, HourlyStats, NativeCostSplit } from '../../usages/fileLogger/types';
import type {
    ExtendedTokenRequestLog,
    NativeCostSplitIndex,
    RequestTotals,
    SessionGroup,
    SessionSummary,
    WebViewMessage
} from './types';
import { REQUEST_KIND_DISPLAY_NAMES } from '../../handlers/requestKindDisplayNames';
import type { DisplayCurrency } from '../costDisplay';

// 复用共享工具函数
export { formatTokens, formatCost } from '../utils';

export const UNKNOWN_SESSION_ID = 'unknown';

export type { NativeCostSplit } from '../../usages/fileLogger/types';

export function getRecordNativeCostSplit(record: ExtendedTokenRequestLog): NativeCostSplit | undefined {
    return getLogNativeCostSplit(record);
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

export function getStatsNativeCostSplit(stats: BaseStats | undefined, fallback?: NativeCostSplit): NativeCostSplit {
    return fallback ?? stats?.nativeCosts ?? createEmptyNativeCostSplit();
}

export function sortRecordsByTimestampDesc(records: ExtendedTokenRequestLog[]): ExtendedTokenRequestLog[] {
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
}

function isChineseLocale(): boolean {
    const lang = (globalThis.document?.documentElement?.lang || globalThis.navigator?.language || '').toLowerCase();
    return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
}

export function getDefaultDisplayCurrency(): DisplayCurrency {
    return isChineseLocale() ? 'MIXED' : 'USD';
}

export function getDisplayCurrency(): DisplayCurrency {
    return window.usagesState?.displayCurrency ?? getDefaultDisplayCurrency();
}

function hasExactRmbPricing(totals?: Pick<RequestTotals, 'rmbExactRequests'> | null): boolean {
    if ((totals?.rmbExactRequests ?? 0) > 0) {
        return true;
    }

    return (globalThis.window?.usagesState?.dateDetails?.allTotals.rmbExactRequests ?? 0) > 0;
}

export function normalizeDisplayCurrency(
    currentCurrency: DisplayCurrency,
    totals?: Pick<RequestTotals, 'rmbExactRequests'> | null
): DisplayCurrency {
    if (!isChineseLocale()) {
        return currentCurrency === 'MIXED' ? 'USD' : currentCurrency;
    }

    if (currentCurrency === 'MIXED' && !hasExactRmbPricing(totals)) {
        return 'USD';
    }

    return currentCurrency;
}

export function getNextDisplayCurrency(currentCurrency: DisplayCurrency): DisplayCurrency {
    const normalizedCurrency = normalizeDisplayCurrency(currentCurrency);

    if (!isChineseLocale()) {
        return normalizedCurrency === 'USD' ? 'RMB' : 'USD';
    }

    if (!hasExactRmbPricing()) {
        return normalizedCurrency === 'USD' ? 'RMB' : 'USD';
    }

    if (normalizedCurrency === 'MIXED') {
        return 'USD';
    }
    if (normalizedCurrency === 'USD') {
        return 'RMB';
    }
    return 'MIXED';
}

function getCurrencyModeLabel(currency: DisplayCurrency): string {
    if (currency === 'MIXED') {
        return t('split currency view', '分币种显示');
    }
    if (currency === 'RMB') {
        return t('RMB view', '统一人民币显示');
    }
    return t('USD view', '统一美元显示');
}

export function getCurrencyToggleTitle(currentCurrency: DisplayCurrency): string {
    const normalizedCurrency = normalizeDisplayCurrency(currentCurrency);
    const nextCurrency = getNextDisplayCurrency(currentCurrency);
    return t(
        'Current: {0}. Click to switch to {1}.',
        '当前：{0}。点击切换到{1}。',
        getCurrencyModeLabel(normalizedCurrency),
        getCurrencyModeLabel(nextCurrency)
    );
}

/**
 * 构造请求成本的明细 tooltip 文本：命中档位 + 单价 + 各分项计算过程 + 合计。
 * 无 costBreakdown 时返回 undefined（调用方回退到币种切换提示）。
 *
 * 币种口径：
 * - 优先币种：MIXED 按界面语言（中文 RMB、英文 USD），RMB 视图优先 RMB，USD 视图优先 USD。
 * - 过程与合计同币种：优先币种有原生定价时全程原生；无原生定价时过程用对方币种原生数据，
 *   合计追加汇率换算（USD 合计 ×7 = ¥ / RMB 合计 ÷7 = $）。
 * - MIXED 视图合计不换算：有原生 RMB 全程 ¥，无则全程 $。
 */
export function buildCostBreakdownTitle(
    breakdown: ExtendedTokenRequestLog['costBreakdown'] | undefined,
    currency: DisplayCurrency
): string | undefined {
    if (!breakdown) {
        return undefined;
    }

    const usdData = breakdown.currencies?.USD;
    const rmbData = breakdown.currencies?.RMB;
    const preferRmb =
        currency === 'RMB' ? true
        : currency === 'USD' ? false
        : isChineseLocale();
    const nativeCurrencies = breakdown.nativeCurrencies;
    // 旧日志没有 nativeCurrencies 时按 currencies 推断；新日志仅记录原生币种
    const hasNativeUsd = nativeCurrencies ? nativeCurrencies.includes('USD') : usdData !== undefined;
    const hasNativeRmb = nativeCurrencies ? nativeCurrencies.includes('RMB') : rmbData !== undefined;
    // 双币模型按优先币种；单币模型用其原生币种
    const processIsRmb = hasNativeRmb && (preferRmb || !hasNativeUsd);
    // MIXED 合计不换算；RMB/USD 视图仅当过程币种与优先币种不同（单币模型）时换算
    const needConvert = currency !== 'MIXED' && processIsRmb !== preferRmb;

    const active = processIsRmb ? rmbData : usdData;
    const pricing = active?.pricing ?? breakdown.pricing;
    const costs = active?.cost ?? breakdown.cost;
    const nativeTotal = active?.total ?? breakdown.total;
    const symbol = processIsRmb ? '¥' : '$';

    const [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens] = breakdown.tokens;
    const [inputPrice, outputPrice, cacheReadPrice, cacheWritePrice] = pricing;
    const [inputCost = 0, outputCost = 0, cacheReadCost = 0, cacheWriteCost = 0] = costs;

    const fmtPrice = (v: number): string => `${symbol}${v}`;
    const fmtCost = (v: number): string => `${symbol}${v.toFixed(6)}`;

    const lines: string[] = [];
    lines.push(
        breakdown.activeTier ?
            t('Tier: {0}', '档位：{0}', breakdown.activeTier)
        :   t('Tier: static (no tier matched)', '档位：静态单档（无 tier 命中）')
    );

    const priceParts = [`in ${fmtPrice(inputPrice)}`, `out ${fmtPrice(outputPrice)}`];
    if (cacheReadPrice !== undefined) {
        priceParts.push(`cacheRead ${fmtPrice(cacheReadPrice)}`);
    }
    if (cacheWritePrice !== undefined) {
        priceParts.push(`cacheWrite ${fmtPrice(cacheWritePrice)}`);
    }
    lines.push(t('Pricing: {0} / 1M tokens', '单价：{0} / 1M tokens', priceParts.join(' · ')));

    lines.push(
        t(
            'Billing: input {0} × {1}/1M = {2}',
            '计费：input {0} × {1}/1M = {2}',
            inputTokens.toLocaleString('en-US'),
            fmtPrice(inputPrice),
            fmtCost(inputCost)
        )
    );
    lines.push(
        t(
            '           output {0} × {1}/1M = {2}',
            '           output {0} × {1}/1M = {2}',
            outputTokens.toLocaleString('en-US'),
            fmtPrice(outputPrice),
            fmtCost(outputCost)
        )
    );
    if (cacheReadTokens > 0 && cacheReadPrice !== undefined) {
        lines.push(
            t(
                '           cacheRead {0} × {1}/1M = {2}',
                '           cacheRead {0} × {1}/1M = {2}',
                cacheReadTokens.toLocaleString('en-US'),
                fmtPrice(cacheReadPrice),
                fmtCost(cacheReadCost)
            )
        );
    }
    if (cacheWriteTokens > 0 && cacheWritePrice !== undefined) {
        lines.push(
            t(
                '           cacheWrite {0} × {1}/1M = {2}',
                '           cacheWrite {0} × {1}/1M = {2}',
                cacheWriteTokens.toLocaleString('en-US'),
                fmtPrice(cacheWritePrice),
                fmtCost(cacheWriteCost)
            )
        );
    }

    if (needConvert) {
        const convertedTotal = preferRmb ? nativeTotal * USD_TO_RMB_RATE : nativeTotal / USD_TO_RMB_RATE;
        const targetSymbol = preferRmb ? '¥' : '$';
        const rateExpr = preferRmb ? `× ${USD_TO_RMB_RATE}` : `÷ ${USD_TO_RMB_RATE}`;
        lines.push(
            t(
                'Total: {0} {1} = {2}',
                '合计：{0} {1} = {2}',
                fmtCost(nativeTotal),
                rateExpr,
                `${targetSymbol}${convertedTotal.toFixed(6)}`
            )
        );
    } else {
        lines.push(t('Total: {0}', '合计：{0}', fmtCost(nativeTotal)));
    }
    return lines.join('\n');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 判断字符串是否为标准 UUID
 */
function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/**
 * 将时间戳格式化为时分秒文本
 */
function formatClockTime(timestamp?: number): string {
    if (!timestamp) {
        return '-';
    }

    try {
        return new Date(timestamp).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch {
        return '-';
    }
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
 */
export function summarizeSessionRecords(records: ExtendedTokenRequestLog[]): SessionSummary {
    const timestamps = records
        .map(record => record.timestamp)
        .filter((timestamp): timestamp is number => Number.isFinite(timestamp));
    const speedRecords = records.filter(record => (record.outputSpeed || 0) > 0);

    return {
        requestCount: records.length,
        totalTokens: records.reduce((sum, record) => sum + getRecordTotalTokens(record), 0),
        startTime: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
        endTime: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
        completedCount: records.filter(record => record.status === 'completed').length,
        failedCount: records.filter(record => record.status === 'failed').length,
        cancelledCount: records.filter(record => record.status === 'cancelled').length,
        avgSpeed: speedRecords.length > 0 ? meanWithoutOutliers(speedRecords.map(r => r.outputSpeed!)) : undefined
    };
}

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

    records.forEach(record => {
        const hasActualUsage =
            (record.status === 'completed' || record.status === 'cancelled') &&
            !!record.rawUsage &&
            record.totalTokens > 0;
        inputTokens += hasActualUsage ? Math.max(record.actualInput || 0, 0) : Math.max(record.estimatedInput || 0, 0);
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

/**
 * 根据当前语言返回文案，并按 {0}、{1} 占位符依次替换参数
 */
export function t(en: string, zh: string, ...args: Array<string | number>): string {
    let result = isChineseLocale() ? zh : en;

    args.forEach((arg, index) => {
        const value = typeof arg === 'number' ? String(arg) : arg;
        result = result.replace(`{${index}}`, value);
    });

    return result;
}

/**
 * 判断记录是否具备可用于识别对话会话的 OTel Trace 上下文
 */
function hasConversationTraceContext(record: Pick<ExtendedTokenRequestLog, 'otelTraceContext'>): boolean {
    return Boolean(record.otelTraceContext?.traceId && record.otelTraceContext?.spanId);
}

/**
 * 仅当记录包含 otelTraceContext 时，才将原始 sessionId 归一化为统一可分组的值
 */
export function normalizeSessionId(record: Pick<ExtendedTokenRequestLog, 'sessionId' | 'otelTraceContext'>): string {
    if (!hasConversationTraceContext(record)) {
        return UNKNOWN_SESSION_ID;
    }

    const value = record.sessionId?.trim();
    if (!value) {
        return UNKNOWN_SESSION_ID;
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
 * 格式化会话的起止时间范围
 */
export function formatSessionTimeRange(startTime?: number, endTime?: number): string {
    if (!startTime && !endTime) {
        return '-';
    }

    const start = formatClockTime(startTime || endTime);
    const end = formatClockTime(endTime || startTime);
    return start === end ? start : `${start} - ${end}`;
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
                records: sortedRecords,
                summary: summarizeSessionRecords(sortedRecords),
                totals: buildRequestTotals(sortedRecords)
            };
        })
        .sort((a, b) => (b.summary.endTime || 0) - (a.summary.endTime || 0));
}

/**
 * 获取提供商显示名称（处理特殊情况）
 * 例如：providerKey 为 "kimi" 时，显示名称应为 "Kimi"
 * @param providerKey - 提供商唯一标识
 * @param providerName - 原始提供商名称
 * @returns 显示名称
 */
export function getProviderDisplayName(providerKey: string, providerName: string): string {
    // 特殊处理：kimi 显示为 Kimi
    if (providerKey === 'kimi') {
        return 'Kimi';
    }
    return providerName;
}

/**
 * 获取请求来源的友好显示名称（自动按语言切换中英文）
 *
 * 注：名称映射表与 RequestKind 类型定义集中维护在
 * `src/handlers/requestClassifier.ts`，避免扩展进程与 WebView 两侧重复。
 * WebView 侧通过 esbuild 将该依赖打包到前端 bundle 中。
 */
export function getRequestKindDisplayName(kind?: string): string {
    if (!kind) {
        return '-';
    }
    // 使用集中定义的名称映射表，确保与扩展侧一致
    const names = REQUEST_KIND_DISPLAY_NAMES[kind];
    if (!names) {
        return kind;
    }
    return isChineseLocale() ? names[1] : names[0];
}

/**
 * 计算总 Token 数
 */
export function calculateTotalTokens(stats: BaseStats): number {
    return stats.actualInput + stats.outputTokens;
}

/**
 * 计算平均输出速度
 * 优先使用 outputSpeeds（已聚合后的平均速度，写入缓存）
 */
export function calculateAverageSpeed(stats: BaseStats | HourlyStats): string {
    if (stats.outputSpeeds && stats.outputSpeeds > 0) {
        return `${stats.outputSpeeds.toFixed(1)} t/s`;
    }
    return '-';
}

/**
 * 计算平均首Token延迟
 */
export function calculateAverageFirstTokenLatency(stats: BaseStats): string {
    if (!stats.firstTokenLatency || stats.firstTokenLatency <= 0) {
        return '-';
    }
    const avgLatency = stats.firstTokenLatency;
    if (avgLatency >= 1000) {
        return `${(avgLatency / 1000).toFixed(1)} s`;
    }
    return `${Math.round(avgLatency)} ms`;
}

/**
 * 获取今日日期字符串
 */
export function getTodayDateString(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * 向 VSCode 发送消息
 */
export function postToVSCode(message: WebViewMessage): void {
    try {
        if ('vscode' in window) {
            const vscode = window.vscode as unknown as { postMessage(message: WebViewMessage): void };
            if (vscode && typeof vscode.postMessage === 'function') {
                vscode.postMessage(message);
            }
        }
    } catch (error) {
        console.error('Failed to post message to VS Code:', error);
    }
}
