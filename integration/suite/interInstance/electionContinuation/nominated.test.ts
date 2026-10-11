import assert from 'node:assert/strict';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { waitFor } from '../leaderLiveness/fixture';
import { createElectionFixture, deferred } from './fixture';

type Election = ReturnType<typeof createElectionFixture>['election'] & {
    takeoverAsNominated(): Promise<void>;
};

suite('Nominated takeover continuation fencing', () => {
    let fixture: ReturnType<typeof createElectionFixture>;
    let pending: Promise<void> | undefined;
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

    test('an uninterrupted nomination can replace a fresh resigning leader', async () => {
        await fixture.write({ instanceId: 'resigning', electedAt: 99_000, lastHeartbeat: 100_000 });
        pending = (fixture.election as Election).takeoverAsNominated();
        await fixture.completeCandidate(pending);
        assert.equal(fixture.updates.length, 1);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
        assert.deepEqual(
            fixture.roles.map(role => role.leader),
            [true]
        );
    });

    for (const boundary of ['write', 'confirmation'] as const) {
        test(`${boundary}: a promoted then demoted nomination cannot force another candidate`, async () => {
            await fixture.write({ instanceId: 'resigning', electedAt: 99_000, lastHeartbeat: 100_000 });
            const waiting = boundary === 'write' ? fixture.holdNextWrite() : undefined;
            let settled = false;
            pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                settled = true;
            });
            try {
                await (waiting?.entered.promise ?? fixture.confirmationEntered.promise);
                await fixture.election.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                fixture.advance(2);
                const successor = { instanceId: 'newer-successor', electedAt: 100_001, lastHeartbeat: 100_002 };
                await fixture.write(successor);
                await fixture.election.checkLeader();
                fixture.assertFollower();
                waiting?.gate.resolve();
                await fixture.completeCandidate(Promise.resolve());
                await waitFor(() => settled || fixture.updates.length > 1);
                await fixture.completeCandidate(pending);
                assert.equal(fixture.updates.length, 1, 'invalidated nomination wrote another forced candidate');
                assert.deepEqual(fixture.read(), successor);
                assert.deepEqual(
                    fixture.roles.map(role => role.leader),
                    [true, false]
                );
                fixture.assertFollower();
            } finally {
                waiting?.gate.resolve();
            }
        });
    }

    for (const invalidated of [false, true]) {
        test(`${invalidated ? 'invalidated' : 'unchanged'} decision across the retry delay fences force eligibility`, async () => {
            const originalTimeout = globalThis.setTimeout;
            const entered = deferred();
            const delay = deferred();
            let timer: NodeJS.Timeout | undefined;
            let finishDelay: (() => void) | undefined;
            globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                if (args[1] !== 200) {
                    return originalTimeout(...args);
                }
                timer = originalTimeout(() => {}, 60_000);
                finishDelay = () => args[0](undefined);
                entered.resolve();
                void delay.promise.then(() => finishDelay?.());
                return timer;
            }) as typeof setTimeout;
            let settled = false;
            try {
                pending = (fixture.election as Election).takeoverAsNominated().finally(() => {
                    settled = true;
                });
                await fixture.confirmationEntered.promise;
                await fixture.write(undefined);
                await fixture.completeCandidate(Promise.resolve());
                await entered.promise;
                let successor: ReturnType<typeof fixture.self> | undefined;
                if (invalidated) {
                    await fixture.write(fixture.self());
                    await fixture.election.checkLeader();
                    assert.equal(LeaderElectionService.isLeader(), true);
                    fixture.advance(2);
                    successor = { instanceId: 'newer-successor', electedAt: 100_001, lastHeartbeat: 100_002 };
                    await fixture.write(successor);
                    await fixture.election.checkLeader();
                    fixture.assertFollower();
                }
                delay.resolve();
                await waitFor(() => settled || fixture.updates.length > 1);
                await fixture.completeCandidate(pending);
                assert.equal(fixture.updates.length, invalidated ? 1 : 2);
                if (invalidated) {
                    assert.deepEqual(fixture.read(), successor);
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        [true, false]
                    );
                    fixture.assertFollower();
                } else {
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        [true]
                    );
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
});
