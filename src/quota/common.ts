/*---------------------------------------------------------------------------------------------
 *  Provider 配额查询共享层 - 通用工具
 *  槽位能力判定；日期/货币/倒计时等纯格式化见 ./format。
 *---------------------------------------------------------------------------------------------*/

import { BalanceQueryManager } from './compatible/balanceQueryManager';
import { getSiteOwnerProvider, readCurrentSite } from '../utils/config/configSetCommands';
import { t } from '../utils/runtime/l10n';

// 纯格式化工具（状态栏与面板共用）
export * from './format';

/** 支持配额/余额查询的内置槽位 */
const SUPPORTED_QUOTA_SLOTS = new Set([
    'zhipu',
    'minimax-token',
    'moonshot',
    'kimi',
    'deepseek',
    'clinepass',
    'opencode'
]);

// ============= 槽位能力判定 =============

export function isQuotaSupportedSlot(slot: string): boolean {
    return (
        SUPPORTED_QUOTA_SLOTS.has(slot) ||
        BalanceQueryManager.hasHandler(slot) ||
        BalanceQueryManager.hasCustomUsageEntries(slot)
    );
}

export function getQuotaMetricType(slot: string): 'usage' | 'balance' {
    if (
        slot === 'moonshot' ||
        slot === 'deepseek' ||
        BalanceQueryManager.hasHandler(slot) ||
        BalanceQueryManager.hasCustomUsageEntries(slot)
    ) {
        return 'balance';
    }
    return 'usage';
}

export function getQuotaMetricLabel(slot: string): string {
    return getQuotaMetricType(slot) === 'balance' ? t('balance', '余额') : t('remaining quota', '剩余额度');
}

export function resolveQuotaSite(slot: string, site: string | undefined): string | undefined {
    const siteProvider = getSiteOwnerProvider(slot);
    return site ?? (siteProvider ? readCurrentSite(siteProvider) : undefined);
}
