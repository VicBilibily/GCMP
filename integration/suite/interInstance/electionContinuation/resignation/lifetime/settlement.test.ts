import assert from 'node:assert/strict';
import { LeaderElectionService } from '../../../../../../src/status/leaderElectionService';
import { createResignationFixture } from '../fixture';

suite('Candidate write settlement authority', () => {
    for (const reject of [false, true]) {
        test(`incumbent/write-rejected=${reject}: only a successful new candidate can replace the owned term`, async () => {
            const f = createResignationFixture();
            const update = f.context.globalState.update;
            const exact = new Error('visible incumbent candidate receipt rejected');
            try {
                await f.seed();
                await f.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                await f.write(undefined);
                f.advance(1);
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    assert.equal(f.read()?.electedAt, 100001);
                    if (reject) {
                        throw exact;
                    }
                };
                const pending = f.election.becomeLeader();
                if (reject) {
                    await assert.rejects(pending, exact);
                } else {
                    await f.completeCandidate(pending);
                }
                f.context.globalState.update = update;
                const writes = f.updates.length;
                await f.checkLeader();
                await f.checkLeader();
                if (reject) {
                    assert.notEqual(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
                    assert.equal(f.updates.length, writes);
                    assert.ok(f.identities.every(identity => identity.ownedTerm !== 'continuation-local:100001'));
                } else {
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
                }
            } finally {
                f.context.globalState.update = update;
                await f.dispose();
            }
        });
    }

    for (const outcome of ['success', 'failure', 'failure-with-valid-B', 'failure-with-pending-B'] as const) {
        test(`early-promotion/${outcome}: a late write outcome is bound to its exact candidate`, async () => {
            const f = createResignationFixture();
            const update = f.context.globalState.update;
            const held = f.holdNextWrite();
            const exact = new Error('early-promoted candidate receipt rejected');
            let settled: Promise<void> | undefined;
            let another: Promise<void> | undefined;
            try {
                f.context.globalState.update = async (key: string, value: unknown) => {
                    await update.call(f.context.globalState, key, value);
                    if (outcome !== 'success') {
                        throw exact;
                    }
                };
                const pending = f.election.becomeLeader();
                settled = outcome === 'success' ? pending : assert.rejects(pending, exact);
                await held.entered.promise;
                assert.deepEqual(f.read(), f.self());
                f.context.globalState.update = update;
                await f.checkLeader();
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100000');
                if (outcome.endsWith('-B')) {
                    f.advance(1);
                    await f.write(undefined);
                    another = f.election.becomeLeader();
                    await new Promise<void>(resolve => setImmediate(resolve));
                    assert.deepEqual(f.read(), f.self(100001));
                    if (outcome === 'failure-with-valid-B') {
                        await f.completeCandidate(another);
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'continuation-local:100001');
                    }
                }
                held.gate.resolve();
                await f.completeCandidate(settled);
                if (another) {
                    await f.completeCandidate(another);
                }
                if (outcome === 'failure') {
                    f.assertFollower();
                    assert.deepEqual(
                        f.roles.map(role => role.leader),
                        [true, false]
                    );
                    const writes = f.updates.length;
                    await f.checkLeader();
                    f.assertFollower();
                    assert.equal(f.updates.length, writes);
                } else {
                    assert.equal(
                        LeaderElectionService.getOwnedAuthorityTerm(),
                        `continuation-local:${outcome === 'success' ? 100000 : 100001}`
                    );
                    assert.deepEqual(
                        f.roles.map(role => role.leader),
                        [true]
                    );
                }
            } finally {
                held.gate.resolve();
                f.context.globalState.update = update;
                try {
                    if (settled) {
                        await f.completeCandidate(settled);
                    }
                    if (another) {
                        await f.completeCandidate(another);
                    }
                } finally {
                    await f.dispose();
                }
            }
        });
    }
});
