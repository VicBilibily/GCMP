import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { OpenAIError } from 'openai';
import * as vscode from 'vscode';

import { OpenAICustomHandler } from '../../src/handlers/openai/openaiCustomHandler';
import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { OpenAIResponsesHandler } from '../../src/handlers/openai/openaiResponsesHandler';
import { runStreamCleanup } from '../../src/handlers/openai/shared/streamCleanup';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { HarRecorder } from '../../src/utils/net/harRecorder';
import type { RequestDiagnosticEntry } from '../../src/utils/net/requestDiagnostics';
import { Logger } from '../../src/utils/runtime/logger';
import type { ModelConfig } from '../../src/types/sharedTypes';
import {
    RetryProvider,
    createContext,
    defaultRetry,
    slot,
    successResponse,
    trackedCancellation
} from './balance/retryFixture';

interface StreamTestAccess {
    processStream(
        model: { name: string },
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken,
        tokenPricing: undefined,
        requestStartTime?: number,
        requestServiceTier?: string,
        wasThrottled?: boolean,
        responseToProbe?: Response
    ): Promise<void>;
}

suite('OpenAI custom SSE lifecycle', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
        for (const width of [1, 7, 4096]) {
            for (const media of ['text/event-stream', 'absent', 'text/plain']) {
                test(`SSE chunked event: ${JSON.stringify(eol)}, ${width}, ${media}`, async () => {
                    const parts: vscode.LanguageModelResponsePart2[] = [];
                    const source = new vscode.CancellationTokenSource();
                    const reporter = new StreamReporter({
                        modelName: 'test',
                        modelId: 'test',
                        provider: 'test',
                        sdkMode: 'openai',
                        progress: { report: part => parts.push(part) }
                    });
                    const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
                    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                    TokenUsagesManager.instance.updateActualTokens = () => {};
                    const bytes = new TextEncoder().encode(
                        [
                            '\uFEFF: heartbeat',
                            'data: invalid-json',
                            '',
                            'id: 1',
                            'event: message',
                            'data',
                            'data: {',
                            ': comment',
                            'retry: 1000',
                            'data: "choices":[{"index":0,"delta":{"content":"中文输出"},"finish_reason":"stop"}]',
                            'data: }',
                            '',
                            ''
                        ].join(eol)
                    );
                    let offset = 0;
                    const body = new ReadableStream<Uint8Array>(
                        {
                            pull(controller) {
                                if (offset < bytes.length) {
                                    controller.enqueue(bytes.subarray(offset, offset + width));
                                    offset += width;
                                } else {
                                    assert.deepEqual(
                                        parts
                                            .filter(part => part instanceof vscode.LanguageModelTextPart)
                                            .map(part => part.value),
                                        ['中文输出']
                                    );
                                    controller.close();
                                }
                            }
                        },
                        { highWaterMark: 0 }
                    );
                    try {
                        await handler.processStream(
                            { name: 'test' },
                            body,
                            reporter,
                            '',
                            source.token,
                            undefined,
                            undefined,
                            undefined,
                            false,
                            media === 'text/event-stream' ? undefined : (
                                new Response(body, { headers: media === 'absent' ? {} : { 'content-type': media } })
                            )
                        );
                        assert.equal(body.locked, false);
                    } finally {
                        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                        source.dispose();
                        reporter.finishMetrics();
                    }
                });
            }
        }
        for (const ending of ['dispatch', 'eof']) {
            test(`SSE waits for the event boundary: ${JSON.stringify(eol)}, ${ending}`, async () => {
                const parts: vscode.LanguageModelResponsePart2[] = [];
                const source = new vscode.CancellationTokenSource();
                const reporter = new StreamReporter({
                    modelName: 'test',
                    modelId: 'test',
                    provider: 'test',
                    sdkMode: 'openai',
                    progress: { report: part => parts.push(part) }
                });
                const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
                const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                TokenUsagesManager.instance.updateActualTokens = () => {};
                let reads = 0;
                const body = new ReadableStream<Uint8Array>(
                    {
                        pull(controller) {
                            if (reads++ === 0) {
                                controller.enqueue(
                                    new TextEncoder().encode(
                                        'data: {"choices":[{"index":0,"delta":{"content":"complete"},"finish_reason":"stop"}]}' +
                                            eol
                                    )
                                );
                            } else {
                                assert.equal(parts.length, 0);
                                if (ending === 'dispatch') {
                                    controller.enqueue(new TextEncoder().encode(eol));
                                }
                                controller.close();
                            }
                        }
                    },
                    { highWaterMark: 0 }
                );
                try {
                    const result = handler.processStream({ name: 'test' }, body, reporter, '', source.token, undefined);
                    if (ending === 'dispatch') {
                        await result;
                    } else {
                        await assert.rejects(result, /without sending any choices/);
                    }
                    assert.deepEqual(
                        parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value),
                        ending === 'dispatch' ? ['complete'] : []
                    );
                    assert.equal(body.locked, false);
                } finally {
                    TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                    source.dispose();
                    reporter.finishMetrics();
                }
            });
        }
    }

    for (const ending of [
        'done-only',
        'usage-only',
        'pending-tool-done',
        'unfinished-finish-event',
        'unfinished-second-choice',
        'finished-no-done',
        'finished-with-done',
        'finished-then-usage',
        'finished-then-empty-delta',
        'finished-multiple-choices',
        'length',
        'content_filter',
        'malformed-only'
    ]) {
        test(`SSE completion validation: ${ending}`, async () => {
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const source = new vscode.CancellationTokenSource();
            const reporter = new StreamReporter({
                modelName: 'test',
                modelId: 'test',
                provider: 'test',
                sdkMode: 'openai',
                progress: { report: part => parts.push(part) }
            });
            const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            const updates: Parameters<typeof originalUpdate>[0][] = [];
            TokenUsagesManager.instance.updateActualTokens = update => {
                updates.push(update);
            };
            const encode = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
            const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
            const complete = ending.startsWith('finished-') || ending === 'length' || ending === 'content_filter';
            const indices = ending === 'finished-multiple-choices' ? [0, 1] : [0];
            const choices = indices.map(index => ({
                index,
                delta: {
                    role: 'assistant',
                    tool_calls: [
                        {
                            index: 0,
                            id: `call-${index}`,
                            type: 'function',
                            function: { name: 'read_file', arguments: JSON.stringify({ index }) }
                        }
                    ]
                },
                finish_reason: null
            }));
            let text = encode({ choices });
            if (ending === 'done-only') {
                text = 'data: [DONE]\n\n';
            } else if (ending === 'usage-only') {
                text = encode({ choices: [], usage });
            } else if (ending === 'malformed-only') {
                text = 'data: {invalid-json\n\n';
            } else if (ending === 'unfinished-second-choice') {
                text = encode({
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' },
                        { ...choices[0], index: 1 }
                    ]
                });
            } else if (complete || ending === 'unfinished-finish-event') {
                const finish = encode({
                    choices: indices.map(index => ({
                        index,
                        delta: {},
                        finish_reason: ending === 'length' || ending === 'content_filter' ? ending : 'tool_calls'
                    }))
                });
                text += ending === 'unfinished-finish-event' ? finish.slice(0, -1) : finish;
            }
            if (ending === 'finished-then-usage') {
                text += encode({ choices: [], usage });
            } else if (ending === 'finished-then-empty-delta') {
                text += encode({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
            }
            if (ending === 'pending-tool-done' || ending === 'finished-with-done' || ending === 'finished-then-usage') {
                text += 'data: [DONE]\n\n';
            }
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                }
            });
            try {
                const result = handler.processStream({ name: 'test' }, body, reporter, '', source.token, undefined);
                if (complete) {
                    await result;
                    assert.deepEqual(
                        updates.map(update => update.status),
                        ['completed']
                    );
                    if (ending === 'finished-then-usage') {
                        assert.deepEqual(updates[0].rawUsage, usage);
                    }
                } else {
                    await assert.rejects(result, /without sending any choices|missing finish_reason/);
                    reporter.flushAll(null);
                    assert.deepEqual(updates, []);
                }
                const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                assert.deepEqual(
                    tools.map(part => part.input),
                    complete && ending !== 'length' && ending !== 'content_filter' ?
                        indices.map(index => ({ index }))
                    :   []
                );
                assert.equal(body.locked, false);
            } finally {
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                source.dispose();
                reporter.finishMetrics();
            }
        });
    }

    for (const sdkMode of ['openai-sse', 'openai', 'openai-responses'] as const) {
        for (const cancelAt of ['none', 'before', 'during']) {
            test(`provider key read cancellation: ${sdkMode}, ${cancelAt}`, async () => {
                const context = createContext();
                ApiKeyManager.initialize(context);
                ConfigSetStore.initialize(context);
                await ConfigSetStore.setSwitchMode(slot, 'off');
                const source = trackedCancellation();
                const storageError = new Error('secret storage unavailable');
                let reads = 0;
                context.secrets.get = async () => {
                    reads++;
                    await Promise.resolve();
                    if (cancelAt === 'during') {
                        source.cancel();
                    }
                    throw storageError;
                };
                const originalFetch = ConfigManager.createProxyAwareFetch;
                let requests = 0;
                ConfigManager.createProxyAwareFetch = () => async () => {
                    requests++;
                    throw new Error('unexpected network dispatch');
                };
                if (cancelAt === 'before') {
                    source.cancel();
                }
                const observed = { grants: 0 };
                try {
                    await assert.rejects(RetryProvider.run(sdkMode, defaultRetry, observed, source.token), error => {
                        if (cancelAt === 'none') {
                            assert.equal(error, storageError);
                        } else {
                            assert.ok(error instanceof vscode.CancellationError);
                        }
                        return true;
                    });
                    assert.equal(reads, cancelAt === 'before' ? 0 : 1);
                    assert.equal(requests, 0);
                    assert.equal(observed.grants, 1);
                    assert.equal(source.subscriptions, source.disposals);
                } finally {
                    ConfigManager.createProxyAwareFetch = originalFetch;
                    source.dispose();
                    for (const disposable of context.subscriptions) {
                        disposable.dispose();
                    }
                }
            });
        }
    }

    for (const sdkMode of ['openai-sse', 'openai-responses', 'openai'] as const) {
        for (const cancelAt of ['none', 'before', 'during']) {
            for (const outcome of ['resolve', 'reject']) {
                test(`handler initialization cancellation: ${sdkMode}, ${cancelAt}, ${outcome}`, async () => {
                    const config: ModelConfig = {
                        id: 'test-model',
                        name: 'Test Model',
                        tooltip: 'Test Model',
                        sdkMode,
                        baseUrl: 'https://initialization.test/v1',
                        maxInputTokens: 1024,
                        maxOutputTokens: 1024,
                        capabilities: { toolCalling: true, imageInput: false }
                    };
                    const provider = {
                        provider: 'test-provider',
                        providerConfig: { displayName: 'Test Provider', baseUrl: config.baseUrl }
                    } as unknown as GenericModelProvider;
                    const openai = new OpenAIHandler(provider);
                    const handler =
                        sdkMode === 'openai-sse' ? new OpenAICustomHandler(provider, openai)
                        : sdkMode === 'openai-responses' ? new OpenAIResponsesHandler(provider, openai)
                        : openai;
                    const source = trackedCancellation();
                    const originalGet = ApiKeyManager.getApiKeyForRequest;
                    const originalFetch = ConfigManager.createProxyAwareFetch;
                    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                    const statuses: unknown[] = [];
                    const storageError = new Error('secret storage unavailable');
                    let reads = 0;
                    let requests = 0;
                    let dispatched = 0;
                    ApiKeyManager.getApiKeyForRequest = async () => {
                        reads++;
                        await Promise.resolve();
                        if (cancelAt === 'during') {
                            source.cancel();
                        }
                        if (outcome === 'reject') {
                            throw storageError;
                        }
                        return 'test-key';
                    };
                    ConfigManager.createProxyAwareFetch = () => async () => {
                        requests++;
                        return successResponse(sdkMode === 'openai-responses' ? 'openai-responses' : 'openai');
                    };
                    TokenUsagesManager.instance.updateActualTokens = update => {
                        statuses.push(update.status);
                    };
                    if (cancelAt === 'before') {
                        source.cancel();
                    }
                    try {
                        const args: Parameters<OpenAICustomHandler['handleRequest']> = [
                            { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                            config,
                            [vscode.LanguageModelChatMessage.User('test')],
                            {} as vscode.ProvideLanguageModelChatResponseOptions,
                            { report() {} },
                            'initialization-test',
                            'test-session',
                            source.token,
                            undefined,
                            () => {
                                dispatched++;
                            }
                        ];
                        const result =
                            handler instanceof OpenAIResponsesHandler ?
                                handler.handleResponsesRequest(...args)
                            :   handler.handleRequest(...args);
                        if (cancelAt !== 'none') {
                            await assert.rejects(result, vscode.CancellationError);
                            assert.deepEqual(statuses, ['cancelled']);
                        } else if (outcome === 'reject') {
                            await assert.rejects(result, error => error === storageError);
                            assert.deepEqual(statuses, []);
                        } else {
                            await result;
                            assert.ok(statuses.includes('completed'));
                        }
                        assert.equal(reads, cancelAt === 'before' ? 0 : 1);
                        assert.equal(requests, cancelAt === 'none' && outcome === 'resolve' ? 1 : 0);
                        assert.equal(dispatched, requests);
                        assert.equal(source.subscriptions, source.disposals);
                    } finally {
                        ApiKeyManager.getApiKeyForRequest = originalGet;
                        ConfigManager.createProxyAwareFetch = originalFetch;
                        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                        source.dispose();
                    }
                });
            }
        }
    }

    for (const media of ['absent', 'text/plain', 'text/event-stream']) {
        for (const prefix of ['split-data', 'comment', 'bom', 'fields', 'limit']) {
            for (const width of [1, 7, 4096]) {
                test(`bounded response prefix stays streaming: ${media}, ${prefix}, ${width}`, async () => {
                    const parts: vscode.LanguageModelResponsePart2[] = [];
                    const source = new vscode.CancellationTokenSource();
                    const reporter = new StreamReporter({
                        modelName: 'test',
                        modelId: 'test',
                        provider: 'test',
                        sdkMode: 'openai',
                        progress: { report: part => parts.push(part) }
                    });
                    const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
                    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                    TokenUsagesManager.instance.updateActualTokens = () => {};
                    const leading =
                        prefix === 'comment' ? ': heartbeat\n\n'
                        : prefix === 'bom' ? '\uFEFF \r\n'
                        : prefix === 'fields' ? 'id: event-1\nevent: message\nretry: 1000\n'
                        : prefix === 'limit' ? ' '.repeat(512) + '\n{}\n'
                        : '';
                    const bytes = new TextEncoder().encode(
                        leading +
                            'data: {"choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n'
                    );
                    let offset = 0;
                    const body = new ReadableStream<Uint8Array>(
                        {
                            pull(controller) {
                                if (offset < bytes.length) {
                                    controller.enqueue(bytes.subarray(offset, offset + width));
                                    offset += width;
                                } else {
                                    assert.ok(
                                        parts.some(
                                            part =>
                                                part instanceof vscode.LanguageModelTextPart &&
                                                part.value === 'recovered'
                                        )
                                    );
                                    controller.close();
                                }
                            }
                        },
                        { highWaterMark: 0 }
                    );
                    const response = new Response(body, {
                        headers: media === 'absent' ? {} : { 'content-type': media }
                    });
                    try {
                        await handler.processStream(
                            { name: 'test' },
                            body,
                            reporter,
                            '',
                            source.token,
                            undefined,
                            undefined,
                            undefined,
                            false,
                            media === 'text/event-stream' ? undefined : response
                        );
                        assert.equal(body.locked, false);
                        assert.deepEqual(
                            parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value),
                            ['recovered']
                        );
                    } finally {
                        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                        source.dispose();
                        reporter.finishMetrics();
                    }
                });
            }
        }
    }

    for (const ending of ['cancel-eof', 'cancel-chunk', 'error-frame', 'reader-error', 'success']) {
        test(`工具缓存完成与异常处理：${ending}`, async () => {
            const calls: vscode.LanguageModelToolCallPart[] = [];
            const source = new vscode.CancellationTokenSource();
            const reporter = new StreamReporter({
                modelName: 'test',
                modelId: 'test',
                provider: 'test',
                sdkMode: 'openai',
                progress: {
                    report(part) {
                        if (part instanceof vscode.LanguageModelToolCallPart) {
                            calls.push(part);
                        }
                    }
                }
            });
            const handler = Object.create(OpenAICustomHandler.prototype) as StreamTestAccess;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            TokenUsagesManager.instance.updateActualTokens = () => {};
            const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
            let readCount = 0;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull(controller) {
                        if (readCount++ === 0) {
                            controller.enqueue(
                                encode({
                                    choices: [
                                        {
                                            index: 0,
                                            delta: {
                                                tool_calls: [
                                                    {
                                                        index: 0,
                                                        id: 'c',
                                                        function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                })
                            );
                            return;
                        }
                        assert.equal(calls.length, 0);
                        if (ending.startsWith('cancel-')) {
                            source.cancel();
                        }
                        if (ending === 'reader-error') {
                            controller.error(new Error('reader failed'));
                            return;
                        }
                        if (ending === 'error-frame') {
                            controller.enqueue(encode({ error: { message: 'upstream failed' } }));
                        } else if (ending === 'success' || ending === 'cancel-chunk') {
                            controller.enqueue(new TextEncoder().encode('data: invalid-json\n\n'));
                            controller.enqueue(
                                encode({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
                            );
                        }
                        controller.close();
                    }
                },
                { highWaterMark: 0 }
            );
            try {
                const result = handler.processStream({ name: 'test' }, body, reporter, 'test', source.token, undefined);
                if (ending === 'success') {
                    await result;
                    assert.deepEqual(
                        calls.map(call => call.input),
                        [{ path: 'a.ts' }]
                    );
                } else {
                    await assert.rejects(result, (error: unknown) => {
                        assert.ok(error instanceof Error);
                        if (ending.startsWith('cancel-')) {
                            assert.ok(error instanceof vscode.CancellationError);
                        } else {
                            assert.equal(error.message, ending === 'error-frame' ? 'upstream failed' : 'reader failed');
                        }
                        return true;
                    });
                    reporter.flushAll(null);
                    assert.deepEqual(calls, []);
                }
                assert.equal(body.locked, false);
            } finally {
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                source.dispose();
                reporter.finishMetrics();
            }
        });
    }

    test('模型请求中的 null customHeader 不会移除必需 header', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let request: Request | undefined;
        const cancellationSource = new vscode.CancellationTokenSource();
        ApiKeyManager.getApiKey = async () => 'test-api-key';
        ConfigManager.fetchWithProxy = (async (input: RequestInfo | URL, init?: RequestInit) => {
            request = new Request(input, init);
            return new Response(
                [
                    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
                    '',
                    'data: [DONE]',
                    '',
                    ''
                ].join('\n'),
                { status: 200, headers: { 'content-type': 'text/event-stream' } }
            );
        }) as typeof ConfigManager.fetchWithProxy;

        try {
            const providerInstance = {
                provider: 'test-provider',
                providerConfig: {
                    displayName: 'Test Provider',
                    baseUrl: 'http://127.0.0.1'
                }
            } as unknown as GenericModelProvider;
            const openaiHandler = {
                buildChatCompletionParams: () => ({ model: 'test-model', messages: [], stream: true })
            } as unknown as ConstructorParameters<typeof OpenAICustomHandler>[1];
            const handler = new OpenAICustomHandler(providerInstance, openaiHandler);
            const modelConfig = {
                id: 'test-model',
                name: 'Test Model',
                customHeader: {
                    Authorization: null,
                    'Content-Type': null
                },
                baseUrl: 'http://127.0.0.1'
            } as unknown as Parameters<OpenAICustomHandler['handleRequest']>[1];

            await handler.handleRequest(
                { id: 'test-model', name: 'Test Model' } as vscode.LanguageModelChatInformation,
                modelConfig,
                [],
                {} as vscode.ProvideLanguageModelChatResponseOptions,
                { report() {} },
                'request-id',
                'session-id',
                cancellationSource.token
            );

            assert.equal(request?.headers.get('authorization'), null);
            assert.equal(request?.headers.get('content-type'), 'application/json');
        } finally {
            cancellationSource.dispose();
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            ApiKeyManager.getApiKey = originalGetApiKey;
        }
    });
});

suite('OpenAI transport recovery diagnostics', () => {
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalDebug = Logger.debug;
    const originalWarn = Logger.warn;
    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
    const originalFlush = StreamReporter.prototype.flushAll;
    const originalUsage = StreamReporter.prototype.reportUsage;
    const originalMetrics = StreamReporter.prototype.finishMetrics;
    let context: vscode.ExtensionContext;

    setup(async () => {
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.setSwitchMode(slot, 'off');
        await ApiKeyManager.setApiKey(slot, 'transport-test-key');
        TokenUsagesManager.instance.updateActualTokens = () => {};
    });

    teardown(() => {
        ConfigManager.createProxyAwareFetch = originalFetch;
        Logger.debug = originalDebug;
        Logger.warn = originalWarn;
        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
        StreamReporter.prototype.flushAll = originalFlush;
        StreamReporter.prototype.reportUsage = originalUsage;
        StreamReporter.prototype.finishMetrics = originalMetrics;
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
    });

    for (const preservePrimaryError of [false, true]) {
        for (const failLogging of [false, true]) {
            test(`cleanup preserves first failure and runs all steps: primary=${preservePrimaryError}, logger=${failLogging}`, () => {
                const firstError = new Error('first cleanup failure');
                const secondError = new Error('second cleanup failure');
                const steps: string[] = [];
                let warnings = 0;
                Logger.warn = () => {
                    warnings++;
                    if (failLogging) {
                        throw new Error('log backend failure');
                    }
                };
                const cleanup = () =>
                    runStreamCleanup(
                        [
                            () => {
                                steps.push('first');
                                throw firstError;
                            },
                            () => {
                                steps.push('second');
                                throw secondError;
                            },
                            () => {
                                steps.push('listener');
                            }
                        ],
                        preservePrimaryError
                    );
                if (preservePrimaryError) {
                    assert.doesNotThrow(cleanup);
                } else {
                    assert.throws(cleanup, error => error === firstError);
                }
                assert.deepEqual(steps, ['first', 'second', 'listener']);
                assert.equal(warnings, 2);
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-responses', 'openai-sse'] as const) {
        for (const ending of [
            'before-output',
            'after-text',
            'after-text-flush-error',
            'after-text-flush-logger-error',
            'after-text-usage-error',
            'after-text-metrics-error',
            'after-text-metrics-logger-error',
            'after-thinking',
            'after-tool',
            'host-cancel',
            'host-cancel-metrics-error',
            'host-cancel-metrics-logger-error',
            'completed',
            'completed-metrics-error',
            'completed-metrics-logger-error',
            'har-clone-failure',
            'invalid-json',
            'invalid-json-with-har',
            'invalid-json-without-content-type'
        ]) {
            const invalidJson = ending.startsWith('invalid-json');
            const missingContentType = ending === 'invalid-json-without-content-type';
            const cancelledRequest = ending.startsWith('host-cancel');
            const completedRequest = ending.startsWith('completed');
            const failureEnding = ending.replace('-logger-error', '-error');
            const failLogging = ending.endsWith('-logger-error');
            if ((invalidJson && sdkMode === 'openai-sse') || (missingContentType && sdkMode !== 'openai-responses')) {
                continue;
            }
            test(`real socket lifecycle: ${sdkMode}, ${ending}`, async () => {
                const cleanupError = new Error('injected cleanup failure');
                let failedWarnings = 0;
                if (failLogging) {
                    Logger.warn = (...args: Parameters<typeof originalWarn>) => {
                        if (args[0] === '[OpenAI] Stream cleanup failed') {
                            failedWarnings++;
                            throw Object.assign(new Error('injected log backend failure'), { code: 'EIO' });
                        }
                        originalWarn.apply(Logger, args);
                    };
                }
                const updates: Parameters<typeof originalUpdate>[0][] = [];
                TokenUsagesManager.instance.updateActualTokens = update => {
                    updates.push(update);
                };
                if (failureEnding === 'after-text-flush-error') {
                    StreamReporter.prototype.flushAll = function (...args) {
                        originalFlush.apply(this, args);
                        throw cleanupError;
                    };
                } else if (failureEnding === 'after-text-usage-error') {
                    StreamReporter.prototype.reportUsage = function (...args) {
                        originalUsage.apply(this, args);
                        throw cleanupError;
                    };
                } else if (failureEnding.endsWith('metrics-error')) {
                    StreamReporter.prototype.finishMetrics = function () {
                        originalMetrics.call(this);
                        throw cleanupError;
                    };
                }
                const cancellation = trackedCancellation();
                const dispatcher = new Agent({ connections: 1 });
                const recorder = new HarRecorder();
                const capturePath =
                    ending === 'har-clone-failure' || ending === 'invalid-json-with-har' ?
                        await mkdtemp(join(tmpdir(), 'gcmp-har-recovery-'))
                    :   undefined;
                if (capturePath) {
                    recorder.initialize({
                        enabled: true,
                        extensionVersion: 'test',
                        defaultStoragePath: capturePath,
                        retentionCount: 2
                    });
                }
                const entries: RequestDiagnosticEntry[] = [];
                const parts: vscode.LanguageModelResponsePart[] = [];
                const observed = { grants: 0 };
                const partial = ending.startsWith('after-');
                const success = await successResponse(
                    sdkMode === 'openai-responses' ? 'openai-responses' : 'openai'
                ).text();
                const delta =
                    ending === 'after-tool' ?
                        {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: 'call-test',
                                    type: 'function',
                                    function: { name: 'read_file', arguments: '{"path":"test.ts"}' }
                                }
                            ]
                        }
                    : ending === 'after-thinking' ? { reasoning_content: 'partial reasoning' }
                    : { content: 'partial text' };
                const responseItem = {
                    id: 'call-item',
                    type: 'function_call',
                    call_id: 'call-test',
                    name: 'read_file',
                    arguments: '{"path":"test.ts"}'
                };
                const events =
                    sdkMode === 'openai-responses' ?
                        [
                            {
                                type: 'response.created',
                                response: { id: 'partial-response', status: 'in_progress', output: [] }
                            },
                            ...(ending === 'after-tool' ?
                                [
                                    {
                                        type: 'response.output_item.added',
                                        output_index: 0,
                                        item: { ...responseItem, arguments: '' }
                                    },
                                    {
                                        type: 'response.function_call_arguments.done',
                                        item_id: 'call-item',
                                        output_index: 0,
                                        arguments: responseItem.arguments
                                    },
                                    { type: 'response.output_item.done', output_index: 0, item: responseItem }
                                ]
                            :   [
                                    {
                                        type:
                                            ending === 'after-thinking' ?
                                                'response.reasoning_summary_text.delta'
                                            :   'response.output_text.delta',
                                        item_id: 'message-test',
                                        output_index: 0,
                                        content_index: 0,
                                        summary_index: 0,
                                        delta: 'partial text'
                                    }
                                ])
                        ]
                    :   [
                            {
                                id: 'chat-partial',
                                object: 'chat.completion.chunk',
                                created: 0,
                                model: 'retry-model',
                                choices: [
                                    {
                                        index: 0,
                                        delta: { role: 'assistant', ...delta },
                                        finish_reason: ending === 'after-tool' ? 'tool_calls' : null
                                    }
                                ]
                            }
                        ];
                const prefix =
                    invalidJson ? 'data: {not-json}\n\n'
                    : partial ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
                    : ': heartbeat\n\n';
                let requests = 0;
                let pendingResponse: ServerResponse | undefined;
                const server = createServer((request, response) => {
                    request.resume();
                    requests++;
                    response.writeHead(200, {
                        ...(missingContentType ? {} : { 'content-type': 'text/event-stream' }),
                        'x-request-id': `local-${requests}`
                    });
                    if (requests > 1 || completedRequest || ending === 'har-clone-failure') {
                        response.end(success);
                    } else {
                        pendingResponse = response;
                        response.write(prefix);
                    }
                });
                Logger.debug = (...args: Parameters<typeof originalDebug>) => {
                    if (args[0] !== '[Request lifecycle]') {
                        return;
                    }
                    const entry = args[1] as RequestDiagnosticEntry;
                    entries.push(entry);
                    const trigger = partial ? 'first_progress' : 'first_data';
                    if (
                        entry.attempt === 1 &&
                        entry.phase === trigger &&
                        !completedRequest &&
                        ending !== 'har-clone-failure' &&
                        !invalidJson
                    ) {
                        if (cancelledRequest) {
                            cancellation.cancel();
                        } else {
                            pendingResponse?.destroy();
                        }
                    }
                };
                server.listen(0, '127.0.0.1');
                await once(server, 'listening');
                const address = server.address();
                assert.ok(address && typeof address === 'object');
                const fetchImpl: typeof fetch = async (input, init) => {
                    const request = new Request(input, init);
                    const headers: Record<string, string> = {};
                    request.headers.forEach((value, key) => {
                        headers[key] = value;
                    });
                    const response = await undiciFetch(
                        `http://127.0.0.1:${address.port}${new URL(request.url).pathname}`,
                        {
                            method: request.method,
                            headers,
                            body: await request.text(),
                            signal: request.signal,
                            dispatcher
                        }
                    );
                    if (ending === 'har-clone-failure') {
                        Object.defineProperty(response, 'clone', {
                            value: () => {
                                throw new TypeError('injected_capture_clone_failure');
                            }
                        });
                    }
                    return response as unknown as Response;
                };
                ConfigManager.createProxyAwareFetch = () => recorder.wrapFetch(fetchImpl);
                try {
                    const result = RetryProvider.run(
                        sdkMode,
                        { ...defaultRetry, maxAttempts: 1 },
                        observed,
                        cancellation.token,
                        parts,
                        'socket-request'
                    );
                    if (partial) {
                        await assert.rejects(result, error => {
                            assert.ok(error instanceof Error);
                            assert.equal(error.message, 'terminated');
                            assert.ok(error.cause && typeof error.cause === 'object');
                            const transportError = sdkMode === 'openai' ? error.cause : error;
                            if (sdkMode === 'openai') {
                                assert.ok(error instanceof OpenAIError);
                            }
                            assert.ok(transportError instanceof TypeError);
                            assert.equal((transportError.cause as { code?: string }).code, 'UND_ERR_SOCKET');
                            return true;
                        });
                    } else if (cancelledRequest) {
                        await assert.rejects(result, vscode.CancellationError);
                    } else if (failureEnding === 'completed-metrics-error') {
                        await assert.rejects(result, error => error === cleanupError);
                    } else if (invalidJson) {
                        await assert.rejects(result, error => {
                            assert.ok(error instanceof Error);
                            assert.ok(error instanceof SyntaxError || error.cause instanceof SyntaxError);
                            return true;
                        });
                    } else {
                        await result;
                    }
                    const expected = ending === 'before-output' ? 2 : 1;
                    assert.equal(requests, expected);
                    assert.equal(observed.grants, expected);
                    assert.equal(cancellation.disposals, cancellation.subscriptions);
                    assert.equal(failedWarnings > 0, failLogging);
                    assert.equal(entries.filter(entry => entry.phase === 'started').length, expected);
                    const firstFailure = entries.find(entry => entry.phase === 'error');
                    const decision = entries.find(entry => entry.phase === 'retry_decision');
                    if (ending === 'completed' || ending === 'har-clone-failure') {
                        assert.equal(firstFailure, undefined);
                        assert.equal(decision, undefined);
                        assert.equal(entries.at(-1)?.outcome, 'completed');
                    } else if (cancelledRequest) {
                        assert.equal(decision?.reason, 'cancelled');
                        assert.equal(entries.at(-1)?.outcome, 'cancelled');
                        assert.ok(entries.some(entry => entry.source === 'host_token'));
                    } else if (failureEnding === 'completed-metrics-error') {
                        assert.equal(decision?.retry, false);
                        assert.equal(entries.at(-1)?.outcome, 'failed');
                    } else if (invalidJson) {
                        assert.ok(firstFailure?.errors?.some(error => error.name === 'SyntaxError'));
                        assert.equal(
                            firstFailure?.errors?.some(error => error.code === 'ERR_INVALID_STATE'),
                            false
                        );
                        assert.equal(decision?.retry, false);
                        assert.equal(decision?.reason, 'unclassified_error');
                        assert.equal(entries.at(-1)?.outcome, 'failed');
                        assert.equal(cancellation.token.isCancellationRequested, false);
                    } else {
                        assert.ok(firstFailure?.errors?.some(error => error.code === 'UND_ERR_SOCKET'));
                        assert.equal(firstFailure?.signalAborted, false);
                        assert.equal(decision?.retry, !partial);
                        assert.equal(decision?.reason, partial ? 'progress_reported' : 'retryable_error');
                        assert.equal(entries.at(-1)?.outcome, partial ? 'failed' : 'completed');
                        if (sdkMode === 'openai-sse') {
                            const cleanup = entries.find(entry => entry.source === 'finally_cleanup');
                            assert.ok(cleanup);
                            assert.equal(cleanup.firstErrorAt, firstFailure.firstErrorAt);
                            assert.deepEqual(cleanup.errors, firstFailure.errors);
                        }
                    }
                    if (partial) {
                        assert.ok(parts.length > 0);
                        assert.equal(updates.filter(update => update.status === 'failed').length, 1);
                    }
                } finally {
                    cancellation.cancel();
                    cancellation.dispose();
                    await dispatcher.destroy();
                    server.closeAllConnections();
                    await new Promise<void>(resolve => server.close(() => resolve()));
                    await recorder.dispose();
                    if (capturePath) {
                        await rm(capturePath, { recursive: true, force: true });
                    }
                }
            });
        }
    }
});
