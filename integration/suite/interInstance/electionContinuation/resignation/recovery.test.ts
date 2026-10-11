import assert from 'node:assert/strict';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { waitFor } from '../../leaderLiveness/fixture';
import { createResignationFixture } from './fixture';

suite('Resignation recovery retains the original decision', () => {
    let f: ReturnType<typeof createResignationFixture>;
    setup(() => {
        f = createResignationFixture();
    });
    teardown(async () => {
        await f.dispose();
    });

    for (const boundary of ['write', 'confirmation'] as const) {
        for (const change of [
            'uninterrupted',
            'promotion-demotion-ABA',
            'follower-invalidation',
            'new-confirmed-term',
            'confirmed-ABA',
            'pause',
            'stop',
            'restart'
        ] as const) {
            test(`${boundary}/${change}: notification recovery cannot renew an invalidated force attempt`, async () => {
                await f.write(f.source);
                f.capability();
                const waiting = boundary === 'write' ? f.holdNextWrite() : undefined;
                try {
                    f.dispatch('none');
                    assert.equal(f.pending.length, 1);
                    const operation = f.pending[0];
                    await (waiting?.entered.promise ?? f.confirmationEntered.promise);
                    const decision = f.election.decisionGeneration;
                    if (change === 'promotion-demotion-ABA') {
                        await f.checkLeader();
                        await f.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: Date.now() });
                        await f.checkLeader();
                        f.assertFollower();
                        assert.deepEqual(
                            f.roles.map(role => role.leader),
                            [true, false]
                        );
                        await f.write(f.self());
                        assert.ok(f.election.decisionGeneration > decision);
                    } else if (change === 'follower-invalidation') {
                        f.election.setLeaderState(false);
                    } else if (change === 'new-confirmed-term' || change === 'confirmed-ABA') {
                        f.capability(`${f.source.instanceId}:99502`);
                        if (change === 'confirmed-ABA') {
                            f.capability();
                        }
                        assert.equal(f.election.decisionGeneration, decision);
                    } else if (change === 'pause') {
                        f.election.electionPausedUntil = Date.now() + 1000;
                    } else if (change === 'stop' || change === 'restart') {
                        await LeaderElectionService.stop();
                        if (change === 'restart') {
                            LeaderElectionService.initialize(f.context);
                            clearTimeout(f.election.startTimer);
                            f.election.startTimer = undefined;
                        }
                    }
                    const writesBeforeRelease = f.updates.length;
                    assert.equal(writesBeforeRelease, change === 'stop' || change === 'restart' ? 2 : 1);
                    if (change === 'stop' || change === 'restart') {
                        assert.equal(f.updates[1], undefined);
                    }
                    waiting?.gate.resolve();
                    await f.completeCandidate(operation);
                    assert.equal(f.updates.length, writesBeforeRelease);
                    assert.equal(f.fallbackChecks(), 0, 'invalidated child must not start a new fallback decision');
                    if (change === 'uninterrupted') {
                        f.assertPromoted();
                    } else {
                        f.assertFollower();
                        assert.deepEqual(
                            f.roles.map(role => role.leader),
                            change === 'promotion-demotion-ABA' ? [true, false] : []
                        );
                    }
                } finally {
                    waiting?.gate.resolve();
                    await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                }
            });
        }
    }

    for (const loss of [
        'same-source',
        'missing-record',
        'foreign-instance',
        'new-source-term',
        'old-observed-ABA',
        'extra-invalidation'
    ] as const) {
        test(`${loss}: fallback accepts only the original source decision or its exact loss ticket`, async () => {
            await f.write(f.source);
            f.capability();
            const originalState = f.election.setLeaderState;
            let restored: Promise<void> | undefined;
            if (loss === 'old-observed-ABA' || loss === 'extra-invalidation') {
                f.election.setLeaderState = value => {
                    originalState.call(f.election, value);
                    if (!value) {
                        queueMicrotask(() => {
                            if (loss === 'old-observed-ABA') {
                                restored = Promise.resolve(f.write(f.source));
                            } else {
                                originalState.call(f.election, false);
                            }
                        });
                    }
                };
            }
            try {
                f.dispatch('none');
                assert.equal(f.pending.length, 1);
                await f.confirmationEntered.promise;
                if (loss === 'missing-record') {
                    await f.write(undefined);
                } else if (loss === 'foreign-instance') {
                    await f.write({ ...f.source, instanceId: 'successor' });
                } else if (loss === 'new-source-term' || loss === 'old-observed-ABA') {
                    await f.write({ ...f.source, electedAt: 99_502 });
                } else {
                    await f.write(f.source);
                }
                let settled = false;
                const operation = f.pending[0].finally(() => {
                    settled = true;
                });
                await f.completeCandidate(Promise.resolve());
                await waitFor(() => settled || f.updates.length > 1);
                await f.completeCandidate(operation);
                await restored;
                const permitted = loss === 'same-source' || loss === 'missing-record';
                assert.equal(f.fallbackChecks(), permitted ? 1 : 0);
                assert.equal(f.updates.length, loss === 'missing-record' ? 2 : 1);
                if (loss === 'missing-record') {
                    f.assertPromoted(100001);
                } else {
                    f.assertFollower();
                    assert.deepEqual(f.roles, []);
                }
            } finally {
                f.election.stopping = true;
                await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                await restored;
                f.election.setLeaderState = originalState;
            }
        });
    }
});
