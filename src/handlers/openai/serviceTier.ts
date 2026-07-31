import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';

export function applyOpenAIServiceTier(
    requestBody: Record<string, unknown>,
    modelConfig: Pick<ModelConfig, 'serviceTier'>,
    settings?: Pick<ModelChatResponseOptions, 'serviceTier'>
): void {
    const serviceTier = settings?.serviceTier;
    if (!modelConfig.serviceTier?.length || !serviceTier) {
        return;
    }

    if ((serviceTier === 'priority' || serviceTier === 'flex') && modelConfig.serviceTier.includes(serviceTier)) {
        requestBody.service_tier = serviceTier;
    } else {
        delete requestBody.service_tier;
    }
}
