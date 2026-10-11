import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../../fixture';

suite('Pending successor after owned candidate rejection', () => {
    for (const phase of ['receipt', 'confirmation'] as const) {
        for (const outcomeB of ['success', 'cancelled', 'rejected'] as const) {
            if (phase === 'confirmation' && outcomeB === 'rejected') {
                continue;
            }
            for (const replay of [false, true]) {
                test(`${phase}/B=${outcomeB}/replay=${replay}: failed A cannot invalidate an eligible B continuation`, async () => {
                    const f = createResignationFixture();
                    const update = f.context.globalState.update;
                    const heldA = f.holdNextWrite();
                    const errorA = new Error('owned A failed before pending B settled');
                    const errorB = new Error('pending B also failed');
                    let heldB: ReturnType<typeof f.holdNextWrite> | undefined;
                    let settledA: Promise<void> | undefined;
                    let settledB: Promise<void> | undefined;
                    try {
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            throw errorA;
                        };
                        settledA = assert.rejects(f.election.becomeLeader(), errorA);
                        await heldA.entered.promise;
                        const recordA = f.read();
                        assert.ok(recordA);
                        f.context.globalState.update = update;
                        await f.checkLeader();
                        assert.equal(
                            LeaderElectionService.getOwnedAuthorityTerm(),
                            `${recordA.instanceId}:${recordA.electedAt}`
                        );
                        f.advance(1);
                        await f.write(undefined);
                        if (phase === 'receipt') {
                            heldB = f.holdNextWrite();
                        }
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            if (outcomeB === 'rejected') {
                                throw errorB;
                            }
                        };
                        const pendingB = f.election.becomeLeader();
                        settledB = outcomeB === 'rejected' ? assert.rejects(pendingB, errorB) : pendingB;
                        if (heldB) {
                            await heldB.entered.promise;
                        } else {
                            await new Promise<void>(resolve => setImmediate(resolve));
                        }
                        const recordB = f.read();
                        assert.ok(recordB);
                        assert.ok(recordB.electedAt > recordA.electedAt);
                        f.context.globalState.update = update;
                        heldA.gate.resolve();
                        await settledA;
                        if (replay) {
                            await f.write(recordA);
                        }
                        const writes = f.updates.length;
                        assert.equal(
                            LeaderElectionService.getOwnedAuthorityTerm(),
                            undefined,
                            'failed A is not owned while B remains pending'
                        );
                        if (replay) {
                            await f.checkLeader();
                        }
                        assert.equal(
                            f.updates.length,
                            writes,
                            'pending B must not let failed A refresh shared storage'
                        );
                        await f.write(recordB);
                        if (outcomeB === 'cancelled') {
                            InterInstanceBus.cancelLeaderLiveness();
                        }
                        heldB?.gate.resolve();
                        await f.completeCandidate(settledB);
                        if (outcomeB === 'success') {
                            assert.equal(
                                LeaderElectionService.getOwnedAuthorityTerm(),
                                `${recordB.instanceId}:${recordB.electedAt}`
                            );
                            assert.deepEqual(
                                f.roles.map(role => role.leader),
                                [true]
                            );
                        } else {
                            f.assertFollower();
                            await f.write(recordA);
                            const settledWrites = f.updates.length;
                            for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
                                await f.checkLeader();
                            }
                            f.assertFollower();
                            assert.equal(f.updates.length, settledWrites);
                        }
                    } finally {
                        heldA.gate.resolve();
                        heldB?.gate.resolve();
                        f.context.globalState.update = update;
                        try {
                            if (settledA) {
                                await f.completeCandidate(settledA);
                            }
                            if (settledB) {
                                await f.completeCandidate(settledB);
                            }
                        } finally {
                            await f.dispose();
                        }
                    }
                });
            }
        }
    }
});
