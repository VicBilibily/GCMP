import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createLivenessFixture } from '../../../../leaderLiveness/fixture';
import { createResignationFixture } from '../../fixture';

suite('Demoted self authority cannot revive a superseded term', () => {
    for (const outcome of ['success', 'failed-receipt', 'cancelled'] as const) {
        for (const freshness of ['fresh', 'boundary', 'expired'] as const) {
            test(`${outcome}/${freshness}: old self replay cannot restore authority after foreign demotion`, async () => {
                const f = createResignationFixture();
                const update = f.context.globalState.update;
                const failedReceipt = new Error('candidate receipt rejected');
                try {
                    if (outcome === 'failed-receipt') {
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            throw failedReceipt;
                        };
                        await assert.rejects(f.election.becomeLeader(), failedReceipt);
                        f.context.globalState.update = update;
                        f.assertFollower();
                    } else {
                        const pending = f.election.becomeLeader();
                        await f.confirmationEntered.promise;
                        if (outcome === 'cancelled') {
                            InterInstanceBus.cancelLeaderLiveness();
                        }
                        await f.completeCandidate(pending);
                        assert.equal(LeaderElectionService.isLeader(), outcome === 'success');
                    }
                    const obsolete = f.read();
                    assert.ok(obsolete);
                    assert.equal(obsolete.electedAt, 100000);
                    f.advance(15001);
                    if (outcome === 'success') {
                        await f.write(undefined);
                        await f.completeCandidate(f.election.becomeLeader());
                    } else {
                        await f.completeCandidate(f.checkLeader());
                    }
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                    assert.equal(f.election.candidateAuthority, undefined);
                    f.advance(1);
                    await f.write({
                        instanceId: 'foreign-successor',
                        electedAt: Date.now(),
                        lastHeartbeat: Date.now()
                    });
                    await f.checkLeader();
                    f.assertFollower();
                    assert.equal(f.election.ownElectedAt, 115001);
                    const roles = f.roles.length;
                    const identities = f.identities.length;
                    const age =
                        freshness === 'fresh' ? 0
                        : freshness === 'boundary' ? 15000
                        : 15001;
                    await f.write({ ...obsolete, lastHeartbeat: Date.now() - age });
                    const writes = f.updates.length;
                    await f.completeCandidate(f.checkLeader());
                    assert.notEqual(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                    assert.equal(f.election.ownElectedAt >= 115001, true);
                    assert.ok(
                        f.identities
                            .slice(identities)
                            .every(identity => identity.ownedTerm !== 'continuation-local:100000')
                    );
                    assert.ok(f.roles.slice(roles).every(role => role.term !== 'continuation-local:100000'));
                    if (freshness === 'expired') {
                        const newTerm = LeaderElectionService.getOwnedAuthorityTerm();
                        if (newTerm) {
                            assert.equal(newTerm, `continuation-local:${Date.now()}`);
                            assert.deepEqual(f.updates.slice(writes), [f.self(Date.now())]);
                        } else {
                            f.assertFollower();
                            assert.equal(f.updates.length, writes);
                        }
                    } else {
                        f.assertFollower();
                        assert.equal(f.updates.length, writes);
                    }
                } finally {
                    f.context.globalState.update = update;
                    await f.dispose();
                }
            });
        }
    }

    for (const freshness of ['fresh', 'expired'] as const) {
        test(`new instance/${freshness}: an unrelated previous instance watermark cannot block self recovery`, async () => {
            const f = createResignationFixture();
            try {
                await f.completeCandidate(f.election.becomeLeader());
                f.advance(15001);
                await f.write(undefined);
                await f.completeCandidate(f.election.becomeLeader());
                const former = f.election.instanceId;
                assert.equal(f.election.ownElectedAt, 115001);
                await f.write({ instanceId: 'foreign-successor', electedAt: 115002, lastHeartbeat: Date.now() });
                await f.checkLeader();
                f.assertFollower();
                await LeaderElectionService.stop();
                LeaderElectionService.initialize(f.context);
                assert.notEqual(f.election.instanceId, former);
                assert.equal(f.election.ownElectedAt, 0);
                const now = Date.now();
                const record = {
                    instanceId: f.election.instanceId,
                    electedAt: 100000,
                    lastHeartbeat: freshness === 'fresh' ? now : now - 15001
                };
                await f.write(record);
                await f.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `${record.instanceId}:100000`);
            } finally {
                await f.dispose();
            }
        });
    }

    for (const rollback of [0, 2, 3, 15001] as const) {
        test(`clock rollback/${rollback}: a new election advances authority without advancing its heartbeat`, async () => {
            const f = createResignationFixture();
            const fixtureClock = Date.now;
            try {
                await f.completeCandidate(f.election.becomeLeader());
                f.advance(15001);
                await f.write(undefined);
                await f.completeCandidate(f.election.becomeLeader());
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                f.advance(1);
                await f.write({ instanceId: 'foreign-successor', electedAt: 115002, lastHeartbeat: Date.now() });
                await f.checkLeader();
                f.assertFollower();
                await f.write(undefined);
                f.advance(1);
                const wallNow = Date.now() - rollback;
                Date.now = () => wallNow;
                await f.completeCandidate(f.checkLeader());
                const electedAt = Math.max(wallNow, 115002);
                assert.deepEqual(f.read(), {
                    instanceId: f.election.instanceId,
                    lastHeartbeat: wallNow,
                    electedAt
                });
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `${f.election.instanceId}:${electedAt}`);
                Date.now = () => wallNow + 1;
                await f.checkLeader();
                assert.deepEqual(f.read(), {
                    instanceId: f.election.instanceId,
                    lastHeartbeat: wallNow + 1,
                    electedAt
                });
            } finally {
                Date.now = fixtureClock;
                await f.dispose();
            }
        });
    }

    test('real IPC: old self visibility cannot republish a demoted authority', async () => {
        const f = await createLivenessFixture(0);
        const originalNow = Date.now;
        try {
            await f.write(undefined);
            await f.election.becomeLeader(true);
            await f.bus.roleSwitchChain;
            const obsolete = f.read();
            assert.ok(obsolete);
            assert.equal(obsolete.instanceId, f.followerId);
            await f.write(undefined);
            await f.election.becomeLeader(true);
            await f.bus.roleSwitchChain;
            const current = f.read();
            assert.ok(current);
            assert.ok(current.electedAt > obsolete.electedAt);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `${f.followerId}:${current.electedAt}`);
            assert.ok(f.bus.server);

            const now = Math.max(originalNow(), current.electedAt + 1);
            Date.now = () => now;
            await f.write({ instanceId: 'foreign-successor', electedAt: now, lastHeartbeat: now });
            await f.election.checkLeader();
            await f.bus.roleSwitchChain;
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
            assert.equal(f.election.ownElectedAt, current.electedAt);
            const roles = f.roles.length;

            await f.write({ ...obsolete, lastHeartbeat: now });
            const writes = f.updates.length;
            await f.election.checkLeader();
            await f.bus.roleSwitchChain;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(f.election.ownElectedAt, current.electedAt);
            assert.equal(f.roles.length, roles);
            assert.equal(f.updates.length, writes);
            assert.equal(f.bus.server, undefined);
        } finally {
            Date.now = originalNow;
            await f.dispose();
        }
    });
});
