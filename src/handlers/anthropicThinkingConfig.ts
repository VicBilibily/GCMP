/** 统一处理 Anthropic 的 thinking / output_config，兼容 auto 透传、enabled 最小预算和 effort 保留。 */

import Anthropic from '@anthropic-ai/sdk';
import type { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';

type AnthropicThinking = Anthropic.MessageCreateParamsStreaming['thinking'];
type AnthropicOutputConfig = Anthropic.MessageCreateParamsStreaming['output_config'];
type AnthropicThinkingType = NonNullable<AnthropicThinking>['type'];
type CompatibleThinkingType = AnthropicThinkingType | Extract<RequestedThinkingType, 'auto'>;
type AnthropicOutputEffort = Exclude<NonNullable<Anthropic.Messages.OutputConfig['effort']>, null>;
type RequestedThinkingType = NonNullable<ModelChatResponseOptions['thinking']>;
type RequestedReasoningEffort = NonNullable<ModelChatResponseOptions['reasoningEffort']>;
type ExistingThinking = {
    type?: string;
    display?: 'summarized' | 'omitted' | null;
    budget_tokens?: number | null;
} & Record<string, unknown>;
type ExistingOutputConfig = (Anthropic.Messages.OutputConfig & Record<string, unknown>) | undefined;

const ANTHROPIC_MIN_ENABLED_BUDGET_TOKENS = 1024;

interface ApplyAnthropicThinkingConfigurationOptions {
    disableThinking?: boolean;
}

export function applyAnthropicThinkingConfiguration(
    params: Pick<Anthropic.MessageCreateParamsStreaming, 'thinking' | 'output_config'>,
    settings: Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort'> | undefined,
    modelConfig: Pick<ModelConfig, 'thinking'>,
    options?: ApplyAnthropicThinkingConfigurationOptions
): void {
    if (settings?.thinking) {
        const requestedType = settings.thinking;
        params.thinking = buildThinkingConfig(requestedType, params.thinking);

        if (requestedType === 'adaptive') {
            params.output_config = mergeOutputConfigEffort(
                params.output_config,
                getOutputConfigEffort(params.output_config) ?? 'medium'
            );
        } else if (requestedType === 'disabled') {
            params.output_config = removeOutputConfigEffort(params.output_config);
        }
    } else if (settings?.reasoningEffort) {
        const effort = toAnthropicOutputEffort(settings.reasoningEffort);
        if (!effort) {
            params.thinking = { type: 'disabled' };
            params.output_config = removeOutputConfigEffort(params.output_config);
        } else {
            const currentType = normalizeThinkingType(params.thinking);
            const requestedType: CompatibleThinkingType =
                currentType === 'enabled' || currentType === 'adaptive' || currentType === 'auto' ? currentType
                : modelConfig.thinking?.includes('adaptive') === true ? 'adaptive'
                : 'enabled';
            params.thinking = buildThinkingConfig(requestedType, params.thinking);
            params.output_config = mergeOutputConfigEffort(params.output_config, effort);
        }
    }

    if (options?.disableThinking && (params.thinking || getOutputConfigEffort(params.output_config))) {
        params.thinking = { type: 'disabled' };
        params.output_config = removeOutputConfigEffort(params.output_config);
    }
}

function normalizeThinkingType(thinking: AnthropicThinking): CompatibleThinkingType | undefined {
    const type = (thinking as ExistingThinking | undefined)?.type;
    if (type === 'enabled' || type === 'adaptive' || type === 'disabled' || type === 'auto') {
        return type;
    }
    return undefined;
}

function buildThinkingConfig(
    targetType: CompatibleThinkingType,
    currentThinking: AnthropicThinking
): AnthropicThinking {
    if (targetType === 'disabled') {
        return { type: 'disabled' };
    }

    const currentType = normalizeThinkingType(currentThinking);
    const nextThinking: ExistingThinking = currentThinking ? { ...(currentThinking as ExistingThinking) } : {};
    nextThinking.type = targetType;

    if (targetType === 'enabled') {
        const budgetTokens = typeof nextThinking.budget_tokens === 'number' ? nextThinking.budget_tokens : undefined;
        if (budgetTokens !== undefined && budgetTokens < ANTHROPIC_MIN_ENABLED_BUDGET_TOKENS) {
            nextThinking.budget_tokens = ANTHROPIC_MIN_ENABLED_BUDGET_TOKENS;
        } else if (budgetTokens === undefined && currentType !== 'enabled') {
            nextThinking.budget_tokens = ANTHROPIC_MIN_ENABLED_BUDGET_TOKENS;
        }
    } else {
        delete nextThinking.budget_tokens;
    }

    return nextThinking as AnthropicThinking;
}

function mergeOutputConfigEffort(
    outputConfig: AnthropicOutputConfig,
    effort: AnthropicOutputEffort
): AnthropicOutputConfig {
    return {
        ...(outputConfig as ExistingOutputConfig),
        effort
    } as AnthropicOutputConfig;
}

function removeOutputConfigEffort(outputConfig: AnthropicOutputConfig): AnthropicOutputConfig {
    if (!outputConfig) {
        return undefined;
    }

    const nextOutputConfig: Record<string, unknown> = { ...(outputConfig as ExistingOutputConfig) };
    delete nextOutputConfig.effort;

    return Object.entries(nextOutputConfig).some(([, value]) => value !== undefined) ?
            (nextOutputConfig as AnthropicOutputConfig)
        :   undefined;
}

function getOutputConfigEffort(outputConfig: AnthropicOutputConfig): AnthropicOutputEffort | undefined {
    const effort = (outputConfig as ExistingOutputConfig)?.effort;
    switch (effort) {
        case 'low':
        case 'medium':
        case 'high':
        case 'max':
            return effort;
        default:
            return undefined;
    }
}

function toAnthropicOutputEffort(reasoningEffort: RequestedReasoningEffort): AnthropicOutputEffort | undefined {
    const effortMap: Record<RequestedReasoningEffort, AnthropicOutputEffort | undefined> = {
        none: undefined,
        minimal: undefined,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'max',
        max: 'max'
    };

    return effortMap[reasoningEffort];
}
