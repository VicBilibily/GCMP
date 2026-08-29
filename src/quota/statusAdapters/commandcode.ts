/*---------------------------------------------------------------------------------------------
 *  CommandCode 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter, type QuotaTable } from './types';
import { formatCompactCountdown, formatDateTimeSlash, formatLocaleDateTime } from '../format';
import {
    buildCommandCodeUsageSummary,
    fetchCommandCodeUsageData,
    getCommandCodeWindowLabel,
    remainingPercent,
    type CommandCodeUsageData
} from '../providers/commandcode';

export interface CommandCodeStatusData extends CommandCodeUsageData {
    lastUpdated: string;
}

export const commandcodeStatusAdapter: QuotaStatusAdapter<CommandCodeStatusData> = {
    async query(apiKey) {
        const usage = await fetchCommandCodeUsageData(apiKey);
        return { ...usage, lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => buildCommandCodeUsageSummary(data),
    tables: data => {
        const windowRows: string[][] = [];
        if (data.fiveHour) {
            windowRows.push([
                getCommandCodeWindowLabel('fiveHour'),
                `${remainingPercent(data.fiveHour.used, data.fiveHour.cap).toFixed(0)}%`,
                formatCompactCountdown(data.fiveHour.resetAt),
                data.fiveHour.resetAt ? formatDateTimeSlash(new Date(data.fiveHour.resetAt)) : '—'
            ]);
        }
        if (data.weekly) {
            windowRows.push([
                getCommandCodeWindowLabel('weekly'),
                `${remainingPercent(data.weekly.used, data.weekly.cap).toFixed(0)}%`,
                formatCompactCountdown(data.weekly.resetAt),
                data.weekly.resetAt ? formatDateTimeSlash(new Date(data.weekly.resetAt)) : '—'
            ]);
        }

        const balanceColumns = [
            t('Monthly', '每月余额'),
            t('Purchased', '充值余额'),
            t('Granted', '赠送余额'),
            t('Available', '可用余额')
        ];
        const balanceRow = [
            `$${data.monthlyCredits.toFixed(2)}`,
            data.purchasedCredits > 0 ? `$${data.purchasedCredits.toFixed(2)}` : '—',
            data.freeCredits > 0 ? `$${data.freeCredits.toFixed(2)}` : '—',
            `$${data.totalCredits.toFixed(2)}`
        ];

        const tables: QuotaTable[] = [];
        if (windowRows.length > 0) {
            tables.push({
                columns: [
                    t('Window', '限频类型'),
                    t('Remaining', '剩余量'),
                    t('Countdown', '倒计时'),
                    t('Reset Time', '重置时间')
                ],
                rows: windowRows,
                align: ['center', 'right', 'center', 'center'],
                boldColumns: [0]
            });
        }
        tables.push({
            columns: balanceColumns,
            rows: [balanceRow],
            align: ['right', 'right', 'right', 'right']
        });
        return tables;
    },
    highlightWarning: data =>
        (data.fiveHour && data.fiveHour.exceeded) || (data.weekly && data.weekly.exceeded) || false
};
