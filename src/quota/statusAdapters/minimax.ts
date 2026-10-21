/*---------------------------------------------------------------------------------------------
 *  MiniMax 状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatQuotaDateForSlot } from '../format';
import { resolveQuotaSite } from '../common';
import { fetchMiniMaxLimits, formatMiniMaxQuotaSummary, type MiniMaxLimit } from '../providers/minimax';

export interface MiniMaxStatusData {
    limits: MiniMaxLimit[];
}

export const minimaxStatusAdapter: QuotaStatusAdapter<MiniMaxStatusData> = {
    async query(apiKey, context) {
        const site = resolveQuotaSite('minimax-token', context?.site) === 'minimax.io' ? 'minimax.io' : undefined;
        const data = { limits: await fetchMiniMaxLimits(apiKey, site) };
        return data;
    },
    requestStatus: data => ({ provider: 'minimax-token', data }),
    summary: data => formatMiniMaxQuotaSummary(data.limits),
    tables: data => [
        {
            columns: [t('Window', '限频类型'), t('Remain', '剩余'), t('Reset Time', '重置时间')],
            rows: data.limits.map(item => [
                item.limitType === '5h' ? t('Every 5 Hours', '每 5 小时') : t('Weekly quota', '每周限额'),
                `${item.remaining}%`,
                item.resetTime ? formatQuotaDateForSlot('minimax-token', new Date(item.resetTime)) : '-'
            ]),
            align: ['left', 'right', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => {
        if (data.limits.length === 0) {
            return false;
        }
        const minRemaining = Math.min(...data.limits.map(limit => limit.remaining));
        return 100 - minRemaining >= threshold;
    },
    refreshHints: (data, cachedAt) =>
        data.limits.map(l => ((l.remainMs ?? 0) > 0 ? cachedAt + (l.remainMs as number) : 0)).filter(v => v > 0)
};
