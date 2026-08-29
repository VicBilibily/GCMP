/*---------------------------------------------------------------------------------------------
 *  智谱状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { t, type QuotaStatusAdapter } from './types';
import { formatQuotaDateForSlot } from '../format';
import { resolveQuotaSite } from '../common';
import { buildZhipuUsageSummary, fetchZhipuLimits, getZhipuLimitLabel, type ZhipuLimit } from '../providers/zhipu';

/** 智谱状态数据（含最近重置时间，刷新判定用） */
export interface ZhipuStatusData {
    limits: ZhipuLimit[];
    nextResetTime?: number;
}

export const zhipuStatusAdapter: QuotaStatusAdapter<ZhipuStatusData> = {
    async query(apiKey) {
        const site = resolveQuotaSite('zhipu', undefined) === 'api.z.ai' ? 'api.z.ai' : undefined;
        const limits = await fetchZhipuLimits(apiKey, site);

        const resetTimes = limits.filter(l => l.nextResetTime !== undefined).map(l => l.nextResetTime as number);
        return { limits, nextResetTime: resetTimes.length > 0 ? Math.min(...resetTimes) : undefined };
    },
    summary: data => buildZhipuUsageSummary(data.limits),
    tables: data => [
        {
            columns: [
                t('Window', '限频类型'),
                t('Quota', '上限值'),
                t('Remaining', '剩余量'),
                t('Reset Time', '重置时间')
            ],
            rows: data.limits.map(limit => [
                limit.type === 'TIME_LIMIT' ?
                    t('MCP Monthly', 'MCP每月')
                :   getZhipuLimitLabel(limit, t('Quota', '限额')),
                limit.type === 'TIME_LIMIT' ? String(limit.usage ?? '-') : '-',
                limit.type === 'TIME_LIMIT' ? String(limit.remaining ?? '-') : `${100 - (limit.percentage ?? 0)}%`,
                limit.nextResetTime ? formatQuotaDateForSlot('zhipu', new Date(limit.nextResetTime)) : '-'
            ]),
            align: ['center', 'right', 'right', 'center'],
            boldColumns: [0]
        }
    ],
    highlightWarning: (data, threshold) => {
        const percentages = data.limits
            .map(limit => limit.percentage)
            .filter((value): value is number => Number.isFinite(value));
        return percentages.length > 0 && Math.max(...percentages) >= threshold;
    },
    refreshHints: data => (data.nextResetTime ? [data.nextResetTime] : [])
};
