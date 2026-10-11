import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RateLimiter } from '../../../../../src/rateLimit/rateLimiter';
import { RateLimitStore } from '../../../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { createQuotaFixture } from './fixture';

suite('Owned quota authority restoration', () => {
    for (const cleanup of ['release', 'cancel', 'renew', 'wrong-owner'] as const) {
        test(`${cleanup}: same-role B recovery preserves buffered operations for persisted old leases`, async () => {
            const source = new RateLimitStore('prior');
            const result = source.acquire(
                'old-request',
                'old-bucket',
                { parallel: 1 },
                { requests: 1, tokens: 0 },
                Date.now(),
                {
                    ownerInstanceId: 'prior-owner'
                }
            );
            assert.equal(result.kind, 'granted');
            if (result.kind !== 'granted') {
                throw new Error('Missing prior grant');
            }
            const snapshot = source.exportSnapshot(Date.now());
            const q = await createQuotaFixture(true, snapshot);
            try {
                const requestId = await q.remoteAcquire('old-bucket', q.termA);
                q.advance(100);
                if (cleanup === 'cancel') {
                    RateLimiter.handleRemoteAcquireCancelled(
                        { authorityTerm: 'prior:1', requestId: 'old-request', bucketKey: 'old-bucket' },
                        'prior-owner'
                    );
                } else if (cleanup === 'renew') {
                    RateLimiter.handleRemoteLeaseRenewal(
                        { authorityTerm: 'prior:1', grantId: result.grantId },
                        'prior-owner',
                        q.now
                    );
                } else {
                    RateLimiter.handleRemoteRelease(
                        { authorityTerm: 'prior:1', grantId: result.grantId },
                        cleanup === 'wrong-owner' ? 'other' : 'prior-owner'
                    );
                }
                await q.beginB();
                await q.settleA();
                await q.confirmB();
                q.rate.sweep();
                await q.finishRestore();
                const grants = q.rate.leaderStore.exportSnapshot(q.now).grants;
                assert.equal(grants.length, cleanup === 'renew' || cleanup === 'wrong-owner' ? 1 : 0);
                if (cleanup === 'renew') {
                    assert.equal(grants[0].grantId, result.grantId);
                    assert.ok(grants[0].expiresAt > snapshot.grants[0].expiresAt);
                }
                if (cleanup === 'wrong-owner') {
                    assert.deepEqual(grants, snapshot.grants);
                }
                await q.barrier();
                assert.deepEqual(q.grants(requestId), []);
                const handle = await q.acquire('after-buffered').promise;
                assert.equal(handle?.authorityTerm, q.termB);
            } finally {
                await q.dispose();
            }
        });
    }

    for (const replay of [false, true]) {
        for (const confirmFirst of [false, true]) {
            test(`replay=${replay}/confirmFirst=${confirmFirst}: recovery never grants a failed term and B can recover`, async () => {
                const q = await createQuotaFixture(true);
                try {
                    const waiting = q.acquire('restore-local');
                    const remoteId = await q.remoteAcquire('restore-remote', q.termA);
                    assert.deepEqual(q.grants(remoteId), []);
                    assert.equal(q.rate.leaderStore.stats('restore-local', q.now), undefined);
                    await q.beginB();
                    await q.settleA(true, replay);
                    if (confirmFirst) {
                        await q.confirmB();
                    }
                    const restored = q.finishRestore();
                    await restored.catch(() => {});
                    const handle = await waiting.promise;
                    assert.ok(handle);
                    assert.equal(handle.authoritative, confirmFirst);
                    assert.equal(handle.authorityTerm, confirmFirst ? q.termB : undefined);
                    await q.barrier();
                    assert.deepEqual(q.grants(remoteId), []);
                    if (!confirmFirst) {
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                        assert.deepEqual(q.rate.leaderStore.exportSnapshot(q.now).grants, []);
                        await q.confirmB();
                    }
                    const after = await q.acquire('restore-after-B').promise;
                    assert.equal(after?.authoritative, true);
                    assert.equal(after.authorityTerm, q.termB);
                    assert.deepEqual(q.f.roles, [true]);
                } finally {
                    await q.dispose();
                }
            });
        }

        test(`replay=${replay}: restoration cancellation settles before blocked I/O`, async () => {
            const q = await createQuotaFixture(true);
            try {
                const waiting = q.acquire('cancel-restore');
                await q.beginB();
                await q.settleA(true, replay);
                const rejected = assert.rejects(waiting.promise, error => error instanceof vscode.CancellationError);
                waiting.token.cancel();
                await rejected;
                assert.deepEqual(q.rate.leaderStore.exportSnapshot(q.now).grants, []);
                assert.equal(q.rate.localStore.stats('cancel-restore', q.now), undefined);
                await q.confirmB();
                await q.finishRestore().catch(() => {});
                const after = await q.acquire('after-cancel').promise;
                assert.equal(after?.authorityTerm, q.termB);
            } finally {
                await q.dispose();
            }
        });
    }
});
