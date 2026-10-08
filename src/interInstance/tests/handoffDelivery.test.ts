import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import test from 'node:test';
import type { InterInstanceEvent } from '../eventProtocol';
import type { IpcTargetSendResult } from '../ipcServer';
import { createIpcHost } from './ipcFixture';

interface ServerState {
    sockets: Set<Socket>;
    socketInstanceIds: Map<Socket, string>;
    backpressuredSockets: Map<Socket, { queue: string[] }>;
    removeSocket(socket: Socket): void;
}

test('Manual handoff write completion is bounded and isolated', async t => {
    const host = await createIpcHost();
    t.after(() => host.restore());
    const handoff: InterInstanceEvent = {
        type: 'leaderResigning',
        payload: { leaderId: 'leader', reason: 'manual', nextLeaderId: 'nominee', sourceAuthorityTerm: 'leader:1' },
        senderInstanceId: 'leader',
        timestamp: 1
    };
    const fixture = (writable = false) => {
        const server = new host.IpcServer();
        const state = server as unknown as ServerState;
        const socket = new EventEmitter() as Socket;
        const control: {
            destroyed: boolean;
            throwWrite: boolean;
            callback?: (error?: Error | null) => void;
            writes: number;
        } = {
            destroyed: false,
            throwWrite: false,
            writes: 0
        };
        Object.defineProperty(socket, 'writableLength', { value: 0 });
        Object.assign(socket, {
            write: (_data: string, callback?: (error?: Error | null) => void) => {
                if (control.throwWrite) {
                    throw new Error('synchronous write failure');
                }
                control.writes++;
                control.callback = callback;
                return writable;
            },
            destroy: () => {
                control.destroyed = true;
                socket.emit('close');
                return socket;
            }
        });
        socket.on('close', () => state.removeSocket(socket));
        socket.on('error', () => socket.destroy());
        state.sockets.add(socket);
        state.socketInstanceIds.set(socket, 'nominee');
        const send = server.sendToInstance as unknown as (
            id: string,
            event: InterInstanceEvent,
            waitForWrite: true
        ) => IpcTargetSendResult | Promise<boolean>;
        return { server, state, socket, control, send: (event = handoff) => send.call(server, 'nominee', event, true) };
    };

    for (const writable of [true, false]) {
        await t.test(`write(${writable}) waits for its callback and ignores late failures`, async () => {
            const f = fixture(writable);
            try {
                const result = f.send();
                assert.ok(result instanceof Promise);
                let settled = false;
                void result.then(() => {
                    settled = true;
                });
                await Promise.resolve();
                assert.equal(settled, false);
                assert.ok(f.control.callback);
                f.control.callback();
                assert.equal(await result, true);
                f.socket.emit('drain');
                f.control.callback(new Error('late callback'));
                assert.equal(f.control.destroyed, false);
                assert.equal(f.socket.listenerCount('close'), 1);
                assert.equal(f.socket.listenerCount('error'), 1);
                assert.equal(f.state.backpressuredSockets.size, 0);
            } finally {
                await f.server.stop();
            }
        });
    }

    for (const cause of ['callback-error', 'close', 'error', 'timeout', 'stop', 'term-change'] as const) {
        await t.test(`${cause} settles once, closes pending writes and releases listeners`, async context => {
            context.mock.timers.enable({ apis: ['setTimeout'] });
            const f = fixture();
            try {
                const result = f.send();
                assert.ok(result instanceof Promise);
                assert.ok(f.control.callback);
                const callback = f.control.callback;
                if (cause === 'callback-error') {
                    callback(new Error('write failed'));
                } else if (cause === 'close') {
                    f.socket.destroy();
                } else if (cause === 'error') {
                    f.socket.emit('error', new Error('transport failed'));
                } else if (cause === 'stop') {
                    await f.server.stop();
                } else if (cause === 'term-change') {
                    f.server.disconnectClients();
                } else {
                    let settled = false;
                    void result.then(() => {
                        settled = true;
                    });
                    context.mock.timers.tick(1999);
                    await Promise.resolve();
                    assert.equal(settled, false);
                    context.mock.timers.tick(1);
                }
                assert.equal(await result, false);
                assert.equal(f.control.destroyed, true);
                callback();
                context.mock.timers.tick(2000);
                assert.equal(await result, false);
                assert.equal(f.socket.listenerCount('close'), 1);
                assert.equal(f.socket.listenerCount('error'), 1);
                assert.equal(f.socket.listenerCount('drain'), 0);
                assert.equal(f.state.backpressuredSockets.size, 0);
            } finally {
                await f.server.stop();
            }
        });
    }

    for (const cause of ['missing', 'backpressured', 'too-large', 'write-throws'] as const) {
        await t.test(`${cause} remains a synchronous refusal before accepted delivery`, async () => {
            const f = fixture();
            try {
                let value = handoff;
                if (cause === 'missing') {
                    f.state.socketInstanceIds.clear();
                } else if (cause === 'backpressured') {
                    assert.equal(
                        f.server.sendToInstance('nominee', {
                            type: 'statusUpdated',
                            payload: { providerKey: 'test', source: 'cache', data: 'pending' },
                            senderInstanceId: 'leader',
                            timestamp: 1
                        }),
                        'sent'
                    );
                } else if (cause === 'too-large') {
                    value = { ...handoff, payload: { ...handoff.payload, leaderId: 'x'.repeat(769 * 1024) } };
                } else {
                    f.control.throwWrite = true;
                }
                const before = f.control.writes;
                assert.equal(
                    f.send(value),
                    cause === 'too-large' ? 'too-large'
                    : cause === 'backpressured' ? 'backpressured'
                    : 'not-connected'
                );
                assert.equal(f.control.writes, before);
                assert.equal(f.socket.listenerCount('close'), 1);
                assert.equal(f.socket.listenerCount('error'), 1);
            } finally {
                await f.server.stop();
            }
        });
    }
});
