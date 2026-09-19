/*---------------------------------------------------------------------------------------------
 *  Kimi (月之暗面 Coding) 配额查询与格式化
 *  含加油包（boosterWallet）专用货币/状态/时间单位格式化。
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatQuotaDateForSlot, getCurrencySymbol, isChineseLocale } from '../common';
import {
    isKimiMonthlyCapEnabled,
    normalizeKimiUsage,
    type KimiNormalizedUsage,
    type KimiUsageSummary
} from '../parsers/kimiUsageParser';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult, QuotaTable } from '../types';

// ============= Kimi 专用类型 =============

/** Kimi 货币金额（分为单位的价格） */
interface KimiPriceAmount {
    currency: string;
    priceInCents: string;
}

/** Kimi 加油包钱包 */
export interface KimiBoosterWallet {
    balance: { amountLeft: string };
    topupLimit: { currency: string };
    status: string;
    /** 旧版显式开关；新接口已移除，缺省时按月限额金额是否大于 0 判断 */
    monthlyChargeLimitEnabled?: boolean;
    monthlyChargeLimit: KimiPriceAmount;
    monthlyUsed: KimiPriceAmount;
}

/** fetchKimiUsage 返回的完整用量快照（状态栏与面板格式化共用） */
export interface KimiUsageSnapshot extends KimiNormalizedUsage {
    parallel?: { limit: number };
    boosterWallet?: KimiBoosterWallet;
}

/** Kimi API 响应（原始 JSON；usage/limits/usages 结构由 kimiUsageParser 归一化） */
interface KimiBillingResponse {
    code?: string;
    parallel?: { limit: string | number };
    boosterWallet?: KimiBoosterWallet;
    booster_wallet?: KimiBoosterWallet;
}

// ============= Kimi 专用货币/状态格式化 =============

export function formatKimiCurrencyLimit(limit: KimiPriceAmount, treatZeroAsUnlimited = false, decimals = 2): string {
    const amount = parseInt(limit.priceInCents, 10);
    if (!Number.isFinite(amount)) {
        return '-';
    }
    if (amount === 0 && treatZeroAsUnlimited) {
        return t('Unlimited', '无限制');
    }
    const symbol = getCurrencySymbol(limit.currency);
    return `${symbol}${(amount / 100).toFixed(decimals)}`;
}

export function formatKimiBoosterCurrency(currency: string, amount: string, decimals = 2): string {
    const numericAmount = parseInt(amount, 10);
    if (!Number.isFinite(numericAmount)) {
        return '-';
    }
    const symbol = getCurrencySymbol(currency);
    return `${symbol}${(numericAmount / 1e8).toFixed(decimals)}`;
}

/** 本月限额展示：启用时显示金额（0 视为无限制），未启用显示"无限制" */
export function formatKimiMonthlyCap(wallet: KimiBoosterWallet): string {
    return isKimiMonthlyCapEnabled(wallet.monthlyChargeLimitEnabled, wallet.monthlyChargeLimit) ?
            formatKimiCurrencyLimit(wallet.monthlyChargeLimit, true, 2)
        :   t('Unlimited', '无限制');
}

export function translateKimiBoosterStatus(status: string): string {
    const statusMap: Record<string, { en: string; zh: string }> = {
        STATUS_ACTIVE: { en: 'Active', zh: '已开启' },
        STATUS_DISABLED: { en: 'Closed', zh: '已关闭' }
    };
    const mapped = statusMap[status];
    if (!mapped) {
        return status;
    }
    return isChineseLocale() ? mapped.zh : mapped.en;
}

export function formatKimiTimeUnit(timeUnit: string, duration: number): string {
    const isZh = isChineseLocale();
    const unitMap: Record<string, { singular: string; plural: string; zh: string }> = {
        TIME_UNIT_SECOND: { singular: 'second', plural: 'seconds', zh: '秒' },
        TIME_UNIT_MINUTE: { singular: 'minute', plural: 'minutes', zh: '分钟' },
        TIME_UNIT_HOUR: { singular: 'hour', plural: 'hours', zh: '小时' },
        TIME_UNIT_DAY: { singular: 'day', plural: 'days', zh: '天' },
        TIME_UNIT_MONTH: { singular: 'month', plural: 'months', zh: '月' },
        TIME_UNIT_YEAR: { singular: 'year', plural: 'years', zh: '年' }
    };
    const unit = unitMap[timeUnit];
    if (!unit) {
        return timeUnit;
    }
    return (
        isZh ? unit.zh
        : duration === 1 ? unit.singular
        : unit.plural
    );
}

// ============= 格式化 =============

/** 摘要行标签：旧会员为每周额度，2026-09 起新会员为每月额度 */
export function formatKimiSummaryLabel(summary: KimiUsageSummary): string {
    return summary.period === 'monthly' ? t('Monthly quota', '每月额度') : t('Weekly quota', '每周额度');
}

/** 状态栏与面板共用的摘要文本（如 "85% (92%) ¥3.20"） */
export function buildKimiUsageSummary(data: KimiUsageSnapshot): string {
    const boosterAmount = data.boosterWallet ? parseInt(data.boosterWallet.balance.amountLeft, 10) : 0;
    const windowRemains = data.windows
        .filter(window => window.detail.remaining < 100)
        .map(window => `${window.detail.remaining}%`);
    let summary = `${data.summary.remaining}%`;
    if (windowRemains.length > 0) {
        summary += ` (${windowRemains.join(',')})`;
    }
    if (data.boosterWallet && boosterAmount > 0) {
        summary += ` ${formatKimiBoosterCurrency(
            data.boosterWallet.topupLimit.currency,
            data.boosterWallet.balance.amountLeft
        )}`;
    }
    return summary;
}

// ============= 查询 =============

class KimiQuotaProvider extends QuotaProviderBase<KimiUsageSnapshot> {
    protected readonly providerKey = 'kimi';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: 'https://api.kimi.com/coding/v1/usages',
            init: {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Kimi'),
                    Authorization: `Bearer ${apiKey}`
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response): KimiUsageSnapshot {
        const parsedResponse = payload as KimiBillingResponse;

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        if (parsedResponse.code === 'unauthenticated') {
            throw new Error(
                t(
                    'The API key is invalid or expired. Check your Kimi API key.',
                    'API密钥无效或已过期，请检查您的Kimi API密钥'
                )
            );
        }
        if (parsedResponse.code !== undefined) {
            throw new Error(t('API error: {0}', 'API错误: {0}', parsedResponse.code));
        }

        const normalized = normalizeKimiUsage(payload);
        if (!normalized) {
            throw new Error(t('No remaining quota data was returned.', '未获取到剩余额度数据'));
        }

        const parallelLimit = Number(parsedResponse.parallel?.limit);

        return {
            ...normalized,
            parallel: Number.isFinite(parallelLimit) ? { limit: Math.trunc(parallelLimit) } : undefined,
            boosterWallet: parsedResponse.boosterWallet ?? parsedResponse.booster_wallet
        };
    }

    protected format(data: KimiUsageSnapshot, lastUpdated: string): QuotaQueryResult {
        const boosterAmount = data.boosterWallet ? parseInt(data.boosterWallet.balance.amountLeft, 10) : 0;

        const tables: QuotaTable[] = [
            {
                columns: [t('Window', '频限类型'), t('Remaining', '剩余量'), t('Reset Time', '重置时间')],
                rows: [
                    [
                        formatKimiSummaryLabel(data.summary),
                        `${data.summary.remaining}%`,
                        formatQuotaDateForSlot('kimi', new Date(data.summary.resetTime))
                    ],
                    ...data.windows.map(window => {
                        const label = `${window.duration} ${formatKimiTimeUnit(window.timeUnit, window.duration)}`;
                        return [
                            label,
                            `${window.detail.remaining}%`,
                            window.detail.resetTime ?
                                formatQuotaDateForSlot('kimi', new Date(window.detail.resetTime))
                            :   t('N/A', '无')
                        ];
                    })
                ]
            }
        ];

        const details: string[] = [];

        if (data.parallel) {
            details.push(t('Maximum concurrency · {0}', '最高并发 · {0}', data.parallel.limit));
        }

        if (data.boosterWallet && boosterAmount > 0) {
            tables.push({
                title: t(
                    'Quota Booster ({0})',
                    '额度加油包（{0}）',
                    translateKimiBoosterStatus(data.boosterWallet.status)
                ),
                columns: [t('Current Bal.', '当前余额'), t('Monthly Used', '本月消费'), t('Monthly Cap', '本月限额')],
                rows: [
                    [
                        formatKimiBoosterCurrency(
                            data.boosterWallet.topupLimit.currency,
                            data.boosterWallet.balance.amountLeft
                        ),
                        formatKimiCurrencyLimit(data.boosterWallet.monthlyUsed, false, 2),
                        formatKimiMonthlyCap(data.boosterWallet)
                    ]
                ]
            });
        }

        return {
            metricType: 'usage',
            summary: buildKimiUsageSummary(data),
            tables,
            details,
            lastUpdated
        };
    }
}

const kimiProvider = new KimiQuotaProvider();

export const fetchKimiUsage = (apiKey: string): Promise<KimiUsageSnapshot> => kimiProvider.fetch(apiKey);

export const queryKimiQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    kimiProvider.query(apiKey, undefined, lastUpdated);
