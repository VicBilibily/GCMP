/*---------------------------------------------------------------------------------------------
 *  ClinePass 配额查询与格式化
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatQuotaCountdown, formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** ClinePass 配额限制项（format 与 query 共用，状态栏展示直接复用） */
export interface ClinePassLimit {
    type: 'five_hour' | 'weekly' | 'monthly';
    percentUsed: number;
    resetsAt?: string;
}

export function formatClinePassQuotaSummary(
    limits: ReadonlyArray<Pick<ClinePassLimit, 'type' | 'percentUsed'>>
): string {
    const weekly = limits.find(limit => limit.type === 'weekly');
    const monthly = limits.find(limit => limit.type === 'monthly');
    const fiveHour = limits.find(limit => limit.type === 'five_hour');
    const mainRemain = Math.min(weekly ? 100 - weekly.percentUsed : 100, monthly ? 100 - monthly.percentUsed : 100);
    const fiveHourRemain = fiveHour ? 100 - fiveHour.percentUsed : undefined;

    return fiveHour && fiveHour.percentUsed > 0 ? `${mainRemain}% (${fiveHourRemain}%)` : `${mainRemain}%`;
}

/** ClinePass API 响应 */
interface ClinePassUsageResponse {
    data?: { limits: ClinePassLimit[] };
    success: boolean;
}

export function getClinePassLimitLabel(type: string): string {
    return (
        type === 'weekly' ? t('Weekly limit', '每周限额')
        : type === 'monthly' ? t('Monthly limit', '每月限额')
        : t('5 Hours', '300 分钟')
    );
}

class ClinePassQuotaProvider extends QuotaProviderBase<ClinePassLimit[]> {
    protected readonly providerKey = 'clinepass';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: 'https://api.cline.bot/api/v1/users/me/plan/usage-limits',
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('ClinePass')
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response, responseText: string): ClinePassLimit[] {
        const parsedResponse = payload as ClinePassUsageResponse;

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            try {
                const errorData = JSON.parse(responseText);
                if (errorData.error) {
                    errorMessage = errorData.error.message || errorData.error;
                }
            } catch {
                // ignore parse failure
            }
            throw new Error(errorMessage);
        }

        const limits = parsedResponse.data?.limits ?? [];
        if (!parsedResponse.success || limits.length === 0) {
            throw new Error(t('No remaining quota data was returned.', '未获取到剩余额度数据'));
        }

        return limits;
    }

    protected format(limits: ClinePassLimit[], lastUpdated: string): QuotaQueryResult {
        return {
            metricType: 'usage',
            summary: formatClinePassQuotaSummary(limits),
            tables: [
                {
                    columns: [
                        t('Window', '限频类型'),
                        t('Remaining', '剩余量'),
                        t('Countdown', '倒计时'),
                        t('Reset Time', '重置时间')
                    ],
                    rows: limits.map(limit => [
                        getClinePassLimitLabel(limit.type),
                        `${100 - limit.percentUsed}%`,
                        limit.resetsAt ? formatQuotaCountdown(limit.resetsAt) : '-',
                        limit.resetsAt ? formatQuotaDateForSlot('clinepass', new Date(limit.resetsAt)) : '-'
                    ])
                }
            ],
            lastUpdated
        };
    }
}

const clinepassProvider = new ClinePassQuotaProvider();

export const fetchClinePassLimits = (apiKey: string): Promise<ClinePassLimit[]> => clinepassProvider.fetch(apiKey);

export const queryClinePassQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    clinepassProvider.query(apiKey, undefined, lastUpdated);
