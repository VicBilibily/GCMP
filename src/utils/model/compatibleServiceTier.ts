export const OPENAI_COMPATIBLE_SERVICE_TIERS = ['default', 'auto', 'flex', 'priority'] as const;
export const ANTHROPIC_COMPATIBLE_SERVICE_TIERS = ['standard_only', 'auto'] as const;

export type OpenAICompatibleServiceTier = (typeof OPENAI_COMPATIBLE_SERVICE_TIERS)[number];
export type AnthropicCompatibleServiceTier = (typeof ANTHROPIC_COMPATIBLE_SERVICE_TIERS)[number];
export type CompatibleServiceTier = OpenAICompatibleServiceTier | AnthropicCompatibleServiceTier;
export type CompatibleSdkMode = 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses';

export function getCompatibleServiceTierOptions(
    sdkMode?: CompatibleSdkMode
): readonly CompatibleServiceTier[] {
    return sdkMode === 'anthropic' ? ANTHROPIC_COMPATIBLE_SERVICE_TIERS : OPENAI_COMPATIBLE_SERVICE_TIERS;
}

export function normalizeCompatibleServiceTiers(
    serviceTiers: unknown,
    sdkMode?: CompatibleSdkMode
): CompatibleServiceTier[] | undefined {
    if (!Array.isArray(serviceTiers)) {
        return undefined;
    }

    const isAnthropic = sdkMode === 'anthropic';
    const allowed = new Set<CompatibleServiceTier>(getCompatibleServiceTierOptions(sdkMode));
    const normalized: CompatibleServiceTier[] = [];

    for (const value of serviceTiers) {
        if (typeof value !== 'string') {
            continue;
        }

        const tier =
            isAnthropic && value === 'default' ? 'standard_only'
            : isAnthropic && value === 'priority' ? 'auto'
            : (value as CompatibleServiceTier);
        if (allowed.has(tier) && !normalized.includes(tier)) {
            normalized.push(tier);
        }
    }

    return normalized.length > 0 ? normalized : undefined;
}
