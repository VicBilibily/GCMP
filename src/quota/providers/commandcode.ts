/*---------------------------------------------------------------------------------------------
 *  CommandCode 配额查询与格式化
 *--------------------------------------------------------------------------------------------*/

import { t } from '../../utils/runtime/l10n';
import { formatQuotaCountdown, formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** CommandCode billing/credits API 响应 */
export interface CommandCodeCreditsResponse {
    credits?: {
        belowThreshold?: boolean;
        creditThreshold?: number;
        monthlyCredits?: number;
        purchasedCredits?: number;
        freeCredits?: number;
    };
    windowLimits?: {
        limited?: boolean;
        exceeded?: string | null;
        fiveHour?: {
            used?: number;
            cap?: number;
            exceeded?: boolean;
            resetAt?: number;
        };
        weekly?: {
            used?: number;
            cap?: number;
            exceeded?: boolean;
            resetAt?: number;
        };
    };
}

export interface CommandCodeUsageData {
    monthlyCredits: number;
    purchasedCredits: number;
    freeCredits: number;
    totalCredits: number;
    fiveHour?: {
        used: number;
        cap: number;
        exceeded: boolean;
        resetAt?: string;
    };
    weekly?: {
        used: number;
        cap: number;
        exceeded: boolean;
        resetAt?: string;
    };
}

function formatCredits(value: number): string {
    return `$${value.toFixed(2)}`;
}

export function remainingPercent(used: number, cap: number): number {
    if (cap <= 0) {
        return 100;
    }
    return Math.max(0, Math.min(100, ((cap - used) / cap) * 100));
}

export function buildCommandCodeUsageSummary(data: CommandCodeUsageData): string {
    const fiveHourRemain = data.fiveHour ? remainingPercent(data.fiveHour.used, data.fiveHour.cap) : undefined;
    const weeklyRemain = data.weekly ? remainingPercent(data.weekly.used, data.weekly.cap) : undefined;
    const primaryRemain = weeklyRemain ?? fiveHourRemain;

    // 无窗口限额（如 Provider plan）：总额已含充值/赠送，直接展示可用余额
    if (primaryRemain === undefined) {
        return formatCredits(data.totalCredits);
    }

    const windowRemains: string[] = [];
    if (weeklyRemain !== undefined && fiveHourRemain !== undefined && fiveHourRemain < 100) {
        windowRemains.push(`${fiveHourRemain.toFixed(0)}%`);
    }

    let summary = `${primaryRemain.toFixed(0)}%`;
    if (windowRemains.length > 0) {
        summary += ` (${windowRemains.join(',')})`;
    }
    if (data.purchasedCredits > 0) {
        summary += ` ${formatCredits(data.purchasedCredits)}`;
    }
    return summary;
}

export function getCommandCodeWindowLabel(type: 'fiveHour' | 'weekly'): string {
    return type === 'fiveHour' ? t('5 Hours', '300 分钟') : t('Weekly quota', '每周额度');
}

class CommandCodeQuotaProvider extends QuotaProviderBase<CommandCodeUsageData> {
    protected readonly providerKey = 'commandcode';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: 'https://api.commandcode.ai/alpha/billing/credits',
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json'
                }
            }
        };
    }

    protected override createInvalidJsonError(): Error {
        return new Error(t('CommandCode usage response is not valid JSON.', 'CommandCode 用量响应不是有效 JSON'));
    }

    protected parseAndValidate(payload: unknown, response: Response): CommandCodeUsageData {
        if (!response.ok) {
            throw new Error(
                t(
                    'CommandCode usage query failed with HTTP {0}.',
                    'CommandCode 用量查询失败，HTTP {0}',
                    response.status
                )
            );
        }

        const parsed = payload as CommandCodeCreditsResponse;
        const monthlyCredits = parsed.credits?.monthlyCredits ?? 0;
        const purchasedCredits = parsed.credits?.purchasedCredits ?? 0;
        const freeCredits = parsed.credits?.freeCredits ?? 0;
        const totalCredits = monthlyCredits + purchasedCredits + freeCredits;

        const data: CommandCodeUsageData = {
            monthlyCredits,
            purchasedCredits,
            freeCredits,
            totalCredits
        };

        if (parsed.windowLimits?.fiveHour) {
            const w = parsed.windowLimits.fiveHour;
            data.fiveHour = {
                used: w.used ?? 0,
                cap: w.cap ?? 0,
                exceeded: w.exceeded ?? false,
                resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : undefined
            };
        }
        if (parsed.windowLimits?.weekly) {
            const w = parsed.windowLimits.weekly;
            data.weekly = {
                used: w.used ?? 0,
                cap: w.cap ?? 0,
                exceeded: w.exceeded ?? false,
                resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : undefined
            };
        }

        return data;
    }

    protected format(data: CommandCodeUsageData, lastUpdated: string): QuotaQueryResult {
        const windowRows: string[][] = [];
        if (data.fiveHour) {
            windowRows.push([
                getCommandCodeWindowLabel('fiveHour'),
                `${remainingPercent(data.fiveHour.used, data.fiveHour.cap).toFixed(0)}%`,
                data.fiveHour.resetAt ? formatQuotaCountdown(data.fiveHour.resetAt) : '-',
                data.fiveHour.resetAt ? formatQuotaDateForSlot('commandcode', new Date(data.fiveHour.resetAt)) : '-'
            ]);
        }
        if (data.weekly) {
            windowRows.push([
                getCommandCodeWindowLabel('weekly'),
                `${remainingPercent(data.weekly.used, data.weekly.cap).toFixed(0)}%`,
                data.weekly.resetAt ? formatQuotaCountdown(data.weekly.resetAt) : '-',
                data.weekly.resetAt ? formatQuotaDateForSlot('commandcode', new Date(data.weekly.resetAt)) : '-'
            ]);
        }

        const balanceColumns = [
            t('Monthly', '每月余额'),
            t('Purchased', '充值余额'),
            t('Granted', '赠送余额'),
            t('Available', '可用余额')
        ];
        const balanceRow = [
            formatCredits(data.monthlyCredits),
            data.purchasedCredits > 0 ? formatCredits(data.purchasedCredits) : '-',
            data.freeCredits > 0 ? formatCredits(data.freeCredits) : '-',
            formatCredits(data.totalCredits)
        ];

        const tables: QuotaQueryResult['tables'] = [];
        if (windowRows.length > 0) {
            tables.push({
                columns: [
                    t('Window', '限频类型'),
                    t('Remaining', '剩余量'),
                    t('Countdown', '倒计时'),
                    t('Reset Time', '重置时间')
                ],
                rows: windowRows
            });
        }
        tables.push({
            columns: balanceColumns,
            rows: [balanceRow]
        });

        return {
            metricType: 'usage',
            summary: buildCommandCodeUsageSummary(data),
            tables,
            lastUpdated
        };
    }
}

const commandcodeProvider = new CommandCodeQuotaProvider();

export const fetchCommandCodeUsageData = (apiKey: string): Promise<CommandCodeUsageData> =>
    commandcodeProvider.fetch(apiKey);

export const queryCommandCodeQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    commandcodeProvider.query(apiKey, undefined, lastUpdated);
