import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../../fixture';

suite('Candidate issuance watermark lifetime', () => {
    for (const elapsed of [0, -10]) {
        for (const reject of [false, true]) {
            for (const confirmFirst of [false, true]) {
                test(`pending/${elapsed}ms/reject=${reject}/confirmed=${confirmFirst}: old settlement cannot roll back issuance`, async () => {
                    const f = createResignationFixture();
                    const update = f.context.globalState.update;
                    const held = f.holdNextWrite();
                    const failure = new Error('late candidate receipt rejected');
                    let settled: Promise<void> | undefined;
                    let successor: Promise<void> | undefined;
                    try {
                        f.context.globalState.update = async (key: string, value: unknown) => {
                            await update.call(f.context.globalState, key, value);
                            if (reject) {
                                throw failure;
                            }
                        };
                        const pending = f.election.becomeLeader();
                        settled = reject ? assert.rejects(pending, failure) : pending;
                        await held.entered.promise;
                        const revoked = f.read();
                        assert.ok(revoked);
                        f.context.globalState.update = update;
                        InterInstanceBus.cancelLeaderLiveness();
                        await f.write(undefined);
                        f.advance(elapsed);
                        successor = f.election.becomeLeader();
                        await new Promise<void>(resolve => setImmediate(resolve));
                        const replacement = f.read();
                        assert.ok(replacement);
                        assert.ok(replacement.electedAt > revoked.electedAt);
                        assert.equal(replacement.lastHeartbeat, Date.now());
                        if (confirmFirst) {
                            await f.completeCandidate(successor);
                        }
                        held.gate.resolve();
                        await f.completeCandidate(settled);
                        await f.completeCandidate(successor);
                        const term = `${replacement.instanceId}:${replacement.electedAt}`;
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        await f.write(revoked);
                        await f.checkLeader();
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        await f.write(undefined);
                        f.advance(-10);
                        await f.completeCandidate(f.election.becomeLeader());
                        assert.equal(f.read()?.electedAt, replacement.electedAt + 1);
                        assert.equal(f.read()?.lastHeartbeat, Date.now());
                    } finally {
                        held.gate.resolve();
                        f.context.globalState.update = update;
                        try {
                            if (settled) {
                                await f.completeCandidate(settled);
                            }
                            if (successor) {
                                await f.completeCandidate(successor);
                            }
                        } finally {
                            await f.dispose();
                        }
                    }
                });
            }
        }
    }

    for (const elapsed of [0, -10]) {
        test(`repeated failure/${elapsed}ms: every attempted write consumes a distinct term`, async () => {
            const f = createResignationFixture();
            const update = f.context.globalState.update;
            const failure = new Error('repeated candidate receipt rejected');
            const revoked: Array<NonNullable<ReturnType<typeof f.read>>> = [];
            try {
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    throw failure;
                };
                for (let attempt = 0; attempt < 3; attempt++) {
                    await f.write(undefined);
                    await assert.rejects(f.election.becomeLeader(), failure);
                    const record = f.read();
                    assert.ok(record);
                    assert.equal(record.electedAt, 100000 + attempt);
                    assert.equal(record.lastHeartbeat, Date.now());
                    revoked.push(record);
                    f.assertFollower();
                    assert.equal(f.election.ownElectedAt, 0);
                    f.advance(elapsed);
                }
                f.context.globalState.update = update;
                await f.write(undefined);
                await f.completeCandidate(f.checkLeader());
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100003');
                for (const record of revoked) {
                    await f.write(record);
                    await f.checkLeader();
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100003');
                }
            } finally {
                f.context.globalState.update = update;
                await f.dispose();
            }
        });
    }

    test('a new instance ID does not inherit the previous instance candidate watermark', async () => {
        const f = createResignationFixture();
        const update = f.context.globalState.update;
        const failure = new Error('previous instance candidate rejected');
        try {
            f.context.globalState.update = async (key: string, value: unknown) => {
                await update.call(f.context.globalState, key, value);
                throw failure;
            };
            await assert.rejects(f.election.becomeLeader(), failure);
            f.context.globalState.update = update;
            assert.equal(f.read()?.electedAt, 100000);
            const previousId = f.election.instanceId;
            await LeaderElectionService.stop();
            f.advance(-10);
            LeaderElectionService.initialize(f.context);
            assert.notEqual(f.election.instanceId, previousId);
            await f.completeCandidate(f.checkLeader());
            assert.equal(f.read()?.electedAt, 99990);
            assert.equal(f.read()?.lastHeartbeat, 99990);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), `${f.election.instanceId}:99990`);
        } finally {
            f.context.globalState.update = update;
            await f.dispose();
        }
    });
});
