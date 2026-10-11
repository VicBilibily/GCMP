import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { createQuotaFixture } from './fixture';

suite('Owned quota authority acquisition', () => {
    for (const route of ['local', 'ipc'] as const) {
        for (const scenario of ['owned-A', 'owned-B', 'pending-A', 'pending-B'] as const) {
            test(`${route}/${scenario}: grant creation requires owned authority`, async () => {
                const q = await createQuotaFixture();
                try {
                    if (scenario !== 'owned-A') {
                        await q.beginB();
                    }
                    if (scenario === 'owned-B') {
                        await q.confirmB();
                    }
                    await q.settleA(scenario !== 'owned-A', scenario === 'pending-A');
                    const pending = scenario.startsWith('pending');
                    const term = scenario.endsWith('-A') ? q.termA : q.termB;
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), pending ? undefined : term);
                    const before = q.rate.leaderStore.exportSnapshot(q.now).grants.length;
                    if (route === 'local') {
                        const handle = await q.acquire('acquire-local').promise;
                        assert.ok(handle);
                        assert.equal(handle.authoritative, !pending);
                        assert.equal(handle.authorityTerm, pending ? undefined : term);
                    } else {
                        const requestId = await q.remoteAcquire('acquire-remote', term);
                        assert.equal(q.grants(requestId).length, pending ? 0 : 1);
                        if (!pending) {
                            assert.equal(q.grants(requestId)[0].payload.authorityTerm, term);
                        }
                    }
                    assert.equal(q.rate.leaderStore.exportSnapshot(q.now).grants.length - before, pending ? 0 : 1);
                    if (pending) {
                        assert.equal(LeaderElectionService.isLeader(), true);
                        await q.confirmB();
                        const next = await q.acquire('after-B').promise;
                        assert.equal(next?.authoritative, true);
                        assert.equal(next.authorityTerm, q.termB);
                        assert.deepEqual(q.f.roles, [true]);
                    }
                } finally {
                    await q.dispose();
                }
            });
        }
    }

    for (const replay of [false, true]) {
        test(`replay=${replay}: cancellation during ownerless local fallback removes its queue`, async () => {
            const q = await createQuotaFixture();
            try {
                await q.beginB();
                await q.settleA(true, replay);
                const first = await q.acquire('fallback').promise;
                assert.equal(first?.authoritative, false);
                const queued = q.acquire('fallback');
                const rejected = assert.rejects(queued.promise, error => error instanceof vscode.CancellationError);
                queued.token.cancel();
                await rejected;
                assert.equal(q.rate.localStore.stats('fallback', q.now)?.pending, 0);
                assert.equal(q.rate.leaderStore.stats('fallback', q.now), undefined);
                const cancelled = new vscode.CancellationTokenSource();
                cancelled.cancel();
                try {
                    await assert.rejects(
                        q.acquire('pre-cancelled', { token: cancelled.token }).promise,
                        error => error instanceof vscode.CancellationError
                    );
                } finally {
                    cancelled.dispose();
                }
                assert.equal(q.rate.localStore.stats('pre-cancelled', q.now), undefined);
            } finally {
                await q.dispose();
            }
        });
    }
});
