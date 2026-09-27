import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { GeminiHandler, hasGeminiPartialUsage } from '../../src/handlers/geminiHandler';
import type { GeminiGenerateContentResponse } from '../../src/handlers/geminiType';
import { onLiveMetrics, type LiveStreamMetricEvent } from '../../src/handlers/liveMetrics';
import { decodeStatefulMarker } from '../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../src/handlers/types';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { TokenUsagesManager, type UpdateActualTokensParams } from '../../src/usages/usagesManager';
import { TokenFileLogger } from '../../src/usages/fileLogger';
import { LogPathManager } from '../../src/usages/fileLogger/logPathManager';
import { LogReadManager } from '../../src/usages/fileLogger/logReadManager';
import { LogWriteManager } from '../../src/usages/fileLogger/logWriteManager';
import { SnapshotManager } from '../../src/usages/fileLogger/snapshotManager';
import { StatsCalculator } from '../../src/usages/fileLogger/statsCalculator';
import type { TokenRequestLog } from '../../src/usages/fileLogger/types';
import { UsageParser } from '../../src/usages/fileLogger/usageParser';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { readResponseBodyData, type HarBodyData } from '../../src/utils/net/harRecorderHelpers';

suite('Gemini response termination', () => {
    for (const ending of [
        'completed',
        'invalid-json',
        'stream-error',
        'tool-conflict',
        'blocked',
        'timeout',
        'cancelled',
        'cancel-error'
    ] as const) {
        for (const captureHar of [false, true]) {
            test(`异常流清理保留终态与用量：${ending}, HAR=${captureHar}`, async () => {
                const originalGetApiKey = ApiKeyManager.getApiKey;
                const originalFetchWithProxy = ConfigManager.fetchWithProxy;
                const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
                const source = new vscode.CancellationTokenSource();
                const parts: vscode.LanguageModelResponsePart2[] = [];
                const updates: UpdateActualTokensParams[] = [];
                const usage = { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 };
                const event = (payload: GeminiGenerateContentResponse) => `data: ${JSON.stringify(payload)}\n\n`;
                const prefix = event({
                    candidates: [
                        {
                            content: {
                                parts: [
                                    { text: 'partial' },
                                    { functionCall: { id: 'call-1', name: 'read_file', args: { path: 'a' } } }
                                ]
                            }
                        }
                    ],
                    usageMetadata: usage
                });
                const tails = {
                    completed: event({ candidates: [{ finishReason: 'STOP' }] }),
                    'invalid-json': 'data: {broken-json}\n\n',
                    'stream-error': event({ error: { code: 503, message: 'test unavailable' } }),
                    'tool-conflict': event({
                        candidates: [
                            {
                                content: {
                                    parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: { path: 'b' } } }]
                                }
                            }
                        ]
                    }),
                    blocked: event({ promptFeedback: { blockReason: 'SAFETY' } }),
                    timeout: '',
                    cancelled: '',
                    'cancel-error': event({ promptFeedback: { blockReason: 'SAFETY' } })
                };
                let requestSignal: AbortSignal | undefined;
                let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
                let responseBody: ReadableStream<Uint8Array> | undefined;
                let capture: Promise<HarBodyData> | undefined;
                let transportEnded = false;
                let cancelCount = 0;
                let abortCount = 0;
                let deadline: ReturnType<typeof setTimeout> | undefined;
                let requestError: unknown;

                ApiKeyManager.getApiKey = async () => 'test-api-key';
                TokenUsagesManager.instance.updateActualTokens = params => updates.push(params);
                ConfigManager.fetchWithProxy = (async (_input, init) => {
                    requestSignal = init?.signal ?? undefined;
                    assert.ok(requestSignal);
                    const signal = requestSignal;
                    const body = new ReadableStream<Uint8Array>({
                        start(value) {
                            controller = value;
                            value.enqueue(new TextEncoder().encode(prefix + tails[ending]));
                            if (ending === 'completed') {
                                transportEnded = true;
                                value.close();
                            }
                        },
                        cancel() {
                            cancelCount++;
                            transportEnded = true;
                            if (ending === 'cancel-error') {
                                throw new Error('test cancel failure');
                            }
                        }
                    });
                    signal.addEventListener(
                        'abort',
                        () => {
                            abortCount++;
                            if (!transportEnded) {
                                transportEnded = true;
                                controller?.error(signal.reason);
                            }
                        },
                        { once: true }
                    );
                    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
                    if (captureHar) {
                        capture = readResponseBodyData(response.clone());
                    }
                    responseBody = response.body!;
                    return response;
                }) as typeof ConfigManager.fetchWithProxy;

                const handler = new GeminiHandler({
                    provider: 'test-provider',
                    providerConfig: { displayName: 'Test Provider' }
                } as unknown as GenericModelProvider);
                const streamReader = handler as unknown as {
                    readStreamChunk(
                        reader: ReadableStreamDefaultReader<Uint8Array>,
                        idleTimeoutMs: number
                    ): Promise<ReadableStreamReadResult<Uint8Array>>;
                };
                const readStreamChunk = streamReader.readStreamChunk.bind(handler);
                streamReader.readStreamChunk = reader => readStreamChunk(reader, 20);
                const request = handler
                    .handleRequest(
                        {
                            id: 'gemini-test',
                            name: 'Gemini Test',
                            maxOutputTokens: 4096
                        } as vscode.LanguageModelChatInformation,
                        { id: 'gemini-test', name: 'Gemini Test', baseUrl: 'https://gateway.test/gemini' } as never,
                        [],
                        {} as never,
                        {
                            report(part) {
                                parts.push(part);
                                if (ending === 'cancelled' && part instanceof vscode.LanguageModelTextPart) {
                                    source.cancel();
                                }
                            }
                        },
                        `cleanup-${ending}-${captureHar}`,
                        'session-1',
                        source.token
                    )
                    .catch((error: unknown) => {
                        requestError = error;
                    });

                try {
                    await Promise.race([
                        request,
                        new Promise<never>((_resolve, reject) => {
                            deadline = setTimeout(() => reject(new Error('流清理阻塞了请求结束')), 1000);
                        })
                    ]);
                    if (ending === 'completed') {
                        assert.equal(requestError, undefined);
                        assert.equal(cancelCount, 0);
                    } else {
                        assert.ok(requestError instanceof Error);
                        if (ending === 'cancelled') {
                            assert.ok(requestError instanceof vscode.CancellationError);
                        } else if (ending === 'blocked' || ending === 'cancel-error') {
                            assert.equal((requestError as vscode.LanguageModelError).code, 'Blocked');
                        } else {
                            assert.equal(hasGeminiPartialUsage(requestError), true);
                            const expectedMessage = {
                                'invalid-json': /Invalid JSON|无效 JSON/,
                                'stream-error': /test unavailable/,
                                'tool-conflict': /conflicting content|内容冲突/,
                                timeout: /ETIMEDOUT/
                            }[ending];
                            assert.match(requestError.message, expectedMessage);
                            if (ending === 'timeout') {
                                assert.equal((requestError as Error & { code?: string }).code, 'ETIMEDOUT');
                            }
                            if (ending === 'stream-error') {
                                assert.equal((requestError as Error & { status?: number }).status, 503);
                            }
                        }
                    }
                    assert.equal(requestSignal?.aborted, ending !== 'completed');
                    assert.equal(abortCount, ending === 'completed' ? 0 : 1);
                    assert.equal(responseBody?.locked, false);
                    assert.equal(transportEnded, true);
                    assert.equal(updates.length, 1);
                    assert.equal(
                        updates[0].status,
                        ending === 'completed' ? 'completed'
                        : ending === 'cancelled' ? 'cancelled'
                        : 'failed'
                    );
                    assert.deepEqual(updates[0].rawUsage, usage);
                    assert.equal(
                        parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length,
                        ending === 'completed' ? 1 : 0
                    );
                    assert.equal(
                        parts.filter(
                            part =>
                                part instanceof vscode.LanguageModelDataPart &&
                                part.mimeType === CustomDataPartMimeTypes.Usage
                        ).length,
                        1
                    );
                    if (capture) {
                        assert.ok((await capture).text?.includes('promptTokenCount'));
                    }
                } finally {
                    if (deadline !== undefined) {
                        clearTimeout(deadline);
                    }
                    source.cancel();
                    if (!transportEnded) {
                        transportEnded = true;
                        controller?.close();
                    }
                    await request;
                    await capture;
                    source.dispose();
                    ApiKeyManager.getApiKey = originalGetApiKey;
                    ConfigManager.fetchWithProxy = originalFetchWithProxy;
                    TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
                }
            });
        }
    }

    for (const ending of ['completed', 'failed', 'cancelled', 'aborted'] as const) {
        for (const visibleThinking of [false, true]) {
            test(`计时落盘和快照保持一致：${ending}, thinking=${visibleThinking}`, async () => {
                const originalGetApiKey = ApiKeyManager.getApiKey;
                const originalFetchWithProxy = ConfigManager.fetchWithProxy;
                const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
                const originalNow = Date.now;
                const source = new vscode.CancellationTokenSource();
                const pathManager = new LogPathManager(await mkdtemp(join(tmpdir(), 'gcmp-gemini-timing-')));
                const writer = new LogWriteManager(pathManager);
                const reader = new LogReadManager(pathManager);
                const snapshots = new SnapshotManager(pathManager, date => reader.invalidateDateCache(date));
                const logger = Object.create(TokenFileLogger.prototype) as TokenFileLogger;
                const requestId = 'timing-persisted';
                const initialLog: TokenRequestLog = {
                    requestId,
                    timestamp: 1000,
                    isoTime: new Date(1000).toISOString(),
                    providerKey: 'test-provider',
                    providerName: 'Test Provider',
                    modelId: 'gemini-test',
                    modelName: 'Gemini Test',
                    estimatedInput: 1,
                    rawUsage: null,
                    status: 'estimated'
                };
                Object.assign(logger, {
                    pendingLogs: new Map([[requestId, { ...initialLog }]]),
                    finalizingRequestIds: new Set<string>(),
                    writeManager: writer,
                    readManager: reader,
                    snapshotManager: snapshots,
                    refreshCurrentStats() {},
                    notifyUpdate() {}
                });
                const subscription = onLiveMetrics(event => {
                    (
                        logger as unknown as {
                            updateStreamingMetrics(event: LiveStreamMetricEvent): void;
                        }
                    ).updateStreamingMetrics(event);
                });
                const writes: Promise<void>[] = [];
                let now = 1000;
                let next = 0;
                const encoder = new TextEncoder();
                const usage = { promptTokenCount: 1, candidatesTokenCount: 11, thoughtsTokenCount: 100 };
                const chunks = [
                    ...(visibleThinking ?
                        [
                            {
                                time: 1200,
                                event: { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] }
                            }
                        ]
                    :   []),
                    { time: 11200, event: { candidates: [{ content: { parts: [{ text: 'first' }] } }] } },
                    {
                        time: 12200,
                        event: {
                            candidates: [
                                {
                                    content: { parts: [{ text: 'last' }] },
                                    ...(ending === 'completed' ? { finishReason: 'STOP' } : {})
                                }
                            ],
                            usageMetadata: usage
                        }
                    }
                ];
                Date.now = () => now;
                ApiKeyManager.getApiKey = async () => 'test-api-key';
                TokenUsagesManager.instance.updateActualTokens = params => {
                    writes.push(
                        logger.updateActualTokens({
                            ...params,
                            rawUsage: params.rawUsage as TokenRequestLog['rawUsage']
                        })
                    );
                };
                ConfigManager.fetchWithProxy = (async () =>
                    new Response(
                        new ReadableStream<Uint8Array>(
                            {
                                pull(controller) {
                                    const chunk = chunks[next++];
                                    if (chunk) {
                                        now = chunk.time;
                                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk.event)}\n\n`));
                                    } else {
                                        now = 50000;
                                        if (ending === 'cancelled' || ending === 'aborted') {
                                            source.cancel();
                                        }
                                        if (ending === 'aborted') {
                                            controller.error(new DOMException('aborted', 'AbortError'));
                                        } else {
                                            controller.close();
                                        }
                                    }
                                }
                            },
                            { highWaterMark: 0 }
                        ),
                        { headers: { 'content-type': 'text/event-stream' } }
                    )) as typeof ConfigManager.fetchWithProxy;
                try {
                    const handler = new GeminiHandler({
                        provider: 'test-provider',
                        providerConfig: { displayName: 'Test Provider' }
                    } as unknown as GenericModelProvider);
                    const request = handler.handleRequest(
                        {
                            id: 'gemini-test',
                            name: 'Gemini Test',
                            maxOutputTokens: 4096
                        } as vscode.LanguageModelChatInformation,
                        { id: 'gemini-test', name: 'Gemini Test', baseUrl: 'https://gateway.test/gemini' } as never,
                        [],
                        {} as never,
                        { report() {} },
                        requestId,
                        'session-1',
                        source.token
                    );
                    if (ending === 'completed') {
                        await request;
                    } else {
                        await assert.rejects(request, ending === 'failed' ? /finishReason/ : vscode.CancellationError);
                    }
                    await Promise.all(writes);
                    assert.equal(writes.length, 1);
                    const logPath = pathManager.getLogPathFromDate(new Date(now));
                    const saved = JSON.parse((await readFile(logPath.fullPath, 'utf8')).trim()) as TokenRequestLog;
                    assert.equal(saved.status, ending === 'aborted' ? 'cancelled' : ending);
                    assert.equal(saved.firstOutputTime, visibleThinking ? 1200 : 11200);
                    assert.equal(saved.lastOutputTime, 12200);
                    assert.equal(saved.firstContentOutputTime, 11200);
                    assert.equal(saved.lastContentOutputTime, 12200);
                    assert.deepEqual(saved.rawUsage, usage);
                    assert.equal(saved.streamStartTime, visibleThinking ? 1200 : 11200);
                    assert.equal(saved.streamEndTime, now);
                    const duration = now - (visibleThinking ? 1200 : 11200);
                    const expectedSpeed = (111 / duration) * 1000;
                    assert.equal(UsageParser.parseFromLog(saved).timePerOutputToken, duration / 111);
                    assert.equal(UsageParser.parseFromLog(saved).outputSpeed, expectedSpeed);
                    const merged = StatsCalculator.mergeLogsByRequestId([initialLog, saved]).get(requestId)!;
                    assert.equal(UsageParser.parseFromLog(merged).timePerOutputToken, duration / 111);
                    assert.equal(UsageParser.parseFromLog(merged).outputSpeed, expectedSpeed);
                    await snapshots.upsertRecord(logPath.date, merged);
                    const restored = (await snapshots.read(logPath.date))?.[0];
                    assert.equal(restored?.firstContentOutputTime, 11200);
                    assert.equal(restored?.lastContentOutputTime, 12200);
                    assert.equal(restored?.firstTokenLatency, visibleThinking ? 200 : 10200);
                    assert.equal(restored?.timePerOutputToken, duration / 111);
                    assert.equal(restored?.outputSpeed, expectedSpeed);
                } finally {
                    source.dispose();
                    subscription.dispose();
                    ApiKeyManager.getApiKey = originalGetApiKey;
                    ConfigManager.fetchWithProxy = originalFetchWithProxy;
                    TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
                    Date.now = originalNow;
                    await writer.dispose();
                    reader.dispose();
                    snapshots.clearCache();
                }
            });
        }
    }

    for (const finishReason of [undefined, 'FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS']) {
        test(`工具轮次终态 ${finishReason ?? 'missing'} 决定交付与持久化状态`, async () => {
            const originalGetApiKey = ApiKeyManager.getApiKey;
            const originalFetchWithProxy = ConfigManager.fetchWithProxy;
            const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
            const source = new vscode.CancellationTokenSource();
            const parts: vscode.LanguageModelResponsePart2[] = [];
            const updates: UpdateActualTokensParams[] = [];
            const usage = { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 };
            const completed = finishReason === 'STOP' || finishReason === 'MAX_TOKENS';
            ApiKeyManager.getApiKey = async () => 'test-api-key';
            TokenUsagesManager.instance.updateActualTokens = params => updates.push(params);
            ConfigManager.fetchWithProxy = (async () =>
                new Response(
                    `data: ${JSON.stringify({
                        candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: {} } }] } }],
                        usageMetadata: { promptTokenCount: 7 }
                    })}\n\ndata: ${JSON.stringify({
                        candidates: [{ finishReason }],
                        usageMetadata: usage
                    })}\n\ndata: [DONE]\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } }
                )) as typeof ConfigManager.fetchWithProxy;

            try {
                const handler = new GeminiHandler({
                    provider: 'test-provider',
                    providerConfig: { displayName: 'Test Provider' }
                } as unknown as GenericModelProvider);
                const request = handler.handleRequest(
                    {
                        id: 'gemini-test',
                        name: 'Gemini Test',
                        maxOutputTokens: 4096
                    } as vscode.LanguageModelChatInformation,
                    { id: 'gemini-test', name: 'Gemini Test', baseUrl: 'https://gateway.test/gemini' } as never,
                    [],
                    {} as never,
                    { report: part => parts.push(part) },
                    `termination-${finishReason ?? 'missing'}`,
                    'session-1',
                    source.token
                );
                if (completed) {
                    await request;
                } else {
                    await assert.rejects(request, /finishReason/);
                }
                assert.equal(updates.length, 1);
                assert.equal(updates[0].status, completed ? 'completed' : 'failed');
                assert.deepEqual(updates[0].rawUsage, usage);
                assert.equal(
                    parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).length,
                    completed ? 1 : 0
                );
                const markerPart = parts.find(
                    (part): part is vscode.LanguageModelDataPart =>
                        part instanceof vscode.LanguageModelDataPart &&
                        part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                );
                assert.ok(markerPart);
                const marker = decodeStatefulMarker(markerPart.data)?.marker;
                assert.equal(marker?.geminiToolCalls?.length ?? 0, completed ? 1 : 0);
                assert.equal(
                    marker?.geminiContents?.some(content => content.parts.some(part => part.functionCall)) ?? false,
                    completed
                );
                assert.equal(
                    parts.filter(
                        part =>
                            part instanceof vscode.LanguageModelDataPart &&
                            part.mimeType === CustomDataPartMimeTypes.Usage
                    ).length,
                    1
                );
            } finally {
                source.dispose();
                ApiKeyManager.getApiKey = originalGetApiKey;
                ConfigManager.fetchWithProxy = originalFetchWithProxy;
                TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
            }
        });
    }

    for (const body of ['', 'data: [DONE]\n\n', 'data: {"usageMetadata":{"promptTokenCount":7}}\n\n']) {
        test(`无候选终态的响应必须失败：${body || 'empty'}`, async () => {
            const originalGetApiKey = ApiKeyManager.getApiKey;
            const originalFetchWithProxy = ConfigManager.fetchWithProxy;
            const originalUpdateActualTokens = TokenUsagesManager.instance.updateActualTokens;
            const source = new vscode.CancellationTokenSource();
            const updates: UpdateActualTokensParams[] = [];
            ApiKeyManager.getApiKey = async () => 'test-api-key';
            TokenUsagesManager.instance.updateActualTokens = params => updates.push(params);
            ConfigManager.fetchWithProxy = (async () =>
                new Response(body, {
                    headers: { 'content-type': 'text/event-stream' }
                })) as typeof ConfigManager.fetchWithProxy;
            try {
                const handler = new GeminiHandler({
                    provider: 'test-provider',
                    providerConfig: { displayName: 'Test Provider' }
                } as unknown as GenericModelProvider);
                await assert.rejects(
                    handler.handleRequest(
                        {
                            id: 'gemini-test',
                            name: 'Gemini Test',
                            maxOutputTokens: 4096
                        } as vscode.LanguageModelChatInformation,
                        { id: 'gemini-test', name: 'Gemini Test', baseUrl: 'https://gateway.test/gemini' } as never,
                        [],
                        {} as never,
                        { report() {} },
                        'termination-empty',
                        'session-1',
                        source.token
                    ),
                    /finishReason/
                );
                assert.equal(updates.length, 1);
                assert.equal(updates[0].status, 'failed');
            } finally {
                source.dispose();
                ApiKeyManager.getApiKey = originalGetApiKey;
                ConfigManager.fetchWithProxy = originalFetchWithProxy;
                TokenUsagesManager.instance.updateActualTokens = originalUpdateActualTokens;
            }
        });
    }
});
