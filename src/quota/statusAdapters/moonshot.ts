/*---------------------------------------------------------------------------------------------
 *  Moonshot 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatLocaleDateTime } from '../format';
import { fetchMoonshotBalance, type MoonshotBalanceInfo } from '../providers/moonshot';

export interface MoonshotStatusData {
    balanceInfo: MoonshotBalanceInfo;
    lastUpdated: string;
}

export const moonshotStatusAdapter: QuotaStatusAdapter<MoonshotStatusData> = {
    async query(apiKey) {
        const balanceInfo = await fetchMoonshotBalance(apiKey);
        const data = { balanceInfo, lastUpdated: formatLocaleDateTime(new Date()) };
        return data;
    },
    summary: data => `¥${data.balanceInfo.available_balance.toFixed(2)}`,
    balance: data => data.balanceInfo.available_balance,
    requestStatus: data => ({ provider: 'moonshot', data }),
    requestBalance: data => [
        {
            id: 'moonshot',
            balance: data.balanceInfo.available_balance,
            currency: 'CNY',
            paid: data.balanceInfo.cash_balance,
            granted: data.balanceInfo.voucher_balance
        }
    ],
    tables: data => [
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
                    data.balanceInfo.cash_balance.toFixed(2),
                    data.balanceInfo.voucher_balance.toFixed(2),
                    data.balanceInfo.available_balance.toFixed(2)
                ]
            ],
            align: ['center', 'right', 'right', 'right'],
            boldColumns: [0, 3]
        }
    ]
};
