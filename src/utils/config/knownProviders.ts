import { ModelOverride, ProviderConfig, ProviderOverride } from '../../types/sharedTypes';

/**
 * 已知提供商配置
 * 包含 ProviderConfig 与 ProviderOverride 的可选字段，及针对 SDK 的兼容策略
 */
export interface KnownProviderConfig extends Partial<ProviderConfig & ProviderOverride> {
    /** 针对 OpenAI SDK 的兼容策略 */
    openai?: Omit<ModelOverride, 'id'>;
    /** 针对 Anthropic SDK 的兼容策略 */
    anthropic?: Omit<ModelOverride, 'id'>;
}

/**
 * 解析内置 provider 配置：InnerProviders 优先合并 KnownProviders。
 * KnownProviders 中有同名条目时，InnerProviders 的 usage/displayName 覆盖之。
 */
export function resolveBuiltinProviderConfig(providerId: string): KnownProviderConfig | undefined {
    const inner = InnerProviders[providerId];
    const known = KnownProviders[providerId];
    if (!inner && !known) {
        return undefined;
    }

    return {
        ...known,
        ...inner
    };
}

/**
 * 预置余额查询配置
 * 无需配置对应模型即会被 Compatible 状态栏加入查询队列（见 CompatibleStatusBar.getConfiguredProviderEntries）
 */
export const InnerProviders: Record<string, Pick<KnownProviderConfig, 'displayName' | 'usage'>> = {
    hyper: {
        displayName: 'Charm Hyper',
        usage: {
            url: 'https://hyper.charm.land/v1/credits',
            errorMessagePath: 'error.message',
            unit: 'USD',
            fields: {
                balance: {
                    operation: 'divide',
                    paths: ['balance', 20] // Charm Hyper 的 Credits 价值为 $5/100Credits
                }
            }
        }
    }
};

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
    // micuapi: {
    //     displayName: '米醋API',
    //     usage: {
    //         url: 'https://www.micuapi.ai/api/user/self', // NewApi 个人信息查询接口
    //         authType: 'none', // 设置为 none，表示不使用任何内置的认证方式，而是使用自定义的请求验证信息
    //         headers: {
    //             'New-Api-User': '1234', // 个人设置中显示的ID
    //             Authorization: 'Bearer xxxx' // xxxx 为个人设置中的安全设置选项卡中生成的系统访问令牌
    //         },
    //         unit: 'RMB',
    //         fields: {
    //             balance: {
    //                 operation: 'divide',
    //                 paths: ['data.quota', 500000]
    //             }
    //         }
    //     }
    // },
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
