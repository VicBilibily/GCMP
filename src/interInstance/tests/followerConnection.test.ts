import assert from 'node:assert/strict';
import test from 'node:test';
import type { IpcClient } from '../ipcClient';
import { USAGES_QUERY_PROTOCOL_VERSION, type InterInstanceEvent } from '../eventProtocol';
import { createIpcHost, ipcPath, waitFor } from './ipcFixture';

interface ConnectionTarget {
    instanceId: string;
    ipcPath: string;
    authorityTerm?: string;
}

interface BusState {
    client?: IpcClient;
    clientTarget?: ConnectionTarget;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    reconnectAttempts: number;
    roleSwitchChain: Promise<void>;
    getLeaderConnectionTarget(): ConnectionTarget | undefined;
    startFallbackTransport(): void;
    connectToLeader(): Promise<void>;
    scheduleReconnect(): void;
    enqueueRoleSwitch(leader: boolean): void;
}

test('Follower connection reuse preserves identity and lifecycle boundaries', async t => {
    const host = await createIpcHost();
    t.after(() => host.restore());
    const { InterInstanceBus: bus } = host;
    const state = bus as unknown as BusState;

    const fixture = async (pendingRetry = false, correctedTerm?: string) => {
        host.logs.length = 0;
        host.election.leader = false;
        const context = host.context();
        const target: ConnectionTarget = {
            instanceId: 'flow-leader',
            ipcPath: ipcPath(),
            authorityTerm: 'flow-leader:1'
        };
        const events: InterInstanceEvent[] = [];
        const servers: InstanceType<typeof host.IpcServer>[] = [];
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const originalTarget = state.getLeaderConnectionTarget;
        const originalFallback = state.startFallbackTransport;
        const startServer = async (pipe: string) => {
            const server = new host.IpcServer({
                onMessage: event => {
                    events.push(event);
                    if (event.type === 'remoteInstanceHello') {
                        server.sendToInstance(event.senderInstanceId, {
                            type: 'remoteInstanceCapabilities',
                            payload: {
                                targetInstanceId: event.senderInstanceId,
                                extensionVersion: '1.0.0',
                                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                                authorityTerm: correctedTerm ?? target.authorityTerm
                            },
                            timestamp: Date.now(),
                            senderInstanceId: target.instanceId
                        });
                    }
                }
            });
            servers.push(server);
            await server.start(pipe);
            return server;
        };
        const dispose = async () => {
            clearTimeout(retryTimer);
            await bus.dispose();
            for (const subscription of context.subscriptions) {
                subscription.dispose();
            }
            for (const server of servers) {
                await server.stop();
            }
            state.getLeaderConnectionTarget = originalTarget;
            state.startFallbackTransport = originalFallback;
        };
        try {
            const server = await startServer(target.ipcPath);
            state.getLeaderConnectionTarget = () => ({ ...target });
            state.startFallbackTransport = () => {};
            bus.initialize(context);
            let retry: (() => void) | undefined;
            if (pendingRetry) {
                state.reconnectAttempts = 4;
                state.scheduleReconnect();
                retryTimer = state.reconnectTimer;
                retry = (retryTimer as unknown as { _onTimeout: () => void })._onTimeout;
            }
            await state.roleSwitchChain;
            await waitFor(() => bus.hasCompatibleUsagesQueryTransport(), 'capability handshake missing');
            const client = state.client!;
            const hellos = () => events.filter(event => event.type === 'remoteInstanceHello').length;
            assert.equal(hellos(), 1);
            return { server, target, events, client, retry, hellos, startServer, dispose };
        } catch (error) {
            await dispose();
            throw error;
        }
    };

    for (const mode of ['direct', 'role-and-identity', 'late-retry', 'corrected-discovery'] as const) {
        await t.test(`${mode} retains the same healthy client and capability`, async () => {
            const f = await fixture(
                mode === 'late-retry',
                mode === 'corrected-discovery' ? 'flow-leader:2' : undefined
            );
            try {
                if (mode === 'direct') {
                    await state.connectToLeader();
                } else if (mode === 'late-retry') {
                    f.retry!();
                    await state.roleSwitchChain;
                } else {
                    host.role.fire(false);
                    host.identity.fire({
                        instanceId: f.target.instanceId,
                        electedAt: 1,
                        authorityTerm: f.target.authorityTerm!
                    });
                    await state.roleSwitchChain;
                }
                assert.equal(state.client === f.client, true);
                assert.equal(f.client.isConnected(), true);
                assert.equal(bus.hasCompatibleUsagesQueryTransport(), true);
                assert.equal(
                    bus.getAuthorityTerm(),
                    mode === 'corrected-discovery' ? 'flow-leader:2' : 'flow-leader:1'
                );
                assert.equal(f.hellos(), 1);
                assert.equal(state.reconnectTimer, undefined);
            } finally {
                await f.dispose();
            }
        });
    }

    for (const timing of ['before-connect', 'while-connected'] as const) {
        await t.test(`success cancels a retry scheduled ${timing}`, async () => {
            const f = await fixture(timing === 'before-connect');
            try {
                if (timing === 'while-connected') {
                    state.reconnectAttempts = 4;
                    state.scheduleReconnect();
                    assert.ok(state.reconnectTimer);
                    await state.connectToLeader();
                }
                assert.equal(state.reconnectTimer, undefined);
                assert.equal(state.reconnectAttempts, 0);
                assert.equal(state.client === f.client, true);
            } finally {
                await f.dispose();
            }
        });
    }

    for (const change of ['term', 'path', 'leader'] as const) {
        await t.test(`${change} change still replaces the connection and repeats the handshake`, async () => {
            const f = await fixture();
            try {
                if (change === 'path') {
                    f.target.ipcPath = ipcPath();
                    await f.startServer(f.target.ipcPath);
                } else if (change === 'leader') {
                    f.target.instanceId = 'next-leader';
                    f.target.authorityTerm = 'next-leader:2';
                } else {
                    f.target.authorityTerm = 'flow-leader:2';
                }
                state.enqueueRoleSwitch(false);
                await state.roleSwitchChain;
                await waitFor(
                    () => f.hellos() === 2 && bus.hasCompatibleUsagesQueryTransport(),
                    'replacement handshake missing'
                );
                assert.notEqual(state.client, f.client);
                assert.equal(f.client.isConnected(), false);
                assert.equal(bus.getAuthorityTerm(), f.target.authorityTerm);
                assert.equal(state.reconnectTimer, undefined);
            } finally {
                await f.dispose();
            }
        });
    }

    await t.test('remote close reconnects the same target without retaining an obsolete retry', async () => {
        const f = await fixture();
        try {
            f.server.disconnectClients();
            await waitFor(() => !bus.hasActiveTransport(), 'remote close missing');
            assert.ok(state.reconnectTimer);
            assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);
            await state.connectToLeader();
            await waitFor(() => f.hellos() === 2 && bus.hasCompatibleUsagesQueryTransport(), 'reconnect missing');
            assert.notEqual(state.client, f.client);
            assert.equal(state.reconnectTimer, undefined);
            assert.match(host.logs.map(value => value.message).join('\n'), /reason=transport-close/);
        } finally {
            await f.dispose();
        }
    });

    await t.test('connection failure does not reuse the previous successful target', async () => {
        const f = await fixture();
        try {
            f.target.ipcPath = ipcPath();
            await state.connectToLeader();
            assert.equal(state.client, undefined);
            assert.equal(state.clientTarget, undefined);
            assert.equal(bus.hasCompatibleUsagesQueryTransport(), false);
            assert.ok(state.reconnectTimer);
        } finally {
            await f.dispose();
        }
    });

    await t.test('dispose invalidates queued role tasks and releases the retained target', async () => {
        const f = await fixture();
        try {
            state.enqueueRoleSwitch(false);
            state.enqueueRoleSwitch(false);
            await bus.dispose();
            assert.equal(state.client, undefined);
            assert.equal(state.clientTarget, undefined);
            assert.equal(state.reconnectTimer, undefined);
            assert.equal(f.hellos(), 1);
            assert.equal(f.client.isConnected(), false);
        } finally {
            await f.dispose();
        }
    });

    await t.test('duplicate role tasks do not cancel an in-flight usage query', async () => {
        const f = await fixture();
        const { UsagesQueryCoordinator } = await import('../../usages/query/usagesQueryCoordinator');
        let localExecutions = 0;
        const coordinator = new UsagesQueryCoordinator(async () => {
            localExecutions++;
            return { kind: 'recentRecords', value: [] };
        });
        let query: Promise<unknown> | undefined;
        try {
            query = coordinator.run({ kind: 'recentRecords', limit: 3 });
            await waitFor(() => f.events.some(value => value.type === 'usagesQueryRequested'), 'remote query missing');
            state.enqueueRoleSwitch(false);
            state.enqueueRoleSwitch(false);
            await state.roleSwitchChain;
            assert.equal(state.client === f.client, true);
            const request = f.events.find(value => value.type === 'usagesQueryRequested')!;
            assert.equal(
                f.server.sendToInstance('flow-follower', {
                    type: 'usagesQueryCompleted',
                    payload: {
                        requestId: request.payload.requestId,
                        targetInstanceId: 'flow-follower',
                        authorityTerm: 'flow-leader:1',
                        result: { kind: 'recentRecords', value: [] }
                    },
                    timestamp: Date.now(),
                    senderInstanceId: 'flow-leader'
                }),
                'sent'
            );
            assert.deepEqual(await query, []);
            assert.equal(localExecutions, 0);
        } finally {
            coordinator.dispose();
            await query;
            await f.dispose();
        }
    });
});
