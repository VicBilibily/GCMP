import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { Agent, Dispatcher } from 'undici';
import { ResponsesTransportFailure, UndiciResponsesSocket } from './responsesWebSocketTransport';

type PeerMode =
    | 'blackhole'
    | 'stall'
    | 'reject'
    | 'oversized-header'
    | 'tiny-fragments'
    | 'empty-fragments'
    | 'compressed-frame'
    | 'invalid-utf8'
    | 'masked-frame'
    | 'invalid-accept'
    | 'unsolicited-extension'
    | 'unsolicited-protocol';

async function upstream(mode: PeerMode) {
    const connections = new Set<Duplex>();
    const upgraded = new Set<Duplex>();
    let seenUpgrade!: () => void;
    let closedUpgrade!: () => void;
    const upgradeSeen = new Promise<void>(resolve => {
        seenUpgrade = resolve;
    });
    const upgradeClosed = new Promise<void>(resolve => {
        closedUpgrade = resolve;
    });
    let authorization: string | undefined;
    const server = createServer((_request, response) => response.end('http-control'));
    server.on('connection', socket => {
        connections.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => connections.delete(socket));
    });
    server.on('upgrade', (request, socket) => {
        upgraded.add(socket);
        socket.once('close', () => upgraded.delete(socket));
        socket.once('close', closedUpgrade);
        socket.on('end', () => socket.end());
        socket.on('data', () => undefined);
        authorization = request.headers.authorization;
        if (mode === 'reject') {
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        } else if (mode !== 'stall') {
            const accept = createHash('sha1')
                .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest('base64');
            const extra =
                mode === 'unsolicited-extension' ? 'Sec-WebSocket-Extensions: permessage-deflate\r\n'
                : mode === 'unsolicited-protocol' ? 'Sec-WebSocket-Protocol: unknown\r\n'
                : '';
            socket.write(
                `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${mode === 'invalid-accept' ? 'invalid' : accept}\r\n${extra}\r\n`
            );
            if (mode === 'oversized-header') {
                const header = Buffer.alloc(10);
                header[0] = 0x81;
                header[1] = 127;
                header.writeBigUInt64BE(BigInt(16 * 1024 * 1024 + 1), 2);
                socket.write(header);
            }
            if (mode === 'tiny-fragments' || mode === 'empty-fragments') {
                const size = mode === 'tiny-fragments' ? 3 : 2;
                const frames = Buffer.alloc(size * 4097);
                for (let index = 0; index < 4097; index++) {
                    frames[index * size] = index === 0 ? 1 : 0;
                    frames[index * size + 1] = size - 2;
                    if (size === 3) {
                        frames[index * size + 2] = 0x61;
                    }
                }
                socket.write(frames);
            }
            if (mode === 'compressed-frame') {
                socket.write(Buffer.from([0xc1, 0]));
            }
            if (mode === 'invalid-utf8') {
                socket.write(Buffer.from([0x81, 1, 0xff]));
            }
            if (mode === 'masked-frame') {
                socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]));
            }
        }
        seenUpgrade();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
        url: `ws://127.0.0.1:${address.port}/responses`,
        http: `http://127.0.0.1:${address.port}/control`,
        connections,
        upgraded,
        upgradeSeen,
        upgradeClosed,
        authorization: () => authorization,
        async dispose() {
            for (const socket of connections) {
                socket.destroy();
            }
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
    };
}

for (const mode of [
    'oversized-header',
    'tiny-fragments',
    'empty-fragments',
    'compressed-frame',
    'invalid-utf8',
    'masked-frame'
] as const) {
    test(`WS-LOOP-13: bounded receiver rejects ${mode} before application delivery`, { timeout: 5_000 }, async () => {
        const server = await upstream(mode);
        const agent = new Agent();
        const socket = new UndiciResponsesSocket({
            url: server.url,
            headers: {},
            dispatcher: agent,
            gracefulMs: 25,
            closeMs: 500
        });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let delivered = 0;
        let receiveError: Error | undefined;
        socket.onMessage(() => {
            delivered++;
        });
        socket.onDisconnect(error => {
            receiveError = error;
        });
        try {
            await socket.opened;
            await Promise.race([
                server.upgradeClosed,
                new Promise<never>((_resolve, reject) => {
                    deadline = setTimeout(() => reject(new Error(`Unbounded receiver: ${mode}`)), 800);
                })
            ]);
            await socket.closed;
            assert.equal(socket.reusable, false);
            assert.equal(server.upgraded.size, 0);
            assert.equal(delivered, 0);
            assert.ok(receiveError instanceof Error);
        } finally {
            clearTimeout(deadline);
            await socket.close().catch(() => undefined);
            await agent.destroy();
            await server.dispose();
        }
    });
}

for (const mode of ['invalid-accept', 'unsolicited-extension', 'unsolicited-protocol'] as const) {
    test(`WS-LOOP-10: real Upgrade rejects ${mode} before opening`, { timeout: 5_000 }, async () => {
        const server = await upstream(mode);
        const agent = new Agent();
        const socket = new UndiciResponsesSocket({ url: server.url, headers: {}, dispatcher: agent });
        try {
            await assert.rejects(
                socket.opened,
                (error: unknown) => error instanceof ResponsesTransportFailure && error.modelDispatch === 'not-sent'
            );
            await socket.closed;
            await server.upgradeClosed;
            assert.equal(socket.reusable, false);
        } finally {
            await socket.close().catch(() => undefined);
            await agent.destroy();
            await server.dispose();
        }
    });
}

test('WS-LOOP-15: delayed real Upgrade after cancellation cannot revive the socket', { timeout: 5_000 }, async () => {
    const server = await upstream('blackhole');
    const agent = new Agent();
    let reached!: () => void;
    const pending = new Promise<void>(resolve => {
        reached = resolve;
    });
    let deliver = () => {};
    let physical: Duplex | undefined;
    class DelayedUpgrade extends Dispatcher {
        override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
            return agent.dispatch(
                options,
                new Proxy(handler, {
                    get(target, property) {
                        if (property === 'onConnect') {
                            return () => target.onConnect?.(() => {});
                        }
                        if (property === 'onUpgrade') {
                            return (status: number, headers: Buffer[] | string[] | null, socket: Duplex) => {
                                physical = socket;
                                deliver = () => target.onUpgrade?.(status, headers, socket);
                                reached();
                            };
                        }
                        const value: unknown = Reflect.get(target, property);
                        return typeof value === 'function' ? value.bind(target) : value;
                    }
                })
            );
        }
    }
    const socket = new UndiciResponsesSocket({
        url: server.url,
        headers: {},
        dispatcher: new DelayedUpgrade(),
        handshakeMs: 2_000,
        gracefulMs: 50,
        closeMs: 1_000
    });
    let messages = 0;
    socket.onMessage(() => {
        messages++;
    });
    try {
        await pending;
        const cleanup = socket.close();
        await assert.rejects(socket.opened);
        assert.equal(socket.reusable, false);
        deliver();
        await cleanup;
        await server.upgradeClosed;
        assert.equal(physical?.destroyed, true);
        assert.equal(messages, 0);
        assert.equal(socket.reusable, false);
        assert.equal(server.upgraded.size, 0);
        const control = await agent.request({ origin: new URL(server.http).origin, path: '/control', method: 'GET' });
        assert.equal(await control.body.text(), 'http-control');
    } finally {
        physical?.destroy();
        await socket.close().catch(() => undefined);
        await agent.destroy();
        await server.dispose();
    }
});

test('WS-LOOP-15: real Undici blackhole close destroys only owned Upgrade socket', { timeout: 5_000 }, async () => {
    const server = await upstream('blackhole');
    const agent = new Agent();
    const socket = new UndiciResponsesSocket({
        url: server.url,
        headers: { Authorization: 'Bearer synthetic' },
        dispatcher: agent,
        gracefulMs: 25,
        closeMs: 500
    });
    try {
        await socket.opened;
        assert.equal(server.authorization(), 'Bearer synthetic');
        const first = socket.close();
        assert.equal(socket.close(), first);
        await first;
        await server.upgradeClosed;
        assert.equal(server.connections.size, 0);
        const control = await agent.request({ origin: new URL(server.http).origin, path: '/control', method: 'GET' });
        assert.equal(await control.body.text(), 'http-control');
        assert.equal(socket.reusable, false);
    } finally {
        await socket.close().catch(() => undefined);
        await agent.destroy();
        await server.dispose();
    }
});

for (const timedOut of [false, true]) {
    test(
        `WS-LOOP-15: real Upgrade stall ${timedOut ? 'deadline' : 'cancel'} releases transport`,
        { timeout: 5_000 },
        async () => {
            const server = await upstream('stall');
            const agent = new Agent();
            const socket = new UndiciResponsesSocket({
                url: server.url,
                headers: {},
                dispatcher: agent,
                handshakeMs: timedOut ? 100 : 2_000,
                gracefulMs: 20,
                closeMs: 500
            });
            try {
                await server.upgradeSeen;
                if (!timedOut) {
                    await socket.close();
                }
                await assert.rejects(
                    socket.opened,
                    (error: unknown) => error instanceof ResponsesTransportFailure && error.modelDispatch === 'not-sent'
                );
                await socket.close();
                await server.upgradeClosed;
                assert.equal(server.connections.size, 0);
                assert.equal(socket.reusable, false);
            } finally {
                await socket.close().catch(() => undefined);
                await agent.destroy();
                await server.dispose();
            }
        }
    );
}

test(
    'WS-LOOP-10: real handshake rejection retains HTTP status without model dispatch',
    { timeout: 5_000 },
    async () => {
        const server = await upstream('reject');
        const agent = new Agent();
        const socket = new UndiciResponsesSocket({
            url: server.url,
            headers: {},
            dispatcher: agent,
            gracefulMs: 20,
            closeMs: 500
        });
        try {
            await assert.rejects(
                socket.opened,
                (error: unknown) =>
                    error instanceof ResponsesTransportFailure && error.status === 401 && error.safeToRetry
            );
            await socket.close();
            await server.upgradeClosed;
            assert.equal(server.upgraded.size, 0);
            const control = await agent.request({
                origin: new URL(server.http).origin,
                path: '/control',
                method: 'GET'
            });
            assert.equal(await control.body.text(), 'http-control');
        } finally {
            await socket.close().catch(() => undefined);
            await agent.destroy();
            await server.dispose();
        }
    }
);
