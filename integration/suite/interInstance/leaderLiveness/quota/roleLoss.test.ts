import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { RateLimiter, type RateLimitHandle } from '../../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { deferred } from '../../electionContinuation/fixture';
import { createQuotaFixture } from './fixture';

suite('Local quota delivery across role loss', () => {
    const originalTimeout = global.setTimeout;
    const originalRelease = RateLimiter.release;
    let recoveryWaits = 0;
    const releases: Array<{ handle: RateLimitHandle; refund: Parameters<typeof RateLimiter.release>[1] }> = [];

    setup(() => {
        recoveryWaits = 0;
        releases.length = 0;
        global.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
            if (ms === 30_000) {
                recoveryWaits++;
            }
            return originalTimeout(callback, ms === 30_000 ? 5 : ms, ...args);
        }) as typeof setTimeout;
        RateLimiter.release = (handle, refund) => {
            releases.push({ handle, refund });
            originalRelease.call(RateLimiter, handle, refund);
        };
    });

    teardown(() => {
        global.setTimeout = originalTimeout;
        RateLimiter.release = originalRelease;
    });

    test('already delivered local lease retains its handoff heartbeat after role loss', async () => {
        const q = await createQuotaFixture();
        try {
            const handle = await q.acquire('already-delivered').promise;
            assert.ok(handle?.authoritative);
            await q.settleA();
            await q.f.bus.roleSwitchChain;
            const state = RateLimiter as unknown as {
                activeHandles: Map<string, RateLimitHandle>;
                leaseHeartbeatTimers: Map<string, NodeJS.Timeout>;
            };
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(state.activeHandles.get(handle.grantId), handle);
            assert.equal(state.leaseHeartbeatTimers.has(handle.grantId), true);
            assert.equal(q.rate.renewLease(handle), true);
            assert.deepEqual(releases, []);
            RateLimiter.release(handle);
            assert.equal(state.activeHandles.has(handle.grantId), false);
            assert.equal(state.leaseHeartbeatTimers.has(handle.grantId), false);
        } finally {
            await q.dispose();
        }
    });

    for (const route of ['direct', 'queued'] as const) {
        for (const failed of [false, true]) {
            for (const cancel of [false, true]) {
                test(`${route}/failed=${failed}/cancel=${cancel}: pacing delivery revalidates its local authority`, async () => {
                    const q = await createQuotaFixture();
                    try {
                        const dims = { rpm: 60, parallel: 1 };
                        const holder = await q.acquire('paced-loss', undefined, dims).promise;
                        assert.ok(holder?.authoritative);
                        if (route === 'direct') {
                            RateLimiter.release(holder);
                        }
                        const entered = deferred();
                        const next = q.acquire(
                            'paced-loss',
                            {
                                onWaiting: event => {
                                    if (event.queuePosition === undefined) {
                                        entered.resolve();
                                    }
                                }
                            },
                            dims
                        );
                        if (route === 'queued') {
                            assert.equal(q.rate.leaderStore.stats('paced-loss', q.now)?.pending, 1);
                            RateLimiter.release(holder);
                        }
                        let settled = false;
                        void next.promise.then(
                            () => {
                                settled = true;
                            },
                            () => {
                                settled = true;
                            }
                        );
                        await entered.promise;
                        const grant = q.rate.leaderStore.exportSnapshot(q.now).grants[0];
                        assert.ok(grant);
                        assert.ok(q.rate.leaderStore.stats('paced-loss', q.now)!.waitMs > 0);
                        await q.settleA(failed);
                        await q.f.bus.roleSwitchChain;
                        assert.equal(settled, false);
                        assert.equal(LeaderElectionService.isLeader(), !failed);
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), failed ? undefined : q.termA);
                        if (cancel) {
                            const rejected = assert.rejects(
                                next.promise,
                                error => error instanceof vscode.CancellationError
                            );
                            next.token.cancel();
                            await rejected;
                        } else {
                            const handle = await next.promise;
                            assert.ok(handle);
                            assert.equal(handle.authoritative, !failed);
                            assert.equal(handle.authorityTerm, failed ? undefined : q.termA);
                            assert.equal(
                                (failed ? q.rate.localStore : q.rate.leaderStore).hasGrant(handle.grantId),
                                true
                            );
                        }
                        const refunds = releases.filter(entry => entry.handle.grantId === grant.grantId);
                        assert.deepEqual(
                            refunds.map(entry => entry.refund),
                            failed || cancel ? [holder.costs] : []
                        );
                        if (failed || cancel) {
                            const state = RateLimiter as unknown as {
                                activeHandles: Map<string, RateLimitHandle>;
                                leaseHeartbeatTimers: Map<string, NodeJS.Timeout>;
                            };
                            assert.equal(state.activeHandles.has(grant.grantId), false);
                            assert.equal(state.leaseHeartbeatTimers.has(grant.grantId), false);
                        }
                        assert.equal(recoveryWaits, failed && !cancel ? 1 : 0);
                    } finally {
                        await q.dispose();
                    }
                });
            }
        }
    }

    for (const lost of [false, true]) {
        for (const cancel of [false, true]) {
            test(`lost=${lost}/cancel=${cancel}: zero-wait queued delivery retains its original local scope`, async () => {
                const q = await createQuotaFixture();
                try {
                    await q.settleA(false);
                    const holder = await q.acquire('zero-loss').promise;
                    assert.ok(holder?.authoritative);
                    const next = q.acquire('zero-loss');
                    assert.equal(q.rate.leaderStore.stats('zero-loss', q.now)?.pending, 1);
                    RateLimiter.release(holder, holder.costs);
                    const grant = q.rate.leaderStore.exportSnapshot(q.now).grants[0];
                    assert.ok(grant);
                    assert.equal(q.rate.leaderStore.stats('zero-loss', q.now)?.waitMs, 0);
                    let transition: Promise<void> | undefined;
                    let written: ReturnType<typeof q.f.write> | undefined;
                    if (lost) {
                        written = q.f.write({ instanceId: randomUUID(), electedAt: q.now + 1, lastHeartbeat: q.now });
                        transition = q.f.election.checkLeader();
                        assert.equal(LeaderElectionService.isLeader(), false);
                    }
                    if (cancel) {
                        const rejected = assert.rejects(
                            next.promise,
                            error => error instanceof vscode.CancellationError
                        );
                        next.token.cancel();
                        await rejected;
                    } else {
                        const handle = await next.promise;
                        assert.ok(handle);
                        assert.equal(handle.authoritative, !lost);
                        assert.equal(handle.authorityTerm, lost ? undefined : q.termA);
                    }
                    await written;
                    await transition;
                    assert.deepEqual(
                        releases.filter(entry => entry.handle.grantId === grant.grantId).map(entry => entry.refund),
                        lost || cancel ? [holder.costs] : []
                    );
                    assert.equal(recoveryWaits, lost && !cancel ? 1 : 0);
                } finally {
                    await q.dispose();
                }
            });
        }
    }
});
