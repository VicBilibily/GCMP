import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import type { ApiKeyBalanceLeaseHandoff } from '../../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../../../src/usages/atomicJsonFile';
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
    readBalanceLeaseHandoff,
    writeBalanceLeaseHandoff
} from '../../../../src/utils/config/failover/balanceLeaseHandoffFile';
import {
    RetryProvider,
    balanceKey,
    createContext,
    defaultRetry,
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

function observe<T>(promise: Promise<T>) {
    return promise.then(
        value => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error })
    );
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
    balanceAttemptSnapshots: Map<string, unknown>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    captureBalanceAttempt: (
        slot: string,
        balanceKey: string,
        allocationRequestId?: string,
        preferredCredentialId?: string,
        token?: vscode.CancellationToken
    ) => Promise<ApiKeyFailoverAttempt | 'fallback' | undefined>;
};

suite('balance queued capture cancellation', () => {
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
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalBalanceCapture = manager.captureBalanceAttempt;
    const originalWrite = AtomicJsonFile.writeJsonAtomically;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    let context: vscode.ExtensionContext;
    let term: string;
    let directory: string;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        term = `queued-capture:${Date.now()}`;
        directory = mkdtempSync(join(tmpdir(), 'gcmp-queued-capture-'));
        setBalanceHandoffDirectoryOverride(directory);
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => term,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'queued-capture-instance'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publish = () => {};
        InterInstanceBus.publishIpcOnly = () => true;
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(async () => {
        await enqueueConfigSetMutation(async () => {});
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        ConfigSetStore.getApiKey = originalSavedKey;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        manager.captureBalanceAttempt = originalBalanceCapture;
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        setBalanceHandoffDirectoryOverride(undefined);
    });

    for (const phase of ['behind-other-capture', 'authority-queue', 'lease-persistence'] as const) {
        for (const sdkMode of ['openai', 'openai-responses'] as const) {
            for (const outcome of ['normal', 'cancel-resolve', 'cancel-reject'] as const) {
                test(`${phase} ${sdkMode}: ${outcome}`, async () => {
                    const gate = deferred();
                    const blocked = deferred();
                    const entered = deferred();
                    const tracked = trackedCancellation();
                    const reads: Array<Promise<string | undefined>> = [];
                    const writes: Array<Promise<void>> = [];
                    const lateError = new Error('preceding balance operation failed');
                    let blocker: ReturnType<typeof observe<void>> | undefined;
                    let other: ReturnType<typeof observe<ApiKeyFailoverAttempt | undefined>> | undefined;
                    let recovery: ReturnType<typeof observe<void>> | undefined;
                    let retainedLeaseId: string;
                    let cancelledLeaseId: string | undefined;
                    let readCount = 0;
                    if (phase === 'authority-queue') {
                        retainedLeaseId = randomUUID();
                        await writeBalanceLeaseHandoff({
                            sourceAuthorityTerm: `previous-owner:${Date.now() - 1000}`,
                            capturedAt: Date.now(),
                            revision: 1,
                            leases: [
                                {
                                    leaseId: retainedLeaseId,
                                    slot,
                                    balanceKey: `${balanceKey}:retained`,
                                    configId: 'a',
                                    credentialId: identity('key-a'),
                                    ownerInstanceId: 'queued-capture-instance',
                                    expiresAt: Date.now() + 30_000
                                }
                            ]
                        });
                        blocker = observe(
                            enqueueConfigSetMutation(async () => {
                                blocked.resolve();
                                await gate.promise;
                                if (outcome === 'cancel-reject') {
                                    throw lateError;
                                }
                            })
                        );
                    } else {
                        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
                        const retained = await originalCapture.call(
                            ApiKeyFailoverManager,
                            slot,
                            `${balanceKey}:retained`,
                            randomUUID()
                        );
                        assert.ok(retained?.balanceLeaseId);
                        retainedLeaseId = retained.balanceLeaseId;
                        if (phase === 'behind-other-capture') {
                            ConfigSetStore.getApiKey = (...args) => {
                                const index = ++readCount;
                                const read = (async () => {
                                    if (index <= 2) {
                                        blocked.resolve();
                                        await gate.promise;
                                        if (outcome === 'cancel-reject') {
                                            throw lateError;
                                        }
                                    }
                                    return originalSavedKey.apply(ConfigSetStore, args);
                                })();
                                reads.push(read);
                                return read;
                            };
                            other = observe(
                                originalCapture.call(ApiKeyFailoverManager, slot, `${balanceKey}:other`, randomUUID())
                            );
                        } else {
                            let first = true;
                            AtomicJsonFile.writeJsonAtomically = (...args) => {
                                const handoff = args[1] as ApiKeyBalanceLeaseHandoff;
                                const write = (async () => {
                                    if (first && args[0].includes(directory)) {
                                        first = false;
                                        cancelledLeaseId = handoff.leases.find(
                                            lease => lease.leaseId !== retainedLeaseId
                                        )?.leaseId;
                                        blocked.resolve();
                                        await gate.promise;
                                        if (outcome === 'cancel-reject') {
                                            throw lateError;
                                        }
                                    }
                                    return originalWrite.apply(AtomicJsonFile, args);
                                })();
                                writes.push(write);
                                return write;
                            };
                        }
                    }
                    if (phase !== 'lease-persistence') {
                        await blocked.promise;
                    }
                    ApiKeyFailoverManager.captureAttempt = (...args) => {
                        entered.resolve();
                        return originalCapture.apply(ApiKeyFailoverManager, args);
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
                    let wires = 0;
                    ConfigManager.createProxyAwareFetch = () => async () => {
                        wires++;
                        return successResponse(sdkMode);
                    };
                    const settled = observe(RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token));
                    try {
                        await Promise.race([
                            entered.promise,
                            settled.then(() => {
                                throw new Error('Capture did not start');
                            })
                        ]);
                        if (phase === 'authority-queue') {
                            recovery = observe(ApiKeyFailoverManager.becomeBalanceAuthority(term));
                        } else if (phase === 'lease-persistence') {
                            await Promise.race([
                                blocked.promise,
                                settled.then(() => {
                                    throw new Error('Persistence gate was not reached');
                                })
                            ]);
                            assert.ok(cancelledLeaseId);
                            assert.equal(manager.balanceLeases.size, 2);
                        }
                        assert.equal((await settleBeforeGate(settled)).state, 'pending');
                        if (outcome !== 'normal') {
                            tracked.cancel();
                        }
                        const early = await settleBeforeGate(settled);
                        if (outcome === 'normal') {
                            assert.equal(early.state, 'pending');
                            assert.equal(refunds.length, 0);
                        } else {
                            assert.ok(early.state === 'rejected' && early.error instanceof vscode.CancellationError);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                            assert.equal(wires, 0);
                            assert.equal(manager.balanceLeases.size, phase === 'authority-queue' ? 0 : 1);
                            assert.equal(manager.balanceAttemptSnapshots.size, phase === 'authority-queue' ? 0 : 1);
                            assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                            assert.equal(tracked.disposals, tracked.subscriptions);
                        }
                        const queued = observe(enqueueConfigSetMutation(async () => {}));
                        assert.equal((await settleBeforeGate(queued)).state, 'pending');
                        if (other) {
                            assert.equal((await settleBeforeGate(other)).state, 'pending');
                        }
                        if (recovery) {
                            assert.equal((await settleBeforeGate(recovery)).state, 'pending');
                        }
                        gate.resolve();
                        const final = await settled;
                        if (other) {
                            const result = await other;
                            if (outcome === 'cancel-reject') {
                                assert.ok(result.state === 'rejected' && result.error === lateError);
                            } else {
                                assert.ok(result.state === 'resolved' && result.value?.balanceLeaseId);
                            }
                        }
                        await blocker;
                        if (recovery) {
                            assert.equal((await recovery).state, 'resolved');
                        }
                        await queued;
                        await Promise.allSettled(reads);
                        await Promise.allSettled(writes);
                        assert.equal(observed.grants, 1);
                        assert.equal(tracked.disposals, tracked.subscriptions);
                        assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                        assert.ok(manager.balanceLeases.has(retainedLeaseId));
                        if (outcome === 'normal') {
                            assert.equal(final.state, 'resolved');
                            assert.equal(wires, 1);
                        } else {
                            assert.ok(final.state === 'rejected' && final.error instanceof vscode.CancellationError);
                            assert.equal(wires, 0);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                            assert.equal(
                                manager.balanceLeases.size,
                                phase === 'behind-other-capture' && outcome === 'cancel-resolve' ? 2 : 1
                            );
                            assert.equal(
                                manager.balanceAttemptSnapshots.size,
                                phase === 'behind-other-capture' && outcome === 'cancel-resolve' ? 2
                                : phase === 'authority-queue' ? 0
                                : 1
                            );
                            if (phase === 'lease-persistence') {
                                assert.ok(!manager.balanceLeases.has(cancelledLeaseId!));
                                const persisted = await readBalanceLeaseHandoff(directory);
                                assert.deepEqual(
                                    persisted?.leases.map(lease => lease.leaseId),
                                    [retainedLeaseId]
                                );
                                assert.equal(writes.length, 2);
                            }
                        }
                    } finally {
                        gate.resolve();
                        await settled;
                        if (other) {
                            const result = await other;
                            if (result.state === 'resolved' && result.value?.balanceLeaseId) {
                                ApiKeyFailoverManager.releaseBalanceLease(result.value.balanceLeaseId, term);
                            }
                        }
                        await blocker;
                        await recovery;
                        await enqueueConfigSetMutation(async () => {});
                        await Promise.allSettled(reads);
                        await Promise.allSettled(writes);
                        tracked.dispose();
                    }
                });
            }
        }
    }

    test('cancellation on queue subscription releases only the matching existing lease without a snapshot', async () => {
        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
        const retained = await originalCapture.call(
            ApiKeyFailoverManager,
            slot,
            `${balanceKey}:retained`,
            randomUUID()
        );
        assert.ok(retained?.balanceLeaseId);
        const requestId = randomUUID();
        const assigned = await originalCapture.call(ApiKeyFailoverManager, slot, balanceKey, requestId);
        assert.ok(assigned?.balanceLeaseId);
        manager.balanceAttemptSnapshots.delete(requestId);
        const tracked = trackedCancellation(true);
        let reads = 0;
        ConfigSetStore.getApiKey = (...args) => {
            reads++;
            return originalSavedKey.apply(ConfigSetStore, args);
        };
        try {
            assert.equal(
                await originalCapture.call(
                    ApiKeyFailoverManager,
                    slot,
                    balanceKey,
                    requestId,
                    undefined,
                    tracked.token
                ),
                undefined
            );
            await enqueueConfigSetMutation(async () => {});
            assert.equal(reads, 0);
            assert.deepEqual([...manager.balanceLeases.keys()], [retained.balanceLeaseId]);
            assert.equal(manager.balanceAttemptSnapshots.size, 1);
            assert.equal(tracked.subscriptions, 1);
            assert.equal(tracked.disposals, tracked.subscriptions);
        } finally {
            tracked.dispose();
        }
    });

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        test(`${sdkMode}: cancellation after allocation drops and releases the late queued result`, async () => {
            await ApiKeyFailoverManager.becomeBalanceAuthority(term);
            const retained = await originalCapture.call(
                ApiKeyFailoverManager,
                slot,
                `${balanceKey}:retained`,
                randomUUID()
            );
            assert.ok(retained?.balanceLeaseId);
            const tracked = trackedCancellation();
            manager.captureBalanceAttempt = (...args) =>
                originalBalanceCapture.apply(ApiKeyFailoverManager, args).then(attempt => {
                    tracked.cancel();
                    return attempt;
                });
            let wires = 0;
            ConfigManager.createProxyAwareFetch = () => async () => {
                wires++;
                return successResponse(sdkMode);
            };
            const handle: RateLimitHandle = {
                grantId: randomUUID(),
                costs: { requests: 1, tokens: 50 },
                leaseMs: 30_000,
                authoritative: true,
                authorityTerm: term
            };
            const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
            RateLimiter.release = (...args) => {
                refunds.push(args);
            };
            try {
                const result = await observe(
                    RetryProvider.run(sdkMode, defaultRetry, { grants: 0, handle }, tracked.token)
                );
                await enqueueConfigSetMutation(async () => {});
                assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                assert.deepEqual(refunds, [[handle, handle.costs]]);
                assert.equal(wires, 0);
                assert.deepEqual([...manager.balanceLeases.keys()], [retained.balanceLeaseId]);
                assert.equal(manager.balanceAttemptSnapshots.size, 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });

        test(`${sdkMode}: cancellation during lease subscription does not start persistence`, async () => {
            await ApiKeyFailoverManager.becomeBalanceAuthority(term);
            const retained = await originalCapture.call(
                ApiKeyFailoverManager,
                slot,
                `${balanceKey}:retained`,
                randomUUID()
            );
            assert.ok(retained?.balanceLeaseId);
            const tracked = trackedCancellation();
            const token: vscode.CancellationToken = {
                get isCancellationRequested() {
                    return tracked.token.isCancellationRequested;
                },
                onCancellationRequested(listener, thisArgs, disposables) {
                    const subscription = tracked.token.onCancellationRequested(listener, thisArgs, disposables);
                    if (manager.balanceLeases.size === 2) {
                        tracked.cancel();
                    }
                    return subscription;
                }
            };
            let writeCount = 0;
            AtomicJsonFile.writeJsonAtomically = (...args) => {
                writeCount++;
                return originalWrite.apply(AtomicJsonFile, args);
            };
            let wires = 0;
            ConfigManager.createProxyAwareFetch = () => async () => {
                wires++;
                return successResponse(sdkMode);
            };
            const handle: RateLimitHandle = {
                grantId: randomUUID(),
                costs: { requests: 1, tokens: 50 },
                leaseMs: 30_000,
                authoritative: true,
                authorityTerm: term
            };
            const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
            RateLimiter.release = (...args) => {
                refunds.push(args);
            };
            try {
                const result = await observe(RetryProvider.run(sdkMode, defaultRetry, { grants: 0, handle }, token));
                await enqueueConfigSetMutation(async () => {});
                assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                assert.deepEqual(refunds, [[handle, handle.costs]]);
                assert.equal(wires, 0);
                assert.equal(writeCount, 0);
                assert.deepEqual([...manager.balanceLeases.keys()], [retained.balanceLeaseId]);
                assert.equal(manager.balanceAttemptSnapshots.size, 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }
});
