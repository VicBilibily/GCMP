import { ModelOverride, ProviderConfig, ProviderOverride } from '../types/sharedTypes';

export interface KnownProviderConfig extends Partial<ProviderConfig & ProviderOverride> {
    /** 针对 OpenAI SDK 的兼容策略 */
    openai?: Omit<ModelOverride, 'id'>;
    /** 针对 Anthropic SDK 的兼容策略 */
    anthropic?: Omit<ModelOverride, 'id'>;
}

/**
 * 内置已知的提供商及部分适配信息
 *
 * 模型配置合并时，优先级：模型配置 > 提供商配置 > 已知提供商配置
 * 已处理的合并参数包括：
 *   - customHeader,
 *   - override.extraBody
 *
 * @static
 * @type {(Record<string, KnownProviderConfig>)}
 * @memberof CompatibleModelManager
 */
export const KnownProviders: Record<string, KnownProviderConfig> = {
    aihubmix: {
        displayName: 'AIHubMix',
        customHeader: { 'APP-Code': 'TFUV4759' },
        openai: {
            baseUrl: 'https://aihubmix.com/v1'
        },
        anthropic: {
            baseUrl: 'https://aihubmix.com',
            extraBody: {
                top_p: null
            }
        }
    },
    aiping: { displayName: 'AIPing' },
    modelscope: { displayName: '魔搭社区' },
    openrouter: { displayName: 'OpenRouter' },
    siliconflow: { displayName: '硅基流动' },
    tbox: { displayName: '百灵大模型' },
    mistral: { displayName: 'MistralAI' }
};
