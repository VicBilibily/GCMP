/*---------------------------------------------------------------------------------------------
 *  MiniMax Token Plan 配额查询与格式化
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** MiniMax 配额限制项（format 与 query 共用，状态栏缓存刷新依赖 remainMs/resetTime） */
export interface MiniMaxLimit {
    label: string;
    limitType: '5h' | 'weekly';
    remaining: number;
    /** 距重置剩余毫秒 */
    remainMs?: number;
    resetTime?: number;
}

export function formatMiniMaxQuotaSummary(
    limits: ReadonlyArray<Pick<MiniMaxLimit, 'limitType' | 'remaining'>>
): string {
    const items5h = limits.filter(limit => limit.limitType === '5h');
    const itemsWeekly = limits.filter(limit => limit.limitType === 'weekly');
    const remain5h = items5h.length > 0 ? Math.min(...items5h.map(item => item.remaining)) : undefined;
    const remainWeekly = itemsWeekly.length > 0 ? Math.min(...itemsWeekly.map(item => item.remaining)) : undefined;

    return (
        remainWeekly !== undefined && remain5h !== undefined ? `${remainWeekly}% (${remain5h}%)`
        : remain5h !== undefined ? `${remain5h}%`
        : remainWeekly !== undefined ? `${remainWeekly}%`
        : '-'
    );
}

interface ModelRemainInfo {
    start_time: number;
    end_time: number;
    remains_time: number;
    current_interval_total_count: number;
    current_interval_usage_count: number;
    model_name: string;
    current_weekly_total_count: number;
    current_weekly_usage_count: number;
    weekly_start_time: number;
    weekly_end_time: number;
    weekly_remains_time: number;
    current_interval_status: number;
    current_interval_remaining_percent: number;
    current_weekly_status: number;
    current_weekly_remaining_percent: number;
}

interface CodingPlanRemainResponse {
    model_remains: ModelRemainInfo[];
    base_resp: { status_code: number; status_msg: string };
}

/** 限频窗口状态是否属于当前订阅（1=生效中 / 2=已用完但窗口未结束）；status 字段缺失时回退 fallback 判定 */
function isActiveQuotaStatus(status: number | null | undefined, fallback: boolean): boolean {
    if (status === undefined || status === null) {
        return fallback;
    }
    return status === 1 || status === 2;
}

class MiniMaxQuotaProvider extends QuotaProviderBase<MiniMaxLimit[]> {
    protected readonly providerKey = 'minimax';

    protected buildRequest(apiKey: string, site: string | undefined): { url: string; init: RequestInit } {
        let requestUrl = 'https://www.minimaxi.com/v1/token_plan/remains';
        if (site === 'minimax.io') {
            requestUrl = requestUrl.replace('.minimaxi.com', '.minimax.io');
        }

        return {
            url: requestUrl,
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('MiniMax')
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response): MiniMaxLimit[] {
        const parsedResponse = payload as CodingPlanRemainResponse;

        if (!response.ok) {
            throw new Error(parsedResponse.base_resp?.status_msg || `HTTP ${response.status}`);
        }
        if (parsedResponse.base_resp?.status_code !== 0) {
            throw new Error(parsedResponse.base_resp.status_msg || t('Unknown business error', '未知业务错误'));
        }

        const modelRemains = parsedResponse.model_remains ?? [];
        const generalModels = modelRemains.filter(m => m.model_name === 'general');
        if (generalModels.length === 0) {
            throw new Error(t('No model remaining quota data was returned.', '未获取到模型剩余额度数据'));
        }

        const limits: MiniMaxLimit[] = [];
        for (const m of generalModels) {
            // 每 5 小时限额（status 缺失时按生效处理，与旧行为一致）
            if (isActiveQuotaStatus(m.current_interval_status, true)) {
                limits.push({
                    label: t('Every 5 Hours', '每 5 小时'),
                    limitType: '5h',
                    remaining: m.current_interval_remaining_percent ?? 100,
                    remainMs: m.remains_time,
                    resetTime: m.end_time
                });
            }
            // 每周限额：count 字段对 Coding Plan 长期为 0，应按 status 判断窗口是否属于当前订阅；status 缺失时回退 count 判定
            if (isActiveQuotaStatus(m.current_weekly_status, (m.current_weekly_total_count ?? 0) > 0)) {
                limits.push({
                    label: t('Weekly quota', '每周限额'),
                    limitType: 'weekly',
                    remaining: m.current_weekly_remaining_percent ?? 100,
                    remainMs: m.weekly_remains_time,
                    resetTime: m.weekly_end_time
                });
            }
        }
        return limits;
    }

    protected format(limits: MiniMaxLimit[], lastUpdated: string): QuotaQueryResult {
        return {
            metricType: 'usage',
            summary: formatMiniMaxQuotaSummary(limits),
            tables: [
                {
                    columns: [t('Window', '限频类型'), t('Remain', '剩余'), t('Reset Time', '重置时间')],
                    rows: limits.map(item => [
                        item.label,
                        `${item.remaining}%`,
                        item.resetTime ? formatQuotaDateForSlot('minimax-token', new Date(item.resetTime)) : '-'
                    ])
                }
            ],
            lastUpdated
        };
    }
}

const minimaxProvider = new MiniMaxQuotaProvider();

export const fetchMiniMaxLimits = (apiKey: string, site: string | undefined): Promise<MiniMaxLimit[]> =>
    minimaxProvider.fetch(apiKey, site);

export const queryMiniMaxQuota = (
    apiKey: string,
    site: string | undefined,
    lastUpdated: string
): Promise<QuotaQueryResult> => minimaxProvider.query(apiKey, site, lastUpdated);
