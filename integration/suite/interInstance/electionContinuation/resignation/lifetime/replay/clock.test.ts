import assert from 'node:assert/strict';
import { InterInstanceBus } from '../../../../../../../src/interInstance/interInstanceBus';
import { LeaderElectionService } from '../../../../../../../src/status/leaderElectionService';
import { createLivenessFixture } from '../../../../leaderLiveness/fixture';
import { createResignationFixture } from '../../fixture';

suite('Revoked candidate replay across clock changes', () => {
    for (const outcome of ['failed-receipt', 'cancelled'] as const) {
        for (const elapsed of [10, 0, -10, -20000]) {
            for (const previouslyOwned of [false, true]) {
                test(`${outcome}/${elapsed}ms/owned=${previouslyOwned}: replacement stays above every issued candidate`, async () => {
                    const f = createResignationFixture();
                    const update = f.context.globalState.update;
                    const failure = new Error('candidate write rejected after becoming visible');
                    try {
                        if (previouslyOwned) {
                            await f.completeCandidate(f.election.becomeLeader());
                            await f.write({
                                instanceId: 'foreign-successor',
                                electedAt: 100001,
                                lastHeartbeat: Date.now()
                            });
                            await f.checkLeader();
                            f.assertFollower();
                            f.advance(15001);
                            await f.write(undefined);
                        }
                        if (outcome === 'failed-receipt') {
                            f.context.globalState.update = async (key: string, value: unknown) => {
                                await update.call(f.context.globalState, key, value);
                                throw failure;
                            };
                            await assert.rejects(f.election.becomeLeader(), failure);
                            f.context.globalState.update = update;
                        } else {
                            const pending = f.election.becomeLeader();
                            await new Promise<void>(resolve => setImmediate(resolve));
                            InterInstanceBus.cancelLeaderLiveness();
                            await f.completeCandidate(pending);
                        }
                        const revoked = f.read();
                        assert.ok(revoked);
                        assert.equal(revoked.electedAt, previouslyOwned ? 115001 : 100000);
                        await f.checkLeader();
                        f.assertFollower();
                        assert.equal(f.election.ownElectedAt, previouslyOwned ? 100000 : 0);
                        await f.write(undefined);
                        f.advance(elapsed);
                        const wallNow = Date.now();
                        await f.completeCandidate(f.checkLeader());
                        const replacement = f.read();
                        assert.ok(replacement);
                        assert.ok(
                            replacement.electedAt > revoked.electedAt,
                            'new candidate reused or fell below a revoked term'
                        );
                        assert.equal(replacement.electedAt, Math.max(wallNow, revoked.electedAt + 1));
                        assert.equal(replacement.lastHeartbeat, wallNow);
                        const term = `${replacement.instanceId}:${replacement.electedAt}`;
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        const roles = f.roles.length;
                        const identities = f.identities.length;
                        for (let replay = 0; replay < 3; replay++) {
                            await f.write(revoked);
                            await f.checkLeader();
                            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                            assert.equal(f.read()?.lastHeartbeat, Date.now());
                            assert.equal(f.roles.length, roles);
                            assert.equal(f.identities.length, identities);
                            f.advance(1);
                        }
                    } finally {
                        f.context.globalState.update = update;
                        await f.dispose();
                    }
                });
            }
        }
    }

    for (const outcome of ['failed-receipt', 'cancelled'] as const) {
        for (const elapsed of [10, 0, -10]) {
            test(`real IPC/${outcome}/${elapsed}ms: replay cannot replace the successor authority`, async () => {
                const f = await createLivenessFixture(0);
                const originalNow = Date.now;
                const update = f.context.globalState.update;
                const failure = new Error('IPC candidate write rejected');
                let now = originalNow();
                Date.now = () => now;
                try {
                    await f.write(undefined);
                    f.context.globalState.update = async (key: string, value: unknown) => {
                        await update.call(f.context.globalState, key, value);
                        if (outcome === 'failed-receipt') {
                            throw failure;
                        }
                        InterInstanceBus.cancelLeaderLiveness();
                    };
                    if (outcome === 'failed-receipt') {
                        await assert.rejects(f.election.becomeLeader(), failure);
                    } else {
                        await f.election.becomeLeader();
                    }
                    f.context.globalState.update = update;
                    const revoked = f.read();
                    assert.ok(revoked);
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                    await f.write(undefined);
                    now += elapsed;
                    await f.election.becomeLeader();
                    await f.bus.roleSwitchChain;
                    const term = LeaderElectionService.getOwnedAuthorityTerm();
                    assert.ok(term);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), term);
                    assert.ok(f.bus.server);
                    assert.ok((f.read()?.electedAt ?? 0) > revoked.electedAt);
                    assert.equal(f.read()?.lastHeartbeat, now);
                    const changes: Array<string | undefined> = [];
                    const subscription = InterInstanceBus.onAuthorityChanged(value => changes.push(value));
                    try {
                        await f.write(revoked);
                        await f.election.checkLeader();
                        await f.bus.roleSwitchChain;
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), term);
                        assert.equal(InterInstanceBus.getAuthorityTerm(), term);
                        assert.ok(f.bus.server);
                        assert.deepEqual(changes, []);
                    } finally {
                        subscription.dispose();
                    }
                } finally {
                    f.context.globalState.update = update;
                    Date.now = originalNow;
                    await f.dispose();
                }
            });
        }
    }
});
