import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serializeEvent, USAGES_QUERY_PROTOCOL_VERSION, type InterInstanceEvent } from './eventProtocol';
import type { UsagesPendingRecord } from '../usages/query/types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

function connectSocket(pipePath: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect(pipePath, () => resolve(socket));
        socket.once('error', reject);
    });
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 1000;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error(message);
        }
        await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
}

async function waitForClose(socket: Socket, message: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            once(socket, 'close'),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), 1000);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

test('IPC server sends bounded responses only to the requested instance', async () => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, error() {}, info() {}, warn() {} } };
        }
        return originalRequire.call(this, id);
    };

    try {
        const { IpcServer } = await import('./ipcServer');
        const writes = new Map<string, string[]>();
        const createSocket = (id: string) =>
            ({
                write: (payload: string) => {
                    const values = writes.get(id) ?? [];
                    values.push(payload);
                    writes.set(id, values);
                    return true;
                }
            }) as unknown as Socket;
        const followerA = createSocket('a');
        const followerB = createSocket('b');
        const disconnectedInstanceIds: string[] = [];
        const server = Object.create(IpcServer.prototype) as InstanceType<typeof IpcServer>;
        Object.assign(server, {
            sockets: new Set([followerA, followerB]),
            leaderEligibleInstanceIds: new Set<string>(),
            socketInstanceIds: new Map([
                [followerA, 'follower-a'],
                [followerB, 'follower-b']
            ]),
            options: { onClientDisconnected: (instanceId: string) => disconnectedInstanceIds.push(instanceId) }
        });
        const event: InterInstanceEvent = {
            type: 'usagesQueryCompleted',
            payload: {
                requestId: 'query-1',
                targetInstanceId: 'follower-a',
                authorityTerm: 'leader:1',
                result: { kind: 'recentRecords', value: [] }
            },
            timestamp: 1,
            senderInstanceId: 'leader'
        };

        assert.equal(server.sendToInstance('follower-a', event), 'sent');
        assert.equal(writes.get('a')?.length, 1);
        assert.equal(writes.has('b'), false);
        assert.equal(server.sendToInstance('missing', event), 'not-connected');

        const failedSocket = {
            write: () => {
                throw new Error('targeted write failed');
            }
        } as unknown as Socket;
        (server as unknown as { sockets: Set<Socket> }).sockets.add(failedSocket);
        (server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds.set(
            failedSocket,
            'follower-failed'
        );
        assert.equal(server.sendToInstance('follower-failed', event), 'not-connected');
        assert.deepEqual(disconnectedInstanceIds, ['follower-failed']);
        assert.equal((server as unknown as { sockets: Set<Socket> }).sockets.has(failedSocket), false);
        assert.equal(
            (server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds.has(failedSocket),
            false
        );

        const slowSocket = new EventEmitter() as Socket;
        let slowWrites = 0;
        let slowSocketDestroyed = false;
        Object.assign(slowSocket, {
            write: () => {
                slowWrites += 1;
                return false;
            },
            destroy: () => {
                slowSocketDestroyed = true;
                slowSocket.emit('close');
                return slowSocket;
            }
        });
        (server as unknown as { sockets: Set<Socket> }).sockets.add(slowSocket);
        (server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds.set(
            slowSocket,
            'follower-slow'
        );
        assert.equal(server.sendToInstance('follower-slow', event), 'sent');
        assert.equal(server.sendToInstance('follower-slow', event), 'not-connected');
        assert.equal(slowWrites, 1);
        assert.equal(slowSocketDestroyed, true);
        assert.equal(disconnectedInstanceIds.at(-1), 'follower-slow');

        const oversized: InterInstanceEvent = {
            type: 'statusUpdated',
            payload: { providerKey: 'test', data: 'x'.repeat(769 * 1024), source: 'cache' },
            timestamp: 1,
            senderInstanceId: 'leader'
        };
        assert.equal(server.sendToInstance('follower-a', oversized), 'too-large');
        assert.equal(writes.get('a')?.length, 1);

        const relay = server as unknown as {
            broadcastFromSocket: (events: InterInstanceEvent[], sourceSocket: Socket) => void;
        };
        const identity = server as unknown as {
            acceptSocketEvents: (socket: Socket, events: InterInstanceEvent[]) => boolean;
        };
        const spoofedEvent: InterInstanceEvent = {
            type: 'statusUpdated',
            payload: { providerKey: 'test', data: {}, source: 'cache' },
            timestamp: 1,
            senderInstanceId: 'follower-a'
        };
        assert.equal(identity.acceptSocketEvents(followerB, [spoofedEvent]), false);
        assert.equal(
            (server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds.get(followerB),
            'follower-b'
        );

        const followerC = createSocket('c');
        const followerD = createSocket('d');
        (server as unknown as { sockets: Set<Socket> }).sockets.add(followerC);
        (server as unknown as { sockets: Set<Socket> }).sockets.add(followerD);
        assert.equal(
            identity.acceptSocketEvents(followerC, [{ ...spoofedEvent, senderInstanceId: 'follower-c' }]),
            false
        );
        assert.equal(
            identity.acceptSocketEvents(followerC, [
                {
                    type: 'remoteInstanceHello',
                    payload: {},
                    timestamp: 1,
                    senderInstanceId: 'follower-c'
                }
            ]),
            true
        );
        assert.equal(
            identity.acceptSocketEvents(followerD, [
                {
                    type: 'remoteInstanceHello',
                    payload: {},
                    timestamp: 1,
                    senderInstanceId: 'follower-a'
                }
            ]),
            false
        );

        writes.clear();
        relay.broadcastFromSocket(
            [
                {
                    type: 'usagesQueryRequested',
                    payload: {
                        requestId: 'query-2',
                        requestedBy: 'follower-a',
                        authorityTerm: 'leader:1',
                        query: { kind: 'recentRecords', limit: 3 }
                    },
                    timestamp: 1,
                    senderInstanceId: 'follower-a'
                },
                {
                    type: 'remoteInstanceCapabilities',
                    payload: {
                        targetInstanceId: 'follower-b',
                        extensionVersion: 'forged',
                        usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION
                    },
                    timestamp: 1,
                    senderInstanceId: 'follower-a'
                },
                event
            ],
            followerA
        );
        assert.equal(writes.has('b'), false);

        relay.broadcastFromSocket(
            [
                {
                    type: 'statusUpdated',
                    payload: { providerKey: 'test', data: {}, source: 'cache' },
                    timestamp: 1,
                    senderInstanceId: 'follower-a'
                }
            ],
            followerA
        );
        assert.equal(writes.get('b')?.length, 1);
        assert.equal(writes.has('d'), false);

        const stopSocket = new EventEmitter() as Socket;
        Object.assign(stopSocket, {
            write: () => false,
            destroy: () => stopSocket
        });
        (server as unknown as { sockets: Set<Socket> }).sockets.add(stopSocket);
        (server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds.set(
            stopSocket,
            'follower-stop'
        );
        assert.equal(server.sendToInstance('follower-stop', event), 'sent');
        assert.equal(
            (server as unknown as { backpressuredSockets: Map<Socket, unknown> }).backpressuredSockets.size,
            1
        );
        await server.stop();
        assert.equal(
            (server as unknown as { backpressuredSockets: Map<Socket, unknown> }).backpressuredSockets.size,
            0
        );
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

test('IPC server enforces immutable identities on real sockets', async () => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, error() {}, info() {}, warn() {} } };
        }
        return originalRequire.call(this, id);
    };

    const sockets: Socket[] = [];
    let server: import('./ipcServer').IpcServer | undefined;
    try {
        const { IpcServer } = await import('./ipcServer');
        const receivedEvents: InterInstanceEvent[] = [];
        const disconnectedInstanceIds: string[] = [];
        const pipePath =
            process.platform === 'win32' ?
                `\\\\.\\pipe\\gcmp-ipc-test-${process.pid}-${Date.now()}`
            :   join(tmpdir(), `gcmp-ipc-test-${process.pid}-${Date.now()}.sock`);
        server = new IpcServer({
            onMessage: event => receivedEvents.push(event),
            onClientDisconnected: instanceId => disconnectedInstanceIds.push(instanceId)
        });
        await server.start(pipePath);

        const followerA = await connectSocket(pipePath);
        sockets.push(followerA);
        const followerAData: string[] = [];
        followerA.on('data', data => followerAData.push(data.toString('utf8')));
        followerA.write(
            serializeEvent({
                type: 'remoteInstanceHello',
                payload: {},
                timestamp: 1,
                senderInstanceId: 'follower-a'
            })
        );
        await waitFor(
            () =>
                receivedEvents.some(
                    event => event.type === 'remoteInstanceHello' && event.senderInstanceId === 'follower-a'
                ),
            'follower-a handshake was not accepted'
        );

        const followerB = await connectSocket(pipePath);
        sockets.push(followerB);
        followerB.write(
            serializeEvent({
                type: 'remoteInstanceHello',
                payload: {},
                timestamp: 1,
                senderInstanceId: 'follower-b'
            })
        );
        await waitFor(
            () =>
                receivedEvents.some(
                    event => event.type === 'remoteInstanceHello' && event.senderInstanceId === 'follower-b'
                ),
            'follower-b handshake was not accepted'
        );

        const spoofClose = waitForClose(followerB, 'identity-changing socket was not closed');
        followerB.write(
            serializeEvent({
                type: 'statusUpdated',
                payload: { providerKey: 'test', data: {}, source: 'cache' },
                timestamp: 2,
                senderInstanceId: 'follower-a'
            })
        );
        await spoofClose;
        assert.equal(
            receivedEvents.some(event => event.type === 'statusUpdated' && event.timestamp === 2),
            false
        );
        assert.deepEqual(disconnectedInstanceIds, ['follower-b']);

        const delivery = server.sendToInstance('follower-a', {
            type: 'usagesQueryCompleted',
            payload: {
                requestId: 'query-1',
                targetInstanceId: 'follower-a',
                authorityTerm: 'leader:1',
                result: { kind: 'recentRecords', value: [] }
            },
            timestamp: 3,
            senderInstanceId: 'leader'
        });
        assert.equal(delivery, 'sent');
        await waitFor(
            () => followerAData.join('').includes('"usagesQueryCompleted"'),
            'targeted response was not delivered'
        );

        const duplicate = await connectSocket(pipePath);
        sockets.push(duplicate);
        const duplicateClose = waitForClose(duplicate, 'duplicate identity socket was not closed');
        duplicate.write(
            serializeEvent({
                type: 'remoteInstanceHello',
                payload: {},
                timestamp: 4,
                senderInstanceId: 'follower-a'
            })
        );
        await duplicateClose;

        const unbound = await connectSocket(pipePath);
        sockets.push(unbound);
        let unboundReceived = false;
        unbound.on('data', () => {
            unboundReceived = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        server.broadcast({
            type: 'statusUpdated',
            payload: { providerKey: 'test', data: {}, source: 'cache' },
            timestamp: 5,
            senderInstanceId: 'leader'
        });
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        assert.equal(unboundReceived, false);

        const listeningServer = (server as unknown as { server: unknown }).server;
        const closing = Promise.all([
            waitForClose(followerA, 'bound client was not disconnected'),
            waitForClose(unbound, 'unbound client was not disconnected')
        ]);
        const connections = server as unknown as { disconnectClients: () => void };
        assert.equal(typeof connections.disconnectClients, 'function');
        connections.disconnectClients();
        await closing;
        assert.equal(server.getConnectionCount(), 0);
        assert.deepEqual(server.getConnectedFollowerIds(), []);
        assert.deepEqual(server.getEligibleFollowerIds(), []);
        assert.deepEqual(disconnectedInstanceIds, ['follower-b', 'follower-a']);
        assert.equal((server as unknown as { server: unknown }).server, listeningServer);
        connections.disconnectClients();
        assert.deepEqual(disconnectedInstanceIds, ['follower-b', 'follower-a']);
        const reconnected = await connectSocket(pipePath);
        sockets.push(reconnected);
        reconnected.write(
            serializeEvent({
                type: 'remoteInstanceHello',
                payload: { leaderEligible: false },
                timestamp: 6,
                senderInstanceId: 'follower-a'
            })
        );
        await waitFor(
            () => server!.getConnectedFollowerIds().includes('follower-a'),
            'same listener did not accept the new connection'
        );
    } finally {
        for (const socket of sockets) {
            socket.destroy();
        }
        await server?.stop();
        NodeModule.prototype.require = originalRequire;
    }
});

test('usage query transport requires a matching leader capability', async t => {
    const originalRequire = NodeModule.prototype.require;
    let agentsWindow = false;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                Disposable: class {
                    constructor(private readonly callback: () => void = () => undefined) {}
                    dispose(): void {
                        this.callback();
                    }
                },
                EventEmitter: class<T> {
                    private readonly listeners = new Set<(value: T) => void>();
                    readonly event = (listener: (value: T) => void) => {
                        this.listeners.add(listener);
                        return { dispose: () => this.listeners.delete(listener) };
                    };
                    fire(value: T): void {
                        for (const listener of this.listeners) {
                            listener(value);
                        }
                    }
                    dispose(): void {
                        this.listeners.clear();
                    }
                }
            };
        }
        if (id.endsWith('/leaderElectionService')) {
            return {
                LeaderElectionService: {
                    isLeader: () => false,
                    isAgentsWindow: () => agentsWindow,
                    getInstanceId: () => 'follower'
                }
            };
        }
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, error() {}, info() {}, warn() {} } };
        }
        return originalRequire.call(this, id);
    };

    try {
        const { InterInstanceBus } = await import('./interInstanceBus');
        const bus = InterInstanceBus as unknown as {
            client?: { isConnected: () => boolean };
            dispatchEvent: (event: InterInstanceEvent) => void;
            hasCompatibleUsagesQueryTransport: () => boolean;
            setAuthorityTerm: (authorityTerm: string | undefined) => void;
        };
        Object.assign(InterInstanceBus, {
            instanceId: 'follower',
            extensionVersion: '1.0.0',
            remoteUsagesQueryCompatible: false,
            client: { isConnected: () => true },
            server: undefined,
            handlers: new Map(),
            authorityTerm: undefined
        });

        bus.setAuthorityTerm('leader:1');
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);

        bus.dispatchEvent({
            type: 'remoteInstanceCapabilities',
            payload: {
                targetInstanceId: 'follower',
                extensionVersion: '1.0.0',
                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION
            },
            timestamp: 1,
            senderInstanceId: 'spoofed-follower'
        });
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);

        bus.dispatchEvent({
            type: 'remoteInstanceCapabilities',
            payload: {
                targetInstanceId: 'follower',
                extensionVersion: '0.9.0',
                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION
            },
            timestamp: 1,
            senderInstanceId: 'leader'
        });
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);

        bus.dispatchEvent({
            type: 'remoteInstanceCapabilities',
            payload: {
                targetInstanceId: 'follower',
                extensionVersion: '1.0.0',
                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION
            },
            timestamp: 2,
            senderInstanceId: 'leader'
        });
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), true);

        await t.test('capabilities correct discovery terms only for a valid current leader identity', () => {
            const capability = (
                authorityTerm: unknown,
                senderInstanceId = 'leader',
                targetInstanceId = 'follower'
            ): InterInstanceEvent =>
                ({
                    type: 'remoteInstanceCapabilities',
                    payload: {
                        targetInstanceId,
                        extensionVersion: '1.0.0',
                        usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                        authorityTerm
                    },
                    timestamp: Date.now(),
                    senderInstanceId
                }) as unknown as InterInstanceEvent;
            bus.dispatchEvent(capability('leader:2', 'forged'));
            bus.dispatchEvent(capability('leader:2', 'leader', 'another-follower'));
            for (const term of [
                undefined,
                null,
                2,
                '',
                'other:2',
                'leader:0',
                'leader:-1',
                'leader:NaN',
                'leader:01',
                'leader:9007199254740992'
            ]) {
                bus.dispatchEvent(capability(term));
                assert.equal(InterInstanceBus.getAuthorityTerm(), 'leader:1');
            }
            bus.dispatchEvent(capability('leader:2'));
            assert.equal(InterInstanceBus.getAuthorityTerm(), 'leader:2');
            assert.equal(bus.hasCompatibleUsagesQueryTransport(), true);
        });

        bus.setAuthorityTerm('next-leader:2');
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);

        Object.assign(InterInstanceBus, { client: undefined });
        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);

        const { IpcServer } = await import('./ipcServer');
        const { UsagesQueryCoordinator } = await import('../usages/query/usagesQueryCoordinator');
        const connectionBus = InterInstanceBus as unknown as {
            connectToLeader: () => Promise<void>;
            getLeaderConnectionTarget: () => {
                instanceId: string;
                ipcPath: string;
                authorityTerm: string;
            };
            scheduleReconnect: () => void;
        };
        const originalTarget = connectionBus.getLeaderConnectionTarget;
        const originalReconnect = connectionBus.scheduleReconnect;
        const pipePath =
            process.platform === 'win32' ?
                `\\\\.\\pipe\\gcmp-bus-test-${process.pid}-${Date.now()}`
            :   join(tmpdir(), `gcmp-bus-test-${process.pid}-${Date.now()}.sock`);
        let leaderId = 'leader';
        let authorityTerm = 'leader:1';
        let discoveredTerm: string | undefined;
        let reconnects = 0;
        let localExecutions = 0;
        const receivedEvents: InterInstanceEvent[] = [];
        const server = new IpcServer({
            onMessage: event => {
                receivedEvents.push(event);
                if (event.type === 'remoteInstanceHello') {
                    server.sendToInstance(event.senderInstanceId, {
                        type: 'remoteInstanceCapabilities',
                        payload: {
                            targetInstanceId: event.senderInstanceId,
                            extensionVersion: '1.0.0',
                            usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                            authorityTerm
                        },
                        timestamp: Date.now(),
                        senderInstanceId: leaderId
                    });
                } else if (event.type === 'usagesQueryRequested') {
                    server.sendToInstance(event.senderInstanceId, {
                        type: 'usagesQueryCompleted',
                        payload: {
                            requestId: event.payload.requestId,
                            targetInstanceId: event.senderInstanceId,
                            authorityTerm,
                            result: { kind: 'recentRecords', value: [] }
                        },
                        timestamp: Date.now(),
                        senderInstanceId: leaderId
                    });
                }
            }
        });
        bus.setAuthorityTerm(undefined);
        Object.assign(InterInstanceBus, { initialized: true, context: {} });
        connectionBus.getLeaderConnectionTarget = () => ({
            instanceId: leaderId,
            ipcPath: pipePath,
            authorityTerm: discoveredTerm ?? authorityTerm
        });
        connectionBus.scheduleReconnect = () => {
            reconnects += 1;
        };
        const authoritySubscription = InterInstanceBus.onAuthorityChanged(term => {
            if (term) {
                InterInstanceBus.publishIpcOnly({ type: 'liveMetricsSnapshotRequested', payload: {} });
            }
        });
        const coordinator = new UsagesQueryCoordinator(async () => {
            localExecutions += 1;
            return { kind: 'recentRecords', value: [] };
        });
        try {
            await server.start(pipePath);
            for (const scenario of [
                'initial connection',
                'reconnection',
                'leader change',
                'Agents term change',
                'stale discovery term'
            ]) {
                await t.test(`hello precedes authority listeners on ${scenario}`, async () => {
                    if (scenario === 'reconnection') {
                        await server.stop();
                        await waitFor(() => !InterInstanceBus.hasActiveTransport(), 'client did not disconnect');
                        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);
                        await server.start(pipePath);
                    } else if (scenario === 'leader change') {
                        leaderId = 'next-leader';
                        authorityTerm = 'next-leader:2';
                    } else if (scenario === 'Agents term change') {
                        agentsWindow = true;
                        authorityTerm = 'next-leader:3';
                        const connections = server as unknown as { disconnectClients: () => void };
                        assert.equal(typeof connections.disconnectClients, 'function');
                        connections.disconnectClients();
                        await waitFor(
                            () => !InterInstanceBus.hasActiveTransport(),
                            'old-term client did not disconnect'
                        );
                        assert.equal(InterInstanceBus.getAuthorityTerm(), undefined);
                        assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);
                    } else if (scenario === 'stale discovery term') {
                        authorityTerm = 'next-leader:4';
                        discoveredTerm = 'next-leader:2';
                    }
                    receivedEvents.length = 0;
                    const reconnectsBeforeConnect = reconnects;
                    await connectionBus.connectToLeader();
                    await waitFor(
                        () =>
                            bus.hasCompatibleUsagesQueryTransport() &&
                            receivedEvents.some(event => event.type === 'liveMetricsSnapshotRequested'),
                        'connection was rejected before the capability and snapshot exchange'
                    );
                    assert.deepEqual(
                        receivedEvents.slice(0, 2).map(event => event.type),
                        ['remoteInstanceHello', 'liveMetricsSnapshotRequested']
                    );
                    const hello = receivedEvents.find(event => event.type === 'remoteInstanceHello');
                    assert.equal(hello?.payload.leaderEligible, !agentsWindow);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), authorityTerm);
                    const timestamp = Date.now();
                    const pending: UsagesPendingRecord = {
                        requestId: 'pending-over-socket',
                        timestamp,
                        isoTime: new Date(timestamp).toISOString(),
                        providerKey: 'test',
                        providerName: 'Test',
                        modelId: 'test',
                        modelName: 'Test',
                        estimatedInput: 10,
                        status: 'estimated',
                        rawUsage: null,
                        sessionTitle: '管道中的正式标题',
                        streamStartTime: timestamp + 250,
                        outputSpeed: 12.5
                    };
                    assert.deepEqual(await coordinator.run({ kind: 'recentRecords', limit: 3 }, [pending]), []);
                    assert.deepEqual(
                        receivedEvents.find(event => event.type === 'usagesQueryRequested')?.payload.pendingRecords,
                        [pending]
                    );
                    assert.equal(localExecutions, 0);
                    assert.equal(reconnects, reconnectsBeforeConnect);
                    assert.equal(InterInstanceBus.hasActiveTransport(), true);
                });
            }
        } finally {
            authoritySubscription.dispose();
            coordinator.dispose();
            await InterInstanceBus.dispose();
            await server.stop();
            connectionBus.getLeaderConnectionTarget = originalTarget;
            connectionBus.scheduleReconnect = originalReconnect;
        }
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

test('IPC distinguishes explicit leader candidates from Agents and unknown clients', async () => {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {}, error() {}, info() {}, warn() {} } };
        }
        return originalRequire.call(this, id);
    };
    try {
        const { IpcServer } = await import('./ipcServer');
        const server = new IpcServer();
        const internals = server as unknown as {
            acceptSocketEvents: (socket: Socket, events: InterInstanceEvent[]) => boolean;
            removeSocket: (socket: Socket) => void;
        };
        const sockets = ['normal', 'agents', 'legacy', 'invalid'].map(() => new EventEmitter() as Socket);
        const hello = (instanceId: string, payload: unknown): InterInstanceEvent =>
            ({
                type: 'remoteInstanceHello',
                payload,
                timestamp: 1,
                senderInstanceId: instanceId
            }) as InterInstanceEvent;
        assert.equal(internals.acceptSocketEvents(sockets[0], [hello('normal', { leaderEligible: true })]), true);
        assert.equal(internals.acceptSocketEvents(sockets[1], [hello('agents', { leaderEligible: false })]), true);
        assert.equal(internals.acceptSocketEvents(sockets[2], [hello('legacy', {})]), true);
        assert.equal(internals.acceptSocketEvents(sockets[3], [hello('invalid', { leaderEligible: 'true' })]), false);
        assert.deepEqual(server.getConnectedFollowerIds(), ['normal', 'agents', 'legacy']);
        assert.deepEqual(server.getEligibleFollowerIds(), ['normal']);
        assert.equal(internals.acceptSocketEvents(sockets[1], [hello('agents', { leaderEligible: true })]), true);
        assert.deepEqual(server.getEligibleFollowerIds(), ['normal']);
        internals.removeSocket(sockets[0]);
        assert.deepEqual(server.getEligibleFollowerIds(), []);
        await server.stop();
        assert.deepEqual(server.getConnectedFollowerIds(), []);
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

test('IPC handoff requires the nominated socket before notifying other followers', async () => {
    const { IpcServer } = await import('./ipcServer');
    const { InterInstanceBus } = await import('./interInstanceBus');
    const bus = InterInstanceBus as unknown as {
        server: InstanceType<typeof IpcServer> | undefined;
        initialized: boolean;
        context: unknown;
        instanceId: string | undefined;
    };
    const previous = {
        server: bus.server,
        initialized: bus.initialized,
        context: bus.context,
        instanceId: bus.instanceId
    };
    for (const outcome of ['sent', 'missing', 'write-error'] as const) {
        const writes: string[] = [];
        const server = new IpcServer();
        const internals = server as unknown as {
            sockets: Set<Socket>;
            acceptSocketEvents: (socket: Socket, events: InterInstanceEvent[]) => boolean;
        };
        const connectFake = (instanceId: string): Socket => {
            const socket = new EventEmitter() as Socket;
            Object.assign(socket, {
                write: () => {
                    if (instanceId === 'nominee' && outcome === 'write-error') {
                        throw new Error('write failed');
                    }
                    writes.push(instanceId);
                    return true;
                },
                destroy: () => socket
            });
            internals.sockets.add(socket);
            assert.equal(
                internals.acceptSocketEvents(socket, [
                    {
                        type: 'remoteInstanceHello',
                        payload: { leaderEligible: true },
                        timestamp: 1,
                        senderInstanceId: instanceId
                    }
                ]),
                true
            );
            return socket;
        };
        connectFake('observer');
        if (outcome !== 'missing') {
            connectFake('nominee');
        }
        Object.assign(bus, { server, initialized: true, context: {}, instanceId: 'leader' });
        try {
            assert.equal(
                InterInstanceBus.publishIpcOnly(
                    {
                        type: 'leaderResigning',
                        payload: { leaderId: 'leader', nextLeaderId: 'nominee', reason: 'manual' }
                    },
                    'nominee'
                ),
                outcome === 'sent'
            );
            assert.deepEqual(writes, outcome === 'sent' ? ['nominee', 'observer'] : []);
        } finally {
            await server.stop();
            Object.assign(bus, previous);
        }
    }
});
