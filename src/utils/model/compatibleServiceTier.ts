export const OPENAI_COMPATIBLE_SERVICE_TIERS = ['default', 'auto', 'flex', 'priority'] as const;
export const ANTHROPIC_COMPATIBLE_SERVICE_TIERS = ['standard_only', 'auto'] as const;

export type CompatibleSdkMode = 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses';

/**
 * 各 sdkMode 下常见的服务等级建议值，仅用于模型编辑器勾选项与 settings.json 自动补全。
 * anthropic 端点除官方 standard_only/auto 外，还包含 MiniMax 等三方端点使用的 default/priority。
 * 注意：compatible 通道对服务等级采取透传策略（选中值原样发送），此列表不是白名单。
 */
export function getCompatibleServiceTierOptions(sdkMode?: CompatibleSdkMode): readonly string[] {
    return sdkMode === 'anthropic' ?
            [...ANTHROPIC_COMPATIBLE_SERVICE_TIERS, 'default', 'priority']
        :   OPENAI_COMPATIBLE_SERVICE_TIERS;
}

/**
 * 归一化服务等级列表：过滤非字符串与空值、保序去重。
 * 不做任何值映射——三方端点并不都遵循官方枚举（如 MiniMax anthropic 端点使用
 * default/priority），旧配置中的任意端点私有值都应原样保留并原样发送。
 */
export function normalizeCompatibleServiceTiers(serviceTiers: unknown): string[] | undefined {
    if (!Array.isArray(serviceTiers)) {
        return undefined;
    }

    const normalized: string[] = [];
    for (const value of serviceTiers) {
        if (typeof value === 'string' && value && !normalized.includes(value)) {
            normalized.push(value);
        }
    }

    return normalized.length > 0 ? normalized : undefined;
}
