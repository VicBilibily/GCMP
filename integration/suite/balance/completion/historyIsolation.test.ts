import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { convertMessagesToGemini } from '../../../../src/handlers/gemini/geminiConverter';
import type { GeminiContent, GeminiPart } from '../../../../src/handlers/gemini/geminiType';
import { decodeStatefulMarker, encodeStatefulMarker } from '../../../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../../../src/handlers/types';
import { InterInstanceBus } from '../../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { TokenUsagesManager, type UpdateActualTokensParams } from '../../../../src/usages/usagesManager';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
import { RetryProvider, createContext, defaultRetry, slot, trackedCancellation } from '../retryFixture';

suite('Gemini history round isolation', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        hasActiveTransport: InterInstanceBus.hasActiveTransport,
        isAuthorityTransitioning: InterInstanceBus.isAuthorityTransitioning,
        publishIpcOnly: InterInstanceBus.publishIpcOnly,
        publish: InterInstanceBus.publish
    };
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
    const originalRelease = RateLimiter.release;
    const originalFailure = ApiKeyFailoverManager.handleFailure;
    const state = ApiKeyFailoverManager as unknown as {
        balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
        balanceAttemptSnapshots: Map<string, unknown>;
        balanceLeases: Map<string, unknown>;
        pendingBalanceFailures: Map<string, unknown>;
        pendingLeaderDecisions: Map<string, unknown>;
    };
    let context: vscode.ExtensionContext;
    let cancellation: ReturnType<typeof trackedCancellation>;
    let wireKeys: string[];
    let updates: UpdateActualTokensParams[];
    let releases: Array<Parameters<typeof RateLimiter.release>>;
    let failureReports: number;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-gemini-history-')));
        context = createContext();
        cancellation = trackedCancellation();
        wireKeys = [];
        updates = [];
        releases = [];
        failureReports = 0;
        const term = `history:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'history-instance'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => true,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => true,
            publish: () => {}
        });
        TokenUsagesManager.instance.updateActualTokens = update => updates.push(update);
        RateLimiter.release = (...args) => releases.push(args);
        ApiKeyFailoverManager.handleFailure = (...args) => {
            failureReports++;
            return originalFailure.apply(ApiKeyFailoverManager, args);
        };
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'off');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        cancellation.dispose();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        setBalanceHandoffDirectoryOverride(undefined);
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
        RateLimiter.release = originalRelease;
        ApiKeyFailoverManager.handleFailure = originalFailure;
    });

    for (const idPolicy of ['reused', 'unique', 'absent'] as const) {
        for (const transport of ['memory', 'http'] as const) {
            for (const mode of ['off', 'balance', 'failover'] as const) {
                for (const cancelAt of ['none', 'signature', 'tool', 'last-tool', 'usage'] as const) {
                    test(`Gemini 三轮工具历史隔离：${idPolicy}, ${transport}, ${mode}, ${cancelAt}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const wireIds = idPolicy !== 'absent';
                        const rawUsage = { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 };
                        const originalParts: GeminiPart[] = [
                            { text: 'preface' },
                            ...[0, 1].map(index => ({
                                functionCall: {
                                    ...(wireIds ? { id: `call-${index}` } : {}),
                                    name: 'read_file',
                                    args: { index }
                                },
                                ...(index === 0 ? { thoughtSignature: 'call-signature' } : {})
                            })),
                            { thoughtSignature: 'trailing-signature' }
                        ];
                        const previousRaw = originalParts.map(part => ({
                            ...part,
                            ...(part.functionCall ?
                                {
                                    functionCall: {
                                        ...part.functionCall,
                                        ...(idPolicy === 'unique' ? { id: `earlier-${part.functionCall.id}` } : {})
                                    }
                                }
                            :   {})
                        }));
                        const payload = (parts: GeminiPart[]): string =>
                            `data: ${JSON.stringify({
                                candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
                                usageMetadata: rawUsage
                            })}\n\n`;
                        let responseBody = payload(previousRaw);
                        const requests: Array<{ contents: GeminiContent[] }> = [];
                        const previousSource = trackedCancellation();
                        const nextSource = trackedCancellation();
                        const handles: RateLimitHandle[] = Array.from({ length: 3 }, () => ({
                            grantId: randomUUID(),
                            costs: { requests: 1, tokens: 4 },
                            leaseMs: 30000,
                            authoritative: false
                        }));
                        let server: Server | undefined;
                        try {
                            let endpoint: string | undefined;
                            if (transport === 'http') {
                                server = createServer((request, response) => {
                                    request.resume();
                                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                                    response.end(responseBody);
                                });
                                const listener = server;
                                await new Promise<void>((resolve, reject) => {
                                    listener.once('error', reject);
                                    listener.listen(0, '127.0.0.1', resolve);
                                });
                                const address = server.address();
                                assert.ok(address && typeof address === 'object');
                                endpoint = `http://127.0.0.1:${address.port}`;
                            }
                            ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                                const request = new Request(input, init);
                                const body = await request.text();
                                wireKeys.push(
                                    request.headers.get('authorization')?.replace(/^Bearer /, '') ??
                                        request.headers.get('x-goog-api-key') ??
                                        ''
                                );
                                requests.push(JSON.parse(body) as { contents: GeminiContent[] });
                                return endpoint ?
                                        fetch(endpoint + new URL(request.url).pathname, {
                                            method: request.method,
                                            headers: request.headers,
                                            body,
                                            signal: request.signal
                                        })
                                    :   new Response(responseBody, {
                                            headers: { 'content-type': 'text/event-stream' }
                                        });
                            };
                            const previousParts: vscode.LanguageModelResponsePart[] = [];
                            const previousObserved = { grants: 0, handle: handles[0] };
                            await RetryProvider.run(
                                'gemini-sse',
                                defaultRetry,
                                previousObserved,
                                previousSource.token,
                                previousParts,
                                randomUUID()
                            );
                            assert.equal(previousObserved.grants, 1);
                            assert.equal(requests.length, 1);
                            assert.deepEqual(
                                updates.map(update => update.status),
                                ['completed']
                            );
                            const earlierTools = previousParts.filter(
                                part => part instanceof vscode.LanguageModelToolCallPart
                            );
                            assert.equal(earlierTools.length, 2);
                            const previousHistory = [
                                vscode.LanguageModelChatMessage.User('earlier question'),
                                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                                    ...previousParts
                                ]),
                                vscode.LanguageModelChatMessage.User(
                                    earlierTools.map(
                                        (tool, index) =>
                                            new vscode.LanguageModelToolResultPart(tool.callId, [
                                                new vscode.LanguageModelTextPart(`earlier-result-${index}`)
                                            ])
                                    )
                                ),
                                vscode.LanguageModelChatMessage.User('read both files')
                            ];
                            const previousSerialized = JSON.stringify(previousHistory);
                            responseBody = payload(originalParts);
                            const parts: vscode.LanguageModelResponsePart[] = [];
                            const append = parts.push.bind(parts);
                            let triggered = false;
                            let lateTools = 0;
                            let toolCount = 0;
                            parts.push = (...incoming) => {
                                for (const part of incoming) {
                                    const isTool = part instanceof vscode.LanguageModelToolCallPart;
                                    if (isTool && cancellation.token.isCancellationRequested) {
                                        lateTools++;
                                    }
                                    const kind =
                                        isTool ?
                                            ++toolCount === 1 ?
                                                'tool'
                                            :   'last-tool'
                                        : part instanceof vscode.LanguageModelThinkingPart ? 'signature'
                                        : (
                                            part instanceof vscode.LanguageModelDataPart &&
                                            part.mimeType === CustomDataPartMimeTypes.Usage
                                        ) ?
                                            'usage'
                                        :   'other';
                                    append(part);
                                    if (!triggered && kind === cancelAt) {
                                        triggered = true;
                                        cancellation.cancel();
                                    }
                                }
                                return parts.length;
                            };
                            const observed = { grants: 0, handle: handles[1] };
                            const currentRequest = RetryProvider.run(
                                'gemini-sse',
                                defaultRetry,
                                observed,
                                cancellation.token,
                                parts,
                                randomUUID(),
                                previousHistory
                            );
                            if (cancelAt === 'none') {
                                await currentRequest;
                            } else {
                                await assert.rejects(currentRequest, vscode.CancellationError);
                            }
                            assert.equal(triggered, cancelAt !== 'none');
                            assert.equal(lateTools, 0);
                            assert.equal(observed.grants, 1);
                            assert.equal(requests.length, 2);
                            const secondHistory = requests[1].contents.flatMap(content => content.parts);
                            assert.equal(secondHistory.filter(part => part.functionCall).length, 2);
                            assert.equal(secondHistory.filter(part => part.functionResponse).length, 2);
                            const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            assert.deepEqual(
                                tools.map(tool => tool.input),
                                (cancelAt === 'signature' ? []
                                : cancelAt === 'tool' ? [0]
                                : [0, 1]
                                ).map(index => ({ index }))
                            );
                            assert.equal(new Set(tools.map(tool => tool.callId)).size, tools.length);
                            const markerParts = parts.filter(
                                (part): part is vscode.LanguageModelDataPart =>
                                    part instanceof vscode.LanguageModelDataPart &&
                                    part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                            );
                            assert.equal(markerParts.length, 1);
                            const marker = decodeStatefulMarker(markerParts[0].data)?.marker;
                            assert.ok(marker);
                            assert.equal(marker.sessionId, 'balance-retry-session');
                            assert.deepEqual(marker.usage, { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 });
                            const history = [
                                ...previousHistory,
                                new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                                    ...parts
                                ]),
                                ...(tools.length > 0 ?
                                    [
                                        vscode.LanguageModelChatMessage.User(
                                            tools
                                                .map(
                                                    (tool, index) =>
                                                        new vscode.LanguageModelToolResultPart(tool.callId, [
                                                            new vscode.LanguageModelTextPart(`result-${index}`)
                                                        ])
                                                )
                                                .reverse()
                                        )
                                    ]
                                :   []),
                                vscode.LanguageModelChatMessage.User('continue')
                            ];
                            responseBody = payload([{ text: 'continued' }]);
                            const nextObserved = { grants: 0, handle: handles[2] };
                            const nextParts: vscode.LanguageModelResponsePart[] = [];
                            await RetryProvider.run(
                                'gemini-sse',
                                defaultRetry,
                                nextObserved,
                                nextSource.token,
                                nextParts,
                                randomUUID(),
                                history
                            );
                            assert.equal(nextObserved.grants, 1);
                            assert.equal(requests.length, 3);
                            assert.equal(wireKeys.length, 3);
                            assert.ok(wireKeys.every(key => ['key-a', 'key-b'].includes(key)));
                            assert.equal(failureReports, 0);
                            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                            assert.equal(JSON.stringify(previousHistory), previousSerialized);
                            for (const source of [previousSource, cancellation, nextSource]) {
                                assert.equal(source.subscriptions, source.disposals);
                            }
                            assert.deepEqual(
                                updates.map(update => update.status),
                                ['completed', cancelAt === 'none' ? 'completed' : 'cancelled', 'completed']
                            );
                            for (const update of updates) {
                                assert.deepEqual(update.rawUsage, rawUsage);
                                assert.ok(update.streamStartTime);
                                assert.ok(update.streamEndTime);
                            }
                            assert.deepEqual(releases, [
                                [handles[0]],
                                cancelAt === 'none' ? [handles[1]] : [handles[1], { tokens: handles[1].costs.tokens }],
                                [handles[2]]
                            ]);
                            for (const collection of [
                                state.balanceLeaseRenewalTimers,
                                state.balanceAttemptSnapshots,
                                state.balanceLeases,
                                state.pendingBalanceFailures,
                                state.pendingLeaderDecisions
                            ]) {
                                assert.equal(collection.size, 0);
                            }
                            assert.equal(
                                nextParts
                                    .filter(part => part instanceof vscode.LanguageModelTextPart)
                                    .map(part => part.value)
                                    .join(''),
                                'continued'
                            );
                            const replayModels = requests[2].contents.filter(content => content.role === 'model');
                            assert.deepEqual(replayModels[0].parts, previousRaw);
                            const historyParts = requests[2].contents.flatMap(content => content.parts);
                            assert.ok(historyParts.some(part => part.text === 'continue'));
                            const replayCalls = historyParts.flatMap(part =>
                                part.functionCall ? [part.functionCall] : []
                            );
                            const replayResults = historyParts.flatMap(part =>
                                part.functionResponse ? [part.functionResponse] : []
                            );
                            const dropped = ['signature', 'tool', 'last-tool'].includes(cancelAt);
                            assert.equal(replayCalls.length, dropped ? 2 : 4);
                            assert.equal(replayResults.length, replayCalls.length);
                            assert.deepEqual(
                                replayResults.map(result => result.response),
                                [
                                    { result: 'earlier-result-0' },
                                    { result: 'earlier-result-1' },
                                    ...(dropped ? [] : [{ result: 'result-0' }, { result: 'result-1' }])
                                ]
                            );
                            const expectedIds = [
                                ...previousRaw.flatMap(part => (part.functionCall ? [part.functionCall.id] : [])),
                                ...(dropped ? []
                                : wireIds ? ['call-0', 'call-1']
                                : [undefined, undefined])
                            ];
                            assert.deepEqual(
                                replayCalls.map(call => call.id),
                                expectedIds
                            );
                            assert.deepEqual(
                                replayResults.map(result => result.id),
                                expectedIds
                            );
                            if (dropped) {
                                assert.equal(marker.geminiRequestIdentity, undefined);
                                assert.equal(marker.geminiContents, undefined);
                                assert.equal(marker.geminiToolCalls, undefined);
                                assert.ok(
                                    replayModels
                                        .slice(1)
                                        .every(content =>
                                            content.parts.every(
                                                part =>
                                                    !part.functionCall &&
                                                    !part.thoughtSignature &&
                                                    !part.thought_signature
                                            )
                                        )
                                );
                            } else {
                                assert.ok(marker.geminiRequestIdentity);
                                assert.deepEqual(marker.geminiContents, [{ role: 'model', parts: originalParts }]);
                                assert.deepEqual(replayModels.at(-1)?.parts, originalParts);
                            }
                        } finally {
                            previousSource.dispose();
                            nextSource.dispose();
                            if (server) {
                                server.closeAllConnections();
                                const listener = server;
                                await new Promise<void>((resolve, reject) =>
                                    listener.close(error => (error ? reject(error) : resolve()))
                                );
                            }
                        }
                    });
                }
            }
        }
    }

    for (const order of ['before', 'after'] as const) {
        for (const layout of ['separate', 'mixed'] as const) {
            for (const invalidMarker of ['missing', 'foreign'] as const) {
                test(`Gemini 同 ID 结果仅清理所属轮次：${order}, ${layout}, ${invalidMarker}`, () => {
                    const identity = {
                        provider: 'history-provider',
                        modelId: 'history-model',
                        requestIdentity: 'history-identity'
                    };
                    const rawParts: GeminiPart[] = [
                        {
                            functionCall: { id: 'shared-call', name: 'read_file', args: {} },
                            thoughtSignature: 'complete-signature'
                        },
                        { thoughtSignature: 'complete-tail' }
                    ];
                    const marker = (requestIdentity: string) =>
                        new vscode.LanguageModelDataPart(
                            encodeStatefulMarker(identity.modelId, {
                                sessionId: 'history-session',
                                responseId: 'history-response',
                                provider: identity.provider,
                                modelId: identity.modelId,
                                sdkMode: 'gemini',
                                geminiRequestIdentity: requestIdentity,
                                geminiContents: [{ role: 'model', parts: rawParts }],
                                geminiToolCalls: [
                                    { localCallId: 'shared-call', upstreamCallId: 'shared-call', name: 'read_file' }
                                ]
                            }),
                            CustomDataPartMimeTypes.StatefulMarker
                        );
                    const complete = [
                        vscode.LanguageModelChatMessage.Assistant([
                            new vscode.LanguageModelToolCallPart('shared-call', 'read_file', {}),
                            marker(identity.requestIdentity)
                        ]),
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelToolResultPart('shared-call', [
                                new vscode.LanguageModelTextPart('complete-result')
                            ])
                        ])
                    ];
                    const droppedResult = new vscode.LanguageModelToolResultPart('shared-call', [
                        new vscode.LanguageModelTextPart('discarded-result')
                    ]);
                    const discarded = [
                        vscode.LanguageModelChatMessage.Assistant([
                            new vscode.LanguageModelToolCallPart('shared-call', 'read_file', {}),
                            ...(invalidMarker === 'foreign' ? [marker('foreign-identity')] : [])
                        ]),
                        ...(layout === 'mixed' ?
                            [
                                vscode.LanguageModelChatMessage.User([
                                    droppedResult,
                                    new vscode.LanguageModelTextPart('kept-note')
                                ])
                            ]
                        :   [
                                vscode.LanguageModelChatMessage.User([droppedResult]),
                                vscode.LanguageModelChatMessage.User('kept-note')
                            ])
                    ];
                    const history = [
                        vscode.LanguageModelChatMessage.User('start'),
                        ...(order === 'before' ? [...complete, ...discarded] : [...discarded, ...complete]),
                        vscode.LanguageModelChatMessage.User('continue')
                    ];
                    const original = JSON.stringify(history);
                    const converted = convertMessagesToGemini(history, identity);
                    const parts = converted.contents.flatMap(content => content.parts);
                    assert.deepEqual(converted.contents.find(content => content.role === 'model')?.parts, rawParts);
                    assert.deepEqual(
                        parts.flatMap(part => (part.functionResponse ? [part.functionResponse.response] : [])),
                        [{ result: 'complete-result' }]
                    );
                    assert.ok(parts.some(part => part.text === 'kept-note'));
                    assert.ok(parts.some(part => part.text === 'continue'));
                    assert.equal(JSON.stringify(history), original);
                });
            }
        }
    }
});
