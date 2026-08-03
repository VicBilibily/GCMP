import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';

export function applyOpenAIServiceTier(
    requestBody: Record<string, unknown>,
    modelConfig: Pick<ModelConfig, 'serviceTier'>,
    settings?: Pick<ModelChatResponseOptions, 'serviceTier'>,
    providerKey?: string
): void {
    const serviceTier = settings?.serviceTier;
    if (!modelConfig.serviceTier?.length || !serviceTier) {
        return;
    }

    const isSupported = modelConfig.serviceTier.includes(serviceTier);
    if (providerKey === 'compatible') {
        // compatible 通道透传：三方端点的服务等级枚举未必遵循官方值（如 scale/fast 或网关
        // 自定义值），模型声明了什么就原样发送什么；未声明的陈旧值删除，避免误发。
        if (isSupported) {
            requestBody.service_tier = serviceTier;
        } else {
            delete requestBody.service_tier;
        }
        return;
    }

    if ((serviceTier === 'priority' || serviceTier === 'flex') && isSupported) {
        requestBody.service_tier = serviceTier;
    } else {
        delete requestBody.service_tier;
    }
}
