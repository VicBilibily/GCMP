import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import { configProviders } from '../providers/config';
import { applyAnthropicThinkingConfiguration } from './anthropicThinkingConfig';

type ThinkingParams = Pick<Anthropic.MessageCreateParamsStreaming, 'thinking' | 'output_config'>;

const adaptiveModel: Pick<ModelConfig, 'thinking'> = {
    thinking: ['enabled', 'adaptive']
};

const autoModel: Pick<ModelConfig, 'thinking'> = {
    thinking: ['auto']
};

const enabledOnlyModel: Pick<ModelConfig, 'thinking'> = {
    thinking: ['enabled']
};

const builtInAnthropicModels: ModelConfig[] = Object.values(configProviders).flatMap(provider =>
    provider.models.filter(model => model.sdkMode === 'anthropic')
);

function getExtraBodyThinking(
    model: Pick<ModelConfig, 'extraBody'>
): { type?: string; budget_tokens?: number } | undefined {
    return (model.extraBody as { thinking?: { type?: string; budget_tokens?: number } } | undefined)?.thinking;
}

const thinkingOptionModels = builtInAnthropicModels.filter(model => model.thinking?.length);
const reasoningOptionModels = builtInAnthropicModels.filter(model => model.reasoningEffort?.length);
const preconfiguredThinkingModels = builtInAnthropicModels.filter(model => Boolean(getExtraBodyThinking(model)?.type));
const passThroughAnthropicModels = builtInAnthropicModels.filter(
    model => !model.thinking && !model.reasoningEffort && !getExtraBodyThinking(model)?.type
);
const builtInThinkingOptions = Array.from(new Set(thinkingOptionModels.flatMap(model => model.thinking ?? []))).sort();

function applyConfig(
    params: ThinkingParams,
    settings: Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort'> | undefined,
    modelConfig: Pick<ModelConfig, 'thinking'>,
    options?: { disableThinking?: boolean }
): ThinkingParams {
    const nextParams: ThinkingParams = {
        thinking:
            params.thinking ?
                ({
                    ...(params.thinking as unknown as Record<string, unknown>)
                } as unknown as ThinkingParams['thinking'])
            :   undefined,
        output_config:
            params.output_config ?
                ({
                    ...(params.output_config as unknown as Record<string, unknown>)
                } as unknown as ThinkingParams['output_config'])
            :   undefined
    };

    applyAnthropicThinkingConfiguration(nextParams, settings, modelConfig, options);
    return nextParams;
}

function getInitialParamsFromModel(model: Pick<ModelConfig, 'extraBody'>): ThinkingParams {
    const extraBody = model.extraBody as
        | { thinking?: ThinkingParams['thinking']; output_config?: ThinkingParams['output_config'] }
        | undefined;
    return {
        thinking: extraBody?.thinking,
        output_config: extraBody?.output_config
    };
}

function toExpectedAnthropicEffort(
    reasoningEffort: NonNullable<ModelChatResponseOptions['reasoningEffort']>
): Anthropic.Messages.OutputConfig['effort'] | undefined {
    switch (reasoningEffort) {
        case 'none':
        case 'minimal':
            return undefined;
        case 'xhigh':
            return 'max';
        default:
            return reasoningEffort;
    }
}

function getExpectedThinkingTypeForReasoning(
    model: Pick<ModelConfig, 'thinking' | 'extraBody'>
): 'enabled' | 'adaptive' {
    const extraBodyThinking = (model.extraBody as { thinking?: { type?: string } } | undefined)?.thinking?.type;
    if (extraBodyThinking === 'enabled' || extraBodyThinking === 'adaptive') {
        return extraBodyThinking;
    }
    return model.thinking?.includes('adaptive') ? 'adaptive' : 'enabled';
}

function assertNoAnthropicBudgetTokensOutsideEnabled(params: ThinkingParams, label: string): void {
    const thinking = params.thinking as { type?: string; budget_tokens?: number } | undefined;
    if (thinking?.type !== 'enabled') {
        assert.equal(
            Object.prototype.hasOwnProperty.call(thinking ?? {}, 'budget_tokens'),
            false,
            `${label}: non-enabled thinking should not retain budget_tokens`
        );
    }
}

describe('applyAnthropicThinkingConfiguration', () => {
    it('显式 adaptive 会保留 format/display，补齐默认 effort，并移除 budget_tokens', () => {
        const format = {
            type: 'json_schema',
            schema: {
                answer: { type: 'string' }
            }
        };
        const params = applyConfig(
            {
                thinking: {
                    type: 'enabled',
                    display: 'omitted',
                    budget_tokens: 2048
                } as ThinkingParams['thinking'],
                output_config: {
                    format
                } as ThinkingParams['output_config']
            },
            { thinking: 'adaptive' },
            adaptiveModel
        );

        assert.deepEqual(params.thinking, {
            type: 'adaptive',
            display: 'omitted'
        });
        assert.deepEqual(params.output_config, {
            format,
            effort: 'medium'
        });
    });

    it('reasoningEffort=none 会关闭 thinking，但保留 output_config.format', () => {
        const format = {
            type: 'json_schema',
            schema: {
                answer: { type: 'string' }
            }
        };
        const params = applyConfig(
            {
                thinking: {
                    type: 'adaptive',
                    display: 'summarized'
                } as ThinkingParams['thinking'],
                output_config: {
                    effort: 'high',
                    format
                } as ThinkingParams['output_config']
            },
            { reasoningEffort: 'none' },
            adaptiveModel
        );

        assert.deepEqual(params.thinking, { type: 'disabled' });
        assert.deepEqual(params.output_config, { format });
    });

    it('reasoningEffort 会尊重 extraBody 里已有的 enabled+budget_tokens，同时合并 effort', () => {
        const format = {
            type: 'json_schema',
            schema: {
                answer: { type: 'string' }
            }
        };
        const params = applyConfig(
            {
                thinking: {
                    type: 'enabled',
                    display: 'summarized',
                    budget_tokens: 4096
                } as ThinkingParams['thinking'],
                output_config: {
                    format
                } as ThinkingParams['output_config']
            },
            { reasoningEffort: 'high' },
            adaptiveModel
        );

        assert.deepEqual(params.thinking, {
            type: 'enabled',
            display: 'summarized',
            budget_tokens: 4096
        });
        assert.deepEqual(params.output_config, {
            format,
            effort: 'high'
        });
    });

    it('子请求禁用思考时只移除 effort，不清空其他 output_config 字段', () => {
        const format = {
            type: 'json_schema',
            schema: {
                answer: { type: 'string' }
            }
        };
        const params = applyConfig(
            {
                output_config: {
                    effort: 'max',
                    format
                } as ThinkingParams['output_config']
            },
            undefined,
            adaptiveModel,
            { disableThinking: true }
        );

        assert.deepEqual(params.thinking, { type: 'disabled' });
        assert.deepEqual(params.output_config, { format });
    });

    it('thinking=auto 会原样透传，不做本地 adaptive/enabled 映射', () => {
        const params = applyConfig(
            {
                thinking: {
                    type: 'enabled',
                    display: 'summarized',
                    budget_tokens: 2048
                } as ThinkingParams['thinking']
            },
            { thinking: 'auto' },
            autoModel
        );

        assert.deepEqual(params.thinking, {
            type: 'auto',
            display: 'summarized'
        });
        assert.equal(params.output_config, undefined);
    });

    it('显式 enabled 在无预设预算时会补齐最小 budget_tokens', () => {
        const params = applyConfig({}, { thinking: 'enabled' }, enabledOnlyModel);

        assert.deepEqual(params.thinking, {
            type: 'enabled',
            budget_tokens: 1024
        });
        assert.equal(params.output_config, undefined);
    });

    it('reasoningEffort=xhigh 会映射为 Anthropic 支持的 max', () => {
        const params = applyConfig({}, { reasoningEffort: 'xhigh' }, adaptiveModel);

        assert.deepEqual(params.thinking, { type: 'adaptive' });
        assert.deepEqual(params.output_config, { effort: 'max' });
    });

    it('显式 disabled 会清理 effort，但保留 output_config 的其他字段', () => {
        const format = {
            type: 'json_schema',
            schema: {
                answer: { type: 'string' }
            }
        };
        const params = applyConfig(
            {
                thinking: {
                    type: 'enabled',
                    display: 'summarized',
                    budget_tokens: 2048
                } as ThinkingParams['thinking'],
                output_config: {
                    effort: 'high',
                    format
                } as ThinkingParams['output_config']
            },
            { thinking: 'disabled' },
            adaptiveModel
        );

        assert.deepEqual(params.thinking, { type: 'disabled' });
        assert.deepEqual(params.output_config, { format });
    });

    it('当前内置 Anthropic 模型 thinking 选项仅为 disabled/enabled', () => {
        assert.deepEqual(
            builtInThinkingOptions,
            ['disabled', 'enabled'],
            '如果未来新增 auto/adaptive 内置模型，需要同时补 strict Anthropic enabled/budget_tokens 兼容测试'
        );
    });

    it('当前所有内置 Anthropic 模型都落在受测兼容分支中', () => {
        assert.ok(builtInAnthropicModels.length > 0, 'expected built-in anthropic models to exist');

        const coveredModelIds = new Set<string>(
            [
                ...thinkingOptionModels,
                ...reasoningOptionModels,
                ...preconfiguredThinkingModels,
                ...passThroughAnthropicModels
            ].map(model => model.id)
        );

        const uncovered = builtInAnthropicModels.filter(model => !coveredModelIds.has(model.id));

        assert.deepEqual(
            uncovered.map(model => model.id),
            [],
            `uncovered anthropic models: ${uncovered.map(model => model.id).join(', ')}`
        );
    });

    it('无 thinking / reasoning 配置的内置 Anthropic 模型保持透传，不被 helper 误改', () => {
        assert.ok(passThroughAnthropicModels.length > 0, 'expected pass-through anthropic models');

        for (const model of passThroughAnthropicModels) {
            assert.deepEqual(
                applyConfig({}, undefined, model),
                { thinking: undefined, output_config: undefined },
                `${model.id}: no settings should remain untouched`
            );
            assert.deepEqual(
                applyConfig({}, undefined, model, { disableThinking: true }),
                { thinking: undefined, output_config: undefined },
                `${model.id}: sub-request disable should still remain untouched`
            );
        }
    });

    it('所有内置 Anthropic 模型声明的 thinking 选项都能生成兼容请求', () => {
        for (const model of thinkingOptionModels) {
            for (const thinkingOption of model.thinking ?? []) {
                const label = `${model.id} thinking=${thinkingOption}`;
                const params = applyConfig(getInitialParamsFromModel(model), { thinking: thinkingOption }, model);

                assert.ok(
                    thinkingOption === 'enabled' || thinkingOption === 'disabled',
                    `${label}: built-in anthropic thinking options should currently stay within enabled/disabled`
                );

                if (thinkingOption === 'disabled') {
                    assert.equal((params.thinking as { type?: string } | undefined)?.type, 'disabled', label);
                    assert.equal((params.output_config as { effort?: string } | undefined)?.effort, undefined, label);
                } else {
                    assert.equal((params.thinking as { type?: string } | undefined)?.type, 'enabled', label);

                    const initialThinkingType = (
                        getInitialParamsFromModel(model).thinking as { type?: string } | undefined
                    )?.type;
                    if (initialThinkingType !== 'enabled') {
                        assert.ok(
                            ((params.thinking as { budget_tokens?: number } | undefined)?.budget_tokens ?? 0) >= 1024,
                            `${label}: helper-enabled thinking should inject minimum budget_tokens for strict endpoints`
                        );
                    }
                }

                assertNoAnthropicBudgetTokensOutsideEnabled(params, label);
            }
        }
    });

    it('所有内置 Anthropic 模型声明的 reasoningEffort 选项都能生成兼容请求', () => {
        for (const model of reasoningOptionModels) {
            for (const reasoningEffort of model.reasoningEffort ?? []) {
                const label = `${model.id} reasoningEffort=${reasoningEffort}`;
                const params = applyConfig(getInitialParamsFromModel(model), { reasoningEffort }, model);
                const expectedEffort = toExpectedAnthropicEffort(reasoningEffort);

                if (!expectedEffort) {
                    assert.equal((params.thinking as { type?: string } | undefined)?.type, 'disabled', label);
                    assert.equal((params.output_config as { effort?: string } | undefined)?.effort, undefined, label);
                } else {
                    assert.equal(
                        (params.thinking as { type?: string } | undefined)?.type,
                        getExpectedThinkingTypeForReasoning(model),
                        label
                    );
                    assert.equal(
                        (params.output_config as { effort?: string } | undefined)?.effort,
                        expectedEffort,
                        label
                    );
                }

                assertNoAnthropicBudgetTokensOutsideEnabled(params, label);
            }
        }
    });

    it('所有带 extraBody.thinking 的内置 Anthropic 模型在无配置时保持原样，并可在子请求中安全关闭', () => {
        assert.ok(preconfiguredThinkingModels.length > 0, 'expected built-in anthropic models with extraBody.thinking');

        for (const model of preconfiguredThinkingModels) {
            const initialParams = getInitialParamsFromModel(model);
            const noopParams = applyConfig(initialParams, undefined, model);
            assert.deepEqual(
                noopParams,
                initialParams,
                `${model.id}: helper should preserve extraBody thinking when no settings are provided`
            );

            const disabledParams = applyConfig(initialParams, undefined, model, { disableThinking: true });
            assert.equal(
                (disabledParams.thinking as { type?: string } | undefined)?.type,
                'disabled',
                `${model.id}: sub-request should disable thinking`
            );
            assert.equal(
                (disabledParams.output_config as { effort?: string } | undefined)?.effort,
                undefined,
                `${model.id}: sub-request should clear effort`
            );
        }
    });

    it('所有内置 Anthropic 模型在启用思考后，子请求都能安全降级为 disabled', () => {
        for (const model of builtInAnthropicModels) {
            const reasoningOption = model.reasoningEffort?.find(option => option !== 'none' && option !== 'minimal');
            const thinkingOption = model.thinking?.find(option => option !== 'disabled');
            const settings =
                reasoningOption ?
                    ({ reasoningEffort: reasoningOption } satisfies Pick<ModelChatResponseOptions, 'reasoningEffort'>)
                : thinkingOption ? ({ thinking: thinkingOption } satisfies Pick<ModelChatResponseOptions, 'thinking'>)
                : undefined;

            const initialParams = applyConfig(getInitialParamsFromModel(model), settings, model);
            const hadThinking = Boolean(initialParams.thinking);
            const disabledParams = applyConfig(initialParams, undefined, model, { disableThinking: true });

            if (
                hadThinking ||
                (disabledParams.output_config as { effort?: string } | undefined)?.effort !== undefined
            ) {
                assert.equal(
                    (disabledParams.thinking as { type?: string } | undefined)?.type,
                    'disabled',
                    `${model.id}: sub-request should disable thinking`
                );
                assert.equal(
                    (disabledParams.output_config as { effort?: string } | undefined)?.effort,
                    undefined,
                    `${model.id}: sub-request should remove reasoning effort`
                );
                assertNoAnthropicBudgetTokensOutsideEnabled(disabledParams, `${model.id} sub-request disable`);
            }
        }
    });
});
