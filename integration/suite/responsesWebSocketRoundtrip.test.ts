import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { Agent } from 'undici';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { ResponsesConnectionPool } from '../../src/handlers/openai/transport/responsesConnectionPool';
import type { ResponsesSocket } from '../../src/handlers/openai/transport/responsesWebSocketTransport';
import type { ResponsesWebSocketServices } from '../../src/handlers/openai/openaiResponsesHandler';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { createContext, trackedCancellation } from './balance/retryFixture';
import { SDK_MAIN } from '../../src/handlers/classification/testFixtures/sdkPurposeSamples';
import { startResponsesMockProcess } from '../fixtures/responsesWebSocketMockProcess';
import type { MockExpectedContext } from '../fixtures/responsesWebSocketMockProcess';
import { createLiveResponsesFixture } from '../fixtures/responsesWebSocketLiveFixture';
import { ResponsesTransportFailure } from '../../src/handlers/openai/transport/responsesWebSocketTransport';
import { onLiveMetrics } from '../../src/handlers/liveMetrics';
import type { LiveStreamMetricEvent } from '../../src/handlers/liveMetrics';

const slot = 'responses-ws-roundtrip';
const modelConfig: ModelConfig = {
    id: 'roundtrip-model',
    name: 'Roundtrip',
    tooltip: 'Roundtrip',
    provider: slot,
    baseUrl: 'https://responses-roundtrip.invalid/v1',
    sdkMode: 'openai-responses',
    useInstructions: true,
    useWebSocket: true,
    extraBody: { store: false },
    maxInputTokens: 8192,
    maxOutputTokens: 1024,
    capabilities: { toolCalling: true, imageInput: false }
};
const system = SDK_MAIN;
const user = (text: string): MockExpectedContext['input'][number] => ({
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }]
});
const assistant = (text: string): MockExpectedContext['input'][number] => ({
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }]
});
const toolCall = {
    type: 'function_call',
    call_id: 'call_a',
    name: 'lookup',
    arguments: '{"id":1}',
    status: 'completed'
};
const toolResult = { type: 'function_call_output', call_id: 'call_a', output: 'tool answer', status: 'completed' };

class ScriptedSocket implements ResponsesSocket {
    opened = Promise.resolve();
    reusable = true;
    private resolveClosed!: () => void;
    closed = new Promise<void>(resolve => {
        this.resolveClosed = resolve;
    });
    private readonly messages = new Set<(value: unknown) => void>();
    private readonly disconnects = new Set<() => void>();
    readonly frames: Array<Record<string, unknown>> = [];
    readonly contexts: unknown[][] = [];
    private readonly predecessors = new Map<string, unknown[]>();

    onMessage(listener: (value: unknown) => void) {
        this.messages.add(listener);
        return () => {
            this.messages.delete(listener);
        };
    }
    onDisconnect(listener: () => void) {
        this.disconnects.add(listener);
        return () => {
            this.disconnects.delete(listener);
        };
    }
    send(text: string) {
        const frame: unknown = JSON.parse(text);
        assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame));
        const parameters = frame as Record<string, unknown>;
        assert.equal(parameters.type, 'response.create');
        assert.equal(parameters.stream, undefined);
        assert.equal(parameters.useWebSocket, undefined);
        assert.equal(parameters.store, false);
        assert.ok(Array.isArray(parameters.input));
        this.frames.push(parameters);
        let context: unknown[];
        if (typeof parameters.previous_response_id === 'string') {
            const previous = this.predecessors.get(parameters.previous_response_id);
            assert.ok(previous, 'predecessor must belong to this socket');
            context = [...previous, ...parameters.input];
        } else {
            context = [...parameters.input];
        }
        this.contexts.push(context);
        const index = this.frames.length;
        const output = index === 1 ? [{ ...toolCall, id: 'server-call' }] : [assistant(`reply-${index}`)];
        const replay = index === 1 ? [toolCall] : [assistant(`reply-${index}`)];
        const responseId = `r${index}`;
        this.predecessors.set(responseId, [...context, ...replay]);
        queueMicrotask(() => {
            this.emit({ type: 'response.created', response: { id: responseId } });
            if (index !== 1) {
                this.emit({
                    type: 'response.output_text.delta',
                    item_id: `message-${index}`,
                    content_index: 0,
                    output_index: 0,
                    delta: `reply-${index}`
                });
            }
            this.emit({
                type: 'response.completed',
                response: { id: responseId, output, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
            });
        });
    }
    private emit(value: unknown) {
        for (const listener of this.messages) {
            listener(JSON.stringify(value));
        }
    }
    async close() {
        if (!this.reusable) {
            return;
        }
        this.reusable = false;
        for (const listener of this.disconnects) {
            listener();
        }
        this.resolveClosed();
    }
}

class RoundtripProvider extends GenericModelProvider {
    grants = 0;
    constructor(
        context: vscode.ExtensionContext,
        services: ResponsesWebSocketServices,
        config: ModelConfig = modelConfig
    ) {
        super(
            context,
            slot,
            {
                displayName: 'Roundtrip',
                baseUrl: config.baseUrl!,
                apiKeyTemplate: 'synthetic',
                models: [config]
            },
            services
        );
    }
    protected override async acquireRateLimit() {
        this.grants++;
        return undefined;
    }
    protected override getRequestRetryConfig() {
        return { enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 };
    }
    async invoke(messages: vscode.LanguageModelChatMessage[], turn: number, cancellation: vscode.CancellationToken) {
        const model = { id: modelConfig.id, name: modelConfig.name } as vscode.LanguageModelChatInformation;
        const options = this.createRequestOptions(messages, {
            requestInitiator: 'core',
            modelOptions: { _conversationId: 'roundtrip-session', _telemetryTurn: turn },
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            tools: [
                {
                    name: 'lookup',
                    description: 'lookup',
                    inputSchema: { type: 'object', properties: { id: { type: 'number' } } }
                }
            ]
        });
        const tracked = await this.prepareTrackedRequestContext(model, modelConfig, messages, options);
        assert.equal(tracked.classification.requestOrigin, 'copilot-sdk');
        assert.equal(tracked.classification.agentRole, 'main');
        assert.equal(tracked.requestContinuity.source, 'sdk-session');
        const parts: vscode.LanguageModelResponsePart[] = [];
        await this.executeModelRequest(
            model,
            modelConfig,
            messages,
            options,
            { report: part => parts.push(part) },
            `roundtrip-${this.grants + 1}`,
            tracked.sessionId,
            cancellation,
            slot,
            Date.now(),
            tracked.totalInputTokens,
            undefined,
            undefined,
            tracked.balanceKey
        );
        return parts;
    }
}

suite('Responses WebSocket roundtrip', () => {
    if (process.env.GCMP_WS_HOST_E2E === '1') {
        for (const useInstructions of [true, false, undefined]) {
            test(`WS-LOOP-03: public system prompt lifecycle useInstructions=${useInstructions}`, async () => {
                const prompts = [
                    SDK_MAIN.trim(),
                    SDK_MAIN.trim(),
                    `${SDK_MAIN.trim()}\nUpdated rules.`,
                    undefined,
                    `${SDK_MAIN.trim()}\nUpdated rules.`
                ];
                const contexts: MockExpectedContext[] = [];
                const conversation: MockExpectedContext['input'][number][] = [];
                for (const [index, prompt] of prompts.entries()) {
                    conversation.push(user(`turn-${index + 1}`));
                    if (prompt) {
                        contexts.push({
                            instructions: useInstructions === true ? prompt : undefined,
                            delta: index === 1 || index === 4,
                            input: [
                                ...(useInstructions !== true ? [{ ...user(prompt), status: undefined }] : []),
                                ...conversation
                            ]
                        });
                    }
                    conversation.push(assistant(prompt ? 'mock response' : 'mock HTTP response'));
                }
                const fixture = await createLiveResponsesFixture('text', { delta: true, useInstructions, contexts });
                fixture.failFastCapture();
                try {
                    const history: vscode.LanguageModelChatMessage[] = [];
                    for (const [index, prompt] of prompts.entries()) {
                        fixture.failFastCapture(prompt !== undefined);
                        history.push(vscode.LanguageModelChatMessage.User(`turn-${index + 1}`));
                        const metrics: Array<{ event: LiveStreamMetricEvent; finalized: boolean }> = [];
                        let metricRequestId: string | undefined;
                        const subscription = onLiveMetrics(event => {
                            if (event.type === 'requestStarted' && event.providerName === 'Live E2E') {
                                metricRequestId = event.requestId;
                            }
                            if (event.requestId === metricRequestId) {
                                metrics.push({
                                    event,
                                    finalized: fixture.updates.some(update => update.requestId === event.requestId)
                                });
                            }
                        });
                        try {
                            const parts = await fixture.begin(
                                [
                                    ...(prompt ?
                                        [
                                            new vscode.LanguageModelChatMessage(
                                                vscode.LanguageModelChatMessageRole.System,
                                                prompt
                                            )
                                        ]
                                    :   []),
                                    ...history
                                ],
                                index + 1
                            ).result;
                            assert.equal(fixture.text(parts), prompt ? 'mock response' : 'mock HTTP response');
                            const started = metrics.find(metric => metric.event.type === 'requestStarted');
                            const firstChunk = metrics.find(metric => metric.event.type === 'firstChunk');
                            const output = metrics.find(
                                metric =>
                                    metric.event.type === 'streamingUpdate' &&
                                    (metric.event.estimatedOutputTokens ?? 0) > 0
                            );
                            assert.ok(started, 'requestStarted must reach the live metrics bus');
                            assert.ok(firstChunk, 'firstChunk must reach the live metrics bus before completion');
                            assert.ok(output, 'output metrics must reach the live metrics bus before completion');
                            assert.equal(firstChunk.finalized, false);
                            assert.equal(output.finalized, false);
                            assert.ok(firstChunk.event.streamStartTime !== undefined);
                            assert.equal(
                                firstChunk.event.firstChunkLatencyMs,
                                Math.max(0, firstChunk.event.streamStartTime - started.event.requestStartTime)
                            );
                            assert.equal(output.event.firstChunkLatencyMs, firstChunk.event.firstChunkLatencyMs);
                            assert.equal(output.event.streamStartTime, firstChunk.event.streamStartTime);
                            for (const metric of metrics) {
                                if (metric.event.type === 'streamEnd') {
                                    continue;
                                }
                                assert.equal(metric.event.requestStartTime, started.event.requestStartTime);
                            }
                            assert.equal(
                                fixture.updates.at(-1)?.requestMetricStartTime,
                                started.event.requestStartTime
                            );
                            history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                        } finally {
                            subscription.dispose();
                        }
                    }
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.contextChecks, 4);
                    assert.equal(observed.contextErrors, 0);
                    assert.equal(observed.handshakes, 1);
                    assert.equal(observed.httpAccepted, 1);
                    assert.equal(observed.full, 2);
                    assert.equal(observed.delta, 2);
                    const inputCounts = useInstructions === true ? [1, 1, 5, 3] : [2, 1, 6, 3];
                    assert.deepEqual(observed.wireInputItems, inputCounts);
                    const plans = fixture.diagnostics.filter(entry => entry.event === 'Responses transport selected');
                    const commits = fixture.diagnostics.filter(entry => entry.event === 'Responses checkpoint commit');
                    assert.equal(plans.length, 4);
                    assert.equal(commits.length, 4);
                    assert.deepEqual(
                        plans.map(entry => entry.data.sentInputItems),
                        inputCounts
                    );
                    assert.deepEqual(
                        plans.map(entry => entry.data.fullInputItems),
                        contexts.map(context => context.input.length)
                    );
                    assert.deepEqual(
                        plans.slice(0, 3).map(entry => entry.data.reason),
                        [
                            'no-checkpoint',
                            'verified-prefix',
                            useInstructions === true ? 'semantics-changed' : 'prefix-changed'
                        ]
                    );
                    for (const [index, entry] of plans.entries()) {
                        assert.deepEqual(
                            Object.keys(entry.data).sort(),
                            [
                                'transport',
                                'requestId',
                                'mode',
                                'generation',
                                'contextEpoch',
                                'reason',
                                'fullInputItems',
                                'sentInputItems'
                            ].sort()
                        );
                        assert.equal(entry.data.requestId, fixture.updates[index === 3 ? 4 : index].requestId);
                    }
                    for (const entry of commits) {
                        assert.deepEqual(
                            Object.keys(entry.data).sort(),
                            [
                                'requestId',
                                'committed',
                                'generation',
                                'contextEpoch',
                                'checkpointVersion',
                                'hasCheckpoint',
                                'lastCommitReason'
                            ].sort()
                        );
                        assert.equal(entry.data.committed, true);
                        assert.equal(entry.data.lastCommitReason, 'committed');
                    }
                    assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 5);
                    assert.equal(fixture.counters().http, 1);
                    assert.equal(fixture.counters().captures, 1);
                    assert.equal((await fixture.close()).length, 1);
                } finally {
                    await fixture.dispose();
                }
            });
        }
        test('WS-LOOP-03: public system prompt mode switches rebuild before resuming delta', async () => {
            const modes = [true, true, false, false, true, true];
            const contexts: MockExpectedContext[] = [];
            const conversation: MockExpectedContext['input'][number][] = [];
            for (const [index, useInstructions] of modes.entries()) {
                conversation.push(user(`turn-${index + 1}`));
                contexts.push({
                    instructions: useInstructions ? SDK_MAIN.trim() : undefined,
                    delta: index % 2 === 1,
                    input: [
                        ...(useInstructions ? [] : [{ ...user(SDK_MAIN.trim()), status: undefined }]),
                        ...conversation
                    ]
                });
                conversation.push(assistant('mock response'));
            }
            const fixture = await createLiveResponsesFixture('text', { delta: true, contexts });
            fixture.failFastCapture();
            try {
                const history = [
                    new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, SDK_MAIN)
                ];
                for (const [index, useInstructions] of modes.entries()) {
                    if (index > 0 && modes[index - 1] !== useInstructions) {
                        fixture.configure({ useInstructions });
                    }
                    history.push(vscode.LanguageModelChatMessage.User(`turn-${index + 1}`));
                    const parts = await fixture.begin(history, index + 1).result;
                    assert.equal(fixture.text(parts), 'mock response');
                    history.push(vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts)));
                }
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.contextChecks, 6);
                assert.equal(observed.contextErrors, 0);
                assert.equal(observed.full, 3);
                assert.equal(observed.delta, 3);
                assert.equal(observed.handshakes, 3);
                assert.deepEqual(observed.wireInputItems, [1, 1, 6, 1, 9, 1]);
                assert.equal(fixture.counters().http, 0);
                assert.equal(fixture.counters().captures, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        for (const useInstructions of [true, false, undefined]) {
            for (const failure of ['rejected-id', 'idle-expiry'] as const) {
                test(`WS-LOOP-03: public system prompt survives ${failure} useInstructions=${useInstructions}`, async () => {
                    const prefix = useInstructions === true ? [] : [{ ...user(SDK_MAIN.trim()), status: undefined }];
                    const instructions = useInstructions === true ? SDK_MAIN.trim() : undefined;
                    const contexts: MockExpectedContext[] = [
                        { instructions, delta: false, input: [...prefix, user('first')] },
                        {
                            instructions,
                            delta: false,
                            input: [...prefix, user('first'), assistant('mock response'), user('next')]
                        }
                    ];
                    const fixture = await createLiveResponsesFixture(
                        failure === 'rejected-id' ? 'reject-previous' : 'text',
                        {
                            delta: true,
                            useInstructions,
                            contexts,
                            poolIdleMs: failure === 'idle-expiry' ? 10 : undefined
                        }
                    );
                    fixture.failFastCapture();
                    try {
                        const history = fixture.history('first');
                        const first = await fixture.begin(history, 1).result;
                        assert.equal(fixture.text(first), 'mock response');
                        if (failure === 'idle-expiry') {
                            await fixture.mock.waitFor({ webSockets: 0, tcpSockets: 0 });
                        }
                        const second = await fixture.begin(
                            [
                                ...history,
                                vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                                vscode.LanguageModelChatMessage.User('next')
                            ],
                            1
                        ).result;
                        assert.equal(fixture.text(second), 'mock response');
                        const observed = await fixture.mock.snapshot();
                        assert.equal(observed.received, failure === 'rejected-id' ? 3 : 2);
                        assert.equal(observed.accepted, 2);
                        assert.equal(observed.contextChecks, 2);
                        assert.equal(observed.contextErrors, 0);
                        assert.equal(observed.handshakes, 2);
                        assert.equal(observed.full, 2);
                        assert.equal(observed.delta, 0);
                        const counts = contexts.map(context => context.input.length);
                        assert.deepEqual(observed.wireInputItems, counts);
                        const plans = fixture.diagnostics.filter(
                            entry => entry.event === 'Responses transport selected'
                        );
                        assert.deepEqual(
                            plans.map(entry => entry.data.sentInputItems),
                            failure === 'rejected-id' ? [counts[0], 1, counts[1]] : counts
                        );
                        assert.deepEqual(
                            plans.map(entry => entry.data.mode),
                            failure === 'rejected-id' ? ['full', 'delta', 'full'] : ['full', 'full']
                        );
                        assert.equal(fixture.estimates.length, 2);
                        assert.equal(fixture.updates.length, 2);
                        assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 2);
                        assert.equal(fixture.provider.grants, failure === 'rejected-id' ? 3 : 2);
                        assert.equal(fixture.counters().http, 0);
                        assert.equal(fixture.counters().captures, 0);
                        assert.equal((await fixture.close()).length, 0);
                    } finally {
                        await fixture.dispose();
                    }
                });
            }
        }
        test('WS-LOOP-11: public Provider cancellation before dispatch opens no connection', async () => {
            const fixture = await createLiveResponsesFixture('text');
            try {
                const request = fixture.begin(fixture.history('first'), 1);
                request.cancel();
                await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 0);
                assert.equal(observed.received, 0);
                assert.equal(observed.httpAccepted, 0);
                assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
                assert.equal(fixture.counters().captures, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-11: public HTTP cancellation preserves once-only finalization', async () => {
            const fixture = await createLiveResponsesFixture('text');
            try {
                const provider = fixture.makeProvider(false);
                const request: ReturnType<typeof fixture.begin> = fixture.begin(fixture.history('first'), 1, {
                    provider,
                    report: part => {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            request.cancel();
                        }
                    }
                });
                await assert.rejects(request.result, error => error instanceof vscode.CancellationError);
                assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.httpAccepted, 1);
                assert.equal(observed.received, 0);
                assert.equal(provider.grants, 1);
                assert.equal((await fixture.close()).length, 1);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-11: public Provider cancellation settles once without replay', async () => {
            const fixture = await createLiveResponsesFixture('paused', { delta: true });
            fixture.configure({ tokenPricing: { inputPrice: 1, outputPrice: 2 } });
            try {
                const request = fixture.begin(fixture.history('first'), 1);
                const cancelled = assert.rejects(request.result, error => error instanceof vscode.CancellationError);
                await fixture.mock.waitFor({ accepted: 1, pendingResponses: 1 });
                request.cancel();
                await cancelled;
                assert.equal(fixture.provider.grants, 1);
                assert.equal((await fixture.mock.snapshot()).received, 1);
                assert.equal(fixture.updates.filter(update => update.status === 'cancelled').length, 1);
                assert.equal(fixture.updates[0].rawUsage, undefined);
                assert.equal(fixture.updates[0].estimatedCost, undefined);
                assert.equal(fixture.updates[0].costBreakdown, undefined);
                assert.equal(fixture.counters().http, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-09: public Provider accepted silence never replays or invents usage', async () => {
            const fixture = await createLiveResponsesFixture('accepted-silent', {
                requestMs: 250,
                retryEnabled: false
            });
            try {
                const request = fixture.begin(fixture.history('first'), 1);
                await assert.rejects(
                    request.result,
                    error =>
                        error instanceof ResponsesTransportFailure &&
                        error.modelDispatch === 'possibly-sent' &&
                        error.acceptance === 'unknown' &&
                        !error.safeToRetry
                );
                assert.equal(fixture.provider.grants, 1);
                assert.equal(fixture.text(request.parts), '');
                assert.equal((await fixture.mock.snapshot()).accepted, 1);
                assert.equal((await fixture.mock.snapshot()).received, 1);
                const failed = fixture.updates.filter(update => update.status === 'failed');
                assert.equal(failed.length, 1);
                assert.equal(failed[0].rawUsage, undefined);
                assert.equal(fixture.counters().http, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        for (const variant of [
            'first-timeout',
            'idle-timeout',
            'disconnect',
            'disabled',
            'zero-budget',
            'partial-output'
        ] as const) {
            test(`WS-LOOP-09: public Provider no-output retry ${variant}`, async () => {
                const fixture = await createLiveResponsesFixture(
                    variant === 'idle-timeout' ? 'idle-after-created'
                    : variant === 'disconnect' ? 'accepted-close'
                    : variant === 'partial-output' ? 'partial-close'
                    : 'accepted-silent',
                    {
                        eventMs: 250,
                        retryEnabled: variant !== 'disabled',
                        retryAttempts: variant === 'zero-budget' ? 0 : 1
                    }
                );
                try {
                    const request = fixture.begin(fixture.history('first'), 1);
                    await assert.rejects(request.result, error => error instanceof ResponsesTransportFailure);
                    const attempts =
                        variant === 'disabled' || variant === 'zero-budget' || variant === 'partial-output' ? 1 : 2;
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.handshakes, attempts);
                    assert.equal(observed.received, attempts);
                    assert.equal(observed.accepted, attempts);
                    assert.equal(observed.httpAccepted, 0);
                    assert.equal(fixture.provider.grants, attempts);
                    assert.equal(fixture.text(request.parts), variant === 'partial-output' ? 'mock response' : '');
                    assert.equal(fixture.updates.length, 1);
                    assert.equal(fixture.updates[0].status, 'failed');
                    assert.equal(fixture.updates[0].rawUsage, undefined);
                    assert.equal((await fixture.close()).length, 0);
                } finally {
                    await fixture.dispose();
                }
            });
        }
        test('WS-LOOP-09: public Provider no-output retry recovers once with full context', async () => {
            const fixture = await createLiveResponsesFixture('paused', { eventMs: 500, delta: true });
            try {
                const request = fixture.begin(fixture.history('first'), 1);
                void request.result.catch(() => undefined);
                await fixture.mock.waitFor({ accepted: 2, pendingResponses: 1 });
                await fixture.mock.releasePending();
                assert.equal(fixture.text(await request.result), 'mock response');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.received, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal(observed.httpAccepted, 0);
                assert.equal(fixture.provider.grants, 2);
                assert.equal(fixture.updates.length, 1);
                assert.equal(fixture.updates[0].status, 'completed');
                assert.deepEqual(fixture.updates[0].rawUsage, {
                    input_tokens: 2,
                    output_tokens: 1,
                    total_tokens: 3
                });
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-08: public Provider consumer failure cannot publish a checkpoint', async () => {
            const fixture = await createLiveResponsesFixture('text', { delta: true });
            try {
                const request = fixture.begin(fixture.history('first'), 1, {
                    report: part => {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            throw new Error('injected progress failure');
                        }
                    }
                });
                await assert.rejects(
                    request.result,
                    error => error instanceof ResponsesTransportFailure && !error.safeToRetry
                );
                assert.equal(fixture.updates.filter(update => update.status === 'failed').length, 1);
                assert.equal((await fixture.mock.snapshot()).received, 1);
                const history = [
                    ...fixture.history('first'),
                    vscode.LanguageModelChatMessage.Assistant(fixture.replay(request.parts)),
                    vscode.LanguageModelChatMessage.User('next')
                ];
                const next = await fixture.begin(history, 2).result;
                assert.equal(fixture.text(next), 'mock response');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal(fixture.counters().http, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-12: public Provider terminal close delivers output and rebuilds full', async () => {
            const fixture = await createLiveResponsesFixture('completed-close', { delta: true });
            try {
                const first = await fixture.begin(fixture.history('first'), 1).result;
                assert.equal(fixture.text(first), 'mock response');
                await fixture.mock.waitFor({ webSockets: 0 });
                const next = await fixture.begin(
                    [
                        ...fixture.history('first'),
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(first)),
                        vscode.LanguageModelChatMessage.User('next')
                    ],
                    2
                ).result;
                assert.equal(fixture.text(next), 'mock response');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 0);
                assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 2);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        test('WS-LOOP-07: public Provider busy isolated WS does not overwrite WS checkpoint', async () => {
            const fixture = await createLiveResponsesFixture('paused', { delta: true });
            try {
                const first = fixture.begin(fixture.history('first'), 1);
                await fixture.mock.waitFor({ accepted: 1, pendingResponses: 1 });
                const bypass = fixture.begin(fixture.history('concurrent'), 2);
                await fixture.mock.waitFor({ received: 2, pendingResponses: 2 });
                await fixture.mock.releasePending();
                assert.equal(fixture.text(await bypass.result), 'mock response');
                const output = await first.result;
                assert.equal(fixture.text(output), 'mock response');
                const third = fixture.begin(
                    [
                        ...fixture.history('first'),
                        vscode.LanguageModelChatMessage.Assistant(fixture.replay(output)),
                        vscode.LanguageModelChatMessage.User('after concurrent')
                    ],
                    3
                );
                await fixture.mock.waitFor({ received: 3, pendingResponses: 1 });
                await fixture.mock.releasePending();
                assert.equal(fixture.text(await third.result), 'mock response');
                const observed = await fixture.mock.snapshot();
                assert.equal(observed.handshakes, 2);
                assert.equal(observed.full, 2);
                assert.equal(observed.delta, 1);
                assert.equal(observed.httpAccepted, 0);
                assert.equal(fixture.provider.grants, 3);
                assert.equal(fixture.updates.filter(update => update.status === 'completed').length, 3);
                assert.equal(fixture.counters().captures, 0);
                assert.equal((await fixture.close()).length, 0);
            } finally {
                await fixture.dispose();
            }
        });
        for (const retry of [false, true]) {
            test(`WS-LOOP-10: public Provider handshake retry stays WS within budget, retry=${retry}`, async () => {
                const fixture = await createLiveResponsesFixture('reject-upgrade', { retryEnabled: retry });
                try {
                    const request = fixture.begin(fixture.history('first'), 1);
                    await assert.rejects(
                        request.result,
                        error =>
                            error instanceof ResponsesTransportFailure &&
                            error.phase === 'handshake' &&
                            error.modelDispatch === 'not-sent'
                    );
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.handshakes, retry ? 2 : 1);
                    assert.equal(observed.accepted, 0);
                    assert.equal(observed.received, 0);
                    assert.equal(observed.httpAccepted, 0);
                    assert.equal(fixture.estimates.length, 1);
                    assert.equal(fixture.provider.grants, retry ? 2 : 1);
                    assert.equal(fixture.updates.filter(update => update.status === 'failed').length, 1);
                    assert.equal(fixture.counters().http, 0);
                    assert.equal(fixture.counters().captures, 0);
                    assert.equal((await fixture.close()).length, 0);
                } finally {
                    await fixture.dispose();
                }
            });
        }
        for (const delta of [false, true]) {
            test(`WS-LOOP-03: public Provider six real WS requests and HAR exclusion, delta=${delta}`, async () => {
                const fixture = await createLiveResponsesFixture(delta ? 'roundtrip-delta' : 'roundtrip-full', {
                    delta
                });
                try {
                    const httpProvider = fixture.makeProvider(false);
                    const positive = await fixture.begin(fixture.history('HTTP positive'), 0, {
                        provider: httpProvider
                    }).result;
                    assert.equal(fixture.text(positive), 'mock HTTP response');
                    assert.equal(fixture.counters().captures, 1);
                    if (delta) {
                        fixture.failFastCapture();
                    }
                    let history = fixture.history('first');
                    for (const [index, turn] of [1, 1, 1, 2, 2, 2].entries()) {
                        const parts = await fixture.begin(history, turn).result;
                        fixture.assertNoMarkers(parts);
                        const output = vscode.LanguageModelChatMessage.Assistant(fixture.replay(parts));
                        if ([0, 1, 3, 4].includes(index)) {
                            const key = ['A', 'B', '', 'C', 'D'][index];
                            const calls = parts.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                            assert.equal(calls.length, 1);
                            assert.equal(calls[0].name, 'lookup');
                            assert.equal(calls[0].callId, `call-${key}`);
                            assert.deepEqual(calls[0].input, { key });
                            const result = vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(calls[0].callId, [
                                    new vscode.LanguageModelTextPart(`result-${key}`)
                                ])
                            ]);
                            history =
                                index === 3 ?
                                    [...fixture.history('adopted summary'), output, result]
                                :   [...history, output, result];
                        } else if (index === 2) {
                            assert.equal(fixture.text(parts), 'done');
                            history = [...history, output, vscode.LanguageModelChatMessage.User('follow up')];
                        } else {
                            assert.equal(fixture.text(parts), 'after summary');
                        }
                        if (delta && index === 1) {
                            fixture.recording(false);
                        }
                        if (delta && index === 2) {
                            fixture.recording(true);
                        }
                    }
                    const observed = await fixture.mock.snapshot();
                    assert.equal(observed.contextChecks, 6);
                    assert.equal(observed.contextErrors, 0);
                    assert.equal(observed.received, 6);
                    assert.equal(observed.accepted, 6);
                    assert.equal(observed.httpAccepted, 1);
                    assert.deepEqual(observed.wireInputItems, delta ? [1, 1, 1, 1, 3, 1] : [1, 3, 5, 7, 3, 5]);
                    assert.equal(fixture.provider.grants, 6);
                    assert.equal(httpProvider.grants, 1);
                    assert.equal(fixture.estimates.length, 7);
                    const completed = fixture.updates.filter(update => update.status === 'completed');
                    assert.equal(completed.length, 7);
                    assert.equal(new Set(completed.map(update => update.requestId)).size, 7);
                    for (const update of completed) {
                        const usage = update.rawUsage;
                        assert.ok(usage && 'input_tokens' in usage && 'output_tokens' in usage);
                        assert.equal(usage.input_tokens, 2);
                        assert.equal(usage.output_tokens, 1);
                    }
                    assert.equal(fixture.counters().http, 1);
                    assert.equal(fixture.counters().captures, 1);
                    assert.equal(fixture.counters().wraps, 1);
                    const entries = await fixture.close();
                    assert.equal(entries.length, 1);
                    assert.equal(entries[0].request.url, `${fixture.mock.origin}/responses`);
                    assert.equal(entries[0].response.status, 200);
                } finally {
                    await fixture.dispose();
                }
            });
        }
        test('WS-LOOP-02: public Provider real WS smoke', async () => {
            const mock = await startResponsesMockProcess('text');
            const context = createContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            await ConfigSetStore.setSwitchMode(slot, 'off');
            await ApiKeyManager.setApiKey(slot, 'synthetic-mock');
            const originalFetch = ConfigManager.createProxyAwareFetch;
            const originalRecord = TokenUsagesManager.instance.recordEstimatedTokens;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            const estimates: Parameters<typeof originalRecord>[0][] = [];
            const updates: Parameters<typeof originalUpdate>[0][] = [];
            let http = 0;
            ConfigManager.createProxyAwareFetch = () => async () => {
                http++;
                throw new Error('Unexpected HTTP in real WS E2E');
            };
            TokenUsagesManager.instance.recordEstimatedTokens = async record => {
                estimates.push(record);
                return `e2e-request-${estimates.length}`;
            };
            TokenUsagesManager.instance.updateActualTokens = record => {
                updates.push(record);
            };
            const pool = new ResponsesConnectionPool();
            const agent = new Agent();
            const config: ModelConfig = {
                ...modelConfig,
                id: 'mock-model',
                baseUrl: mock.origin,
                endpoint: '/responses',
                proxy: 'noproxy',
                maxInputTokens: 128_000
            };
            let dispatcherLeases = 0;
            const provider = new RoundtripProvider(
                context,
                {
                    pool,
                    dispatcher: () => {
                        dispatcherLeases++;
                        return {
                            dispatcher: agent,
                            fingerprint: 'live-loopback',
                            release: () => {
                                dispatcherLeases--;
                            }
                        };
                    }
                },
                config
            );
            const cancellation = trackedCancellation();
            try {
                const parts: vscode.LanguageModelResponsePart[] = [];
                await provider.provideLanguageModelChatResponse(
                    { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                    [
                        new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, SDK_MAIN),
                        vscode.LanguageModelChatMessage.User('first')
                    ],
                    {
                        requestInitiator: 'core',
                        toolMode: vscode.LanguageModelChatToolMode.Auto,
                        modelOptions: { _conversationId: 'live-session', _telemetryTurn: 1 }
                    },
                    { report: part => parts.push(part) },
                    cancellation.token
                );
                assert.equal(
                    parts
                        .filter(part => part instanceof vscode.LanguageModelTextPart)
                        .map(part => part.value)
                        .join(''),
                    'mock response'
                );
                assert.equal(estimates.length, 1);
                assert.equal(updates.filter(record => record.status === 'completed').length, 1);
                assert.equal(provider.grants, 1);
                assert.equal(http, 0);
                assert.equal((await mock.snapshot()).accepted, 1);
                await provider.dispose();
                await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
                assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
                assert.equal(dispatcherLeases, 0);
                assert.equal(cancellation.subscriptions, cancellation.disposals);
                const stopped = await mock.stop();
                assert.equal(stopped.listening, false);
                assert.equal(stopped.forcedTerminations, 0);
                assert.deepEqual(mock.diagnostics(), { exited: true, pending: 0, forcedKills: 0 });
            } finally {
                await provider.dispose();
                await pool.dispose();
                cancellation.dispose();
                await agent.destroy();
                await mock.dispose();
                ConfigManager.createProxyAwareFetch = originalFetch;
                TokenUsagesManager.instance.recordEstimatedTokens = originalRecord;
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                for (const disposable of context.subscriptions) {
                    disposable.dispose();
                }
            }
        });
    }
    for (const delta of [false, true]) {
        test(`WS-LOOP-${delta ? '03' : '02'}: real Provider tool roundtrip, next turn and adopted summary, delta=${delta}`, async () => {
            const context = createContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            await ConfigSetStore.setSwitchMode(slot, 'off');
            await ApiKeyManager.setApiKey(slot, 'synthetic-only');
            const originalFetch = ConfigManager.createProxyAwareFetch;
            const originalUpdate = TokenUsagesManager.instance.updateActualTokens;
            const updates: Parameters<typeof originalUpdate>[0][] = [];
            let http = 0;
            ConfigManager.createProxyAwareFetch = () => async () => {
                http++;
                throw new Error('WS path must not call HTTP/HAR fetch');
            };
            TokenUsagesManager.instance.updateActualTokens = update => updates.push(update);
            const pool = new ResponsesConnectionPool();
            const sockets: ScriptedSocket[] = [];
            const agent = new Agent();
            let dispatcherLeases = 0;
            const provider = new RoundtripProvider(context, {
                pool,
                allowDelta: delta ? undefined : false,
                dispatcher: () => {
                    dispatcherLeases++;
                    return {
                        dispatcher: agent,
                        fingerprint: 'synthetic-network',
                        release: () => {
                            dispatcherLeases--;
                        }
                    };
                },
                socket: () => {
                    const socket = new ScriptedSocket();
                    sockets.push(socket);
                    return socket;
                }
            });
            const cancellation = trackedCancellation();
            try {
                const firstUser = '<userRequest>first</userRequest>';
                const nextUser = '<userRequest>next turn</userRequest>';
                const summary = '<userRequest>adopted summary</userRequest>';
                const systemMessage = new vscode.LanguageModelChatMessage(
                    vscode.LanguageModelChatMessageRole.System,
                    system
                );
                const replayParts = (parts: vscode.LanguageModelResponsePart[]) =>
                    parts.filter(
                        part =>
                            part instanceof vscode.LanguageModelTextPart ||
                            part instanceof vscode.LanguageModelToolCallPart ||
                            part instanceof vscode.LanguageModelDataPart
                    );
                let history = [systemMessage, vscode.LanguageModelChatMessage.User(firstUser)];
                const first = await provider.invoke(history, 1, cancellation.token);
                const calls = first.filter(part => part instanceof vscode.LanguageModelToolCallPart);
                assert.equal(calls.length, 1);
                assert.equal(calls[0].callId, 'call_a');
                history.push(
                    vscode.LanguageModelChatMessage.Assistant(replayParts(first)),
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(calls[0].callId, [
                            new vscode.LanguageModelTextPart('tool answer')
                        ])
                    ])
                );
                const second = await provider.invoke(history, 1, cancellation.token);
                history.push(
                    vscode.LanguageModelChatMessage.Assistant(replayParts(second)),
                    vscode.LanguageModelChatMessage.User(nextUser)
                );
                const third = await provider.invoke(history, 2, cancellation.token);
                history = [systemMessage, vscode.LanguageModelChatMessage.User(summary)];
                const fourth = await provider.invoke(history, 2, cancellation.token);
                for (const parts of [first, second, third, fourth]) {
                    assert.equal(
                        parts.some(
                            part => part instanceof vscode.LanguageModelDataPart && /stateful/i.test(part.mimeType)
                        ),
                        false
                    );
                }
                assert.equal(sockets.length, 1);
                assert.deepEqual(sockets[0].contexts, [
                    [user(firstUser)],
                    [user(firstUser), toolCall, toolResult],
                    [user(firstUser), toolCall, toolResult, assistant('reply-2'), user(nextUser)],
                    [user(summary)]
                ]);
                assert.deepEqual(
                    sockets[0].frames.map(frame => frame.previous_response_id),
                    delta ? [undefined, 'r1', 'r2', undefined] : [undefined, undefined, undefined, undefined]
                );
                assert.equal(provider.grants, 4);
                assert.equal(updates.filter(update => update.status === 'completed').length, 4);
                assert.equal(http, 0);
                assert.equal(pool.diagnostics().leases, 0);
                await provider.dispose();
                assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
                assert.equal(dispatcherLeases, 0);
                assert.equal(cancellation.subscriptions, cancellation.disposals);
            } finally {
                await provider.dispose();
                await pool.dispose();
                cancellation.dispose();
                await agent.destroy();
                ConfigManager.createProxyAwareFetch = originalFetch;
                TokenUsagesManager.instance.updateActualTokens = originalUpdate;
                for (const disposable of context.subscriptions) {
                    disposable.dispose();
                }
            }
        });
    }
});
