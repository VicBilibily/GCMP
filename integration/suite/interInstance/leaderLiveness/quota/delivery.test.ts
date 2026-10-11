import assert from 'node:assert/strict';
import { RateLimiter } from '../../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { createQuotaFixture } from './fixture';

suite('Owned quota authority delivery', () => {
    for (const replay of [false, true]) {
        test(`replay=${replay}: queued grant is revalidated before returning its handle`, async () => {
            const q = await createQuotaFixture();
            try {
                const holder = await q.acquire('delivery').promise;
                assert.ok(holder);
                const queued = q.acquire('delivery');
                RateLimiter.release(holder, holder.costs);
                const successor = q.beginB();
                const handle = await queued.promise;
                await successor;
                await q.settleA(true, replay);
                assert.equal(handle?.authoritative, false);
                assert.equal(handle.authorityTerm, undefined);
                assert.equal(q.rate.leaderStore.stats('delivery', q.now)?.inflight, 0);
                await q.confirmB();
                const after = await q.acquire('delivery-after').promise;
                assert.equal(after?.authorityTerm, q.termB);
            } finally {
                await q.dispose();
            }
        });

        test(`replay=${replay}: a pacing callback cannot stamp a grant with unowned shared authority`, async () => {
            const q = await createQuotaFixture();
            let successor: Promise<void> | undefined;
            try {
                const first = await q.acquire('pacing', undefined, { rpm: 60 }).promise;
                assert.ok(first);
                RateLimiter.release(first);
                const next = q.acquire(
                    'pacing',
                    {
                        onWaiting: () => {
                            successor ??= q.beginB();
                        }
                    },
                    { rpm: 60 }
                );
                const handle = await next.promise;
                await successor;
                await q.settleA(true, replay);
                assert.equal(handle?.authoritative, false);
                assert.equal(handle.authorityTerm, undefined);
                assert.equal(q.rate.leaderStore.stats('pacing', q.now)?.inflight, 0);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
            } finally {
                await successor;
                await q.dispose();
            }
        });
    }
});
