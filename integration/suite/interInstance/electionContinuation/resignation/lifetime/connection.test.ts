import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import type {
    InterInstanceEvent,
    RemoteInstanceCapabilitiesEvent
} from '../../../../../../src/interInstance/eventProtocol';
import type { IpcClient } from '../../../../../../src/interInstance/ipcClient';
import { IpcServer } from '../../../../../../src/interInstance/ipcServer';
import { resolveIpcPath } from '../../../../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../leaderLiveness/fixture';
import { deferred } from '../../fixture';
import type { Election } from '../fixture';
interface ConnectionState {
    client: IpcClient | undefined;
    getLeaderConnectionTarget(): { instanceId: string; authorityTerm?: string; ipcPath: string } | undefined;
}
function sendCapability(server: IpcServer, leaderId: string, followerId: string, term: string): void {
    const event: RemoteInstanceCapabilitiesEvent = {
        type: 'remoteInstanceCapabilities',
        senderInstanceId: leaderId,
        timestamp: Date.now(),
        payload: {
            targetInstanceId: followerId,
            extensionVersion: '1.0.0',
            usagesQueryProtocolVersion: 1,
            leaderLivenessProtocolVersion: 1,
            authorityTerm: term
        }
    };
    assert.equal(server.sendToInstance(followerId, event), 'sent');
}
suite('Connection authority and accepted resignation lifetime', () => {
    for (const late of [false, true]) {
        test(`replacement/late-old-capability=${late}: new connection requires its own capability handshake`, async () => {
            const f = await createLivenessFixture(0);
            const state = InterInstanceBus as unknown as ConnectionState;
            const oldClient = state.client;
            const oldDisconnect = oldClient?.disconnect;
            const oldTarget = state.getLeaderConnectionTarget;
            const entered = deferred();
            const release = deferred();
            const delivered = deferred();
            const events: InterInstanceEvent[] = [];
            const server = new IpcServer({
                onMessage: event => {
                    events.push(event);
                }
            });
            const target = {
                instanceId: f.identity.instanceId,
                authorityTerm: `${f.identity.instanceId}:${f.identity.electedAt + 1}`,
                ipcPath: resolveIpcPath(randomUUID())
            };
            let socket: Socket | undefined;
            let buffer = '';
            const onData = (data: Buffer) => {
                buffer += data.toString('utf8');
                if (buffer.includes(target.authorityTerm)) {
                    delivered.resolve();
                }
            };
            let pending: Promise<void> | undefined;
            try {
                assert.ok(oldClient && oldDisconnect);
                socket = (oldClient as unknown as { socket: Socket | undefined }).socket;
                assert.ok(socket);
                await server.start(target.ipcPath);
                oldClient.disconnect = async () => {
                    entered.resolve();
                    await release.promise;
                    await oldDisconnect.call(oldClient);
                };
                state.getLeaderConnectionTarget = () => ({ ...target });
                pending = f.bus.connectToLeader();
                await entered.promise;
                assert.equal(InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm, undefined);
                if (late) {
                    socket.on('data', onData);
                    sendCapability(f.server, f.identity.instanceId, f.followerId, target.authorityTerm);
                    await delivered.promise;
                }
                release.resolve();
                await pending;
                await waitFor(() => events.some(event => event.type === 'remoteInstanceHello'));
                assert.notEqual(state.client, oldClient);
                assert.equal(state.client?.isConnected(), true);
                assert.equal(InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm, undefined);
                assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                sendCapability(server, f.identity.instanceId, f.followerId, target.authorityTerm);
                await waitFor(
                    () => InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm === target.authorityTerm
                );
                assert.equal(f.bus.remoteLeaderLivenessCompatible, true);
            } finally {
                release.resolve();
                try {
                    await pending;
                } finally {
                    socket?.off('data', onData);
                    if (oldClient && oldDisconnect) {
                        oldClient.disconnect = oldDisconnect;
                    }
                    state.getLeaderConnectionTarget = oldTarget;
                    try {
                        await f.dispose();
                    } finally {
                        await server.stop();
                    }
                }
            }
        });
    }
    for (const branch of ['self', 'none', 'other'] as const) {
        for (const change of [
            'source-open',
            'source-close',
            'new-capability',
            'confirmed-ABA',
            'explicit-cancellation',
            'expiry',
            'stop',
            'restart'
        ] as const) {
            if (change === 'source-open' && branch !== 'none') {
                continue;
            }
            test(`${branch}/${change}: only a still-valid accepted notification survives normal source close`, async () => {
                const f = await createLivenessFixture(0);
                const election = f.election as Election;
                const original = {
                    takeoverAsNominated: election.takeoverAsNominated,
                    waitForNominatedTakeover: election.waitForNominatedTakeover,
                    recoverAfterLeaderResigning: election.recoverAfterLeaderResigning
                };
                const originalTimeout = globalThis.setTimeout;
                const originalNow = Date.now;
                const entered = deferred();
                const release = deferred();
                const pending: Promise<void>[] = [];
                const calls: string[] = [];
                const recoveries: Array<{ storage: ReturnType<typeof f.read>; elapsed: number }> = [];
                const acceptedAt = originalNow();
                let now = acceptedAt;
                let timer: NodeJS.Timeout | undefined;
                let blocked = false;
                const track = (name: string, operation: Promise<void>) => {
                    calls.push(name);
                    pending.push(operation);
                    return operation;
                };
                election.takeoverAsNominated = (...args) =>
                    track('self', original.takeoverAsNominated.call(election, ...args));
                election.waitForNominatedTakeover = (...args) =>
                    track('other', original.waitForNominatedTakeover.call(election, ...args));
                election.recoverAfterLeaderResigning = (...args) => {
                    recoveries.push({ storage: f.read(), elapsed: now - acceptedAt });
                    return track('none', original.recoverAfterLeaderResigning.call(election, ...args));
                };
                Date.now = () => now;
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    if (branch === 'other' && args[1] === 200 && blocked) {
                        return originalTimeout(() => {
                            now += 200;
                            args[0](undefined);
                        }, 0);
                    }
                    if (args[1] !== (branch === 'other' ? 200 : 100) || blocked) {
                        return originalTimeout(...args);
                    }
                    blocked = true;
                    timer = originalTimeout(() => {}, 60_000);
                    entered.resolve();
                    void release.promise.then(() => args[0](undefined));
                    return timer;
                }) as typeof setTimeout;
                try {
                    LeaderElectionService.subscribeToLeaderResigning();
                    assert.equal(
                        f.server.sendToInstance(f.followerId, {
                            type: 'leaderResigning',
                            senderInstanceId: f.identity.instanceId,
                            timestamp: now,
                            payload: {
                                leaderId: f.identity.instanceId,
                                reason: 'manual',
                                sourceAuthorityTerm: f.identity.authorityTerm,
                                nextLeaderId:
                                    branch === 'self' ? f.followerId
                                    : branch === 'other' ? 'nominated-other'
                                    : undefined
                            }
                        }),
                        'sent'
                    );
                    await entered.promise;
                    assert.ok(pending[0]);
                    assert.deepEqual(calls, [branch]);
                    assert.equal(f.updates.length, branch === 'other' ? 0 : 1);
                    const before = InterInstanceBus.getConfirmedLeaderAuthority();
                    assert.equal(before.authorityTerm, f.identity.authorityTerm);
                    if (change === 'new-capability' || change === 'confirmed-ABA') {
                        const term = `${f.identity.instanceId}:${f.identity.electedAt + 1}`;
                        sendCapability(f.server, f.identity.instanceId, f.followerId, term);
                        await waitFor(() => InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm === term);
                        if (change === 'confirmed-ABA') {
                            sendCapability(f.server, f.identity.instanceId, f.followerId, f.identity.authorityTerm);
                            await waitFor(
                                () =>
                                    InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm ===
                                    f.identity.authorityTerm
                            );
                        }
                        assert.ok(InterInstanceBus.getConfirmedLeaderAuthority().generation > before.generation);
                    }
                    if (change !== 'source-open') {
                        await f.server.stop();
                        await waitFor(() => !f.bus.clientTarget);
                        assert.equal(InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm, undefined);
                        assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                    }
                    const closedGeneration = InterInstanceBus.getConfirmedLeaderAuthority().generation;
                    if (change === 'explicit-cancellation') {
                        InterInstanceBus.cancelLeaderLiveness();
                        assert.ok(InterInstanceBus.getConfirmedLeaderAuthority().generation > closedGeneration);
                    } else if (change === 'expiry') {
                        now += 10_001;
                    } else if (change === 'stop' || change === 'restart') {
                        await LeaderElectionService.stop();
                        if (change === 'restart') {
                            LeaderElectionService.initialize(f.context);
                            clearTimeout(election.startTimer);
                            election.startTimer = undefined;
                        }
                    }
                    if (branch === 'other') {
                        assert.deepEqual(f.read(), f.record);
                        // 首次 200ms 等待晚恢复 200ms，再完成下一次 200ms 等待。
                        now += 400;
                    }
                    const writes = f.updates.length;
                    release.resolve();
                    await Promise.all(pending);
                    const permitted = change === 'source-open' || change === 'source-close';
                    assert.equal(LeaderElectionService.isLeader(), permitted);
                    assert.deepEqual(f.roles, permitted ? [true] : []);
                    if (permitted) {
                        assert.equal(f.updates.length, 1);
                        assert.equal(f.read()?.instanceId, f.followerId);
                        assert.equal(
                            LeaderElectionService.getOwnedAuthorityTerm(),
                            `${f.followerId}:${f.read()?.electedAt}`
                        );
                        if (branch === 'other') {
                            assert.deepEqual(calls, ['other', 'none']);
                            assert.deepEqual(recoveries[0].storage, f.record);
                            assert.equal(recoveries[0].elapsed, 600);
                        }
                    } else {
                        assert.equal(f.updates.length, writes);
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                        if (change !== 'stop' && change !== 'restart') {
                            await f.election.checkLeader();
                            assert.equal(LeaderElectionService.isLeader(), false);
                            assert.deepEqual(f.roles, []);
                        }
                    }
                } finally {
                    release.resolve();
                    clearTimeout(timer);
                    try {
                        await Promise.all(pending);
                    } finally {
                        Object.assign(election, original);
                        globalThis.setTimeout = originalTimeout;
                        Date.now = originalNow;
                        await f.dispose();
                    }
                }
            });
        }
    }
    test('ordinary source close without a notification cannot grant force takeover authority', async () => {
        const f = await createLivenessFixture(0);
        try {
            LeaderElectionService.subscribeToLeaderResigning();
            await f.server.stop();
            await waitFor(() => !f.bus.clientTarget);
            assert.equal(InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm, undefined);
            assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
            await f.election.checkLeader();
            f.assertUnchangedFollower();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
        } finally {
            await f.dispose();
        }
    });
});
