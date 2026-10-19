import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from 'undici';
import * as transportNamespace from '../../../src/handlers/openai/transport/responsesWebSocketTransport';
import * as poolNamespace from '../../../src/handlers/openai/transport/responsesConnectionPool';
import type { ResponsesConnectionLease } from '../../../src/handlers/openai/transport/responsesConnectionPool';
import type { ResponsesRequestHandle } from '../../../src/handlers/openai/transport/responsesWebSocketTransport';
import { startResponsesMockServer } from './mockServer.js';

const { UndiciResponsesSocket, ResponsesWebSocketTransport } = (
    'default' in transportNamespace ?
        transportNamespace.default
    :   transportNamespace) as typeof transportNamespace;
const { ResponsesConnectionPool } = (
    'default' in poolNamespace ?
        poolNamespace.default
    :   poolNamespace) as typeof poolNamespace;
const identity = {
    ownerId: 'owner',
    provider: 'provider',
    modelId: 'model',
    sessionId: 'session',
    origin: 'sdk',
    purpose: 'main-agent',
    branchId: 'main',
    binding: 'A'
};

async function fixture() {
    const mock = await startResponsesMockServer('text');
    const agent = new Agent();
    const pool = new ResponsesConnectionPool();
    const transports = new Set<InstanceType<typeof ResponsesWebSocketTransport>>();
    const create = () => {
        const transport = new ResponsesWebSocketTransport(
            new UndiciResponsesSocket({
                url: mock.url,
                headers: { Authorization: 'Bearer synthetic-mock' },
                dispatcher: agent,
                handshakeMs: 1_000,
                gracefulMs: 50,
                closeMs: 1_000
            })
        );
        transports.add(transport);
        return transport;
    };
    return {
        mock,
        pool,
        transports,
        create,
        async complete(lease: ResponsesConnectionLease) {
            assert.ok(lease.connection instanceof ResponsesWebSocketTransport);
            const handle = lease.connection.begin({ model: 'mock-model', input: [] }, () => undefined);
            try {
                for await (const event of handle.events) {
                    assert.ok(event.type);
                }
                assert.equal(handle.receipt?.type, 'response.completed');
                handle.finish(true);
                lease.release(true);
            } finally {
                handle.finish(false);
            }
        },
        async close() {
            await pool.dispose();
            await agent.close();
            await mock.waitFor({ webSockets: 0, tcpSockets: 0 });
            assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
            for (const transport of transports) {
                assert.deepEqual(transport.diagnostics(), { handles: 0, queueBytes: 0, processQueueBytes: 0 });
            }
            assert.equal(mock.snapshot().forcedTerminations, 0);
            assert.equal(mock.snapshot().protocolErrors, 0);
            await mock.stop();
        },
        async dispose() {
            await pool.dispose().catch(() => undefined);
            await agent.destroy();
            await mock.stop();
        }
    };
}

for (const failedState of ['idle', 'handshake', 'generation', 'consumption'] as const) {
    test(
        `WS-LOOP-15: mixed real shutdown retains ${failedState} cleanup failure and closes peers`,
        { timeout: 20_000 },
        async () => {
            const pool = new ResponsesConnectionPool();
            const failure = new Error(`injected ${failedState} dispatcher release failure`);
            const participants: Array<{
                mock: Awaited<ReturnType<typeof startResponsesMockServer>>;
                agent: Agent;
                transport: InstanceType<typeof ResponsesWebSocketTransport>;
                acquisition: Promise<ResponsesConnectionLease | undefined>;
                handle?: ResponsesRequestHandle;
            }> = [];
            try {
                for (const state of ['idle', 'handshake', 'generation', 'consumption'] as const) {
                    const mock = await startResponsesMockServer(
                        state === 'handshake' ? 'stall-upgrade'
                        : state === 'generation' ? 'paused'
                        : 'text'
                    );
                    const agent = new Agent();
                    let aborted: Promise<void> | undefined;
                    const abortPending = () => (aborted ??= agent.destroy());
                    const socket = new UndiciResponsesSocket({
                        url: mock.url,
                        headers: { Authorization: 'Bearer synthetic-mock' },
                        dispatcher: agent,
                        abortPending,
                        handshakeMs: 10_000,
                        gracefulMs: 50,
                        closeMs: 1_000
                    });
                    const transport = new ResponsesWebSocketTransport(socket, undefined, undefined, {
                        abortPending,
                        release: async () => {
                            await (aborted ?? agent.close());
                            if (state === failedState) {
                                throw failure;
                            }
                        }
                    });
                    const acquisition = pool.acquire(
                        { ...identity, sessionId: state },
                        () => transport,
                        new AbortController().signal
                    );
                    void acquisition.catch(() => undefined);
                    const participant: (typeof participants)[number] = { mock, agent, transport, acquisition };
                    participants.push(participant);
                    if (state === 'handshake') {
                        await mock.waitFor({ handshakes: 1 });
                        continue;
                    }
                    const lease = await acquisition;
                    assert.ok(lease);
                    if (state === 'idle') {
                        lease.release(true);
                        continue;
                    }
                    let observed!: () => void;
                    const barrier = new Promise<void>(resolve => {
                        observed = resolve;
                    });
                    const remove = socket.onMessage(data => {
                        assert.equal(typeof data, 'string');
                        const event: unknown = JSON.parse(data as string);
                        if (
                            event &&
                            typeof event === 'object' &&
                            'type' in event &&
                            event.type === (state === 'generation' ? 'response.created' : 'response.completed')
                        ) {
                            observed();
                        }
                    });
                    participant.handle = transport.begin({ model: 'mock-model', input: [] }, () => {});
                    await barrier;
                    remove();
                }
                assert.deepEqual(pool.diagnostics(), { connections: 4, leases: 3, closing: 0 });
                const cleanup = pool.disposeOwner(identity.ownerId);
                assert.equal(pool.disposeOwner(identity.ownerId), cleanup);
                await assert.rejects(
                    cleanup,
                    (error: unknown) => error instanceof AggregateError && error.errors.includes(failure)
                );
                await Promise.allSettled(participants.map(participant => participant.acquisition));
                for (const participant of participants) {
                    participant.handle?.finish(false);
                    await participant.mock.waitFor({ webSockets: 0, tcpSockets: 0, pendingResponses: 0 });
                    assert.deepEqual(participant.transport.diagnostics(), {
                        handles: 0,
                        queueBytes: 0,
                        processQueueBytes: 0
                    });
                    assert.equal(participant.mock.snapshot().forcedTerminations, 0);
                    assert.equal(participant.mock.snapshot().protocolErrors, 0);
                    await participant.mock.stop();
                }
                assert.deepEqual(pool.diagnostics(), { connections: 1, leases: 0, closing: 1 });
                await assert.rejects(pool.dispose(), AggregateError);
            } finally {
                await pool.dispose().catch(() => undefined);
                for (const participant of participants) {
                    participant.handle?.finish(false);
                    await participant.agent.destroy();
                    await participant.mock.stop();
                }
            }
        }
    );
}

for (const field of ['provider', 'modelId', 'sessionId', 'ownerId', 'branchId', 'binding'] as const) {
    test(
        `WS-LOOP-17: real socket isolates ${field} while preserving the original scope`,
        { timeout: 10_000 },
        async () => {
            const real = await fixture();
            const signal = new AbortController().signal;
            try {
                const first = await real.pool.acquire(identity, real.create, signal);
                assert.ok(first);
                await real.complete(first);
                const isolated = await real.pool.acquire({ ...identity, [field]: 'other' }, real.create, signal);
                assert.ok(isolated);
                assert.notEqual(isolated.connection, first.connection);
                await real.complete(isolated);
                const original = await real.pool.acquire(identity, real.create, signal);
                assert.ok(original);
                assert.equal(original.connection, first.connection);
                await real.complete(original);
                assert.equal(real.mock.snapshot().handshakes, 2);
                assert.equal(real.mock.snapshot().accepted, 3);
                await real.close();
            } finally {
                await real.dispose();
            }
        }
    );
}

test('WS-LOOP-06: real explicit revocation rebuilds A B A without an old socket', { timeout: 10_000 }, async () => {
    const real = await fixture();
    const signal = new AbortController().signal;
    const connections: ResponsesConnectionLease['connection'][] = [];
    try {
        for (const binding of ['A', 'B', 'A']) {
            const lease = await real.pool.acquire({ ...identity, binding }, real.create, signal);
            assert.ok(lease);
            connections.push(lease.connection);
            await real.complete(lease);
            real.pool.retireOwner(identity.ownerId);
            await lease.connection.closed;
        }
        assert.equal(new Set(connections).size, 3);
        assert.equal(real.mock.snapshot().handshakes, 3);
        assert.equal(real.mock.snapshot().full, 3);
        assert.equal(real.mock.snapshot().delta, 0);
        await real.close();
    } finally {
        await real.dispose();
    }
});

test(
    'WS-LOOP-15: real default pool limits stop at 32 sockets and eight per provider',
    { timeout: 20_000 },
    async () => {
        const real = await fixture();
        const signal = new AbortController().signal;
        const leases: ResponsesConnectionLease[] = [];
        try {
            for (let index = 0; index < 32; index++) {
                const lease = await real.pool.acquire(
                    { ...identity, provider: `provider-${Math.floor(index / 8)}`, sessionId: `session-${index}` },
                    real.create,
                    signal
                );
                assert.ok(lease);
                leases.push(lease);
            }
            assert.equal(
                await real.pool.acquire(
                    { ...identity, provider: 'provider-0', sessionId: 'ninth' },
                    real.create,
                    signal
                ),
                undefined
            );
            assert.equal(
                await real.pool.acquire(
                    { ...identity, provider: 'overflow', sessionId: 'global-overflow' },
                    real.create,
                    signal
                ),
                undefined
            );
            assert.equal(real.transports.size, 32);
            assert.equal(real.mock.snapshot().webSockets, 32);
            leases[0].release(false);
            await leases[0].connection.closed;
            await real.mock.waitFor({ webSockets: 31 });
            const replacement = await real.pool.acquire(
                { ...identity, provider: 'replacement', sessionId: 'replacement' },
                real.create,
                signal
            );
            assert.ok(replacement);
            assert.equal(real.mock.snapshot().webSockets, 32);
            assert.equal(real.mock.snapshot().accepted, 0);
            await real.close();
        } finally {
            await real.dispose();
        }
    }
);
