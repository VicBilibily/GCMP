import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonWithSpans } from '../jsonScan';
import { applyTargetEdit } from '../writer';

const sample = `{
    "displayName": "Example",
    "baseUrl": "https://example.com/v1",
    "models": [
        {
            "id": "first",
            "name": "First",
            "sdkMode": "openai-sse",
            "contextSize": [1000000, 512000, 400000],
            "maxInputTokens": 936000,
            "maxOutputTokens": 64000,
            "capabilities": { "toolCalling": true, "imageInput": false },
            "tokenPricing": [0.2, 0.4, 0.04]
        },
        {
            "id": "middle",
            "name": "Middle",
            "sdkMode": "openai-sse",
            "maxInputTokens": 224000,
            "maxOutputTokens": 32000,
            "capabilities": { "toolCalling": true, "imageInput": true }
        },
        {
            "id": "last",
            "name": "Last",
            "sdkMode": "openai-sse",
            "maxInputTokens": 168000,
            "maxOutputTokens": 32000,
            "capabilities": { "toolCalling": true, "imageInput": false }
        }
    ]
}
`;

test('jsonScan 检测重复键', () => {
    assert.throws(() => parseJsonWithSpans('{"a": 1, "a": 2}'), /重复的对象键/);
});

test('空变更计划返回原文，保持字节级幂等', () => {
    const result = applyTargetEdit(sample, { updates: [], removals: [], additions: [] });
    assert.equal(result, sample);
});

test('更新字段为局部替换，未触及的格式保持不变', () => {
    const result = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'first',
                ops: [
                    { kind: 'set', field: 'maxInputTokens', value: 448000 },
                    { kind: 'set', field: 'tokenPricing', value: [0.22, 0.66, 0.007] }
                ]
            }
        ],
        removals: [],
        additions: []
    });
    assert.ok(result.includes('"maxInputTokens": 448000'));
    assert.ok(result.includes('"tokenPricing": [0.22, 0.66, 0.007]'));
    assert.ok(result.includes('"capabilities": { "toolCalling": true, "imageInput": false }'));
    assert.ok(result.includes('"contextSize": [1000000, 512000, 400000]'));
});

test('新增字段插入到对象末尾，删除字段清理逗号', () => {
    const result = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'middle',
                ops: [
                    { kind: 'set', field: 'reasoningEffort', value: ['low', 'high'] },
                    { kind: 'remove', field: 'maxInputTokens' }
                ]
            }
        ],
        removals: [],
        additions: []
    });
    const parsed = JSON.parse(result) as { models: Array<Record<string, unknown>> };
    const middle = parsed.models.find(model => model.id === 'middle')!;
    assert.deepEqual(middle.reasoningEffort, ['low', 'high']);
    assert.equal(middle.maxInputTokens, undefined);
    assert.ok(result.includes('"reasoningEffort": ["low", "high"]'));
});

test('移除首项、中间项、末项后的 JSON 均合法', () => {
    for (const id of ['first', 'middle', 'last']) {
        const result = applyTargetEdit(sample, { updates: [], removals: [id], additions: [] });
        const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
        assert.deepEqual(
            parsed.models.map(model => model.id),
            ['first', 'middle', 'last'].filter(item => item !== id)
        );
    }
});

test('相邻多项移除合并为单段编辑', () => {
    // 头部相邻段
    let parsed = JSON.parse(applyTargetEdit(sample, { updates: [], removals: ['first', 'middle'], additions: [] })) as {
        models: Array<{ id: string }>;
    };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['last']
    );
    // 尾部相邻段
    parsed = JSON.parse(applyTargetEdit(sample, { updates: [], removals: ['middle', 'last'], additions: [] })) as {
        models: Array<{ id: string }>;
    };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['first']
    );
    // 全量移除
    parsed = JSON.parse(
        applyTargetEdit(sample, { updates: [], removals: ['first', 'middle', 'last'], additions: [] })
    ) as { models: Array<{ id: string }> };
    assert.deepEqual(parsed.models, []);
    // 不相邻多项仍是独立编辑
    parsed = JSON.parse(applyTargetEdit(sample, { updates: [], removals: ['first', 'last'], additions: [] })) as {
        models: Array<{ id: string }>;
    };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['middle']
    );
});

test('相邻移除与锚点插入组合不产生重叠', () => {
    const result = applyTargetEdit(sample, {
        updates: [],
        removals: ['middle', 'last'],
        additions: [{ entry: { id: 'new', sdkMode: 'openai-sse' }, after: 'first' }]
    });
    const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['first', 'new']
    );
});

test('相邻对象属性移除合并处理逗号', () => {
    // 尾部相邻属性段
    const tailResult = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'first',
                ops: [
                    { kind: 'remove', field: 'maxOutputTokens' },
                    { kind: 'remove', field: 'capabilities' },
                    { kind: 'remove', field: 'tokenPricing' }
                ]
            }
        ],
        removals: [],
        additions: []
    });
    const firstTail = (JSON.parse(tailResult) as { models: Array<Record<string, unknown>> }).models[0];
    assert.deepEqual(Object.keys(firstTail), ['id', 'name', 'sdkMode', 'contextSize', 'maxInputTokens']);
    // 中部相邻属性段
    const midResult = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'first',
                ops: [
                    { kind: 'remove', field: 'contextSize' },
                    { kind: 'remove', field: 'maxInputTokens' }
                ]
            }
        ],
        removals: [],
        additions: []
    });
    const firstMid = (JSON.parse(midResult) as { models: Array<Record<string, unknown>> }).models[0];
    assert.deepEqual(Object.keys(firstMid), [
        'id',
        'name',
        'sdkMode',
        'maxOutputTokens',
        'capabilities',
        'tokenPricing'
    ]);
});

test('新增字段按内置字段序插入，紧凑值保持单行', () => {
    const result = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'middle',
                ops: [
                    // 故意乱序给出，验证按内置序归位
                    { kind: 'set', field: 'extraBody', value: { store: false } },
                    { kind: 'set', field: 'thinkingFormat', value: 'object' },
                    { kind: 'set', field: 'reasoningEffort', value: ['low', 'high'] }
                ]
            }
        ],
        removals: [],
        additions: []
    });
    const parsed = JSON.parse(result) as { models: Array<Record<string, unknown>> };
    const middle = parsed.models.find(model => model.id === 'middle')!;
    assert.deepEqual(Object.keys(middle), [
        'id',
        'name',
        'sdkMode',
        'maxInputTokens',
        'maxOutputTokens',
        'reasoningEffort',
        'thinkingFormat',
        'capabilities',
        'extraBody'
    ]);
    // 纯原始值数组/对象保持单行
    assert.ok(result.includes('"reasoningEffort": ["low", "high"]'));
    assert.ok(result.includes('"extraBody": { "store": false }'));
});

test('新增模型按既有缩进风格追加到数组末尾', () => {
    const result = applyTargetEdit(sample, {
        updates: [],
        removals: [],
        additions: [
            {
                entry: {
                    id: 'new-model',
                    name: 'New Model (Hyper)',
                    tooltip: 'Charm Hyper — New Model。',
                    sdkMode: 'openai-sse',
                    contextSize: [1000000, 512000, 400000, 256000, 192000],
                    maxInputTokens: 936000,
                    maxOutputTokens: 64000,
                    capabilities: { toolCalling: true, imageInput: true },
                    tokenPricing: [1.437216, 4.311648, 0.0479072]
                }
            }
        ]
    });
    assert.ok(
        result.includes(
            `        {
            "id": "new-model",
            "name": "New Model (Hyper)",
            "tooltip": "Charm Hyper — New Model。",
            "sdkMode": "openai-sse",
            "contextSize": [1000000, 512000, 400000, 256000, 192000],
            "maxInputTokens": 936000,
            "maxOutputTokens": 64000,
            "capabilities": { "toolCalling": true, "imageInput": true },
            "tokenPricing": [1.437216, 4.311648, 0.0479072]
        }`
        )
    );
    const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
    assert.equal(parsed.models[parsed.models.length - 1].id, 'new-model');
    // 再次应用空计划不产生变化
    assert.equal(applyTargetEdit(result, { updates: [], removals: [], additions: [] }), result);
});

test('锚点插入：after 插到指定模型之后，同锚点多条目保持顺序', () => {
    const result = applyTargetEdit(sample, {
        updates: [],
        removals: [],
        additions: [
            { entry: { id: 'middle-a', sdkMode: 'openai-sse' }, after: 'middle' },
            { entry: { id: 'middle-b', sdkMode: 'openai-sse' }, after: 'middle' },
            { entry: { id: 'first-a', sdkMode: 'openai-sse' }, after: 'first' }
        ]
    });
    const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['first', 'first-a', 'middle', 'middle-a', 'middle-b', 'last']
    );
});

test('锚点插入：before 插到指定模型之前', () => {
    const result = applyTargetEdit(sample, {
        updates: [],
        removals: [],
        additions: [{ entry: { id: 'newest', sdkMode: 'openai-sse' }, before: 'first' }]
    });
    const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['newest', 'first', 'middle', 'last']
    );
});

test('锚点插入：锚点不存在时报错', () => {
    assert.throws(
        () =>
            applyTargetEdit(sample, {
                updates: [],
                removals: [],
                additions: [{ entry: { id: 'x' }, after: 'missing' }]
            }),
        /锚点 "missing" 不存在/
    );
});

test('浮点尾数被规范化', () => {
    const result = applyTargetEdit(sample, {
        updates: [
            {
                localId: 'first',
                ops: [{ kind: 'set', field: 'tokenPricing', value: [0.16332, 0.5444, 0.031575200000000005] }]
            }
        ],
        removals: [],
        additions: []
    });
    assert.ok(result.includes('[0.16332, 0.5444, 0.0315752]'));
});

test('CRLF 换行的文件保持风格', () => {
    const crlf = sample.replace(/\n/g, '\r\n');
    const result = applyTargetEdit(crlf, { updates: [], removals: ['middle'], additions: [] });
    const parsed = JSON.parse(result) as { models: Array<{ id: string }> };
    assert.deepEqual(
        parsed.models.map(model => model.id),
        ['first', 'last']
    );
    assert.ok(!result.includes('\n') || result.includes('\r\n'));
});

test('移除不存在的模型时报错', () => {
    assert.throws(() => applyTargetEdit(sample, { updates: [], removals: ['missing'], additions: [] }), /不存在/);
});
