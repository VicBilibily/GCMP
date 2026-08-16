/*---------------------------------------------------------------------------------------------
 *  ZhipuAI (智谱) 配额查询与格式化
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** 智谱配额限制项（format 与 query 共用，状态栏展示直接复用） */
export interface ZhipuLimit {
    type: 'TIME_LIMIT' | 'TOKENS_LIMIT';
    unit: number;
    percentage: number;
    usage?: number;
    remaining?: number;
    nextResetTime?: number;
}

/** 智谱 API 响应 */
interface ZhipuQuotaLimitResponse {
    code: number;
    msg: string;
    data: { limits: ZhipuLimit[] };
    success: boolean;
}

/** 状态栏与面板共用的摘要文本（如 "64% (88%)"，无代币限额时返回空串） */
export function buildZhipuUsageSummary(limits: ZhipuLimit[]): string {
    const tokensLimits = limits.filter(limit => limit.type === 'TOKENS_LIMIT');
    const weekly = tokensLimits.find(limit => limit.unit === 6);
    const hourly = tokensLimits.find(limit => limit.unit === 3);
    const formatRemaining = (limit: ZhipuLimit) => `${100 - (limit.percentage ?? 0)}%`;
    if (weekly && hourly) {
        return `${formatRemaining(weekly)} (${formatRemaining(hourly)})`;
    }
    if (weekly) {
        return formatRemaining(weekly);
    }
    if (hourly) {
        return formatRemaining(hourly);
    }
    if (tokensLimits.length > 0) {
        return formatRemaining(tokensLimits[0]);
    }
    return '';
}

/** 窗口标签：unit=3 → 5 小时限额，unit=6 → 每周限额，其余用 defaultLabel */
export function getZhipuLimitLabel(limit: ZhipuLimit, defaultLabel: string): string {
    if (limit.unit === 3) {
        return t('Every 5 Hours', '每 5 小时');
    }
    if (limit.unit === 6) {
        return t('Weekly quota', '每周限额');
    }
    return defaultLabel;
}

class ZhipuQuotaProvider extends QuotaProviderBase<ZhipuLimit[]> {
    protected readonly providerKey = 'zhipu';

    protected buildRequest(apiKey: string, site: string | undefined): { url: string; init: RequestInit } {
        const requestUrl =
            site === 'api.z.ai' ?
                'https://api.z.ai/api/monitor/usage/quota/limit'
            :   'https://bigmodel.cn/api/monitor/usage/quota/limit';

        return {
            url: requestUrl,
            init: {
                method: 'GET',
                headers: {
                    Authorization: apiKey,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Zhipu')
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response): ZhipuLimit[] {
        const parsedResponse = payload as ZhipuQuotaLimitResponse;

        if (!response.ok || !parsedResponse.success || parsedResponse.code !== 200) {
            throw new Error(parsedResponse.msg || `HTTP ${response.status}`);
        }

        const limits = parsedResponse.data?.limits ?? [];
        if (limits.length === 0) {
            throw new Error(t('No remaining quota data was returned.', '未获取到剩余额度数据'));
        }

        return limits;
    }

    protected format(limits: ZhipuLimit[], lastUpdated: string): QuotaQueryResult {
        const summary = buildZhipuUsageSummary(limits);

        return {
            metricType: 'usage',
            summary: summary || '-',
            tables: [
                {
                    columns: [
                        t('Window', '限频类型'),
                        t('Quota', '上限值'),
                        t('Remaining', '剩余量'),
                        t('Reset Time', '重置时间')
                    ],
                    rows: limits.map(limit => [
                        limit.type === 'TIME_LIMIT' ?
                            t('MCP Monthly', 'MCP每月')
                        :   getZhipuLimitLabel(limit, t('Quota', '限额')),
                        limit.type === 'TIME_LIMIT' ? String(limit.usage ?? '-') : '-',
                        limit.type === 'TIME_LIMIT' ?
                            String(limit.remaining ?? '-')
                        :   `${100 - (limit.percentage ?? 0)}%`,
                        limit.nextResetTime ? formatQuotaDateForSlot('zhipu', new Date(limit.nextResetTime)) : '-'
                    ])
                }
            ],
            lastUpdated
        };
    }
}

const zhipuProvider = new ZhipuQuotaProvider();

export const fetchZhipuLimits = (apiKey: string, site: string | undefined): Promise<ZhipuLimit[]> =>
    zhipuProvider.fetch(apiKey, site);

export const queryZhipuQuota = (
    apiKey: string,
    site: string | undefined,
    lastUpdated: string
): Promise<QuotaQueryResult> => zhipuProvider.query(apiKey, site, lastUpdated);
