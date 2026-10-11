import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../src/interInstance';
import type { InterInstanceEvent, LeaderResigningEvent } from '../../../../src/interInstance/eventProtocol';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { waitFor } from '../leaderLiveness/fixture';
import { createElectionFixture, deferred } from './fixture';

type Election = ReturnType<typeof createElectionFixture>['election'] & {
    takeoverAsNominated(): Promise<void>;
    waitForNominatedTakeover(nextLeaderId: string, resigningLeaderId: string): Promise<void>;
    recoverAfterLeaderResigning(resigningLeaderId: string): Promise<void>;
};
interface BusInternals {
    instanceId: string | undefined;
    authorityTerm: string | undefined;
    dispatchEvent(event: InterInstanceEvent, source?: 'ipc'): void;
}

suite('Resignation authority admission and waiting continuation', () => {
    const source = { instanceId: 'resigning-source', electedAt: 99_500, lastHeartbeat: 100_000 };
    const sourceTerm = `${source.instanceId}:${source.electedAt}`;
    const bus = InterInstanceBus as unknown as BusInternals;
    let fixture: ReturnType<typeof createElectionFixture>;
    let election: Election;
    let previousBus: Pick<BusInternals, 'instanceId' | 'authorityTerm'>;
    let original: Pick<Election, 'takeoverAsNominated' | 'waitForNominatedTakeover' | 'recoverAfterLeaderResigning'>;
    let pending: Promise<void>[];
    let calls: string[];
    const track = (branch: string, operation: Promise<void>) => {
        calls.push(branch);
        pending.push(operation);
        return operation;
    };
    setup(async () => {
        fixture = createElectionFixture();
        election = fixture.election as Election;
        previousBus = { instanceId: bus.instanceId, authorityTerm: bus.authorityTerm };
        original = {
            takeoverAsNominated: election.takeoverAsNominated,
            waitForNominatedTakeover: election.waitForNominatedTakeover,
            recoverAfterLeaderResigning: election.recoverAfterLeaderResigning
        };
        pending = [];
        calls = [];
        await fixture.write(source);
        bus.instanceId = election.instanceId;
        bus.authorityTerm = sourceTerm;
        election.takeoverAsNominated = () => track('self', original.takeoverAsNominated.call(election));
        election.waitForNominatedTakeover = (next, leader) =>
            track('other', original.waitForNominatedTakeover.call(election, next, leader));
        election.recoverAfterLeaderResigning = leader =>
            track('none', original.recoverAfterLeaderResigning.call(election, leader));
        LeaderElectionService.subscribeToLeaderResigning();
    });
    teardown(async () => {
        election.stopping = true;
        election.lifecycleGeneration++;
        try {
            await fixture.completeCandidate(Promise.all(pending).then(() => {}));
        } finally {
            Object.assign(election, original);
            Object.assign(bus, previousBus);
            await fixture.dispose();
        }
    });

    function dispatch(branch: 'self' | 'other' | 'none', kind = 'matching-term') {
        const event: LeaderResigningEvent = {
            type: 'leaderResigning',
            timestamp: kind === 'expired-event' ? Date.now() - 10_001 : Date.now() - 1000,
            senderInstanceId: kind === 'foreign-sender' ? 'foreign-process' : source.instanceId,
            payload: {
                leaderId: source.instanceId,
                reason: 'manual',
                sourceAuthorityTerm:
                    kind === 'legacy-no-term' ? undefined
                    : kind === 'old-term' ? `${source.instanceId}:99000`
                    : kind === 'empty-term' ? ''
                    : sourceTerm,
                nextLeaderId:
                    branch === 'self' ? election.instanceId
                    : branch === 'other' ? 'nominated-other'
                    : undefined
            }
        };
        bus.dispatchEvent(event, 'ipc');
    }

    for (const branch of ['self', 'other', 'none'] as const) {
        for (const kind of [
            'matching-term',
            'old-term',
            'legacy-no-term',
            'expired-event',
            'foreign-sender',
            'empty-term'
        ]) {
            test(`${branch} resignation ${kind} is checked by the real notification entry`, async () => {
                const permitted = kind === 'matching-term' || kind === 'legacy-no-term';
                dispatch(branch, kind);
                assert.deepEqual(calls, permitted ? [branch] : []);
                if (permitted) {
                    await waitFor(() => fixture.updates.length > 0);
                    await fixture.completeCandidate(pending[0]);
                    assert.equal(fixture.updates.length, 1);
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                    assert.deepEqual(
                        fixture.roles.map(role => role.leader),
                        [true]
                    );
                } else {
                    assert.equal(fixture.updates.length, 0);
                    assert.deepEqual(fixture.read(), source);
                    assert.deepEqual(fixture.roles, []);
                    fixture.assertFollower();
                }
            });
        }
    }

    for (const round of [1, 2]) {
        for (const change of [
            'same-term-heartbeat',
            'missing-record',
            'successor',
            'source-new-term',
            'source-old-term',
            'decision-invalidation',
            'identity-ABA',
            'pause',
            'stop',
            'restart'
        ] as const) {
            test(`accepted resignation waiting round ${round} rechecks ${change} before force recovery`, async () => {
                const originalTimeout = globalThis.setTimeout;
                const entered = deferred();
                const delay = deferred();
                let timer: NodeJS.Timeout | undefined;
                let waits = 0;
                let settled = false;
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    if (args[1] !== 200 || ++waits !== round) {
                        return originalTimeout(...args);
                    }
                    timer = originalTimeout(() => {}, 60_000);
                    entered.resolve();
                    void delay.promise.then(() => args[0](undefined));
                    return timer;
                }) as typeof setTimeout;
                try {
                    dispatch('other');
                    const operation = pending[0].finally(() => {
                        settled = true;
                    });
                    await entered.promise;
                    const decision = election.decisionGeneration;
                    if (change === 'same-term-heartbeat') {
                        fixture.advance(1);
                        await fixture.write({ ...source, lastHeartbeat: Date.now() });
                    } else if (change === 'missing-record') {
                        await fixture.write(undefined);
                    } else if (change === 'successor') {
                        await fixture.write({ ...source, instanceId: 'nominated-other', electedAt: 100_001 });
                    } else if (change === 'source-new-term' || change === 'source-old-term') {
                        await fixture.write({ ...source, electedAt: change === 'source-new-term' ? 100_001 : 99_000 });
                    } else if (change === 'decision-invalidation') {
                        election.setLeaderState(false);
                    } else if (change === 'identity-ABA') {
                        await fixture.write({ ...source, electedAt: 100_001 });
                        await election.checkLeader();
                        await fixture.write(source);
                        await election.checkLeader();
                    } else if (change === 'pause') {
                        election.electionPausedUntil = Date.now() + 1000;
                    } else {
                        await LeaderElectionService.stop();
                        if (change === 'restart') {
                            LeaderElectionService.initialize(fixture.context);
                            clearTimeout(election.startTimer);
                            election.startTimer = undefined;
                        }
                    }
                    if (change === 'source-new-term' || change === 'source-old-term') {
                        assert.equal(
                            election.decisionGeneration,
                            decision,
                            'record-only changes must test the term guard'
                        );
                    }
                    if (change === 'decision-invalidation' || change === 'identity-ABA') {
                        assert.ok(election.decisionGeneration > decision);
                    }
                    const beforeRelease = fixture.read();
                    const permitted = change === 'same-term-heartbeat' || change === 'missing-record';
                    delay.resolve();
                    await waitFor(() => settled || fixture.updates.length > 0);
                    await fixture.completeCandidate(operation);
                    assert.equal(fixture.updates.length, permitted ? 1 : 0);
                    assert.deepEqual(calls, permitted ? ['other', 'none'] : ['other']);
                    if (permitted) {
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `continuation-local:${Date.now()}`);
                        assert.deepEqual(
                            fixture.roles.map(role => role.leader),
                            [true]
                        );
                    } else {
                        assert.deepEqual(fixture.read(), beforeRelease);
                        assert.deepEqual(fixture.roles, []);
                        fixture.assertFollower();
                    }
                } finally {
                    clearTimeout(timer);
                    election.stopping = true;
                    delay.resolve();
                    await fixture.completeCandidate(Promise.all(pending).then(() => {}));
                    globalThis.setTimeout = originalTimeout;
                }
            });
        }
    }
});
