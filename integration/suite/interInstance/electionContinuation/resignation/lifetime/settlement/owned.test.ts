import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../../fixture';

suite('Owned candidate settlement isolation', () => {
    for (const rejectA of [false, true]) {
        for (const outcomeB of ['none', 'rejected', 'cancelled', 'confirmed'] as const) {
            for (const replay of [false, true]) {
                test(`A-rejected=${rejectA}/B=${outcomeB}/replay=${replay}: settlement revokes only failed ownership`, async () => {
                    const f = createResignationFixture();
                    const update = f.context.globalState.update;
                    const held = f.holdNextWrite();
                    const errorA = new Error('late A receipt rejected');
                    const errorB = new Error('B receipt rejected');
                    let settledA: Promise<void> | undefined;
                    try {
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            if (rejectA) {
                                throw errorA;
                            }
                        };
                        const pendingA = f.election.becomeLeader();
                        settledA = rejectA ? assert.rejects(pendingA, errorA) : pendingA;
                        await held.entered.promise;
                        const recordA = f.read();
                        assert.ok(recordA);
                        const termA = `${recordA.instanceId}:${recordA.electedAt}`;
                        f.context.globalState.update = update;
                        await f.checkLeader();
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), termA);
                        let termB: string | undefined;
                        if (outcomeB !== 'none') {
                            f.advance(1);
                            await f.write(undefined);
                            if (outcomeB === 'rejected') {
                                f.context.globalState.update = async (key: string, value: unknown) => {
                                    await update.call(f.context.globalState, key, value);
                                    throw errorB;
                                };
                                await assert.rejects(f.election.becomeLeader(), errorB);
                                f.context.globalState.update = update;
                            } else {
                                const next = f.election.becomeLeader();
                                await new Promise<void>(resolve => setImmediate(resolve));
                                if (outcomeB === 'cancelled') {
                                    InterInstanceBus.cancelLeaderLiveness();
                                }
                                await f.completeCandidate(next);
                            }
                            const recordB = f.read();
                            assert.ok(recordB);
                            assert.ok(recordB.electedAt > recordA.electedAt);
                            termB = `${recordB.instanceId}:${recordB.electedAt}`;
                            if (outcomeB === 'confirmed') {
                                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), termB);
                            }
                        }
                        held.gate.resolve();
                        await f.completeCandidate(settledA);
                        if (replay) {
                            await f.write(recordA);
                        }
                        const writes = f.updates.length;
                        for (let heartbeat = 0; heartbeat < 3; heartbeat++) {
                            await f.checkLeader();
                        }
                        const owned = LeaderElectionService.getOwnedAuthorityTerm();
                        if (outcomeB === 'confirmed') {
                            assert.equal(owned, termB);
                        } else if (rejectA) {
                            assert.notEqual(
                                owned,
                                termA,
                                'failed A must not regain authority after B replaces the candidate'
                            );
                            f.assertFollower();
                            assert.equal(f.updates.length, writes, 'failed ownership must not refresh its heartbeat');
                        } else if (replay || outcomeB === 'none') {
                            assert.equal(owned, termA, 'successfully settled A remains recoverable');
                        } else {
                            assert.equal(owned, undefined);
                        }
                    } finally {
                        held.gate.resolve();
                        f.context.globalState.update = update;
                        try {
                            if (settledA) {
                                await f.completeCandidate(settledA);
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
