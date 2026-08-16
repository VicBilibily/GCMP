/*---------------------------------------------------------------------------------------------
 *  OpenCode 配额查询与格式化
 *--------------------------------------------------------------------------------------------*/

import { t } from '../../utils/runtime/l10n';
import {
    buildOpenCodeUsageSummary,
    type OpenCodeUsageData,
    type OpenCodeUsageWindow,
    parseOpenCodeUsage,
    resolveOpenCodeUsageUrl
} from '../parsers/opencodeUsage';
import { formatQuotaCountdown, formatQuotaDateForSlot } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

export function getOpenCodeWindowLabel(type: OpenCodeUsageWindow['type']): string {
    switch (type) {
        case 'rolling':
            return t('5 Hours', '300 分钟');
        case 'weekly':
            return t('Weekly quota', '每周额度');
        case 'monthly':
            return t('Monthly quota', '每月额度');
    }
}

class OpenCodeQuotaProvider extends QuotaProviderBase<OpenCodeUsageData> {
    protected readonly providerKey = 'opencode';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: resolveOpenCodeUsageUrl(process.env),
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
        return new Error(t('OpenCode usage response is not valid JSON.', 'OpenCode 用量响应不是有效 JSON'));
    }

    protected parseAndValidate(payload: unknown, response: Response): OpenCodeUsageData {
        if (!response.ok) {
            throw new Error(
                t('OpenCode usage query failed with HTTP {0}.', 'OpenCode 用量查询失败，HTTP {0}', response.status)
            );
        }

        const parsed = parseOpenCodeUsage(payload);
        if (parsed.kind === 'invalid') {
            throw new Error(t('Invalid OpenCode usage response: {0}', 'OpenCode 用量响应无效: {0}', parsed.error));
        }

        return parsed.usage;
    }

    protected format(data: OpenCodeUsageData, lastUpdated: string): QuotaQueryResult {
        return {
            metricType: 'usage',
            summary: buildOpenCodeUsageSummary(data),
            tables: [
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
                        window.resetAt ? formatQuotaCountdown(window.resetAt) : '-',
                        window.resetAt ? formatQuotaDateForSlot('opencode', new Date(window.resetAt)) : '-'
                    ])
                }
            ],
            lastUpdated
        };
    }
}

const opencodeProvider = new OpenCodeQuotaProvider();

export const fetchOpenCodeUsageData = (apiKey: string): Promise<OpenCodeUsageData> => opencodeProvider.fetch(apiKey);

export const queryOpenCodeQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    opencodeProvider.query(apiKey, undefined, lastUpdated);
