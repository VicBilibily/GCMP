/*---------------------------------------------------------------------------------------------
 *  自定义 compatible provider 余额查询与格式化
 *  通过 BalanceQueryManager 查询注册的自定义余额条目。
 *---------------------------------------------------------------------------------------------*/

import { BalanceQueryManager } from '../compatible/balanceQueryManager';
import { t } from '../../utils/runtime/l10n';
import { formatCompatibleBalanceValue } from '../common';
import type { QuotaQueryResult, QuotaTable } from '../types';

/** BalanceQueryManager.queryBalance 返回的余额查询结果 */
interface BalanceQueryResult {
    balance: number;
    currency: string;
    paid?: number;
    granted?: number;
}

/** 单个余额条目的格式化结果 */
interface QuotaEntryResult {
    label?: string;
    summary: string;
    tables?: QuotaTable[];
}

export function formatCompatibleQuotaEntry(entryId: string, result: BalanceQueryResult): QuotaEntryResult {
    const label = BalanceQueryManager.getCustomUsageDisplayName(entryId);
    const summary = formatCompatibleBalanceValue(result.balance, result.currency);
    const tables =
        result.paid !== undefined || result.granted !== undefined ?
            [
                {
                    columns: [t('Paid', '充值余额'), t('Granted', '赠金余额'), t('Available', '可用余额')],
                    rows: [
                        [
                            formatCompatibleBalanceValue(result.paid, result.currency),
                            formatCompatibleBalanceValue(result.granted, result.currency),
                            formatCompatibleBalanceValue(result.balance, result.currency)
                        ]
                    ]
                }
            ]
        :   undefined;
    return { label, summary, tables };
}

export async function queryCompatibleProviderQuota(
    slot: string,
    apiKey: string,
    lastUpdated: string
): Promise<QuotaQueryResult> {
    const entryIds = BalanceQueryManager.getRegisteredProvidersForBaseProvider(slot);
    const results = await Promise.all(
        entryIds.map(async entryId => {
            const result = await BalanceQueryManager.queryBalance(entryId, apiKey);
            return formatCompatibleQuotaEntry(entryId, result);
        })
    );

    return {
        metricType: 'balance',
        summary:
            results.length === 1 && !results[0].label ?
                results[0].summary
            :   t('{0} balance entries', '{0} 项余额', results.length),
        tables: results.length === 1 && !results[0].label ? results[0].tables : undefined,
        quotaEntries: results,
        lastUpdated
    };
}
