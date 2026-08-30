/*---------------------------------------------------------------------------------------------
 *  智谱状态栏适配器
 *--------------------------------------------------------------------------------------------*/

import { type QuotaStatusAdapter, type QuotaTable } from './types';
import { resolveQuotaSite } from '../common';
import {
    buildZhipuBalanceTable,
    buildZhipuLimitsTable,
    buildZhipuUsageSummary,
    fetchZhipuUsage,
    type ZhipuAccountBalance,
    type ZhipuLimit
} from '../providers/zhipu';

/** 智谱状态数据（含最近重置时间，刷新判定用） */
export interface ZhipuStatusData {
    limits: ZhipuLimit[];
    account?: ZhipuAccountBalance;
    nextResetTime?: number;
}

export const zhipuStatusAdapter: QuotaStatusAdapter<ZhipuStatusData> = {
    async query(apiKey) {
        const site = resolveQuotaSite('zhipu', undefined) === 'api.z.ai' ? 'api.z.ai' : undefined;
        const { limits, account } = await fetchZhipuUsage(apiKey, site);

        const resetTimes = limits.filter(l => l.nextResetTime !== undefined).map(l => l.nextResetTime as number);
        return { limits, account, nextResetTime: resetTimes.length > 0 ? Math.min(...resetTimes) : undefined };
    },
    summary: data => buildZhipuUsageSummary(data),
    tables: data => {
        const tables: QuotaTable[] = [];
        if (data.limits.length > 0) {
            // tooltip 专属展示元数据：对齐与首列加粗（面板侧不带）
            tables.push({
                ...buildZhipuLimitsTable(data.limits),
                align: ['center', 'right', 'right', 'center'],
                boldColumns: [0]
            });
        }
        const balanceTable = data.account ? buildZhipuBalanceTable(data.account) : undefined;
        if (balanceTable) {
            tables.push(balanceTable);
        }
        return tables;
    },
    highlightWarning: (data, threshold) => {
        const percentages = data.limits
            .map(limit => limit.percentage)
            .filter((value): value is number => Number.isFinite(value));
        return percentages.length > 0 && Math.max(...percentages) >= threshold;
    },
    refreshHints: data => (data.nextResetTime ? [data.nextResetTime] : [])
};
