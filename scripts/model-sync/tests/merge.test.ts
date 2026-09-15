import assert from 'node:assert/strict';
import test from 'node:test';
import { planSource, resolveRef, sourceBaseUrl, validateModelDefaults } from '../merge';
import type { ModelDefaultsFile, ProviderConfigFile, RemoteModelMetadata, SourcePolicy } from '../types';

const defaults: ModelDefaultsFile = {
    moonshotai: {
        'kimi-k3': {
            name: 'Kimi-K3',
            contextSize: [1000000, 512000, 400000, 256000, 192000],
            maxInputTokens: 936000,
            maxOutputTokens: 64000,
            reasoningEffort: ['max', 'high', 'low'],
            capabilities: { toolCalling: true, imageInput: true }
        }
    },
    openai: {
        'gpt-5.5': {
            name: 'GPT-5.5',
            maxInputTokens: 272000,
            maxOutputTokens: 128000,
            reasoningEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
            capabilities: { toolCalling: true, imageInput: true }
        }
    }
};

function makePolicy(overrides: Partial<SourcePolicy> = {}): SourcePolicy {
    return {
        adapter: 'openai-model-list',
        endpoint: 'https://example.com/v1/models',
        target: 'src/providers/config/example.json',
        ...overrides
    };
}

function makeConfig(models: ProviderConfigFile['models'], baseUrl = 'https://example.com/v1'): ProviderConfigFile {
    return { displayName: 'Example', baseUrl, models };
}

test('sourceBaseUrl 去除末尾 models 与斜杠', () => {
    assert.equal(sourceBaseUrl('https://a.com/v1/models'), 'https://a.com/v1');
    assert.equal(sourceBaseUrl('https://a.com/v1/models/'), 'https://a.com/v1');
});

test('resolveRef 按作者与模型精确解析', () => {
    assert.equal(resolveRef(defaults, 'moonshotai/kimi-k3')?.name, 'Kimi-K3');
    assert.equal(resolveRef(defaults, 'moonshotai/kimi-k4'), undefined);
    assert.equal(resolveRef(defaults, 'kimi-k3'), undefined);
});

test('变体继承基础模型并仅覆盖差异字段', () => {
    const withVariant: ModelDefaultsFile = {
        deepseek: {
            'deepseek-v4-flash': {
                name: 'DeepSeek-V4-Flash',
                contextSize: [1000000, 512000],
                maxInputTokens: 936000,
                maxOutputTokens: 64000,
                reasoningEffort: ['high', 'max', 'none'],
                capabilities: { toolCalling: true, imageInput: false }
            },
            'deepseek-v4-flash-fast': {
                variantOf: 'deepseek-v4-flash',
                name: 'DeepSeek-V4-Flash-Fast',
                reasoningEffort: ['high', 'max']
            }
        }
    };
    const resolved = resolveRef(withVariant, 'deepseek/deepseek-v4-flash-fast');
    assert.equal(resolved?.name, 'DeepSeek-V4-Flash-Fast');
    assert.deepEqual(resolved?.reasoningEffort, ['high', 'max']);
    assert.deepEqual(resolved?.contextSize, [1000000, 512000]);
    assert.equal(resolved?.maxInputTokens, 936000);
    assert.deepEqual(resolved?.capabilities, { toolCalling: true, imageInput: false });
    assert.equal(resolved?.variantOf, undefined);
});

test('默认源校验拒绝缺失基座与链式变体', () => {
    const broken: ModelDefaultsFile = {
        a: {
            base: { name: 'Base', maxInputTokens: 1000, maxOutputTokens: 100 },
            v1: { variantOf: 'base', name: 'V1' },
            v2: { variantOf: 'v1', name: 'V2' },
            v3: { variantOf: 'gone', name: 'V3' }
        }
    };
    const errors = validateModelDefaults(broken);
    assert.equal(errors.length, 2);
    assert.ok(errors.some(error => error.includes('链式变体')));
    assert.ok(errors.some(error => error.includes('不存在')));
    assert.equal(resolveRef(broken, 'a/v2'), undefined);
    assert.equal(resolveRef(broken, 'a/v1')?.maxInputTokens, 1000);
});

test('模板作为预算基线，条目字段优先', () => {
    const withTemplates: ModelDefaultsFile = {
        $templates: {
            '1m': {
                contextSize: [1000000, 512000],
                maxInputTokens: 936000,
                maxOutputTokens: 64000
            },
            vision: {
                capabilities: { toolCalling: true, imageInput: true }
            },
            lmh: {
                reasoningEffort: ['low', 'medium', 'high']
            }
        },
        deepseek: {
            'deepseek-v4-flash': {
                template: '1m',
                name: 'DeepSeek-V4-Flash',
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            },
            'deepseek-v4-flash-fast': {
                variantOf: 'deepseek-v4-flash',
                name: 'DeepSeek-V4-Flash-Fast'
            },
            'deepseek-v4.1-flash': {
                template: ['1m', 'vision', 'lmh'],
                name: 'DeepSeek-V4.1-Flash',
                reasoningDefault: 'medium'
            }
        }
    };
    const resolved = resolveRef(withTemplates, 'deepseek/deepseek-v4-flash');
    assert.deepEqual(resolved?.contextSize, [1000000, 512000]);
    assert.equal(resolved?.maxInputTokens, 936000);
    assert.equal(resolved?.maxOutputTokens, 32000);
    assert.equal(resolved?.template, undefined);
    // 变体经由基座间接继承模板
    const variant = resolveRef(withTemplates, 'deepseek/deepseek-v4-flash-fast');
    assert.equal(variant?.maxInputTokens, 936000);
    assert.equal(variant?.name, 'DeepSeek-V4-Flash-Fast');
    // 多模板按顺序叠加：预算、能力与推理档位来自不同模板
    const stacked = resolveRef(withTemplates, 'deepseek/deepseek-v4.1-flash');
    assert.equal(stacked?.maxInputTokens, 936000);
    assert.deepEqual(stacked?.capabilities, { toolCalling: true, imageInput: true });
    assert.deepEqual(stacked?.reasoningEffort, ['low', 'medium', 'high']);
    assert.equal(stacked?.reasoningDefault, 'medium');
    // 模板不允许被当作模型引用
    assert.equal(resolveRef(withTemplates, '$templates/1m'), undefined);
});

test('默认源校验拒绝缺失模板与模板嵌套', () => {
    const broken: ModelDefaultsFile = {
        $templates: { loop: { template: 'loop' } },
        a: { m: { template: 'missing', name: 'M' } }
    };
    const errors = validateModelDefaults(broken);
    assert.ok(errors.some(error => error.includes('不允许再引用模板')));
    assert.ok(errors.some(error => error.includes('不存在的模板')));
});

test('排除：本地存在时移除，无论远端是否仍存在', () => {
    const config = makeConfig([{ id: 'old-model', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 }]);
    const remote: RemoteModelMetadata[] = [{ id: 'old-model' }, { id: 'other' }];
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ excludedModelIds: ['old-model'] }),
        remote,
        config,
        defaults
    });
    assert.deepEqual(
        plan.entries.map(entry => [entry.action, entry.localId]),
        [['remove', 'old-model']]
    );
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：other')));
});

test('排除：仅远端存在时跳过新增，均不存在时报告未命中', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ excludedModelIds: ['remote-only', 'gone'] }),
        remote: [{ id: 'remote-only' }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.ok(plan.warnings.some(warning => warning.startsWith('排除跳过：remote-only')));
    assert.ok(plan.warnings.some(warning => warning.startsWith('排除未命中：gone')));
});

test('前缀排除：静默跳过新增，本地既有条目不受影响', () => {
    const config = makeConfig([
        { id: 'claude-old', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ excludedModelIdPrefixes: ['claude-', 'gpt-'] }),
        remote: [{ id: 'claude-new' }, { id: 'gpt-new' }, { id: 'kimi-k3' }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    // 前缀跳过不产生任何排除类警告；claude-old 远端缺失的保留警告仍按原逻辑出现
    assert.equal(plan.warnings.filter(warning => warning.startsWith('排除')).length, 0);
    assert.ok(plan.warnings.some(warning => warning.startsWith('远端缺失保留：claude-old')));
    // 非前缀命中模型仍走待配置
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：kimi-k3')));
});

test('前缀排除 $ 锚点：精确匹配不误伤同族模型', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ excludedModelIdPrefixes: ['glm-5$'] }),
        remote: [{ id: 'glm-5' }, { id: 'glm-5.3' }, { id: 'glm-5.3-flash' }],
        config,
        defaults
    });
    // glm-5 被静默跳过；glm-5.3 系列不受 $ 锚点影响，仍走待配置
    assert.equal(plan.warnings.filter(warning => warning.includes('待配置：glm-5（')).length, 0);
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：glm-5.3（')));
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：glm-5.3-flash（')));
});
test('前缀排除可被 models 手动登记覆盖', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            excludedModelIdPrefixes: ['gpt-'],
            defaults: { sdkMode: 'openai-sse' },
            models: { 'gpt-5.5': { ref: 'openai/gpt-5.5' } }
        }),
        remote: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6' }],
        config,
        defaults
    });
    // 手动登记的 gpt-5.5 照常新增；未登记的 gpt-5.6 静默跳过
    assert.ok(plan.entries.some(entry => entry.action === 'add' && entry.remoteId === 'gpt-5.5'));
    assert.equal(plan.warnings.filter(warning => warning.includes('gpt-5.6')).length, 0);
});
test('后缀排除：静默跳过新增，不误伤仅包含该子串的模型', () => {
    const config = makeConfig([
        { id: 'mimo-v2.5-free', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ excludedModelIdSuffixes: ['-free'] }),
        remote: [{ id: 'nemotron-3-ultra-free' }, { id: 'freedom-model' }, { id: 'kimi-k3' }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.warnings.filter(warning => warning.startsWith('排除')).length, 0);
    // 既有 -free 条目远端缺失时仍按原逻辑保留警告
    assert.ok(plan.warnings.some(warning => warning.startsWith('远端缺失保留：mimo-v2.5-free')));
    // 非后缀命中的模型不受影响
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：freedom-model（')));
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：kimi-k3（')));
    assert.equal(plan.warnings.filter(warning => warning.includes('待配置：nemotron-3-ultra-free（')).length, 0);
});

const placementDefaults: ModelDefaultsFile = {
    kimi: {
        'kimi-k2.5': { name: 'K2.5', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } }
    },
    zhipu: {
        'glm-5': { name: 'GLM-5', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } },
        'glm-5.1': { name: 'GLM-5.1', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } },
        'glm-5.4': { name: 'GLM-5.4', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } }
    },
    xai: {
        'grok-4.5': {
            name: 'Grok-4.5',
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            capabilities: { toolCalling: true }
        }
    },
    qwen: {
        'qwen3.5-plus': {
            name: 'Qwen3.5',
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            capabilities: { toolCalling: true }
        }
    },
    nova: {
        'nova-1': { name: 'Nova-1', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { toolCalling: true } }
    }
};

function placementPolicy(models: Record<string, { ref: string }>): SourcePolicy {
    return makePolicy({ localIdSuffix: '-go', defaults: { sdkMode: 'openai-sse' }, models });
}

test('新增定位：同族聚簇插入并保持版本降序', () => {
    const config = makeConfig([
        { id: 'grok-4.6-go', model: 'grok-4.6', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'glm-5.3-go', model: 'glm-5.3', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'glm-5.2-go', model: 'glm-5.2', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'kimi-k2.6-go', model: 'kimi-k2.6', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        {
            id: 'qwen3.6-plus-go',
            model: 'qwen3.6-plus',
            sdkMode: 'openai-sse',
            maxInputTokens: 1000,
            maxOutputTokens: 100
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: placementPolicy({
            'kimi-k2.5': { ref: 'kimi/kimi-k2.5' },
            'glm-5': { ref: 'zhipu/glm-5' },
            'glm-5.1': { ref: 'zhipu/glm-5.1' },
            'grok-4.5': { ref: 'xai/grok-4.5' },
            'qwen3.5-plus': { ref: 'qwen/qwen3.5-plus' }
        }),
        remote: [{ id: 'grok-4.5' }, { id: 'glm-5.1' }, { id: 'glm-5' }, { id: 'kimi-k2.5' }, { id: 'qwen3.5-plus' }],
        config,
        defaults: placementDefaults
    });
    const adds = plan.entries.filter(entry => entry.action === 'add');
    assert.equal(adds.length, 5);
    const anchorOf = (localId: string) => adds.find(entry => entry.localId === localId)?.after;
    assert.equal(anchorOf('grok-4.5-go'), 'grok-4.6-go');
    assert.equal(anchorOf('glm-5.1-go'), 'glm-5.2-go');
    assert.equal(anchorOf('glm-5-go'), 'glm-5.2-go');
    assert.equal(anchorOf('kimi-k2.5-go'), 'kimi-k2.6-go');
    assert.equal(anchorOf('qwen3.5-plus-go'), 'qwen3.6-plus-go');
    // 同锚点的新增按版本降序渲染（glm-5.1 在 glm-5 之前）
    assert.deepEqual(
        adds.filter(entry => entry.after === 'glm-5.2-go').map(entry => entry.localId),
        ['glm-5.1-go', 'glm-5-go']
    );
});

test('新增定位：族内最新版本插到簇首之前', () => {
    const config = makeConfig([
        { id: 'glm-5.3-go', model: 'glm-5.3', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'glm-5.2-go', model: 'glm-5.2', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: placementPolicy({ 'glm-5.4': { ref: 'zhipu/glm-5.4' } }),
        remote: [{ id: 'glm-5.4' }],
        config,
        defaults: placementDefaults
    });
    const add = plan.entries.find(entry => entry.action === 'add');
    assert.equal(add?.localId, 'glm-5.4-go');
    assert.equal(add?.before, 'glm-5.3-go');
    assert.equal(add?.after, undefined);
});

test('新增定位：无同族时排到同来源组末而非文件末尾', () => {
    const config = makeConfig([
        { id: 'glm-5.3-go', model: 'glm-5.3', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        {
            id: 'unrelated',
            baseUrl: 'https://other.com/v1',
            sdkMode: 'openai-sse',
            maxInputTokens: 1000,
            maxOutputTokens: 100
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: placementPolicy({ 'nova-1': { ref: 'nova/nova-1' } }),
        remote: [{ id: 'nova-1' }],
        config,
        defaults: placementDefaults
    });
    const add = plan.entries.find(entry => entry.action === 'add');
    assert.equal(add?.localId, 'nova-1-go');
    assert.equal(add?.after, 'glm-5.3-go');
});

test('作者默认源固有 sdkMode 优先于来源默认，并携带 thinkingFormat/extraBody', () => {
    const responsesDefaults: ModelDefaultsFile = {
        meta: {
            'muse-spark-1.3': {
                name: 'Muse',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                capabilities: { toolCalling: true },
                sdkMode: 'openai-responses',
                thinkingFormat: 'effort-only',
                extraBody: { store: false }
            }
        }
    };
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            localIdSuffix: '-zen',
            defaults: { sdkMode: 'openai-sse' },
            models: { 'muse-spark-1.3': { ref: 'meta/muse-spark-1.3' } }
        }),
        remote: [{ id: 'muse-spark-1.3' }],
        config: makeConfig([]),
        defaults: responsesDefaults
    });
    const add = plan.entries.find(entry => entry.action === 'add');
    assert.equal(add?.target?.sdkMode, 'openai-responses');
    assert.equal(add?.target?.thinkingFormat, 'effort-only');
    assert.deepEqual(add?.target?.extraBody, { store: false });
});

test('远端缺失的本地模型保留并警告', () => {
    const config = makeConfig([{ id: 'kept', sdkMode: 'openai-sse' }]);
    const plan = planSource({ sourceId: 'test', policy: makePolicy(), remote: [], config, defaults });
    assert.equal(plan.entries.length, 0);
    assert.ok(plan.warnings.some(warning => warning.startsWith('远端缺失保留：kept')));
});

test('anthropic 条目按运行时约定归一化 base 参与匹配', () => {
    const config = makeConfig([
        {
            id: 'm-go',
            model: 'm',
            sdkMode: 'anthropic',
            baseUrl: 'https://example.com/go',
            maxInputTokens: 1000,
            maxOutputTokens: 100
        }
    ]);
    const plan = planSource({
        sourceId: 'go',
        policy: makePolicy({ endpoint: 'https://example.com/go/v1/models' }),
        remote: [{ id: 'm' }],
        config,
        defaults
    });
    // 被正确匹配为既有条目，而非误报待配置或重复新增
    assert.equal(plan.warnings.filter(warning => warning.includes('待配置')).length, 0);
    assert.equal(plan.entries.filter(entry => entry.action === 'add').length, 0);
});

test('Zen 与 Go 同名模型按来源隔离', () => {
    const config = makeConfig(
        [
            { id: 'kimi-k3', name: 'Kimi-K3 (Zen)', sdkMode: 'openai-sse' },
            {
                id: 'kimi-k3-go',
                model: 'kimi-k3',
                name: 'Kimi-K3 (Go)',
                sdkMode: 'openai-sse',
                baseUrl: 'https://example.com/go/v1'
            }
        ],
        'https://example.com/v1'
    );
    const zenPlan = planSource({
        sourceId: 'zen',
        policy: makePolicy({ endpoint: 'https://example.com/v1/models', excludedModelIds: ['kimi-k3'] }),
        remote: [{ id: 'kimi-k3' }],
        config,
        defaults
    });
    assert.deepEqual(
        zenPlan.entries.map(entry => [entry.action, entry.localId]),
        [['remove', 'kimi-k3']]
    );
    const goPlan = planSource({
        sourceId: 'go',
        policy: makePolicy({ endpoint: 'https://example.com/go/v1/models' }),
        remote: [{ id: 'kimi-k3' }],
        config,
        defaults
    });
    assert.equal(goPlan.entries.length, 0);
});

test('新模型按作者默认源生成，名称后缀自动加空格', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            nameSuffix: '(Hyper)',
            tooltipPrefix: 'Charm Hyper',
            defaults: { sdkMode: 'openai-sse' },
            models: { 'kimi-k3': { ref: 'moonshotai/kimi-k3' } }
        }),
        remote: [
            { id: 'kimi-k3', contextWindow: 1048576, pricing: { input: 3, output: 16, cacheRead: 0.3, cacheWrite: 0 } }
        ],
        config,
        defaults
    });
    assert.equal(plan.errors.length, 0);
    const entry = plan.entries[0];
    assert.equal(entry.action, 'add');
    assert.equal(entry.target?.name, 'Kimi-K3 (Hyper)');
    assert.equal(entry.target?.tooltip, 'Charm Hyper — Kimi-K3。');
    assert.equal(entry.target?.sdkMode, 'openai-sse');
    assert.deepEqual(entry.target?.contextSize, [1000000, 512000, 400000, 256000, 192000]);
    assert.deepEqual(entry.target?.tokenPricing, [3, 16, 0.3]);
    assert.deepEqual(entry.target?.reasoningEffort, ['max', 'high', 'low']);
});

test('思考开关模板经解析后写入新模型', () => {
    const withThink: ModelDefaultsFile = {
        $templates: {
            think: { thinking: ['enabled', 'disabled'] }
        },
        acme: {
            'think-model': {
                name: 'Think-Model',
                template: 'think',
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'think-model': { ref: 'acme/think-model' } }
        }),
        remote: [{ id: 'think-model', contextWindow: 262144 }],
        config,
        defaults: withThink
    });
    assert.equal(plan.errors.length, 0);
    const entry = plan.entries[0];
    assert.equal(entry.action, 'add');
    assert.deepEqual(entry.target?.thinking, ['enabled', 'disabled']);
    assert.equal(entry.target?.reasoningEffort, undefined);
});

test('已有模型按默认源声明收口模型固有字段，未声明字段不触碰', () => {
    const withThink: ModelDefaultsFile = {
        acme: {
            'think-model': {
                name: 'Think-Model',
                thinking: ['enabled', 'disabled'],
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    const config = makeConfig([
        { id: 'think-model', name: 'Think-Model', sdkMode: 'openai-sse', thinkingFormat: 'custom' }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'think-model': { ref: 'acme/think-model' } }
        }),
        remote: [{ id: 'think-model', contextWindow: 262144 }],
        config,
        defaults: withThink
    });
    assert.equal(plan.entries.length, 1);
    const entry = plan.entries[0];
    assert.equal(entry.action, 'update');
    assert.deepEqual(entry.target?.thinking, ['enabled', 'disabled']);
    assert.ok(entry.changes?.some(change => change.field === 'thinking' && change.origin === 'author'));
    // 默认源未声明 thinkingFormat，本地既有值保留且不产生操作
    assert.equal(entry.target?.thinkingFormat, 'custom');
    assert.equal(entry.changes?.filter(change => change.field === 'thinkingFormat').length, 0);
});

test('removeFields 压制默认源声明，同字段操作去重', () => {
    const withThink: ModelDefaultsFile = {
        acme: {
            'think-model': {
                name: 'Think-Model',
                thinking: ['enabled', 'disabled'],
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    const config = makeConfig([
        { id: 'think-model', name: 'Think-Model', sdkMode: 'openai-sse', thinking: ['enabled', 'disabled'] }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'think-model': { ref: 'acme/think-model', removeFields: ['thinking'] } }
        }),
        remote: [{ id: 'think-model', contextWindow: 262144 }],
        config,
        defaults: withThink
    });
    assert.equal(plan.entries.length, 1);
    const entry = plan.entries[0];
    assert.equal(entry.action, 'update');
    assert.equal(entry.target?.thinking, undefined);
    // 默认源的 set 操作被去重，只剩一条删除
    assert.deepEqual(
        entry.changes?.map(change => `${change.field}:${change.to === undefined ? 'remove' : 'set'}`),
        ['thinking:remove']
    );
});

test('removeFields 对本地缺失的字段不产生幻影更新', () => {
    const withThink: ModelDefaultsFile = {
        acme: {
            'think-model': {
                name: 'Think-Model',
                thinking: ['enabled', 'disabled'],
                maxInputTokens: 224000,
                maxOutputTokens: 32000,
                capabilities: { toolCalling: true, imageInput: false }
            }
        }
    };
    // 本地已无 thinking：默认源声明 + removeFields 相互抵消后不应产生任何变更
    const config = makeConfig([{ id: 'think-model', name: 'Think-Model', sdkMode: 'openai-sse' }]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'think-model': { ref: 'acme/think-model', removeFields: ['thinking'] } }
        }),
        remote: [{ id: 'think-model', contextWindow: 262144 }],
        config,
        defaults: withThink
    });
    assert.equal(plan.entries.length, 0);
});

test('新模型单一窗口时省略 contextSize', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-responses' },
            models: { 'gpt-5.5': { ref: 'openai/gpt-5.5' } }
        }),
        remote: [{ id: 'gpt-5.5', contextWindow: 400000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.action, 'add');
    assert.equal(entry.target?.contextSize, undefined);
    assert.equal(entry.target?.maxInputTokens, 272000);
});

test('新模型 1M+ 窗口按规则使用 64K 输出，不受远端输出上限阻塞', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'kimi-k3': { ref: 'moonshotai/kimi-k3' } }
        }),
        remote: [{ id: 'kimi-k3', contextWindow: 1048576, maxOutputTokens: 16000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.action, 'add');
    assert.equal(entry.target?.maxOutputTokens, 64000);
    assert.deepEqual(entry.target?.contextSize, [1000000, 512000, 400000, 256000, 192000]);
});

test('新模型中间区间窗口且输出预算超过远端上限时列为待配置', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'kimi-k3': { ref: 'moonshotai/kimi-k3' } }
        }),
        remote: [{ id: 'kimi-k3', contextWindow: 500000, maxOutputTokens: 16000 }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.ok(plan.warnings.some(warning => warning.includes('待配置：kimi-k3')));
});

test('新模型 256K 窗口且默认源缺预算时按规则推导 32K 输出', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            defaults: { sdkMode: 'openai-sse' },
            models: { 'bare-k3': { ref: 'moonshotai/kimi-k3' } }
        }),
        remote: [{ id: 'bare-k3', contextWindow: 256000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.action, 'add');
    // 默认档过滤后剩 256K/192K 两档，输出按规则收紧为 32K
    assert.deepEqual(entry.target?.contextSize, [256000, 192000]);
    assert.equal(entry.target?.maxOutputTokens, 32000);
    assert.equal(entry.target?.maxInputTokens, 224000);
});

test('更新：规则认可的输出预算不再产生远端输出上限警告', () => {
    const config = makeConfig([
        { id: 'kimi-k3', sdkMode: 'openai-sse', maxInputTokens: 936000, maxOutputTokens: 64000 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'kimi-k3', contextWindow: 1048576, maxOutputTokens: 16000 }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.ok(!plan.warnings.some(warning => warning.includes('输出上限')));
});

test('更新：超出规则认可范围的输出预算仍产生警告', () => {
    const config = makeConfig([{ id: 'm', sdkMode: 'openai-sse', maxInputTokens: 872000, maxOutputTokens: 128000 }]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', contextWindow: 1050000, maxOutputTokens: 16000 }],
        config,
        defaults
    });
    assert.ok(plan.warnings.some(warning => warning.includes('输出上限')));
});

test('更新：远端窗口收紧时过滤档位并收缩输入预算', () => {
    const config = makeConfig([
        {
            id: 'kimi-k3',
            sdkMode: 'openai-sse',
            contextSize: [1000000, 512000, 400000, 256000, 192000],
            maxInputTokens: 936000,
            maxOutputTokens: 64000
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'kimi-k3', contextWindow: 512000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.action, 'update');
    assert.deepEqual(entry.target?.contextSize, [512000, 400000, 256000, 192000]);
    assert.equal(entry.target?.maxInputTokens, 448000);
});

test('更新：仅剩单档时删除 contextSize', () => {
    const config = makeConfig([
        {
            id: 'kimi-k3',
            sdkMode: 'openai-sse',
            contextSize: [512000, 400000],
            maxInputTokens: 448000,
            maxOutputTokens: 64000
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'kimi-k3', contextWindow: 400000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.action, 'update');
    assert.equal(entry.target?.contextSize, undefined);
    assert.equal(entry.target?.maxInputTokens, 336000);
});

test('更新：预算合计超过窗口时报错而非静默修改', () => {
    const config = makeConfig([
        {
            id: 'm3',
            sdkMode: 'openai-sse',
            contextSize: [512000, 400000],
            maxInputTokens: 460800,
            maxOutputTokens: 64000
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm3', contextWindow: 512000 }],
        config,
        defaults
    });
    // 自动收紧 maxInputTokens 到 448000 后合法，不产生错误
    assert.equal(plan.errors.length, 0);
    const entry = plan.entries[0];
    assert.equal(entry.target?.maxInputTokens, 448000);
});

test('更新：价格按缓存读写在第三、四位映射', () => {
    const config = makeConfig([{ id: 'm', sdkMode: 'openai-sse', tokenPricing: [0.11, 0.408, 0, 0.055] }]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', pricing: { input: 0.122, output: 0.42, cacheRead: 0.061, cacheWrite: 0 } }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.deepEqual(entry.target?.tokenPricing, [0.122, 0.42, 0.061]);
});

test('更新：保留复杂分档价格的 tiers，仅更新基础价格', () => {
    const config = makeConfig([
        {
            id: 'm',
            sdkMode: 'openai-sse',
            tokenPricing: { pricing: [2, 6, 0.5], tiers: [{ contextSizeMin: 200001, pricing: [4, 12, 1] }] }
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', pricing: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
});

test('更新：imageInput 按远端布尔值同步且不丢失 toolCalling', () => {
    const config = makeConfig([
        { id: 'm', sdkMode: 'openai-sse', capabilities: { toolCalling: true, imageInput: false } }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', capabilities: { imageInput: true } }],
        config,
        defaults
    });
    assert.deepEqual(plan.entries[0]?.target?.capabilities, { toolCalling: true, imageInput: true });
});

test('更新：推理档位不一致仅警告，不自动替换', () => {
    const config = makeConfig([
        { id: 'm', sdkMode: 'openai-sse', reasoningEffort: ['high', 'xhigh', 'none'], thinkingFormat: 'effort-none' }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' } }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.deepEqual(config.models[0].reasoningEffort, ['high', 'xhigh', 'none']);
    assert.ok(plan.warnings.some(warning => warning.includes('推理档位')));
});

test('更新：推理档位仅顺序不同不告警', () => {
    const config = makeConfig([
        { id: 'm', sdkMode: 'openai-sse', reasoningEffort: ['max', 'high', 'low'], thinkingFormat: 'effort-none' }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy(),
        remote: [{ id: 'm', reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'high' } }],
        config,
        defaults
    });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.warnings.filter(warning => warning.includes('推理档位')).length, 0);
});

test('人工覆盖与删除字段按规则生效', () => {
    const config = makeConfig([
        {
            id: 'm',
            sdkMode: 'openai-sse',
            contextSize: [400000, 1000000],
            maxInputTokens: 872000,
            maxOutputTokens: 128000
        }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            models: {
                m: {
                    removeFields: ['contextSize'],
                    overrides: { maxInputTokens: 272000 }
                }
            }
        }),
        remote: [{ id: 'm', contextWindow: 1000000 }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.target?.contextSize, undefined);
    assert.equal(entry.target?.maxInputTokens, 272000);
});

test('modelRules 按前缀批量套用，精确登记叠加胜出', () => {
    const config = makeConfig([
        { id: 'meta/a-1', sdkMode: 'openai-responses', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'meta/a-2', sdkMode: 'openai-responses', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'other/b-1', sdkMode: 'openai-responses', maxInputTokens: 1000, maxOutputTokens: 100 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            modelRules: [
                {
                    idPrefix: 'meta/a-',
                    overrides: { sdkMode: 'openai-sse' },
                    removeFields: ['maxOutputTokens']
                }
            ],
            models: {
                // 精确登记在同名字段上胜出，并补充额外删除字段
                'meta/a-2': { overrides: { sdkMode: 'openai-chat' }, removeFields: ['maxInputTokens'] }
            }
        }),
        remote: [{ id: 'meta/a-1' }, { id: 'meta/a-2' }, { id: 'other/b-1' }],
        config,
        defaults
    });
    const [a1, a2, b1] = config.models.map(model => plan.entries.find(entry => entry.localId === model.id));
    assert.equal(a1?.target?.sdkMode, 'openai-sse');
    assert.equal(a1?.target?.maxOutputTokens, undefined);
    assert.equal(a2?.target?.sdkMode, 'openai-chat');
    assert.equal(a2?.target?.maxOutputTokens, undefined);
    assert.equal(a2?.target?.maxInputTokens, undefined);
    // 非前缀命中模型不受规则影响
    assert.equal(b1, undefined);
});

test('modelRules idPrefixes 多模型共用一套规则，多条命中按序叠加', () => {
    const config = makeConfig([
        { id: 'a/m-1', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 },
        { id: 'b/m-2', sdkMode: 'openai-sse', maxInputTokens: 1000, maxOutputTokens: 100 }
    ]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({
            modelRules: [
                { idPrefixes: ['a/m-1', 'b/m-2'], overrides: { sdkMode: 'openai-chat' } },
                { idPrefixes: ['b/m-2'], removeFields: ['maxOutputTokens'] }
            ]
        }),
        remote: [{ id: 'a/m-1' }, { id: 'b/m-2' }],
        config,
        defaults
    });
    const [m1, m2] = config.models.map(model => plan.entries.find(entry => entry.localId === model.id));
    assert.equal(m1?.target?.sdkMode, 'openai-chat');
    assert.equal(m1?.target?.maxOutputTokens, 100);
    assert.equal(m2?.target?.sdkMode, 'openai-chat');
    assert.equal(m2?.target?.maxOutputTokens, undefined);
});

test('非法 removeFields 与身份字段覆盖被拒绝', () => {
    const config = makeConfig([{ id: 'm', sdkMode: 'openai-sse' }]);
    const plan = planSource({
        sourceId: 'test',
        policy: makePolicy({ models: { m: { removeFields: ['id'], overrides: { model: 'x' } } } }),
        remote: [{ id: 'm' }],
        config,
        defaults
    });
    assert.ok(plan.errors.some(error => error.includes('removeFields')));
    assert.ok(plan.errors.some(error => error.includes('身份字段')));
});

test('Go 新模型使用 localIdSuffix 并显式写入 model 与 baseUrl', () => {
    const config = makeConfig([]);
    const plan = planSource({
        sourceId: 'go',
        policy: makePolicy({
            endpoint: 'https://example.com/go/v1/models',
            localIdSuffix: '-go',
            nameSuffix: '(Go)',
            defaults: { sdkMode: 'openai-sse', baseUrl: 'https://example.com/go/v1' },
            models: { 'kimi-k3': { ref: 'moonshotai/kimi-k3' } }
        }),
        remote: [{ id: 'kimi-k3' }],
        config,
        defaults
    });
    const entry = plan.entries[0];
    assert.equal(entry.localId, 'kimi-k3-go');
    assert.equal(entry.target?.model, 'kimi-k3');
    assert.equal(entry.target?.baseUrl, 'https://example.com/go/v1');
    assert.equal(entry.target?.name, 'Kimi-K3 (Go)');
});
