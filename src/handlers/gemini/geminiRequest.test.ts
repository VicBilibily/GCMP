import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelChatResponseOptions, ModelConfig } from '../../types/sharedTypes';
import { buildGeminiAuthHeaders, buildGeminiEndpoint, buildGeminiRequest, GeminiStreamParser } from './geminiRequest';

const modelConfig = (extraBody?: Record<string, unknown>): ModelConfig =>
    ({
        id: 'gemini-3-pro',
        model: 'gemini-3-pro',
        name: 'Gemini 3 Pro',
        maxOutputTokens: 4096,
        serviceTier: ['unspecified', 'standard', 'flex', 'priority'],
        extraBody
    }) as unknown as ModelConfig;

test('buildGeminiEndpoint builds the official streaming endpoint', () => {
    assert.equal(
        buildGeminiEndpoint('https://generativelanguage.googleapis.com/v1', 'gemini-3-pro'),
        'https://generativelanguage.googleapis.com/v1/models/gemini-3-pro:streamGenerateContent?alt=sse'
    );
    assert.equal(
        buildGeminiEndpoint('https://generativelanguage.googleapis.com/v1beta', 'gemini-3-pro'),
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse'
    );
    assert.equal(
        buildGeminiEndpoint('https://gateway.test/{model}:streamGenerateContent', 'models/custom-model'),
        'https://gateway.test/models/custom-model:streamGenerateContent?alt=sse'
    );
    assert.equal(
        buildGeminiEndpoint('https://gateway.test/{model}:streamGenerateContent', 'gemini-3-pro'),
        'https://gateway.test/models/gemini-3-pro:streamGenerateContent?alt=sse'
    );
    assert.equal(
        buildGeminiEndpoint('https://gateway.test/{model}:streamGenerateContent', 'tunedModels/custom-model'),
        'https://gateway.test/tunedModels/custom-model:streamGenerateContent?alt=sse'
    );
    assert.equal(buildGeminiEndpoint('https://gateway.test/v1beta', 'gemini/unsafe'), '');
});

for (const version of ['v1', 'v1beta']) {
    for (const suffix of ['', '/', '?region=us&alt=json']) {
        test(`buildGeminiEndpoint preserves ${version} with gateway prefix and suffix ${suffix || '(none)'}`, () => {
            const endpoint = new URL(
                buildGeminiEndpoint(`https://gateway.test/gemini/${version}${suffix}`, 'gemini-3-pro')
            );
            assert.equal(endpoint.origin, 'https://gateway.test');
            assert.equal(endpoint.pathname, `/gemini/${version}/models/gemini-3-pro:streamGenerateContent`);
            assert.equal(endpoint.searchParams.get('alt'), 'sse');
            assert.equal(endpoint.searchParams.get('region'), suffix.startsWith('?') ? 'us' : null);
        });
    }
}

test('buildGeminiEndpoint defaults to v1beta only without an explicit version segment', () => {
    for (const prefix of ['', '/gemini', '/v1proxy', '/v1beta-proxy']) {
        assert.equal(
            buildGeminiEndpoint(`https://gateway.test${prefix}`, 'gemini-3-pro'),
            `https://gateway.test${prefix}/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse`
        );
    }
});

test('buildGeminiEndpoint preserves complete method endpoints for both API versions', () => {
    for (const version of ['v1', 'v1beta']) {
        for (const method of ['generateContent', 'streamGenerateContent']) {
            assert.equal(
                buildGeminiEndpoint(
                    `https://gateway.test/${version}/models/shared:${method}?region=us&alt=json`,
                    'gemini-3-pro'
                ),
                `https://gateway.test/${version}/models/shared:streamGenerateContent?region=us&alt=sse`
            );
        }
    }
});

test('buildGeminiAuthHeaders uses Google API keys only for official endpoints', () => {
    assert.deepEqual(buildGeminiAuthHeaders('https://generativelanguage.googleapis.com/v1beta', 'secret'), {
        'x-goog-api-key': 'secret'
    });
    assert.deepEqual(buildGeminiAuthHeaders('https://proxy.generativelanguage.googleapis.com/v1beta', 'secret'), {
        'x-goog-api-key': 'secret'
    });
    assert.deepEqual(buildGeminiAuthHeaders('https://gateway.test/gemini/v1beta', 'secret'), {
        Authorization: 'Bearer secret'
    });
});

test('buildGeminiRequest keeps core fields and merges extra body at protocol levels', () => {
    const body = buildGeminiRequest(
        {
            contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
            systemInstruction: { role: 'user', parts: [{ text: 'system' }] }
        },
        modelConfig({
            generationConfig: { temperature: 0.2, thinkingConfig: { includeThoughts: false } },
            responseModalities: ['TEXT'],
            contents: [{ role: 'user', parts: [{ text: 'must not replace' }] }],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
        }),
        {
            thinking: 'enabled',
            reasoningEffort: 'high',
            serviceTier: 'priority'
        } satisfies Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort' | 'serviceTier'>,
        4096,
        []
    );

    assert.equal(body.contents[0].parts[0].text, 'hello');
    assert.equal(body.systemInstruction?.parts[0].text, 'system');
    assert.equal(body.generationConfig?.maxOutputTokens, 4096);
    assert.equal(body.generationConfig?.temperature, 0.2);
    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: 'HIGH'
    });
    assert.deepEqual(body.responseModalities, ['TEXT']);
    assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    assert.equal(body.serviceTier, 'priority');
});

test('buildGeminiRequest omits unsupported Gemini 3 Pro medium effort', () => {
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        modelConfig(),
        { reasoningEffort: 'medium' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true
    });
});

test('buildGeminiRequest omits unsupported Gemini 3 minimal effort', () => {
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        modelConfig(),
        { reasoningEffort: 'minimal' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false
    });
});

test('buildGeminiRequest keeps minimal level for Gemini 3 Flash-Lite', () => {
    const config = modelConfig();
    config.id = 'gemini-3.1-flash-lite-preview';
    config.model = 'gemini-3.1-flash-lite-preview';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'minimal' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false,
        thinkingLevel: 'MINIMAL'
    });
});

test('buildGeminiRequest keeps minimal level for Gemini 3 Flash', () => {
    const config = modelConfig();
    config.id = 'gemini-3-flash-preview';
    config.model = 'gemini-3-flash-preview';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'minimal' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false,
        thinkingLevel: 'MINIMAL'
    });
});

test('buildGeminiRequest keeps medium level for Gemini 3.1 Flash-Lite', () => {
    const config = modelConfig();
    config.id = 'gemini-3.1-flash-lite-preview';
    config.model = 'gemini-3.1-flash-lite-preview';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'medium' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingLevel: 'MEDIUM'
    });
});

test('buildGeminiRequest omits unsupported Flash-Lite Image medium effort', () => {
    const config = modelConfig();
    config.id = 'gemini-3.1-flash-lite-image-preview';
    config.model = 'gemini-3.1-flash-lite-image-preview';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'medium' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true
    });
});

test('buildGeminiRequest omits unsupported Gemini 3.1 Pro minimal effort', () => {
    const config = modelConfig();
    config.id = 'gemini-3.1-pro-preview';
    config.model = 'gemini-3.1-pro-preview';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'minimal' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false
    });
});

test('buildGeminiRequest keeps configured levels for Gemini 3.6 and 3.7 Flash', () => {
    for (const model of ['gemini-3.6-flash-preview', 'gemini-3.7-flash-preview']) {
        const config = modelConfig();
        config.id = model;
        config.model = model;
        const body = buildGeminiRequest(
            { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
            config,
            { reasoningEffort: 'medium' },
            undefined,
            []
        );

        assert.deepEqual(body.generationConfig?.thinkingConfig, {
            includeThoughts: true,
            thinkingLevel: 'MEDIUM'
        });
    }
});

test('buildGeminiRequest omits unsupported levels for unknown Gemini 3 models', () => {
    const config = modelConfig();
    config.id = 'gemini-3-custom';
    config.model = 'gemini-3-custom';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'medium' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true
    });
});

test('buildGeminiRequest maps Gemini 2.5 reasoning effort to thinking budget', () => {
    const config = modelConfig();
    config.id = 'gemini-2.5-pro';
    config.model = 'gemini-2.5-pro';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'medium' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: true,
        thinkingBudget: 8192
    });
});

test('buildGeminiRequest disables Gemini 2.5 thinking for none effort', () => {
    const config = modelConfig();
    config.id = 'gemini-2.5-flash';
    config.model = 'gemini-2.5-flash';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'none' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false,
        thinkingBudget: 0
    });
});

test('buildGeminiRequest uses the minimum legal budget for Gemini 2.5 Pro', () => {
    const config = modelConfig();
    config.id = 'gemini-2.5-pro';
    config.model = 'gemini-2.5-pro';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'none' },
        undefined,
        []
    );

    assert.deepEqual(body.generationConfig?.thinkingConfig, {
        includeThoughts: false,
        thinkingBudget: 128
    });
});

test('buildGeminiRequest omits inferred thinking config for unknown models', () => {
    const config = modelConfig();
    config.id = 'custom-model';
    config.model = 'custom-model';
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { reasoningEffort: 'high' },
        undefined,
        []
    );

    assert.equal(body.generationConfig?.thinkingConfig, undefined);
});

test('buildGeminiRequest drops a service tier not declared by the model', () => {
    const config = modelConfig();
    config.serviceTier = ['standard'];
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        config,
        { serviceTier: 'priority' },
        undefined,
        []
    );

    assert.equal(body.serviceTier, undefined);
});

test('buildGeminiRequest requires one of the declared tools in Required mode', () => {
    const tools = [
        {
            functionDeclarations: [
                { name: 'search', description: 'Search' },
                { name: 'read_file', description: 'Read file' }
            ]
        }
    ];
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        modelConfig({ toolConfig: { functionCallingConfig: { mode: 'AUTO', custom: true } } }),
        undefined,
        undefined,
        tools,
        'required'
    );

    assert.deepEqual(body.toolConfig, {
        functionCallingConfig: {
            mode: 'ANY',
            custom: true,
            allowedFunctionNames: ['search', 'read_file']
        }
    });
});

test('GeminiStreamParser aggregates multiline SSE data and flushes EOF data', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('event: message\ndata: {"candidates":[\n'), []);
    assert.deepEqual(parser.push('data: {"index":0}]}\n\n{"usageMetadata":{}}'), [
        { data: '{"candidates":[\n{"index":0}]}', isSse: true }
    ]);
    assert.deepEqual(parser.finish(), [{ data: '{"usageMetadata":{}}', isSse: false }]);
});

test('GeminiStreamParser preserves DONE and reports malformed SSE data to the caller', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('data: [DONE]\n\n'), [{ data: '[DONE]', isSse: true }]);
    const malformed = new GeminiStreamParser();
    const payload = malformed.push('data: {not-json}\n\n')[0];
    assert.equal(payload.isSse, true);
    assert.throws(() => JSON.parse(payload.data));
});

test('GeminiStreamParser accepts leading empty events and ignores unknown SSE fields', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('\nfoo: ignored\n: keepalive\ndata: {"candidates":[]}\n\n'), [
        { data: '{"candidates":[]}', isSse: true }
    ]);
    assert.deepEqual(parser.finish(), []);
});

test('GeminiStreamParser accepts a UTF-8 BOM before SSE events', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('\uFEFFdata: {"candidates":[]}\n\n'), [{ data: '{"candidates":[]}', isSse: true }]);
});

test('GeminiStreamParser leaves a non-SSE error body for JSON rejection', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('upstream unavailable'), []);
    const payload = parser.finish()[0];
    assert.equal(payload.isSse, false);
    assert.throws(() => JSON.parse(payload.data));
});

test('GeminiStreamParser returns a formatted JSON object only after its top-level value is complete', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('{\n  "candidates": [{"content": {"parts": [{"text": "a } ] \\" b"}]}}]'), []);
    assert.deepEqual(parser.push('\n}\n'), [
        {
            data: '{\n  "candidates": [{"content": {"parts": [{"text": "a } ] \\" b"}]}}]\n}',
            isSse: false
        }
    ]);
    assert.deepEqual(parser.finish(), []);
});

test('GeminiStreamParser preserves a formatted JSON response array as one payload', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('[\n {"candidates": []},\n {"usageMetadata": {"totalTokenCount": 3}}\n]\n'), [
        {
            data: '[\n {"candidates": []},\n {"usageMetadata": {"totalTokenCount": 3}}\n]',
            isSse: false
        }
    ]);
});

test('GeminiStreamParser leaves incomplete JSON for the caller to reject at EOF', () => {
    const parser = new GeminiStreamParser();
    assert.deepEqual(parser.push('{"candidates": ['), []);
    const payload = parser.finish()[0];
    assert.equal(payload.isSse, false);
    assert.throws(() => JSON.parse(payload.data));
});

test('buildGeminiRequest ignores prototype-pollution keys in extraBody', () => {
    const extraBody = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true}}') as Record<
        string,
        unknown
    >;
    const body = buildGeminiRequest(
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        modelConfig(extraBody),
        undefined,
        128,
        []
    );

    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
    assert.equal((body as { polluted?: boolean }).polluted, undefined);
});
