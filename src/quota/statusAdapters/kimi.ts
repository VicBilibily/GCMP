/*---------------------------------------------------------------------------------------------
 *  Kimi 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter, type QuotaTable } from './types';
import { formatQuotaDateForSlot } from '../format';
import {
    buildKimiUsageSummary,
    fetchKimiUsage,
    formatKimiBoosterCurrency,
    formatKimiCurrencyLimit,
    formatKimiTimeUnit,
    translateKimiBoosterStatus,
    type KimiUsageSnapshot
} from '../providers/kimi';

export type KimiStatusData = KimiUsageSnapshot;

export const kimiStatusAdapter: QuotaStatusAdapter<KimiStatusData> = {
    query: apiKey => fetchKimiUsage(apiKey),
    summary: data => buildKimiUsageSummary(data),
    tables: data => {
        const tables: QuotaTable[] = [
            {
                columns: [t('Window', '频限类型'), t('Remaining', '剩余量'), t('Reset Time', '重置时间')],
                rows: [
                    [
                        t('Weekly quota', '每周额度'),
                        `${data.summary.remaining}%`,
                        formatQuotaDateForSlot('kimi', new Date(data.summary.resetTime))
                    ],
                    ...data.windows.map(window => [
                        `${window.duration} ${formatKimiTimeUnit(window.timeUnit, window.duration)}`,
                        `${window.detail.remaining}%`,
                        window.detail.resetTime ?
                            formatQuotaDateForSlot('kimi', new Date(window.detail.resetTime))
                        :   t('N/A', '无')
                    ])
                ],
                align: ['center', 'right', 'center'],
                boldColumns: [0]
            }
        ];

        const boosterAmount = data.boosterWallet ? parseFloat(data.boosterWallet.balance.amountLeft) : 0;
        if (data.boosterWallet && boosterAmount > 0) {
            const wallet = data.boosterWallet;
            tables.push({
                title: `**${t('Quota Booster', '额度加油包')}** (${translateKimiBoosterStatus(wallet.status)})`,
                columns: [t('Current Bal.', '当前余额'), t('Monthly Used', '本月消费'), t('Monthly Cap', '本月限额')],
                rows: [
                    [
                        formatKimiBoosterCurrency(wallet.topupLimit.currency, wallet.balance.amountLeft),
                        formatKimiCurrencyLimit(wallet.monthlyUsed, false, 2),
                        wallet.monthlyChargeLimitEnabled ?
                            formatKimiCurrencyLimit(wallet.monthlyChargeLimit, true, 2)
                        :   t('Unlimited', '无限制')
                    ]
                ],
                align: ['right', 'right', 'right']
            });
        }

        return tables;
    },
    details: data => (data.parallel ? [`${t('Maximum concurrency', '最高并发上限')}: ${data.parallel.limit}`] : []),
    highlightWarning: (data, threshold) =>
        data.summary.used >= threshold || data.windows.some(window => window.detail.used >= threshold)
};
