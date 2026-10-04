import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { convertMessagesToGemini } from '../../../../src/handlers/gemini/geminiConverter';
import type { GeminiContent, GeminiPart } from '../../../../src/handlers/gemini/geminiType';
import { encodeStatefulMarker } from '../../../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../../../src/handlers/types';
import { InterInstanceBus } from '../../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { TokenUsagesManager, type UpdateActualTokensParams } from '../../../../src/usages/usagesManager';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
import { RetryProvider, createContext, defaultRetry, slot, trackedCancellation } from '../retryFixture';

suite('Gemini 混合消息工具结果对齐', () => {
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
    let failureReports: number;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-gemini-order-')));
        context = createContext();
        cancellation = trackedCancellation();
        wireKeys = [];
        updates = [];
        failureReports = 0;
        const term = `order:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'order-instance'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => true,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => true,
            publish: () => {}
        });
        TokenUsagesManager.instance.updateActualTokens = update => updates.push(update);
        RateLimiter.release = () => {};
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

    for (const wireIds of [false, true]) {
        for (const sameName of [false, true]) {
            for (const transport of ['memory', 'http'] as const) {
                for (const mode of ['off', 'balance', 'failover'] as const) {
                    for (const layout of ['separate', 'mixed'] as const) {
                        for (const reverse of [false, true]) {
                            test(`实际两轮请求结果对齐：${wireIds}, ${sameName}, ${transport}, ${mode}, ${layout}, ${reverse}`, async () => {
                                await ConfigSetStore.setSwitchMode(slot, mode);
                                const rawParts: GeminiPart[] = [
                                    ...[0, 1].map(index => ({
                                        functionCall: {
                                            ...(wireIds ? { id: 'call-' + index } : {}),
                                            name:
                                                sameName ? 'read_file'
                                                : index === 0 ? 'read_file'
                                                : 'list_dir',
                                            args: { index }
                                        },
                                        thoughtSignature: 'signature-' + index
                                    })),
                                    { thoughtSignature: 'trailing-signature' }
                                ];
                                const payload = (parts: GeminiPart[]): string =>
                                    'data: ' +
                                    JSON.stringify({
                                        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
                                        usageMetadata: {
                                            promptTokenCount: 2,
                                            candidatesTokenCount: 2,
                                            totalTokenCount: 4
                                        }
                                    }) +
                                    '\n\n';
                                let body = payload(rawParts);
                                const requests: Array<{ contents: GeminiContent[] }> = [];
                                const nextSource = trackedCancellation();
                                let server: Server | undefined;
                                let serverRequests = 0;
                                try {
                                    let endpoint: string | undefined;
                                    if (transport === 'http') {
                                        server = createServer((request, response) => {
                                            serverRequests++;
                                            request.resume();
                                            response.writeHead(200, { 'content-type': 'text/event-stream' });
                                            response.end(body);
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
                                        const serialized = await request.text();
                                        requests.push(JSON.parse(serialized) as { contents: GeminiContent[] });
                                        wireKeys.push(
                                            request.headers.get('authorization')?.replace(/^Bearer /, '') ??
                                                request.headers.get('x-goog-api-key') ??
                                                ''
                                        );
                                        return endpoint ?
                                                fetch(endpoint + new URL(request.url).pathname, {
                                                    method: request.method,
                                                    headers: request.headers,
                                                    body: serialized,
                                                    signal: request.signal
                                                })
                                            :   new Response(body, {
                                                    headers: { 'content-type': 'text/event-stream' }
                                                });
                                    };
                                    const parts: vscode.LanguageModelResponsePart[] = [];
                                    const firstObserved = { grants: 0 };
                                    await RetryProvider.run(
                                        'gemini-sse',
                                        defaultRetry,
                                        firstObserved,
                                        cancellation.token,
                                        parts,
                                        randomUUID()
                                    );
                                    assert.equal(firstObserved.grants, 1);
                                    assert.equal(requests.length, 1);
                                    const tools = parts.filter(
                                        part => part instanceof vscode.LanguageModelToolCallPart
                                    );
                                    assert.equal(tools.length, 2);
                                    assert.equal(new Set(tools.map(tool => tool.callId)).size, 2);
                                    const resultParts = tools.map(
                                        (tool, index) =>
                                            new vscode.LanguageModelToolResultPart(tool.callId, [
                                                new vscode.LanguageModelTextPart('value-for-' + index)
                                            ])
                                    );
                                    if (reverse) {
                                        resultParts.reverse();
                                    }
                                    const history = [
                                        vscode.LanguageModelChatMessage.User('perform both tools'),
                                        new vscode.LanguageModelChatMessage(
                                            vscode.LanguageModelChatMessageRole.Assistant,
                                            [...parts]
                                        ),
                                        vscode.LanguageModelChatMessage.User([
                                            ...resultParts,
                                            ...(layout === 'mixed' ?
                                                [new vscode.LanguageModelTextPart('continue with both results')]
                                            :   [])
                                        ]),
                                        ...(layout === 'separate' ?
                                            [vscode.LanguageModelChatMessage.User('continue with both results')]
                                        :   [])
                                    ];
                                    const original = JSON.stringify(history);
                                    body = payload([{ text: 'continued' }]);
                                    const nextObserved = { grants: 0 };
                                    const nextParts: vscode.LanguageModelResponsePart[] = [];
                                    let nextError: unknown;
                                    try {
                                        await RetryProvider.run(
                                            'gemini-sse',
                                            defaultRetry,
                                            nextObserved,
                                            nextSource.token,
                                            nextParts,
                                            randomUUID(),
                                            history
                                        );
                                    } catch (error) {
                                        nextError = error;
                                    }
                                    const responses =
                                        requests[1]?.contents.flatMap(content =>
                                            content.parts.flatMap(part =>
                                                part.functionResponse ? [part.functionResponse] : []
                                            )
                                        ) ?? [];
                                    const actual =
                                        wireIds ?
                                            [0, 1].map(
                                                index =>
                                                    responses.find(result => result.id === 'call-' + index)?.response
                                            )
                                        :   responses.map(result => result.response);
                                    assert.equal(JSON.stringify(history), original);
                                    assert.equal(cancellation.subscriptions, cancellation.disposals);
                                    assert.equal(nextSource.subscriptions, nextSource.disposals);
                                    for (const collection of [
                                        state.balanceLeaseRenewalTimers,
                                        state.balanceAttemptSnapshots,
                                        state.balanceLeases,
                                        state.pendingBalanceFailures,
                                        state.pendingLeaderDecisions
                                    ]) {
                                        assert.equal(collection.size, 0);
                                    }
                                    if (transport === 'http') {
                                        assert.equal(serverRequests, requests.length);
                                    }
                                    assert.equal(nextError, undefined);
                                    assert.equal(requests.length, 2);
                                    assert.equal(nextObserved.grants, 1);
                                    assert.equal(failureReports, 0);
                                    assert.deepEqual(actual, [{ result: 'value-for-0' }, { result: 'value-for-1' }]);
                                    assert.deepEqual(
                                        requests[1].contents.find(content => content.role === 'model')?.parts,
                                        rawParts
                                    );
                                    assert.deepEqual(
                                        updates.map(update => update.status),
                                        ['completed', 'completed']
                                    );
                                    assert.ok(wireKeys.every(key => key === 'key-a' || key === 'key-b'));
                                    assert.equal(
                                        requests[1].contents
                                            .flatMap(content => content.parts)
                                            .filter(part => part.text === 'continue with both results').length,
                                        1
                                    );
                                } finally {
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
        }
    }

    for (const wireIds of [false, true]) {
        for (const sameName of [false, true]) {
            for (const order of ['before', 'between', 'after'] as const) {
                for (const layout of ['separate', 'split', 'mixed'] as const) {
                    for (const invalidMarker of ['missing', 'foreign'] as const) {
                        test(`历史净化后的结果布局：${wireIds}, ${sameName}, ${order}, ${layout}, ${invalidMarker}`, () => {
                            const identity = {
                                provider: 'test-provider',
                                modelId: 'gemini-test',
                                requestIdentity: 'request-identity'
                            };
                            const calls = [0, 1].map(index => ({
                                localCallId: 'local-' + index,
                                ...(wireIds ? { upstreamCallId: 'wire-' + index } : {}),
                                name:
                                    sameName ? 'read_file'
                                    : index === 0 ? 'read_file'
                                    : 'list_dir'
                            }));
                            const rawParts = [
                                ...calls.map((call, index) => ({
                                    functionCall: {
                                        ...(call.upstreamCallId ? { id: call.upstreamCallId } : {}),
                                        name: call.name,
                                        args: { index }
                                    },
                                    thoughtSignature: 'signature-' + index
                                })),
                                { thoughtSignature: 'trailing-signature' }
                            ];
                            const makeRound = (label: string, valid: boolean): vscode.LanguageModelChatMessage[] => {
                                const marker = new vscode.LanguageModelDataPart(
                                    encodeStatefulMarker(identity.modelId, {
                                        sessionId: 'layout-session',
                                        responseId: label,
                                        provider: identity.provider,
                                        modelId: identity.modelId,
                                        sdkMode: 'gemini',
                                        geminiRequestIdentity: valid ? identity.requestIdentity : 'foreign',
                                        geminiToolCalls: calls,
                                        geminiContents: [{ role: 'model', parts: rawParts }]
                                    }),
                                    CustomDataPartMimeTypes.StatefulMarker
                                );
                                const assistant = new vscode.LanguageModelChatMessage(
                                    vscode.LanguageModelChatMessageRole.Assistant,
                                    [
                                        ...calls.map(
                                            (call, index) =>
                                                new vscode.LanguageModelToolCallPart(call.localCallId, call.name, {
                                                    index
                                                })
                                        ),
                                        ...(valid || invalidMarker === 'foreign' ? [marker] : [])
                                    ]
                                );
                                const results = calls.map(
                                    (call, index) =>
                                        new vscode.LanguageModelToolResultPart(call.localCallId, [
                                            new vscode.LanguageModelTextPart(label + '-' + index)
                                        ])
                                );
                                const note = vscode.LanguageModelChatMessage.User(label + ' note');
                                const users =
                                    layout === 'mixed' ?
                                        [
                                            vscode.LanguageModelChatMessage.User([
                                                results[1],
                                                new vscode.LanguageModelTextPart(label + ' note'),
                                                results[0]
                                            ])
                                        ]
                                    : layout === 'split' ?
                                        [
                                            vscode.LanguageModelChatMessage.User([results[1]]),
                                            vscode.LanguageModelChatMessage.User([results[0]]),
                                            note
                                        ]
                                    :   [vscode.LanguageModelChatMessage.User([results[1], results[0]]), note];
                                return [assistant, ...users];
                            };
                            const kept = makeRound('kept', true);
                            const firstDropped = makeRound('dropped-first', false);
                            const lastDropped = makeRound('dropped-last', false);
                            const history = [
                                vscode.LanguageModelChatMessage.User('start'),
                                ...(order === 'before' ? [...kept, ...firstDropped, ...lastDropped]
                                : order === 'between' ? [...firstDropped, ...kept, ...lastDropped]
                                : [...firstDropped, ...lastDropped, ...kept]),
                                vscode.LanguageModelChatMessage.User('continue')
                            ];
                            const original = JSON.stringify(history);
                            const converted = convertMessagesToGemini(history, identity);
                            const results = converted.contents.flatMap(content =>
                                content.parts.flatMap(part => (part.functionResponse ? [part.functionResponse] : []))
                            );
                            const actual =
                                wireIds ?
                                    calls.map(
                                        call => results.find(result => result.id === call.upstreamCallId)?.response
                                    )
                                :   results.map(result => result.response);
                            assert.equal(JSON.stringify(history), original);
                            assert.deepEqual(actual, [{ result: 'kept-0' }, { result: 'kept-1' }]);
                            assert.deepEqual(
                                converted.contents.find(content => content.role === 'model')?.parts,
                                rawParts
                            );
                            assert.ok(
                                converted.contents
                                    .flatMap(content => content.parts)
                                    .some(part => part.text === 'kept note')
                            );
                        });
                    }
                }
            }
        }
    }

    for (const wireIds of [false, true]) {
        for (const layout of ['mixed', 'split', 'interlude'] as const) {
            for (const allowMedia of [false, true]) {
                test(`结果重排保留文本媒体位置：${wireIds}, ${layout}, ${allowMedia}`, () => {
                    const identity = {
                        provider: 'test-provider',
                        modelId: 'gemini-test',
                        requestIdentity: 'request-identity'
                    };
                    const calls = [0, 1].map(index => ({
                        localCallId: 'local-' + index,
                        ...(wireIds ? { upstreamCallId: 'wire-' + index } : {}),
                        name: 'read_file'
                    }));
                    const rawParts: GeminiPart[] = calls.map((call, index) => ({
                        functionCall: {
                            ...(call.upstreamCallId ? { id: call.upstreamCallId } : {}),
                            name: call.name,
                            args: { index }
                        },
                        thoughtSignature: 'signature-' + index
                    }));
                    const marker = new vscode.LanguageModelDataPart(
                        encodeStatefulMarker(identity.modelId, {
                            sessionId: 'media-session',
                            responseId: 'media-response',
                            provider: identity.provider,
                            modelId: identity.modelId,
                            sdkMode: 'gemini',
                            geminiRequestIdentity: identity.requestIdentity,
                            geminiToolCalls: calls,
                            geminiContents: [{ role: 'model', parts: rawParts }]
                        }),
                        CustomDataPartMimeTypes.StatefulMarker
                    );
                    const media = [0, 1].map(
                        index => new vscode.LanguageModelDataPart(new Uint8Array([index + 1]), 'image/png')
                    );
                    const results = calls.map(
                        (call, index) =>
                            new vscode.LanguageModelToolResultPart(call.localCallId, [
                                new vscode.LanguageModelTextPart('value-' + index),
                                media[index]
                            ])
                    );
                    const before = new vscode.LanguageModelTextPart('before');
                    const first = [results[1], media[0], new vscode.LanguageModelTextPart('between')];
                    const second = [results[0], media[1], new vscode.LanguageModelTextPart('after')];
                    const users =
                        layout === 'mixed' ? [vscode.LanguageModelChatMessage.User([before, ...first, ...second])]
                        : layout === 'split' ?
                            [
                                vscode.LanguageModelChatMessage.User([before, ...first]),
                                vscode.LanguageModelChatMessage.User(second)
                            ]
                        :   [
                                vscode.LanguageModelChatMessage.User([before]),
                                vscode.LanguageModelChatMessage.User(first),
                                vscode.LanguageModelChatMessage.User(second)
                            ];
                    const history = [
                        new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, [
                            ...calls.map(
                                (call, index) =>
                                    new vscode.LanguageModelToolCallPart(call.localCallId, call.name, { index })
                            ),
                            marker
                        ]),
                        ...users
                    ];
                    const original = JSON.stringify(history);
                    const converted = convertMessagesToGemini(history, { ...identity, allowMedia });
                    const expected = calls.map((call, index) => ({
                        functionResponse: {
                            ...(call.upstreamCallId ? { id: call.upstreamCallId } : {}),
                            name: call.name,
                            response: { result: 'value-' + index },
                            ...(allowMedia ?
                                {
                                    parts: [
                                        {
                                            inlineData: {
                                                mimeType: 'image/png',
                                                data: Buffer.from(media[index].data).toString('base64')
                                            }
                                        }
                                    ]
                                }
                            :   {})
                        }
                    }));
                    assert.deepEqual(converted.contents, [
                        { role: 'model', parts: rawParts },
                        {
                            role: 'user',
                            parts: [
                                { text: 'before' },
                                expected[0],
                                ...(allowMedia ? [{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }] : []),
                                { text: 'between' },
                                expected[1],
                                ...(allowMedia ? [{ inlineData: { mimeType: 'image/png', data: 'Ag==' } }] : []),
                                { text: 'after' }
                            ]
                        }
                    ]);
                    assert.equal(JSON.stringify(history), original);
                });
            }
        }
    }

    for (const sameName of [false, true]) {
        for (const layout of ['mixed', 'split'] as const) {
            for (const fault of ['missing', 'duplicate', 'unknown'] as const) {
                test(`混合结果拒绝不完整或重复关联：${sameName}, ${layout}, ${fault}`, () => {
                    const assistant = vscode.LanguageModelChatMessage.Assistant(
                        [0, 1].map(
                            index =>
                                new vscode.LanguageModelToolCallPart(
                                    'local-' + index,
                                    sameName ? 'read' : 'tool-' + index,
                                    { index }
                                )
                        )
                    );
                    const first = new vscode.LanguageModelToolResultPart('local-0', [
                        new vscode.LanguageModelTextPart('zero')
                    ]);
                    const other = new vscode.LanguageModelToolResultPart(
                        fault === 'duplicate' ? 'local-0' : 'unknown',
                        [new vscode.LanguageModelTextPart('other')]
                    );
                    const note = new vscode.LanguageModelTextPart('continue');
                    const users =
                        layout === 'mixed' ?
                            [
                                vscode.LanguageModelChatMessage.User([
                                    first,
                                    note,
                                    ...(fault === 'missing' ? [] : [other])
                                ])
                            ]
                        :   [
                                vscode.LanguageModelChatMessage.User([first, note]),
                                ...(fault === 'missing' ? [] : [vscode.LanguageModelChatMessage.User([other])])
                            ];
                    const history = [assistant, ...users];
                    const original = JSON.stringify(history);
                    assert.throws(() => convertMessagesToGemini(history), /function response|工具结果/);
                    assert.equal(JSON.stringify(history), original);
                });
            }
        }
    }
});
