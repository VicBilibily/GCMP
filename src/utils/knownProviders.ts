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
            baseUrl: 'https://api.inferera.com/v1'
        },
        anthropic: {
            baseUrl: 'https://api.inferera.com',
            extraBody: {
                top_p: null
            }
        }
    },
    aiping: {
        displayName: 'AIPing',
        openai: {
            baseUrl: 'https://aiping.cn/api/v1'
        }
    },
    openrouter: {
        displayName: 'OpenRouter',
        openai: {
            baseUrl: 'https://openrouter.ai/api/v1'
        },
        anthropic: {
            baseUrl: 'https://openrouter.ai/api'
        }
    },
    siliconflow: {
        displayName: 'SiliconFlow',
        openai: {
            baseUrl: 'https://api.siliconflow.cn/v1'
        },
        anthropic: {
            baseUrl: 'https://api.siliconflow.cn/'
        }
    },
    mistral: {
        displayName: 'MistralAI',
        openai: {
            baseUrl: 'https://api.mistral.ai/v1'
        }
    }
};
