import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import test from 'node:test';
import type { InterInstanceEvent } from '../eventProtocol';
import { createIpcHost, ipcPath, waitFor } from './ipcFixture';

interface PressureState {
    timer: ReturnType<typeof setTimeout>;
    onDrain(): void;
    queue: string[];
    queuedBytes: number;
}

interface ServerState {
    sockets: Set<Socket>;
    socketInstanceIds: Map<Socket, string>;
    backpressuredSockets: Map<Socket, PressureState>;
    removeSocket(socket: Socket): void;
}

const event = (index: number, value = ''): InterInstanceEvent => ({
    type: 'statusUpdated',
    payload: { providerKey: 'flow', source: 'cache', data: value },
    timestamp: index,
    senderInstanceId: 'flow-leader'
});

test('IPC backpressure preserves bounded ordered delivery', async t => {
    const host = await createIpcHost();
    t.after(() => host.restore());

    for (const mode of ['target', 'broadcast', 'mixed'] as const) {
        for (const large of [false, true]) {
            await t.test(`${mode} real socket keeps ${large ? 'large' : 'small'} bursts connected`, async () => {
                const received: InterInstanceEvent[] = [];
                const server = new host.IpcServer();
                const state = server as unknown as ServerState;
                const client = new host.IpcClient({ onMessage: value => received.push(value) });
                const pipe = ipcPath();
                try {
                    await server.start(pipe);
                    await client.connect(pipe);
                    client.send({
                        type: 'remoteInstanceHello',
                        payload: { leaderEligible: true },
                        timestamp: 0,
                        senderInstanceId: 'flow-follower'
                    });
                    await waitFor(() => server.getConnectedFollowerIds().length === 1, 'hello missing');
                    for (let index = 1; index <= 3; index++) {
                        const value = event(index, large && index !== 2 ? 'x'.repeat(96 * 1024) : 'small');
                        if (mode === 'broadcast' || (mode === 'mixed' && index === 2)) {
                            server.broadcast(value);
                        } else {
                            assert.equal(server.sendToInstance('flow-follower', value), 'sent');
                        }
                    }
                    await waitFor(() => received.length === 3 || !client.isConnected(), 'delivery missing');
                    assert.equal(client.isConnected(), true);
                    assert.deepEqual(
                        received.map(value => value.timestamp),
                        [1, 2, 3]
                    );
                    await waitFor(() => state.backpressuredSockets.size === 0, 'backpressure not cleared');
                } finally {
                    await client.disconnect();
                    await server.stop();
                }
            });
        }
    }

    const fake = () => {
        const disconnected: string[] = [];
        const writes: string[] = [];
        const control = { writable: false, bufferedBytes: 0, destroyed: false, failWrite: false };
        const server = new host.IpcServer({ onClientDisconnected: id => disconnected.push(id) });
        const state = server as unknown as ServerState;
        const socket = new EventEmitter() as Socket;
        Object.defineProperty(socket, 'writableLength', { get: () => control.bufferedBytes });
        Object.assign(socket, {
            write: (payload: string) => {
                if (control.failWrite) {
                    throw new Error('write failed');
                }
                writes.push(payload);
                if (!control.writable) {
                    control.bufferedBytes += Buffer.byteLength(payload);
                }
                return control.writable;
            },
            destroy: () => {
                control.destroyed = true;
                socket.emit('close');
                return socket;
            }
        });
        socket.on('close', () => state.removeSocket(socket));
        state.sockets.add(socket);
        state.socketInstanceIds.set(socket, 'slow');
        return {
            server,
            state,
            socket,
            writes,
            control,
            disconnected,
            send: (index: number, value = '') => server.sendToInstance('slow', event(index, value)),
            drain: () => {
                control.bufferedBytes = 0;
                socket.emit('drain');
            }
        };
    };

    await t.test('one FIFO preserves target and broadcast messages across repeated drains', async () => {
        const f = fake();
        try {
            assert.equal(f.send(1), 'sent');
            const firstState = f.state.backpressuredSockets.get(f.socket)!;
            assert.equal(f.send(2), 'sent');
            f.server.broadcast(event(3));
            assert.equal(f.writes.length, 1);
            assert.equal(f.control.destroyed, false);
            f.drain();
            assert.deepEqual(
                f.writes.map(value => (JSON.parse(value) as InterInstanceEvent).timestamp),
                [1, 2]
            );
            assert.equal(f.send(4), 'sent');
            firstState.onDrain();
            assert.equal(f.writes.length, 2);
            f.control.writable = true;
            f.drain();
            assert.deepEqual(
                f.writes.map(value => (JSON.parse(value) as InterInstanceEvent).timestamp),
                [1, 2, 3, 4]
            );
            assert.equal(f.state.backpressuredSockets.size, 0);
            assert.equal(f.socket.listenerCount('drain'), 0);
            assert.deepEqual(f.disconnected, []);
        } finally {
            await f.server.stop();
        }
    });

    for (const limit of ['bytes', 'count', 'utf8'] as const) {
        await t.test(`${limit} limit disconnects only the overloaded socket and logs no payload`, async () => {
            const f = fake();
            const start = host.logs.length;
            const other = new EventEmitter() as Socket;
            let otherWrites = 0;
            Object.assign(other, {
                write: () => {
                    otherWrites++;
                    return true;
                },
                destroy: () => other
            });
            f.state.sockets.add(other);
            f.state.socketInstanceIds.set(other, 'healthy');
            try {
                assert.equal(f.send(1, 'sensitive-sentinel'), 'sent');
                if (limit === 'count') {
                    for (let index = 0; index < 256; index++) {
                        assert.equal(f.send(index + 2), 'sent');
                    }
                    assert.equal(f.send(258), 'not-connected');
                } else {
                    const value = limit === 'utf8' ? '界'.repeat(150_000) : 'x'.repeat(450_000);
                    assert.equal(f.send(2, value), 'sent');
                    assert.equal(f.send(3, value), 'sent');
                    assert.equal(f.send(4, value), 'not-connected');
                }
                assert.equal(f.control.destroyed, true);
                assert.equal(f.state.backpressuredSockets.size, 0);
                assert.equal(f.socket.listenerCount('drain'), 0);
                assert.deepEqual(f.disconnected, ['slow']);
                assert.equal(f.server.sendToInstance('healthy', event(5)), 'sent');
                assert.equal(otherWrites, 1);
                const messages = host.logs
                    .slice(start)
                    .map(value => value.message)
                    .join('\n');
                assert.match(messages, /reason=backpressure-limit/);
                assert.match(messages, /queuedBytes=/);
                assert.doesNotMatch(messages, /sensitive-sentinel/);
            } finally {
                await f.server.stop();
            }
        });
    }

    await t.test('pending socket bytes count toward the byte limit', async () => {
        const f = fake();
        try {
            assert.equal(f.send(1, 'x'.repeat(700_000)), 'sent');
            assert.equal(f.send(2, 'x'.repeat(400_000)), 'not-connected');
            assert.equal(f.writes.length, 1);
            assert.equal(f.control.destroyed, true);
        } finally {
            await f.server.stop();
        }
    });

    await t.test('a stalled receiver still times out without extending its timer on new messages', async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const f = fake();
        const start = host.logs.length;
        try {
            assert.equal(f.send(1), 'sent');
            context.mock.timers.tick(1500);
            assert.equal(f.send(2), 'sent');
            context.mock.timers.tick(499);
            assert.equal(f.control.destroyed, false);
            context.mock.timers.tick(1);
            assert.equal(f.control.destroyed, true);
            assert.deepEqual(f.disconnected, ['slow']);
            assert.match(
                host.logs
                    .slice(start)
                    .map(value => value.message)
                    .join('\n'),
                /reason=drain-timeout/
            );
        } finally {
            await f.server.stop();
        }
    });

    for (const action of ['close', 'stop', 'term-change', 'write-error'] as const) {
        await t.test(`${action} releases queued messages, timer and drain listener`, async context => {
            context.mock.timers.enable({ apis: ['setTimeout'] });
            const f = fake();
            try {
                assert.equal(f.send(1), 'sent');
                assert.equal(f.send(2), 'sent');
                const pending = f.state.backpressuredSockets.get(f.socket)!;
                if (action === 'close') {
                    f.socket.destroy();
                } else if (action === 'stop') {
                    await f.server.stop();
                } else if (action === 'term-change') {
                    f.server.disconnectClients();
                } else {
                    f.control.failWrite = true;
                    f.drain();
                }
                assert.equal(f.state.backpressuredSockets.size, 0);
                assert.equal(f.socket.listenerCount('drain'), 0);
                assert.equal(pending.queue.length, 0);
                assert.equal(pending.queuedBytes, 0);
                const removed = f.disconnected.length;
                pending.onDrain();
                context.mock.timers.tick(2000);
                assert.equal(f.writes.length, 1);
                assert.equal(f.disconnected.length, removed);
            } finally {
                await f.server.stop();
            }
        });
    }

    await t.test('oversized target responses remain rejected before queueing', async () => {
        const f = fake();
        try {
            assert.equal(f.send(1), 'sent');
            assert.equal(f.send(2, 'x'.repeat(769 * 1024)), 'too-large');
            assert.equal(f.control.destroyed, false);
            assert.equal(f.writes.length, 1);
        } finally {
            await f.server.stop();
        }
    });
});
