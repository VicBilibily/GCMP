import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { convertMessagesToGemini } from '../../src/handlers/gemini/geminiConverter';
import { GeminiHandler } from '../../src/handlers/gemini/geminiHandler';
import type { GeminiContent, GeminiPart } from '../../src/handlers/gemini/geminiType';
import { encodeStatefulMarker } from '../../src/handlers/stateful/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
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

    for (const callCount of [1, 3]) {
        test(`实际两轮 SSE 不发送无签名空文本：${callCount} 个调用`, async () => {
            const originalGetApiKey = ApiKeyManager.getApiKey;
            const originalFetch = ConfigManager.fetchWithProxy;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            const source = new vscode.CancellationTokenSource();
            const requests: Array<{ contents: GeminiContent[] }> = [];
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const calls: GeminiPart[] = Array.from({ length: callCount }, (_, index) => ({
                functionCall: { id: `call-${index}`, name: index < 2 ? 'read_file' : 'list_dir', args: { index } },
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
                    { report: part => parts.push(part) },
                    'request-1',
                    'session-1',
                    source.token
                );
                const toolCalls = parts.filter(
                    (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
                );
                assert.equal(toolCalls.length, callCount);
                messages.push(
                    vscode.LanguageModelChatMessage.Assistant(
                        parts.filter(
                            (
                                part
                            ): part is
                                | vscode.LanguageModelTextPart
                                | vscode.LanguageModelToolCallPart
                                | vscode.LanguageModelDataPart =>
                                part instanceof vscode.LanguageModelTextPart ||
                                part instanceof vscode.LanguageModelToolCallPart ||
                                part instanceof vscode.LanguageModelDataPart
                        )
                    ),
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
                    messages,
                    options,
                    { report() {} },
                    'request-2',
                    'session-1',
                    source.token
                );

                assert.equal(requests.length, 2);
                assert.deepEqual(requests[1].contents[1], { role: 'model', parts: calls });
                assert.deepEqual(
                    requests[1].contents[2].parts.map(part => part.functionResponse?.id),
                    toolCalls.map(call => call.callId)
                );
                assert.equal(JSON.stringify(messages), before);
            } finally {
                source.dispose();
                ConfigManager.fetchWithProxy = originalFetch;
                ApiKeyManager.getApiKey = originalGetApiKey;
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
            }
        });
    }
});
