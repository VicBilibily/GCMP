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
    async query(apiKey) {
        const site = resolveQuotaSite('minimax-token', undefined) === 'minimax.io' ? 'minimax.io' : undefined;
        return { limits: await fetchMiniMaxLimits(apiKey, site) };
    },
    summary: data => formatMiniMaxQuotaSummary(data.limits),
    tables: data => [
        {
            columns: [t('Window', '限频类型'), t('Remain', '剩余'), t('Reset Time', '重置时间')],
            rows: data.limits.map(item => [
                item.label,
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
