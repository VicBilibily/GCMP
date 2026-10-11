import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../fixture';

suite('Resignation candidate authority lifetime', () => {
    test('a visible candidate with a rejected write receipt cannot be adopted by a later heartbeat', async () => {
        const f = createResignationFixture();
        const originalUpdate = f.context.globalState.update;
        const exactError = new Error('candidate write receipt failed after becoming visible');
        let pending: Promise<void> | undefined;
        try {
            f.context.globalState.update = async (key: string, value: unknown) => {
                await originalUpdate.call(f.context.globalState, key, value);
                assert.deepEqual(f.read(), f.self());
                throw exactError;
            };
            await assert.rejects(f.election.becomeLeader(), exactError);
            const failedCandidate = f.read();
            assert.deepEqual(failedCandidate, f.self());
            assert.equal(f.updates.length, 1);
            assert.equal(f.pending.length, 0);
            f.assertFollower();
            assert.deepEqual(f.roles, []);
            const writes = f.updates.length;
            await f.checkLeader();
            f.assertFollower();
            assert.deepEqual(f.roles, []);
            assert.equal(f.updates.length, writes);
            assert.deepEqual(f.read(), failedCandidate);

            f.context.globalState.update = originalUpdate;
            f.advance(1);
            await f.write(undefined);
            pending = f.election.becomeLeader();
            await Promise.race([f.confirmationEntered.promise, pending]);
            assert.equal(f.updates.length, writes + 1);
            assert.deepEqual(f.read(), f.self(Date.now()));
            f.assertFollower();
            await f.completeCandidate(pending);
            f.assertPromoted();
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.notEqual(f.read()?.electedAt, failedCandidate?.electedAt);
        } finally {
            try {
                if (pending) {
                    await f.completeCandidate(pending);
                }
            } finally {
                f.context.globalState.update = originalUpdate;
                await f.dispose();
            }
        }
    });

    for (const boundary of ['write', 'confirmation'] as const) {
        for (const change of ['unchanged', 'new-confirmed', 'confirmed-ABA', 'explicit-cancellation'] as const) {
            test(`${boundary}/${change}: invalidated force candidate is not adopted by the next heartbeat`, async () => {
                const f = createResignationFixture();
                const held = boundary === 'write' ? f.holdNextWrite() : undefined;
                try {
                    await f.write(f.source);
                    f.capability();
                    f.dispatch('none');
                    assert.equal(f.pending.length, 1);
                    await (held?.entered.promise ?? f.confirmationEntered.promise);
                    assert.equal(f.updates.length, 1);
                    assert.deepEqual(f.read(), f.self());
                    const generation = InterInstanceBus.getConfirmedLeaderAuthority().generation;
                    if (change === 'explicit-cancellation') {
                        InterInstanceBus.cancelLeaderLiveness();
                    } else if (change !== 'unchanged') {
                        f.capability(`${f.source.instanceId}:99502`);
                        if (change === 'confirmed-ABA') {
                            f.capability();
                        }
                    }
                    if (change !== 'unchanged') {
                        assert.ok(InterInstanceBus.getConfirmedLeaderAuthority().generation > generation);
                    }
                    held?.gate.resolve();
                    await f.completeCandidate(f.pending[0]);
                    if (change === 'unchanged') {
                        f.assertPromoted();
                    } else {
                        f.assertFollower();
                    }
                    await f.checkLeader();
                    if (change === 'unchanged') {
                        f.assertPromoted();
                    } else {
                        f.assertFollower();
                        assert.deepEqual(f.roles, []);
                    }
                } finally {
                    held?.gate.resolve();
                    try {
                        await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                    } finally {
                        await f.dispose();
                    }
                }
            });
        }
    }

    for (const kind of ['current-capability', 'duplicate-current', 'legacy-capability', 'duplicate-legacy'] as const) {
        test(`${kind}: identical capabilities remain idempotent during accepted resignation`, async () => {
            const f = createResignationFixture();
            try {
                await f.write(f.source);
                const protocol = kind === 'current-capability' || kind === 'duplicate-current';
                f.capability(f.confirmedTerm, 'ipc', protocol);
                f.dispatch('none');
                assert.equal(f.pending.length, 1);
                await f.confirmationEntered.promise;
                const before = InterInstanceBus.getConfirmedLeaderAuthority();
                assert.equal(before.authorityTerm, f.confirmedTerm);
                assert.equal(f.bus.remoteLeaderLivenessCompatible, protocol);
                if (kind.startsWith('duplicate')) {
                    f.capability(f.confirmedTerm, 'ipc', protocol);
                }
                assert.deepEqual(InterInstanceBus.getConfirmedLeaderAuthority(), before);
                assert.equal(f.bus.remoteLeaderLivenessCompatible, protocol);
                await f.completeCandidate(f.pending[0]);
                f.assertPromoted();
                assert.equal(f.updates.length, 1);
            } finally {
                try {
                    await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                } finally {
                    await f.dispose();
                }
            }
        });
    }

    for (const boundary of ['write', 'confirmation'] as const) {
        for (const change of ['malformed-legacy-ABA', 'capability-true-false'] as const) {
            test(`${boundary}/${change}: restoration cannot revive revoked candidate authority`, async () => {
                const f = createResignationFixture();
                const held = boundary === 'write' ? f.holdNextWrite() : undefined;
                try {
                    await f.write(f.source);
                    f.capability(f.confirmedTerm, 'ipc', change === 'capability-true-false');
                    f.dispatch('none');
                    assert.equal(f.pending.length, 1);
                    await (held?.entered.promise ?? f.confirmationEntered.promise);
                    const before = InterInstanceBus.getConfirmedLeaderAuthority();
                    assert.equal(before.authorityTerm, f.confirmedTerm);
                    if (change === 'malformed-legacy-ABA') {
                        f.capability(`${f.source.instanceId}:invalid`, 'ipc', false);
                        assert.equal(InterInstanceBus.getConfirmedLeaderAuthority().authorityTerm, undefined);
                        assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                    }
                    f.capability(f.confirmedTerm, 'ipc', false);
                    const after = InterInstanceBus.getConfirmedLeaderAuthority();
                    assert.equal(after.authorityTerm, before.authorityTerm);
                    assert.ok(after.generation > before.generation);
                    assert.equal(f.bus.remoteLeaderLivenessCompatible, false);
                    assert.equal(f.updates.length, 1);
                    held?.gate.resolve();
                    await f.completeCandidate(f.pending[0]);
                    f.assertFollower();
                    assert.deepEqual(f.roles, []);
                    await f.checkLeader();
                    f.assertFollower();
                    assert.deepEqual(f.roles, []);
                } finally {
                    held?.gate.resolve();
                    try {
                        await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                    } finally {
                        await f.dispose();
                    }
                }
            });
        }
    }

    for (const boundary of ['write', 'confirmation'] as const) {
        for (const control of ['normal-concurrent', 'new-candidate'] as const) {
            test(`${boundary}/${control}: valid independent leadership is not permanently suppressed`, async () => {
                const f = createResignationFixture();
                const held = boundary === 'write' ? f.holdNextWrite() : undefined;
                try {
                    await f.write(f.source);
                    f.capability();
                    f.dispatch('none');
                    assert.equal(f.pending.length, 1);
                    await (held?.entered.promise ?? f.confirmationEntered.promise);
                    const oldCandidate = f.read();
                    assert.deepEqual(oldCandidate, f.self());
                    if (control === 'normal-concurrent') {
                        await f.checkLeader();
                        f.assertPromoted();
                    } else {
                        InterInstanceBus.cancelLeaderLiveness();
                    }
                    held?.gate.resolve();
                    await f.completeCandidate(f.pending[0]);
                    if (control === 'new-candidate') {
                        f.assertFollower();
                        assert.deepEqual(f.roles, []);
                        f.advance(1);
                        await f.write(f.source);
                        f.capability();
                        f.dispatch('none');
                        assert.equal(f.pending.length, 2);
                        await f.completeCandidate(f.pending[1]);
                        assert.equal(f.updates.length, 2);
                        assert.notEqual(f.read()?.electedAt, oldCandidate?.electedAt);
                    }
                    f.assertPromoted();
                    assert.equal(f.read()?.instanceId, f.election.instanceId);
                    assert.equal(LeaderElectionService.isLeader(), true);
                } finally {
                    held?.gate.resolve();
                    try {
                        await f.completeCandidate(Promise.all(f.pending).then(() => {}));
                    } finally {
                        await f.dispose();
                    }
                }
            });
        }
    }
});
