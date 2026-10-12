import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';

/**
 * 官方通道允许转发的服务等级：
 * - priority / fast：同一 Fast 模式（priority 为旧名，GPT-6 起官方回执为 fast）
 * - ultrafast：受限开放的超高速模式（GPT-6 Astra / GPT-6.1 Sol）
 * - flex：低价弹性处理
 * 其余值（default、auto 等）代表"不指定"，命中时删除字段回退官方默认。
 */
const FORWARDABLE_SERVICE_TIERS = new Set(['priority', 'fast', 'ultrafast', 'flex']);

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

    if (FORWARDABLE_SERVICE_TIERS.has(serviceTier) && isSupported) {
        requestBody.service_tier = serviceTier;
    } else {
        delete requestBody.service_tier;
    }
}
