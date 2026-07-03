import type { ProviderOverride, ProviderUsageConfig, ProviderUsageOverrideConfig } from '../../types/sharedTypes';

export const CUSTOM_USAGE_ENTRY_SEPARATOR = '::';

export interface ResolvedCustomUsageEntry {
    id: string;
    baseProviderId: string;
    usageKey: string;
    usageConfig: ProviderUsageConfig;
}

export function parseCustomUsageTarget(providerId: string): { baseProviderId: string; usageKey?: string } {
    const separatorIndex = providerId.indexOf(CUSTOM_USAGE_ENTRY_SEPARATOR);
    if (separatorIndex < 0) {
        return { baseProviderId: providerId };
    }

    return {
        baseProviderId: providerId.slice(0, separatorIndex),
        usageKey: providerId.slice(separatorIndex + CUSTOM_USAGE_ENTRY_SEPARATOR.length)
    };
}

export function resolveCustomUsageEntries(
    baseProviderId: string,
    override: ProviderOverride | undefined
): ResolvedCustomUsageEntry[] {
    if (!override) {
        return [];
    }

    const entries: ResolvedCustomUsageEntry[] = [];
    const usageDefaults = override.usage;
    const usages = override.usages;
    const usageEntries = Object.entries(usages || {});
    const defaultUsageConfig = resolveUsageConfig(undefined, usageDefaults);

    if (usageEntries.length > 0) {
        const resolvedUsageEntries: ResolvedCustomUsageEntry[] = [];

        for (const [usageKey, usageOverride] of usageEntries) {
            const mergedConfig = resolveUsageConfig(usageDefaults, usageOverride);
            if (!mergedConfig) {
                continue;
            }

            resolvedUsageEntries.push({
                id: `${baseProviderId}${CUSTOM_USAGE_ENTRY_SEPARATOR}${usageKey}`,
                baseProviderId,
                usageKey,
                usageConfig: mergedConfig
            });
        }

        const hasEquivalentNamedDefault =
            defaultUsageConfig !== undefined &&
            resolvedUsageEntries.some(entry => areEquivalentUsageConfigs(entry.usageConfig, defaultUsageConfig));

        if (defaultUsageConfig && !hasEquivalentNamedDefault) {
            entries.push({
                id: `${baseProviderId}${CUSTOM_USAGE_ENTRY_SEPARATOR}default`,
                baseProviderId,
                usageKey: 'default',
                usageConfig: defaultUsageConfig
            });
        }

        entries.push(...resolvedUsageEntries);
        return entries;
    }

    if (defaultUsageConfig) {
        entries.push({
            id: `${baseProviderId}${CUSTOM_USAGE_ENTRY_SEPARATOR}default`,
            baseProviderId,
            usageKey: 'default',
            usageConfig: defaultUsageConfig
        });
    }

    return entries;
}

export function resolveUsageConfig(
    baseUsage: ProviderUsageConfig | undefined,
    usageOverride: ProviderUsageConfig | ProviderUsageOverrideConfig | undefined
): ProviderUsageConfig | undefined {
    if (!baseUsage && !usageOverride) {
        return undefined;
    }

    const mergedFields = {
        ...(baseUsage?.fields || {}),
        ...(usageOverride?.fields || {})
    };

    const mergedConfig = {
        displayName: usageOverride?.displayName ?? baseUsage?.displayName,
        url: usageOverride?.url ?? baseUsage?.url,
        method: usageOverride?.method ?? baseUsage?.method,
        authType: usageOverride?.authType ?? baseUsage?.authType,
        headers: mergeRecord(baseUsage?.headers, usageOverride?.headers),
        params: mergeRecord(baseUsage?.params, usageOverride?.params),
        body: mergeRecord(baseUsage?.body, usageOverride?.body),
        fields: mergedFields,
        unit: usageOverride?.unit ?? baseUsage?.unit
    };

    return isCompleteUsageConfig(mergedConfig) ? mergedConfig : undefined;
}

function isCompleteUsageConfig(
    config: Omit<Partial<ProviderUsageConfig>, 'fields'> & { fields?: Partial<ProviderUsageConfig['fields']> }
): config is ProviderUsageConfig {
    return typeof config.url === 'string' && config.url.length > 0 && typeof config.fields?.balance === 'string';
}

function areEquivalentUsageConfigs(left: ProviderUsageConfig, right: ProviderUsageConfig): boolean {
    return (
        left.url === right.url &&
        (left.method ?? 'GET') === (right.method ?? 'GET') &&
        (left.authType ?? 'bearer') === (right.authType ?? 'bearer') &&
        (left.unit ?? 'USD') === (right.unit ?? 'USD') &&
        JSON.stringify(left.headers || {}) === JSON.stringify(right.headers || {}) &&
        JSON.stringify(left.params || {}) === JSON.stringify(right.params || {}) &&
        JSON.stringify(left.body || {}) === JSON.stringify(right.body || {}) &&
        JSON.stringify(left.fields) === JSON.stringify(right.fields)
    );
}

function mergeRecord<T extends Record<string, unknown> | undefined>(baseRecord: T, overrideRecord: T): T {
    if (!baseRecord && !overrideRecord) {
        return undefined as T;
    }

    return {
        ...(baseRecord || {}),
        ...(overrideRecord || {})
    } as T;
}
