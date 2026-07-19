import { ModelOverride, ProviderConfig, ProviderOverride } from '../../types/sharedTypes';

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
        usage: {
            url: 'https://aiping.cn/api/v1/user/remain/points',
            successConditions: [{ path: 'code', equals: 0 }],
            errorMessagePath: 'msg',
            fields: {
                balance: 'data.total_remain',
                paid: 'data.recharge_remain',
                granted: 'data.gift_remain'
            },
            unit: 'CNY'
        },
        openai: {
            baseUrl: 'https://aiping.cn/api/v1'
        }
    },
    openrouter: {
        displayName: 'OpenRouter',
        usage: {
            url: 'https://openrouter.ai/api/v1/credits',
            fields: {
                balance: {
                    operation: 'subtract',
                    paths: ['data.total_credits', 'data.total_usage'],
                    treatMissingAsZero: true
                }
            },
            unit: 'USD'
        },
        openai: {
            baseUrl: 'https://openrouter.ai/api/v1'
        },
        anthropic: {
            baseUrl: 'https://openrouter.ai/api'
        }
    },
    siliconflow: {
        displayName: 'SiliconFlow',
        usage: {
            url: 'https://api.siliconflow.cn/v1/user/info',
            successConditions: [
                { path: 'code', equals: 20000 },
                { path: 'status', equals: true }
            ],
            errorMessagePath: 'message',
            fields: {
                balance: 'data.totalBalance',
                paid: 'data.chargeBalance',
                granted: 'data.balance'
            },
            unit: 'CNY'
        },
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
