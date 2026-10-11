import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import test from 'node:test';
import type { InterInstanceEvent } from '../eventProtocol';
import { createIpcHost, ipcPath, waitFor } from './ipcFixture';

interface ClientState {
    socket: Socket | undefined;
    buffer: string;
}

const frame: InterInstanceEvent = {
    type: 'statusUpdated',
    payload: { providerKey: 'close-test', source: 'cache', data: 'x'.repeat(4096) },
    timestamp: 1,
    senderInstanceId: 'close-follower'
};

test('IPC client disconnect has a bounded graceful drain', async t => {
    const host = await createIpcHost();
    t.after(() => host.restore());

    const fake = () => {
        const client = new host.IpcClient({ onMessage() {} });
        const state = client as unknown as ClientState;
        const socket = new EventEmitter() as Socket;
        const calls = { end: 0, destroySoon: 0, destroy: 0 };
        Object.assign(socket, {
            end: () => {
                calls.end++;
                return socket;
            },
            destroySoon: () => {
                calls.destroySoon++;
            },
            destroy: () => {
                calls.destroy++;
                return socket;
            }
        });
        state.socket = socket;
        state.buffer = 'partial frame';
        return { client, state, socket, calls };
    };

    for (const elapsed of [0, 999]) {
        await t.test(`graceful close at ${elapsed}ms clears the fallback timer`, async context => {
            context.mock.timers.enable({ apis: ['setTimeout'] });
            const f = fake();
            const closing = f.client.disconnect();
            try {
                assert.equal(f.client.isConnected(), false);
                assert.deepEqual(f.calls, { end: 1, destroySoon: 1, destroy: 0 });
                context.mock.timers.tick(elapsed);
                f.socket.emit('close');
                await closing;
                context.mock.timers.tick(2000);
                assert.equal(f.calls.destroy, 0);
                assert.equal(f.socket.listenerCount('close'), 0);
                assert.equal(f.state.buffer, '');
            } finally {
                f.socket.emit('close');
                await closing;
            }
        });
    }

    await t.test('stalled drain forces destruction at 1000ms and settles only after close', async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const f = fake();
        const logStart = host.logs.length;
        let settled = false;
        const closing = f.client.disconnect().then(() => {
            settled = true;
        });
        try {
            context.mock.timers.tick(999);
            await Promise.resolve();
            assert.equal(f.calls.destroy, 0);
            assert.equal(settled, false);
            context.mock.timers.tick(1);
            assert.equal(f.calls.destroy, 1);
            assert.equal(settled, false);
            f.socket.emit('close');
            await closing;
            context.mock.timers.tick(2000);
            assert.equal(f.calls.destroy, 1);
            assert.equal(f.socket.listenerCount('close'), 0);
            assert.equal(f.state.buffer, '');
            assert.equal(host.logs.slice(logStart).filter(log => /disconnect-timeout/.test(log.message)).length, 1);
        } finally {
            f.socket.emit('close');
            await closing;
        }
    });

    await t.test('disconnect without a socket is repeatable and creates no timeout', async context => {
        context.mock.timers.enable({ apis: ['setTimeout'] });
        const client = new host.IpcClient({ onMessage() {} });
        const logStart = host.logs.length;
        await client.disconnect();
        await client.disconnect();
        context.mock.timers.tick(2000);
        assert.equal(client.isConnected(), false);
        assert.deepEqual(host.logs.slice(logStart), []);
    });

    for (const stalled of [false, true]) {
        await t.test(`real ${stalled ? 'paused' : 'healthy'} peer permits close and reuse`, async () => {
            const peers = new Set<Socket>();
            const received: Buffer[] = [];
            const server = createServer(socket => {
                peers.add(socket);
                socket.on('data', data => received.push(data));
                if (stalled) {
                    socket.pause();
                }
            });
            let disconnected = 0;
            const client = new host.IpcClient({
                onMessage() {},
                onDisconnect: () => disconnected++
            });
            const state = client as unknown as ClientState;
            const pipe = ipcPath();
            let closing: Promise<void> | undefined;
            try {
                server.listen(pipe);
                await once(server, 'listening');
                await client.connect(pipe);
                await waitFor(() => peers.size === 1, 'old peer missing');
                const oldPeer = [...peers][0];
                const oldSocket = state.socket!;
                const count = stalled ? 1024 : 3;
                for (let index = 0; index < count; index++) {
                    client.send(frame);
                }
                if (stalled) {
                    assert.ok(oldSocket.writableLength > 0, 'fixture must have pending writes');
                }
                let closed = false;
                closing = client.disconnect().then(() => {
                    closed = true;
                });
                await waitFor(() => closed, 'disconnect waited for old peer to resume');
                assert.equal(oldSocket.destroyed, true);
                assert.equal(disconnected, 0);
                if (stalled) {
                    assert.equal(oldPeer.isPaused(), true);
                } else {
                    await waitFor(
                        () => Buffer.concat(received).toString().split('\n').length - 1 === count,
                        'graceful close discarded queued frames'
                    );
                }
                await client.connect(pipe);
                await waitFor(() => peers.size === 2, 'replacement peer missing');
                const newPeer = [...peers][1];
                newPeer.resume();
                let freshData = '';
                newPeer.on('data', data => {
                    freshData += data.toString();
                });
                client.send({ ...frame, timestamp: 2 });
                await waitFor(() => freshData.includes('"timestamp":2'), 'replacement socket not writable');
                assert.equal(client.isConnected(), true);
                assert.equal(disconnected, 0);
            } finally {
                for (const peer of peers) {
                    peer.destroy();
                }
                await closing;
                await client.disconnect();
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
        });
    }
});
