import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';
import { OPENAI_COMPATIBLE_SERVICE_TIERS } from '../../utils/model/compatibleServiceTier';

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
    if (
        providerKey === 'compatible' &&
        OPENAI_COMPATIBLE_SERVICE_TIERS.includes(
            serviceTier as (typeof OPENAI_COMPATIBLE_SERVICE_TIERS)[number]
        ) &&
        isSupported
    ) {
        requestBody.service_tier = serviceTier;
    } else if ((serviceTier === 'priority' || serviceTier === 'flex') && isSupported) {
        requestBody.service_tier = serviceTier;
    } else {
        delete requestBody.service_tier;
    }
}
