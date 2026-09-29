import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { GeminiHandler, hasGeminiPartialUsage } from '../../src/handlers/gemini/geminiHandler';
import { decodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { TokenUsagesManager, type UpdateActualTokensParams } from '../../src/usages/usagesManager';
import type { RawUsageData } from '../../src/usages/fileLogger/types';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { RetryManager } from '../../src/utils/retry/retryManager';

interface GeminiHandlerTestAccess {
    processStream(
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        token: vscode.CancellationToken,
        idleTimeoutMs?: number,
        markerRequestIdentity?: string
    ): Promise<{
        finalUsage?: RawUsageData;
        streamStartTime?: number;
        streamEndTime?: number;
        cancelled?: boolean;
        finishReason?: string;
        terminalError?: Error;
    }>;
}

function createHandler(): GeminiHandlerTestAccess {
    return Object.create(GeminiHandler.prototype) as GeminiHandlerTestAccess;
}

function createReporter(parts: vscode.LanguageModelResponsePart2[] = []): StreamReporter {
    return new StreamReporter({
        modelName: 'Gemini Test',
        modelId: 'gemini-test',
        provider: 'test-provider',
        sdkMode: 'gemini',
        sessionId: 'session-1',
        progress: { report: part => parts.push(part) }
    });
}

function createSseBody(events: unknown[]): ReadableStream<Uint8Array> {
    const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } }).body!;
}

function createJsonBody(value: unknown): ReadableStream<Uint8Array> {
    return new Response(JSON.stringify(value, null, 2), { headers: { 'content-type': 'application/json' } }).body!;
}

suite('Gemini handler stream lifecycle', () => {
    test('缺少模型级 baseUrl 时不回退到提供商地址', async () => {
        const cancellationSource = new vscode.CancellationTokenSource();
        const handler = new GeminiHandler({
            provider: 'compatible',
            providerConfig: { displayName: 'Compatible', baseUrl: 'https://api.openai.com/v1' }
        } as unknown as GenericModelProvider);

        try {
            await assert.rejects(
                handler.handleRequest(
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        maxOutputTokens: 32000
                    } as vscode.LanguageModelChatInformation,
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        model: 'gemini-3.8-flash'
                    } as never,
                    [],
                    {} as never,
                    { report() {} },
                    'request-missing-base-url',
                    'session-1',
                    cancellationSource.token
                ),
                /baseUrl/
            );
        } finally {
            cancellationSource.dispose();
        }
    });

    test('第三方网关使用 Bearer、合并连续 user turn 并发送 parametersJsonSchema', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
        const cancellationSource = new vscode.CancellationTokenSource();
        let requestHeaders: Headers | undefined;
        let requestBody: Record<string, unknown> | undefined;

        ApiKeyManager.getApiKey = async () => 'test-api-key';
        TokenUsagesManager.instance.updateActualTokens = () => {};
        ConfigManager.fetchWithProxy = (async (_input, init) => {
            requestHeaders = new Headers(init?.headers as HeadersInit);
            requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(
                'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}\n\n',
                { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
        }) as typeof ConfigManager.fetchWithProxy;

        try {
            const handler = new GeminiHandler({
                provider: 'test-provider',
                providerConfig: { displayName: 'Test Provider', baseUrl: 'https://gateway.test/gemini' }
            } as unknown as GenericModelProvider);

            await handler.handleRequest(
                {
                    id: 'gemini-3.8-flash',
                    name: 'Gemini 3.8 Flash',
                    maxOutputTokens: 32000
                } as vscode.LanguageModelChatInformation,
                {
                    id: 'gemini-3.8-flash',
                    name: 'Gemini 3.8 Flash',
                    model: 'gemini-3.8-flash',
                    baseUrl: 'https://gateway.test/gemini'
                } as never,
                [
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        content: [new vscode.LanguageModelTextPart('first')]
                    },
                    {
                        role: vscode.LanguageModelChatMessageRole.User,
                        content: [new vscode.LanguageModelTextPart('second')]
                    }
                ] as never,
                {
                    tools: [
                        {
                            name: 'search',
                            description: 'Search',
                            inputSchema: {
                                type: 'object',
                                properties: { query: { type: 'string', minLength: 1 } },
                                required: ['query']
                            }
                        }
                    ]
                } as never,
                { report() {} },
                'request-1',
                'session-1',
                cancellationSource.token
            );

            assert.equal(requestHeaders?.get('authorization'), 'Bearer test-api-key');
            assert.equal(requestHeaders?.get('x-goog-api-key'), null);
            assert.deepEqual(requestBody?.contents, [{ role: 'user', parts: [{ text: 'first' }, { text: 'second' }] }]);
            assert.deepEqual(requestBody?.tools, [
                {
                    functionDeclarations: [
                        {
                            name: 'search',
                            description: 'Search',
                            parametersJsonSchema: {
                                type: 'object',
                                properties: { query: { type: 'string', minLength: 1 } },
                                required: ['query']
                            }
                        }
                    ]
                }
            ]);
        } finally {
            cancellationSource.dispose();
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            ApiKeyManager.getApiKey = originalGetApiKey;
            TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
        }
    });

    test('跨 chunk 合并 usage 并保留 finish reason 与 responseId', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const reporter = createReporter(parts);
        const result = await createHandler().processStream(
            createSseBody([
                {
                    responseId: 'response-1',
                    usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4 }
                },
                {
                    candidates: [
                        {
                            content: { parts: [{ text: 'ok' }] },
                            finishReason: 'STOP'
                        }
                    ],
                    usageMetadata: { candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 13 }
                }
            ]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        assert.deepEqual(result.finalUsage, {
            promptTokenCount: 10,
            cachedContentTokenCount: 4,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 1,
            totalTokenCount: 13
        });
        assert.equal(result.finishReason, 'stop');
        assert.equal(result.terminalError, undefined);
        assert.equal(reporter.getResponseId(), 'response-1');
        assert.deepEqual(
            parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value),
            ['ok']
        );
    });

    test('格式化完整 JSON 响应可正常输出', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const result = await createHandler().processStream(
            createJsonBody({
                candidates: [{ content: { parts: [{ text: 'json response' }] }, finishReason: 'STOP' }],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
            }),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'stop');
        assert.deepEqual(result.finalUsage, {
            promptTokenCount: 2,
            candidatesTokenCount: 2,
            totalTokenCount: 4
        });
        assert.deepEqual(
            parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value),
            ['json response']
        );
    });

    test('完整 JSON 数组按顺序处理多个 Gemini 事件', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const result = await createHandler().processStream(
            createJsonBody([
                { candidates: [{ content: { parts: [{ text: 'first' }] } }] },
                {
                    candidates: [{ content: { parts: [{ text: 'second' }] }, finishReason: 'STOP' }],
                    usageMetadata: { totalTokenCount: 3 }
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'stop');
        assert.deepEqual(result.finalUsage, { totalTokenCount: 3 });
        assert.deepEqual(
            parts
                .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value),
            ['first', 'second']
        );
    });

    test('非法非 SSE JSON 必须失败而不是静默返回空成功', async () => {
        await assert.rejects(
            createHandler().processStream(
                new Response('{not-json}', { headers: { 'content-type': 'application/json' } }).body!,
                createReporter(),
                new vscode.CancellationTokenSource().token
            ),
            /(?:Gemini.*JSON|JSON.*Gemini)/
        );
    });

    test('MAX_TOKENS 映射为 length', async () => {
        const reporter = createReporter();
        const result = await createHandler().processStream(
            createSseBody([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'length');
        assert.equal(result.terminalError, undefined);
    });

    test('candidate safetyRatings 标记 blocked 时返回内容过滤终态', async () => {
        const reporter = createReporter();
        const result = await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            finishReason: 'STOP',
                            safetyRatings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', blocked: true }]
                        }
                    ]
                }
            ]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'content_filter');
        assert.ok(result.terminalError instanceof vscode.LanguageModelError);
    });

    test('异常 finishReason 返回失败终态并保留 finishMessage', async () => {
        const reporter = createReporter();
        const result = await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            finishReason: 'MALFORMED_FUNCTION_CALL',
                            finishMessage: 'Function arguments are invalid'
                        }
                    ]
                }
            ]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'malformed_function_call');
        assert.match(result.terminalError?.message ?? '', /Function arguments are invalid/);
    });

    test('promptFeedback 安全阻断返回 blocked 终态并保留 usage', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const reporter = createReporter(parts);
        const result = await createHandler().processStream(
            createSseBody([
                {
                    promptFeedback: {
                        blockReason: 'SAFETY',
                        safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', blocked: true }]
                    },
                    usageMetadata: { promptTokenCount: 5 }
                }
            ]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        assert.equal(result.finishReason, 'content_filter');
        assert.ok(result.terminalError instanceof vscode.LanguageModelError);
        assert.equal(
            (result.terminalError as vscode.LanguageModelError).code,
            vscode.LanguageModelError.Blocked().code
        );
        assert.deepEqual(result.finalUsage, { promptTokenCount: 5 });
        assert.equal(
            parts.some(part => part instanceof vscode.LanguageModelTextPart),
            false
        );
    });

    for (const code of ['429', '503']) {
        test(`流内字符串错误码 ${code} 可进入重试分类`, async () => {
            const reporter = createReporter();
            await assert.rejects(
                createHandler().processStream(
                    createSseBody([{ error: { code, message: 'temporary upstream failure' } }]),
                    reporter,
                    new vscode.CancellationTokenSource().token
                ),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    const retryable = error as Error & { status?: number; error?: unknown };
                    assert.equal(retryable.status, Number(code));
                    assert.deepEqual(retryable.error, { code, message: 'temporary upstream failure' });
                    assert.equal(
                        code === '429' ?
                            RetryManager.isRateLimitError(retryable)
                        :   RetryManager.isServerError(retryable),
                        true
                    );
                    return true;
                }
            );
        });
    }

    test('流内嵌套字符串状态码可进入服务端重试分类', async () => {
        const reporter = createReporter();
        await assert.rejects(
            createHandler().processStream(
                createSseBody([{ error: { message: 'upstream failure', details: { statusCode: '503' } } }]),
                reporter,
                new vscode.CancellationTokenSource().token
            ),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                const retryable = error as Error & { status?: number };
                assert.equal(retryable.status, 503);
                assert.equal(RetryManager.isServerError(retryable), true);
                return true;
            }
        );
    });

    test('取消时保留已收到的部分 usage', async () => {
        const source = new vscode.CancellationTokenSource();
        const reporter = createReporter();
        const encoder = new TextEncoder();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulls++ === 0) {
                        controller.enqueue(encoder.encode('data: {"usageMetadata":{"promptTokenCount":7}}\n\n'));
                        return;
                    }
                    source.cancel();
                    controller.close();
                }
            },
            { highWaterMark: 0 }
        );

        try {
            const result = await createHandler().processStream(body, reporter, source.token);
            assert.equal(result.cancelled, true);
            assert.deepEqual(result.finalUsage, { promptTokenCount: 7 });
            assert.equal(body.locked, false);
        } finally {
            source.dispose();
        }
    });

    test('正常取消时上报已收到的 partial usage DataPart', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
        const cancellationSource = new vscode.CancellationTokenSource();
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const encoder = new TextEncoder();
        let pulls = 0;
        let actualUpdate: UpdateActualTokensParams | undefined;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulls++ === 0) {
                        controller.enqueue(encoder.encode('data: {"usageMetadata":{"totalTokenCount":9}}\n\n'));
                        return;
                    }
                    cancellationSource.cancel();
                    controller.close();
                }
            },
            { highWaterMark: 0 }
        );

        ApiKeyManager.getApiKey = async () => 'test-api-key';
        TokenUsagesManager.instance.updateActualTokens = params => {
            actualUpdate = params;
        };
        ConfigManager.fetchWithProxy = (async () =>
            new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            })) as typeof ConfigManager.fetchWithProxy;

        try {
            const handler = new GeminiHandler({
                provider: 'test-provider',
                providerConfig: { displayName: 'Test Provider', baseUrl: 'https://gateway.test/gemini' }
            } as unknown as GenericModelProvider);

            await assert.rejects(
                handler.handleRequest(
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        maxOutputTokens: 32000
                    } as vscode.LanguageModelChatInformation,
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        model: 'gemini-3.8-flash',
                        baseUrl: 'https://gateway.test/gemini'
                    } as never,
                    [],
                    {} as never,
                    { report: part => parts.push(part) },
                    'request-clean-cancel-partial-usage',
                    'session-1',
                    cancellationSource.token
                ),
                error => error instanceof vscode.CancellationError
            );

            assert.equal(actualUpdate?.status, 'cancelled');
            assert.deepEqual(actualUpdate?.rawUsage, { totalTokenCount: 9 });
            const usagePart = parts.find(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.Usage
            );
            assert.deepEqual(JSON.parse(new TextDecoder().decode(usagePart?.data)), {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 9,
                prompt_tokens_details: { cached_tokens: 0 }
            });
        } finally {
            cancellationSource.dispose();
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            ApiKeyManager.getApiKey = originalGetApiKey;
            TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
        }
    });

    test('流读取异常携带已收到的 partial usage', async () => {
        const encoder = new TextEncoder();
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulls++ === 0) {
                        controller.enqueue(encoder.encode('data: {"usageMetadata":{"promptTokenCount":7}}\n\n'));
                        return;
                    }
                    controller.error(new Error('connection reset'));
                }
            },
            { highWaterMark: 0 }
        );

        await assert.rejects(
            createHandler().processStream(body, createReporter(), new vscode.CancellationTokenSource().token),
            (error: unknown) => {
                assert.equal(hasGeminiPartialUsage(error), true);
                assert.match(error instanceof Error ? error.message : '', /connection reset/);
                return true;
            }
        );
        assert.equal(body.locked, false);
    });

    test('reader abort 拒绝时按取消状态持久化 partial usage', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
        const cancellationSource = new vscode.CancellationTokenSource();
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const encoder = new TextEncoder();
        let pulls = 0;
        let actualUpdate: UpdateActualTokensParams | undefined;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulls++ === 0) {
                        controller.enqueue(
                            encoder.encode(
                                'data: {"usageMetadata":{"candidatesTokenCount":5,"thoughtsTokenCount":2}}\n\n'
                            )
                        );
                        return;
                    }
                    cancellationSource.cancel();
                    controller.error(new DOMException('aborted', 'AbortError'));
                }
            },
            { highWaterMark: 0 }
        );

        ApiKeyManager.getApiKey = async () => 'test-api-key';
        TokenUsagesManager.instance.updateActualTokens = params => {
            actualUpdate = params;
        };
        ConfigManager.fetchWithProxy = (async () =>
            new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            })) as typeof ConfigManager.fetchWithProxy;

        try {
            const handler = new GeminiHandler({
                provider: 'test-provider',
                providerConfig: { displayName: 'Test Provider', baseUrl: 'https://gateway.test/gemini' }
            } as unknown as GenericModelProvider);

            await assert.rejects(
                handler.handleRequest(
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        maxOutputTokens: 32000
                    } as vscode.LanguageModelChatInformation,
                    {
                        id: 'gemini-3.8-flash',
                        name: 'Gemini 3.8 Flash',
                        model: 'gemini-3.8-flash',
                        baseUrl: 'https://gateway.test/gemini'
                    } as never,
                    [],
                    {} as never,
                    { report: part => parts.push(part) },
                    'request-abort-partial-usage',
                    'session-1',
                    cancellationSource.token
                ),
                error => error instanceof vscode.CancellationError
            );

            assert.equal(actualUpdate?.status, 'cancelled');
            assert.deepEqual(actualUpdate?.rawUsage, { candidatesTokenCount: 5, thoughtsTokenCount: 2 });
            const usagePart = parts.find(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.Usage
            );
            assert.deepEqual(JSON.parse(new TextDecoder().decode(usagePart?.data)), {
                prompt_tokens: 0,
                completion_tokens: 7,
                total_tokens: 7,
                prompt_tokens_details: { cached_tokens: 0 },
                completion_tokens_details: { reasoning_tokens: 2 }
            });
        } finally {
            cancellationSource.dispose();
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            ApiKeyManager.getApiKey = originalGetApiKey;
            TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
        }
    });

    test('流长时间无数据时中止读取并返回可重试超时错误', async () => {
        const body = new ReadableStream<Uint8Array>({});

        await assert.rejects(
            createHandler().processStream(body, createReporter(), new vscode.CancellationTokenSource().token, 20),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal((error as Error & { code?: string }).code, 'ETIMEDOUT');
                assert.equal(RetryManager.isNetworkError(error as Error & { code?: string }), true);
                return true;
            }
        );
        assert.equal(body.locked, false);
    });

    test('thought signature 在工具调用前输出并只消费一次', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const reporter = createReporter(parts);
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            content: {
                                parts: [
                                    { thoughtSignature: 'sig-1' },
                                    { functionCall: { id: 'call-1', name: 'first', args: {} } },
                                    { functionCall: { id: 'call-2', name: 'second', args: {} } }
                                ]
                            },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            reporter,
            new vscode.CancellationTokenSource().token
        );

        const signatures = parts.filter(
            (part): part is vscode.LanguageModelThinkingPart => part instanceof vscode.LanguageModelThinkingPart
        );
        const calls = parts.filter(
            (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
        );
        assert.equal(signatures.length, 1);
        assert.equal(signatures[0].metadata?.signature, 'sig-1');
        assert.deepEqual(
            calls.map(call => call.callId),
            ['call-1', 'call-2']
        );

        const markerPart = parts.find(
            (part): part is vscode.LanguageModelDataPart =>
                part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.StatefulMarker
        );
        assert.deepEqual(decodeStatefulMarker(markerPart!.data)?.marker.geminiThoughtSignatures, [
            { callId: 'call-1', name: 'first', signature: 'sig-1' }
        ]);
    });

    test('普通文本 Part 的 thought signature 会输出并写入 marker', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            content: { parts: [{ text: 'answer', thoughtSignature: 'text-sig' }] },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        const signature = parts.find(
            (part): part is vscode.LanguageModelThinkingPart => part instanceof vscode.LanguageModelThinkingPart
        );
        assert.equal(signature?.metadata?.signature, 'text-sig');

        const markerPart = parts.find(
            (part): part is vscode.LanguageModelDataPart =>
                part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.StatefulMarker
        );
        assert.deepEqual(decodeStatefulMarker(markerPart!.data)?.marker.geminiThoughtSignatures, [
            { partKind: 'text', partIndex: 0, signature: 'text-sig' }
        ]);
    });

    test('响应末尾的独立 thought signature 会写入 marker', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            content: { parts: [{ text: 'answer' }, { thoughtSignature: 'final-sig' }] },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        const markerPart = parts.find(
            (part): part is vscode.LanguageModelDataPart =>
                part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.StatefulMarker
        );
        assert.deepEqual(decodeStatefulMarker(markerPart!.data)?.marker.geminiThoughtSignatures, [
            { partKind: 'standalone', partIndex: 0, signature: 'final-sig' }
        ]);
    });

    test('重复的稳定 functionCall 快照只输出一次', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        { content: { parts: [{ functionCall: { id: 'call-1', name: 'write', args: { value: 1 } } }] } }
                    ]
                },
                {
                    candidates: [
                        {
                            content: { parts: [{ functionCall: { id: 'call-1', name: 'write', args: { value: 1 } } }] },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        const calls = parts.filter(
            (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].callId, 'call-1');
    });

    test('仅工具调用响应按到达时间记录流开始而不是 EOF', async () => {
        const originalDateNow = Date.now;
        const events: Array<{ type: string; streamStartTime?: number }> = [];
        const parts: vscode.LanguageModelResponsePart2[] = [];
        const reporter = new StreamReporter({
            modelName: 'Gemini Test',
            modelId: 'gemini-test',
            provider: 'test-provider',
            sdkMode: 'gemini',
            sessionId: 'session-1',
            requestId: 'request-1',
            requestStartTime: 1000,
            progress: { report: part => parts.push(part) },
            onLiveMetrics: event => events.push(event)
        });
        const encoder = new TextEncoder();
        let pulls = 0;
        let now = 1200;
        Date.now = () => now;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulls++ === 0) {
                        controller.enqueue(
                            encoder.encode(
                                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"read_file","args":{}}}]},"finishReason":"STOP"}]}\n\n'
                            )
                        );
                        return;
                    }
                    now = 5000;
                    controller.close();
                }
            },
            { highWaterMark: 0 }
        );

        try {
            const result = await createHandler().processStream(
                body,
                reporter,
                new vscode.CancellationTokenSource().token
            );
            const update = events.filter(event => event.type === 'streamingUpdate').at(-1);
            assert.equal(update?.streamStartTime, 1200);
            assert.equal(result.streamEndTime, 5000);
            assert.equal(parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length, 1);
        } finally {
            Date.now = originalDateNow;
        }
    });

    test('相同 functionCall id 的冲突快照会显式失败', async () => {
        await assert.rejects(
            createHandler().processStream(
                createSseBody([
                    {
                        candidates: [
                            {
                                content: {
                                    parts: [{ functionCall: { id: 'call-1', name: 'write', args: { value: 1 } } }]
                                }
                            }
                        ]
                    },
                    {
                        candidates: [
                            {
                                content: {
                                    parts: [{ functionCall: { id: 'call-1', name: 'write', args: { value: 2 } } }]
                                }
                            }
                        ]
                    }
                ]),
                createReporter(),
                new vscode.CancellationTokenSource().token
            ),
            /call-1/
        );
    });

    test('缺少上游 ID 时仅向 VS Code 生成本地 ID，不污染原始 Gemini Part', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        functionCall: { name: 'read_file', args: { path: 'README.md' } },
                                        thoughtSignature: 'tool-signature'
                                    }
                                ]
                            },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token,
            undefined,
            'request-identity'
        );

        const call = parts.find(
            (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
        );
        assert.ok(call?.callId);

        const markerPart = parts.find(
            (part): part is vscode.LanguageModelDataPart =>
                part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.StatefulMarker
        );
        const marker = decodeStatefulMarker(markerPart!.data)?.marker;
        assert.deepEqual(marker?.geminiContents, [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: { name: 'read_file', args: { path: 'README.md' } },
                        thoughtSignature: 'tool-signature'
                    }
                ]
            }
        ]);
        assert.deepEqual(marker?.geminiToolCalls, [{ localCallId: call.callId, name: 'read_file' }]);
        assert.equal(marker?.geminiRequestIdentity, 'request-identity');
    });

    test('匿名 functionCall 参数增量会归并到命名调用和原始历史', async () => {
        const parts: vscode.LanguageModelResponsePart2[] = [];
        await createHandler().processStream(
            createSseBody([
                {
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        functionCall: {
                                            id: 'call-1',
                                            name: 'write',
                                            args: { first: 1, nested: { first: true } }
                                        }
                                    }
                                ]
                            }
                        }
                    ]
                },
                {
                    candidates: [
                        {
                            content: {
                                parts: [
                                    {
                                        functionCall: {
                                            id: 'call-1',
                                            args: { second: 2, nested: { second: true } }
                                        },
                                        thoughtSignature: 'tool-sig'
                                    }
                                ]
                            },
                            finishReason: 'STOP'
                        }
                    ]
                }
            ]),
            createReporter(parts),
            new vscode.CancellationTokenSource().token
        );

        const call = parts.find(
            (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
        );
        assert.deepEqual(call?.input, {
            first: 1,
            second: 2,
            nested: { first: true, second: true }
        });

        const markerPart = parts.find(
            (part): part is vscode.LanguageModelDataPart =>
                part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.StatefulMarker
        );
        assert.deepEqual(decodeStatefulMarker(markerPart!.data)?.marker.geminiContents, [
            {
                role: 'model',
                parts: [
                    {
                        functionCall: {
                            id: 'call-1',
                            name: 'write',
                            args: {
                                first: 1,
                                second: 2,
                                nested: { first: true, second: true }
                            }
                        },
                        thoughtSignature: 'tool-sig'
                    }
                ]
            }
        ]);
    });

    test('并行工具调用的匿名参数增量无法归属时显式失败', async () => {
        await assert.rejects(
            createHandler().processStream(
                createSseBody([
                    {
                        candidates: [
                            {
                                content: {
                                    parts: [
                                        { functionCall: { name: 'first', args: {} } },
                                        { functionCall: { name: 'second', args: {} } }
                                    ]
                                }
                            }
                        ]
                    },
                    {
                        candidates: [
                            {
                                content: { parts: [{ functionCall: { args: { value: 1 } } }] }
                            }
                        ]
                    }
                ]),
                createReporter(),
                new vscode.CancellationTokenSource().token
            ),
            /parallel tool calls|并行工具调用/
        );
    });

    test('直接端点相同时 wire model 仍参与 marker identity', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
        ApiKeyManager.getApiKey = async () => 'test-api-key';
        TokenUsagesManager.instance.updateActualTokens = () => {};
        ConfigManager.fetchWithProxy = (async () =>
            new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]} ,"finishReason":"STOP"}]}\n\n', {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            })) as typeof ConfigManager.fetchWithProxy;

        const run = async (wireModel: string): Promise<string | undefined> => {
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const handler = new GeminiHandler({
                provider: 'test-provider',
                providerConfig: {
                    displayName: 'Test Provider',
                    baseUrl: 'https://gateway.test/v1beta/models/shared:streamGenerateContent'
                }
            } as unknown as GenericModelProvider);
            const cancellationSource = new vscode.CancellationTokenSource();
            try {
                await handler.handleRequest(
                    {
                        id: 'shared-entry',
                        name: 'Shared Entry',
                        maxOutputTokens: 4096
                    } as vscode.LanguageModelChatInformation,
                    {
                        id: 'shared-entry',
                        name: 'Shared Entry',
                        model: wireModel,
                        baseUrl: 'https://gateway.test/v1beta/models/shared:streamGenerateContent'
                    } as never,
                    [
                        {
                            role: vscode.LanguageModelChatMessageRole.User,
                            content: [new vscode.LanguageModelTextPart('hello')]
                        }
                    ] as never,
                    {} as never,
                    { report: part => parts.push(part) },
                    `request-${wireModel}`,
                    `session-${wireModel}`,
                    cancellationSource.token
                );
            } finally {
                cancellationSource.dispose();
            }
            const markerPart = parts.find(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
            );
            return markerPart ? decodeStatefulMarker(markerPart.data)?.marker.geminiRequestIdentity : undefined;
        };

        try {
            const firstIdentity = await run('gemini-3-flash-preview');
            const secondIdentity = await run('gemini-3-pro-preview');
            assert.ok(firstIdentity);
            assert.ok(secondIdentity);
            assert.notEqual(firstIdentity, secondIdentity);
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            ApiKeyManager.getApiKey = originalGetApiKey;
            TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
        }
    });
});
