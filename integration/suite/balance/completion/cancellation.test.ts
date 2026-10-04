import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { GeminiHandler } from '../../../../src/handlers/gemini/geminiHandler';
import type { GeminiContent, GeminiPart } from '../../../../src/handlers/gemini/geminiType';
import { decodeStatefulMarker } from '../../../../src/handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../../../src/handlers/types';
import { InterInstanceBus } from '../../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import type { GenericModelProvider } from '../../../../src/providers/genericModelProvider';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { TokenUsagesManager, type UpdateActualTokensParams } from '../../../../src/usages/usagesManager';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
import type { CopilotUsageData } from '../../../../src/utils/model/copilotUsage';
import { RetryProvider, createContext, defaultRetry, slot, trackedCancellation } from '../retryFixture';

suite('completion callback cancellation', () => {
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
    let term: string;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-completion-cancellation-')));
        context = createContext();
        cancellation = trackedCancellation();
        wireKeys = [];
        updates = [];
        releases = [];
        failureReports = 0;
        term = `completion:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'completion-instance'
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

    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        for (const transport of ['memory', 'http'] as const) {
            for (const mode of ['off', 'balance', 'failover'] as const) {
                for (const cancelAt of ['none', 'tool', 'marker', 'usage'] as const) {
                    test(`收尾回调取消：${sdkMode}, ${transport}, ${mode}, ${cancelAt}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const encode = <T extends object>(event: T, type?: string): string =>
                            `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
                        const items = [0, 1].map(index => ({
                            id: `item-${index}`,
                            call_id: `call-${index}`,
                            type: 'function_call',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: `file-${index}.txt` }),
                            status: 'completed'
                        }));
                        let body: string;
                        if (sdkMode === 'openai-responses') {
                            body = encode({
                                type: 'response.created',
                                sequence_number: 0,
                                response: { id: 'response-completion', status: 'in_progress', output: [] }
                            });
                            for (const [index, item] of items.entries()) {
                                body += encode({
                                    type: 'response.output_item.added',
                                    sequence_number: index * 2 + 1,
                                    output_index: index,
                                    item: { ...item, arguments: '', status: 'in_progress' }
                                });
                                body += encode({
                                    type: 'response.function_call_arguments.done',
                                    sequence_number: index * 2 + 2,
                                    output_index: index,
                                    item_id: item.id,
                                    call_id: item.call_id,
                                    name: item.name,
                                    arguments: item.arguments
                                });
                            }
                            body += encode({
                                type: 'response.completed',
                                sequence_number: 5,
                                response: {
                                    id: 'response-completion',
                                    status: 'completed',
                                    output: items,
                                    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
                                }
                            });
                        } else if (sdkMode === 'anthropic') {
                            body = encode(
                                {
                                    type: 'message_start',
                                    message: {
                                        id: 'message-completion',
                                        type: 'message',
                                        role: 'assistant',
                                        model: 'retry-model',
                                        content: [],
                                        stop_reason: null,
                                        stop_sequence: null,
                                        usage: { input_tokens: 2, output_tokens: 0 }
                                    }
                                },
                                'message_start'
                            );
                            for (const [index, item] of items.entries()) {
                                body += encode(
                                    {
                                        type: 'content_block_start',
                                        index,
                                        content_block: {
                                            type: 'tool_use',
                                            id: item.call_id,
                                            name: item.name,
                                            input: {}
                                        }
                                    },
                                    'content_block_start'
                                );
                                body += encode(
                                    {
                                        type: 'content_block_delta',
                                        index,
                                        delta: { type: 'input_json_delta', partial_json: item.arguments }
                                    },
                                    'content_block_delta'
                                );
                                body += encode({ type: 'content_block_stop', index }, 'content_block_stop');
                            }
                            body += encode(
                                {
                                    type: 'message_delta',
                                    delta: { stop_reason: 'tool_use', stop_sequence: null },
                                    usage: { output_tokens: 2 }
                                },
                                'message_delta'
                            );
                            body += encode({ type: 'message_stop' }, 'message_stop');
                        } else if (sdkMode === 'gemini-sse') {
                            body = encode({
                                responseId: 'gemini-completion',
                                candidates: [
                                    {
                                        index: 0,
                                        content: {
                                            role: 'model',
                                            parts: items.map((item, index) => ({
                                                functionCall: {
                                                    id: item.call_id,
                                                    name: item.name,
                                                    args: { path: `file-${index}.txt` }
                                                }
                                            }))
                                        },
                                        finishReason: 'STOP'
                                    }
                                ],
                                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 }
                            });
                        } else {
                            const chunk = {
                                id: 'chat-completion',
                                object: 'chat.completion.chunk',
                                created: 0,
                                model: 'retry-model'
                            };
                            body = encode({
                                ...chunk,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            role: 'assistant',
                                            tool_calls: items.map((item, index) => ({
                                                index,
                                                id: item.call_id,
                                                type: 'function',
                                                function: { name: item.name, arguments: item.arguments }
                                            }))
                                        },
                                        finish_reason: null
                                    }
                                ]
                            });
                            body += encode({
                                ...chunk,
                                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                                usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
                            });
                            body += 'data: [DONE]\n\n';
                        }
                        let server: Server | undefined;
                        try {
                            let endpoint: string | undefined;
                            if (transport === 'http') {
                                server = createServer((request, response) => {
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
                                const key =
                                    request.headers.get('authorization')?.replace(/^Bearer /, '') ??
                                    request.headers.get('x-api-key') ??
                                    request.headers.get('x-goog-api-key') ??
                                    '';
                                assert.ok(['key-a', 'key-b'].includes(key));
                                wireKeys.push(key);
                                return endpoint ?
                                        fetch(endpoint + new URL(request.url).pathname, {
                                            method: request.method,
                                            headers: request.headers,
                                            body: await request.text(),
                                            signal: request.signal
                                        })
                                    :   new Response(new TextEncoder().encode(body), {
                                            headers: { 'content-type': 'text/event-stream' }
                                        });
                            };
                            const parts: vscode.LanguageModelResponsePart[] = [];
                            const append = parts.push.bind(parts);
                            let triggered = false;
                            let lateTools = 0;
                            parts.push = (...incoming) => {
                                for (const part of incoming) {
                                    const kind =
                                        part instanceof vscode.LanguageModelToolCallPart ? 'tool'
                                        : (
                                            part instanceof vscode.LanguageModelDataPart &&
                                            part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                                        ) ?
                                            'marker'
                                        : (
                                            part instanceof vscode.LanguageModelDataPart &&
                                            part.mimeType === CustomDataPartMimeTypes.Usage
                                        ) ?
                                            'usage'
                                        :   'other';
                                    if (kind === 'tool' && cancellation.token.isCancellationRequested) {
                                        lateTools++;
                                    }
                                    append(part);
                                    if (!triggered && kind === cancelAt) {
                                        triggered = true;
                                        cancellation.cancel();
                                    }
                                }
                                return parts.length;
                            };
                            const handle: RateLimitHandle = {
                                grantId: randomUUID(),
                                costs: { requests: 1, tokens: 4 },
                                leaseMs: 30000,
                                authoritative: false
                            };
                            const observed = { grants: 0, handle };
                            let failure: unknown;
                            try {
                                await RetryProvider.run(
                                    sdkMode,
                                    defaultRetry,
                                    observed,
                                    cancellation.token,
                                    parts,
                                    randomUUID()
                                );
                            } catch (error) {
                                failure = error;
                            }
                            assert.equal(wireKeys.length, 1);
                            assert.equal(observed.grants, 1);
                            assert.equal(cancellation.disposals, cancellation.subscriptions);
                            for (const collection of [
                                state.balanceLeaseRenewalTimers,
                                state.balanceAttemptSnapshots,
                                state.balanceLeases,
                                state.pendingBalanceFailures,
                                state.pendingLeaderDecisions
                            ]) {
                                assert.equal(collection.size, 0);
                            }
                            assert.equal(failureReports, 0);
                            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                            assert.equal(triggered, cancelAt !== 'none');
                            if (cancelAt === 'none') {
                                assert.equal(failure, undefined);
                            } else {
                                assert.ok(failure instanceof vscode.CancellationError);
                            }
                            assert.deepEqual(
                                updates.map(update => update.status),
                                [cancelAt === 'none' ? 'completed' : 'cancelled']
                            );
                            assert.equal(lateTools, 0);
                            assert.deepEqual(
                                releases,
                                cancelAt === 'none' ? [[handle]] : [[handle, { tokens: handle.costs.tokens }]]
                            );
                            const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            assert.deepEqual(
                                tools.map(part => ({ name: part.name, input: part.input })),
                                (cancelAt === 'tool' ? [0] : [0, 1]).map(index => ({
                                    name: 'read_file',
                                    input: { path: `file-${index}.txt` }
                                }))
                            );
                            assert.equal(new Set(tools.map(part => part.callId)).size, tools.length);
                            if (sdkMode === 'gemini-sse' || cancelAt === 'none' || cancelAt === 'usage') {
                                const usageParts = parts.filter(
                                    (part): part is vscode.LanguageModelDataPart =>
                                        part instanceof vscode.LanguageModelDataPart &&
                                        part.mimeType === CustomDataPartMimeTypes.Usage
                                );
                                assert.equal(usageParts.length, 1);
                                const usage = JSON.parse(
                                    new TextDecoder().decode(usageParts[0].data)
                                ) as CopilotUsageData;
                                assert.equal(usage.prompt_tokens, 2);
                                assert.equal(usage.completion_tokens, 2);
                                assert.equal(usage.total_tokens, 4);
                                assert.ok(updates[0].rawUsage);
                            }
                            if (sdkMode === 'gemini-sse') {
                                assert.deepEqual(updates[0].rawUsage, {
                                    promptTokenCount: 2,
                                    candidatesTokenCount: 2,
                                    totalTokenCount: 4
                                });
                            }
                        } finally {
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

    for (const wireIds of [true, false]) {
        for (const transport of ['memory', 'http'] as const) {
            for (const mode of ['off', 'balance', 'failover'] as const) {
                for (const cancelAt of [
                    'none',
                    'signature',
                    'tool',
                    'last-tool',
                    'trailing-signature',
                    'marker',
                    'usage'
                ] as const) {
                    test(`Gemini 取消后的历史回放：${wireIds}, ${transport}, ${mode}, ${cancelAt}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
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
                        const payload = (parts: GeminiPart[]): string =>
                            `data: ${JSON.stringify({
                                candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
                                usageMetadata: rawUsage
                            })}\n\n`;
                        let responseBody = payload(originalParts);
                        const requests: Array<{ contents: GeminiContent[] }> = [];
                        const nextSource = trackedCancellation();
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
                            const parts: vscode.LanguageModelResponsePart[] = [];
                            const append = parts.push.bind(parts);
                            let triggered = false;
                            let lateTools = 0;
                            let signatureCount = 0;
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
                                        : part instanceof vscode.LanguageModelThinkingPart ?
                                            ++signatureCount === 1 ?
                                                'signature'
                                            :   'trailing-signature'
                                        : (
                                            part instanceof vscode.LanguageModelDataPart &&
                                            part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                                        ) ?
                                            'marker'
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
                            const handle: RateLimitHandle = {
                                grantId: randomUUID(),
                                costs: { requests: 1, tokens: 4 },
                                leaseMs: 30000,
                                authoritative: false
                            };
                            const observed = { grants: 0, handle };
                            const initialRequest = RetryProvider.run(
                                'gemini-sse',
                                defaultRetry,
                                observed,
                                cancellation.token,
                                parts,
                                randomUUID()
                            );
                            if (cancelAt === 'none') {
                                await initialRequest;
                            } else {
                                await assert.rejects(initialRequest, vscode.CancellationError);
                            }
                            assert.equal(triggered, cancelAt !== 'none');
                            assert.equal(lateTools, 0);
                            assert.equal(observed.grants, 1);
                            assert.equal(cancellation.disposals, cancellation.subscriptions);
                            const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            const deliveredIndices =
                                cancelAt === 'signature' ? []
                                : cancelAt === 'tool' ? [0]
                                : [0, 1];
                            assert.deepEqual(
                                tools.map(tool => tool.input),
                                deliveredIndices.map(index => ({ index }))
                            );
                            assert.equal(new Set(tools.map(tool => tool.callId)).size, tools.length);
                            assert.ok(
                                parts.some(
                                    part => part instanceof vscode.LanguageModelTextPart && part.value === 'preface'
                                )
                            );
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
                            const usageParts = parts.filter(
                                (part): part is vscode.LanguageModelDataPart =>
                                    part instanceof vscode.LanguageModelDataPart &&
                                    part.mimeType === CustomDataPartMimeTypes.Usage
                            );
                            assert.equal(usageParts.length, 1);
                            assert.equal(
                                (JSON.parse(new TextDecoder().decode(usageParts[0].data)) as CopilotUsageData)
                                    .total_tokens,
                                4
                            );
                            const history = [
                                vscode.LanguageModelChatMessage.User('earlier question'),
                                vscode.LanguageModelChatMessage.Assistant('earlier answer'),
                                vscode.LanguageModelChatMessage.User('read both files'),
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
                            const nextHandle: RateLimitHandle = { ...handle, grantId: randomUUID() };
                            const nextObserved = { grants: 0, handle: nextHandle };
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
                            assert.equal(nextSource.subscriptions, nextSource.disposals);
                            assert.equal(requests.length, 2);
                            assert.equal(wireKeys.length, 2);
                            assert.ok(wireKeys.every(key => ['key-a', 'key-b'].includes(key)));
                            assert.equal(failureReports, 0);
                            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                            assert.deepEqual(
                                updates.map(update => update.status),
                                [cancelAt === 'none' ? 'completed' : 'cancelled', 'completed']
                            );
                            for (const update of updates) {
                                assert.deepEqual(update.rawUsage, rawUsage);
                                assert.ok(update.streamStartTime);
                                assert.ok(update.streamEndTime);
                            }
                            assert.deepEqual(releases, [
                                cancelAt === 'none' ? [handle] : [handle, { tokens: handle.costs.tokens }],
                                [nextHandle]
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
                            const historyParts = requests[1].contents.flatMap(content => content.parts);
                            assert.ok(historyParts.some(part => part.text === 'earlier answer'));
                            assert.ok(historyParts.some(part => part.text === 'continue'));
                            const replayCalls = historyParts.flatMap(part =>
                                part.functionCall ? [part.functionCall] : []
                            );
                            const replayResults = historyParts.flatMap(part =>
                                part.functionResponse ? [part.functionResponse] : []
                            );
                            if (['signature', 'tool', 'last-tool'].includes(cancelAt)) {
                                assert.equal(marker.geminiRequestIdentity, undefined);
                                assert.equal(marker.geminiContents, undefined);
                                assert.equal(marker.geminiToolCalls, undefined);
                                assert.deepEqual(replayCalls, []);
                                assert.deepEqual(replayResults, []);
                                assert.ok(
                                    historyParts.every(part => !part.thoughtSignature && !part.thought_signature)
                                );
                            } else {
                                assert.ok(marker.geminiRequestIdentity);
                                assert.deepEqual(marker.geminiContents, [{ role: 'model', parts: originalParts }]);
                                assert.deepEqual(
                                    marker.geminiToolCalls,
                                    tools.map((tool, index) => ({
                                        localCallId: tool.callId,
                                        ...(wireIds ? { upstreamCallId: `call-${index}` } : {}),
                                        name: 'read_file'
                                    }))
                                );
                                assert.deepEqual(
                                    requests[1].contents.filter(content => content.role === 'model').at(-1)?.parts,
                                    originalParts
                                );
                                assert.deepEqual(
                                    replayCalls.map(call => call.id),
                                    wireIds ? ['call-0', 'call-1'] : [undefined, undefined]
                                );
                                assert.deepEqual(
                                    replayResults.map(result => result.id),
                                    wireIds ? ['call-0', 'call-1'] : [undefined, undefined]
                                );
                                assert.deepEqual(
                                    replayResults.map(result => result.response),
                                    [{ result: 'result-0' }, { result: 'result-1' }]
                                );
                            }
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

    for (const cancelAt of ['none', 'tool', 'marker', 'usage'] as const) {
        test(`Gemini 直接收尾保留用量且只记一次终态：${cancelAt}`, async () => {
            const rawUsage = { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 };
            ConfigManager.createProxyAwareFetch = () => async () =>
                new Response(
                    `data: ${JSON.stringify({
                        candidates: [
                            {
                                content: {
                                    parts: [0, 1].map(index => ({
                                        functionCall: { id: `call-${index}`, name: 'read_file', args: { index } }
                                    }))
                                },
                                finishReason: 'STOP'
                            }
                        ],
                        usageMetadata: rawUsage
                    })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } }
                );
            const handler = new GeminiHandler({
                provider: slot,
                providerConfig: { displayName: 'Completion Test' }
            } as unknown as GenericModelProvider);
            const parts: vscode.LanguageModelResponsePart2[] = [];
            let triggered = false;
            let lateTools = 0;
            const request = handler.handleRequest(
                {
                    id: 'gemini-completion',
                    name: 'Gemini Completion',
                    maxOutputTokens: 1024
                } as vscode.LanguageModelChatInformation,
                {
                    id: 'gemini-completion',
                    name: 'Gemini Completion',
                    baseUrl: 'https://gateway.test/gemini',
                    tooltip: 'Gemini Completion',
                    maxInputTokens: 1024,
                    maxOutputTokens: 1024,
                    capabilities: { toolCalling: true, imageInput: false }
                },
                [],
                { toolMode: vscode.LanguageModelChatToolMode.Auto, requestInitiator: 'completion-test' },
                {
                    report(part) {
                        const kind =
                            part instanceof vscode.LanguageModelToolCallPart ? 'tool'
                            : (
                                part instanceof vscode.LanguageModelDataPart &&
                                part.mimeType === CustomDataPartMimeTypes.StatefulMarker
                            ) ?
                                'marker'
                            : (
                                part instanceof vscode.LanguageModelDataPart &&
                                part.mimeType === CustomDataPartMimeTypes.Usage
                            ) ?
                                'usage'
                            :   'other';
                        if (kind === 'tool' && cancellation.token.isCancellationRequested) {
                            lateTools++;
                        }
                        parts.push(part);
                        if (!triggered && kind === cancelAt) {
                            triggered = true;
                            cancellation.cancel();
                        }
                    }
                },
                randomUUID(),
                'completion-session',
                cancellation.token
            );
            if (cancelAt === 'none') {
                await request;
            } else {
                await assert.rejects(request, vscode.CancellationError);
            }
            assert.equal(triggered, cancelAt !== 'none');
            assert.equal(lateTools, 0);
            assert.equal(cancellation.subscriptions, cancellation.disposals);
            assert.deepEqual(
                updates.map(update => update.status),
                [cancelAt === 'none' ? 'completed' : 'cancelled']
            );
            assert.deepEqual(updates[0].rawUsage, rawUsage);
            assert.ok(updates[0].streamStartTime);
            assert.ok(updates[0].streamEndTime);
            assert.deepEqual(
                parts.filter(part => part instanceof vscode.LanguageModelToolCallPart).map(part => part.input),
                (cancelAt === 'tool' ? [0] : [0, 1]).map(index => ({ index }))
            );
            const usageParts = parts.filter(
                (part): part is vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.Usage
            );
            assert.equal(usageParts.length, 1);
            const usage = JSON.parse(new TextDecoder().decode(usageParts[0].data)) as CopilotUsageData;
            assert.equal(usage.prompt_tokens, 7);
            assert.equal(usage.completion_tokens, 3);
            assert.equal(usage.total_tokens, 10);
        });
    }
});
