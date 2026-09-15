import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommandCodeModels } from '../adapters/commandcode';
import { parseHyperModels } from '../adapters/hyper';
import { parseOpenAiModelList } from '../adapters/openai-model-list';

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
