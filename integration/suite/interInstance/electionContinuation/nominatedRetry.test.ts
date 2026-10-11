import assert from 'node:assert/strict';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { waitFor } from '../leaderLiveness/fixture';
import { createElectionFixture, deferred } from './fixture';

type Election = ReturnType<typeof createElectionFixture>['election'] & {
    takeoverAsNominated(): Promise<void>;
};

suite('Nominated takeover retry eligibility', () => {
    let fixture: ReturnType<typeof createElectionFixture>;
    let pending: Promise<void> | undefined;
    const source = { instanceId: 'resigning-source', electedAt: 99_000, lastHeartbeat: 100_000 };
    setup(() => {
        fixture = createElectionFixture();
        pending = undefined;
    });
    teardown(async () => {
        fixture.election.stopping = true;
        fixture.election.lifecycleGeneration++;
        try {
            if (pending) {
                await fixture.completeCandidate(pending);
            }
        } finally {
            await fixture.dispose();
        }
    });

    for (const losses of [1, 2, 3]) {
        test(`${losses} same-term source heartbeats preserve retries without exceeding three candidates`, async () => {
            await fixture.write(source);
            const originalCheck = fixture.election.checkLeader;
            let fallbackChecks = 0;
            fixture.election.checkLeader = async () => {
                fallbackChecks++;
                await originalCheck.call(fixture.election);
            };
            let settled = false;
            try {
                pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                    settled = true;
                });
                for (let attempt = 1; attempt <= losses; attempt++) {
                    await waitFor(() => settled || fixture.updates.length === attempt);
                    assert.equal(settled, false, 'valid nomination stopped before its next permitted attempt');
                    fixture.advance(1);
                    await fixture.write({ ...source, lastHeartbeat: Date.now() });
                    await fixture.completeCandidate(Promise.resolve());
                }
                await waitFor(() => settled || fixture.updates.length > losses);
                await fixture.completeCandidate(pending);
                assert.equal(fixture.updates.length, Math.min(losses + 1, 3));
                assert.equal(fallbackChecks, losses === 3 ? 1 : 0);
                if (losses === 3) {
                    assert.deepEqual(fixture.read(), { ...source, lastHeartbeat: Date.now() });
                    assert.deepEqual(fixture.roles, []);
                    fixture.assertFollower();
                } else {
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `continuation-local:${Date.now()}`);
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        [true]
                    );
                }
            } finally {
                fixture.election.checkLeader = originalCheck;
            }
        });
    }

    for (const replacement of [
        { ...source, instanceId: 'other-leader' },
        { ...source, electedAt: 100_001 },
        { ...source, electedAt: 98_000 }
    ]) {
        test(`confirmation rejects replacement ${replacement.instanceId}:${replacement.electedAt}`, async () => {
            await fixture.write(source);
            let settled = false;
            pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                settled = true;
            });
            await fixture.confirmationEntered.promise;
            await fixture.write(replacement);
            await fixture.completeCandidate(Promise.resolve());
            await waitFor(() => settled || fixture.updates.length > 1);
            await fixture.completeCandidate(pending);
            assert.equal(fixture.updates.length, 1);
            assert.deepEqual(fixture.read(), replacement);
            assert.deepEqual(fixture.roles, []);
            fixture.assertFollower();
        });
    }

    for (const change of [
        'unchanged',
        'foreign-instance',
        'source-new-term',
        'source-old-term',
        'promotion-demotion',
        'follower-invalidation',
        'identity-ABA',
        'pause',
        'stop',
        'restart'
    ] as const) {
        test(`same-term loss followed by ${change} during retry delay rechecks nomination eligibility`, async () => {
            const originalTimeout = globalThis.setTimeout;
            const delay = deferred();
            let delayEntered = false;
            let timer: NodeJS.Timeout | undefined;
            globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                if (args[1] !== 200) {
                    return originalTimeout(...args);
                }
                timer = originalTimeout(() => {}, 60_000);
                delayEntered = true;
                void delay.promise.then(() => args[0](undefined));
                return timer;
            }) as typeof setTimeout;
            let settled = false;
            try {
                await fixture.write(source);
                pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                    settled = true;
                });
                await fixture.confirmationEntered.promise;
                fixture.advance(1);
                await fixture.write({ ...source, lastHeartbeat: Date.now() });
                await fixture.completeCandidate(Promise.resolve());
                await waitFor(() => settled || delayEntered);
                assert.equal(delayEntered, true, 'same-term candidate loss incorrectly revoked the nomination');
                if (change === 'foreign-instance') {
                    await fixture.write({ ...source, instanceId: 'other-leader' });
                } else if (change === 'source-new-term' || change === 'source-old-term') {
                    await fixture.write({ ...source, electedAt: change === 'source-new-term' ? 100_001 : 98_000 });
                } else if (change === 'promotion-demotion') {
                    await fixture.write(fixture.self(Date.now()));
                    await fixture.election.checkLeader();
                    assert.equal(LeaderElectionService.isLeader(), true);
                    fixture.advance(1);
                    await fixture.write({ instanceId: 'successor', electedAt: Date.now(), lastHeartbeat: Date.now() });
                    await fixture.election.checkLeader();
                    fixture.assertFollower();
                } else if (change === 'follower-invalidation') {
                    fixture.election.setLeaderState(false);
                } else if (change === 'identity-ABA') {
                    await fixture.write({ ...source, instanceId: 'other-leader' });
                    await fixture.election.checkLeader();
                    await fixture.write(source);
                    await fixture.election.checkLeader();
                } else if (change === 'pause') {
                    fixture.election.electionPausedUntil = Date.now() + 1000;
                } else if (change === 'stop' || change === 'restart') {
                    await LeaderElectionService.stop();
                    if (change === 'restart') {
                        LeaderElectionService.initialize(fixture.context);
                        clearTimeout(fixture.election.startTimer);
                        fixture.election.startTimer = undefined;
                    }
                }
                const beforeRelease = fixture.read();
                delay.resolve();
                await waitFor(() => settled || fixture.updates.length > 1);
                await fixture.completeCandidate(pending);
                assert.equal(fixture.updates.length, change === 'unchanged' ? 2 : 1);
                if (change === 'unchanged') {
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        [true]
                    );
                } else {
                    assert.deepEqual(fixture.read(), beforeRelease);
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        change === 'promotion-demotion' ? [true, false] : []
                    );
                    fixture.assertFollower();
                }
            } finally {
                clearTimeout(timer);
                delay.resolve();
                fixture.election.stopping = true;
                if (pending) {
                    await fixture.completeCandidate(pending);
                }
                globalThis.setTimeout = originalTimeout;
            }
        });
    }

    for (const replacement of [
        { ...source, instanceId: 'other-leader' },
        { ...source, electedAt: 100_001 },
        { ...source, electedAt: 98_000 }
    ]) {
        test(`observed ${replacement.instanceId}:${replacement.electedAt} cannot renew a nomination after source ABA`, async () => {
            const originalSetLeaderState = fixture.election.setLeaderState;
            const observed: Array<{ record: typeof source | undefined; decision: number }> = [];
            let restore: Promise<void> | undefined;
            let decisionAtRestore: number | undefined;
            let settled = false;
            fixture.election.setLeaderState = value => {
                originalSetLeaderState.call(fixture.election, value);
                if (!value) {
                    observed.push({ record: fixture.read(), decision: fixture.election.decisionGeneration });
                    queueMicrotask(() => {
                        decisionAtRestore = fixture.election.decisionGeneration;
                        restore = Promise.resolve(fixture.write(source));
                    });
                }
            };
            try {
                await fixture.write(source);
                pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                    settled = true;
                });
                await fixture.confirmationEntered.promise;
                await fixture.write(replacement);
                await fixture.completeCandidate(Promise.resolve());
                await waitFor(() => settled || fixture.updates.length > 1);
                await fixture.completeCandidate(pending);
                await restore;
                assert.equal(observed.length, 1);
                assert.deepEqual(observed[0].record, replacement);
                assert.equal(decisionAtRestore, observed[0].decision);
                assert.equal(fixture.updates.length, 1);
                assert.deepEqual(fixture.read(), source);
                assert.deepEqual(fixture.roles, []);
                fixture.assertFollower();
            } finally {
                fixture.election.stopping = true;
                if (pending) {
                    await fixture.completeCandidate(pending);
                }
                await restore;
                fixture.election.setLeaderState = originalSetLeaderState;
            }
        });
    }

    test('another invalidation between loss completion and nomination continuation cannot renew the retry', async () => {
        const originalSetLeaderState = fixture.election.setLeaderState;
        let invalidations = 0;
        fixture.election.setLeaderState = value => {
            originalSetLeaderState.call(fixture.election, value);
            if (!value) {
                queueMicrotask(() => {
                    invalidations++;
                    originalSetLeaderState.call(fixture.election, false);
                });
            }
        };
        let settled = false;
        try {
            await fixture.write(source);
            pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                settled = true;
            });
            await fixture.confirmationEntered.promise;
            await fixture.write(source);
            await fixture.completeCandidate(Promise.resolve());
            await waitFor(() => settled || fixture.updates.length > 1);
            await fixture.completeCandidate(pending);
            assert.equal(invalidations, 1);
            assert.equal(fixture.updates.length, 1);
            assert.deepEqual(fixture.read(), source);
            assert.deepEqual(fixture.roles, []);
            fixture.assertFollower();
        } finally {
            fixture.election.setLeaderState = originalSetLeaderState;
        }
    });
});
