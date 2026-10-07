import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceLeaseReleasedEvent
} from '../../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { enqueueConfigSetMutation } from '../../../../src/utils/config/configSetCommands';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt
} from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    balanceKey,
    createContext,
    defaultRetry,
    errorResponse,
    identity,
    slot,
    successResponse,
    trackedCancellation
} from '../retryFixture';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function settleBeforeGate<T>(settled: Promise<T>): Promise<T | { state: 'pending' }> {
    return Promise.race([
        settled,
        new Promise<{ state: 'pending' }>(resolve => {
            setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
        })
    ]);
}

const manager = ApiKeyFailoverManager as unknown as {
    balanceLeases: Map<string, unknown>;
    balanceAttemptSnapshots: Map<string, { slot: string; attempt: ApiKeyFailoverAttempt }>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    pendingBalanceAssignments: Map<string, unknown>;
    releasedBalanceLeases: Set<string>;
};
const outcomes = ['normal', 'failure', 'cancel-resolve', 'cancel-reject'] as const;

suite('balance normal capture cancellation', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        hasActiveTransport: InterInstanceBus.hasActiveTransport,
        isAuthorityTransitioning: InterInstanceBus.isAuthorityTransitioning,
        publishIpcOnly: InterInstanceBus.publishIpcOnly,
        publish: InterInstanceBus.publish
    };
    const originalSavedKey = ConfigSetStore.getApiKey;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    let context: vscode.ExtensionContext;
    let leader: boolean;
    let term: string;
    let assignments: number;
    let releases: ApiKeyBalanceLeaseReleasedEvent['payload'][];

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        leader = false;
        term = `normal-capture:${randomUUID()}`;
        assignments = 0;
        releases = [];
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-normal-capture-')));
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => leader,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => (leader ? term : undefined),
            getAuthorityTerm: () => term,
            getInstanceId: () => 'normal-capture-instance'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publish = () => {};
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                assignments++;
                const payload = event.payload as ApiKeyBalanceAssignmentRequestedEvent['payload'];
                ApiKeyFailoverManager.resolveBalanceAssignment({
                    requestId: payload.requestId,
                    targetInstanceId: 'normal-capture-instance',
                    authorityTerm: term,
                    handled: true,
                    configId: 'b',
                    credentialId: identity('key-b'),
                    leaseId: `lease-${payload.requestId}`,
                    expiresAt: Date.now() + 30_000
                });
            } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                releases.push(event.payload as ApiKeyBalanceLeaseReleasedEvent['payload']);
            }
            return true;
        };
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add(slot, { id, label: id, balanceWeight: 1 }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        ConfigSetStore.getApiKey = originalSavedKey;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        setBalanceHandoffDirectoryOverride(undefined);
    });

    test('mode invalidation still releases a delivered lease once after local snapshots are cleared', async () => {
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, randomUUID());
        assert.ok(attempt?.balanceLeaseId);
        ApiKeyFailoverManager.startBalanceLeaseHeartbeat(attempt, slot);
        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
        assert.equal(manager.balanceAttemptSnapshots.size, 0);
        assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId);
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId);
        assert.deepEqual(releases, [{ leaseId: attempt.balanceLeaseId, authorityTerm: term }]);
    });

    test('release deduplication does not suppress the same lease under a new authority', async () => {
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, randomUUID());
        assert.ok(attempt?.balanceLeaseId);
        const oldTerm = term;
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId, oldTerm);
        term = `normal-capture:${randomUUID()}`;
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId, term);
        assert.deepEqual(releases, [
            { leaseId: attempt.balanceLeaseId, authorityTerm: oldTerm },
            { leaseId: attempt.balanceLeaseId, authorityTerm: term }
        ]);
    });

    test('authority state recreation does not suppress a new lease with the same id and term', async () => {
        const requestId = randomUUID();
        const first = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId);
        assert.ok(first?.balanceLeaseId);
        ApiKeyFailoverManager.releaseBalanceLease(first.balanceLeaseId, term);
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        const next = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId);
        assert.equal(next?.balanceLeaseId, first.balanceLeaseId);
        ApiKeyFailoverManager.releaseBalanceLease(first.balanceLeaseId, term);
        assert.deepEqual(releases, [
            { leaseId: first.balanceLeaseId, authorityTerm: term },
            { leaseId: first.balanceLeaseId, authorityTerm: term }
        ]);
    });

    test('an unsuccessful release publication can be retried', async () => {
        const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, randomUUID());
        assert.ok(attempt?.balanceLeaseId);
        const publish = InterInstanceBus.publishIpcOnly;
        InterInstanceBus.publishIpcOnly = () => false;
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId, term);
        InterInstanceBus.publishIpcOnly = publish;
        ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId, term);
        assert.deepEqual(releases, [{ leaseId: attempt.balanceLeaseId, authorityTerm: term }]);
    });

    test('successful release tracking is bounded and retains recent duplicate suppression', () => {
        for (let index = 0; index < 1005; index++) {
            ApiKeyFailoverManager.releaseBalanceLease(`bounded-release-${index}`, term);
        }
        assert.equal(manager.releasedBalanceLeases.size, 1000);
        assert.equal(releases.length, 1005);
        ApiKeyFailoverManager.releaseBalanceLease('bounded-release-1004', term);
        assert.equal(releases.length, 1005);
    });

    for (const source of ['follower-assigned', 'leader-pool'] as const) {
        for (const sdkMode of ['openai', 'openai-responses'] as const) {
            for (const outcome of outcomes) {
                test(`${source} ${sdkMode}: ${outcome}`, async () => {
                    leader = source === 'leader-pool';
                    if (leader) {
                        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
                    }
                    const tracked = trackedCancellation();
                    const gate = deferred();
                    const started = deferred();
                    const lookupError = new Error('saved secret lookup failed');
                    let block = true;
                    const reads: Array<Promise<string | undefined>> = [];
                    ConfigSetStore.getApiKey = (...args) => {
                        if (!block) {
                            return originalSavedKey.apply(ConfigSetStore, args);
                        }
                        const read = (async () => {
                            started.resolve();
                            await gate.promise;
                            if (outcome === 'failure' || outcome === 'cancel-reject') {
                                throw lookupError;
                            }
                            return originalSavedKey.apply(ConfigSetStore, args);
                        })();
                        reads.push(read);
                        return read;
                    };
                    const handle: RateLimitHandle = {
                        grantId: randomUUID(),
                        costs: { requests: 1, tokens: 50 },
                        leaseMs: 30_000,
                        authoritative: true,
                        authorityTerm: term
                    };
                    const observed = { grants: 0, handle };
                    const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                    RateLimiter.release = (...args) => {
                        refunds.push(args);
                    };
                    let wireCount = 0;
                    ConfigManager.createProxyAwareFetch = () => async () => {
                        wireCount++;
                        return successResponse(sdkMode);
                    };
                    const settled = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token).then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    try {
                        await Promise.race([
                            started.promise,
                            settled.then(() => {
                                throw new Error('Secret lookup did not start');
                            })
                        ]);
                        if (outcome.startsWith('cancel-')) {
                            tracked.cancel();
                        }
                        const early = await settleBeforeGate(settled);
                        if (outcome.startsWith('cancel-')) {
                            assert.ok(early.state === 'rejected' && early.error instanceof vscode.CancellationError);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                            assert.equal(releases.length, leader ? 0 : 1);
                            assert.equal(manager.balanceLeases.size, 0);
                            assert.equal(manager.balanceAttemptSnapshots.size, 0);
                            if (leader) {
                                const queued = await settleBeforeGate(
                                    enqueueConfigSetMutation(async () => ({ state: 'queue-free' as const }))
                                );
                                assert.equal(queued.state, 'queue-free');
                            }
                        } else {
                            assert.equal(early.state, 'pending');
                            assert.equal(refunds.length, 0);
                        }
                        block = false;
                        gate.resolve();
                        const final = await settled;
                        await Promise.allSettled(reads);
                        assert.equal(observed.grants, 1);
                        assert.equal(manager.pendingBalanceAssignments.size, 0);
                        assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                        assert.equal(manager.balanceLeases.size, 0);
                        assert.equal(manager.balanceAttemptSnapshots.size, 0);
                        assert.equal(tracked.disposals, tracked.subscriptions);
                        if (outcome === 'normal') {
                            assert.equal(final.state, 'resolved');
                            assert.equal(wireCount, 1);
                        } else {
                            assert.equal(wireCount, 0);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                            assert.ok(final.state === 'rejected');
                            if (outcome === 'failure') {
                                assert.equal(final.error, lookupError);
                            } else {
                                assert.ok(final.error instanceof vscode.CancellationError);
                            }
                        }
                        assert.equal(releases.length, leader ? 0 : 1);
                    } finally {
                        block = false;
                        gate.resolve();
                        await settled;
                        await Promise.allSettled(reads);
                        tracked.dispose();
                    }
                });
            }
        }
    }

    for (const source of ['follower-cache', 'leader-cache', 'leader-existing-lease'] as const) {
        for (const outcome of outcomes) {
            test(`${source}: ${outcome}`, async () => {
                leader = source !== 'follower-cache';
                const requestId = randomUUID();
                const initial = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId);
                assert.ok(initial?.balanceLeaseId);
                if (source === 'leader-existing-lease') {
                    manager.balanceAttemptSnapshots.delete(requestId);
                }
                const gate = deferred();
                const started = deferred();
                const tracked = trackedCancellation();
                const lookupError = new Error('cached secret lookup failed');
                const reads: Array<Promise<string | undefined>> = [];
                let readCount = 0;
                ConfigSetStore.getApiKey = (...args) => {
                    readCount++;
                    if (source === 'leader-existing-lease' && readCount <= 2) {
                        return originalSavedKey.apply(ConfigSetStore, args);
                    }
                    const read = (async () => {
                        started.resolve();
                        await gate.promise;
                        if (outcome === 'failure' || outcome === 'cancel-reject') {
                            throw lookupError;
                        }
                        return originalSavedKey.apply(ConfigSetStore, args);
                    })();
                    reads.push(read);
                    return read;
                };
                const settled = ApiKeyFailoverManager.captureAttempt(
                    slot,
                    balanceKey,
                    requestId,
                    undefined,
                    tracked.token
                ).then(
                    value => ({ state: 'resolved' as const, value }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        started.promise,
                        settled.then(() => {
                            throw new Error('Cached lookup did not start');
                        })
                    ]);
                    if (outcome.startsWith('cancel-')) {
                        tracked.cancel();
                    }
                    const early = await settleBeforeGate(settled);
                    if (outcome.startsWith('cancel-')) {
                        assert.ok(early.state === 'resolved' && early.value === undefined);
                        assert.equal(manager.balanceAttemptSnapshots.has(requestId), false);
                        assert.equal(manager.balanceLeases.has(initial.balanceLeaseId), false);
                        assert.equal(releases.length, leader ? 0 : 1);
                    } else {
                        assert.equal(early.state, 'pending');
                    }
                    gate.resolve();
                    const final = await settled;
                    await Promise.allSettled(reads);
                    if (outcome === 'normal') {
                        assert.ok(final.state === 'resolved' && final.value?.balanceLeaseId === initial.balanceLeaseId);
                    } else if (outcome === 'failure') {
                        assert.ok(final.state === 'rejected' && final.error === lookupError);
                    } else {
                        assert.ok(final.state === 'resolved' && final.value === undefined);
                        assert.equal(manager.balanceAttemptSnapshots.has(requestId), false);
                        assert.equal(manager.balanceLeases.has(initial.balanceLeaseId), false);
                        assert.equal(releases.length, leader ? 0 : 1);
                    }
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    assert.equal(assignments, leader ? 0 : 1);
                } finally {
                    gate.resolve();
                    await settled;
                    await Promise.allSettled(reads);
                    if (!outcome.startsWith('cancel-')) {
                        ApiKeyFailoverManager.releaseBalanceLease(initial.balanceLeaseId, term);
                    }
                    tracked.dispose();
                }
            });
        }
    }

    for (const source of ['leader-pool', 'follower-cache', 'leader-cache'] as const) {
        test(`${source}: cancellation on read subscription skips SecretStorage`, async () => {
            leader = source !== 'follower-cache';
            const requestId = randomUUID();
            if (source !== 'leader-pool') {
                assert.ok(await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId));
            }
            const tracked = trackedCancellation(true);
            let reads = 0;
            ConfigSetStore.getApiKey = async (...args) => {
                reads++;
                return originalSavedKey.apply(ConfigSetStore, args);
            };
            try {
                assert.equal(
                    await ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId, undefined, tracked.token),
                    undefined
                );
                assert.equal(reads, 0);
                assert.equal(manager.balanceLeases.size, 0);
                assert.equal(manager.balanceAttemptSnapshots.size, 0);
                assert.equal(tracked.subscriptions, 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const ending of ['resolve', 'reject'] as const) {
            test(`${sdkMode}: cached retry cancellation refunds and releases once before storage ${ending}`, async () => {
                const tracked = trackedCancellation();
                const gate = deferred();
                const started = deferred();
                const reads: Array<Promise<string | undefined>> = [];
                let secretReads = 0;
                ConfigSetStore.getApiKey = (...args) => {
                    secretReads++;
                    if (secretReads === 1) {
                        return originalSavedKey.apply(ConfigSetStore, args);
                    }
                    const read = (async () => {
                        started.resolve();
                        await gate.promise;
                        if (ending === 'reject') {
                            throw new Error('late cached secret rejection');
                        }
                        return originalSavedKey.apply(ConfigSetStore, args);
                    })();
                    reads.push(read);
                    return read;
                };
                const firstHandle: RateLimitHandle = {
                    grantId: randomUUID(),
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: term
                };
                const secondHandle = { ...firstHandle, grantId: randomUUID() };
                const observed = { grants: 0, handle: firstHandle };
                const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                RateLimiter.release = (...args) => {
                    refunds.push(args);
                };
                let wireCount = 0;
                ConfigManager.createProxyAwareFetch = () => async () => {
                    wireCount++;
                    observed.handle = secondHandle;
                    return errorResponse();
                };
                const settled = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token).then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        started.promise,
                        settled.then(() => {
                            throw new Error('Cached retry lookup did not start');
                        })
                    ]);
                    tracked.cancel();
                    const early = await settleBeforeGate(settled);
                    assert.ok(early.state === 'rejected' && early.error instanceof vscode.CancellationError);
                    assert.deepEqual(refunds, [
                        [firstHandle, { tokens: firstHandle.costs.tokens }],
                        [secondHandle, secondHandle.costs]
                    ]);
                    assert.equal(releases.length, 1);
                    assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                    assert.equal(manager.balanceAttemptSnapshots.size, 0);
                    gate.resolve();
                    await settled;
                    await Promise.allSettled(reads);
                    assert.equal(releases.length, 1);
                    assert.equal(refunds.length, 2);
                    assert.equal(wireCount, 1);
                    assert.equal(assignments, 1);
                    assert.equal(secretReads, 2);
                    assert.equal(observed.grants, 2);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                } finally {
                    gate.resolve();
                    await settled;
                    await Promise.allSettled(reads);
                    tracked.dispose();
                }
            });
        }
    }
});
