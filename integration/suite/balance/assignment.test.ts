import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceAssignmentResolvedEvent,
    ApiKeyBalanceLeaseReleasedEvent
} from '../../../src/interInstance/eventProtocol';
import { RateLimiter, type RateLimitHandle } from '../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
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
} from './retryFixture';

type Assignment = ApiKeyBalanceAssignmentResolvedEvent['payload'];
type Timer = NodeJS.Timeout & { _destroyed: boolean; _onTimeout(): void };
const manager = ApiKeyFailoverManager as unknown as {
    pendingBalanceAssignments: Map<string, { timer: Timer }>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    balanceAttemptSnapshots: Map<string, unknown>;
    abandonedBalanceAssignments?: Map<string, number>;
};

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function observe<T>(promise: Promise<T>) {
    const settled = promise.then(
        value => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error })
    );
    const beforeCleanup = await Promise.race([
        settled,
        new Promise<{ state: 'pending' }>(resolve => {
            setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
        })
    ]);
    if (beforeCleanup.state === 'pending') {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
    }
    await settled;
    return beforeCleanup;
}

suite('balance initial assignment cancellation', () => {
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
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalGetApiKey = ConfigSetStore.getApiKey;
    const originalRelease = RateLimiter.release;
    const originalNow = Date.now;
    let context: vscode.ExtensionContext;
    let term: string;
    let requests: ApiKeyBalanceAssignmentRequestedEvent['payload'][];
    let releases: ApiKeyBalanceLeaseReleasedEvent['payload'][];
    let timers: Timer[];
    let cancellations: ReturnType<typeof trackedCancellation>[];
    let sent: ReturnType<typeof deferred>;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        manager.abandonedBalanceAssignments?.clear();
        BalanceAffinityCache.instance.clear();
        requests = [];
        releases = [];
        timers = [];
        cancellations = [];
        sent = deferred();
        term = `assignment:${randomUUID()}`;
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => false,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => undefined,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'assignment-follower'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                const payload = event.payload as ApiKeyBalanceAssignmentRequestedEvent['payload'];
                requests.push(payload);
                const pending = manager.pendingBalanceAssignments.get(payload.requestId);
                assert.ok(pending);
                timers.push(pending.timer);
                sent.resolve();
            } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                releases.push(event.payload as ApiKeyBalanceLeaseReleasedEvent['payload']);
            }
            return true;
        };
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

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        manager.abandonedBalanceAssignments?.clear();
        BalanceAffinityCache.instance.clear();
        for (const timer of timers) {
            clearTimeout(timer);
        }
        for (const cancellation of cancellations) {
            cancellation.dispose();
        }
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
        ConfigSetStore.getApiKey = originalGetApiKey;
        RateLimiter.release = originalRelease;
        Date.now = originalNow;
    });

    function cancellation(cancelOnSubscribe = false) {
        const tracked = trackedCancellation(cancelOnSubscribe);
        cancellations.push(tracked);
        return tracked;
    }

    function capture(requestId = randomUUID(), token?: vscode.CancellationToken) {
        return ApiKeyFailoverManager.captureAttempt(slot, balanceKey, requestId, undefined, token);
    }

    function assignment(index = 0): Assignment {
        return {
            requestId: requests[index].requestId,
            targetInstanceId: 'assignment-follower',
            authorityTerm: requests[index].authorityTerm,
            handled: true,
            configId: 'b',
            credentialId: identity('key-b'),
            leaseId: `lease-${requests[index].requestId}`,
            expiresAt: Date.now() + 30_000
        };
    }

    function assertClean(tracked: ReturnType<typeof trackedCancellation>) {
        assert.equal(manager.pendingBalanceAssignments.size, 0);
        assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
        assert.equal(manager.balanceAttemptSnapshots.size, 0);
        assert.equal(tracked.disposals, tracked.subscriptions);
        assert.ok(timers.every(timer => timer._destroyed));
    }

    for (const action of [
        'pre-cancel',
        'cancel-on-subscribe',
        'cancel',
        'timeout',
        'mode',
        'authority',
        'reply-cancel',
        'cancel-reply'
    ] as const) {
        test(`assignment settles without leaking its listener or timer: ${action}`, async () => {
            const tracked = cancellation(action === 'cancel-on-subscribe');
            if (action === 'pre-cancel') {
                tracked.cancel();
            }
            const pending = capture(undefined, tracked.token);
            if (action === 'cancel') {
                tracked.cancel();
            }
            if (action === 'timeout') {
                timers[0]._onTimeout();
            }
            if (action === 'mode') {
                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
            }
            if (action === 'authority') {
                ApiKeyFailoverManager.handleBalanceAuthorityLost();
            }
            if (action === 'reply-cancel') {
                ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                tracked.cancel();
            }
            if (action === 'cancel-reply') {
                tracked.cancel();
                ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
            }
            assert.deepEqual(await observe(pending), { state: 'resolved', value: undefined });
            assertClean(tracked);
            if (action === 'pre-cancel' || action === 'cancel-on-subscribe') {
                assert.equal(requests.length, 0);
            } else {
                assert.equal(tracked.subscriptions, action === 'timeout' ? 2 : 1);
                if (!action.includes('reply')) {
                    ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                }
                assert.deepEqual(releases, [{ leaseId: assignment().leaseId, authorityTerm: term }]);
                ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                assert.equal(releases.length, 1, 'duplicate late replies must not release twice');
            }
        });
    }

    for (const action of ['false', 'throw'] as const) {
        test(`assignment cleans up when publication returns ${action}`, async () => {
            const publish = InterInstanceBus.publishIpcOnly;
            InterInstanceBus.publishIpcOnly = event => {
                publish(event);
                if (event.type === 'apiKeyBalanceAssignmentRequested') {
                    if (action === 'throw') {
                        throw new Error('assignment publication failed');
                    }
                    return false;
                }
                return true;
            };
            const tracked = cancellation();
            const pending = capture(undefined, tracked.token);
            if (action === 'throw') {
                await assert.rejects(pending, /assignment publication failed/);
            } else {
                assert.equal(await pending, undefined);
            }
            assertClean(tracked);
            assert.equal(tracked.subscriptions, action === 'false' ? 2 : 1);
        });
    }

    test('normal duplicate replies neither release the accepted lease nor cancel a completed assignment', async () => {
        const tracked = cancellation();
        const started = deferred();
        const gate = deferred();
        ConfigSetStore.getApiKey = async (...args) => {
            started.resolve();
            await gate.promise;
            return originalGetApiKey.apply(ConfigSetStore, args);
        };
        const requestId = randomUUID();
        const pending = capture(requestId, tracked.token);
        const payload = assignment();
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        try {
            await started.promise;
            ApiKeyFailoverManager.resolveBalanceAssignment(payload);
            assert.deepEqual(releases, []);
        } finally {
            gate.resolve();
        }
        const attempt = await pending;
        assert.equal(attempt?.balanceLeaseId, payload.leaseId);
        assert.equal(tracked.subscriptions, 2);
        assert.equal(tracked.disposals, 2);
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        tracked.cancel();
        assert.deepEqual(releases, []);
        assert.equal(manager.balanceAttemptSnapshots.has(requestId), true);
        ApiKeyFailoverManager.releaseBalanceLease(payload.leaseId!, term);
        assertClean(tracked);
    });

    for (const action of ['cancel', 'reject'] as const) {
        test(`assignment releases its lease when secret lookup ${action}s`, async () => {
            const tracked = cancellation();
            const started = deferred();
            const gate = deferred();
            ConfigSetStore.getApiKey = async (...args) => {
                started.resolve();
                await gate.promise;
                if (action === 'reject') {
                    throw new Error('secret lookup failed');
                }
                return originalGetApiKey.apply(ConfigSetStore, args);
            };
            const pending = capture(undefined, tracked.token);
            const payload = assignment();
            ApiKeyFailoverManager.resolveBalanceAssignment(payload);
            await started.promise;
            if (action === 'cancel') {
                tracked.cancel();
            }
            gate.resolve();
            if (action === 'reject') {
                await assert.rejects(pending, /secret lookup failed/);
            } else {
                assert.equal(await pending, undefined);
            }
            assert.deepEqual(releases, [{ leaseId: payload.leaseId, authorityTerm: term }]);
            assertClean(tracked);
        });
    }

    test('cancellation during cached secret lookup cannot restore the snapshot', async () => {
        const requestId = randomUUID();
        const initial = capture(requestId);
        const payload = assignment();
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        assert.ok(await initial);
        const started = deferred();
        const gate = deferred();
        ConfigSetStore.getApiKey = async (...args) => {
            started.resolve();
            await gate.promise;
            return originalGetApiKey.apply(ConfigSetStore, args);
        };
        const tracked = cancellation();
        const pending = capture(requestId, tracked.token);
        await started.promise;
        tracked.cancel();
        gate.resolve();
        assert.equal(await pending, undefined);
        assert.deepEqual(releases, [{ leaseId: payload.leaseId, authorityTerm: term }]);
        assertClean(tracked);
    });

    test('mode changes in another slot do not interrupt an assignment', async () => {
        const tracked = cancellation();
        const pending = capture(undefined, tracked.token);
        ApiKeyFailoverManager.handleBalanceModeChanged('other-slot');
        assert.equal(manager.pendingBalanceAssignments.size, 1);
        const payload = assignment();
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        assert.ok(await pending);
        ApiKeyFailoverManager.releaseBalanceLease(payload.leaseId!, term);
        assertClean(tracked);
    });

    test('a new assignment with the same request id is not released by its old cancellation record', async () => {
        const requestId = randomUUID();
        const tracked = cancellation();
        const abandoned = capture(requestId, tracked.token);
        const payload = assignment();
        tracked.cancel();
        assert.deepEqual(await observe(abandoned), { state: 'resolved', value: undefined });
        const pending = capture(requestId);
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        assert.equal((await pending)?.balanceLeaseId, payload.leaseId);
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        assert.deepEqual(releases, []);
        ApiKeyFailoverManager.releaseBalanceLease(payload.leaseId!, term);
    });

    test('late assignment tracking is bounded and ignores expired cancellation records', async () => {
        const tracked = cancellation();
        const first = capture(undefined, tracked.token);
        const payload = assignment();
        tracked.cancel();
        assert.deepEqual(await observe(first), { state: 'resolved', value: undefined });
        const now = originalNow();
        Date.now = () => now + 60_000;
        ApiKeyFailoverManager.resolveBalanceAssignment(payload);
        assert.deepEqual(releases, []);
        for (let index = 0; index < 1005; index++) {
            const pending = capture();
            ApiKeyFailoverManager.handleBalanceModeChanged(slot);
            assert.equal(await pending, undefined);
        }
        assert.ok(manager.abandonedBalanceAssignments);
        assert.ok(manager.abandonedBalanceAssignments.size <= 1000);
    });

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of ['waiting-resolve', 'waiting-reject', 'assigned-secret-reject'] as const) {
            test(`${sdkMode}: cancelled allocation does not enter fallback I/O: ${phase}`, async () => {
                const tracked = cancellation();
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
                const originalGetPrimary = ApiKeyManager.getApiKey;
                const gate = deferred();
                const lookupStarted = deferred();
                let fallbackReads = 0;
                ApiKeyManager.getApiKey = async provider => {
                    fallbackReads++;
                    lookupStarted.resolve();
                    await gate.promise;
                    if (phase === 'waiting-reject') {
                        throw new Error('primary secret storage unavailable');
                    }
                    return originalGetPrimary.call(ApiKeyManager, provider);
                };
                if (phase === 'assigned-secret-reject') {
                    ConfigSetStore.getApiKey = async () => {
                        lookupStarted.resolve();
                        await gate.promise;
                        throw new Error('assigned secret storage unavailable');
                    };
                }
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token);
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        sent.promise,
                        settled.then(() => {
                            throw new Error('No allocation was requested');
                        })
                    ]);
                    if (phase === 'assigned-secret-reject') {
                        ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                        await lookupStarted.promise;
                    }
                    tracked.cancel();
                    if (phase === 'assigned-secret-reject') {
                        gate.resolve();
                    }
                    const beforeGate = await Promise.race([
                        settled,
                        new Promise<{ state: 'pending' }>(resolve => {
                            setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
                        })
                    ]);
                    const refundsBeforeGate = refunds.length;
                    gate.resolve();
                    const result = await settled;
                    assert.equal(fallbackReads, 0, 'Cancelled allocation must not start fallback SecretStorage I/O');
                    assert.equal(beforeGate.state, 'rejected');
                    assert.equal(refundsBeforeGate, 1);
                    assert.equal(result.state, 'rejected');
                    assert.ok(
                        result.state === 'rejected' && result.error instanceof vscode.CancellationError,
                        'Storage failure after cancellation must not replace cancellation'
                    );
                    assert.deepEqual(refunds, [[handle, handle.costs]]);
                    assert.equal(wireCount, 0);
                    assert.equal(observed.grants, 1);
                    assertClean(tracked);
                    assert.equal(releases.length, phase === 'assigned-secret-reject' ? 1 : 0);
                } finally {
                    gate.resolve();
                    await settled;
                    ApiKeyManager.getApiKey = originalGetPrimary;
                    ConfigSetStore.getApiKey = originalGetApiKey;
                }
            });
        }

        test(`${sdkMode}: uncancelled unavailable allocation still falls back`, async () => {
            const tracked = cancellation();
            const originalGetPrimary = ApiKeyManager.getApiKey;
            let fallbackReads = 0;
            let wireCount = 0;
            ApiKeyManager.getApiKey = async provider => {
                fallbackReads++;
                return originalGetPrimary.call(ApiKeyManager, provider);
            };
            ConfigManager.createProxyAwareFetch = () => async () => {
                wireCount++;
                return successResponse(sdkMode);
            };
            try {
                const pending = RetryProvider.run(sdkMode, defaultRetry, { grants: 0 }, tracked.token);
                await sent.promise;
                ApiKeyFailoverManager.resolveBalanceAssignment({
                    ...assignment(),
                    handled: false,
                    leaseId: undefined
                });
                await pending;
                assert.equal(fallbackReads, 1);
                assert.equal(wireCount, 1);
                assertClean(tracked);
            } finally {
                ApiKeyManager.getApiKey = originalGetPrimary;
            }
        });

        for (const action of ['mode', 'configuration', 'credential'] as const) {
            test(`${sdkMode}: invalidated assignment cannot enter primary fallback: ${action}`, async () => {
                const tracked = cancellation();
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
                const originalGetPrimary = ApiKeyManager.getApiKey;
                let primaryReads = 0;
                let wireCount = 0;
                ApiKeyManager.getApiKey = async provider => {
                    primaryReads++;
                    return originalGetPrimary.call(ApiKeyManager, provider);
                };
                ConfigManager.createProxyAwareFetch = () => async () => {
                    wireCount++;
                    return successResponse(sdkMode);
                };
                const pending = RetryProvider.run(sdkMode, defaultRetry, { grants: 0, handle }, tracked.token);
                const rejected = assert.rejects(pending, /Configuration changed while capturing/);
                try {
                    await sent.promise;
                    const payload = assignment();
                    if (action === 'mode') {
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    } else if (action === 'configuration') {
                        await ConfigSetStore.setApplyOperationToken(slot, randomUUID());
                    } else {
                        await ConfigSetStore.setApiKey(slot, 'b', 'replacement-key');
                    }
                    ApiKeyFailoverManager.resolveBalanceAssignment(payload);
                    await rejected;
                    assert.equal(primaryReads, 0);
                    assert.equal(wireCount, 0);
                    assert.deepEqual(refunds, [[handle, handle.costs]]);
                    assert.deepEqual(releases, [{ leaseId: payload.leaseId, authorityTerm: term }]);
                    assertClean(tracked);
                } finally {
                    ApiKeyManager.getApiKey = originalGetPrimary;
                }
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of [
            'handoff-cancel',
            'handoff-success',
            'fallback-cancel-resolve',
            'fallback-cancel-reject',
            'fallback-reject',
            'assigned-reject'
        ] as const) {
            test(`${sdkMode}: allocation ownership and cancellation boundary: ${phase}`, async () => {
                const tracked = cancellation();
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
                const originalCapture = ApiKeyFailoverManager.captureAttempt;
                const originalHeartbeat = ApiKeyFailoverManager.startBalanceLeaseHeartbeat;
                const originalGetPrimary = ApiKeyManager.getApiKey;
                const gate = deferred();
                const lookupStarted = deferred();
                const lookupError = new Error(`secret storage unavailable during ${phase}`);
                let primaryReads = 0;
                let heartbeatStarts = 0;
                let deliveredLease: string | undefined;
                let snapshotsAtCancellation: number | undefined;
                ApiKeyFailoverManager.captureAttempt = (...args) => {
                    const promise = originalCapture.apply(ApiKeyFailoverManager, args);
                    void promise.then(
                        attempt => {
                            deliveredLease = attempt?.balanceLeaseId;
                            if (phase === 'handoff-cancel' && attempt) {
                                snapshotsAtCancellation = manager.balanceAttemptSnapshots.size;
                                tracked.cancel();
                            }
                        },
                        () => {}
                    );
                    return promise;
                };
                ApiKeyFailoverManager.startBalanceLeaseHeartbeat = (...args) => {
                    heartbeatStarts++;
                    originalHeartbeat.apply(ApiKeyFailoverManager, args);
                };
                ApiKeyManager.getApiKey = async provider => {
                    primaryReads++;
                    if (phase.startsWith('fallback-')) {
                        lookupStarted.resolve();
                        await gate.promise;
                        if (phase.endsWith('reject')) {
                            throw lookupError;
                        }
                    }
                    return originalGetPrimary.call(ApiKeyManager, provider);
                };
                if (phase === 'assigned-reject') {
                    ConfigSetStore.getApiKey = async () => {
                        lookupStarted.resolve();
                        await gate.promise;
                        throw lookupError;
                    };
                }
                const parts: vscode.LanguageModelResponsePart[] = [];
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, parts);
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        sent.promise,
                        settled.then(() => {
                            throw new Error('No allocation was requested');
                        })
                    ]);
                    const payload = assignment();
                    ApiKeyFailoverManager.resolveBalanceAssignment(
                        phase.startsWith('fallback-') ? { ...payload, handled: false, leaseId: undefined } : payload
                    );
                    if (phase.startsWith('fallback-') || phase === 'assigned-reject') {
                        await Promise.race([
                            lookupStarted.promise,
                            settled.then(() => {
                                throw new Error('Secret lookup did not start');
                            })
                        ]);
                        if (phase.startsWith('fallback-cancel-')) {
                            tracked.cancel();
                            const beforeGate = await Promise.race([
                                settled,
                                new Promise<{ state: 'pending' }>(resolve => {
                                    setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
                                })
                            ]);
                            assert.equal(beforeGate.state, 'rejected');
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                        }
                        gate.resolve();
                    }
                    const result = await settled;
                    assert.equal(observed.grants, 1);
                    assert.equal(heartbeatStarts, phase === 'handoff-success' ? 1 : 0);
                    if (phase === 'handoff-success') {
                        assert.equal(result.state, 'resolved');
                        assert.equal(wireCount, 1);
                        assert.deepEqual(refunds, [[handle]]);
                        assert.ok(parts.some(part => part instanceof vscode.LanguageModelTextPart));
                    } else {
                        assert.equal(wireCount, 0);
                        assert.equal(parts.length, 0);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                        assert.equal(result.state, 'rejected');
                        if (phase.includes('cancel')) {
                            assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                        } else {
                            assert.ok(result.state === 'rejected' && result.error === lookupError);
                        }
                    }
                    if (phase.startsWith('handoff-')) {
                        assert.equal(deliveredLease, payload.leaseId);
                        assert.equal(primaryReads, 0);
                    }
                    if (phase === 'handoff-cancel') {
                        assert.equal(snapshotsAtCancellation, 1);
                    }
                    assert.deepEqual(
                        releases,
                        phase.startsWith('fallback-') ? [] : [{ leaseId: payload.leaseId, authorityTerm: term }]
                    );
                    assertClean(tracked);
                } finally {
                    gate.resolve();
                    ApiKeyFailoverManager.handleBalanceAuthorityLost();
                    await settled;
                    ApiKeyFailoverManager.captureAttempt = originalCapture;
                    ApiKeyFailoverManager.startBalanceLeaseHeartbeat = originalHeartbeat;
                    ApiKeyManager.getApiKey = originalGetPrimary;
                    ConfigSetStore.getApiKey = originalGetApiKey;
                }
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of ['primary-key', 'primary-empty', 'metadata-resolve', 'metadata-reject'] as const) {
            test(`${sdkMode}: named request cancellation stops further secret lookup: ${phase}`, async () => {
                const tracked = cancellation();
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
                const originalGetPrimary = ApiKeyManager.getApiKey;
                const primaryStarted = deferred();
                const primaryGate = deferred();
                const metadataStarted = deferred();
                const metadataGate = deferred();
                let metadataReads = 0;
                ApiKeyManager.getApiKey = async provider => {
                    primaryStarted.resolve();
                    await primaryGate.promise;
                    return phase === 'primary-empty' ? undefined : originalGetPrimary.call(ApiKeyManager, provider);
                };
                ConfigSetStore.getApiKey = async (...args) => {
                    metadataReads++;
                    metadataStarted.resolve();
                    await metadataGate.promise;
                    if (phase === 'metadata-reject') {
                        throw new Error('key name metadata unavailable');
                    }
                    return originalGetApiKey.apply(ConfigSetStore, args);
                };
                const parts: vscode.LanguageModelResponsePart[] = [];
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, parts, randomUUID());
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        sent.promise,
                        settled.then(() => {
                            throw new Error('No allocation was requested');
                        })
                    ]);
                    ApiKeyFailoverManager.resolveBalanceAssignment({
                        ...assignment(),
                        handled: false,
                        leaseId: undefined
                    });
                    await primaryStarted.promise;
                    if (phase.startsWith('primary-')) {
                        tracked.cancel();
                        assert.equal(metadataReads, 0, 'Cancellation after primary lookup must skip name metadata');
                    } else {
                        primaryGate.resolve();
                        await metadataStarted.promise;
                        tracked.cancel();
                    }
                    const beforeGate = await Promise.race([
                        settled,
                        new Promise<{ state: 'pending' }>(resolve => {
                            setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
                        })
                    ]);
                    assert.equal(beforeGate.state, 'rejected');
                    assert.deepEqual(refunds, [[handle, handle.costs]]);
                    primaryGate.resolve();
                    metadataGate.resolve();
                    const result = await settled;
                    assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                    assert.equal(metadataReads, phase.startsWith('primary-') ? 0 : 2);
                    assert.deepEqual(refunds, [[handle, handle.costs]]);
                    assert.equal(observed.grants, 1);
                    assert.equal(wireCount, 0);
                    assert.equal(parts.length, 0);
                    assert.deepEqual(releases, []);
                    assertClean(tracked);
                } finally {
                    primaryGate.resolve();
                    metadataGate.resolve();
                    ApiKeyFailoverManager.handleBalanceAuthorityLost();
                    await settled;
                    ApiKeyManager.getApiKey = originalGetPrimary;
                    ConfigSetStore.getApiKey = originalGetApiKey;
                }
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of ['delivery', 'secret-reject'] as const) {
            test(`${sdkMode}: cancelling cached allocation during ${phase} releases the prior lease once`, async () => {
                const tracked = cancellation();
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
                    if (wireCount > 1) {
                        tracked.cancel();
                    }
                    return errorResponse();
                };
                const originalCapture = ApiKeyFailoverManager.captureAttempt;
                let captures = 0;
                let secretReads = 0;
                ApiKeyFailoverManager.captureAttempt = (...args) => {
                    const captureNumber = ++captures;
                    const promise = originalCapture.apply(ApiKeyFailoverManager, args);
                    void promise.then(
                        attempt => {
                            if (phase === 'delivery' && captureNumber === 2 && attempt) {
                                tracked.cancel();
                            }
                        },
                        () => {}
                    );
                    return promise;
                };
                ConfigSetStore.getApiKey = async (...args) => {
                    secretReads++;
                    if (phase === 'secret-reject' && secretReads === 2) {
                        tracked.cancel();
                        throw new Error('cached secret lookup failed after cancellation');
                    }
                    return originalGetApiKey.apply(ConfigSetStore, args);
                };
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token);
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        sent.promise,
                        settled.then(() => {
                            throw new Error('No allocation was requested');
                        })
                    ]);
                    const payload = assignment();
                    ApiKeyFailoverManager.resolveBalanceAssignment(payload);
                    const result = await settled;
                    assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                    assert.equal(captures, 2);
                    assert.equal(secretReads, 2);
                    assert.equal(requests.length, 1);
                    assert.equal(wireCount, 1);
                    assert.equal(observed.grants, 2);
                    assert.deepEqual(refunds, [
                        [firstHandle, { tokens: firstHandle.costs.tokens }],
                        [secondHandle, secondHandle.costs]
                    ]);
                    assert.deepEqual(releases, [{ leaseId: payload.leaseId, authorityTerm: term }]);
                    assertClean(tracked);
                } finally {
                    ApiKeyFailoverManager.handleBalanceAuthorityLost();
                    await settled;
                    ApiKeyFailoverManager.captureAttempt = originalCapture;
                    ConfigSetStore.getApiKey = originalGetApiKey;
                }
            });
        }
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of ['pre-cancel', 'waiting', 'secret'] as const) {
            test(`${sdkMode}: ${phase} cancellation refunds the grant without dispatching or retrying`, async () => {
                const tracked = cancellation();
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
                let wireCount = 0;
                ConfigManager.createProxyAwareFetch = () => async () => {
                    wireCount++;
                    return successResponse(sdkMode);
                };
                const observed = { grants: 0, handle };
                const parts: vscode.LanguageModelResponsePart[] = [];
                const gate = deferred();
                const started = deferred();
                if (phase === 'pre-cancel') {
                    tracked.cancel();
                }
                if (phase === 'secret') {
                    ConfigSetStore.getApiKey = async (...args) => {
                        started.resolve();
                        await gate.promise;
                        return originalGetApiKey.apply(ConfigSetStore, args);
                    };
                }
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, parts);
                const outcome = observe(pending);
                if (phase !== 'pre-cancel') {
                    await sent.promise;
                    if (phase === 'secret') {
                        ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                        await started.promise;
                    }
                    tracked.cancel();
                    gate.resolve();
                }
                const result = await outcome;
                assert.equal(result.state, 'rejected');
                assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                assert.equal(wireCount, 0);
                assert.equal(parts.length, 0);
                assert.equal(observed.grants, 1);
                assert.deepEqual(refunds, [[handle, handle.costs]]);
                assertClean(tracked);
                if (phase === 'waiting') {
                    ApiKeyFailoverManager.resolveBalanceAssignment(assignment());
                }
                assert.equal(releases.length, phase === 'pre-cancel' ? 0 : 1);
            });
        }
    }
});
