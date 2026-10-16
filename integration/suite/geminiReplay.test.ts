import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { convertMessagesToGemini } from '../../src/handlers/gemini/geminiConverter';
import { GeminiHandler } from '../../src/handlers/gemini/geminiHandler';
import type { GeminiContent, GeminiPart } from '../../src/handlers/gemini/geminiType';
import { encodeStatefulMarker, type StatefulMarkerContainer } from '../../src/handlers/stateful/statefulMarker';
import { filterStatefulReplay, SdkReplayCache } from '../../src/handlers/stateful/statefulReplay';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
import { createResponseProcessor } from '../../src/providers/request/responseProcessor';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';

const identity = { provider: 'test-provider', modelId: 'gemini-test', requestIdentity: 'request-identity' };

function createRawMarker(parts: GeminiPart[]): vscode.LanguageModelDataPart {
    return new vscode.LanguageModelDataPart(
        encodeStatefulMarker(identity.modelId, {
            sessionId: 'session-1',
            responseId: 'response-1',
            provider: identity.provider,
            modelId: identity.modelId,
            sdkMode: 'gemini',
            geminiRequestIdentity: identity.requestIdentity,
            geminiContents: [{ role: 'model', parts }]
        }),
        CustomDataPartMimeTypes.StatefulMarker
    );
}

suite('Gemini 原始历史空文本回放', () => {
    for (const callCount of [1, 3]) {
        for (const tail of [
            { text: '' },
            { text: '', thought: true },
            { text: '', thoughtSignature: '' },
            { text: '', thought_signature: '' }
        ] satisfies GeminiPart[]) {
            test(`过滤无签名空文本：${callCount} 个调用，${JSON.stringify(tail)}`, () => {
                const calls: GeminiPart[] = Array.from({ length: callCount }, (_, index) => ({
                    functionCall: { id: `call-${index}`, name: 'read_file', args: { index } },
                    ...(index === 0 ? { thoughtSignature: 'tool-signature' } : {})
                }));
                const marker = createRawMarker([...calls, tail]);
                const before = Buffer.from(marker.data);
                const result = convertMessagesToGemini(
                    [
                        vscode.LanguageModelChatMessage.User('read files'),
                        vscode.LanguageModelChatMessage.Assistant([marker]),
                        vscode.LanguageModelChatMessage.User(
                            calls.map(
                                (_, index) =>
                                    new vscode.LanguageModelToolResultPart(`call-${index}`, [
                                        new vscode.LanguageModelTextPart(`result-${index}`)
                                    ])
                            )
                        )
                    ],
                    identity
                );

                assert.deepEqual(result.contents[1], { role: 'model', parts: calls });
                assert.deepEqual(
                    result.contents[2].parts.map(part => part.functionResponse),
                    calls.map((_, index) => ({
                        id: `call-${index}`,
                        name: 'read_file',
                        response: { result: `result-${index}` }
                    }))
                );
                assert.deepEqual(Buffer.from(marker.data), before);
            });
        }
    }

    test('保留签名空文本、空白、思考及媒体原始顺序', () => {
        const parts: GeminiPart[] = [
            { text: '', thoughtSignature: 'camel-signature' },
            { text: '  \n' },
            { text: '', thought_signature: 'snake-signature' },
            { text: 'reasoning', thought: true, thoughtSignature: 'thinking-signature' },
            { inlineData: { mimeType: 'image/png', data: 'AQID' } },
            { fileData: { mimeType: 'application/pdf', fileUri: 'files/test' } },
            { thoughtSignature: 'standalone-signature' }
        ];
        const result = convertMessagesToGemini(
            [vscode.LanguageModelChatMessage.Assistant([createRawMarker(parts)])],
            identity
        );
        assert.deepEqual(result.contents, [{ role: 'model', parts }]);
    });

    test('原始历史只有无签名空文本时回退可见文本', () => {
        const result = convertMessagesToGemini(
            [
                vscode.LanguageModelChatMessage.Assistant([
                    new vscode.LanguageModelTextPart('answer'),
                    createRawMarker([{ text: '' }])
                ])
            ],
            identity
        );
        assert.deepEqual(result.contents, [{ role: 'model', parts: [{ text: 'answer' }] }]);
    });

    for (const { callCount, sdk, upstreamId } of [1, 3].flatMap(callCount => [
        { callCount, sdk: false, upstreamId: true },
        { callCount, sdk: true, upstreamId: true },
        { callCount, sdk: true, upstreamId: false }
    ])) {
        test(`实际两轮 SSE 不发送无签名空文本：${callCount} 个调用，SDK=${sdk}，上游 ID=${upstreamId}`, async () => {
            const originalGetApiKey = ApiKeyManager.getApiKey;
            const originalFetch = ConfigManager.fetchWithProxy;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            const source = new vscode.CancellationTokenSource();
            const cache = new SdkReplayCache();
            const replayIdentity = {
                ...identity,
                sdkMode: 'gemini',
                sessionId: 'session-1',
                credentialId: 'test-credential'
            };
            const processor = createResponseProcessor({
                behavior: { kind: 'sdk', cacheUsage: true, legacyTurnAffinity: false, auxiliaryResponse: undefined },
                classification: { requestOrigin: 'copilot-sdk' } as Parameters<
                    typeof createResponseProcessor
                >[0]['classification'],
                providerKey: identity.provider,
                modelId: identity.modelId,
                sdkMode: 'gemini-sse',
                requestId: 'request-1',
                sessionId: replayIdentity.sessionId,
                continuity: { version: 1, scope: 'chain', source: 'sdk-session' },
                continuityAgentRole: 'main',
                options: { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: 'gemini-test' },
                token: source.token,
                sdkReplayCache: cache
            });
            const requests: Array<{ contents: GeminiContent[] }> = [];
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const calls: GeminiPart[] = Array.from({ length: callCount }, (_, index) => ({
                functionCall: {
                    ...(upstreamId ? { id: `call-${index}` } : {}),
                    name: index < 2 ? 'read_file' : 'list_dir',
                    args: { index }
                },
                ...(index === 0 ? { thoughtSignature: 'tool-signature' } : {})
            }));
            const sse = (part: GeminiPart, final = false): string =>
                `data: ${JSON.stringify({
                    candidates: [
                        { content: { role: 'model', parts: [part] }, ...(final ? { finishReason: 'STOP' } : {}) }
                    ]
                })}\n\n`;
            ApiKeyManager.getApiKey = async () => 'test-api-key';
            TokenUsagesManager.instance.updateActualTokens = () => {};
            ConfigManager.fetchWithProxy = (async (_input, init) => {
                const request = JSON.parse(String(init?.body)) as { contents: GeminiContent[] };
                requests.push(request);
                for (const content of request.contents) {
                    for (const part of content.parts) {
                        assert.ok(
                            part.text !== '' || part.thoughtSignature || part.thought_signature,
                            '请求回放了无签名空文本 Part'
                        );
                    }
                }
                return new Response(
                    requests.length === 1 ?
                        calls.map(part => sse(part)).join('') + sse({ text: '' }, true)
                    :   sse({ text: 'continued' }, true),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                );
            }) as typeof ConfigManager.fetchWithProxy;

            try {
                const handler = new GeminiHandler({
                    provider: identity.provider,
                    providerConfig: { displayName: 'Test Provider' }
                } as unknown as GenericModelProvider);
                const model: vscode.LanguageModelChatInformation = {
                    id: identity.modelId,
                    name: 'Gemini Test',
                    family: 'gemini',
                    version: 'test',
                    maxInputTokens: 100000,
                    maxOutputTokens: 32000,
                    capabilities: { toolCalling: true, imageInput: false }
                };
                const modelConfig: ModelConfig = {
                    id: identity.modelId,
                    name: 'Gemini Test',
                    tooltip: 'Gemini Test',
                    maxInputTokens: 100000,
                    maxOutputTokens: 32000,
                    capabilities: { toolCalling: true, imageInput: false },
                    baseUrl: 'https://gateway.test/gemini'
                };
                const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: 'gemini-test' };
                const messages = [vscode.LanguageModelChatMessage.User('read files')];
                await handler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    {
                        report: part => {
                            const output =
                                sdk ?
                                    processor(part as unknown as vscode.LanguageModelResponsePart, {
                                        statefulCredentialId: replayIdentity.credentialId
                                    })
                                :   part;
                            if (output !== undefined) {
                                parts.push(output);
                            }
                        }
                    },
                    'request-1',
                    'session-1',
                    source.token
                );
                const toolCalls = parts.filter(
                    (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
                );
                assert.equal(toolCalls.length, callCount);
                if (sdk) {
                    assert.ok(
                        !parts.some(
                            part =>
                                part instanceof vscode.LanguageModelDataPart &&
                                (part.mimeType === CustomDataPartMimeTypes.StatefulMarker ||
                                    part.mimeType === CustomDataPartMimeTypes.SdkContinuity)
                        )
                    );
                }
                const assistantParts =
                    sdk ?
                        (parts.map(part =>
                            part instanceof vscode.LanguageModelThinkingPart ?
                                new vscode.LanguageModelThinkingPart(part.value, part.id, {
                                    signature: part.metadata?.signature
                                })
                            :   part
                        ) as unknown as Array<
                            | vscode.LanguageModelTextPart
                            | vscode.LanguageModelToolCallPart
                            | vscode.LanguageModelDataPart
                        >)
                    :   parts.filter(
                            (
                                part
                            ): part is
                                | vscode.LanguageModelTextPart
                                | vscode.LanguageModelToolCallPart
                                | vscode.LanguageModelDataPart =>
                                part instanceof vscode.LanguageModelTextPart ||
                                part instanceof vscode.LanguageModelToolCallPart ||
                                part instanceof vscode.LanguageModelDataPart
                        );
                messages.push(
                    vscode.LanguageModelChatMessage.Assistant(assistantParts),
                    vscode.LanguageModelChatMessage.User(
                        toolCalls.map(
                            (call, index) =>
                                new vscode.LanguageModelToolResultPart(call.callId, [
                                    new vscode.LanguageModelTextPart(`result-${index}`)
                                ])
                        )
                    )
                );
                const before = JSON.stringify(messages);
                await handler.handleRequest(
                    model,
                    modelConfig,
                    sdk ? filterStatefulReplay(messages, replayIdentity, cache) : messages,
                    options,
                    { report() {} },
                    'request-2',
                    'session-1',
                    source.token
                );

                assert.equal(requests.length, 2);
                assert.deepEqual(requests[1].contents[1], { role: 'model', parts: calls });
                assert.deepEqual(
                    requests[1].contents[2].parts.map(part => part.functionResponse),
                    calls.map((call, index) => ({
                        ...(upstreamId ? { id: `call-${index}` } : {}),
                        name: call.functionCall?.name,
                        response: { result: `result-${index}` }
                    }))
                );
                assert.equal(JSON.stringify(messages), before);
            } finally {
                cache.dispose();
                source.dispose();
                ConfigManager.fetchWithProxy = originalFetch;
                ApiKeyManager.getApiKey = originalGetApiKey;
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
            }
        });
    }
});

suite('SDK Gemini 本地完整回放', () => {
    function fixture(now?: () => number) {
        const cache = new SdkReplayCache(now);
        const source = new vscode.CancellationTokenSource();
        const replayIdentity = {
            ...identity,
            sdkMode: 'gemini',
            sessionId: 'session-1',
            subSessionId: 'sub-1',
            credentialId: 'credential-1'
        };
        const processor = createResponseProcessor({
            behavior: { kind: 'sdk', cacheUsage: true, legacyTurnAffinity: false, auxiliaryResponse: undefined },
            classification: { requestOrigin: 'copilot-sdk' } as Parameters<
                typeof createResponseProcessor
            >[0]['classification'],
            providerKey: identity.provider,
            modelId: identity.modelId,
            sdkMode: 'gemini-sse',
            requestId: 'request-1',
            sessionId: replayIdentity.sessionId,
            subSessionId: replayIdentity.subSessionId,
            continuity: { version: 1, scope: 'subagent', source: 'sdk-session' },
            continuityAgentRole: 'subagent',
            options: { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: 'gemini-test' },
            token: source.token,
            sdkReplayCache: cache
        });
        const toolCalls = [
            new vscode.LanguageModelToolCallPart('local-1', 'read_file', {
                value: 'first',
                context: { before: 1, after: 2 }
            }),
            new vscode.LanguageModelToolCallPart('local-2', 'read_file', { value: 'second' })
        ];
        const raw: GeminiPart[] = [
            { text: '', thoughtSignature: 'empty-signature' },
            {
                functionCall: { name: 'read_file', args: { value: 'first', context: { before: 1, after: 2 } } },
                thoughtSignature: 'call-signature'
            },
            { inlineData: { mimeType: 'image/png', data: 'AQID' } },
            { functionCall: { id: 'upstream-2', name: 'read_file', args: { value: 'second' } } },
            { text: 'signed text', thought_signature: 'text-signature' }
        ];
        const signatures = ['empty-signature', 'call-signature', 'text-signature'];
        const marker: Omit<StatefulMarkerContainer, 'extension'> = {
            ...replayIdentity,
            sdkMode: 'gemini',
            responseId: 'response-1',
            geminiRequestIdentity: identity.requestIdentity,
            geminiContents: [{ role: 'model', parts: raw }],
            geminiThoughtSignatures: signatures.map(signature => ({ signature })),
            geminiToolCalls: [
                { localCallId: 'local-1', name: 'read_file' },
                { localCallId: 'local-2', upstreamCallId: 'upstream-2', name: 'read_file' }
            ]
        };
        const content = [
            ...signatures.map(signature => new vscode.LanguageModelThinkingPart('', undefined, { signature })),
            ...toolCalls
        ] as unknown as vscode.LanguageModelChatMessage['content'];
        const history: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User('read files'),
            { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined },
            vscode.LanguageModelChatMessage.User(
                toolCalls.map(
                    call =>
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart('result')
                        ])
                )
            )
        ];
        const store = (
            overrides: Partial<typeof marker> = {},
            mimeType: string = CustomDataPartMimeTypes.StatefulMarker
        ) => {
            const output = processor(
                new vscode.LanguageModelDataPart(
                    encodeStatefulMarker(identity.modelId, { ...marker, ...overrides }),
                    mimeType
                ),
                { statefulCredentialId: replayIdentity.credentialId }
            );
            assert.equal(output, undefined);
        };
        return { cache, source, replayIdentity, toolCalls, raw, marker, content, history, store };
    }

    for (const change of [
        { provider: 'other' },
        { modelId: 'other' },
        { sdkMode: 'openai' },
        { credentialId: 'other' },
        { sessionId: 'other' },
        { subSessionId: 'other' },
        { credentialId: undefined },
        { sessionId: '' },
        { subSessionId: undefined }
    ]) {
        test(`拒绝身份变化 ${JSON.stringify(change)}`, () => {
            const current = fixture();
            current.store();
            assert.ok(current.cache.getGeminiReplay(current.content, current.replayIdentity));
            const filtered = filterStatefulReplay(
                current.history,
                { ...current.replayIdentity, ...change },
                current.cache
            );
            const converted = convertMessagesToGemini(filtered, identity);
            assert.ok(
                !converted.contents
                    .flatMap(content => content.parts)
                    .some(part => part.functionCall || part.functionResponse || part.thoughtSignature)
            );
        });
    }

    for (const change of [
        'callId',
        'name',
        'input',
        'order',
        'missing call',
        'extra call',
        'missing signature',
        'wrong signature',
        'foreign metadata',
        'ciphertext'
    ]) {
        test(`拒绝工具历史变化 ${change}`, () => {
            const current = fixture();
            current.store();
            switch (change) {
                case 'callId':
                    current.content[3] = new vscode.LanguageModelToolCallPart(
                        'other',
                        'read_file',
                        current.toolCalls[0].input
                    );
                    break;
                case 'name':
                    current.content[3] = new vscode.LanguageModelToolCallPart(
                        'local-1',
                        'other',
                        current.toolCalls[0].input
                    );
                    break;
                case 'input':
                    current.content[3] = new vscode.LanguageModelToolCallPart('local-1', 'read_file', {
                        value: 'changed'
                    });
                    break;
                case 'order':
                    [current.content[3], current.content[4]] = [current.content[4], current.content[3]];
                    break;
                case 'missing call':
                    current.content.pop();
                    break;
                case 'extra call':
                    current.content.push(new vscode.LanguageModelToolCallPart('extra', 'read_file', {}));
                    break;
                case 'missing signature':
                    current.content.shift();
                    break;
                default: {
                    const metadata =
                        change === 'foreign metadata' ? { signature: 'empty-signature', statefulCredentialId: 'other' }
                        : change === 'ciphertext' ? { signature: 'empty-signature', encrypted: 'cipher' }
                        : { signature: 'wrong' };
                    current.content[0] = new vscode.LanguageModelThinkingPart(
                        '',
                        undefined,
                        metadata
                    ) as unknown as vscode.LanguageModelChatMessage['content'][number];
                }
            }
            assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined);
        });
    }

    for (const mime of [CustomDataPartMimeTypes.StatefulMarker, CustomDataPartMimeTypes.SdkContinuity]) {
        test(`隐藏 ${mime}，保留原始顺序和端点校验`, () => {
            const current = fixture();
            current.store({}, mime);
            const filtered = filterStatefulReplay(current.history, current.replayIdentity, current.cache);
            assert.deepEqual(convertMessagesToGemini(filtered, identity).contents[1], {
                role: 'model',
                parts: current.raw
            });
            const rejected = convertMessagesToGemini(filtered, {
                ...identity,
                requestIdentity: 'different-endpoint-or-wire-model'
            });
            assert.ok(
                !rejected.contents
                    .flatMap(content => content.parts)
                    .some(part => part.functionCall || part.functionResponse || part.thoughtSignature)
            );
        });
    }

    test('参数对象键顺序不影响匹配，缓存和返回字节均为独立快照', () => {
        const current = fixture();
        current.store();
        const original = JSON.stringify(current.raw);
        current.content[3] = new vscode.LanguageModelToolCallPart('local-1', 'read_file', {
            context: { after: 2, before: 1 },
            value: 'first'
        });
        const data = current.cache.getGeminiReplay(current.content, current.replayIdentity);
        assert.ok(data);
        data.fill(0);
        current.raw.push({ text: 'later mutation' });
        const result = convertMessagesToGemini(
            filterStatefulReplay(current.history, current.replayIdentity, current.cache),
            identity
        );
        assert.equal(JSON.stringify(result.contents[1].parts), original);
    });

    test('取消、缺少原始状态和非法工具映射不写入缓存', () => {
        for (const change of [
            'cancelled',
            'missing native',
            'missing mapping',
            'wrong upstream',
            'wrong model',
            'wrong session'
        ]) {
            const current = fixture();
            if (change === 'cancelled') {
                current.source.cancel();
            }
            current.store(
                change === 'missing native' ? { geminiContents: undefined }
                : change === 'missing mapping' ? { geminiToolCalls: [] }
                : change === 'wrong upstream' ?
                    {
                        geminiToolCalls: [
                            { localCallId: 'local-1', name: 'read_file', upstreamCallId: 'other' },
                            current.marker.geminiToolCalls![1]
                        ]
                    }
                : change === 'wrong model' ? { modelId: 'other' }
                : change === 'wrong session' ? { sessionId: 'other' }
                : {}
            );
            assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined, change);
            current.source.dispose();
        }
    });

    test('七天过期、释放后不可读取或重新写入', () => {
        let now = 0;
        const current = fixture(() => now);
        current.store();
        now = 7 * 24 * 60 * 60 * 1000 - 1;
        assert.ok(current.cache.getGeminiReplay(current.content, current.replayIdentity));
        now++;
        assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined);
        current.store();
        assert.ok(current.cache.getGeminiReplay(current.content, current.replayIdentity));
        current.cache.dispose();
        current.store();
        assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined);
    });

    test('容量限制淘汰最旧项，刷新不重复累计容量', () => {
        const current = fixture();
        current.store();
        for (let index = 1; index <= 1000; index++) {
            current.store({
                geminiToolCalls: [
                    { localCallId: `local-${index + 2}`, name: 'read_file' },
                    current.marker.geminiToolCalls![1]
                ]
            });
        }
        assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined);
        current.store();
        for (let index = 0; index < 1001; index++) {
            current.store();
        }
        assert.ok(current.cache.getGeminiReplay(current.content, current.replayIdentity));
    });

    test('总字节上限淘汰旧项，过大单项不覆盖已存在的有效状态', function () {
        this.timeout(15000);
        const current = fixture();
        const large = { role: 'model' as const, parts: [...current.raw, { text: 'x'.repeat(9 * 1024 * 1024) }] };
        current.store({ geminiContents: [large] });
        assert.ok(current.cache.getGeminiReplay(current.content, current.replayIdentity));
        current.store({
            geminiContents: [large],
            geminiToolCalls: [{ localCallId: 'new-local', name: 'read_file' }, current.marker.geminiToolCalls![1]]
        });
        assert.equal(current.cache.getGeminiReplay(current.content, current.replayIdentity), undefined);
        current.store();
        current.store({
            geminiContents: [{ role: 'model', parts: [...current.raw, { text: 'x'.repeat(17 * 1024 * 1024) }] }]
        });
        const result = convertMessagesToGemini(
            filterStatefulReplay(current.history, current.replayIdentity, current.cache),
            identity
        );
        assert.deepEqual(result.contents[1].parts, current.raw);
    });
});
