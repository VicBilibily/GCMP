/*---------------------------------------------------------------------------------------------
 *  CommandCode 状态栏适配器
 *  套餐名由状态栏 titleOf 作为 tooltip 主标题，使用情况表格照常跟随。
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter, type QuotaTable } from './types';
import { formatCompactCountdown, formatDateTimeSlash, formatLocaleDateTime } from '../format';
import {
    buildCommandCodeUsageSummary,
    buildCommandCodeBalanceRow,
    buildCommandCodeWindowRows,
    fetchCommandCodeUsageData,
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
        const balanceColumns = [
            t('Monthly', '每月余额'),
            t('Purchased', '充值余额'),
            t('Granted', '赠送余额'),
            t('Available', '可用余额')
        ];
        const windowRows = buildCommandCodeWindowRows(data, formatCompactCountdown, formatDateTimeSlash, '—');
        const balanceRow = buildCommandCodeBalanceRow(data, '—');

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
