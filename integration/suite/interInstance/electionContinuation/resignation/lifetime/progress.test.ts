import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../fixture';

suite('Invalid self candidate ordinary recovery', () => {
    for (const revoke of ['write-failure', 'explicit-cancellation', 'new-confirmed-authority'] as const) {
        for (const elapsed of [15001, 60000]) {
            test(`${revoke}/${elapsed}ms: recover with a new candidate, not the revoked term`, async () => {
                const f = createResignationFixture();
                const update = f.context.globalState.update;
                const exact = new Error('visible recovery candidate receipt rejected');
                try {
                    if (revoke === 'write-failure') {
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            throw exact;
                        };
                        await assert.rejects(f.election.becomeLeader(), exact);
                    } else {
                        const pending = f.election.becomeLeader();
                        await f.confirmationEntered.promise;
                        if (revoke === 'explicit-cancellation') {
                            InterInstanceBus.cancelLeaderLiveness();
                        } else {
                            f.capability(`${f.source.instanceId}:99502`);
                        }
                        await f.completeCandidate(pending);
                    }
                    f.context.globalState.update = update;
                    const revoked = f.read();
                    assert.deepEqual(revoked, f.self());
                    f.assertFollower();
                    for (const delta of [0, 15000]) {
                        f.advance(delta);
                        await f.checkLeader();
                        f.assertFollower();
                        assert.deepEqual(f.read(), revoked);
                        assert.equal(f.updates.length, 1);
                        assert.deepEqual(f.roles, []);
                    }
                    f.advance(elapsed - 15000);
                    await f.completeCandidate(f.checkLeader());
                    assert.equal(
                        LeaderElectionService.getOwnedAuthorityTerm(),
                        `continuation-local:${100000 + elapsed}`
                    );
                    assert.deepEqual(f.read(), f.self(100000 + elapsed));
                    assert.equal(f.updates.length, 2);
                    assert.deepEqual(
                        f.roles.map(role => role.leader),
                        [true]
                    );
                    assert.ok(f.identities.every(identity => identity.ownedTerm !== 'continuation-local:100000'));
                } finally {
                    f.context.globalState.update = update;
                    await f.dispose();
                }
            });
        }
    }

    for (const lateOutcome of ['success', 'failure'] as const) {
        test(`pending-revoked-write/${lateOutcome}: an old completion cannot undo recovered authority`, async () => {
            const f = createResignationFixture();
            const update = f.context.globalState.update;
            const held = f.holdNextWrite();
            const exact = new Error('late obsolete recovery candidate receipt rejected');
            let settled: Promise<void> | undefined;
            try {
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    if (lateOutcome === 'failure') {
                        throw exact;
                    }
                };
                const pending = f.election.becomeLeader();
                settled = lateOutcome === 'failure' ? assert.rejects(pending, exact) : pending;
                await held.entered.promise;
                f.context.globalState.update = update;
                InterInstanceBus.cancelLeaderLiveness();
                await f.checkLeader();
                f.assertFollower();
                assert.equal(f.updates.length, 1);
                f.advance(15001);
                await f.completeCandidate(f.checkLeader());
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                assert.equal(f.updates.length, 2);
                held.gate.resolve();
                await f.completeCandidate(settled);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                assert.deepEqual(
                    f.roles.map(role => role.leader),
                    [true]
                );
                assert.equal(f.updates.length, 2);
            } finally {
                held.gate.resolve();
                f.context.globalState.update = update;
                try {
                    if (settled) {
                        await f.completeCandidate(settled);
                    }
                } finally {
                    await f.dispose();
                }
            }
        });
    }

    test('foreign expired record keeps the exact existing 15 second threshold', async () => {
        const f = createResignationFixture();
        try {
            await f.write({ instanceId: 'expired-foreign', electedAt: 99000, lastHeartbeat: 100000 });
            f.advance(15000);
            await f.checkLeader();
            f.assertFollower();
            assert.equal(f.updates.length, 0);
            f.advance(1);
            await f.completeCandidate(f.checkLeader());
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
            assert.equal(f.updates.length, 1);
        } finally {
            await f.dispose();
        }
    });
});
