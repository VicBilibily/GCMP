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
        return { balanceInfo: await fetchMoonshotBalance(apiKey), lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => `¥${data.balanceInfo.available_balance.toFixed(2)}`,
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
