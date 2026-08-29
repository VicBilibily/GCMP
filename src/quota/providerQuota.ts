/*---------------------------------------------------------------------------------------------
 *  Provider 配额查询与格式化（共享层）- 调度入口
 *  queryProviderQuota 按 slot 分发到 ./providers 下各 provider 实现；
 *  通用工具见 ./common；各 provider 的 format/query 见 ./providers/*。
 *--------------------------------------------------------------------------------------------*/

import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { t } from '../utils/runtime/l10n';
import type { QuotaQueryResult } from './types';

// 通用工具
export * from './common';
// 各 provider 实现
export * from './providers';
// 类型
export type { QuotaTable, QuotaQueryResult } from './types';

// ============= 调度入口 =============

export async function queryProviderQuota(
    slot: string,
    apiKey: string,
    site: string | undefined,
    lastUpdated: string
): Promise<QuotaQueryResult> {
    switch (slot) {
        case 'zhipu': {
            const { queryZhipuQuota } = await import('./providers/zhipu');
            return await queryZhipuQuota(apiKey, site, lastUpdated);
        }
        case 'minimax-token': {
            const { queryMiniMaxQuota } = await import('./providers/minimax');
            return await queryMiniMaxQuota(apiKey, site, lastUpdated);
        }
        case 'moonshot': {
            const { queryMoonshotQuota } = await import('./providers/moonshot');
            return await queryMoonshotQuota(apiKey, lastUpdated);
        }
        case 'deepseek': {
            const { queryDeepSeekQuota } = await import('./providers/deepseek');
            return await queryDeepSeekQuota(apiKey, lastUpdated);
        }
        case 'kimi': {
            const { queryKimiQuota } = await import('./providers/kimi');
            return await queryKimiQuota(apiKey, lastUpdated);
        }
        case 'clinepass': {
            const { queryClinePassQuota } = await import('./providers/clinepass');
            return await queryClinePassQuota(apiKey, lastUpdated);
        }
        case 'opencode': {
            const { queryOpenCodeQuota } = await import('./providers/opencode');
            return await queryOpenCodeQuota(apiKey, lastUpdated);
        }
        case 'commandcode': {
            const { queryCommandCodeQuota } = await import('./providers/commandcode');
            return await queryCommandCodeQuota(apiKey, lastUpdated);
        }
        default:
            if (BalanceQueryManager.hasHandler(slot) || BalanceQueryManager.hasCustomUsageEntries(slot)) {
                const { queryCompatibleProviderQuota } = await import('./providers/compatible');
                return await queryCompatibleProviderQuota(slot, apiKey, lastUpdated);
            }
            throw new Error(t('Remaining quota query is not supported for this slot.', '该槽位暂不支持剩余额度查询。'));
    }
}
