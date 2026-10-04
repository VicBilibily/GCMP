import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APIError } from 'openai';
import * as vscode from 'vscode';
import { CustomDataPartMimeTypes } from '../../../src/handlers/types';
import { InterInstanceBus } from '../../../src/interInstance';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceFailureReportedEvent,
    ApiKeyFailoverRequestedEvent
} from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { TokenUsagesManager } from '../../../src/usages/usagesManager';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    createContext,
    defaultRetry,
    identity,
    slot,
    successResponse,
    trackedCancellation
} from './retryFixture';

suite('request termination and coordination cancellation', () => {
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
    const originalGet = ConfigSetStore.getApiKey;
    const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
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
    let statuses: Parameters<typeof originalUpdate>[0]['status'][];
    let term: string;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-request-termination-')));
        context = createContext();
        cancellation = trackedCancellation();
        wireKeys = [];
        statuses = [];
        term = `request-termination:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'termination-instance'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => true,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => true,
            publish: () => {}
        });
        TokenUsagesManager.instance.updateActualTokens = update => {
            statuses.push(update.status);
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
        ConfigSetStore.getApiKey = originalGet;
        TokenUsagesManager.instance.updateActualTokens = originalUpdate;
    });

    function assertClean(grants: number, expected: number): void {
        assert.equal(wireKeys.length, expected);
        assert.equal(grants, expected);
        assert.equal(cancellation.disposals, cancellation.subscriptions);
        assert.equal(state.balanceLeaseRenewalTimers.size, 0);
        assert.equal(state.balanceAttemptSnapshots.size, 0);
        assert.equal(state.balanceLeases.size, 0);
        assert.equal(state.pendingBalanceFailures.size, 0);
        assert.equal(state.pendingLeaderDecisions.size, 0);
    }

    for (const transport of ['memory', 'http']) {
        for (const media of ['text/event-stream', 'absent', 'text/plain']) {
            for (const mode of ['off', 'balance', 'failover'] as const) {
                const endings =
                    transport === 'http' ?
                        ['empty', 'pending-tool', 'healthy-tool']
                    :   [
                            'empty',
                            'heartbeat',
                            'unterminated',
                            'partial-text',
                            'pending-tool',
                            'healthy-text',
                            'healthy-tool'
                        ];
                for (const ending of endings) {
                    test(`SSE termination: ${transport}, ${media}, ${mode}, ${ending}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const healthy = ending.startsWith('healthy-');
                        const tool = ending.endsWith('tool');
                        const payload = {
                            id: 'termination-test',
                            object: 'chat.completion.chunk',
                            created: 0,
                            model: 'retry-model',
                            choices: [
                                {
                                    index: 0,
                                    delta: {
                                        role: 'assistant',
                                        ...(tool ?
                                            {
                                                tool_calls: [
                                                    {
                                                        index: 0,
                                                        id: 'call-1',
                                                        type: 'function',
                                                        function: {
                                                            name: 'read_file',
                                                            arguments: '{"path":"report.txt"}'
                                                        }
                                                    }
                                                ]
                                            }
                                        :   { content: healthy ? 'complete' : 'partial' })
                                    },
                                    finish_reason:
                                        healthy ?
                                            tool ? 'tool_calls'
                                            :   'stop'
                                        :   null
                                }
                            ]
                        };
                        const recovered = await successResponse('openai').text();
                        const responseText = (key: string): string => {
                            assert.ok(['key-a', 'key-b'].includes(key));
                            wireKeys.push(key);
                            if (mode !== 'off' && key !== wireKeys[0]) {
                                return recovered;
                            }
                            return (
                                ending === 'empty' ? ''
                                : ending === 'heartbeat' ? ': heartbeat\n\n'
                                : ending === 'unterminated' ? 'data: {"error":{"message":"upstream rejected"}}\n'
                                : `data: ${JSON.stringify(payload)}\n\n`
                            );
                        };
                        let server: Server | undefined;
                        try {
                            if (transport === 'http') {
                                server = createServer((request, response) => {
                                    request.resume();
                                    const key = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
                                    response.writeHead(200, media === 'absent' ? {} : { 'content-type': media });
                                    response.end(responseText(key));
                                });
                                const listener = server;
                                await new Promise<void>((resolve, reject) => {
                                    listener.once('error', reject);
                                    listener.listen(0, '127.0.0.1', resolve);
                                });
                                const address = server.address();
                                assert.ok(address && typeof address === 'object');
                                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                                    const request = new Request(input, init);
                                    const response = await fetch(`http://127.0.0.1:${address.port}/chat/completions`, {
                                        method: request.method,
                                        headers: request.headers,
                                        body: await request.text(),
                                        signal: request.signal
                                    });
                                    assert.equal(
                                        response.headers.get('content-type'),
                                        media === 'absent' ? null : media
                                    );
                                    return response;
                                };
                            } else {
                                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                                    const request = new Request(input, init);
                                    const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
                                    return new Response(new TextEncoder().encode(responseText(key)), {
                                        headers: media === 'absent' ? {} : { 'content-type': media }
                                    });
                                };
                            }
                            const parts: vscode.LanguageModelResponsePart[] = [];
                            const observed = { grants: 0 };
                            let failure: unknown;
                            try {
                                await RetryProvider.run(
                                    'openai-sse',
                                    defaultRetry,
                                    observed,
                                    cancellation.token,
                                    parts
                                );
                            } catch (error) {
                                failure = error;
                            }
                            const text = parts
                                .filter(part => part instanceof vscode.LanguageModelTextPart)
                                .map(part => part.value);
                            const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            const shouldFail = !healthy && (mode === 'off' || ending === 'partial-text');
                            assertClean(observed.grants, healthy || shouldFail ? 1 : 4);
                            if (healthy) {
                                assert.equal(failure, undefined);
                                assert.deepEqual(statuses, ['completed']);
                                if (tool) {
                                    assert.deepEqual(
                                        tools.map(part => part.input),
                                        [{ path: 'report.txt' }]
                                    );
                                } else {
                                    assert.deepEqual(text, ['complete']);
                                }
                            } else {
                                assert.equal(tools.length, 0, 'unfinished stream must not dispatch buffered tools');
                                if (shouldFail) {
                                    assert.ok(
                                        failure instanceof Error,
                                        'unexpected EOF must not complete successfully'
                                    );
                                    assert.deepEqual(statuses, []);
                                    assert.deepEqual(text, ending === 'partial-text' ? ['partial'] : []);
                                } else {
                                    assert.equal(failure, undefined);
                                    assert.deepEqual(text, ['recovered']);
                                    assert.deepEqual(statuses, ['completed']);
                                    assert.deepEqual(wireKeys, [
                                        wireKeys[0],
                                        wireKeys[0],
                                        wireKeys[0],
                                        wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                                    ]);
                                }
                            }
                        } finally {
                            if (server) {
                                server.closeAllConnections();
                                const listener = server;
                                await new Promise<void>((resolve, reject) => {
                                    listener.close(error => (error ? reject(error) : resolve()));
                                });
                            }
                        }
                    });
                }
            }
        }
    }

    for (const sdkMode of ['openai-responses', 'anthropic'] as const) {
        for (const transport of ['memory', 'http']) {
            for (const mode of ['off', 'balance', 'failover'] as const) {
                for (const ending of [
                    'empty',
                    'heartbeat',
                    'created-only',
                    'pending-tool',
                    'healthy-empty',
                    'healthy-text',
                    'healthy-tool',
                    'compat-text',
                    'compat-tool',
                    'cancelled'
                ]) {
                    test(`cross-protocol termination: ${sdkMode}, ${transport}, ${mode}, ${ending}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const healthy = ending.startsWith('healthy-') || ending.startsWith('compat-');
                        const encode = <T extends { type: string }>(event: T): string =>
                            `${sdkMode === 'anthropic' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
                        const responseBody = (kind: string): string => {
                            const text = kind === 'recovered' ? 'recovered' : 'complete';
                            const tool = kind.endsWith('tool');
                            const pending = kind === 'pending-tool';
                            if (sdkMode === 'anthropic') {
                                const events = [
                                    encode({
                                        type: 'message_start',
                                        message: {
                                            id: 'msg-termination',
                                            type: 'message',
                                            role: 'assistant',
                                            model: 'retry-model',
                                            content: [],
                                            stop_reason: null,
                                            stop_sequence: null,
                                            usage: { input_tokens: 1, output_tokens: 0 }
                                        }
                                    })
                                ];
                                if (kind === 'created-only') {
                                    return events.join('');
                                }
                                if (kind !== 'healthy-empty') {
                                    if (tool) {
                                        events.push(
                                            encode({
                                                type: 'content_block_start',
                                                index: 0,
                                                content_block: {
                                                    type: 'tool_use',
                                                    id: 'call-termination',
                                                    name: 'read_file',
                                                    input: {}
                                                }
                                            }),
                                            encode({
                                                type: 'content_block_delta',
                                                index: 0,
                                                delta: {
                                                    type: 'input_json_delta',
                                                    partial_json: pending ? '{' : '{"path":"report.txt"}'
                                                }
                                            })
                                        );
                                    } else {
                                        events.push(
                                            encode({
                                                type: 'content_block_start',
                                                index: 0,
                                                content_block: { type: 'text', text: '' }
                                            }),
                                            encode({
                                                type: 'content_block_delta',
                                                index: 0,
                                                delta: { type: 'text_delta', text }
                                            })
                                        );
                                    }
                                    if (!pending) {
                                        events.push(encode({ type: 'content_block_stop', index: 0 }));
                                    }
                                }
                                if (!pending && !kind.startsWith('compat-')) {
                                    events.push(
                                        encode({
                                            type: 'message_delta',
                                            delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
                                            usage: { output_tokens: kind === 'healthy-empty' ? 0 : 1 }
                                        }),
                                        encode({ type: 'message_stop' })
                                    );
                                }
                                return events.join('');
                            }
                            const events = [
                                encode({
                                    type: 'response.created',
                                    sequence_number: 0,
                                    response: { id: 'resp-termination', status: 'in_progress', output: [] }
                                })
                            ];
                            if (kind === 'created-only') {
                                return events.join('');
                            }
                            const item = {
                                type: 'function_call',
                                id: 'item-termination',
                                call_id: 'call-termination',
                                name: 'read_file',
                                arguments: '{"path":"report.txt"}',
                                status: 'completed'
                            };
                            if (tool) {
                                events.push(
                                    encode({
                                        type: 'response.output_item.added',
                                        sequence_number: 1,
                                        output_index: 0,
                                        item: { ...item, arguments: '', status: 'in_progress' }
                                    })
                                );
                                if (pending) {
                                    events.push(
                                        encode({
                                            type: 'response.function_call_arguments.delta',
                                            sequence_number: 2,
                                            item_id: item.id,
                                            output_index: 0,
                                            delta: '{'
                                        })
                                    );
                                } else {
                                    events.push(
                                        encode({
                                            type: 'response.function_call_arguments.done',
                                            sequence_number: 2,
                                            item_id: item.id,
                                            output_index: 0,
                                            call_id: item.call_id,
                                            name: item.name,
                                            arguments: item.arguments
                                        })
                                    );
                                }
                                if (kind === 'healthy-tool') {
                                    events.push(
                                        encode({
                                            type: 'response.output_item.done',
                                            sequence_number: 3,
                                            output_index: 0,
                                            item
                                        })
                                    );
                                }
                            } else if (kind !== 'healthy-empty') {
                                events.push(
                                    encode({
                                        type: 'response.output_text.delta',
                                        sequence_number: 1,
                                        item_id: 'message-termination',
                                        output_index: 0,
                                        content_index: 0,
                                        delta: text
                                    })
                                );
                            }
                            if (!pending && !kind.startsWith('compat-')) {
                                events.push(
                                    encode({
                                        type: 'response.completed',
                                        sequence_number: 4,
                                        response: {
                                            id: 'resp-termination',
                                            status: 'completed',
                                            output: tool ? [item] : [],
                                            usage: { input_tokens: 1, output_tokens: kind === 'healthy-empty' ? 0 : 1 }
                                        }
                                    })
                                );
                            }
                            return events.join('');
                        };
                        const bodyFor = (key: string): string => {
                            assert.ok(['key-a', 'key-b'].includes(key));
                            wireKeys.push(key);
                            if (mode !== 'off' && key !== wireKeys[0]) {
                                return responseBody('recovered');
                            }
                            if (ending === 'empty' || ending === 'cancelled') {
                                return '';
                            }
                            if (ending === 'heartbeat') {
                                return sdkMode === 'anthropic' ? encode({ type: 'ping' }) : ': heartbeat\n\n';
                            }
                            return responseBody(ending);
                        };
                        let server: Server | undefined;
                        try {
                            let endpoint: string | undefined;
                            if (transport === 'http') {
                                server = createServer((request, response) => {
                                    request.resume();
                                    const apiKey = request.headers['x-api-key'];
                                    const key =
                                        request.headers.authorization?.replace(/^Bearer /, '') ??
                                        (typeof apiKey === 'string' ? apiKey : '');
                                    response.writeHead(200, { 'content-type': 'text/event-stream' });
                                    response.end(bodyFor(key));
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
                                    '';
                                const response =
                                    endpoint ?
                                        await fetch(endpoint + new URL(request.url).pathname, {
                                            method: request.method,
                                            headers: request.headers,
                                            body: await request.text(),
                                            signal: request.signal
                                        })
                                    :   new Response(new TextEncoder().encode(bodyFor(key)), {
                                            headers: { 'content-type': 'text/event-stream' }
                                        });
                                if (ending === 'cancelled') {
                                    cancellation.cancel();
                                }
                                return response;
                            };
                            const parts: vscode.LanguageModelResponsePart[] = [];
                            const observed = { grants: 0 };
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
                            const text = parts
                                .filter(part => part instanceof vscode.LanguageModelTextPart)
                                .map(part => part.value);
                            const tools = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            assertClean(observed.grants, healthy || mode === 'off' || ending === 'cancelled' ? 1 : 4);
                            if (ending === 'cancelled') {
                                assert.ok(failure instanceof vscode.CancellationError);
                                assert.deepEqual(statuses, ['cancelled']);
                                assert.deepEqual(text, []);
                                assert.deepEqual(tools, []);
                            } else if (healthy) {
                                assert.equal(failure, undefined);
                                assert.deepEqual(statuses, ['completed']);
                                assert.deepEqual(text, ending.endsWith('text') ? ['complete'] : []);
                                assert.deepEqual(
                                    tools.map(part => part.input),
                                    ending.endsWith('tool') ? [{ path: 'report.txt' }] : []
                                );
                            } else if (mode === 'off') {
                                assert.ok(failure instanceof Error, 'EOF without output or a terminal event must fail');
                                assert.deepEqual(statuses, []);
                                assert.deepEqual(text, []);
                                assert.deepEqual(tools, []);
                            } else {
                                assert.equal(failure, undefined);
                                assert.deepEqual(statuses, ['completed']);
                                assert.deepEqual(text, ['recovered']);
                                assert.deepEqual(tools, []);
                                assert.deepEqual(wireKeys, [
                                    wireKeys[0],
                                    wireKeys[0],
                                    wireKeys[0],
                                    wireKeys[0] === 'key-a' ? 'key-b' : 'key-a'
                                ]);
                            }
                        } finally {
                            if (server) {
                                server.closeAllConnections();
                                const listener = server;
                                await new Promise<void>((resolve, reject) => {
                                    listener.close(error => (error ? reject(error) : resolve()));
                                });
                            }
                        }
                    });
                }
            }
        }
    }

    for (const transport of ['memory', 'http']) {
        for (const mode of ['off', 'balance', 'failover'] as const) {
            for (const ending of ['terminal', 'eof']) {
                for (const cancelAt of ['none', 'tool', 'marker']) {
                    test(`Responses finalization: ${transport}, ${mode}, ${ending}, ${cancelAt}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        const encode = <T extends { type: string }>(event: T): string =>
                            `data: ${JSON.stringify(event)}\n\n`;
                        const items = [0, 1].map(index => ({
                            type: 'function_call',
                            id: `item-${index}`,
                            call_id: `call-${index}`,
                            name: 'read_file',
                            arguments: JSON.stringify({ path: `report-${index}.txt` }),
                            status: 'completed'
                        }));
                        let body = encode({
                            type: 'response.created',
                            sequence_number: 0,
                            response: { id: 'resp-finalization', status: 'in_progress', output: [] }
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
                                item_id: item.id,
                                call_id: item.call_id,
                                output_index: index,
                                name: item.name,
                                arguments: item.arguments
                            });
                        }
                        if (ending === 'terminal') {
                            body += encode({
                                type: 'response.completed',
                                sequence_number: 5,
                                response: {
                                    id: 'resp-finalization',
                                    status: 'completed',
                                    output: items,
                                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
                                }
                            });
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
                                const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
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
                            parts.push = (...incoming) => {
                                const length = append(...incoming);
                                if (
                                    incoming.some(
                                        part =>
                                            (cancelAt === 'tool' && part instanceof vscode.LanguageModelToolCallPart) ||
                                            (cancelAt === 'marker' &&
                                                part instanceof vscode.LanguageModelDataPart &&
                                                part.mimeType === CustomDataPartMimeTypes.StatefulMarker)
                                    )
                                ) {
                                    cancellation.cancel();
                                }
                                return length;
                            };
                            const observed = { grants: 0 };
                            let failure: unknown;
                            try {
                                await RetryProvider.run(
                                    'openai-responses',
                                    defaultRetry,
                                    observed,
                                    cancellation.token,
                                    parts,
                                    randomUUID()
                                );
                            } catch (error) {
                                failure = error;
                            }
                            const calls = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            assertClean(observed.grants, 1);
                            assert.equal(cancellation.token.isCancellationRequested, cancelAt !== 'none');
                            assert.deepEqual(
                                calls.map(part => part.callId),
                                cancelAt === 'tool' ? ['call-0'] : ['call-0', 'call-1']
                            );
                            assert.deepEqual(
                                calls.map(part => part.input),
                                cancelAt === 'tool' ?
                                    [{ path: 'report-0.txt' }]
                                :   [{ path: 'report-0.txt' }, { path: 'report-1.txt' }]
                            );
                            assert.deepEqual(statuses, [cancelAt === 'none' ? 'completed' : 'cancelled']);
                            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                            if (cancelAt === 'none') {
                                assert.equal(failure, undefined);
                            } else {
                                assert.ok(failure instanceof vscode.CancellationError);
                            }
                        } finally {
                            if (server) {
                                server.closeAllConnections();
                                const listener = server;
                                await new Promise<void>((resolve, reject) => {
                                    listener.close(error => (error ? reject(error) : resolve()));
                                });
                            }
                        }
                    });
                }
            }
        }
    }

    for (const sdkMode of ['openai-sse', 'openai', 'openai-responses'] as const) {
        for (const failedRequest of [1, 3]) {
            for (const cancelled of [false, true]) {
                test(`failure coordination rejection: ${sdkMode}, ${failedRequest}, cancelled=${cancelled}`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, 'failover');
                    const storageError = new Error('coordination secret storage unavailable');
                    ConfigSetStore.getApiKey = async (...args) => {
                        if (wireKeys.length === failedRequest) {
                            if (cancelled) {
                                cancellation.cancel();
                            }
                            throw storageError;
                        }
                        return originalGet.apply(ConfigSetStore, args);
                    };
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        const request = new Request(input, init);
                        wireKeys.push(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
                        return new Response(
                            'data: {"error":{"message":"upstream rejected","code":"rate_limit_exceeded"}}\n\n',
                            { headers: { 'content-type': 'text/event-stream' } }
                        );
                    };
                    const observed = { grants: 0 };
                    await assert.rejects(
                        RetryProvider.run(sdkMode, defaultRetry, observed, cancellation.token),
                        error => {
                            if (cancelled) {
                                assert.ok(error instanceof vscode.CancellationError);
                            } else {
                                assert.equal(error, storageError);
                            }
                            return true;
                        }
                    );
                    assertClean(observed.grants, failedRequest);
                    assert.deepEqual(statuses, []);
                    assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                });
            }
        }
    }

    for (const role of ['leader', 'follower']) {
        for (const mode of ['balance', 'failover'] as const) {
            for (const sdkMode of ['openai-sse', 'openai', 'openai-responses'] as const) {
                for (const cancelAt of ['none', 'before-response', 'coordination', 'threshold']) {
                    if (role === 'follower' && cancelAt === 'threshold') {
                        continue;
                    }
                    test(`failure coordination cancellation: ${role}, ${mode}, ${sdkMode}, ${cancelAt}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        let coordinationPoints = 0;
                        const atCoordination = () => {
                            coordinationPoints++;
                            if (cancelAt === 'coordination' || cancelAt === 'threshold') {
                                cancellation.cancel();
                            }
                        };
                        if (role === 'follower') {
                            LeaderElectionService.isLeader = () => false;
                            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
                            InterInstanceBus.publishIpcOnly = event => {
                                if (event.type === 'apiKeyBalanceAssignmentRequested') {
                                    const payload = event.payload as ApiKeyBalanceAssignmentRequestedEvent['payload'];
                                    ApiKeyFailoverManager.resolveBalanceAssignment({
                                        requestId: payload.requestId,
                                        targetInstanceId: LeaderElectionService.getInstanceId(),
                                        authorityTerm: term,
                                        handled: true,
                                        configId: 'a',
                                        credentialId: identity('key-a'),
                                        leaseId: `termination-${payload.requestId}`,
                                        expiresAt: Date.now() + 30_000
                                    });
                                } else if (event.type === 'apiKeyBalanceFailureReported') {
                                    const payload = event.payload as ApiKeyBalanceFailureReportedEvent['payload'];
                                    atCoordination();
                                    if (cancelAt !== 'coordination') {
                                        ApiKeyFailoverManager.resolveBalanceFailure({
                                            requestId: payload.requestId,
                                            targetInstanceId: LeaderElectionService.getInstanceId(),
                                            authorityTerm: term,
                                            handled: true,
                                            shouldRetry: false,
                                            switched: false
                                        });
                                    }
                                }
                                return true;
                            };
                            InterInstanceBus.publish = event => {
                                if (event.type === 'apiKeyFailoverRequested') {
                                    const payload = event.payload as ApiKeyFailoverRequestedEvent['payload'];
                                    atCoordination();
                                    if (cancelAt !== 'coordination') {
                                        ApiKeyFailoverManager.resolveLeaderDecision(payload.requestId, {
                                            handled: true,
                                            shouldRetry: false,
                                            switched: false
                                        });
                                    }
                                }
                            };
                        } else {
                            ConfigSetStore.getApiKey = async (...args) => {
                                const key = await originalGet.apply(ConfigSetStore, args);
                                if (mode === 'failover' && wireKeys.length === (cancelAt === 'threshold' ? 3 : 1)) {
                                    atCoordination();
                                }
                                return key;
                            };
                            const update = context.globalState.update;
                            context.globalState.update = async (key, value) => {
                                if (mode === 'balance' && wireKeys.length === 3) {
                                    atCoordination();
                                }
                                return update.call(context.globalState, key, value);
                            };
                        }
                        ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                            const request = new Request(input, init);
                            const key = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
                            wireKeys.push(key);
                            if (cancelAt === 'before-response') {
                                cancellation.cancel();
                            }
                            return role === 'leader' && key !== wireKeys[0] ?
                                    successResponse(sdkMode === 'openai-responses' ? 'openai-responses' : 'openai')
                                :   new Response(
                                        'data: {"error":{"message":"upstream rejected","code":"rate_limit_exceeded"}}\n\n',
                                        { headers: { 'content-type': 'text/event-stream' } }
                                    );
                        };
                        const observed = { grants: 0 };
                        let failure: unknown;
                        try {
                            await RetryProvider.run(sdkMode, defaultRetry, observed, cancellation.token);
                        } catch (error) {
                            failure = error;
                        }
                        const expectedWires =
                            cancelAt === 'before-response' ? 1
                            : role === 'leader' && cancelAt === 'none' ? 4
                            : cancelAt === 'threshold' || mode === 'balance' ? 3
                            : 1;
                        assertClean(observed.grants, expectedWires);
                        assert.equal(coordinationPoints > 0, cancelAt !== 'before-response');
                        if (role === 'leader' && mode === 'balance' && cancelAt !== 'before-response') {
                            assert.equal(
                                ConfigSetStore.getBalanceExclusions(slot)[0]?.credentialId,
                                identity(wireKeys[0])
                            );
                        }
                        if (role === 'leader' && mode === 'failover') {
                            assert.equal(
                                await ApiKeyManager.getApiKey(slot),
                                cancelAt === 'none' || cancelAt === 'threshold' ? 'key-b' : 'key-a'
                            );
                        }
                        if (cancelAt !== 'none') {
                            assert.ok(failure instanceof vscode.CancellationError);
                            assert.ok(!statuses.includes('completed'));
                        } else if (role === 'leader') {
                            assert.equal(failure, undefined);
                        } else {
                            assert.ok(failure instanceof APIError);
                        }
                    });
                }
            }
        }
    }
});
