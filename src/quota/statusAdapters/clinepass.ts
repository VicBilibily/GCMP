/*---------------------------------------------------------------------------------------------
 *  ClinePass 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatCompactCountdown, formatLocaleDateTime, formatQuotaDateForSlot } from '../format';
import {
    fetchClinePassLimits,
    formatClinePassQuotaSummary,
    getClinePassLimitLabel,
    type ClinePassLimit
} from '../providers/clinepass';

export interface ClinePassStatusData {
    limits: ClinePassLimit[];
    lastUpdated: string;
}

export const clinepassStatusAdapter: QuotaStatusAdapter<ClinePassStatusData> = {
    async query(apiKey) {
        return { limits: await fetchClinePassLimits(apiKey), lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => formatClinePassQuotaSummary(data.limits),
    tables: data => [
        {
            columns: [
                t('Window', '限频类型'),
                t('Remaining', '剩余量'),
                t('Countdown', '倒计时'),
                t('Reset Time', '重置时间')
            ],
            rows: data.limits.map(limit => [
                getClinePassLimitLabel(limit.type),
                `${100 - limit.percentUsed}%`,
                formatCompactCountdown(limit.resetsAt),
                limit.resetsAt ? formatQuotaDateForSlot('clinepass', new Date(limit.resetsAt)) : '—'
            ]),
            align: ['center', 'right', 'center', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => data.limits.some(limit => limit.percentUsed >= threshold),
    refreshHints: data =>
        data.limits.map(limit => (limit.resetsAt ? new Date(limit.resetsAt).getTime() : 0)).filter(v => v > 0)
};
