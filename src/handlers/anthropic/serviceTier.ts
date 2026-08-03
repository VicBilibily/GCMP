import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';

export function applyAnthropicServiceTier(
    requestBody: Record<string, unknown>,
    modelConfig: Pick<ModelConfig, 'serviceTier'>,
    settings?: Pick<ModelChatResponseOptions, 'serviceTier'>,
    providerKey?: string
): void {
    const serviceTier = settings?.serviceTier;
    if (!serviceTier) {
        return;
    }

    if (providerKey === 'compatible') {
        if (!modelConfig.serviceTier?.length) {
            return;
        }
        // compatible 通道透传：三方 anthropic 端点未必遵循官方枚举（如 MiniMax 使用
        // default/priority），模型声明了什么就原样发送什么；未声明的陈旧值删除。
        if (modelConfig.serviceTier.includes(serviceTier)) {
            requestBody.service_tier = serviceTier;
        } else {
            delete requestBody.service_tier;
        }
        return;
    }

    if (serviceTier === 'flex' || serviceTier === 'priority') {
        requestBody.service_tier = serviceTier;
    } else {
        delete requestBody.service_tier;
    }
}
