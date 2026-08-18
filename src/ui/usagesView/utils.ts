/**
 * UsagesView 工具函数
 * 纯聚合计算已下沉到 ./aggregation（扩展侧与 WebView 共享），此处保留展示层函数并 re-export。
 */

import { createEmptyNativeCostSplit } from '../../usages/fileLogger/nativeCostSplit';
import { USD_TO_RMB_RATE } from '../../utils/pricing/pricingCurrency';
import type { BaseStats, HourlyStats, NativeCostSplit } from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog, LiveRequestUiState, RequestTotals, WebViewMessage } from './types';
import { REQUEST_KIND_DISPLAY_NAMES } from '../../handlers/requestKindDisplayNames';
import type { DisplayCurrency } from '../costDisplay';

// 复用共享工具函数
export { formatTokens, formatCost } from '../utils';

// 纯聚合模块 re-export（聚合实现见 ./aggregation，供扩展侧与 WebView 共用）
export {
    buildNativeCostSplitIndex,
    buildRequestTotals,
    buildSessionGroupSummaries,
    filterRecordsBySession,
    getRecordNativeCostSplit,
    getSessionDisplayId,
    groupRecordsBySession,
    meanWithoutOutliers,
    normalizeSessionId,
    sliceRecordsPage,
    sortRecordsByTimestampDesc,
    summarizeSessionRecoveryDebugInfo,
    summarizeSessionRecords,
    UNKNOWN_SESSION_ID
} from './aggregation';
export type { RecordsPageSlice, SessionRecoveryDebugSummary } from './aggregation';

export type { NativeCostSplit } from '../../usages/fileLogger/types';

export function getStatsNativeCostSplit(stats: BaseStats | undefined, fallback?: NativeCostSplit): NativeCostSplit {
    return fallback ?? stats?.nativeCosts ?? createEmptyNativeCostSplit();
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

export function getLiveWaitingPresentation(liveState: LiveRequestUiState | undefined): {
    isWaiting: boolean;
    waitTitle: string;
    statusText: string;
    statusTitle: string;
    queuePositionText: string;
    queuePositionTitle: string;
} {
    const isWaiting = liveState?.isRateLimitWaiting === true;
    const hasQueuePosition = (liveState?.queuePosition ?? 0) > 0;
    // 无队列号的等待：已获并发槽位（或直调放行），正在等 GCRA pacing 令牌到点，状态列与排队阶段区分
    const pacingTitle = t(
        'Concurrency slot granted; waiting for the rate limit pacing window',
        '已获得并发槽位，等待限流令牌到点'
    );

    let statusTitle = '';
    if (isWaiting) {
        if (liveState.waitScope === 'leader') {
            statusTitle = t('Waiting for leader rate limit', '等待 Leader 限流放行');
        } else if (liveState.waitScope === 'local') {
            statusTitle = t('Waiting for local rate limit', '等待本地限流放行');
        } else if (liveState.waitScope === 'ipc') {
            statusTitle = t('Waiting for remote rate limit', '等待远端限流放行');
        } else {
            statusTitle = t('Waiting for rate limit', '等待限流放行');
        }
    }

    return {
        isWaiting,
        waitTitle:
            !isWaiting ? ''
            : hasQueuePosition ? t('Waiting for rate limit grant', '等待限流放行中')
            : pacingTitle,
        statusText:
            !isWaiting ? ''
            : hasQueuePosition ? 'WAIT'
            : 'PACE',
        statusTitle,
        queuePositionText: isWaiting && hasQueuePosition ? `#${liveState.queuePosition}` : '-',
        queuePositionTitle:
            !isWaiting ? ''
            : hasQueuePosition ? t('Current FIFO queue position', '当前 FIFO 排队顺位')
            : pacingTitle
    };
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
