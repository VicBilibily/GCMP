import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import OpenAI from 'openai';
import { Stream } from 'openai/core/streaming';
import * as vscode from 'vscode';

import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { OpenAIResponsesStreamProcessor } from '../../src/handlers/openai/openaiResponsesStreamProcessor';
import { StreamReporter } from '../../src/handlers/streamReporter';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { ConfigManager } from '../../src/utils/config/configManager';
import { HarRecorder, type HarRecorderOptions } from '../../src/utils/net/harRecorder';
import { RequestDiagnostics, type RequestDiagnosticEntry } from '../../src/utils/net/requestDiagnostics';
import { StatusLogger } from '../../src/utils/runtime/statusLogger';

interface PreprocessorAccess {
    preprocessSSEResponse(response: Response, diagnostics?: RequestDiagnostics): Promise<Response>;
    createCustomFetch(
        modelConfig: undefined,
        resolvedBaseURL: undefined,
        proxyUrl: undefined,
        diagnostics: RequestDiagnostics
    ): typeof fetch;
}

function createPreprocessor(): PreprocessorAccess {
    const provider = {
        provider: 'test',
        providerConfig: { displayName: 'Test', baseUrl: 'https://example.test/v1', apiKeyTemplate: 'test', models: [] }
    } as unknown as GenericModelProvider;
    return new OpenAIHandler(provider) as unknown as PreprocessorAccess;
}

function createResponse(body: ReadableStream<Uint8Array>, media: string): Response {
    const response = new Response(body, {
        headers: media === 'absent' ? {} : { 'content-type': media }
    });
    Object.defineProperty(response, 'url', { value: 'https://example.test/v1/responses' });
    return response;
}

const terminalFrame = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { id: 'terminal-test', object: 'response', status: 'completed', output: [] }
})}\n\n`;

function createChunkedBody(text: string, width: number): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new ReadableStream<Uint8Array>(
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
}

function multilineFrame(json: string, eol: string): string {
    return (
        json
            .split('\n')
            .map(line => `data:${line}`)
            .join(eol) +
        eol +
        eol
    );
}

interface CapturedHar {
    log: { entries: Array<{ response: { content: { text?: string }; _status?: string } }> };
}

suite('OpenAI SDK SSE preprocessing', () => {
    for (const media of ['text/event-stream', 'absent']) {
        for (const eol of ['\n', '\r\n', '\r']) {
            for (const width of [1, 7, 4096]) {
                test(`emits multiline UTF-8 before EOF: ${media}, ${JSON.stringify(eol)}, ${width}`, async () => {
                    const event = {
                        id: 'framing-test',
                        object: 'chat.completion.chunk',
                        created: 0,
                        model: 'test',
                        choices: [
                            {
                                index: 0,
                                delta: { role: 'assistant', content: 'split \u4e2d\u6587' },
                                finish_reason: null
                            }
                        ]
                    };
                    const lines = JSON.stringify(event, null, 2)
                        .split('\n')
                        .map(line => `data: ${line}`);
                    const bytes = new TextEncoder().encode(`${lines.join(eol)}${eol}${eol}: heartbeat${eol}${eol}`);
                    let upstream!: ReadableStreamDefaultController<Uint8Array>;
                    let offset = 0;
                    const body = new ReadableStream<Uint8Array>(
                        {
                            start(controller) {
                                upstream = controller;
                            },
                            pull(controller) {
                                if (offset < bytes.length) {
                                    controller.enqueue(bytes.subarray(offset, offset + width));
                                    offset += width;
                                }
                            }
                        },
                        { highWaterMark: 0 }
                    );
                    const processed = await createPreprocessor().preprocessSSEResponse(createResponse(body, media));
                    const iterator = Stream.fromSSEResponse<OpenAI.Chat.Completions.ChatCompletionChunk>(
                        processed,
                        new AbortController()
                    )[Symbol.asyncIterator]();
                    let first: IteratorResult<OpenAI.Chat.Completions.ChatCompletionChunk> | undefined;
                    let failure: unknown;
                    const pending = iterator.next().then(
                        value => {
                            first = value;
                        },
                        error => {
                            failure = error;
                        }
                    );
                    try {
                        await nextTurn();
                        const firstBeforeEof = first;
                        upstream.close();
                        await pending;
                        assert.equal(failure, undefined);
                        assert.ok(firstBeforeEof && !firstBeforeEof.done, 'complete SSE event must not wait for EOF');
                        assert.equal(firstBeforeEof.value.choices[0].delta.content, event.choices[0].delta.content);
                    } finally {
                        await iterator.return?.();
                    }
                });
            }
        }

        for (const eol of ['\n', '\r\n', '\r']) {
            for (const width of [1, 4096]) {
                for (const scenario of ['message', 'keepalive', 'rate-limits']) {
                    test(`normalizes multiline Chat events: ${media}, ${JSON.stringify(eol)}, ${width}, ${scenario}`, async () => {
                        const content = { role: 'assistant', content: 'multiline \u4e2d\u6587' };
                        const chunk = {
                            id: 'compatibility-test',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'test',
                            choices: [
                                {
                                    index: 0,
                                    ...(scenario === 'message' ? { message: content } : { delta: content }),
                                    finish_reason: 'stop'
                                }
                            ]
                        };
                        const noiseType = scenario === 'keepalive' ? 'keepalive' : 'codex.rate_limits';
                        const prefix =
                            scenario === 'message' ? '' : (
                                `event:${noiseType}${eol}` +
                                multilineFrame(JSON.stringify({ type: noiseType }, null, 2), eol)
                            );
                        const payload =
                            prefix + multilineFrame(JSON.stringify(chunk, null, 2), eol) + `data: [DONE]${eol}${eol}`;
                        const response = createResponse(createChunkedBody(payload, width), media);
                        const preprocessor = createPreprocessor();
                        const client = new OpenAI({
                            apiKey: 'test',
                            maxRetries: 0,
                            fetch: () => preprocessor.preprocessSSEResponse(response)
                        });
                        const completion = await client.chat.completions
                            .stream({ model: 'test', messages: [{ role: 'user', content: 'test' }] })
                            .finalChatCompletion();
                        assert.equal(completion.choices[0].message.content, content.content);
                    });
                }

                for (const scenario of ['delta', 'completed']) {
                    test(`normalizes multiline Responses events: ${media}, ${JSON.stringify(eol)}, ${width}, ${scenario}`, async () => {
                        const event =
                            scenario === 'delta' ?
                                {
                                    type: 'response.output_text.delta',
                                    item_id: 'item-test',
                                    output_index: 0,
                                    content_index: 0,
                                    delta: 'content',
                                    sequence_number: 1
                                }
                            :   {
                                    type: 'response.completed',
                                    response: { id: 'completed-test', object: 'response', status: 'completed' }
                                };
                        const dataLines = JSON.stringify(event, null, 2)
                            .split('\n')
                            .flatMap((line, index) =>
                                index === 1 ? [': between data fields', `data:${line}`] : [`data:${line}`]
                            );
                        const payload = `event:${event.type}${eol}` + dataLines.join(eol) + eol + eol;
                        const response = await createPreprocessor().preprocessSSEResponse(
                            createResponse(createChunkedBody(payload, width), media)
                        );
                        const events: OpenAI.Responses.ResponseStreamEvent[] = [];
                        for await (const parsed of Stream.fromSSEResponse<OpenAI.Responses.ResponseStreamEvent>(
                            response,
                            new AbortController()
                        )) {
                            events.push(parsed);
                        }
                        if (scenario === 'delta') {
                            assert.deepEqual(
                                events.map(parsed => parsed.type),
                                ['response.content_part.added', 'response.output_text.delta']
                            );
                            const delta = events[1];
                            assert.ok(delta.type === 'response.output_text.delta');
                            assert.equal(delta.delta, 'content');
                        } else {
                            assert.equal(events.length, 1);
                            const completed = events[0];
                            assert.ok(completed.type === 'response.completed');
                            assert.deepEqual(completed.response.output, []);
                        }
                    });
                }
            }

            test(`rejects malformed multiline JSON: ${media}, ${JSON.stringify(eol)}`, async () => {
                const payload = multilineFrame('{\ninvalid\n}', eol);
                const response = await createPreprocessor().preprocessSSEResponse(
                    createResponse(createChunkedBody(payload, 1), media)
                );
                await assert.rejects(async () => {
                    for await (const parsed of Stream.fromSSEResponse(response, new AbortController())) {
                        assert.fail(`unexpected event: ${JSON.stringify(parsed)}`);
                    }
                }, SyntaxError);
            });

            test(`does not finalize an incomplete event at EOF: ${media}, ${JSON.stringify(eol)}`, async () => {
                const payload = multilineFrame(
                    JSON.stringify(
                        { type: 'response.completed', response: { id: 'incomplete', object: 'response', output: [] } },
                        null,
                        2
                    ),
                    eol
                ).slice(0, -eol.length);
                const response = await createPreprocessor().preprocessSSEResponse(
                    createResponse(createChunkedBody(payload, 1), media)
                );
                let events = 0;
                for await (const parsed of Stream.fromSSEResponse(response, new AbortController())) {
                    assert.ok(parsed);
                    events++;
                }
                assert.equal(events, 0);
            });
        }

        for (const ending of [
            'completed',
            'late-protocol-error',
            'partial',
            'failed',
            'empty',
            'completion-callback-error',
            'tool-callback-error',
            'tool-final-callback-error',
            'tool-invalid-json'
        ]) {
            for (const captureHar of [false, true]) {
                test(`preserves event and failure order: ${media}, ${ending}, HAR=${captureHar}`, async () => {
                    const transportError = new TypeError('terminated', {
                        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
                    });
                    const callbackError = new Error('completion callback failed');
                    let toolCallbacks = 0;
                    const tool = {
                        type: 'function_call',
                        id: 'item-tool',
                        call_id: 'call-tool',
                        name: 'read_file',
                        arguments: ending === 'tool-invalid-json' ? '{invalid' : '{"path":"test"}'
                    };
                    let pulls = 0;
                    const firstFrame =
                        ending.startsWith('tool-') ?
                            (ending === 'tool-final-callback-error' ? '' : (
                                `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: tool })}\n\n`
                            )) +
                            `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'tool-response', output: [tool] } })}\n\n`
                        : ending === 'partial' ?
                            `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'item-test', output_index: 0, content_index: 0, delta: 'partial' })}\n\n`
                        : ending === 'failed' ?
                            `data: ${JSON.stringify({ type: 'response.failed', response: { id: 'failed-test', error: { message: 'original protocol failure', code: 'usage_limit_reached' } } })}\n\n`
                        :   terminalFrame +
                            (ending === 'late-protocol-error' ? '{"error":"late gateway error"}\n\n' : '');
                    const response = createResponse(
                        new ReadableStream<Uint8Array>(
                            {
                                pull(controller) {
                                    pulls++;
                                    if (pulls === 1 && ending !== 'empty') {
                                        controller.enqueue(new TextEncoder().encode(firstFrame));
                                    } else {
                                        controller.error(transportError);
                                    }
                                }
                            },
                            { highWaterMark: 0 }
                        ),
                        media
                    );
                    const cancellation = new vscode.CancellationTokenSource();
                    const abortController = new AbortController();
                    const entries: RequestDiagnosticEntry[] = [];
                    const parts: vscode.LanguageModelResponsePart2[] = [];
                    const trace = new RequestDiagnostics(
                        {
                            requestId: 'ordering-test',
                            sessionId: 'test',
                            provider: 'test',
                            modelId: 'test',
                            sdkMode: 'openai-responses'
                        },
                        entry => entries.push(entry),
                        () => ({ tokenCancelled: cancellation.token.isCancellationRequested })
                    );
                    const reporter = new StreamReporter({
                        modelName: 'Test',
                        modelId: 'test',
                        provider: 'test',
                        sdkMode: 'openai-responses',
                        progress: { report: part => parts.push(part) }
                    });
                    if (ending === 'completion-callback-error') {
                        reporter.flushAll = () => {
                            throw callbackError;
                        };
                    }
                    if (ending.startsWith('tool-')) {
                        reporter.reportToolCall = () => {
                            toolCallbacks++;
                            throw callbackError;
                        };
                    }
                    const processor = new OpenAIResponsesStreamProcessor({
                        modelName: 'Test',
                        displayName: 'Test',
                        token: cancellation.token,
                        abortController,
                        streamReporter: reporter,
                        sessionId: 'test'
                    });
                    const recorder = new HarRecorder();
                    const captureDirectory = mkdtempSync(join(tmpdir(), 'gcmp-sse-capture-'));
                    let failure: unknown;
                    try {
                        recorder.initialize({
                            enabled: captureHar,
                            extensionVersion: 'test',
                            defaultStoragePath: captureDirectory,
                            retentionCount: 2
                        });
                        const capturePath = recorder.getCurrentFilePath();
                        const preprocessor = createPreprocessor();
                        const originalFetch = ConfigManager.createProxyAwareFetch;
                        let customFetch: typeof fetch;
                        try {
                            ConfigManager.createProxyAwareFetch = () => recorder.wrapFetch(async () => response);
                            customFetch = preprocessor.createCustomFetch(undefined, undefined, undefined, trace);
                        } finally {
                            ConfigManager.createProxyAwareFetch = originalFetch;
                        }
                        const client = new OpenAI({ apiKey: 'test', maxRetries: 0, fetch: customFetch });
                        try {
                            const stream = await client.responses.create(
                                { model: 'test', input: 'test', stream: true },
                                { signal: abortController.signal }
                            );
                            processor.attach(trace);
                            await processor.consume(stream, trace);
                        } catch (error) {
                            failure = error;
                        }
                        if (ending === 'completed' || ending === 'late-protocol-error') {
                            assert.equal(failure, undefined);
                            assert.equal(processor.isResponseFinalized(), true);
                            assert.equal(pulls, 1);
                            assert.equal(
                                entries.some(entry => entry.phase === 'error'),
                                false
                            );
                        } else if (ending === 'completion-callback-error' || ending.endsWith('callback-error')) {
                            assert.equal(failure, callbackError);
                            if (ending.startsWith('tool-')) {
                                assert.equal(toolCallbacks, 1);
                            }
                        } else if (ending === 'tool-invalid-json') {
                            assert.equal(failure, undefined);
                            assert.equal(processor.isResponseFinalized(), true);
                            assert.equal(toolCallbacks, 0);
                        } else if (ending === 'failed') {
                            assert.ok(failure instanceof OpenAI.APIError);
                            assert.match(failure.message, /original protocol failure/);
                            assert.equal(failure.code, 'usage_limit_reached');
                        } else {
                            assert.ok(
                                failure === transportError ||
                                    (failure instanceof Error && failure.cause === transportError)
                            );
                            assert.equal(processor.isResponseFinalized(), false);
                            assert.ok(
                                entries.some(entry => entry.errors?.some(error => error.code === 'UND_ERR_SOCKET'))
                            );
                            if (ending === 'partial') {
                                reporter.flushAll(null);
                                assert.ok(
                                    parts.some(
                                        part =>
                                            part instanceof vscode.LanguageModelTextPart &&
                                            part.value.includes('partial')
                                    )
                                );
                            }
                        }
                        await recorder.dispose();
                        if (captureHar) {
                            assert.ok(capturePath);
                            const har = JSON.parse(readFileSync(capturePath, 'utf8')) as CapturedHar;
                            assert.equal(har.log.entries.length, 1);
                            assert.equal(
                                har.log.entries[0].response.content.text,
                                ending === 'empty' ? '' : firstFrame
                            );
                        }
                    } finally {
                        abortController.abort();
                        cancellation.dispose();
                        reporter.finishMetrics();
                        await response.body?.cancel().catch(() => undefined);
                        await recorder.dispose();
                        rmSync(captureDirectory, { recursive: true, force: true });
                    }
                });
            }
        }

        test(`cancelling preprocessing releases the source: ${media}`, async () => {
            let cancels = 0;
            const reason = new Error('consumer stopped');
            const response = createResponse(
                new ReadableStream<Uint8Array>(
                    {
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
                        },
                        cancel(receivedReason) {
                            assert.equal(receivedReason, reason);
                            cancels++;
                        }
                    },
                    { highWaterMark: 0 }
                ),
                media
            );
            const processed = await createPreprocessor().preprocessSSEResponse(response);
            const reader = processed.body!.getReader();
            try {
                await reader.read();
                await reader.cancel(reason);
                assert.equal(cancels, 1);
                assert.equal(response.body?.locked, false);
            } finally {
                reader.releaseLock();
                await response.body?.cancel(reason).catch(() => undefined);
            }
        });
    }

    for (const signalMode of ['request', 'override', 'null']) {
        test(`HAR request signal follows fetch overrides: ${signalMode}`, async () => {
            const captureDirectory = mkdtempSync(join(tmpdir(), 'gcmp-har-signal-'));
            const recorder = new HarRecorder();
            const requestController = new AbortController();
            const overrideController = new AbortController();
            try {
                recorder.initialize({
                    enabled: true,
                    extensionVersion: 'test',
                    defaultStoragePath: captureDirectory,
                    retentionCount: 2
                });
                const capturePath = recorder.getCurrentFilePath();
                assert.ok(capturePath);
                const request = new Request('https://example.test/responses', { signal: requestController.signal });
                const init =
                    signalMode === 'request' ? undefined : (
                        { signal: signalMode === 'null' ? null : overrideController.signal }
                    );
                const response = await recorder.wrapFetch(async () => new Response('still readable'))(request, init);
                requestController.abort();
                assert.equal(await response.text(), 'still readable');
                await recorder.dispose();
                const har = JSON.parse(readFileSync(capturePath, 'utf8')) as CapturedHar;
                assert.equal(har.log.entries.length, 1);
                assert.equal(
                    har.log.entries[0].response.content.text,
                    signalMode === 'request' ? '' : 'still readable'
                );
                assert.equal(har.log.entries[0].response._status, signalMode === 'request' ? 'aborted' : 'completed');
            } finally {
                await recorder.dispose();
                rmSync(captureDirectory, { recursive: true, force: true });
            }
        });
    }

    test('cancellation does not wait for an external tee branch before SDK abort cleanup', async () => {
        const response = createResponse(
            new ReadableStream<Uint8Array>(
                {
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
                    }
                },
                { highWaterMark: 0 }
            ),
            'text/event-stream'
        );
        const captureReader = response.clone().body!.getReader();
        const processed = await createPreprocessor().preprocessSSEResponse(response);
        const reader = processed.body!.getReader();
        let settled = false;
        try {
            await reader.read();
            const cancelling = reader.cancel().then(() => {
                settled = true;
            });
            await nextTurn();
            assert.equal(settled, true, 'SDK abort must not wait on the still-live capture branch');
            await cancelling;
        } finally {
            reader.releaseLock();
            await Promise.all([response.body!.cancel().catch(() => undefined), captureReader.cancel()]);
            captureReader.releaseLock();
        }
    });
});

suite('HAR flush scheduling', () => {
    let captureDirectory: string;
    let recorder: HarRecorder;
    let options: HarRecorderOptions;
    let fetchCaptured: typeof fetch;
    let writes: string[];
    let messages: string[];
    let failWrite: boolean;
    let failedPath: string | undefined;
    let failedWritesRemaining: number;
    let partialWrite: boolean;
    let failReplace: boolean;

    setup(() => {
        mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date(2026, 9, 17, 12).getTime() });
        captureDirectory = mkdtempSync(join(tmpdir(), 'gcmp-har-flush-'));
        recorder = new HarRecorder();
        writes = [];
        messages = [];
        failWrite = false;
        failedPath = undefined;
        failedWritesRemaining = 0;
        partialWrite = false;
        failReplace = false;
        mock.method(StatusLogger, 'info', (message: string) => {
            messages.push(message);
        });
        const writeFileSync = fs.writeFileSync;
        mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
            const filePath = String(args[0]);
            const targetPath = filePath.replace(/\.tmp$/, '');
            if (filePath.startsWith(captureDirectory) && targetPath.endsWith('.har')) {
                writes.push(targetPath);
                const options = args[2];
                assert.ok(options && typeof options === 'object');
                assert.equal(options.flush, true);
                if (partialWrite) {
                    writeFileSync(args[0], String(args[1]).slice(0, 32), args[2]);
                    throw Object.assign(new Error('injected partial HAR write failure'), { code: 'ENOSPC' });
                }
                if ((failWrite && (!failedPath || targetPath === failedPath)) || failedWritesRemaining > 0) {
                    if (failedWritesRemaining > 0) {
                        failedWritesRemaining--;
                    }
                    throw new Error('injected HAR write failure');
                }
            }
            const result = writeFileSync(...args);
            if (filePath.startsWith(captureDirectory) && targetPath.endsWith('.har')) {
                fs.utimesSync(filePath, new Date(), new Date());
            }
            return result;
        });
        const renameSync = fs.renameSync;
        mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
            if (failReplace && String(args[1]).startsWith(captureDirectory)) {
                throw Object.assign(new Error('injected HAR replacement failure'), { code: 'EPERM' });
            }
            return renameSync(...args);
        });
        options = {
            enabled: true,
            extensionVersion: 'test',
            defaultStoragePath: captureDirectory,
            retentionCount: 3
        };
        recorder.initialize(options);
        fetchCaptured = recorder.wrapFetch(async () => new Response('captured body'));
    });

    teardown(async () => {
        try {
            failWrite = false;
            failedWritesRemaining = 0;
            partialWrite = false;
            failReplace = false;
            await recorder.dispose();
        } finally {
            mock.restoreAll();
            mock.timers.reset();
            rmSync(captureDirectory, { recursive: true, force: true });
        }
    });

    async function recordRequests(count: number): Promise<void> {
        for (let index = 0; index < count; index++) {
            const response = await fetchCaptured('https://example.test/har-flush');
            assert.equal(await response.text(), 'captured body');
        }
        await nextTurn();
    }

    function readHar(filePath: string): CapturedHar {
        return JSON.parse(readFileSync(filePath, 'utf8')) as CapturedHar;
    }

    for (const failure of ['partial-write', 'replace']) {
        for (const recovery of ['interval', 'dispose']) {
            test(`preserves durable HAR after ${failure} and recovers on ${recovery}`, async () => {
                const filePath = recorder.getCurrentFilePath();
                assert.ok(filePath);
                await recordRequests(1);
                mock.timers.tick(15_000);
                const saved = readFileSync(filePath, 'utf8');
                assert.equal(readHar(filePath).log.entries.length, 1);
                await recordRequests(1);
                partialWrite = failure === 'partial-write';
                failReplace = failure === 'replace';
                mock.timers.tick(15_000);
                assert.equal(readFileSync(filePath, 'utf8'), saved);
                assert.equal(existsSync(`${filePath}.tmp`), false);
                const failedAttempts = writes.length;
                mock.timers.tick(14_999);
                assert.equal(writes.length, failedAttempts);
                if (recovery === 'dispose') {
                    await assert.rejects(recorder.dispose(), error => {
                        assert.ok(error instanceof AggregateError);
                        assert.equal(
                            (error.errors[0] as NodeJS.ErrnoException).code,
                            failure === 'partial-write' ? 'ENOSPC' : 'EPERM'
                        );
                        return true;
                    });
                    assert.equal(readFileSync(filePath, 'utf8'), saved);
                    assert.equal(existsSync(`${filePath}.tmp`), false);
                }
                partialWrite = false;
                failReplace = false;
                if (recovery === 'dispose') {
                    await recorder.dispose();
                } else {
                    mock.timers.tick(1);
                }
                assert.equal(readHar(filePath).log.entries.length, 2);
                assert.equal(existsSync(`${filePath}.tmp`), false);
            });
        }
    }

    test('batches requests until 15 seconds and skips unchanged intervals', async () => {
        const filePath = recorder.getCurrentFilePath();
        assert.ok(filePath);
        await recordRequests(25);
        assert.equal(writes.length, 0);
        mock.timers.tick(14_999);
        assert.equal(writes.length, 0);
        assert.equal(existsSync(filePath), false);
        mock.timers.tick(1);
        assert.equal(writes.length, 1);
        assert.equal(readHar(filePath).log.entries.length, 25);
        mock.timers.tick(15_000);
        assert.equal(writes.length, 1);
        await recordRequests(1);
        assert.equal(writes.length, 1);
        mock.timers.tick(14_999);
        assert.equal(writes.length, 1);
        mock.timers.tick(1);
        assert.equal(writes.length, 2);
        assert.equal(readHar(filePath).log.entries.length, 26);
    });

    test('retries failed writes at the next 15-second interval', async () => {
        const filePath = recorder.getCurrentFilePath();
        assert.ok(filePath);
        await recordRequests(1);
        failWrite = true;
        mock.timers.tick(15_000);
        assert.equal(writes.length, 1);
        assert.equal(existsSync(filePath), false);
        failWrite = false;
        mock.timers.tick(14_999);
        assert.equal(writes.length, 1);
        mock.timers.tick(1);
        assert.equal(writes.length, 2);
        assert.equal(readHar(filePath).log.entries.length, 1);
        mock.timers.tick(15_000);
        assert.equal(writes.length, 2);
    });

    for (const ending of ['dispose', 'disable']) {
        test(`flushes completed and pending captures on ${ending} before the interval`, async () => {
            const filePath = recorder.getCurrentFilePath();
            assert.ok(filePath);
            await recordRequests(2);
            const pending = await fetchCaptured('https://example.test/har-pending');
            assert.equal(writes.length, 0);
            if (ending === 'dispose') {
                await recorder.dispose();
            } else {
                recorder.initialize({
                    enabled: false,
                    extensionVersion: 'test',
                    defaultStoragePath: captureDirectory,
                    retentionCount: 3
                });
                await nextTurn();
            }
            const entries = readHar(filePath).log.entries;
            assert.equal(entries.length, 3);
            assert.equal(entries[2].response._status, 'aborted');
            assert.equal(await pending.text(), 'captured body');
            const finalWrites = writes.length;
            mock.timers.tick(30_000);
            assert.equal(writes.length, finalWrites);
        });
    }

    test('preserves all entries when the file rotates before the interval', async () => {
        const firstPath = recorder.getCurrentFilePath();
        assert.ok(firstPath);
        await recordRequests(49);
        assert.equal(writes.length, 0);
        await recordRequests(1);
        assert.equal(writes.length, 1);
        assert.equal(readHar(firstPath).log.entries.length, 50);
        const nextPath = recorder.getCurrentFilePath();
        assert.ok(nextPath);
        assert.notEqual(nextPath, firstPath);
        await recordRequests(1);
        assert.equal(writes.length, 1);
        assert.equal(existsSync(nextPath), false);
        mock.timers.tick(15_000);
        assert.equal(writes.length, 2);
        assert.equal(readHar(nextPath).log.entries.length, 1);
    });

    for (const rotation of ['request-limit', 'age', 'day']) {
        test(`failed ${rotation} rotation retains data and waits for the next retry interval`, async () => {
            if (rotation === 'day') {
                recorder.initialize({ ...options, enabled: false });
                mock.timers.setTime(new Date(2026, 9, 17, 23, 59, 30).getTime());
                recorder.initialize(options);
            }
            const firstPath = recorder.getCurrentFilePath();
            assert.ok(firstPath);
            if (rotation === 'request-limit') {
                await recordRequests(49);
            } else {
                await recordRequests(2);
                mock.timers.tick(15_000);
                await recordRequests(3);
            }
            failWrite = true;
            if (rotation === 'request-limit') {
                await recordRequests(1);
            } else if (rotation === 'age') {
                mock.timers.tick(30 * 60 * 1000);
            } else {
                mock.timers.setTime(Date.now() + 30_000);
                await recordRequests(1);
            }
            const failedAttempts = writes.length;
            assert.equal(recorder.getCurrentFilePath(), firstPath);
            await recordRequests(2);
            assert.equal(writes.length, failedAttempts);
            failWrite = false;
            mock.timers.tick(14_999);
            assert.equal(writes.length, failedAttempts);
            mock.timers.tick(1);
            assert.equal(writes.length, failedAttempts + 1);
            assert.notEqual(recorder.getCurrentFilePath(), firstPath);
            assert.equal(
                readHar(firstPath).log.entries.length,
                rotation === 'request-limit' ? 52
                : rotation === 'age' ? 7
                : 8
            );
        });
    }

    test('failed disable keeps pending data and retries without reporting successful writes', async () => {
        const filePath = recorder.getCurrentFilePath();
        assert.ok(filePath);
        await recordRequests(3);
        failWrite = true;
        recorder.initialize({ ...options, enabled: false });
        await nextTurn();
        assert.equal(recorder.isEnabled(), false);
        assert.equal(writes.length, 1);
        assert.equal(
            messages.some(message => message.includes('Recording stopped, wrote')),
            false
        );
        failWrite = false;
        mock.timers.tick(14_999);
        assert.equal(writes.length, 1);
        mock.timers.tick(1);
        assert.equal(writes.length, 2);
        assert.equal(readHar(filePath).log.entries.length, 3);
        assert.equal(messages.filter(message => message.includes('Recording stopped, wrote')).length, 1);
        mock.timers.tick(30_000);
        assert.equal(writes.length, 2);
    });

    test('failed dispose reports failure promptly and can retry completed and pending captures', async () => {
        const filePath = recorder.getCurrentFilePath();
        assert.ok(filePath);
        await recordRequests(2);
        const pending = await fetchCaptured('https://example.test/har-pending-close');
        failWrite = true;
        await assert.rejects(recorder.dispose(), error => {
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /HAR/);
            return true;
        });
        assert.equal(writes.length, 2);
        assert.equal(
            messages.some(message => message.includes('Recording stopped, wrote')),
            false
        );
        assert.equal(await pending.text(), 'captured body');
        mock.timers.tick(30_000);
        assert.equal(writes.length, 2);
        failWrite = false;
        await recorder.dispose();
        const entries = readHar(filePath).log.entries;
        assert.equal(entries.length, 3);
        assert.equal(entries[2].response._status, 'aborted');
        assert.equal(writes.length, 3);
        await recorder.dispose();
        assert.equal(writes.length, 3);
    });

    test('dispose recovers a transient final write failure within its bounded attempts', async () => {
        const filePath = recorder.getCurrentFilePath();
        assert.ok(filePath);
        await recordRequests(1);
        failedWritesRemaining = 1;
        await recorder.dispose();
        assert.equal(writes.length, 2);
        assert.equal(readHar(filePath).log.entries.length, 1);
        assert.equal(messages.filter(message => message.includes('Recording stopped, wrote')).length, 1);
    });

    test('configuration restart protects a failed closing file from retention cleanup', async () => {
        const firstPath = recorder.getCurrentFilePath();
        assert.ok(firstPath);
        await recordRequests(1);
        mock.timers.tick(15_000);
        await recordRequests(1);
        failWrite = true;
        recorder.initialize({ ...options, retentionCount: 1 });
        assert.equal(existsSync(firstPath), true);
        const nextPath = recorder.getCurrentFilePath();
        assert.ok(nextPath);
        assert.notEqual(nextPath, firstPath);
        await recordRequests(1);
        failWrite = false;
        mock.timers.tick(15_000);
        assert.equal(readHar(firstPath).log.entries.length, 2);
        assert.equal(readHar(nextPath).log.entries.length, 1);
    });

    test('reinitialization resumes retries retained after an explicit disposal failure', async () => {
        const firstPath = recorder.getCurrentFilePath();
        assert.ok(firstPath);
        await recordRequests(2);
        failWrite = true;
        await assert.rejects(recorder.dispose(), AggregateError);
        failWrite = false;
        recorder.initialize(options);
        await recordRequests(1);
        mock.timers.tick(15_000);
        assert.equal(readHar(firstPath).log.entries.length, 2);
        const nextPath = recorder.getCurrentFilePath();
        assert.ok(nextPath);
        assert.equal(readHar(nextPath).log.entries.length, 1);
    });

    test('disposing multiple states saves healthy files and retains only failed writes', async () => {
        const firstPath = recorder.getCurrentFilePath();
        assert.ok(firstPath);
        await recordRequests(2);
        failWrite = true;
        failedPath = firstPath;
        recorder.initialize({ ...options, retentionCount: 4 });
        const nextPath = recorder.getCurrentFilePath();
        assert.ok(nextPath);
        assert.notEqual(nextPath, firstPath);
        await recordRequests(1);
        await assert.rejects(recorder.dispose(), error => {
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors.length, 1);
            return true;
        });
        assert.equal(readHar(nextPath).log.entries.length, 1);
        assert.equal(writes.filter(filePath => filePath === nextPath).length, 1);
        const failedAttempts = writes.length;
        mock.timers.tick(30_000);
        assert.equal(writes.length, failedAttempts);
        failWrite = false;
        await recorder.dispose();
        assert.equal(readHar(firstPath).log.entries.length, 2);
        assert.equal(writes.filter(filePath => filePath === nextPath).length, 1);
    });
});
