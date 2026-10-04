import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { OpenAICustomHandler } from '../../src/handlers/openai/openaiCustomHandler';
import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { OpenAIResponsesHandler } from '../../src/handlers/openai/openaiResponsesHandler';
import { StreamReporter } from '../../src/handlers/streamReporter';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
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

    for (const sdkMode of ['openai-sse', 'openai-responses'] as const) {
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
                        sdkMode === 'openai-sse' ?
                            new OpenAICustomHandler(provider, openai)
                        :   new OpenAIResponsesHandler(provider, openai);
                    const source = trackedCancellation();
                    const originalGet = ApiKeyManager.getApiKeyForRequest;
                    const originalFetch = ConfigManager.createProxyAwareFetch;
                    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
                    const statuses: unknown[] = [];
                    const storageError = new Error('secret storage unavailable');
                    let reads = 0;
                    let requests = 0;
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
                        return successResponse(sdkMode === 'openai-sse' ? 'openai' : 'openai-responses');
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
                            source.token
                        ];
                        const result =
                            handler instanceof OpenAICustomHandler ?
                                handler.handleRequest(...args)
                            :   handler.handleResponsesRequest(...args);
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
