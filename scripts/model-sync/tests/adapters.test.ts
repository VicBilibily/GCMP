import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommandCodeModels } from '../adapters/commandcode';
import { parseHyperModels } from '../adapters/hyper';
import { parseModelsDevProviderModels } from '../adapters/models-dev';
import { parseOpenAiModelList } from '../adapters/openai-model-list';
import type { SourcePolicy } from '../types';

test('hyper 适配器解析完整元数据', () => {
    const raw = {
        object: 'list',
        data: [
            {
                id: 'deepseek-v4-flash',
                display_name: 'DeepSeek V4 Flash',
                context_window: 1000000,
                max_output_tokens: 384000,
                capabilities: { vision: false },
                reasoning: {
                    effort_levels: [
                        { value: 'high', display: 'High' },
                        { value: 'xhigh', display: 'X-High' }
                    ],
                    default_effort_level: 'high'
                },
                pricing: { input: 0.2, output: 0.4, cache_create: 0, cache_hit: 0.04 }
            }
        ]
    };
    const [model] = parseHyperModels(raw);
    assert.equal(model.id, 'deepseek-v4-flash');
    assert.equal(model.displayName, 'DeepSeek V4 Flash');
    assert.equal(model.contextWindow, 1000000);
    assert.equal(model.maxOutputTokens, 384000);
    assert.deepEqual(model.capabilities, { imageInput: false });
    assert.deepEqual(model.reasoning, { efforts: ['high', 'xhigh'], defaultEffort: 'high' });
    assert.deepEqual(model.pricing, { input: 0.2, output: 0.4, cacheRead: 0.04, cacheWrite: 0 });
});

test('hyper 适配器保留零价格与 false 能力', () => {
    const raw = {
        data: [
            {
                id: 'm',
                pricing: { input: 0, output: 0.5, cache_create: 0, cache_hit: 0 },
                capabilities: { vision: false }
            }
        ]
    };
    const [model] = parseHyperModels(raw);
    assert.equal(model.pricing?.input, 0);
    assert.equal(model.pricing?.cacheRead, 0);
    assert.equal(model.capabilities?.imageInput, false);
});

test('hyper 适配器拒绝未知推理档位与错误默认值', () => {
    assert.throws(
        () =>
            parseHyperModels({
                data: [{ id: 'm', reasoning: { effort_levels: [{ value: 'ultra' }] } }]
            }),
        /不支持的推理档位/
    );
    assert.throws(
        () =>
            parseHyperModels({
                data: [
                    {
                        id: 'm',
                        reasoning: { effort_levels: [{ value: 'low' }], default_effort_level: 'high' }
                    }
                ]
            }),
        /默认推理档位不在档位列表中/
    );
});

test('hyper 适配器拒绝空列表、重复 ID 与非法数值', () => {
    assert.throws(() => parseHyperModels({ data: [] }), /空模型列表/);
    assert.throws(() => parseHyperModels({ data: [{ id: 'a' }, { id: 'a' }] }), /重复模型 id/);
    assert.throws(() => parseHyperModels({ data: [{ id: 'a', context_window: 1.5 }] }), /必须是正整数/);
    assert.throws(() => parseHyperModels({ data: [{ id: 'a', pricing: { input: -1, output: 2 } }] }), /非负有限数值/);
});

test('hyper 适配器容忍缺失的可选字段', () => {
    const [model] = parseHyperModels({ data: [{ id: 'plain' }] });
    assert.deepEqual(model, { id: 'plain' });
});

test('openai 清单适配器只提取 ID', () => {
    const models = parseOpenAiModelList({ data: [{ id: 'a', created: 1 }, { id: 'b' }] }, 'Zen');
    assert.deepEqual(models, [{ id: 'a' }, { id: 'b' }]);
});

test('commandcode 适配器解析名称与上下文', () => {
    const raw = {
        data: [
            { id: 'moonshotai/Kimi-K3', name: 'Kimi K3', context_length: 1000000 },
            { id: 'xai/grok-4.6', name: 'Grok 4.6', context_length: 500000 }
        ]
    };
    const models = parseCommandCodeModels(raw);
    assert.deepEqual(models, [
        { id: 'moonshotai/Kimi-K3', displayName: 'Kimi K3', contextWindow: 1000000 },
        { id: 'xai/grok-4.6', displayName: 'Grok 4.6', contextWindow: 500000 }
    ]);
});

function devPolicy(provider?: string): SourcePolicy {
    return {
        adapter: 'models-dev',
        endpoint: 'https://models.dev/api.json',
        target: 'src/providers/config/clinepass.json',
        modelsDevProvider: provider
    };
}

test('models-dev 适配器按提供商键解析完整元数据', () => {
    const raw = {
        'cline-pass': {
            api: 'https://api.cline.bot/api/v1',
            models: {
                'cline-pass/glm-5.3-flash': {
                    id: 'cline-pass/glm-5.3-flash',
                    name: 'cline-pass/glm-5.3-flash',
                    reasoning: true,
                    reasoning_options: [
                        { type: 'effort', values: ['low', 'high', 'max'] },
                        { type: 'budget_tokens', values: ['ignored'] }
                    ],
                    tool_call: true,
                    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
                    limit: { context: 1000000, output: 131072 },
                    cost: { input: 0.15, output: 0.5, cache_read: 0.03 }
                },
                'cline-pass/mimo-v2.5': {
                    id: 'cline-pass/mimo-v2.5',
                    name: 'MiMo V2.5',
                    reasoning: true,
                    reasoning_options: [],
                    modalities: { input: ['text'], output: ['text'] },
                    limit: { context: 1048576, output: 131072 }
                }
            }
        },
        'other-provider': { models: { x: {} } }
    };
    const models = parseModelsDevProviderModels(raw, 'clinepass', devPolicy('cline-pass'));
    assert.equal(models.length, 2);
    const flash = models[0];
    assert.equal(flash.id, 'cline-pass/glm-5.3-flash');
    assert.equal(flash.displayName, undefined);
    assert.equal(flash.contextWindow, 1000000);
    assert.equal(flash.maxOutputTokens, 131072);
    assert.deepEqual(flash.capabilities, { imageInput: true });
    assert.deepEqual(flash.reasoning, { efforts: ['low', 'high', 'max'] });
    assert.equal(flash.pricing?.input, 0.15);
    assert.equal(flash.pricing?.output, 0.5);
    assert.equal(flash.pricing?.cacheRead, 0.03);
    assert.equal(flash.pricing?.cacheWrite, undefined);
    // 名称与 id 不同才作为显示名；空档位视为未声明；缺 cost 不产生定价
    const mimo = models[1];
    assert.equal(mimo.displayName, 'MiMo V2.5');
    assert.equal(mimo.reasoning, undefined);
    assert.equal(mimo.pricing, undefined);
});

test('models-dev 适配器缺少提供商键或载荷时拒绝', () => {
    assert.throws(() => parseModelsDevProviderModels({}, 'clinepass', devPolicy()), /缺少 modelsDevProvider/);
    assert.throws(
        () => parseModelsDevProviderModels({ 'cline-pass': {} }, 'clinepass', devPolicy('cline-pass')),
        /缺少 models 对象/
    );
    assert.throws(
        () => parseModelsDevProviderModels({ 'cline-pass': { models: {} } }, 'clinepass', devPolicy('cline-pass')),
        /空模型列表/
    );
});

test('models-dev 适配器拒绝不支持的推理档位', () => {
    const raw = {
        'cline-pass': {
            models: { m: { reasoning_options: [{ type: 'effort', values: ['ultra'] }] } }
        }
    };
    assert.throws(() => parseModelsDevProviderModels(raw, 'clinepass', devPolicy('cline-pass')), /不支持的推理档位/);
});
