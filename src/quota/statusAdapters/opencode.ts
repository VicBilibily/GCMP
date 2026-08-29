/*---------------------------------------------------------------------------------------------
 *  OpenCode 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatCompactCountdown, formatDateTimeSlash, formatLocaleDateTime } from '../format';
import { fetchOpenCodeUsageData, getOpenCodeWindowLabel } from '../providers/opencode';
import { buildOpenCodeUsageSummary, type OpenCodeUsageData } from '../parsers/opencodeUsage';

export interface OpenCodeStatusData extends OpenCodeUsageData {
    lastUpdated: string;
}

export const opencodeStatusAdapter: QuotaStatusAdapter<OpenCodeStatusData> = {
    async query(apiKey) {
        const usage = await fetchOpenCodeUsageData(apiKey);
        return { windows: usage.windows, lastUpdated: formatLocaleDateTime(new Date()) };
    },
    summary: data => buildOpenCodeUsageSummary(data),
    tables: data => [
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
                formatCompactCountdown(window.resetAt),
                window.resetAt ? formatDateTimeSlash(new Date(window.resetAt)) : '—'
            ]),
            align: ['center', 'right', 'center', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => data.windows.some(window => window.usedPercent >= threshold)
};
