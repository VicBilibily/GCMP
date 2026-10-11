import assert from 'node:assert/strict';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { createElectionFixture } from './fixture';

suite('Leader election continuation fencing', () => {
    let fixture: ReturnType<typeof createElectionFixture>;
    setup(() => {
        fixture = createElectionFixture();
    });
    teardown(async () => {
        await fixture.dispose();
    });

    for (const branch of ['self', 'reclaim'] as const) {
        for (const visible of ['successor', 'none', 'stale-self'] as const) {
            test(`${branch}: a late heartbeat cannot restore leadership after losing to ${visible}`, async () => {
                await fixture.seed(branch);
                const waiting = fixture.holdNextWrite();
                const pending = fixture.election.checkLeader();
                try {
                    await waiting.entered.promise;
                    await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
                    await fixture.election.checkLeader();
                    fixture.assertFollower();
                    if (visible !== 'successor') {
                        await fixture.write(visible === 'none' ? undefined : fixture.self());
                    }
                    waiting.gate.resolve();
                    await pending;
                    fixture.assertFollower();
                    assert.deepEqual(fixture.roles, [{ leader: false, term: undefined }]);
                    assert.equal(fixture.updates.length, 1);
                } finally {
                    waiting.gate.resolve();
                    await fixture.completeCandidate(pending);
                }
            });
        }

        test(`${branch}: a successor observed only at heartbeat completion cannot produce a promotion`, async () => {
            await fixture.seed(branch);
            const waiting = fixture.holdNextWrite();
            const pending = fixture.election.checkLeader();
            try {
                await waiting.entered.promise;
                await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
                fixture.election.setLeaderState(false);
                waiting.gate.resolve();
                await pending;
                fixture.assertFollower();
                assert.deepEqual(fixture.roles, [{ leader: false, term: undefined }]);
            } finally {
                waiting.gate.resolve();
                await fixture.completeCandidate(pending);
            }
        });

        for (const elapsed of [7500, 10_000]) {
            test(`${branch}: ${elapsed}ms persistence wait leaves heartbeat scheduling independent`, async () => {
                await fixture.seed(branch);
                const waiting = fixture.holdNextWrite();
                const pending = fixture.election.checkLeader();
                try {
                    await waiting.entered.promise;
                    fixture.advance(5000);
                    await fixture.election.checkLeader();
                    assert.equal(fixture.updates.length, 2, 'next heartbeat was blocked by the older write');
                    fixture.advance(elapsed - 5000);
                    waiting.gate.resolve();
                    await pending;
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                    assert.deepEqual(fixture.roles, []);
                    assert.equal(fixture.read()?.lastHeartbeat, 105_000);
                } finally {
                    waiting.gate.resolve();
                    await fixture.completeCandidate(pending);
                }
            });
        }
    }

    test('self adoption re-reads identity after an asynchronous boundary', async () => {
        await fixture.write(fixture.self());
        const pending = fixture.election.checkLeader();
        await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
        await pending;
        fixture.assertFollower();
        assert.deepEqual(fixture.roles, []);
        assert.equal(fixture.election.ownElectedAt, 0);
    });

    test('accepting a newer self term neither overwrites it nor allows the old heartbeat to revert it', async () => {
        await fixture.seed();
        const waiting = fixture.holdNextWrite();
        const pending = fixture.election.checkLeader();
        try {
            await waiting.entered.promise;
            await fixture.write(fixture.self(100_001));
            await fixture.election.checkLeader();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
            waiting.gate.resolve();
            await pending;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
            assert.equal(fixture.read()?.electedAt, 100_001);
            assert.deepEqual(fixture.roles, []);
            assert.deepEqual(
                fixture.identities.filter(identity => identity.term === 'continuation-local:100001'),
                [{ term: 'continuation-local:100001', ownedTerm: 'continuation-local:100001', leader: true }]
            );
        } finally {
            waiting.gate.resolve();
            await fixture.completeCandidate(pending);
        }
    });

    for (const boundary of ['write', 'confirmation'] as const) {
        test(`${boundary}: a candidate that lost cannot accept its stale self record on completion`, async () => {
            const waiting = boundary === 'write' ? fixture.holdNextWrite() : undefined;
            const pending = fixture.election.becomeLeader(true);
            try {
                await (waiting?.entered.promise ?? fixture.confirmationEntered.promise);
                await fixture.election.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
                await fixture.election.checkLeader();
                fixture.assertFollower();
                await fixture.write(fixture.self());
                waiting?.gate.resolve();
                await fixture.completeCandidate(pending);
                fixture.assertFollower();
                assert.deepEqual(
                    fixture.roles.map(role => role.leader),
                    [true, false]
                );
            } finally {
                waiting?.gate.resolve();
                await fixture.completeCandidate(pending);
            }
        });
    }

    test('an election loss invalidates another pending adoption even when already a follower', async () => {
        const candidate = fixture.election.becomeLeader(true);
        await fixture.confirmationEntered.promise;
        const adoption = fixture.election.checkLeader();
        await fixture.write({ instanceId: 'successor', electedAt: 100_001, lastHeartbeat: 100_000 });
        try {
            await fixture.completeCandidate(candidate);
            await adoption;
            fixture.assertFollower();
            assert.deepEqual(fixture.roles, []);
        } finally {
            await fixture.completeCandidate(candidate);
            await adoption;
        }
    });

    test('manual handoff invalidates a pending heartbeat beyond the grace period', async () => {
        await fixture.seed();
        const waiting = fixture.holdNextWrite();
        const pending = fixture.election.checkLeader();
        try {
            await waiting.entered.promise;
            assert.equal(await LeaderElectionService.resignLeadership(), 'resigned');
            fixture.advance(5001);
            await fixture.write(fixture.self());
            waiting.gate.resolve();
            await pending;
            fixture.assertFollower();
            assert.deepEqual(
                fixture.roles.map(role => role.leader),
                [false]
            );
        } finally {
            waiting.gate.resolve();
            await fixture.completeCandidate(pending);
        }
    });

    test('a stopped and restarted lifecycle is not promoted by its previous heartbeat', async () => {
        await fixture.seed();
        const waiting = fixture.holdNextWrite();
        const pending = fixture.election.checkLeader();
        try {
            await waiting.entered.promise;
            await LeaderElectionService.stop();
            LeaderElectionService.initialize(fixture.context);
            clearTimeout(fixture.election.startTimer);
            fixture.election.startTimer = undefined;
            waiting.gate.resolve();
            await pending;
            fixture.assertFollower();
            assert.deepEqual(
                fixture.roles.map(role => role.leader),
                [false]
            );
        } finally {
            waiting.gate.resolve();
            await fixture.completeCandidate(pending);
        }
    });

    test('normal first election publishes authority together with its leader event', async () => {
        const pending = fixture.election.becomeLeader();
        await fixture.completeCandidate(pending);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
        assert.deepEqual(fixture.roles, [{ leader: true, term: 'continuation-local:100000' }]);
        assert.equal(fixture.updates.length, 1);
    });

    for (const ownedAt of [0, 99_999]) {
        test(`promotion rejects a missing or mismatched owned timestamp ${ownedAt}`, async () => {
            await fixture.write(fixture.self());
            fixture.election.ownElectedAt = ownedAt;
            fixture.election.setLeaderState(true);
            fixture.assertFollower();
            assert.deepEqual(fixture.roles, []);
        });
    }

    test('a heartbeat timestamp change is not a term change', async () => {
        await fixture.seed();
        const waiting = fixture.holdNextWrite();
        const pending = fixture.election.checkLeader();
        try {
            await waiting.entered.promise;
            fixture.advance(1);
            await fixture.write(fixture.self());
            waiting.gate.resolve();
            await pending;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
            assert.deepEqual(fixture.roles, []);
        } finally {
            waiting.gate.resolve();
            await fixture.completeCandidate(pending);
        }
    });

    test('failed persistence still rejects and a later heartbeat remains usable', async () => {
        await fixture.seed();
        const original = fixture.context.globalState.update;
        const failure = new Error('controlled persistence failure');
        fixture.context.globalState.update = async () => {
            throw failure;
        };
        await assert.rejects(fixture.election.checkLeader(), error => error === failure);
        fixture.context.globalState.update = original;
        await fixture.election.checkLeader();
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
        assert.deepEqual(fixture.roles, []);
    });
});
