import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareGcmpVersions,
    getRemoteModelsOverlay,
    hashModelsText,
    isRemoteManifestFresh,
    parseModelsManifest,
    sanitizeProviderModels,
    setRemoteProviderModels
} from './modelsResolver';

test('hashModelsText returns stable 12-hex digest', () => {
    assert.equal(hashModelsText('{"a":1}'), hashModelsText('{"a":1}'));
    assert.match(hashModelsText('{"a":1}'), /^[0-9a-f]{12}$/);
    assert.notEqual(hashModelsText('{"a":1}'), hashModelsText('{"a":2}'));
});

test('parseModelsManifest parses a valid manifest', () => {
    const manifest = parseModelsManifest(
        JSON.stringify({
            schemaVersion: 1,
            gcmpVersion: '0.27.15-p1',
            generatedAt: '2026-09-06T00:00:00.000Z',
            providers: [
                { id: 'zhipu', displayName: 'ZhipuAI', modelCount: 8, contentHash: 'a1b2c3d4e5f6' },
                { id: 'codex', modelCount: 6, contentHash: '001122334455' }
            ]
        })
    );
    assert.equal(manifest?.gcmpVersion, '0.27.15-p1');
    assert.deepEqual(manifest?.providers, [
        { id: 'zhipu', contentHash: 'a1b2c3d4e5f6' },
        { id: 'codex', contentHash: '001122334455' }
    ]);
});

test('parseModelsManifest rejects invalid payloads', () => {
    assert.equal(parseModelsManifest('not-json'), undefined);
    assert.equal(
        parseModelsManifest(JSON.stringify({ schemaVersion: 2, gcmpVersion: '1.0.0', providers: [] })),
        undefined
    );
    assert.equal(parseModelsManifest(JSON.stringify({ schemaVersion: 1, providers: [] })), undefined);
    assert.equal(parseModelsManifest(JSON.stringify({ schemaVersion: 1, gcmpVersion: '1.0.0' })), undefined);
});

test('parseModelsManifest rejects invalid or duplicate provider entries', () => {
    assert.equal(
        parseModelsManifest(
            JSON.stringify({
                schemaVersion: 1,
                gcmpVersion: '1.0.0',
                providers: [
                    { id: 'zhipu', contentHash: 'a1b2c3d4e5f6' },
                    { id: 'Bad_Id', contentHash: 'a1b2c3d4e5f6' }
                ]
            })
        ),
        undefined
    );
    assert.equal(
        parseModelsManifest(
            JSON.stringify({
                schemaVersion: 1,
                gcmpVersion: '1.0.0',
                providers: [
                    { id: 'zhipu', contentHash: 'a1b2c3d4e5f6' },
                    { id: 'zhipu', contentHash: '001122334455' }
                ]
            })
        ),
        undefined
    );
});

test('parseModelsManifest rejects excessive provider count', () => {
    const providers = Array.from({ length: 129 }, (_, index) => ({
        id: `provider-${index}`,
        contentHash: 'a1b2c3d4e5f6'
    }));
    assert.equal(
        parseModelsManifest(
            JSON.stringify({
                schemaVersion: 1,
                gcmpVersion: '1.0.0',
                providers
            })
        ),
        undefined
    );
});

test('parseModelsManifest rejects malformed entries instead of treating them as removals', () => {
    assert.equal(
        parseModelsManifest(
            JSON.stringify({
                schemaVersion: 1,
                gcmpVersion: '1.0.0',
                providers: [
                    { id: 'zhipu', contentHash: 'a1b2c3d4e5f6' },
                    { id: 'Bad_Id', contentHash: 'a1b2c3d4e5f6' },
                    { id: 'codex', contentHash: 'not-hex' },
                    'broken'
                ]
            })
        ),
        undefined
    );
});

test('compareGcmpVersions compares numeric parts and prerelease', () => {
    assert.equal(compareGcmpVersions('0.27.16', '0.27.15')! > 0, true);
    assert.equal(compareGcmpVersions('0.27.15', '0.27.15-p1')! > 0, true);
    assert.equal(compareGcmpVersions('0.27.15-p2', '0.27.15-p1')! > 0, true);
    assert.equal(compareGcmpVersions('0.27.15-p1', '0.27.15-p1'), 0);
    assert.equal(compareGcmpVersions('0.27.15-p1', '0.27.16')! < 0, true);
    assert.equal(compareGcmpVersions('0.27.15-p1', '0.27.15')! < 0, true);
    assert.equal(compareGcmpVersions('not-a-version', '0.27.15'), undefined);
});

test('isRemoteManifestFresh gates on manifest >= extension', () => {
    assert.equal(isRemoteManifestFresh('0.27.15-p1', '0.27.15-p1'), true);
    assert.equal(isRemoteManifestFresh('0.27.16', '0.27.15-p1'), true);
    assert.equal(isRemoteManifestFresh('0.27.15', '0.27.15-p1'), true);
    assert.equal(isRemoteManifestFresh('0.27.15-p1', '0.27.15'), false);
    assert.equal(isRemoteManifestFresh('0.27.14', '0.27.15-p1'), false);
    assert.equal(isRemoteManifestFresh('garbage', '0.27.15'), false);
});

test('sanitizeProviderModels keeps whitelisted fields of a full model', () => {
    const result = sanitizeProviderModels({
        displayName: 'Evil Renamed',
        baseUrl: 'https://attacker.example',
        models: [
            {
                id: 'glm-4.6',
                name: 'GLM-4.6',
                tooltip: 'desc',
                maxInputTokens: 200000,
                maxOutputTokens: 128000,
                capabilities: { toolCalling: true, imageInput: false },
                sdkMode: 'openai',
                model: 'glm-4.6-real',
                family: 'gpt-5.2',
                thinking: ['auto', 'enabled'],
                thinkingFormat: 'boolean-none',
                reasoningFormat: 'nested',
                reasoningEffort: ['low', 'high', 'xhigh'],
                reasoningDefault: 'high',
                contextSize: [128000, 200000],
                serviceTier: ['default', 'priority'],
                tokenPricing: [2, 8, 0.4],
                limit: { rpm: 20, parallel: 4 },
                customHeader: { 'X-Org': 'abc', 'user-agent': 'custom/1.0' },
                extraBody: { store: false, reasoning: { effort: 'high' } },
                useInstructions: true,
                cacheTtl: '1h',
                webSearchTool: { maxUses: 3, allowedDomains: ['example.com'] },
                nativeTools: [{ type: 'web_search', maxUses: 2 }]
            }
        ]
    });
    assert.equal(result?.droppedModels, 0);
    const model = result?.models[0];
    assert.equal(model?.id, 'glm-4.6');
    assert.equal(model?.sdkMode, 'openai');
    assert.equal(model?.model, 'glm-4.6-real');
    assert.deepEqual(model?.thinking, ['auto', 'enabled']);
    assert.deepEqual(model?.reasoningEffort, ['low', 'high', 'xhigh']);
    assert.equal(model?.reasoningDefault, 'high');
    assert.deepEqual(model?.contextSize, [128000, 200000]);
    assert.deepEqual(model?.serviceTier, ['default', 'priority']);
    assert.equal(model?.tokenPricing?.inputPrice, 2);
    assert.deepEqual(model?.limit, { rpm: 20, parallel: 4 });
    assert.deepEqual(model?.customHeader, { 'X-Org': 'abc', 'user-agent': 'custom/1.0' });
    assert.deepEqual(model?.extraBody, { store: false, reasoning: { effort: 'high' } });
    assert.equal(model?.useInstructions, true);
    assert.equal(model?.cacheTtl, '1h');
    assert.deepEqual(model?.webSearchTool, { maxUses: 3, allowedDomains: ['example.com'] });
    assert.deepEqual(model?.nativeTools, [{ type: 'web_search', maxUses: 2 }]);
});

test('sanitizeProviderModels strips forbidden and proto-pollution fields with audit', () => {
    // __proto__ 只有经 JSON.parse 才会成为自有属性（对象字面量写法会静默改写原型），与真实载荷一致
    const model = JSON.parse(
        '{"id":"gpt-5.4","name":"GPT","maxInputTokens":1000,"maxOutputTokens":100,' +
            '"baseUrl":"https://attacker.example","endpoint":"/evil","modelsEndpoint":"/evil-models",' +
            '"proxy":"http://attacker:8080","apiKeyTemplate":"sk-evil","__proto__":{"polluted":true},"constructor":"evil"}'
    );
    const result = sanitizeProviderModels({ models: [model] });
    assert.equal(result?.droppedModels, 0);
    const cleaned = result?.models[0];
    assert.equal(cleaned?.baseUrl, undefined);
    assert.equal(cleaned?.endpoint, undefined);
    assert.equal(cleaned?.proxy, undefined);
    assert.equal((cleaned as unknown as Record<string, unknown>)?.apiKeyTemplate, undefined);
    assert.equal((cleaned as unknown as Record<string, unknown>)?.polluted, undefined);
    assert.deepEqual(result?.strippedFields, [
        '__proto__',
        'apiKeyTemplate',
        'baseUrl',
        'constructor',
        'endpoint',
        'modelsEndpoint',
        'proxy'
    ]);
});

test('sanitizeProviderModels drops models with invalid required fields, keeps others', () => {
    const result = sanitizeProviderModels({
        models: [
            { id: 'bad id!', name: 'Bad', maxInputTokens: 1000, maxOutputTokens: 100 },
            { id: 'ok-model', maxInputTokens: 1000, maxOutputTokens: 100 },
            { id: 'no-tokens', name: 'X' },
            { id: 'good', name: 'Good', maxInputTokens: 1000, maxOutputTokens: 100 }
        ]
    });
    assert.equal(result?.droppedModels, 3);
    assert.deepEqual(
        result?.models.map(m => m.id),
        ['good']
    );
});

test('sanitizeProviderModels inherits destination fields from builtin by id, never from remote', () => {
    const builtin = [
        {
            id: 'variant-model',
            name: 'Variant',
            tooltip: '',
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            capabilities: { toolCalling: false, imageInput: false },
            baseUrl: 'https://token-plan.example.com/v1',
            provider: 'dashscope-token',
            proxy: 'noproxy'
        } as const
    ];
    const result = sanitizeProviderModels(
        {
            models: [
                {
                    id: 'variant-model',
                    name: 'Variant',
                    maxInputTokens: 1000,
                    maxOutputTokens: 100,
                    baseUrl: 'https://attacker.example',
                    provider: 'attacker-slot',
                    proxy: 'http://attacker:8080',
                    tokenPricing: [9, 9]
                },
                {
                    id: 'brand-new-model',
                    name: 'New',
                    maxInputTokens: 1000,
                    maxOutputTokens: 100,
                    baseUrl: 'https://attacker.example',
                    provider: 'attacker-slot'
                }
            ]
        },
        builtin
    );
    const variant = result?.models.find(m => m.id === 'variant-model');
    assert.equal(variant?.baseUrl, 'https://token-plan.example.com/v1');
    assert.equal(variant?.provider, 'dashscope-token');
    assert.equal(variant?.proxy, 'noproxy');
    assert.equal(variant?.tokenPricing?.inputPrice, 9);
    const fresh = result?.models.find(m => m.id === 'brand-new-model');
    assert.equal(fresh?.baseUrl, undefined);
    assert.equal(fresh?.provider, undefined);
});

test('sanitizeProviderModels rejects structurally invalid payloads', () => {
    assert.equal(sanitizeProviderModels('broken'), undefined);
    assert.equal(sanitizeProviderModels({ models: 'not-array' }), undefined);
    assert.equal(sanitizeProviderModels({}), undefined);
});

test('sanitizeProviderModels validates customHeader keys and values', () => {
    const result = sanitizeProviderModels({
        models: [
            {
                id: 'm1',
                name: 'M1',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                customHeader: {
                    'X-Valid': 'ok',
                    'bad key': 'no',
                    'X-CRLF': 'inject\r\nX-Evil: 1',
                    'X-Long': 'x'.repeat(2000),
                    Authorization: 'Bearer stolen',
                    Cookie: 'sid=1',
                    Host: 'attacker.example',
                    'Set-Cookie': 'sid=1',
                    'Proxy-Authorization': 'Basic abc'
                }
            }
        ]
    });
    assert.deepEqual(result?.models[0]?.customHeader, { 'X-Valid': 'ok' });
});

test('sanitizeProviderModels bounds extraBody size and depth and strips proto keys', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) {
        cursor.next = {};
        cursor = cursor.next as Record<string, unknown>;
    }
    const protoPayload = JSON.parse('{"store":false,"__proto__":{"x":1},"reasoning":{"effort":"high"}}');
    const result = sanitizeProviderModels({
        models: [
            { id: 'm1', name: 'M1', maxInputTokens: 1000, maxOutputTokens: 100, extraBody: protoPayload },
            {
                id: 'm2',
                name: 'M2',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                extraBody: { note: 'x'.repeat(9000) }
            },
            { id: 'm3', name: 'M3', maxInputTokens: 1000, maxOutputTokens: 100, extraBody: deep }
        ]
    });
    assert.deepEqual(result?.models.find(m => m.id === 'm1')?.extraBody, {
        store: false,
        reasoning: { effort: 'high' }
    });
    assert.equal(result?.models.find(m => m.id === 'm2')?.extraBody, undefined);
    assert.equal(result?.models.find(m => m.id === 'm3')?.extraBody, undefined);
});

test('sanitizeProviderModels drops invalid enum fields but keeps the model', () => {
    const result = sanitizeProviderModels({
        models: [
            {
                id: 'm1',
                name: 'M1',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                sdkMode: 'grpc',
                thinkingFormat: 'xml',
                reasoningFormat: 'yaml',
                reasoningEffort: ['low', 'ultra'],
                reasoningDefault: 'high',
                cacheTtl: '2h',
                tokenPricing: [Number.NaN, 1]
            }
        ]
    });
    const model = result?.models[0];
    assert.equal(model?.sdkMode, undefined);
    assert.equal(model?.thinkingFormat, undefined);
    assert.equal(model?.reasoningFormat, undefined);
    assert.deepEqual(model?.reasoningEffort, ['low']);
    assert.equal(model?.reasoningDefault, undefined);
    assert.equal(model?.cacheTtl, undefined);
    assert.equal(model?.tokenPricing, undefined);
});

test('sanitizeProviderModels normalizes pricing and validates reasoningDefault membership', () => {
    const result = sanitizeProviderModels({
        models: [
            {
                id: 'm1',
                name: 'M1',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                tokenPricing: { pricing: { RMB: [5, 30, 0.5] } },
                reasoningEffort: ['low', 'high'],
                reasoningDefault: 'high'
            }
        ]
    });
    const model = result?.models[0];
    assert.equal(model?.tokenPricing?.inputPrice !== undefined, true);
    assert.equal(model?.reasoningDefault, 'high');
});

test('sanitizeProviderModels rejects fractional numeric limits instead of flooring to zero', () => {
    const result = sanitizeProviderModels({
        models: [
            {
                id: 'fractional',
                name: 'Fractional',
                maxInputTokens: 0.5,
                maxOutputTokens: 0.5,
                contextSize: [0.5, 1024],
                limit: { rpm: 0.5, tpm: 100 }
            }
        ]
    });
    assert.equal(result, undefined);

    const partial = sanitizeProviderModels({
        models: [
            {
                id: 'partial',
                name: 'Partial',
                maxInputTokens: 1024,
                maxOutputTokens: 100,
                contextSize: [0.5, 1024],
                limit: { rpm: 0.5, tpm: 100 }
            }
        ]
    });
    assert.equal(partial?.droppedModels, 0);
    assert.deepEqual(partial?.models[0]?.contextSize, [1024]);
    assert.deepEqual(partial?.models[0]?.limit, { tpm: 100 });
});

test('sanitizeProviderModels enforces extraBody UTF-8 byte budget', () => {
    const payload = { note: '汉'.repeat(8180) };
    const result = sanitizeProviderModels({
        models: [
            {
                id: 'unicode-extra-body',
                name: 'UnicodeExtraBody',
                maxInputTokens: 1000,
                maxOutputTokens: 100,
                extraBody: payload
            }
        ]
    });
    assert.equal(Buffer.byteLength(JSON.stringify(payload), 'utf8') > 8192, true);
    assert.equal(result?.models[0]?.extraBody, undefined);
});

test('sanitizeProviderModels rejects payload when every model is invalid', () => {
    const result = sanitizeProviderModels({
        models: [
            { id: 'bad id!', name: 'Bad', maxInputTokens: 1000, maxOutputTokens: 100 },
            { id: 'no-tokens', name: 'X' }
        ]
    });
    assert.equal(result, undefined);
});

function builtinModel(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: `Builtin ${id}`,
        tooltip: '',
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        capabilities: { toolCalling: false, imageInput: false },
        ...overrides
    } as const;
}

test('sanitizeProviderModels merges with builtin: remote wins on duplicate id, builtin rest as fallback', () => {
    const builtin = [
        builtinModel('shared-model', { maxInputTokens: 1000, baseUrl: 'https://plan.example.com/v1' }),
        builtinModel('fallback-model', { maxOutputTokens: 200 })
    ];
    const result = sanitizeProviderModels(
        {
            models: [
                {
                    id: 'shared-model',
                    name: 'Remote Shared',
                    maxInputTokens: 2000,
                    maxOutputTokens: 100,
                    baseUrl: 'https://attacker.example'
                },
                { id: 'brand-new', name: 'Brand New', maxInputTokens: 500, maxOutputTokens: 50 }
            ]
        },
        builtin
    );
    assert.deepEqual(
        result?.models.map(model => model.id),
        ['shared-model', 'brand-new', 'fallback-model']
    );
    const shared = result?.models[0];
    assert.equal(shared?.name, 'Remote Shared');
    assert.equal(shared?.maxInputTokens, 2000);
    assert.equal(shared?.baseUrl, 'https://plan.example.com/v1');
    const fallback = result?.models[2];
    assert.equal(fallback, builtin[1]);
});

test('sanitizeProviderModels deduplicates remote ids with the last definition winning', () => {
    const result = sanitizeProviderModels({
        models: [
            { id: 'duplicate', name: 'First', maxInputTokens: 100, maxOutputTokens: 10 },
            { id: 'other', name: 'Other', maxInputTokens: 200, maxOutputTokens: 20 },
            { id: 'duplicate', name: 'Last', maxInputTokens: 300, maxOutputTokens: 30 }
        ]
    });
    assert.deepEqual(
        result?.models.map(model => model.id),
        ['duplicate', 'other']
    );
    assert.equal(result?.models[0]?.name, 'Last');
    assert.equal(result?.models[0]?.maxInputTokens, 300);
});

test('sanitizeProviderModels rejects excessive model count', () => {
    const models = Array.from({ length: 513 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${index}`,
        maxInputTokens: 100,
        maxOutputTokens: 10
    }));
    assert.equal(sanitizeProviderModels({ models }), undefined);
});

test('sanitizeProviderModels treats empty remote models as pure builtin fallback', () => {
    const builtin = [builtinModel('legacy-model')];
    const result = sanitizeProviderModels({ models: [] }, builtin);
    assert.deepEqual(
        result?.models.map(model => model.id),
        ['legacy-model']
    );
});

test('sanitizeProviderModels without builtin keeps replace semantics', () => {
    const result = sanitizeProviderModels({
        models: [{ id: 'only-remote', name: 'Only Remote', maxInputTokens: 100, maxOutputTokens: 10 }]
    });
    assert.deepEqual(
        result?.models.map(model => model.id),
        ['only-remote']
    );
});

test('remote models snapshot set/read/remove', () => {
    setRemoteProviderModels('zhipu', [
        {
            id: 'm1',
            name: 'M1',
            tooltip: '',
            maxInputTokens: 1000,
            maxOutputTokens: 100,
            capabilities: { toolCalling: false, imageInput: false }
        }
    ]);
    assert.equal(getRemoteModelsOverlay().get('zhipu')?.length, 1);
    setRemoteProviderModels('zhipu', undefined);
    assert.equal(getRemoteModelsOverlay().has('zhipu'), false);
});
