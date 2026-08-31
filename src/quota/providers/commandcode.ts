/*---------------------------------------------------------------------------------------------
 *  CommandCode 配额查询与格式化
 *--------------------------------------------------------------------------------------------*/

import { ConfigManager } from '../../utils/config/configManager';
import { t } from '../../utils/runtime/l10n';
import { formatQuotaCountdown, formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** Command Code 订阅套餐 planId → 展示名映射 */
const PLAN_LABELS: Record<string, string> = {
    'individual-goat': 'Command Code · GOAT',
    'individual-go': 'Command Code · Go',
    'individual-pro': 'Command Code · Pro',
    'individual-max-10x': 'Command Code · Max 10×',
    'individual-max-20x': 'Command Code · Max 20×',
    'team-pro': 'Command Code · Team Pro'
};

/** 将 planId 转换为订阅套餐展示名（未识别时按 planId 推断） */
export function humanizePlanId(planId: string | undefined): string {
    if (!planId) {
        return t('Command Code', 'Command Code');
    }
    const mapped = PLAN_LABELS[planId];
    if (mapped) {
        return mapped;
    }
    const title = planId
        .replace(/^individual-/, '')
        .replace(/^team-/, 'Team ')
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    return `Command Code · ${title || planId}`;
}

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
    /** 当前订阅套餐 planId（来自 /alpha/billing/subscriptions，soft-fail） */
    planId?: string;
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

export function formatCommandCodeCredits(value: number): string {
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
        return formatCommandCodeCredits(data.totalCredits);
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
        summary += ` ${formatCommandCodeCredits(data.purchasedCredits)}`;
    }
    return summary;
}

export function getCommandCodeWindowLabel(type: 'fiveHour' | 'weekly'): string {
    return type === 'fiveHour' ? t('5 Hours', '300 分钟') : t('Weekly quota', '每周额度');
}

export function buildCommandCodeWindowRows(
    data: CommandCodeUsageData,
    formatCountdown: (value: string | undefined) => string,
    formatResetTime: (value: Date) => string,
    missingValue = '-'
): string[][] {
    const rows: string[][] = [];
    if (data.fiveHour) {
        rows.push([
            getCommandCodeWindowLabel('fiveHour'),
            `${remainingPercent(data.fiveHour.used, data.fiveHour.cap).toFixed(0)}%`,
            formatCountdown(data.fiveHour.resetAt),
            data.fiveHour.resetAt ? formatResetTime(new Date(data.fiveHour.resetAt)) : missingValue
        ]);
    }
    if (data.weekly) {
        rows.push([
            getCommandCodeWindowLabel('weekly'),
            `${remainingPercent(data.weekly.used, data.weekly.cap).toFixed(0)}%`,
            formatCountdown(data.weekly.resetAt),
            data.weekly.resetAt ? formatResetTime(new Date(data.weekly.resetAt)) : missingValue
        ]);
    }
    return rows;
}

export function buildCommandCodeBalanceRow(data: CommandCodeUsageData, missingValue = '-'): string[] {
    return [
        formatCommandCodeCredits(data.monthlyCredits),
        data.purchasedCredits > 0 ? formatCommandCodeCredits(data.purchasedCredits) : missingValue,
        data.freeCredits > 0 ? formatCommandCodeCredits(data.freeCredits) : missingValue,
        formatCommandCodeCredits(data.totalCredits)
    ];
}

class CommandCodeQuotaProvider extends QuotaProviderBase<CommandCodeUsageData> {
    protected readonly providerKey = 'commandcode';

    /** 订阅查询超时（附加信息，软失败，不阻塞主查询） */
    private static readonly SUBSCRIPTION_TIMEOUT_MS = 10000;

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

    override async fetch(apiKey: string, site?: string): Promise<CommandCodeUsageData> {
        const data = await super.fetch(apiKey, site);
        // 订阅套餐为附加信息，查询失败不影响主数据
        data.planId = await this.fetchPlanId(apiKey);
        return data;
    }

    /** 查询当前订阅套餐 planId（soft-fail，返回 undefined 表示未获取到） */
    private async fetchPlanId(apiKey: string): Promise<string | undefined> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CommandCodeQuotaProvider.SUBSCRIPTION_TIMEOUT_MS);
        try {
            const response = await ConfigManager.fetchWithProxy(
                'https://api.commandcode.ai/alpha/billing/subscriptions',
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        Accept: 'application/json'
                    },
                    signal: controller.signal
                },
                { providerKey: this.providerKey }
            );
            if (!response.ok) {
                return undefined;
            }
            const payload = (await response.json()) as { data?: { planId?: string } };
            const planId = payload.data?.planId?.trim();
            return planId || undefined;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timeoutId);
        }
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
        const balanceColumns = [
            t('Monthly', '每月余额'),
            t('Purchased', '充值余额'),
            t('Granted', '赠送余额'),
            t('Available', '可用余额')
        ];
        const windowRows = buildCommandCodeWindowRows(
            data,
            resetAt => (resetAt ? formatQuotaCountdown(resetAt) : '-'),
            date => formatQuotaDateForSlot('commandcode', date)
        );
        const balanceRow = buildCommandCodeBalanceRow(data);

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
