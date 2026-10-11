import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../src/interInstance';
import { waitFor } from '../../leaderLiveness/fixture';
import { deferred } from '../fixture';
import { createResignationFixture } from './fixture';

suite('IPC-confirmed resignation authority and continuation', () => {
    let f: ReturnType<typeof createResignationFixture>;
    setup(() => {
        f = createResignationFixture();
    });
    teardown(async () => {
        await f.dispose();
    });

    for (const branch of ['self', 'other', 'none'] as const) {
        for (const kind of [
            'split-current',
            'split-stale',
            'synchronized-current',
            'synchronized-stale',
            'storage-ahead-current',
            'storage-ahead-stale',
            'legacy-capability-current',
            'fallback-only-current',
            'fallback-only-stale',
            'wrong-target-current',
            'malformed-capability-current'
        ] as const) {
            test(`${branch}/${kind}: notification uses confirmed IPC authority rather than stale discovery`, async () => {
                const stored = {
                    ...f.source,
                    electedAt:
                        kind.startsWith('storage-ahead') ? 99_502
                        : kind.startsWith('synchronized') ? 99_501
                        : 99_500
                };
                await f.write(stored);
                if (kind === 'fallback-only-current' || kind === 'fallback-only-stale') {
                    f.capability(f.confirmedTerm, 'fallback');
                } else if (kind === 'wrong-target-current') {
                    f.capability(f.confirmedTerm, 'ipc', true, 'other-follower');
                } else if (kind === 'malformed-capability-current') {
                    f.capability('confirmed-source:invalid');
                } else {
                    f.capability(f.confirmedTerm, 'ipc', kind !== 'legacy-capability-current');
                    assert.equal(InterInstanceBus.getAuthorityTerm(), f.confirmedTerm);
                    assert.deepEqual(f.read(), stored);
                }
                f.dispatch(branch, kind.endsWith('stale') ? `${f.source.instanceId}:99500` : f.confirmedTerm);
                const permitted =
                    kind === 'split-current' ||
                    kind === 'synchronized-current' ||
                    kind === 'legacy-capability-current' ||
                    kind === 'fallback-only-stale';
                assert.deepEqual(f.calls, permitted || kind === 'storage-ahead-current' ? [branch] : []);
                if (permitted) {
                    await waitFor(() => f.updates.length > 0);
                    await f.completeCandidate(f.pending[0]);
                    assert.equal(f.updates.length, 1);
                    f.assertPromoted();
                } else {
                    let settled = false;
                    const completion = Promise.all(f.pending).then(() => {
                        settled = true;
                    });
                    await waitFor(() => settled || f.updates.length > 0);
                    await f.completeCandidate(completion);
                    assert.equal(f.updates.length, 0);
                    assert.deepEqual(f.read(), stored);
                    assert.deepEqual(f.roles, []);
                    f.assertFollower();
                }
            });
        }
    }

    for (const branch of ['self', 'other'] as const) {
        for (const change of [
            'unchanged',
            'storage-catches-up',
            'missing-storage',
            'new-storage-term',
            'foreign-storage',
            'new-confirmed-term',
            'confirmed-ABA',
            'lost-confirmation',
            'decision-invalidated'
        ] as const) {
            test(`${branch} waiting rechecks ${change} without recapturing its resignation authority`, async () => {
                const originalTimeout = globalThis.setTimeout;
                const delay = deferred();
                const entered = deferred();
                let timer: NodeJS.Timeout | undefined;
                let blocked = false;
                let settled = false;
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    if (args[1] !== 200 || blocked) {
                        return originalTimeout(...args);
                    }
                    blocked = true;
                    timer = originalTimeout(() => {}, 60_000);
                    entered.resolve();
                    void delay.promise.then(() => args[0](undefined));
                    return timer;
                }) as typeof setTimeout;
                try {
                    await f.write(f.source);
                    f.capability();
                    f.dispatch(branch);
                    assert.equal(f.pending.length, 1, 'a valid corrected-term notification must reach its branch');
                    const operation = f.pending[0].finally(() => {
                        settled = true;
                    });
                    if (branch === 'self') {
                        await f.confirmationEntered.promise;
                        await f.write(f.source);
                        await f.completeCandidate(Promise.resolve());
                    }
                    await entered.promise;
                    const decision = f.election.decisionGeneration;
                    if (change === 'storage-catches-up') {
                        await f.write({ ...f.source, electedAt: 99_501 });
                    } else if (change === 'missing-storage') {
                        await f.write(undefined);
                    } else if (change === 'new-storage-term') {
                        await f.write({ ...f.source, electedAt: 99_502 });
                    } else if (change === 'foreign-storage') {
                        await f.write({ ...f.source, instanceId: 'successor', electedAt: 99_502 });
                    } else if (change === 'new-confirmed-term') {
                        f.capability(`${f.source.instanceId}:99502`);
                    } else if (change === 'confirmed-ABA') {
                        f.capability(`${f.source.instanceId}:99502`);
                        f.capability();
                    } else if (change === 'lost-confirmation') {
                        f.bus.setAuthorityTerm(undefined);
                        f.bus.setAuthorityTerm(f.confirmedTerm);
                    } else if (change === 'decision-invalidated') {
                        f.election.setLeaderState(false);
                    }
                    if (change !== 'decision-invalidated') {
                        assert.equal(f.election.decisionGeneration, decision);
                    }
                    const before = f.read();
                    const writes = f.updates.length;
                    const permitted =
                        change === 'unchanged' || change === 'storage-catches-up' || change === 'missing-storage';
                    delay.resolve();
                    await waitFor(() => settled || f.updates.length > writes);
                    await f.completeCandidate(operation);
                    assert.equal(f.updates.length, permitted ? writes + 1 : writes);
                    if (permitted) {
                        f.assertPromoted(branch === 'self' ? 100001 : 100000);
                    } else {
                        assert.deepEqual(f.read(), before);
                        assert.deepEqual(f.roles, []);
                        f.assertFollower();
                    }
                } finally {
                    clearTimeout(timer);
                    f.election.stopping = true;
                    delay.resolve();
                    await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                    globalThis.setTimeout = originalTimeout;
                }
            });
        }
    }
});
