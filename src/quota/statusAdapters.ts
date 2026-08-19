/*---------------------------------------------------------------------------------------------
 *  状态栏展示适配器（纯逻辑，无 UI 依赖）
 *  为通用 ProviderQuotaStatusBar 提供 query / summary / tables / 高亮 / 刷新提示。
 *  tables 逐字还原各状态栏重构前的 tooltip 表格（对齐/加粗/倒计时风格均保持原样），
 *  与面板使用的 provider.format 表格是两套独立文案，禁止互相替换。
 *---------------------------------------------------------------------------------------------*/

import { t } from '../utils/runtime/l10n';
import {
    formatCompactCountdown,
    formatCurrency,
    formatDateTimeSlash,
    formatLocaleDateTime,
    formatQuotaDateForSlot
} from './format';
import { resolveQuotaSite } from './common';
import { buildZhipuUsageSummary, fetchZhipuLimits, getZhipuLimitLabel, type ZhipuLimit } from './providers/zhipu';
import { fetchMiniMaxLimits, formatMiniMaxQuotaSummary, type MiniMaxLimit } from './providers/minimax';
import {
    buildKimiUsageSummary,
    fetchKimiUsage,
    formatKimiBoosterCurrency,
    formatKimiCurrencyLimit,
    formatKimiTimeUnit,
    translateKimiBoosterStatus,
    type KimiUsageSnapshot
} from './providers/kimi';
import { fetchDeepSeekBalances, type DeepSeekBalanceInfo } from './providers/deepseek';
import { fetchMoonshotBalance, type MoonshotBalanceInfo } from './providers/moonshot';
import {
    fetchClinePassLimits,
    formatClinePassQuotaSummary,
    getClinePassLimitLabel,
    type ClinePassLimit
} from './providers/clinepass';
import { fetchOpenCodeUsageData, getOpenCodeWindowLabel } from './providers/opencode';
import { buildOpenCodeUsageSummary, type OpenCodeUsageData } from './parsers/opencodeUsage';
import type { QuotaTable } from './types';

/** 状态栏适配器：数据查询与展示决策，UI 渲染在 status 层通用类 */
export interface QuotaStatusAdapter<TRaw> {
    /** 查询状态数据（站点等上下文在此读取） */
    query(apiKey: string): Promise<TRaw>;
    /** 状态栏摘要文本（不含图标） */
    summary(data: TRaw): string;
    /** tooltip 表格（对齐/加粗元数据与重构前一致） */
    tables(data: TRaw): QuotaTable[];
    /** tooltip 补充行（markdown 原样输出） */
    details?(data: TRaw): string[];
    /** 高亮警告判定（缺省不高亮） */
    highlightWarning?(data: TRaw, threshold: number): boolean;
    /** 返回未来重置点时间戳；缓存写入早于重置点且当前已越过时触发刷新 */
    refreshHints?(data: TRaw, cachedAt: number): number[];
}

// ============= Zhipu =============

/** 智谱状态数据（含最近重置时间，刷新判定用） */
export interface ZhipuStatusData {
    limits: ZhipuLimit[];
    nextResetTime?: number;
}

export const zhipuStatusAdapter: QuotaStatusAdapter<ZhipuStatusData> = {
    async query(apiKey) {
        const site = resolveQuotaSite('zhipu', undefined) === 'api.z.ai' ? 'api.z.ai' : undefined;
        const limits = await fetchZhipuLimits(apiKey, site);

        const resetTimes = limits.filter(l => l.nextResetTime !== undefined).map(l => l.nextResetTime as number);
        return { limits, nextResetTime: resetTimes.length > 0 ? Math.min(...resetTimes) : undefined };
    },
    summary: data => buildZhipuUsageSummary(data.limits),
    tables: data => [
        {
            columns: [
                t('Window', '限频类型'),
                t('Quota', '上限值'),
                t('Remaining', '剩余量'),
                t('Reset Time', '重置时间')
            ],
            rows: data.limits.map(limit => [
                limit.type === 'TIME_LIMIT' ?
                    t('MCP Monthly', 'MCP每月')
                :   getZhipuLimitLabel(limit, t('Quota', '限额')),
                limit.type === 'TIME_LIMIT' ? String(limit.usage ?? '-') : '-',
                limit.type === 'TIME_LIMIT' ? String(limit.remaining ?? '-') : `${100 - (limit.percentage ?? 0)}%`,
                limit.nextResetTime ? formatQuotaDateForSlot('zhipu', new Date(limit.nextResetTime)) : '-'
            ]),
            align: ['center', 'right', 'right', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => {
        const percentages = data.limits
            .map(limit => limit.percentage)
            .filter((value): value is number => Number.isFinite(value));
        return percentages.length > 0 && Math.max(...percentages) >= threshold;
    },
    refreshHints: data => (data.nextResetTime ? [data.nextResetTime] : [])
};

// ============= MiniMax =============

export interface MiniMaxStatusData {
    limits: MiniMaxLimit[];
}

export const minimaxStatusAdapter: QuotaStatusAdapter<MiniMaxStatusData> = {
    async query(apiKey) {
        const site = resolveQuotaSite('minimax-token', undefined) === 'minimax.io' ? 'minimax.io' : undefined;
        return { limits: await fetchMiniMaxLimits(apiKey, site) };
    },
    summary: data => formatMiniMaxQuotaSummary(data.limits),
    tables: data => [
        {
            columns: [t('Window', '限频类型'), t('Remain', '剩余'), t('Reset Time', '重置时间')],
            rows: data.limits.map(item => [
                item.label,
                `${item.remaining}%`,
                item.resetTime ? formatQuotaDateForSlot('minimax-token', new Date(item.resetTime)) : '-'
            ]),
            align: ['left', 'right', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => {
        if (data.limits.length === 0) {
            return false;
        }
        const minRemaining = Math.min(...data.limits.map(limit => limit.remaining));
        return 100 - minRemaining >= threshold;
    },
    refreshHints: (data, cachedAt) =>
        data.limits.map(l => ((l.remainMs ?? 0) > 0 ? cachedAt + (l.remainMs as number) : 0)).filter(v => v > 0)
};

// ============= Kimi =============

export type KimiStatusData = KimiUsageSnapshot;

export const kimiStatusAdapter: QuotaStatusAdapter<KimiStatusData> = {
    query: apiKey => fetchKimiUsage(apiKey),
    summary: data => buildKimiUsageSummary(data),
    tables: data => {
        const tables: QuotaTable[] = [
            {
                columns: [t('Window', '频限类型'), t('Remaining', '剩余量'), t('Reset Time', '重置时间')],
                rows: [
                    [
                        t('Weekly quota', '每周额度'),
                        `${data.summary.remaining}%`,
                        formatQuotaDateForSlot('kimi', new Date(data.summary.resetTime))
                    ],
                    ...data.windows.map(window => [
                        `${window.duration} ${formatKimiTimeUnit(window.timeUnit, window.duration)}`,
                        `${window.detail.remaining}%`,
                        window.detail.resetTime ?
                            formatQuotaDateForSlot('kimi', new Date(window.detail.resetTime))
                        :   t('N/A', '无')
                    ])
                ],
                align: ['center', 'right', 'center'],
                boldColumns: [0]
            }
        ];

        const boosterAmount = data.boosterWallet ? parseFloat(data.boosterWallet.balance.amountLeft) : 0;
        if (data.boosterWallet && boosterAmount > 0) {
            const wallet = data.boosterWallet;
            tables.push({
                title: `**${t('Quota Booster', '额度加油包')}** (${translateKimiBoosterStatus(wallet.status)})`,
                columns: [t('Current Bal.', '当前余额'), t('Monthly Used', '本月消费'), t('Monthly Cap', '本月限额')],
                rows: [
                    [
                        formatKimiBoosterCurrency(wallet.topupLimit.currency, wallet.balance.amountLeft),
                        formatKimiCurrencyLimit(wallet.monthlyUsed, false, 2),
                        wallet.monthlyChargeLimitEnabled ?
                            formatKimiCurrencyLimit(wallet.monthlyChargeLimit, true, 2)
                        :   t('Unlimited', '无限制')
                    ]
                ],
                align: ['right', 'right', 'right']
            });
        }

        return tables;
    },
    details: data => (data.parallel ? [`${t('Maximum concurrency', '最高并发上限')}: ${data.parallel.limit}`] : []),
    highlightWarning: (data, threshold) =>
        data.summary.used >= threshold || data.windows.some(window => window.detail.used >= threshold)
};

// ============= DeepSeek =============

export interface DeepSeekStatusData {
    primaryBalance: DeepSeekBalanceInfo;
    allBalances: DeepSeekBalanceInfo[];
    lastUpdated: string;
}

export const deepseekStatusAdapter: QuotaStatusAdapter<DeepSeekStatusData> = {
    async query(apiKey) {
        const allBalances = await fetchDeepSeekBalances(apiKey);
        let primaryBalance = allBalances.find(b => b.currency === 'CNY');
        if (!primaryBalance) {
            primaryBalance = allBalances.find(b => b.currency === 'USD') || allBalances[0];
        }
        return { primaryBalance, allBalances, lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => formatCurrency(data.primaryBalance.currency, Number.parseFloat(data.primaryBalance.total_balance)),
    tables: data => [
        {
            columns: [
                t('Currency', '货币'),
                t('Paid Balance', '充值余额'),
                t('Granted', '赠金余额'),
                t('Available', '可用余额')
            ],
            rows: data.allBalances.map(balance => [
                balance.currency,
                balance.topped_up_balance,
                balance.granted_balance,
                balance.total_balance
            ]),
            align: ['center', 'right', 'right', 'right'],
            boldColumns: [0, 3]
        }
    ]
};

// ============= Moonshot =============

export interface MoonshotStatusData {
    balanceInfo: MoonshotBalanceInfo;
    lastUpdated: string;
}

export const moonshotStatusAdapter: QuotaStatusAdapter<MoonshotStatusData> = {
    async query(apiKey) {
        return { balanceInfo: await fetchMoonshotBalance(apiKey), lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => `¥${data.balanceInfo.available_balance.toFixed(2)}`,
    tables: data => [
        {
            columns: [
                t('Currency', '货币'),
                t('Cash Balance', '现金余额'),
                t('Voucher', '代金券'),
                t('Available', '可用余额')
            ],
            rows: [
                [
                    'CNY',
                    data.balanceInfo.cash_balance.toFixed(2),
                    data.balanceInfo.voucher_balance.toFixed(2),
                    data.balanceInfo.available_balance.toFixed(2)
                ]
            ],
            align: ['center', 'right', 'right', 'right'],
            boldColumns: [0, 3]
        }
    ]
};

// ============= ClinePass =============

export interface ClinePassStatusData {
    limits: ClinePassLimit[];
    lastUpdated: string;
}

export const clinepassStatusAdapter: QuotaStatusAdapter<ClinePassStatusData> = {
    async query(apiKey) {
        return { limits: await fetchClinePassLimits(apiKey), lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => formatClinePassQuotaSummary(data.limits),
    tables: data => [
        {
            columns: [
                t('Window', '限频类型'),
                t('Remaining', '剩余量'),
                t('Countdown', '倒计时'),
                t('Reset Time', '重置时间')
            ],
            rows: data.limits.map(limit => [
                getClinePassLimitLabel(limit.type),
                `${100 - limit.percentUsed}%`,
                formatCompactCountdown(limit.resetsAt),
                limit.resetsAt ? formatQuotaDateForSlot('clinepass', new Date(limit.resetsAt)) : '—'
            ]),
            align: ['center', 'right', 'center', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => data.limits.some(limit => limit.percentUsed >= threshold),
    refreshHints: data =>
        data.limits.map(limit => (limit.resetsAt ? new Date(limit.resetsAt).getTime() : 0)).filter(v => v > 0)
};

// ============= OpenCode =============

export interface OpenCodeStatusData extends OpenCodeUsageData {
    lastUpdated: string;
}

export const opencodeStatusAdapter: QuotaStatusAdapter<OpenCodeStatusData> = {
    async query(apiKey) {
        const usage = await fetchOpenCodeUsageData(apiKey);
        return { windows: usage.windows, lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => buildOpenCodeUsageSummary(data),
    tables: data => [
        {
            columns: [
                t('Window', '限频类型'),
                t('Remaining', '剩余量'),
                t('Countdown', '倒计时'),
                t('Reset Time', '重置时间')
            ],
            rows: data.windows.map(window => [
                getOpenCodeWindowLabel(window.type),
                `${window.remainingPercent.toFixed(0)}%`,
                formatCompactCountdown(window.resetAt),
                window.resetAt ? formatDateTimeSlash(new Date(window.resetAt)) : '—'
            ]),
            align: ['center', 'right', 'center', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => data.windows.some(window => window.usedPercent >= threshold)
};
