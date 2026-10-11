import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { InterInstanceBus } from '../../../../src/interInstance/interInstanceBus';
import type { InterInstanceEvent } from '../../../../src/interInstance/eventProtocol';
import { IpcClient } from '../../../../src/interInstance/ipcClient';
import { resolveIpcPath } from '../../../../src/interInstance/pathResolver';
import { createLivenessFixture, waitFor } from './fixture';

suite('Leader liveness IPC protocol boundaries', () => {
    for (const responsive of [true, false]) {
        test(`new IPC authority with stale stored term, responsive=${responsive}, is checked before takeover`, async () => {
            const f = await createLivenessFixture();
            try {
                const electedAt = f.record.electedAt + 1;
                const term = `${f.identity.instanceId}:${electedAt}`;
                await f.leaderContext.globalState.update('gcmp.leader.info.v2', {
                    ...f.record,
                    electedAt,
                    lastHeartbeat: Date.now()
                });
                f.setResponder(event => {
                    if (responsive) {
                        f.withLeader(() => {
                            f.election.ownElectedAt = electedAt;
                            f.bus.dispatchEvent(event, 'ipc');
                        });
                    }
                });
                f.server.sendToInstance(f.followerId, {
                    type: 'remoteInstanceCapabilities',
                    timestamp: Date.now(),
                    senderInstanceId: f.identity.instanceId,
                    payload: {
                        targetInstanceId: f.followerId,
                        extensionVersion: 'different',
                        usagesQueryProtocolVersion: 1,
                        authorityTerm: term,
                        leaderLivenessProtocolVersion: 1
                    }
                });
                await waitFor(() => InterInstanceBus.getAuthorityTerm() === term);
                const start = performance.now();
                await f.election.checkLeader();
                if (responsive) {
                    f.assertUnchangedFollower();
                } else {
                    assert.ok(performance.now() - start >= 990);
                    assert.equal(f.updates.length, 1);
                    assert.deepEqual(f.roles, [true]);
                }
                const requests = f.events.filter(event => event.type === 'leaderLivenessRequested');
                assert.equal(requests.length, 1);
                assert.equal(requests[0].payload.authorityTerm, term);
            } finally {
                await f.dispose();
            }
        });
    }
    for (const version of [undefined, 0, 2]) {
        test(`peer liveness capability ${version} preserves compatibility fallback`, async () => {
            const f = await createLivenessFixture();
            try {
                const received = InterInstanceBus.subscribe('remoteInstanceCapabilities', () => {});
                f.server.sendToInstance(f.followerId, {
                    type: 'remoteInstanceCapabilities',
                    timestamp: Date.now(),
                    senderInstanceId: f.identity.instanceId,
                    payload: {
                        targetInstanceId: f.followerId,
                        extensionVersion: 'older',
                        usagesQueryProtocolVersion: 1,
                        authorityTerm: f.identity.authorityTerm,
                        leaderLivenessProtocolVersion: version
                    }
                });
                try {
                    await waitFor(() => !f.bus.remoteLeaderLivenessCompatible);
                } finally {
                    received.dispose();
                }
                assert.equal(await InterInstanceBus.confirmLeaderLiveness(f.identity), 'unconfirmed');
                assert.equal(f.events.filter(event => event.type === 'leaderLivenessRequested').length, 0);
            } finally {
                await f.dispose();
            }
        });
    }

    test('IPC liveness compatibility is independent of extension and usages capability version', async () => {
        const f = await createLivenessFixture();
        try {
            f.bus.remoteLeaderLivenessCompatible = false;
            f.server.sendToInstance(f.followerId, {
                type: 'remoteInstanceCapabilities',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: {
                    targetInstanceId: f.followerId,
                    extensionVersion: 'different',
                    usagesQueryProtocolVersion: 99,
                    authorityTerm: f.identity.authorityTerm,
                    leaderLivenessProtocolVersion: 1
                }
            });
            await waitFor(() => f.bus.remoteLeaderLivenessCompatible);
            assert.equal(InterInstanceBus.hasCompatibleUsagesQueryTransport(), false);
            assert.equal(await InterInstanceBus.confirmLeaderLiveness(f.identity), 'alive');
            f.assertUnchangedFollower();
        } finally {
            await f.dispose();
        }
    });

    test('fallback capability cannot grant IPC liveness eligibility or answer a request', async () => {
        const f = await createLivenessFixture();
        try {
            f.bus.remoteLeaderLivenessCompatible = false;
            f.bus.dispatchEvent({
                type: 'remoteInstanceCapabilities',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: {
                    targetInstanceId: f.followerId,
                    extensionVersion: 'different',
                    usagesQueryProtocolVersion: 1,
                    authorityTerm: f.identity.authorityTerm,
                    leaderLivenessProtocolVersion: 1
                }
            });
            assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
            const reply = InterInstanceBus.publishToInstance;
            let replies = 0;
            InterInstanceBus.publishToInstance = () => {
                replies++;
                return 'sent';
            };
            try {
                f.withLeader(() =>
                    f.bus.dispatchEvent({
                        type: 'leaderLivenessRequested',
                        timestamp: Date.now(),
                        senderInstanceId: f.followerId,
                        payload: {
                            requestId: randomUUID(),
                            targetInstanceId: f.identity.instanceId,
                            authorityTerm: f.identity.authorityTerm
                        }
                    })
                );
                assert.equal(replies, 0);
            } finally {
                InterInstanceBus.publishToInstance = reply;
            }
        } finally {
            await f.dispose();
        }
    });

    test('real IPC sends a targeted liveness reply without relaying the request to observers', async () => {
        const f = await createLivenessFixture();
        const seen: InterInstanceEvent[] = [];
        const observerId = randomUUID();
        const observer = new IpcClient({
            onMessage: event => {
                seen.push(event);
            },
            onDisconnect: () => {}
        });
        try {
            await observer.connect(resolveIpcPath(f.identity.instanceId));
            observer.send({
                type: 'remoteInstanceHello',
                timestamp: Date.now(),
                senderInstanceId: observerId,
                payload: {}
            });
            await waitFor(() => seen.some(event => event.type === 'remoteInstanceCapabilities'));
            assert.equal(await InterInstanceBus.confirmLeaderLiveness(f.identity), 'alive');
            const request = f.events.find(event => event.type === 'leaderLivenessRequested');
            assert.ok(request && request.type === 'leaderLivenessRequested');
            observer.send({
                type: 'leaderLivenessRequested',
                timestamp: Date.now(),
                senderInstanceId: observerId,
                payload: {
                    requestId: 'observer-barrier',
                    targetInstanceId: f.identity.instanceId,
                    authorityTerm: f.identity.authorityTerm
                }
            });
            await waitFor(() =>
                seen.some(
                    event => event.type === 'leaderLivenessConfirmed' && event.payload.requestId === 'observer-barrier'
                )
            );
            assert.equal(
                seen.some(event => event.type === 'leaderLivenessRequested'),
                false
            );
            assert.equal(
                seen.some(
                    event =>
                        event.type === 'leaderLivenessConfirmed' &&
                        event.payload.requestId === request.payload.requestId
                ),
                false
            );
            f.assertUnchangedFollower();
        } finally {
            await observer.disconnect();
            await f.dispose();
        }
    });

    test('follower socket cannot impersonate an authoritative liveness reply', async () => {
        const f = await createLivenessFixture();
        const attackerId = randomUUID();
        const attacker = new IpcClient({ onMessage: () => {}, onDisconnect: () => {} });
        try {
            await attacker.connect(resolveIpcPath(f.identity.instanceId));
            attacker.send({
                type: 'remoteInstanceHello',
                timestamp: Date.now(),
                senderInstanceId: attackerId,
                payload: {}
            });
            await waitFor(() => f.server.getConnectedFollowerIds().includes(attackerId));
            f.setResponder(() => {});
            const pending = InterInstanceBus.confirmLeaderLiveness(f.identity);
            await waitFor(() => f.events.some(event => event.type === 'leaderLivenessRequested'));
            const request = f.events.find(event => event.type === 'leaderLivenessRequested');
            assert.ok(request && request.type === 'leaderLivenessRequested');
            attacker.send({
                type: 'leaderLivenessConfirmed',
                timestamp: Date.now(),
                senderInstanceId: attackerId,
                payload: { ...request.payload, targetInstanceId: f.followerId }
            });
            await waitFor(() => !attacker.isConnected());
            assert.equal(await pending, 'unconfirmed');
            assert.equal(
                f.events.some(event => event.type === 'leaderLivenessConfirmed'),
                false
            );
            f.assertUnchangedFollower();
        } finally {
            await attacker.disconnect();
            await f.dispose();
        }
    });

    test('connection replacement cancels the original wait and its late response cannot count', async () => {
        const f = await createLivenessFixture();
        try {
            f.setResponder(() => {});
            const pending = InterInstanceBus.confirmLeaderLiveness(f.identity);
            await waitFor(() => f.events.some(event => event.type === 'leaderLivenessRequested'));
            const old = f.events.find(event => event.type === 'leaderLivenessRequested');
            assert.ok(old && old.type === 'leaderLivenessRequested');
            f.bus.clientTarget = {
                instanceId: f.identity.instanceId,
                authorityTerm: `${f.identity.instanceId}:wrong`,
                ipcPath: resolveIpcPath(f.identity.instanceId)
            };
            await f.bus.connectToLeader();
            assert.equal(await pending, 'invalidated');
            await waitFor(() => f.bus.remoteLeaderLivenessCompatible);
            f.server.sendToInstance(f.followerId, {
                type: 'leaderLivenessConfirmed',
                timestamp: Date.now(),
                senderInstanceId: f.identity.instanceId,
                payload: { ...old.payload, targetInstanceId: f.followerId }
            });
            const next = InterInstanceBus.confirmLeaderLiveness(f.identity);
            assert.equal(await next, 'unconfirmed');
            f.assertUnchangedFollower();
        } finally {
            await f.dispose();
        }
    });
});
