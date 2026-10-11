import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../../src/interInstance';
import { RateLimiter, type RateLimitHandle } from '../../../../../src/rateLimit/rateLimiter';
import { RateLimitStore } from '../../../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../../../src/status/leaderElectionService';
import { deferred } from '../../electionContinuation/fixture';
import { createLivenessFixture, waitFor } from '../fixture';

suite('Follower IPC quota delivery remains authoritative', () => {
    for (const pacing of [false, true]) {
        for (const cancel of [false, true]) {
            test(`pacing=${pacing}/cancel=${cancel}: remote authority does not require local ownership`, async () => {
                const f = await createLivenessFixture(0);
                const originalNow = Date.now;
                const now = originalNow();
                const state = RateLimiter as unknown as Record<string, unknown>;
                const fields = [
                    'leaderStore',
                    'localStore',
                    'leaderRestoreReady',
                    'leaderRestoreAuthorityTerm',
                    'degraded',
                    'degradedNotified',
                    'lastProbeAt'
                ];
                const previous = Object.fromEntries(fields.map(field => [field, state[field]]));
                const store = new RateLimitStore('remote');
                const token = new vscode.CancellationTokenSource();
                const costs = { requests: 1, tokens: 17 };
                const dims = { rpm: 600, tpm: 102_000, parallel: 1 };
                const handles: RateLimitHandle[] = [];
                const refunds: Array<{ grantId: string; refund: Parameters<typeof RateLimiter.release>[1] }> = [];
                const entered = deferred();
                let acquiring: Promise<RateLimitHandle | undefined> | undefined;
                let latestGrantId = '';
                let requestCount = 0;
                try {
                    assert.equal(state.initialized, false);
                    state.localStore = new RateLimitStore();
                    state.degraded = false;
                    Date.now = () => now;
                    RateLimiter.initialize(f.context);
                    f.setResponder(event => {
                        if (event.type === 'rateLimitAcquireRequested') {
                            requestCount++;
                            const payload = event.payload;
                            assert.equal(payload.authorityTerm, f.identity.authorityTerm);
                            const grant = store.acquire(
                                payload.requestId,
                                payload.bucketKey,
                                payload.dims,
                                payload.costs,
                                Date.now(),
                                { ownerInstanceId: event.senderInstanceId }
                            );
                            assert.equal(grant.kind, 'granted');
                            if (grant.kind !== 'granted') {
                                throw new Error('Remote store did not grant');
                            }
                            latestGrantId = grant.grantId;
                            if (!pacing && cancel) {
                                token.cancel();
                            }
                            f.server.sendToInstance(event.senderInstanceId, {
                                type: 'rateLimitAcquireGranted',
                                senderInstanceId: f.identity.instanceId,
                                timestamp: Date.now(),
                                payload: {
                                    authorityTerm: f.identity.authorityTerm,
                                    requestId: payload.requestId,
                                    grantId: grant.grantId,
                                    waitMs: grant.waitMs
                                }
                            });
                        } else if (event.type === 'rateLimitReleased') {
                            refunds.push({ grantId: event.payload.grantId, refund: event.payload.refund });
                            store.release(event.payload.grantId, event.payload.refund, Date.now());
                        } else if (event.type === 'rateLimitLeaseRenewed') {
                            store.renew(event.payload.grantId, Date.now());
                        }
                    });
                    if (pacing) {
                        const holder = await RateLimiter.acquire('remote-delivery', dims, costs, {
                            token: token.token
                        });
                        assert.ok(holder?.authoritative);
                        handles.push(holder);
                        RateLimiter.release(holder);
                        await waitFor(() => !store.hasGrant(holder.grantId));
                    }
                    acquiring = RateLimiter.acquire('remote-delivery', dims, costs, {
                        token: token.token,
                        onWaiting: () => entered.resolve()
                    }).then(handle => {
                        if (handle) {
                            handles.push(handle);
                        }
                        return handle;
                    });
                    void acquiring.catch(() => {});
                    if (pacing) {
                        await entered.promise;
                        if (cancel) {
                            token.cancel();
                        }
                    }
                    if (cancel) {
                        await assert.rejects(acquiring, error => error instanceof vscode.CancellationError);
                        await waitFor(() => !store.hasGrant(latestGrantId));
                        assert.deepEqual(
                            refunds.filter(entry => entry.grantId === latestGrantId).map(entry => entry.refund),
                            [costs]
                        );
                    } else {
                        const handle = await acquiring;
                        assert.ok(handle?.authoritative);
                        assert.equal(handle.authorityTerm, f.identity.authorityTerm);
                        assert.equal(handle.grantId, latestGrantId);
                        assert.equal(store.hasGrant(handle.grantId), true);
                        RateLimiter.release(handle);
                        await waitFor(() => !store.hasGrant(handle.grantId));
                    }
                    assert.equal(requestCount, pacing ? 2 : 1);
                    assert.equal(LeaderElectionService.isLeader(), false);
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
                    assert.equal(InterInstanceBus.getAuthorityTerm(), f.identity.authorityTerm);
                    assert.deepEqual(f.roles, []);
                } finally {
                    token.cancel();
                    await acquiring?.catch(() => {});
                    for (const handle of handles) {
                        RateLimiter.release(handle);
                    }
                    token.dispose();
                    Date.now = originalNow;
                    await f.dispose();
                    Object.assign(state, previous);
                }
            });
        }
    }
});
