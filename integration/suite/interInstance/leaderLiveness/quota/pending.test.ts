import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { RateLimiter, type RateLimitHandle } from '../../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { createQuotaFixture } from './fixture';

suite('Owned quota authority pending grants', () => {
    for (const replay of [false, true]) {
        for (const cleanup of ['local-release', 'remote-release', 'remote-abort', 'disconnect', 'expiry'] as const) {
            test(`${cleanup}/replay=${replay}: old lease cleanup cannot grant pending work without an owner`, async () => {
                const q = await createQuotaFixture();
                try {
                    const bucket = 'pending-bucket';
                    let holder: RateLimitHandle | undefined;
                    if (cleanup === 'local-release') {
                        holder = await q.acquire(bucket).promise;
                    } else {
                        RateLimiter.handleAcquireRequest(
                            {
                                requestId: 'holder',
                                bucketKey: bucket,
                                authorityTerm: q.termA,
                                dims: { parallel: 1 },
                                costs: { requests: 1, tokens: 0 }
                            },
                            'departed'
                        );
                    }
                    const grant = q.rate.leaderStore.exportSnapshot(q.now).grants[0];
                    assert.ok(grant);
                    const queued = q.acquire(bucket);
                    let delivered = false;
                    void queued.promise.then(
                        () => {
                            delivered = true;
                        },
                        () => {}
                    );
                    const remoteId = await q.remoteAcquire(bucket, q.termA);
                    assert.equal(q.rate.leaderStore.stats(bucket, q.now)?.pending, 2);
                    await q.beginB();
                    await q.settleA(true, replay);
                    if (cleanup === 'local-release') {
                        assert.ok(holder);
                        RateLimiter.release(holder, holder.costs);
                    } else if (cleanup === 'remote-release') {
                        RateLimiter.handleRemoteRelease(
                            { authorityTerm: q.termA, grantId: grant.grantId, refund: grant.costs },
                            'departed'
                        );
                    } else if (cleanup === 'remote-abort') {
                        RateLimiter.handleRemoteAcquireCancelled(
                            { authorityTerm: q.termA, bucketKey: bucket, requestId: 'holder' },
                            'departed'
                        );
                    } else if (cleanup === 'disconnect') {
                        q.rate.reclaimDisconnectedInstance('departed');
                    } else {
                        q.advance(600_001);
                        q.rate.sweep();
                    }
                    await q.barrier();
                    assert.equal(q.rate.leaderStore.hasGrant(grant.grantId), false);
                    assert.equal(q.rate.leaderStore.stats(bucket, q.now)?.inflight, 0);
                    assert.equal(q.rate.leaderStore.stats(bucket, q.now)?.pending, 2);
                    assert.equal(delivered, false);
                    assert.deepEqual(q.grants(remoteId), []);
                    await q.confirmB();
                    q.rate.sweep();
                    const next = await queued.promise;
                    assert.ok(next?.authoritative);
                    assert.equal(next.authorityTerm, q.termB);
                    assert.equal(q.rate.leaderStore.stats(bucket, q.now)?.pending, 1);
                    RateLimiter.release(next, next.costs);
                    await q.barrier();
                    assert.equal(q.grants(remoteId).length, 1);
                    assert.equal(q.grants(remoteId)[0].payload.authorityTerm, q.termB);
                    assert.deepEqual(q.f.roles, [true]);
                } finally {
                    await q.dispose();
                }
            });
        }

        test(`replay=${replay}: pending cancellation and existing lease renewal remain available`, async () => {
            const q = await createQuotaFixture();
            try {
                const holder = await q.acquire('cancel-queue').promise;
                assert.ok(holder);
                const queued = q.acquire('cancel-queue');
                const remoteId = await q.remoteAcquire('cancel-queue', q.termA);
                await q.beginB();
                await q.settleA(true, replay);
                const rejected = assert.rejects(queued.promise, error => error instanceof vscode.CancellationError);
                queued.token.cancel();
                await rejected;
                RateLimiter.handleRemoteAcquireCancelled(
                    { authorityTerm: q.termA, bucketKey: 'cancel-queue', requestId: remoteId },
                    q.observerId
                );
                assert.equal(q.rate.leaderStore.stats('cancel-queue', q.now)?.pending, 0);
                q.advance(10);
                assert.equal(q.rate.renewLease(holder, q.now), true);
                assert.ok(q.rate.leaderStore.exportSnapshot(q.now).grants[0].expiresAt > q.now);
                RateLimiter.release(holder, holder.costs);
                assert.equal(q.rate.leaderStore.stats('cancel-queue', q.now)?.inflight, 0);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                assert.deepEqual(q.grants(remoteId), []);
            } finally {
                await q.dispose();
            }
        });
    }
});
