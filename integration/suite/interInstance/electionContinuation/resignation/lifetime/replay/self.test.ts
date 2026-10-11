import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import type { LeaderRecord } from '../../../fixture';
import { createResignationFixture } from '../../fixture';

suite('Confirmed self authority replay', () => {
    for (const outcome of ['success', 'failed-receipt', 'cancelled'] as const) {
        for (const freshness of ['expired', 'fresh'] as const) {
            for (const replay of [false, true]) {
                test(`${outcome}/${freshness}/replay=${replay}: keep the confirmed replacement through repeated checks`, async () => {
                    const f = createResignationFixture();
                    const update = f.context.globalState.update;
                    const exact = new Error('obsolete self candidate receipt failed');
                    try {
                        if (outcome === 'failed-receipt') {
                            f.context.globalState.update = async (key: string, value: unknown) => {
                                await update.call(f.context.globalState, key, value);
                                throw exact;
                            };
                            await assert.rejects(f.election.becomeLeader(), exact);
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
                        assert.deepEqual(obsolete, f.self());
                        assert.ok(obsolete);
                        f.advance(15001);
                        if (outcome === 'success') {
                            await f.write(undefined);
                            await f.completeCandidate(f.election.becomeLeader());
                        } else {
                            await f.completeCandidate(f.checkLeader());
                        }
                        const term = 'continuation-local:115001';
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        assert.equal(f.election.candidateAuthority, undefined);
                        const identities = f.identities.length;
                        const roles = f.roles.length;
                        for (let iteration = 0; iteration < 3; iteration++) {
                            f.advance(1);
                            if (replay) {
                                await f.write({
                                    ...obsolete,
                                    lastHeartbeat: freshness === 'fresh' ? Date.now() : obsolete.lastHeartbeat
                                });
                            }
                            const writes = f.updates.length;
                            await f.checkLeader();
                            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                            assert.equal(f.election.ownElectedAt, 115001);
                            assert.deepEqual(f.read(), f.self(115001));
                            assert.deepEqual(f.updates.slice(writes), [f.self(115001)]);
                            assert.equal(f.identities.length, identities);
                            assert.equal(f.roles.length, roles);
                        }
                    } finally {
                        f.context.globalState.update = update;
                        await f.dispose();
                    }
                });
            }
        }
    }

    for (const observed of [99999, 100000, 115001, 115002]) {
        test(`confirmation/${observed}: only equal or newer self authority can be confirmed`, async () => {
            const f = createResignationFixture();
            const election = f.election as typeof f.election & {
                confirmLeadership(
                    expected: Pick<LeaderRecord, 'instanceId' | 'electedAt'>,
                    generation: number,
                    decision: number
                ): boolean;
            };
            try {
                f.advance(15001);
                await f.completeCandidate(election.becomeLeader());
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                const identities = f.identities.length;
                const roles = f.roles.length;
                const writes = f.updates.length;
                await f.write(f.self(observed));
                const confirmed = election.confirmLeadership(
                    f.self(observed),
                    election.lifecycleGeneration,
                    election.decisionGeneration
                );
                assert.equal(confirmed, observed >= 115001);
                assert.equal(election.ownElectedAt, Math.max(115001, observed));
                assert.equal(LeaderElectionService.isLeader(), true);
                assert.equal(f.roles.length, roles);
                assert.equal(f.updates.length, writes);
                assert.equal(f.identities.length, identities + (observed > 115001 ? 1 : 0));
                await f.checkLeader();
                assert.equal(
                    LeaderElectionService.getOwnedAuthorityTerm(),
                    `continuation-local:${Math.max(115001, observed)}`
                );
                assert.equal(f.updates.length, writes + 1);
            } finally {
                await f.dispose();
            }
        });
    }

    test('a visible newer self term is still adopted without a role toggle', async () => {
        const f = createResignationFixture();
        try {
            await f.completeCandidate(f.election.becomeLeader());
            const roles = f.roles.length;
            const writes = f.updates.length;
            f.advance(15001);
            await f.write(f.self(115001));
            await f.checkLeader();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
            assert.equal(f.updates.length, writes);
            assert.equal(f.roles.length, roles);
            assert.equal(f.identities.at(-1)?.ownedTerm, 'continuation-local:115001');
            await f.checkLeader();
            assert.deepEqual(f.updates.slice(writes), [f.self(115001)]);
        } finally {
            await f.dispose();
        }
    });

    for (const change of ['older-self', 'newer-self', 'stop'] as const) {
        test(`pending heartbeat/${change}: its continuation cannot roll back current authority`, async () => {
            const f = createResignationFixture();
            let pending: Promise<void> | undefined;
            const held = f.holdNextWrite();
            try {
                await f.seed();
                pending = f.checkLeader();
                await held.entered.promise;
                if (change === 'stop') {
                    f.election.stopping = true;
                    f.election.lifecycleGeneration++;
                    f.election.setLeaderState(false);
                } else {
                    const observed = change === 'older-self' ? 99000 : 115001;
                    await f.write(f.self(observed));
                    if (change === 'newer-self') {
                        await f.checkLeader();
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:115001');
                    }
                }
                held.gate.resolve();
                await pending;
                if (change === 'stop') {
                    f.assertFollower();
                    assert.equal(f.updates.length, 1);
                    assert.ok(f.roles.every(role => !role.leader));
                } else {
                    const expected = change === 'older-self' ? 100000 : 115001;
                    assert.equal(f.election.ownElectedAt, expected);
                    const writes = f.updates.length;
                    await f.checkLeader();
                    assert.equal(f.election.ownElectedAt, expected);
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `continuation-local:${expected}`);
                    assert.deepEqual(f.updates.slice(writes), [f.self(expected)]);
                    assert.ok(f.identities.every(identity => identity.ownedTerm !== 'continuation-local:99000'));
                }
            } finally {
                held.gate.resolve();
                try {
                    await pending;
                } finally {
                    await f.dispose();
                }
            }
        });
    }
});
