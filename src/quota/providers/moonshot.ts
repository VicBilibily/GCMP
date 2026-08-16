/*---------------------------------------------------------------------------------------------
 *  Moonshot (月之暗面) 余额查询与格式化
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatCurrency } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** Moonshot 余额信息（format 与 query 共用，状态栏展示直接复用） */
export interface MoonshotBalanceInfo {
    available_balance: number;
    cash_balance: number;
    voucher_balance: number;
}

/** Moonshot API 响应 */
interface MoonshotBalanceResponse {
    code: number;
    data: MoonshotBalanceInfo;
    scode: string;
    status: boolean;
}

class MoonshotQuotaProvider extends QuotaProviderBase<MoonshotBalanceInfo> {
    protected readonly providerKey = 'moonshot';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: 'https://api.moonshot.cn/v1/users/me/balance',
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Moonshot')
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response, responseText: string): MoonshotBalanceInfo {
        const parsedResponse = payload as MoonshotBalanceResponse;

        if (!response.ok) {
            let errorMessage = parsedResponse.scode || `HTTP ${response.status}`;
            if (!parsedResponse.scode && responseText) {
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData.error) {
                        errorMessage = errorData.error.message || errorData.error;
                    }
                } catch {
                    // 错误响应不是 JSON 时使用默认错误信息
                }
            }
            throw new Error(errorMessage);
        }
        if (!parsedResponse.status || parsedResponse.code !== 0 || !parsedResponse.data) {
            throw new Error(parsedResponse.scode || t('No balance data was returned.', '未获取到余额数据'));
        }

        return parsedResponse.data;
    }

    protected format(info: MoonshotBalanceInfo, lastUpdated: string): QuotaQueryResult {
        return {
            metricType: 'balance',
            summary: formatCurrency('CNY', info.available_balance),
            tables: [
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
                            info.cash_balance.toFixed(2),
                            info.voucher_balance.toFixed(2),
                            info.available_balance.toFixed(2)
                        ]
                    ]
                }
            ],
            lastUpdated
        };
    }
}

const moonshotProvider = new MoonshotQuotaProvider();

export const fetchMoonshotBalance = (apiKey: string): Promise<MoonshotBalanceInfo> => moonshotProvider.fetch(apiKey);

export const queryMoonshotQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    moonshotProvider.query(apiKey, undefined, lastUpdated);
