import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createLivenessFixture, waitFor } from '../../../../leaderLiveness/fixture';
import { deferred } from '../../../fixture';
import type { Election } from '../../fixture';

suite('Recovered self authority replay with real IPC', () => {
    for (const freshness of ['expired', 'fresh'] as const) {
        for (const replay of [false, true]) {
            test(`${freshness}/replay=${replay}: repeated old visibility cannot replace the recovered IPC term`, async () => {
                const f = await createLivenessFixture(0);
                const election = f.election as Election;
                const update = f.context.globalState.update;
                const originalRecovery = election.recoverAfterLeaderResigning;
                const originalNow = Date.now;
                const acceptedAt = originalNow();
                const gate = deferred();
                const pending: Promise<void>[] = [];
                let now = acceptedAt;
                let held = false;
                Date.now = () => now;
                election.recoverAfterLeaderResigning = (...args) => {
                    const operation = originalRecovery.call(election, ...args);
                    pending.push(operation);
                    return operation;
                };
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    if (key === 'gcmp.leader.info.v2' && !held) {
                        held = true;
                        await gate.promise;
                    }
                };
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
                                sourceAuthorityTerm: f.identity.authorityTerm
                            }
                        }),
                        'sent'
                    );
                    await waitFor(() => held && pending.length === 1);
                    const obsolete = f.read();
                    assert.equal(obsolete?.electedAt, acceptedAt);
                    assert.ok(obsolete);
                    InterInstanceBus.cancelLeaderLiveness();
                    gate.resolve();
                    await Promise.all(pending);
                    assert.equal(LeaderElectionService.isLeader(), false);
                    f.context.globalState.update = update;
                    now += 15001;
                    await election.checkLeader();
                    await f.bus.roleSwitchChain;
                    const electedAt = now;
                    const term = `${f.followerId}:${electedAt}`;
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), term);
                    const server = f.bus.server;
                    assert.ok(server);
                    const roles = f.roles.length;
                    for (let iteration = 0; iteration < 3; iteration++) {
                        now++;
                        if (replay) {
                            await f.write({
                                ...obsolete,
                                lastHeartbeat: freshness === 'fresh' ? now : obsolete.lastHeartbeat
                            });
                        }
                        const writes = f.updates.length;
                        await election.checkLeader();
                        await f.bus.roleSwitchChain;
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        assert.equal(InterInstanceBus.getAuthorityTerm(), term);
                        assert.equal(f.bus.server, server);
                        assert.equal(f.roles.length, roles);
                        const expected = { instanceId: f.followerId, electedAt, lastHeartbeat: now };
                        assert.deepEqual(f.read(), expected);
                        assert.deepEqual(f.updates.slice(writes), [expected]);
                    }
                } finally {
                    gate.resolve();
                    try {
                        await Promise.all(pending);
                    } finally {
                        f.context.globalState.update = update;
                        election.recoverAfterLeaderResigning = originalRecovery;
                        Date.now = originalNow;
                        await f.dispose();
                    }
                }
            });
        }
    }
});
