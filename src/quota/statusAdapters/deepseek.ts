/*---------------------------------------------------------------------------------------------
 *  DeepSeek 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatCurrency, formatLocaleDateTime } from '../format';
import { fetchDeepSeekBalances, type DeepSeekBalanceInfo } from '../providers/deepseek';

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
