import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import { IpcClient } from '../../../../src/interInstance/ipcClient';
import { IpcServer } from '../../../../src/interInstance/ipcServer';
import { resolveIpcPath } from '../../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from './fixture';

type Fixture = Awaited<ReturnType<typeof createLivenessFixture>>;

function stallOldPeer(f: Fixture) {
    const bindings = (f.server as unknown as { socketInstanceIds: Map<Socket, string> }).socketInstanceIds;
    const peer = [...bindings].find(([, id]) => id === f.followerId)?.[0];
    assert.ok(peer, 'old leader must have completed its handshake');
    const client = f.bus.client;
    assert.ok(client);
    const socket = (client as unknown as { socket: Socket }).socket;
    peer.pause();
    for (let index = 0; index < 1024; index++) {
        client.send({
            type: 'statusUpdated',
            payload: { providerKey: 'close-test', source: 'cache', data: 'x'.repeat(4096) },
            timestamp: 1,
            senderInstanceId: f.followerId
        });
    }
    assert.ok(socket.writableLength > 0, 'old connection must have pending writes');
    return { peer, socket };
}

suite('Stalled old IPC connection does not block role recovery', () => {
    test('new leader connects and its stats completion is accepted while old peer remains paused', async () => {
        const f = await createLivenessFixture(0);
        const nextId = randomUUID();
        const electedAt = Date.now();
        const term = `${nextId}:${electedAt}`;
        const received: string[] = [];
        const server = new IpcServer({
            onMessage: event => {
                if (event.type === 'statsRefreshRequested') {
                    for (const senderInstanceId of [f.identity.instanceId, nextId]) {
                        server.broadcast({
                            type: 'statsRefreshCompleted',
                            payload: {
                                requestId: `${event.payload.requestId}:${senderInstanceId}`,
                                regeneratedDates: []
                            },
                            timestamp: Date.now(),
                            senderInstanceId
                        });
                    }
                }
            }
        });
        const subscription = InterInstanceBus.subscribe('statsRefreshCompleted', event => {
            if (event.type === 'statsRefreshCompleted') {
                received.push(event.payload.requestId);
            }
        });
        let stalled: ReturnType<typeof stallOldPeer> | undefined;
        try {
            await server.start(resolveIpcPath(nextId));
            stalled = stallOldPeer(f);
            await f.write({ instanceId: nextId, electedAt, lastHeartbeat: Date.now() });
            await f.election.checkLeader();
            await waitFor(() => f.bus.clientTarget?.authorityTerm === term);
            await f.bus.roleSwitchChain;
            assert.equal(stalled.peer.isPaused(), true);
            assert.equal(stalled.socket.destroyed, true);
            assert.equal(InterInstanceBus.getAuthorityTerm(), term);
            assert.equal(LeaderElectionService.isLeader(), false);
            const requestId = randomUUID();
            assert.equal(
                InterInstanceBus.publishIpcOnly({
                    type: 'statsRefreshRequested',
                    payload: { requestId, regenerateAll: false, requestedBy: f.followerId }
                }),
                true
            );
            await waitFor(() => received.length > 0);
            assert.deepEqual(received, [`${requestId}:${nextId}`]);
            assert.equal(stalled.peer.isPaused(), true);
        } finally {
            stalled?.peer.destroy();
            subscription.dispose();
            await f.dispose();
            await server.stop();
        }
    });

    test('stale unresponsive leader can be replaced by a serving local leader without draining old writes', async () => {
        const f = await createLivenessFixture();
        let completed = false;
        const requestId = randomUUID();
        const follower = new IpcClient({
            onMessage: event => {
                if (event.type === 'statsRefreshCompleted' && event.payload.requestId === requestId) {
                    assert.equal(event.senderInstanceId, f.followerId);
                    completed = true;
                }
            }
        });
        const subscription = InterInstanceBus.subscribe('statsRefreshRequested', event => {
            if (event.type === 'statsRefreshRequested' && event.payload.requestId === requestId) {
                assert.equal(
                    InterInstanceBus.publishIpcOnly({
                        type: 'statsRefreshCompleted',
                        payload: { requestId, regeneratedDates: [] }
                    }),
                    true
                );
            }
        });
        let stalled: ReturnType<typeof stallOldPeer> | undefined;
        try {
            stalled = stallOldPeer(f);
            await f.election.checkLeader();
            assert.equal(LeaderElectionService.isLeader(), true, 'real stale-leader election must complete');
            await waitFor(() => !!f.bus.server);
            await f.bus.roleSwitchChain;
            assert.equal(stalled.peer.isPaused(), true);
            assert.equal(stalled.socket.destroyed, true);
            assert.equal(f.bus.client, undefined);
            assert.equal(InterInstanceBus.getAuthorityTerm(), LeaderElectionService.getOwnedAuthorityTerm());
            assert.ok(InterInstanceBus.getAuthorityTerm());
            await follower.connect(resolveIpcPath(f.followerId));
            follower.send({
                type: 'remoteInstanceHello',
                payload: { leaderEligible: true },
                timestamp: Date.now(),
                senderInstanceId: 'replacement-follower'
            });
            follower.send({
                type: 'statsRefreshRequested',
                payload: { requestId, regenerateAll: false, requestedBy: 'replacement-follower' },
                timestamp: Date.now(),
                senderInstanceId: 'replacement-follower'
            });
            await waitFor(() => completed);
            assert.equal(stalled.peer.isPaused(), true);
        } finally {
            stalled?.peer.destroy();
            await follower.disconnect();
            subscription.dispose();
            await f.dispose();
        }
    });

    for (const switching of [false, true]) {
        test(`dispose ${switching ? 'during a role switch' : 'with an active client'} drains without old peer recovery`, async () => {
            const f = await createLivenessFixture(0);
            let stalled: ReturnType<typeof stallOldPeer> | undefined;
            let disposing: Promise<void> | undefined;
            try {
                stalled = stallOldPeer(f);
                if (switching) {
                    await f.write({ instanceId: randomUUID(), electedAt: Date.now(), lastHeartbeat: Date.now() });
                    await f.election.checkLeader();
                    await waitFor(() => f.bus.client === undefined);
                }
                let disposed = false;
                disposing = InterInstanceBus.dispose().then(() => {
                    disposed = true;
                });
                await waitFor(() => disposed);
                assert.equal(stalled.peer.isPaused(), true);
                assert.equal(stalled.socket.destroyed, true);
                assert.equal(f.bus.initialized, false);
                assert.equal(f.bus.client, undefined);
                assert.equal(f.bus.server, undefined);
                assert.equal(f.bus.clientTarget, undefined);
                assert.equal(
                    (f.bus as unknown as { reconnectTimer: NodeJS.Timeout | undefined }).reconnectTimer,
                    undefined
                );
            } finally {
                stalled?.peer.destroy();
                await disposing;
                await f.dispose();
            }
        });
    }
});
