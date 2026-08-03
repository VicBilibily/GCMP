import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';
import { ANTHROPIC_COMPATIBLE_SERVICE_TIERS } from '../../utils/model/compatibleServiceTier';

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
        if (
            ANTHROPIC_COMPATIBLE_SERVICE_TIERS.includes(
                serviceTier as (typeof ANTHROPIC_COMPATIBLE_SERVICE_TIERS)[number]
            ) &&
            modelConfig.serviceTier.includes(serviceTier)
        ) {
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
