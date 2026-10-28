import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, ProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';
import type { MockNetwork } from '../responsesWebSocketMockProcess.js';
import * as processNamespace from '../responsesWebSocketMockProcess.js';
import * as transportNamespace from '../../../src/handlers/openai/transport/responsesWebSocketTransport';
import * as poolNamespace from '../../../src/handlers/openai/transport/responsesConnectionPool';
import * as plannerNamespace from '../../../src/handlers/openai/responses/responsesContinuationPlanner';
import { startResponsesMockServer } from './mockServer.js';
import type { MockScenario } from './mockServer.js';
import type { ResponsesRequestHandle } from '../../../src/handlers/openai/transport/responsesWebSocketTransport';

const transportModule = (
    'default' in transportNamespace ?
        transportNamespace.default
    :   transportNamespace) as typeof transportNamespace;
const { UndiciResponsesSocket, ResponsesWebSocketTransport } = transportModule;
const { ResponsesTransportFailure } = transportModule;
const { ResponsesConnectionPool } = (
    'default' in poolNamespace ?
        poolNamespace.default
    :   poolNamespace) as typeof poolNamespace;
const { ResponsesContinuationPlanner } = (
    'default' in plannerNamespace ?
        plannerNamespace.default
    :   plannerNamespace) as typeof plannerNamespace;

const { isMockCommand } = (
    'default' in processNamespace ?
        processNamespace.default
    :   processNamespace) as typeof processNamespace;

test('WS-LOOP-03: mock prompt context contract rejects invalid inputs', () => {
    const content = { type: 'input_text', text: 'synthetic prompt' };
    const message = { type: 'message', role: 'user', content: [content] };
    const context = { instructions: 'synthetic rules', delta: false, input: [message] };
    const command = { id: 1, kind: 'start', scenario: 'text' };
    assert.equal(isMockCommand(command), true);
    for (const contexts of [
        [],
        [context],
        [{ delta: true, input: [] }],
        [
            {
                delta: false,
                input: [
                    message,
                    { ...message, status: 'completed' },
                    {
                        type: 'message',
                        role: 'assistant',
                        status: 'completed',
                        content: [{ type: 'output_text', text: 'synthetic answer' }]
                    }
                ]
            }
        ]
    ]) {
        assert.equal(isMockCommand({ ...command, expected: { contexts } }), true);
    }
    const invalidContexts: unknown[] = [
        null,
        { ...context, instructions: null },
        { ...context, delta: 'false' },
        { ...context, delta: undefined },
        { ...context, input: null },
        { ...context, input: [null] },
        ...[
            { ...message, type: 'function_call' },
            { ...message, role: 'system' },
            { ...message, status: 'in_progress' },
            { ...message, content: null },
            { ...message, content: [null] },
            { ...message, content: [{ ...content, type: 'input_image' }] },
            { ...message, content: [{ ...content, text: 42 }] }
        ].map(input => ({ ...context, input: [input] }))
    ];
    for (const invalid of invalidContexts) {
        assert.equal(isMockCommand({ ...command, expected: { contexts: [invalid] } }), false);
    }
    for (const contexts of [null, 'invalid', {}]) {
        assert.equal(isMockCommand({ ...command, expected: { contexts } }), false);
    }
});

interface TransportLimits {
    messageBytes: number;
    queueBytes: number;
    firstMs: number;
    idleMs: number;
}

function connection(
    mock: Awaited<ReturnType<typeof startResponsesMockServer>>,
    agent: Dispatcher,
    limits: Partial<TransportLimits> = {},
    abortPending?: () => Promise<void>
) {
    assert.equal(process.env.WS_NO_BUFFER_UTIL, '1');
    assert.equal(process.env.WS_NO_UTF_8_VALIDATE, '1');
    const socket = new UndiciResponsesSocket({
        url: mock.url,
        headers: { Authorization: 'Bearer synthetic-mock' },
        dispatcher: agent,
        abortPending,
        handshakeMs: 500,
        gracefulMs: 50,
        closeMs: 1_000
    });
    const transport = new ResponsesWebSocketTransport(socket, undefined, {
        messageBytes: 16 * 1024 * 1024,
        queueBytes: 32 * 1024 * 1024,
        firstMs: 1_000,
        idleMs: 1_000,
        ...limits
    });
    return { socket, transport };
}

async function client(scenario: MockScenario, limits: Partial<TransportLimits> = {}) {
    const mock = await startResponsesMockServer(scenario);
    const agent = new Agent();
    const real = connection(mock, agent, limits);
    try {
        await real.transport.opened;
    } catch (error) {
        await agent.destroy();
        await mock.stop();
        throw error;
    }
    return {
        mock,
        agent,
        ...real,
        async dispose() {
            await real.transport.close().catch(() => undefined);
            await agent.destroy();
            await mock.stop();
        }
    };
}

async function drain(handle: ResponsesRequestHandle) {
    const types: string[] = [];
    let text = '';
    for await (const event of handle.events) {
        types.push(event.type);
        if (event.type === 'response.output_text.delta') {
            text += event.delta;
        }
    }
    return { types, text };
}

async function assertClosed(real: Awaited<ReturnType<typeof client>>) {
    await real.transport.close();
    await real.mock.waitFor({ webSockets: 0, tcpSockets: 0 });
    assert.equal(real.mock.snapshot().forcedTerminations, 0);
    assert.equal(real.mock.snapshot().protocolErrors, 0);
    assert.equal(real.mock.snapshot().pendingResponses, 0);
    assert.equal(real.mock.snapshot().waiters, 0);
    assert.equal(real.transport.diagnostics().handles, 0);
    assert.equal(real.transport.diagnostics().processQueueBytes, 0);
    await real.mock.stop();
    assert.equal(real.mock.snapshot().listening, false);
}

function replay(output: readonly unknown[]): Record<string, unknown>[] {
    return output.map(value => {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value));
        const item = value as Record<string, unknown>;
        if (item.type === 'function_call') {
            assert.equal(typeof item.call_id, 'string');
            assert.equal(typeof item.name, 'string');
            assert.equal(typeof item.arguments, 'string');
            return {
                type: 'function_call',
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
                status: 'completed'
            };
        }
        assert.equal(item.type, 'message');
        assert.equal(item.role, 'assistant');
        assert.ok(Array.isArray(item.content));
        return { type: 'message', role: 'assistant', status: 'completed', content: item.content };
    });
}

const user = (text: string) => ({
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }]
});
const identity = {
    ownerId: 'mock-owner',
    provider: 'mock-provider',
    modelId: 'mock-model',
    sessionId: 'mock-session',
    origin: 'sdk',
    purpose: 'main-agent',
    branchId: 'main',
    binding: 'mock-network'
};

test('WS-LOOP-13: real fragmented message exceeds default 16 MiB receiver limit', { timeout: 20_000 }, async () => {
    const real = await client('fragmented-overlimit', { firstMs: 10_000, idleMs: 10_000 });
    const handle = real.transport.begin({ model: 'mock-model', input: [] }, () => {});
    try {
        await assert.rejects(
            drain(handle),
            (error: unknown) =>
                error instanceof ResponsesTransportFailure &&
                !error.safeToRetry &&
                error.cause instanceof Error &&
                /Max payload size exceeded/.test(error.cause.message)
        );
        handle.finish(false);
        await assertClosed(real);
    } finally {
        handle.finish(false);
        await real.dispose();
    }
});

test('WS-LOOP-13: real connections enforce the default 128 MiB process queue budget', { timeout: 30_000 }, async () => {
    const mock = await startResponsesMockServer('process-pressure');
    const agent = new Agent();
    const requests: Array<ReturnType<typeof connection> & { handle: ResponsesRequestHandle }> = [];
    try {
        for (let index = 0; index < 6; index++) {
            const real = connection(mock, agent, { firstMs: 15_000, idleMs: 15_000 });
            await real.transport.opened;
            let received = 0;
            let ready!: () => void;
            const filled = new Promise<void>(resolve => {
                ready = resolve;
            });
            const remove = real.socket.onMessage(() => {
                if (++received === 4) {
                    ready();
                }
            });
            const handle = real.transport.begin({ model: 'mock-model', input: [] }, () => {});
            requests.push({ ...real, handle });
            if (index < 5) {
                await filled;
                assert.ok(real.transport.diagnostics().queueBytes > 23 * 1024 * 1024);
            } else {
                await real.socket.closed;
                await assert.rejects(
                    drain(handle),
                    (error: unknown) =>
                        error instanceof ResponsesTransportFailure &&
                        !error.safeToRetry &&
                        error.cause instanceof Error &&
                        /queue budget/.test(error.cause.message)
                );
                handle.finish(false);
            }
            remove();
        }
        const bytes = requests[0].transport.diagnostics().processQueueBytes;
        assert.ok(bytes > 119 * 1024 * 1024 && bytes <= 128 * 1024 * 1024);
        assert.equal(
            bytes,
            requests.reduce((total, request) => total + request.transport.diagnostics().queueBytes, 0)
        );
        for (const request of requests) {
            request.handle.finish(false);
        }
        await Promise.all(requests.map(request => request.transport.close()));
        await agent.close();
        await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
        for (const request of requests) {
            assert.deepEqual(request.transport.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
        }
        assert.equal(mock.snapshot().accepted, 6);
        assert.equal(mock.snapshot().forcedTerminations, 0);
        assert.equal(mock.snapshot().protocolErrors, 0);
        await mock.stop();
    } finally {
        for (const request of requests) {
            request.handle.finish(false);
        }
        await agent.destroy();
        await mock.stop();
    }
});

test('WS-LOOP-10: real mock rejects Upgrade without accepting a model request', { timeout: 10_000 }, async () => {
    const mock = await startResponsesMockServer('reject-upgrade');
    const agent = new Agent();
    const socket = new UndiciResponsesSocket({
        url: mock.url,
        headers: { Authorization: 'Bearer synthetic-mock' },
        dispatcher: agent,
        gracefulMs: 50,
        closeMs: 1_000
    });
    try {
        await assert.rejects(
            socket.opened,
            (error: unknown) =>
                error instanceof ResponsesTransportFailure && error.status === 404 && error.modelDispatch === 'not-sent'
        );
        await socket.close();
        await agent.close();
        await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
        assert.equal(mock.snapshot().handshakes, 1);
        assert.equal(mock.snapshot().accepted, 0);
        await mock.stop();
    } finally {
        await socket.close().catch(() => undefined);
        await agent.destroy();
        await mock.stop();
    }
});

for (const variant of ['malformed', 'local-flag', 'delta'] as const) {
    test(`WS-LOOP-01: real mock rejects invalid HTTP ${variant}`, { timeout: 10_000 }, async () => {
        const mock = await startResponsesMockServer();
        const agent = new Agent();
        try {
            const body =
                variant === 'malformed' ? '{' : (
                    JSON.stringify({
                        model: 'mock-model',
                        input: [],
                        stream: true,
                        ...(variant === 'local-flag' ?
                            { useWebSocket: true }
                        :   { previous_response_id: 'invalid-predecessor' })
                    })
                );
            const response = await agent.request({
                origin: mock.origin,
                path: '/responses',
                method: 'POST',
                body,
                headers: { 'content-type': 'application/json' }
            });
            assert.equal(response.statusCode, 400);
            await response.body.dump();
            assert.equal(mock.snapshot().httpRequests, 1);
            assert.equal(mock.snapshot().httpAccepted, 0);
            assert.equal(mock.snapshot().received, 0);
            await agent.close();
            await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
            await mock.stop();
            assert.equal(mock.snapshot().forcedTerminations, 0);
        } finally {
            await agent.destroy();
            await mock.stop();
        }
    });
}

test(
    'WS-LOOP-02: pinned mock server exchanges real response.create and typed events',
    { timeout: 10_000 },
    async () => {
        const mock = await startResponsesMockServer();
        const agent = new Agent();
        const socket = new UndiciResponsesSocket({
            url: mock.url,
            headers: { Authorization: 'Bearer synthetic-mock' },
            dispatcher: agent,
            gracefulMs: 50,
            closeMs: 1_000
        });
        const transport = new ResponsesWebSocketTransport(socket);
        let handle: ReturnType<typeof transport.begin> | undefined;
        try {
            await transport.opened;
            handle = transport.begin({ model: 'mock-model', input: [], store: false, stream: true }, () => undefined);
            const types: string[] = [];
            let text = '';
            for await (const event of handle.events) {
                types.push(event.type);
                if (event.type === 'response.output_text.delta') {
                    text += event.delta;
                }
            }
            assert.deepEqual(types, ['response.created', 'response.output_text.delta', 'response.completed']);
            assert.equal(text, 'mock response');
            assert.equal(handle.receipt?.type, 'response.completed');
            handle.finish(true);
            await transport.close();
            await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
            assert.equal(mock.snapshot().accepted, 1);
            assert.equal(mock.snapshot().forcedTerminations, 0);
            assert.equal(mock.snapshot().waiters, 0);
            assert.equal(transport.diagnostics().handles, 0);
            assert.equal(transport.diagnostics().processQueueBytes, 0);
            await mock.stop();
            assert.equal(mock.snapshot().listening, false);
        } finally {
            handle?.finish(false);
            await transport.close().catch(() => undefined);
            await agent.destroy();
            await mock.stop();
        }
    }
);

test('WS-LOOP-02: fragmented UTF-8 text crosses real WebSocket frame boundaries', { timeout: 10_000 }, async () => {
    const real = await client('fragmented');
    let handle: ResponsesRequestHandle | undefined;
    try {
        handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
        const result = await drain(handle);
        assert.equal(result.text, 'mock response \u4e2d\u6587');
        assert.equal(result.types.filter(type => type === 'response.output_text.delta').length, 1);
        handle.finish(true);
        await assertClosed(real);
    } finally {
        handle?.finish(false);
        await real.dispose();
    }
});

for (const delta of [false, true]) {
    test(
        `WS-LOOP-03: six real network requests preserve full context, delta=${delta}`,
        { timeout: 15_000 },
        async () => {
            const mock = await startResponsesMockServer(delta ? 'roundtrip-delta' : 'roundtrip-full');
            const agent = new Agent();
            const pool = new ResponsesConnectionPool();
            const planner = new ResponsesContinuationPlanner();
            const controller = new AbortController();
            const generations: number[] = [];
            const modes: string[] = [];
            let creates = 0;
            let history: Record<string, unknown>[] = [user('first')];
            try {
                for (const [index, turn] of [1, 1, 1, 2, 2, 2].entries()) {
                    assert.equal(turn, index < 3 ? 1 : 2);
                    const lease = await pool.acquire(
                        identity,
                        () => {
                            creates++;
                            return connection(mock, agent).transport;
                        },
                        controller.signal
                    );
                    assert.ok(lease);
                    assert.ok(lease.connection instanceof ResponsesWebSocketTransport);
                    generations.push(lease.generation);
                    const fullBody = {
                        model: 'mock-model',
                        input: history,
                        stream: true,
                        store: false,
                        parallel_tool_calls: false,
                        instructions: 'mock instructions',
                        tools: [
                            {
                                type: 'function',
                                name: 'lookup',
                                parameters: { type: 'object', properties: { key: { type: 'string' } } }
                            }
                        ]
                    };
                    const plan = planner.plan(fullBody, lease.generation, delta, turn);
                    modes.push(plan.mode);
                    const handle = lease.connection.begin(plan.body, () => undefined, plan.previousResponseId);
                    let success = false;
                    try {
                        const result = await drain(handle);
                        if (index === 2) {
                            assert.equal(result.text, 'done');
                        }
                        if (index === 5) {
                            assert.equal(result.text, 'after summary');
                        }
                        assert.ok(handle.receipt);
                        assert.equal(planner.commit(plan, handle.receipt, lease.isCurrent()), true);
                        const output = replay(handle.receipt.output);
                        if ([0, 1, 3, 4].includes(index)) {
                            const key = ['A', 'B', '', 'C', 'D'][index];
                            assert.equal(output.length, 1);
                            assert.equal(output[0].call_id, `call-${key}`);
                            const toolResult = {
                                type: 'function_call_output',
                                call_id: output[0].call_id,
                                output: `result-${key}`,
                                status: 'completed'
                            };
                            history =
                                index === 3 ?
                                    [user('adopted summary'), ...output, toolResult]
                                :   [...history, ...output, toolResult];
                        } else if (index === 2) {
                            history = [...history, ...output, user('follow up')];
                        }
                        success = true;
                    } finally {
                        handle.finish(success);
                        lease.release(success);
                    }
                }
                assert.equal(creates, 1);
                assert.equal(new Set(generations).size, 1);
                assert.deepEqual(
                    modes,
                    delta ? ['full', 'delta', 'delta', 'delta', 'full', 'delta'] : Array(6).fill('full')
                );
                const observed = mock.snapshot();
                assert.equal(observed.contextChecks, 6);
                assert.equal(observed.contextErrors, 0);
                assert.equal(observed.received, 6);
                assert.equal(observed.accepted, 6);
                assert.equal(observed.full, delta ? 2 : 6);
                assert.equal(observed.delta, delta ? 4 : 0);
                assert.deepEqual(observed.wireInputItems, delta ? [1, 1, 1, 1, 3, 1] : [1, 3, 5, 7, 3, 5]);
                await pool.dispose();
                await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
                assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
                assert.equal(mock.snapshot().forcedTerminations, 0);
                assert.equal(mock.snapshot().waiters, 0);
                await mock.stop();
                assert.equal(mock.snapshot().listening, false);
            } finally {
                await pool.dispose();
                await agent.destroy();
                await mock.stop();
            }
        }
    );
}

for (const scenario of ['malformed', 'binary', 'oversize', 'queue-overflow', 'identity', 'unknown-terminal'] as const) {
    test(`WS-LOOP-13: real mock rejects ${scenario} without replay`, { timeout: 10_000 }, async () => {
        const expectedCause = {
            malformed: /JSON|Expected|Unexpected/,
            binary: /Unsupported binary/,
            oversize: /message budget/,
            'queue-overflow': /queue budget/,
            identity: /identity mismatch/,
            'unknown-terminal': /first event deadline exceeded/
        }[scenario];
        const real = await client(scenario, {
            messageBytes: scenario === 'oversize' ? 256 : 16 * 1024,
            queueBytes: scenario === 'queue-overflow' ? 128 : 32 * 1024
        });
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await real.socket.closed;
            await assert.rejects(drain(handle), (error: unknown) => {
                assert.ok(error instanceof ResponsesTransportFailure);
                assert.equal(error.safeToRetry, false);
                assert.equal(error.modelDispatch, 'possibly-sent');
                assert.equal(error.retryIfNoOutput, scenario === 'unknown-terminal');
                if (scenario === 'unknown-terminal') {
                    assert.equal(error.phase, 'receive');
                    assert.equal(error.acceptance, 'unknown');
                    assert.equal(error.cause, undefined);
                    assert.match(error.message, expectedCause);
                } else {
                    assert.ok(error.cause instanceof Error);
                    assert.match(error.cause.message, expectedCause);
                }
                return true;
            });
            assert.equal(real.mock.snapshot().received, 1);
            handle.finish(false);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    });
}

for (const scenario of ['completed-close', 'partial-close', 'duplicate-terminal'] as const) {
    test(`WS-LOOP-12: real mock ${scenario} respects explicit terminal boundary`, { timeout: 10_000 }, async () => {
        const real = await client(scenario);
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await real.socket.closed;
            if (scenario === 'partial-close') {
                await assert.rejects(
                    drain(handle),
                    (error: unknown) => error instanceof ResponsesTransportFailure && !error.safeToRetry
                );
            } else {
                const result = await drain(handle);
                assert.equal(result.text, 'mock response');
                assert.equal(result.types.filter(type => type === 'response.completed').length, 1);
            }
            handle.finish(scenario !== 'partial-close');
            assert.equal(real.transport.reusable, false);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    });
}

for (const scenario of ['cancelled', 'failed', 'incomplete'] as const) {
    test(`WS-LOOP-12: real mock ${scenario} remains a non-completed receipt`, { timeout: 10_000 }, async () => {
        const real = await client(scenario);
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            const result = await drain(handle);
            assert.deepEqual(result.types, [`response.${scenario}`]);
            assert.equal(handle.receipt?.type, `response.${scenario}`);
            handle.finish(false);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    });
}

for (const scenario of ['flat-error', 'nested-error'] as const) {
    test(`WS-LOOP-10: real mock ${scenario} preserves status and error code`, { timeout: 10_000 }, async () => {
        const real = await client(scenario);
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await assert.rejects(
                drain(handle),
                (error: unknown) =>
                    error instanceof ResponsesTransportFailure &&
                    error.status === 429 &&
                    error.code === 'mock_limit' &&
                    !error.safeToRetry
            );
            assert.equal(real.mock.snapshot().received, 1);
            assert.equal(real.mock.snapshot().accepted, 0);
            handle.finish(false);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    });
}

for (const scenario of ['accepted-silent', 'ping-only', 'idle-after-created'] as const) {
    test(`WS-LOOP-15: real mock ${scenario} cannot extend event deadlines`, { timeout: 10_000 }, async () => {
        const real = await client(scenario, { firstMs: 60, idleMs: 60 });
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await assert.rejects(
                drain(handle),
                (error: unknown) =>
                    error instanceof ResponsesTransportFailure &&
                    !error.safeToRetry &&
                    error.acceptance === (scenario === 'idle-after-created' ? 'accepted' : 'unknown')
            );
            assert.equal(real.mock.snapshot().accepted, 1);
            assert.equal(real.mock.snapshot().received, 1);
            if (scenario === 'ping-only') {
                assert.equal(real.mock.snapshot().pings, 1);
            }
            handle.finish(false);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    });
}

test(
    'WS-LOOP-11: real owner disposal interrupts an accepted request and releases the socket',
    { timeout: 10_000 },
    async () => {
        const real = await client('paused');
        const pool = new ResponsesConnectionPool();
        let handle: ResponsesRequestHandle | undefined;
        try {
            const lease = await pool.acquire(identity, () => real.transport, new AbortController().signal);
            assert.ok(lease);
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            const iterator = handle.events[Symbol.asyncIterator]();
            assert.equal((await iterator.next()).value?.type, 'response.created');
            const waiting = assert.rejects(
                iterator.next(),
                (error: unknown) => error instanceof Error && error.name === 'AbortError'
            );
            const cleanup = pool.disposeOwner(identity.ownerId);
            assert.equal(pool.disposeOwner(identity.ownerId), cleanup);
            await waiting;
            await cleanup;
            handle.finish(false);
            assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
            assert.equal(real.mock.snapshot().received, 1);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await pool.dispose();
            await real.dispose();
        }
    }
);

test(
    'WS-LOOP-15: real total request deadline interrupts an otherwise active connection',
    { timeout: 10_000 },
    async () => {
        const real = await client('paused');
        const pool = new ResponsesConnectionPool(undefined, { requestMs: 100 });
        let handle: ResponsesRequestHandle | undefined;
        try {
            const lease = await pool.acquire(identity, () => real.transport, new AbortController().signal);
            assert.ok(lease);
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await assert.rejects(drain(handle), /total deadline/);
            handle.finish(false);
            await pool.dispose();
            assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
            assert.equal(real.mock.snapshot().received, 1);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await pool.dispose();
            await real.dispose();
        }
    }
);

test(
    'WS-LOOP-17: real reused connection ignores cancellation from the previous request',
    { timeout: 10_000 },
    async () => {
        const real = await client('text');
        const pool = new ResponsesConnectionPool();
        const previous = new AbortController();
        let handle: ResponsesRequestHandle | undefined;
        try {
            const first = await pool.acquire(identity, () => real.transport, previous.signal);
            assert.ok(first);
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await drain(handle);
            handle.finish(true);
            first.release(true);
            const next = await pool.acquire(
                identity,
                () => {
                    throw new Error('Unexpected replacement socket');
                },
                new AbortController().signal
            );
            assert.ok(next);
            assert.equal(next.connection, first.connection);
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            previous.abort();
            first.release(false);
            assert.equal((await drain(handle)).text, 'mock response');
            assert.equal(next.isCurrent(), true);
            handle.finish(true);
            next.release(true);
            await pool.dispose();
            assert.equal(real.mock.snapshot().accepted, 2);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await pool.dispose();
            await real.dispose();
        }
    }
);

test(
    'WS-LOOP-13: unsolicited real idle events invalidate rather than feed the next request',
    { timeout: 10_000 },
    async () => {
        const real = await client('text');
        let handle: ResponsesRequestHandle | undefined;
        try {
            handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
            await drain(handle);
            handle.finish(true);
            real.mock.sendIdleEvent();
            await real.socket.closed;
            assert.equal(real.transport.reusable, false);
            assert.throws(
                () => real.transport.begin({ model: 'mock-model', input: [] }, () => undefined),
                /unavailable/
            );
            assert.equal(real.mock.snapshot().received, 1);
            await assertClosed(real);
        } finally {
            handle?.finish(false);
            await real.dispose();
        }
    }
);

test('WS-LOOP-15: shared Agent keeps another real WS and HTTP request working', { timeout: 10_000 }, async () => {
    const real = await client('text');
    const second = connection(real.mock, real.agent);
    let handle: ResponsesRequestHandle | undefined;
    try {
        await second.transport.opened;
        await real.transport.close();
        await real.mock.waitFor({ webSockets: 1 });
        handle = second.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
        assert.equal((await drain(handle)).text, 'mock response');
        handle.finish(true);
        const control = await real.agent.request({ origin: real.mock.origin, path: '/health', method: 'GET' });
        assert.equal(control.statusCode, 200);
        await control.body.dump();
        await second.transport.close();
        await real.agent.close();
        await real.mock.waitFor({ webSockets: 0, tcpSockets: 0 });
        assert.equal(real.mock.snapshot().forcedTerminations, 0);
        assert.equal(second.transport.diagnostics().processQueueBytes, 0);
        await real.mock.stop();
    } finally {
        handle?.finish(false);
        await second.transport.close().catch(() => undefined);
        await real.dispose();
    }
});

interface PolicyCase {
    name: string;
    network: MockNetwork;
    trusted?: boolean;
    proxyTrusted?: boolean;
    credentials?: 'valid' | 'invalid';
    succeeds: boolean;
}
const policies: readonly PolicyCase[] = [
    { name: 'direct trusted WSS', network: { tls: 'valid' }, trusted: true, succeeds: true },
    { name: 'direct untrusted WSS', network: { tls: 'valid' }, succeeds: false },
    { name: 'direct hostname mismatch', network: { tls: 'hostname' }, trusted: true, succeeds: false },
    { name: 'direct expired certificate', network: { tls: 'expired' }, trusted: true, succeeds: false },
    { name: 'CONNECT plain WS', network: { proxy: 'forward' }, succeeds: true },
    { name: 'CONNECT trusted WSS', network: { tls: 'valid', proxy: 'forward' }, trusted: true, succeeds: true },
    {
        name: 'CONNECT valid authentication',
        network: { tls: 'valid', proxy: 'auth' },
        trusted: true,
        credentials: 'valid',
        succeeds: true
    },
    {
        name: 'CONNECT invalid authentication',
        network: { tls: 'valid', proxy: 'auth' },
        trusted: true,
        credentials: 'invalid',
        succeeds: false
    },
    { name: 'CONNECT rejection', network: { tls: 'valid', proxy: 'reject' }, trusted: true, succeeds: false },
    { name: 'CONNECT disconnect', network: { tls: 'valid', proxy: 'disconnect' }, trusted: true, succeeds: false },
    {
        name: 'HTTPS proxy independently trusted',
        network: { tls: 'valid', proxy: 'forward', secureProxy: true },
        trusted: true,
        proxyTrusted: true,
        succeeds: true
    },
    {
        name: 'HTTPS proxy untrusted',
        network: { tls: 'valid', proxy: 'forward', secureProxy: true },
        trusted: true,
        succeeds: false
    },
    { name: 'CONNECT target untrusted', network: { tls: 'valid', proxy: 'forward' }, succeeds: false },
    {
        name: 'CONNECT target hostname mismatch',
        network: { tls: 'hostname', proxy: 'forward' },
        trusted: true,
        succeeds: false
    },
    { name: 'CONNECT target expired', network: { tls: 'expired', proxy: 'forward' }, trusted: true, succeeds: false }
];

for (const policy of policies) {
    test(`WS-LOOP-06: real network policy ${policy.name}`, { timeout: 15_000 }, async () => {
        const directory = process.env.GCMP_WS_TLS_DIR;
        assert.ok(directory, 'Use the PowerShell verification entry');
        const ca = policy.trusted ? readFileSync(join(directory, 'ca.cert.pem')) : undefined;
        const mock = await startResponsesMockServer('text', {}, policy.network);
        const proxyUrl = mock.proxyUrl ? new URL(mock.proxyUrl) : undefined;
        if (proxyUrl && policy.credentials) {
            proxyUrl.username = 'fixture';
            proxyUrl.password = policy.credentials === 'valid' ? 'synthetic-proxy' : 'invalid';
        }
        const agent =
            proxyUrl ?
                new ProxyAgent({
                    uri: proxyUrl.href,
                    proxyTunnel: true,
                    requestTls: { ca, rejectUnauthorized: true },
                    proxyTls: {
                        ca: policy.proxyTrusted ? readFileSync(join(directory, 'ca.cert.pem')) : undefined,
                        rejectUnauthorized: true
                    }
                })
            :   new Agent({ connect: { ca, rejectUnauthorized: true } });
        let aborted = false;
        const real = connection(mock, agent, {}, () => {
            aborted = true;
            return agent.destroy();
        });
        let handle: ResponsesRequestHandle | undefined;
        try {
            if (policy.succeeds) {
                await real.transport.opened;
                handle = real.transport.begin({ model: 'mock-model', input: [] }, () => undefined);
                assert.equal((await drain(handle)).text, 'mock response');
                handle.finish(true);
                assert.equal(mock.snapshot().accepted, 1);
                assert.equal(mock.snapshot().handshakes, 1);
            } else {
                await assert.rejects(
                    real.transport.opened,
                    (error: unknown) => error instanceof ResponsesTransportFailure && error.modelDispatch === 'not-sent'
                );
                assert.equal(mock.snapshot().accepted, 0);
                assert.equal(mock.snapshot().handshakes, 0);
            }
            await real.transport.close();
            if (!aborted) {
                await agent.close();
            }
            await mock.waitFor({ webSockets: 0, tcpSockets: 0, proxySockets: 0 });
            const state = mock.snapshot();
            if (policy.network.proxy === 'disconnect') {
                assert.ok(state.connects >= 1);
            } else {
                assert.equal(
                    state.connects,
                    policy.network.proxy && !(policy.network.secureProxy && !policy.proxyTrusted) ? 1 : 0
                );
            }
            assert.equal(state.authFailures, policy.credentials === 'invalid' ? 1 : 0);
            assert.equal(state.proxyRejected, policy.network.proxy === 'reject' ? 1 : 0);
            assert.equal(state.forcedTerminations, 0);
            assert.equal(state.protocolErrors, 0);
            assert.deepEqual(real.transport.diagnostics(), { handles: 0, queueBytes: 0, processQueueBytes: 0 });
            await mock.stop();
            assert.equal(mock.snapshot().proxyListening, false);
            assert.equal(mock.snapshot().listening, false);
            assert.equal(mock.snapshot().forcedTerminations, 0);
        } finally {
            handle?.finish(false);
            await real.transport.close().catch(() => undefined);
            await agent.destroy();
            await mock.stop();
        }
    });
}
