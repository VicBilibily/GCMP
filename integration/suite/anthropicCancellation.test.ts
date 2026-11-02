import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';

import { AnthropicHandler } from '../../src/handlers/anthropic/anthropicHandler';
import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { StreamReporter } from '../../src/handlers/streamReporter';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { ConfigManager } from '../../src/utils/config/configManager';
import { getAnthropicRetryDelayMs, shouldRetryAnthropicRequest } from '../../src/handlers/anthropic/anthropicRetry';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { RetryManager } from '../../src/utils/retry/retryManager';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
import { hasFinalStatusRecorded } from '../../src/utils/runtime/finalStatusMarker';
import { Logger } from '../../src/utils/runtime/logger';

interface AnthropicHandlerTestAccess {
    createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic>;
    getModelRequestHeaderDeletions(modelConfig?: ModelConfig): Record<string, string | null>;
    handleAnthropicStream(stream: AsyncIterable<unknown>, reporter: unknown, token: unknown): Promise<unknown>;
}

suite('Anthropic cancellation', () => {
    for (const scenario of [
        'complete',
        'eof',
        'error',
        'cancel',
        'complete-usage-only',
        'eof-usage-only',
        'error-usage-only',
        'complete-nullable',
        'complete-zero',
        'complete-server-omitted',
        'complete-server-null',
        'complete-server-zero'
    ]) {
        for (const width of [1, 4096]) {
            test(`public Anthropic preserves received usage: ${scenario}, ${width}`, async () => {
                const ending = scenario.split('-')[0];
                const withText = !scenario.endsWith('usage-only');
                const inputTokens = scenario === 'complete-zero' ? 0 : 21;
                const cacheCreationTokens = scenario === 'complete-zero' ? 0 : 2;
                const cacheReadTokens = scenario === 'complete-zero' ? 0 : 3;
                const serverTools = { web_search_requests: 2, web_fetch_requests: 1 };
                const deltaUsage = {
                    output_tokens: 13,
                    ...(scenario === 'complete-nullable' || scenario === 'complete-zero' ?
                        {
                            input_tokens: scenario.endsWith('nullable') ? null : 0,
                            cache_creation_input_tokens: scenario.endsWith('nullable') ? null : 0,
                            cache_read_input_tokens: scenario.endsWith('nullable') ? null : 0
                        }
                    :   {}),
                    ...(scenario === 'complete-server-null' ? { server_tool_use: null }
                    : scenario === 'complete-server-zero' ?
                        { server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } }
                    :   {})
                };
                const source = new vscode.CancellationTokenSource();
                const provider = {
                    provider: 'test',
                    providerConfig: { displayName: 'Test', baseUrl: 'https://example.test' }
                } as unknown as GenericModelProvider;
                const handler = new AnthropicHandler(provider);
                const events = [
                    {
                        type: 'message_start',
                        message: {
                            id: 'msg-usage',
                            usage: {
                                input_tokens: 21,
                                output_tokens: 0,
                                cache_creation_input_tokens: 2,
                                cache_read_input_tokens: 3,
                                ...(scenario.startsWith('complete-server-') ? { server_tool_use: serverTools } : {})
                            }
                        }
                    },
                    ...(withText ?
                        [
                            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } },
                            { type: 'content_block_stop', index: 0 }
                        ]
                    :   []),
                    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: deltaUsage },
                    ...(ending === 'complete' ? [{ type: 'message_stop' }] : []),
                    ...(ending === 'error' ?
                        [{ type: 'error', error: { type: 'overloaded_error', message: 'usage test upstream error' } }]
                    :   [])
                ];
                const bytes = new TextEncoder().encode(
                    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
                );
                let offset = 0;
                const body = new ReadableStream<Uint8Array>(
                    {
                        pull(controller) {
                            if (offset < bytes.length) {
                                controller.enqueue(bytes.subarray(offset, offset + width));
                                offset += width;
                            } else {
                                controller.close();
                            }
                        }
                    },
                    { highWaterMark: 0 }
                );
                const client = new Anthropic({
                    apiKey: 'test',
                    maxRetries: 0,
                    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
                });
                (handler as unknown as AnthropicHandlerTestAccess).createAnthropicClient = async () => client;
                const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                const updates: Parameters<typeof originalUpdate>[0][] = [];
                TokenUsagesManager.instance.updateActualTokens = update => {
                    updates.push(update);
                };
                const text: string[] = [];
                try {
                    const request = handler.handleRequest(
                        { id: 'test', name: 'Test', maxOutputTokens: 128 } as vscode.LanguageModelChatInformation,
                        { id: 'test' } as ModelConfig,
                        [],
                        {} as vscode.ProvideLanguageModelChatResponseOptions,
                        {
                            report(part) {
                                if (part instanceof vscode.LanguageModelTextPart) {
                                    text.push(part.value);
                                    if (ending === 'cancel') {
                                        source.cancel();
                                    }
                                }
                            }
                        },
                        'usage-request',
                        'usage-session',
                        source.token
                    );
                    if (ending === 'complete') {
                        await request;
                    } else {
                        await assert.rejects(request, error => {
                            assert.ok(error instanceof Error);
                            assert.equal(error instanceof vscode.CancellationError, ending === 'cancel');
                            if (ending === 'eof') {
                                assert.match(error.message, /message_stop/);
                            } else if (ending === 'error') {
                                assert.match(error.message, /usage test upstream error/);
                            }
                            return true;
                        });
                    }
                    assert.deepEqual(text, withText ? ['part'] : []);
                    assert.equal(body.locked, false);
                    assert.equal(updates.length, 1);
                    assert.equal(
                        updates[0].status,
                        ending === 'complete' ? 'completed'
                        : ending === 'cancel' ? 'cancelled'
                        : 'failed'
                    );
                    assert.deepEqual(updates[0].rawUsage, {
                        input_tokens: inputTokens,
                        output_tokens: ending === 'cancel' ? 0 : 13,
                        cache_creation_input_tokens: cacheCreationTokens,
                        cache_read_input_tokens: cacheReadTokens,
                        ...(scenario.startsWith('complete-server-') ?
                            {
                                server_tool_use:
                                    scenario === 'complete-server-zero' ?
                                        { web_search_requests: 0, web_fetch_requests: 0 }
                                    :   serverTools
                            }
                        :   {})
                    });
                } finally {
                    TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                    source.dispose();
                }
            });
        }
    }

    for (const scenario of [
        'error-none',
        'error-usage',
        'error-marker',
        'error-metrics',
        'error-usage-logger',
        'error-marker-logger',
        'error-metrics-logger',
        'cancel-metrics',
        'cancel-metrics-logger',
        'complete-metrics',
        'complete-metrics-logger',
        'complete-finally',
        'complete-finally-logger'
    ]) {
        for (const width of [1, 4096]) {
            test(`public Anthropic cleanup preserves primary failure: ${scenario}, ${width}`, async () => {
                const ending = scenario.split('-')[0];
                const fault = scenario.split('-')[1];
                const failLogging = scenario.endsWith('-logger');
                const cleanupError = new Error('injected Anthropic cleanup failure');
                const originalMetrics = StreamReporter.prototype.finishMetrics;
                const originalWarn = Logger.warn;
                const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                const updates: Parameters<typeof originalUpdate>[0][] = [];
                const source = new vscode.CancellationTokenSource();
                let subscriptions = 0;
                let disposals = 0;
                let faultHits = 0;
                let warningFailures = 0;
                let metricsCalls = 0;
                const token: vscode.CancellationToken = {
                    get isCancellationRequested() {
                        return source.token.isCancellationRequested;
                    },
                    onCancellationRequested(listener) {
                        subscriptions++;
                        const subscription = source.token.onCancellationRequested(listener);
                        return {
                            dispose() {
                                disposals++;
                                subscription.dispose();
                            }
                        };
                    }
                };
                const provider = {
                    provider: 'test',
                    providerConfig: { displayName: 'Test', baseUrl: 'https://example.test' }
                } as unknown as GenericModelProvider;
                const handler = new AnthropicHandler(provider);
                const events = [
                    {
                        type: 'message_start',
                        message: {
                            id: 'msg-cleanup',
                            usage: {
                                input_tokens: 21,
                                output_tokens: 0,
                                cache_creation_input_tokens: 2,
                                cache_read_input_tokens: 3
                            }
                        }
                    },
                    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } },
                    { type: 'content_block_stop', index: 0 },
                    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 13 } },
                    ...(ending === 'complete' ? [{ type: 'message_stop' }]
                    : ending === 'error' ?
                        [{ type: 'error', error: { type: 'overloaded_error', message: 'cleanup upstream error' } }]
                    :   [])
                ];
                const bytes = new TextEncoder().encode(
                    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
                );
                let offset = 0;
                const body = new ReadableStream<Uint8Array>(
                    {
                        pull(controller) {
                            if (offset < bytes.length) {
                                controller.enqueue(bytes.subarray(offset, offset + width));
                                offset += width;
                            } else {
                                controller.close();
                            }
                        }
                    },
                    { highWaterMark: 0 }
                );
                const client = new Anthropic({
                    apiKey: 'test',
                    maxRetries: 0,
                    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
                });
                (handler as unknown as AnthropicHandlerTestAccess).createAnthropicClient = async () => client;
                const text: string[] = [];
                try {
                    TokenUsagesManager.instance.updateActualTokens = update => updates.push(update);
                    if (fault === 'metrics' || fault === 'finally') {
                        StreamReporter.prototype.finishMetrics = function () {
                            originalMetrics.call(this);
                            metricsCalls++;
                            if (fault === 'metrics' || metricsCalls > 1) {
                                faultHits++;
                                throw cleanupError;
                            }
                        };
                    }
                    if (failLogging) {
                        Logger.warn = (...args: Parameters<typeof originalWarn>) => {
                            if (args[0] === '[OpenAI] Stream cleanup failed') {
                                warningFailures++;
                                throw new Error('injected cleanup logger failure');
                            }
                            originalWarn.apply(Logger, args);
                        };
                    }
                    const request = handler.handleRequest(
                        { id: 'test', name: 'Test', maxOutputTokens: 128 } as vscode.LanguageModelChatInformation,
                        { id: 'test' } as ModelConfig,
                        [],
                        {} as vscode.ProvideLanguageModelChatResponseOptions,
                        {
                            report(part) {
                                if (part instanceof vscode.LanguageModelTextPart) {
                                    text.push(part.value);
                                    if (ending === 'cancel') {
                                        source.cancel();
                                    }
                                }
                                if (
                                    part instanceof vscode.LanguageModelDataPart &&
                                    ((fault === 'usage' && part.mimeType === CustomDataPartMimeTypes.Usage) ||
                                        (fault === 'marker' &&
                                            part.mimeType === CustomDataPartMimeTypes.StatefulMarker))
                                ) {
                                    faultHits++;
                                    throw cleanupError;
                                }
                            }
                        },
                        'cleanup-request',
                        'cleanup-session',
                        token
                    );
                    await assert.rejects(request, error => {
                        assert.ok(error instanceof Error);
                        if (ending === 'cancel') {
                            assert.ok(error instanceof vscode.CancellationError);
                        } else if (ending === 'complete') {
                            assert.equal(error, cleanupError);
                        } else {
                            assert.ok(error instanceof Anthropic.APIError);
                            assert.match(error.message, /cleanup upstream error/);
                        }
                        if (ending !== 'cancel') {
                            assert.equal(hasFinalStatusRecorded(error), fault !== 'finally');
                        }
                        return true;
                    });
                    assert.deepEqual(text, ['part']);
                    assert.equal(body.locked, false);
                    assert.equal(subscriptions, 1);
                    assert.equal(disposals, subscriptions);
                    assert.equal(faultHits > 0, fault !== 'none');
                    assert.equal(warningFailures > 0, failLogging);
                    assert.equal(updates.length, 1);
                    assert.equal(
                        updates[0].status,
                        ending === 'cancel' ? 'cancelled'
                        : fault === 'finally' ? 'completed'
                        : 'failed'
                    );
                    assert.deepEqual(updates[0].rawUsage, {
                        input_tokens: 21,
                        output_tokens: ending === 'cancel' ? 0 : 13,
                        cache_creation_input_tokens: 2,
                        cache_read_input_tokens: 3
                    });
                } finally {
                    StreamReporter.prototype.finishMetrics = originalMetrics;
                    Logger.warn = originalWarn;
                    TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                    source.dispose();
                }
            });
        }
    }

    test('message_stop finishes iteration without requesting another event', async () => {
        const handler = new AnthropicHandler({} as GenericModelProvider) as unknown as AnthropicHandlerTestAccess;
        let closed = false;
        let terminalReads = 0;
        async function* stream() {
            try {
                yield { type: 'message_stop' };
                terminalReads++;
                throw new Error('read after message_stop');
            } finally {
                closed = true;
            }
        }
        await handler.handleAnthropicStream(
            stream(),
            { heartbeat() {}, flushAll() {}, getMetricStreamStartTime() {} },
            { isCancellationRequested: false }
        );
        assert.equal(terminalReads, 0);
        assert.equal(closed, true);
    });

    for (const keepOpen of [false, true]) {
        test(`message_stop completes local HTTP stream: keepOpen=${keepOpen}`, async () => {
            const handler = new AnthropicHandler({} as GenericModelProvider) as unknown as AnthropicHandlerTestAccess;
            let serverResponse: ServerResponse | undefined;
            const events = [
                {
                    type: 'message_start',
                    message: { id: 'msg-terminal', usage: { input_tokens: 21, output_tokens: 0 } }
                },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 13 } },
                { type: 'message_stop' }
            ];
            const server = createServer((request, response) => {
                request.resume();
                serverResponse = response;
                response.writeHead(200, { 'content-type': 'text/event-stream' });
                response.write(
                    events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
                );
                if (!keepOpen) {
                    response.end();
                }
            });
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            });
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            const client = new Anthropic({
                apiKey: 'test',
                baseURL: `http://127.0.0.1:${address.port}`,
                maxRetries: 0
            });
            const abortController = new AbortController();
            let markTerminal: () => void = () => {};
            const terminal = new Promise<void>(resolve => {
                markTerminal = resolve;
            });
            const text: string[] = [];
            const reporter = {
                heartbeat() {},
                markStreamStarted() {},
                setResponseId() {},
                flushSignature() {},
                getSessionId() {
                    return 'test';
                },
                getMetricStreamStartTime() {
                    return undefined;
                },
                reportText(value: string) {
                    text.push(value);
                },
                flushAll() {
                    markTerminal();
                }
            };
            let request: Promise<unknown> | undefined;
            let deadline: NodeJS.Timeout | undefined;
            try {
                const stream = await client.messages.create(
                    { model: 'test', max_tokens: 16, messages: [{ role: 'user', content: 'test' }], stream: true },
                    { signal: abortController.signal }
                );
                request = handler.handleAnthropicStream(stream, reporter, { isCancellationRequested: false });
                await Promise.race([terminal, request]);
                const outcome = await Promise.race([
                    request.then(() => 'completed'),
                    new Promise<string>(resolve => {
                        deadline = setTimeout(() => resolve('waiting-for-EOF'), 80);
                    })
                ]);
                assert.equal(outcome, 'completed');
                assert.deepEqual(text, ['complete']);
            } finally {
                clearTimeout(deadline);
                abortController.abort();
                serverResponse?.end();
                await request?.catch(() => {});
                server.closeAllConnections();
                await new Promise<void>(resolve => {
                    server.close(() => resolve());
                });
            }
        });
    }

    test('工具等待对应 block stop、抑制重放且丢弃不完整 JSON', async () => {
        const handler = new AnthropicHandler({} as GenericModelProvider) as unknown as AnthropicHandlerTestAccess;
        const calls: unknown[] = [];
        const reporter = {
            get hasContent() {
                return calls.length > 0;
            },
            heartbeat() {},
            reportToolArgDelta() {},
            flushSignature() {},
            flushAll() {},
            getModelName() {
                return 'test';
            },
            getMetricStreamStartTime() {
                return undefined;
            },
            reportToolCall(_id: string, _name: string, args: unknown) {
                calls.push(args);
            }
        };
        const start = (index: number) => ({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: 'same', name: 'read_file', input: {} }
        });
        const delta = (index: number, partial_json: string) => ({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json }
        });
        const stop = (index: number) => ({ type: 'content_block_stop', index });
        async function* stream() {
            yield start(0);
            yield delta(0, '{"a":1}');
            assert.equal(calls.length, 0);
            yield start(1);
            yield delta(1, '{"b":2}');
            yield stop(0);
            yield stop(1);
            yield start(0);
            yield delta(0, '{"a":1}');
            yield stop(0);
            yield start(2);
            yield delta(2, '{"broken":');
            yield stop(2);
            yield start(3);
            yield stop(3);
            yield { type: 'message_stop' };
        }
        await handler.handleAnthropicStream(stream(), reporter, { isCancellationRequested: false });
        assert.deepEqual(calls, [{ a: 1 }, { b: 2 }, {}]);
    });

    for (const ending of [
        'empty',
        'heartbeat',
        'created',
        'pending-tool',
        'completed-empty',
        'text',
        'tool',
        'thinking',
        'completed-text',
        'completed-tool',
        'completed-thinking',
        'terminal-with-pending-tool',
        'cancelled'
    ]) {
        test(`空结果与终态判定：${ending}`, async () => {
            const handler = new AnthropicHandler({} as GenericModelProvider) as unknown as AnthropicHandlerTestAccess;
            const cancellation = new vscode.CancellationTokenSource();
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const reporter = new StreamReporter({
                modelName: 'test',
                modelId: 'test',
                provider: 'anthropic-test',
                sdkMode: 'anthropic',
                progress: { report: part => parts.push(part) }
            });
            async function* stream() {
                if (ending === 'heartbeat') {
                    yield { type: 'ping' };
                } else if (ending === 'created') {
                    yield {
                        type: 'message_start',
                        message: { id: 'empty', usage: { input_tokens: 1, output_tokens: 0 } }
                    };
                } else if (
                    ending === 'pending-tool' ||
                    ending === 'tool' ||
                    ending === 'completed-tool' ||
                    ending === 'terminal-with-pending-tool'
                ) {
                    yield {
                        type: 'content_block_start',
                        index: 0,
                        content_block: {
                            type: 'tool_use',
                            id: 'call-empty',
                            name: 'read_file',
                            input: {}
                        }
                    };
                    if (ending === 'tool' || ending === 'completed-tool') {
                        yield { type: 'content_block_stop', index: 0 };
                    }
                    if (ending === 'terminal-with-pending-tool') {
                        yield { type: 'message_stop' };
                    }
                } else if (ending === 'completed-empty') {
                    yield { type: 'message_stop' };
                } else if (ending === 'text' || ending === 'completed-text') {
                    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } };
                } else if (ending === 'thinking' || ending === 'completed-thinking') {
                    yield {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'thinking_delta', thinking: 'partial' }
                    };
                } else if (ending === 'cancelled') {
                    cancellation.cancel();
                }
                if (ending.startsWith('completed-') && ending !== 'completed-empty') {
                    yield { type: 'message_stop' };
                }
            }
            try {
                const request = handler.handleAnthropicStream(stream(), reporter, cancellation.token);
                if (ending.startsWith('completed-')) {
                    await request;
                    assert.equal(reporter.hasContent, ending !== 'completed-empty');
                    assert.equal(
                        parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length,
                        ending === 'completed-tool' ? 1 : 0
                    );
                } else {
                    await assert.rejects(request, (error: unknown) => {
                        assert.ok(error instanceof Error);
                        assert.equal(error instanceof vscode.CancellationError, ending === 'cancelled');
                        if (ending !== 'cancelled') {
                            assert.match(error.message, /message_stop|unfinished content blocks/);
                        }
                        return true;
                    });
                    assert.equal(reporter.hasContent, ['text', 'tool', 'thinking'].includes(ending));
                    assert.equal(
                        parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length,
                        ending === 'tool' ? 1 : 0
                    );
                    if (ending === 'text') {
                        assert.equal(
                            parts
                                .filter(part => part instanceof vscode.LanguageModelTextPart)
                                .map(part => part.value)
                                .join(''),
                            'partial'
                        );
                    }
                }
            } finally {
                reporter.finishMetrics();
                cancellation.dispose();
            }
        });
    }

    test('禁用 SDK 内部重试，由外层重试链统一处理', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        ApiKeyManager.getApiKey = async () => 'test-api-key';

        try {
            const providerInstance = {
                provider: 'anthropic-test',
                providerConfig: {
                    displayName: 'Anthropic Test',
                    baseUrl: 'http://127.0.0.1'
                }
            } as unknown as GenericModelProvider;
            const handler = new AnthropicHandler(providerInstance) as unknown as AnthropicHandlerTestAccess;
            const client = await handler.createAnthropicClient({
                id: 'test-model',
                name: 'Test Model',
                tooltip: 'Test Model',
                maxInputTokens: 1024,
                maxOutputTokens: 128,
                capabilities: {
                    toolCalling: false,
                    imageInput: false
                },
                sdkMode: 'anthropic',
                provider: 'anthropic-test',
                baseUrl: 'http://127.0.0.1',
                proxy: 'noproxy'
            });

            assert.equal(client.maxRetries, 0);
        } finally {
            ApiKeyManager.getApiKey = originalGetApiKey;
        }
    });

    test('Claude User-Agent 由 GCMP 提供，Stainless 指纹由 Anthropic SDK 添加', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalCreateProxyAwareFetch = ConfigManager.createProxyAwareFetch;
        let requestHeaders: Headers | undefined;
        ApiKeyManager.getApiKey = async () => 'test-api-key';
        ConfigManager.createProxyAwareFetch = (() => {
            return async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                requestHeaders = request.headers;
                return new Response(
                    JSON.stringify({
                        id: 'msg_test',
                        type: 'message',
                        role: 'assistant',
                        model: 'claude-sonnet-4-5',
                        content: [{ type: 'text', text: 'ok' }],
                        stop_reason: 'end_turn',
                        stop_sequence: null,
                        usage: { input_tokens: 1, output_tokens: 1 }
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            };
        }) as typeof ConfigManager.createProxyAwareFetch;

        try {
            const providerInstance = {
                provider: 'compatible-test',
                providerConfig: {
                    displayName: 'Compatible Test',
                    baseUrl: 'http://127.0.0.1'
                }
            } as unknown as GenericModelProvider;
            const handler = new AnthropicHandler(providerInstance) as unknown as AnthropicHandlerTestAccess;
            const client = await handler.createAnthropicClient({
                id: 'claude-sonnet-4-5',
                name: 'Claude',
                tooltip: 'Claude',
                maxInputTokens: 1024,
                maxOutputTokens: 128,
                capabilities: {
                    toolCalling: false,
                    imageInput: false
                },
                sdkMode: 'anthropic',
                provider: 'compatible-test',
                baseUrl: 'http://127.0.0.1',
                customHeader: {
                    'User-Agent': 'claude-cli/2.1.258 (external, cli)'
                },
                proxy: 'noproxy'
            });

            await client.messages.create({
                model: 'claude-sonnet-4-5',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }]
            });

            assert.equal(requestHeaders?.get('user-agent'), 'claude-cli/2.1.258 (external, cli)');
            assert.ok(requestHeaders?.get('x-stainless-lang'));
            assert.ok(requestHeaders?.get('x-stainless-package-version'));
            assert.ok(requestHeaders?.get('x-stainless-os'));
            assert.ok(requestHeaders?.get('x-stainless-arch'));
            assert.ok(requestHeaders?.get('x-stainless-runtime'));
            assert.ok(requestHeaders?.get('x-stainless-runtime-version'));
        } finally {
            ConfigManager.createProxyAwareFetch = originalCreateProxyAwareFetch;
            ApiKeyManager.getApiKey = originalGetApiKey;
        }
    });

    test('两个 SDK 的内置 header 可由 null 删除', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalCreateProxyAwareFetch = ConfigManager.createProxyAwareFetch;
        let anthropicHeaders: Headers | undefined;
        let openaiHeaders: Headers | undefined;
        ApiKeyManager.getApiKey = async () => 'test-api-key';
        ConfigManager.createProxyAwareFetch = (() => {
            return async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                if (request.url.includes('/messages')) {
                    anthropicHeaders = request.headers;
                    return new Response(
                        JSON.stringify({
                            id: 'msg_test',
                            type: 'message',
                            role: 'assistant',
                            model: 'claude-sonnet-4-5',
                            content: [{ type: 'text', text: 'ok' }],
                            stop_reason: 'end_turn',
                            stop_sequence: null,
                            usage: { input_tokens: 1, output_tokens: 1 }
                        }),
                        { status: 200, headers: { 'content-type': 'application/json' } }
                    );
                }

                openaiHeaders = request.headers;
                return new Response(
                    [
                        `data: ${JSON.stringify({
                            id: 'chatcmpl_test',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'test-model',
                            choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }]
                        })}`,
                        '',
                        `data: ${JSON.stringify({
                            id: 'chatcmpl_test',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'test-model',
                            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                        })}`,
                        '',
                        'data: [DONE]',
                        '',
                        ''
                    ].join('\n'),
                    { status: 200, headers: { 'content-type': 'text/event-stream' } }
                );
            };
        }) as typeof ConfigManager.createProxyAwareFetch;

        try {
            const providerInstance = {
                provider: 'compatible-test',
                providerConfig: {
                    displayName: 'Compatible Test',
                    baseUrl: 'http://127.0.0.1'
                }
            } as unknown as GenericModelProvider;

            const anthropicHandler = new AnthropicHandler(providerInstance) as unknown as AnthropicHandlerTestAccess;
            const anthropicModel = {
                id: 'claude-sonnet-4-5',
                name: 'Claude',
                tooltip: 'Claude',
                maxInputTokens: 1024,
                maxOutputTokens: 128,
                capabilities: {
                    toolCalling: false,
                    imageInput: false
                },
                sdkMode: 'anthropic',
                provider: 'compatible-test',
                baseUrl: 'http://127.0.0.1',
                customHeader: {
                    'User-Agent': null,
                    'X-Stainless-Package-Version': null,
                    'anthropic-version': null,
                    'Content-Type': null
                },
                proxy: 'noproxy'
            } satisfies ModelConfig;
            const anthropicClient = await anthropicHandler.createAnthropicClient(anthropicModel);

            await anthropicClient.messages.create(
                {
                    model: 'claude-sonnet-4-5',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                },
                { headers: anthropicHandler.getModelRequestHeaderDeletions(anthropicModel) }
            );

            assert.equal(anthropicHeaders?.get('user-agent'), null);
            assert.equal(anthropicHeaders?.get('x-stainless-package-version'), null);
            assert.equal(anthropicHeaders?.get('anthropic-version'), null);

            const openaiHandler = new OpenAIHandler(providerInstance);
            const openaiModel = {
                id: 'test-model',
                name: 'OpenAI',
                tooltip: 'OpenAI',
                maxInputTokens: 1024,
                maxOutputTokens: 128,
                capabilities: {
                    toolCalling: false,
                    imageInput: false
                },
                sdkMode: 'openai',
                provider: 'compatible-test',
                baseUrl: 'http://127.0.0.1',
                customHeader: {
                    'User-Agent': null,
                    'X-Stainless-Package-Version': null,
                    'X-Session-ID': null,
                    Authorization: null,
                    'Content-Type': null
                },
                proxy: 'noproxy'
            } satisfies ModelConfig;
            const openaiClient = await openaiHandler.createOpenAIClient(openaiModel, 'session-1');

            const completion = await openaiClient.chat.completions.create(
                {
                    model: 'test-model',
                    messages: [{ role: 'user', content: 'hi' }],
                    stream: true
                },
                { headers: openaiHandler.getModelRequestHeaderDeletions(openaiModel) }
            );
            for await (const _chunk of completion) {
                assert.ok(_chunk);
            }

            assert.equal(openaiHeaders?.get('user-agent'), null);
            assert.equal(openaiHeaders?.get('x-stainless-package-version'), null);
            assert.equal(openaiHeaders?.get('x-session-id'), null);
            assert.equal(openaiHeaders?.get('authorization'), null);
            assert.equal(openaiHeaders?.get('content-type'), 'application/json');
            assert.equal(anthropicHeaders?.get('content-type'), 'application/json');
        } finally {
            ConfigManager.createProxyAwareFetch = originalCreateProxyAwareFetch;
            ApiKeyManager.getApiKey = originalGetApiKey;
        }
    });

    test('Retry-After 等待可在取消后及时结束', async () => {
        const retryManager = new RetryManager({
            enabled: true,
            maxAttempts: 3,
            initialDelayMs: 25,
            maxDelayMs: 100
        });
        let cancelled = false;
        let attempts = 0;
        let scheduledDelayMs: number | undefined;
        const retryError = Object.assign(new Error('rate limited'), {
            status: 429,
            headers: new Headers({ 'retry-after': '2' })
        });
        const cancellationTimer = setTimeout(() => {
            cancelled = true;
        }, 50);
        const startedAt = Date.now();

        try {
            await assert.rejects(
                retryManager.executeWithRetry(
                    async () => {
                        attempts++;
                        throw retryError;
                    },
                    error => shouldRetryAnthropicRequest(error, false),
                    'Anthropic Test',
                    {
                        shouldCancel: () => cancelled,
                        getRetryDelayMs: getAnthropicRetryDelayMs,
                        onRetryScheduled: (_attempt, _maxAttempts, delayMs) => {
                            scheduledDelayMs = delayMs;
                        }
                    }
                ),
                error => error instanceof Error && error.name === 'Canceled'
            );
        } finally {
            clearTimeout(cancellationTimer);
        }

        assert.equal(attempts, 1);
        assert.equal(scheduledDelayMs, 100);
        assert.ok(Date.now() - startedAt < 1000);
    });
});
