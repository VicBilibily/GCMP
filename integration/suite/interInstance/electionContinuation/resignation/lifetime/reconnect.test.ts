import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../leaderLiveness/fixture';
import { deferred } from '../../fixture';
import type { Election } from '../fixture';

interface ReconnectState {
    reconnectTimer: NodeJS.Timeout | undefined;
    getLeaderConnectionTarget(): { instanceId: string; authorityTerm?: string; ipcPath: string } | undefined;
}

suite('Automatic reconnect during accepted handoff', () => {
    for (const branch of ['none', 'self'] as const) {
        for (const outcome of ['fast', 'reconnected', 'expired', 'cancelled'] as const) {
            test(`${branch}/${outcome}: self discovery preserves only still-valid source-close authority`, async () => {
                const f = await createLivenessFixture(0);
                const election = f.election as Election;
                const bus = InterInstanceBus as unknown as ReconnectState;
                const originalNow = Date.now;
                const update = f.context.globalState.update;
                const original = {
                    recoverAfterLeaderResigning: election.recoverAfterLeaderResigning,
                    takeoverAsNominated: election.takeoverAsNominated
                };
                const entered = deferred();
                const gate = deferred();
                const pending: Promise<void>[] = [];
                const acceptedAt = originalNow();
                let now = acceptedAt;
                let held = false;
                Date.now = () => now;
                const track = (operation: Promise<void>) => {
                    pending.push(operation);
                    return operation;
                };
                election.recoverAfterLeaderResigning = (...args) =>
                    track(original.recoverAfterLeaderResigning.call(election, ...args));
                election.takeoverAsNominated = (...args) => track(original.takeoverAsNominated.call(election, ...args));
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    if (key === 'gcmp.leader.info.v2' && !held) {
                        held = true;
                        entered.resolve();
                        await gate.promise;
                    }
                };
                const before = InterInstanceBus.getConfirmedLeaderAuthority();
                try {
                    LeaderElectionService.subscribeToLeaderResigning();
                    assert.equal(
                        f.server.sendToInstance(f.followerId, {
                            type: 'leaderResigning',
                            senderInstanceId: f.identity.instanceId,
                            timestamp: now,
                            payload: {
                                leaderId: f.identity.instanceId,
                                sourceAuthorityTerm: f.identity.authorityTerm,
                                reason: 'manual',
                                nextLeaderId: branch === 'self' ? f.followerId : undefined
                            }
                        }),
                        'sent'
                    );
                    await waitFor(() => held && pending.length === 1);
                    await entered.promise;
                    assert.equal(f.read()?.instanceId, f.followerId);
                    assert.equal(LeaderElectionService.isLeader(), false);
                    assert.equal(f.updates.length, 1);
                    const sourceClient = f.bus.client;
                    assert.ok(sourceClient);
                    await f.server.stop();
                    await waitFor(() => !f.bus.clientTarget);
                    assert.equal(InterInstanceBus.isLeaderResignationAuthorityCurrent(before), true);
                    if (outcome !== 'fast') {
                        assert.ok(bus.reconnectTimer, 'source close must register a real reconnect timer');
                        if (outcome === 'cancelled') {
                            InterInstanceBus.cancelLeaderLiveness();
                        }
                        await waitFor(() => !bus.reconnectTimer);
                        await f.bus.roleSwitchChain;
                        now = acceptedAt + (outcome === 'expired' ? 10000 : 2300);
                        assert.equal(bus.getLeaderConnectionTarget()?.instanceId, f.followerId);
                        assert.equal(f.bus.client, sourceClient);
                        assert.equal(sourceClient.isConnected(), false);
                    }
                    const valid = outcome === 'fast' || outcome === 'reconnected';
                    assert.equal(InterInstanceBus.isLeaderResignationAuthorityCurrent(before), valid);
                    gate.resolve();
                    await Promise.all(pending);
                    await f.bus.roleSwitchChain;
                    assert.equal(LeaderElectionService.isLeader(), valid);
                    assert.deepEqual(f.roles, valid ? [true] : []);
                    assert.equal(
                        LeaderElectionService.getOwnedAuthorityTerm(),
                        valid ? `${f.followerId}:${acceptedAt}` : undefined
                    );
                    assert.equal(f.read()?.electedAt, acceptedAt);
                    assert.equal(f.updates.length, 1);
                    if (!valid) {
                        await f.election.checkLeader();
                        assert.equal(LeaderElectionService.isLeader(), false);
                        assert.deepEqual(f.roles, []);
                        assert.equal(f.updates.length, 1);
                    }
                } finally {
                    gate.resolve();
                    try {
                        await Promise.all(pending);
                    } finally {
                        f.context.globalState.update = update;
                        Object.assign(election, original);
                        Date.now = originalNow;
                        await f.dispose();
                    }
                }
            });
        }
    }
});
