import type { ModelConfig } from '../types/sharedTypes';

export type MissingReasoningFieldPolicy = 'never' | 'tool-calls-only' | 'always';

export interface ReasoningReplayPolicy {
    restoreFromStatefulMarker: boolean;
    missingReasoningFieldPolicy: MissingReasoningFieldPolicy;
}

interface ReasoningReplayContext {
    providerKey?: string;
    modelConfig?: Partial<Pick<ModelConfig, 'baseUrl' | 'id' | 'model' | 'provider'>>;
}

export function getReasoningReplayPolicy(context: ReasoningReplayContext): ReasoningReplayPolicy {
    const providerKey = `${context.modelConfig?.provider || context.providerKey || ''}`.toLowerCase();
    const modelId = `${context.modelConfig?.model || context.modelConfig?.id || ''}`.toLowerCase();
    const baseUrl = `${context.modelConfig?.baseUrl || ''}`.toLowerCase();

    // DeepSeek V4 和 小米 MiMo 统一使用同一策略：
    // restoreFromStatefulMarker=true — VS Code 剥离 ThinkingPart 时从 StatefulMarker 恢复
    // missingReasoningFieldPolicy=always — 即使无 thinking 也注入空白占位符
    if (
        modelId.includes('deepseek-v4') ||
        providerKey === 'xiaomimimo' ||
        providerKey === 'xiaomimimo-token' ||
        modelId.startsWith('mimo-') ||
        modelId.includes('mimo-v') ||
        baseUrl.includes('xiaomimimo.com')
    ) {
        return {
            restoreFromStatefulMarker: true,
            missingReasoningFieldPolicy: 'always'
        };
    }

    return {
        restoreFromStatefulMarker: false,
        missingReasoningFieldPolicy: 'never'
    };
}

export function shouldInjectReasoningPlaceholder(
    policy: ReasoningReplayPolicy,
    hasToolCalls: boolean,
    markerHasToolCalls?: boolean
): boolean {
    if (policy.missingReasoningFieldPolicy === 'always') {
        return true;
    }

    if (policy.missingReasoningFieldPolicy === 'tool-calls-only') {
        return hasToolCalls || markerHasToolCalls === true;
    }

    return false;
}
