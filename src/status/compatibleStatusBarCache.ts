import type { CompatibleProviderBalance } from './compatibleStatusBar';

export interface CompatibleProviderCacheData {
    balance: CompatibleProviderBalance;
    timestamp: number;
}

export function getCompatibleProviderCacheUpdate(
    existingCache: CompatibleProviderCacheData | undefined,
    provider: CompatibleProviderBalance,
    fallbackTimestamp: number
): CompatibleProviderCacheData | undefined {
    const providerTimestamp = new Date(provider.lastUpdated).getTime();
    const cacheTimestamp = Number.isFinite(providerTimestamp) ? providerTimestamp : fallbackTimestamp;
    if (!provider.success) {
        return undefined;
    }
    if (existingCache && existingCache.timestamp >= cacheTimestamp) {
        return undefined;
    }

    return {
        balance: {
            ...provider,
            lastUpdated: Number.isFinite(providerTimestamp) ? new Date(providerTimestamp) : provider.lastUpdated
        },
        timestamp: cacheTimestamp
    };
}
