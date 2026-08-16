/*---------------------------------------------------------------------------------------------
 *  DeepSeek 余额查询与格式化
 *---------------------------------------------------------------------------------------------*/

import { VersionManager } from '../../utils/runtime/versionManager';
import { t } from '../../utils/runtime/l10n';
import { formatCurrency } from '../common';
import { QuotaProviderBase } from './base';
import type { QuotaQueryResult } from '../types';

/** DeepSeek 余额条目（format 与 query 共用，状态栏展示直接复用） */
export interface DeepSeekBalanceInfo {
    currency: string;
    total_balance: string;
    granted_balance: string;
    topped_up_balance: string;
}

/** DeepSeek API 响应 */
interface DeepSeekBalanceResponse {
    balance_infos: DeepSeekBalanceInfo[];
}

class DeepSeekQuotaProvider extends QuotaProviderBase<DeepSeekBalanceInfo[]> {
    protected readonly providerKey = 'deepseek';

    protected buildRequest(apiKey: string): { url: string; init: RequestInit } {
        return {
            url: 'https://api.deepseek.com/v1/user/balance',
            init: {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('DeepSeek')
                }
            }
        };
    }

    protected parseAndValidate(payload: unknown, response: Response, responseText: string): DeepSeekBalanceInfo[] {
        const parsedResponse = payload as DeepSeekBalanceResponse;

        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}`;
            if (responseText) {
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
        if (!Array.isArray(parsedResponse.balance_infos) || parsedResponse.balance_infos.length === 0) {
            throw new Error(t('No balance data was returned.', '未获取到余额数据'));
        }

        return parsedResponse.balance_infos;
    }

    protected format(balances: DeepSeekBalanceInfo[], lastUpdated: string): QuotaQueryResult {
        const primary = balances[0]!;
        return {
            metricType: 'balance',
            summary: formatCurrency(primary.currency, parseFloat(primary.total_balance)),
            tables: [
                {
                    columns: [
                        t('Currency', '货币'),
                        t('Paid Balance', '充值余额'),
                        t('Granted', '赠金余额'),
                        t('Available', '可用余额')
                    ],
                    rows: balances.map(balance => [
                        balance.currency,
                        balance.topped_up_balance,
                        balance.granted_balance,
                        balance.total_balance
                    ])
                }
            ],
            lastUpdated
        };
    }
}

const deepseekProvider = new DeepSeekQuotaProvider();

export const fetchDeepSeekBalances = (apiKey: string): Promise<DeepSeekBalanceInfo[]> => deepseekProvider.fetch(apiKey);

export const queryDeepSeekQuota = (apiKey: string, lastUpdated: string): Promise<QuotaQueryResult> =>
    deepseekProvider.query(apiKey, undefined, lastUpdated);
