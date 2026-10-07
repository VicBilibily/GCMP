import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    createContext,
    defaultRetry,
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

suite('request credential preparation boundaries', () => {
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
    const originalSaved = ConfigSetStore.getApiKey;
    const originalPrimary = ApiKeyManager.getApiKey;
    const originalRequestKey = ApiKeyManager.getApiKeyForRequest;
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    let context: vscode.ExtensionContext;
    let handle: RateLimitHandle;
    let refunds: Array<Parameters<typeof RateLimiter.release>>;
    let authorizations: Array<string | null>;
    let captureFinished: boolean;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => false,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => undefined,
            getAuthorityTerm: () => 'credential-preparation:1',
            getInstanceId: () => 'credential-preparation-follower'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => 'credential-preparation:1',
            hasActiveTransport: () => true,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => false,
            publish: () => {}
        });
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'a', balanceWeight: 0 }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', balanceWeight: 1 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'outside-key');
        handle = {
            grantId: randomUUID(),
            costs: { requests: 1, tokens: 50 },
            leaseMs: 30_000,
            authoritative: true,
            authorityTerm: 'credential-preparation:1'
        };
        refunds = [];
        authorizations = [];
        captureFinished = false;
        RateLimiter.release = (...args) => {
            refunds.push(args);
        };
        ApiKeyFailoverManager.captureAttempt = async (...args) => {
            const attempt = await originalCapture.apply(ApiKeyFailoverManager, args);
            captureFinished = true;
            return attempt;
        };
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        ConfigSetStore.getApiKey = originalSaved;
        ApiKeyManager.getApiKey = originalPrimary;
        ApiKeyManager.getApiKeyForRequest = originalRequestKey;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
    });

    for (const sdk of ['openai', 'openai-responses'] as const) {
        for (const phase of ['names', 'primary'] as const) {
            for (const mode of ['off', 'failover'] as const) {
                for (const action of [
                    'unchanged',
                    'zero-key',
                    'positive-key',
                    'all-zero',
                    'mode-roundtrip',
                    'automatic-mode',
                    'manual-mode',
                    'authority'
                ] as const) {
                    test(`${sdk}: ${mode} ${phase} boundary handles ${action}`, async () => {
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                        const gate = deferred();
                        const reached = deferred();
                        const reads: Array<Promise<string | undefined>> = [];
                        ConfigSetStore.getApiKey = (...args) => {
                            const pending = (async () => {
                                if (captureFinished && phase === 'names') {
                                    reached.resolve();
                                    await gate.promise;
                                }
                                return originalSaved.apply(ConfigSetStore, args);
                            })();
                            reads.push(pending);
                            return pending;
                        };
                        ApiKeyManager.getApiKey = (...args) => {
                            const pending = (async () => {
                                if (captureFinished && phase === 'primary') {
                                    reached.resolve();
                                    await gate.promise;
                                }
                                return originalPrimary.apply(ApiKeyManager, args);
                            })();
                            reads.push(pending);
                            return pending;
                        };
                        ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                            authorizations.push(new Request(input, init).headers.get('authorization'));
                            return successResponse(sdk);
                        };
                        const tracked = trackedCancellation();
                        const observed = { grants: 0, handle };
                        const settled = RetryProvider.run(
                            sdk,
                            defaultRetry,
                            observed,
                            tracked.token,
                            [],
                            randomUUID()
                        ).then(
                            () => ({ state: 'resolved' as const }),
                            (error: unknown) => ({ state: 'rejected' as const, error })
                        );
                        try {
                            await Promise.race([
                                reached.promise,
                                settled.then(() => {
                                    throw new Error('Credential boundary was not reached');
                                })
                            ]);
                            if (action === 'zero-key' || action === 'positive-key') {
                                await ApiKeyManager.setApiKey(slot, action === 'zero-key' ? 'key-a' : 'key-b');
                            } else if (action === 'all-zero') {
                                await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 });
                            } else if (action === 'mode-roundtrip') {
                                await ConfigSetStore.setSwitchMode(slot, mode === 'off' ? 'failover' : 'off');
                                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                                await ConfigSetStore.setSwitchMode(slot, mode);
                                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                            } else if (action === 'automatic-mode' || action === 'manual-mode') {
                                await ConfigSetStore.setSwitchMode(
                                    slot,
                                    action === 'manual-mode' ? 'off'
                                    : mode === 'off' ? 'failover'
                                    : 'balance'
                                );
                                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                            } else if (action === 'authority') {
                                ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                            }
                            gate.resolve();
                            const result = await settled;
                            await Promise.allSettled(reads);
                            const changedConfig =
                                action === 'zero-key' || action === 'positive-key' || action === 'all-zero';
                            const shouldReject =
                                (changedConfig && (mode === 'failover' || phase === 'primary')) ||
                                action === 'automatic-mode' ||
                                (action === 'mode-roundtrip' && (mode === 'failover' || phase === 'primary')) ||
                                (action === 'manual-mode' && phase === 'primary');
                            assert.equal(observed.grants, 1);
                            assert.equal(tracked.disposals, tracked.subscriptions);
                            if (shouldReject) {
                                assert.deepEqual(authorizations, []);
                                assert.ok(
                                    result.state === 'rejected' &&
                                        result.error instanceof Error &&
                                        /Configuration changed while capturing/.test(result.error.message)
                                );
                                assert.deepEqual(refunds, [[handle, handle.costs]]);
                            } else {
                                assert.equal(result.state, 'resolved');
                                const expectedKey =
                                    action === 'zero-key' ? 'key-a'
                                    : action === 'positive-key' ? 'key-b'
                                    : 'outside-key';
                                assert.deepEqual(authorizations, [`Bearer ${expectedKey}`]);
                                assert.deepEqual(refunds, [[handle]]);
                            }
                        } finally {
                            gate.resolve();
                            await settled;
                            await Promise.allSettled(reads);
                            tracked.dispose();
                        }
                    });
                }
            }
        }

        for (const mode of ['off', 'failover'] as const) {
            for (const ending of ['cancel-resolve', 'cancel-reject', 'failure'] as const) {
                test(`${sdk}: ${mode} primary ${ending} refunds before dispatch`, async () => {
                    await ConfigSetStore.setSwitchMode(slot, mode);
                    const gate = deferred();
                    const reached = deferred();
                    const reads: Array<Promise<string | undefined>> = [];
                    ApiKeyManager.getApiKey = (...args) => {
                        const pending = (async () => {
                            if (captureFinished) {
                                reached.resolve();
                                await gate.promise;
                                if (ending !== 'cancel-resolve') {
                                    throw new Error('primary key storage unavailable');
                                }
                            }
                            return originalPrimary.apply(ApiKeyManager, args);
                        })();
                        reads.push(pending);
                        return pending;
                    };
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        authorizations.push(new Request(input, init).headers.get('authorization'));
                        return successResponse(sdk);
                    };
                    const tracked = trackedCancellation();
                    const observed = { grants: 0, handle };
                    const settled = RetryProvider.run(
                        sdk,
                        defaultRetry,
                        observed,
                        tracked.token,
                        [],
                        randomUUID()
                    ).then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    try {
                        await Promise.race([
                            reached.promise,
                            settled.then(() => {
                                throw new Error('Primary read boundary was not reached');
                            })
                        ]);
                        if (ending !== 'failure') {
                            tracked.cancel();
                            assert.equal((await settleBeforeGate(settled)).state, 'rejected');
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                        }
                        gate.resolve();
                        const result = await settled;
                        await Promise.allSettled(reads);
                        assert.ok(result.state === 'rejected' && result.error instanceof Error);
                        if (ending !== 'failure') {
                            assert.ok(result.error instanceof vscode.CancellationError);
                        } else {
                            assert.match(result.error.message, /primary key storage unavailable/);
                        }
                        assert.deepEqual(authorizations, []);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                        assert.equal(observed.grants, 1);
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

        for (const mode of ['failover', 'off', 'balance'] as const) {
            for (const phase of mode === 'balance' ? (['names'] as const) : (['names', 'primary'] as const)) {
                for (const mutation of [
                    'primary-zero',
                    'primary-positive',
                    'metadata-zero',
                    'shared-positive',
                    'other-site'
                ] as const) {
                    test(`${sdk}: in-flight ${mode} ${mutation} completes during ${phase}`, async () => {
                        if (mutation === 'shared-positive' || mutation === 'other-site') {
                            await ConfigSetStore.writeAll(
                                slot,
                                [
                                    { id: 'a', label: 'a', balanceWeight: 0 },
                                    {
                                        id: 'b',
                                        label: 'b',
                                        balanceWeight: 1,
                                        ...(mutation === 'other-site' ? { site: 'other-site' } : {})
                                    }
                                ],
                                { a: 'key-a', b: 'key-a' },
                                'a'
                            );
                        }
                        await ConfigSetStore.setSwitchMode(slot, mode);
                        if (mode === 'balance') {
                            LeaderElectionService.isInitialized = () => false;
                        }
                        const originalStore = context.secrets.store;
                        const originalUpdate = context.globalState.update;
                        const writing = deferred();
                        const commit = deferred();
                        const reached = deferred();
                        const gate = deferred();
                        const reads: Array<Promise<string | undefined>> = [];
                        const previousOperation = ConfigSetStore.getApplyOperationToken(slot);
                        context.secrets.store = async (key, value) => {
                            if (mutation !== 'metadata-zero' && key === `${slot}.apiKey`) {
                                writing.resolve();
                                await commit.promise;
                            }
                            await originalStore.call(context.secrets, key, value);
                        };
                        context.globalState.update = async (key: string, value: unknown) => {
                            if (mutation === 'metadata-zero' && key === `configSets.items.${slot}`) {
                                writing.resolve();
                                await commit.promise;
                            }
                            await originalUpdate.call(context.globalState, key, value);
                        };
                        ConfigSetStore.getApiKey = (...args) => {
                            const pending = (async () => {
                                if (captureFinished && phase === 'names') {
                                    reached.resolve();
                                    await gate.promise;
                                }
                                return originalSaved.apply(ConfigSetStore, args);
                            })();
                            reads.push(pending);
                            return pending;
                        };
                        ApiKeyManager.getApiKey = (...args) => {
                            const pending = (async () => {
                                if (captureFinished && phase === 'primary') {
                                    reached.resolve();
                                    await gate.promise;
                                }
                                return originalPrimary.apply(ApiKeyManager, args);
                            })();
                            reads.push(pending);
                            return pending;
                        };
                        ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                            authorizations.push(new Request(input, init).headers.get('authorization'));
                            return successResponse(sdk);
                        };
                        const write =
                            mutation === 'metadata-zero' ?
                                ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 })
                            :   ApiKeyManager.setApiKey(slot, mutation === 'primary-positive' ? 'key-b' : 'key-a');
                        const tracked = trackedCancellation();
                        const observed = { grants: 0, handle };
                        let settled: Promise<{ state: 'resolved' } | { state: 'rejected'; error: unknown }> | undefined;
                        try {
                            await Promise.race([
                                writing.promise,
                                write.then(() => {
                                    throw new Error('Persistence boundary was not reached');
                                })
                            ]);
                            const operation = ConfigSetStore.getApplyOperationToken(slot);
                            assert.notEqual(operation, previousOperation);
                            assert.equal(await originalPrimary.call(ApiKeyManager, slot), 'outside-key');
                            settled = RetryProvider.run(
                                sdk,
                                defaultRetry,
                                observed,
                                tracked.token,
                                [],
                                randomUUID()
                            ).then(
                                () => ({ state: 'resolved' as const }),
                                (error: unknown) => ({ state: 'rejected' as const, error })
                            );
                            await Promise.race([
                                reached.promise,
                                settled.then(() => {
                                    throw new Error('Credential boundary was not reached');
                                })
                            ]);
                            commit.resolve();
                            await write;
                            assert.equal(ConfigSetStore.getApplyOperationToken(slot), operation);
                            gate.resolve();
                            const result = await settled;
                            await Promise.allSettled(reads);
                            const shouldReject =
                                mode === 'failover' &&
                                mutation !== 'primary-positive' &&
                                mutation !== 'shared-positive';
                            assert.equal(observed.grants, 1);
                            assert.equal(tracked.disposals, tracked.subscriptions);
                            if (shouldReject) {
                                assert.deepEqual(authorizations, []);
                                assert.ok(result.state === 'rejected' && result.error instanceof Error);
                                assert.match(result.error.message, /positive-weight API key/);
                                assert.deepEqual(refunds, [[handle, handle.costs]]);
                            } else {
                                assert.equal(result.state, 'resolved');
                                const expectedKey =
                                    mode === 'balance' || mutation === 'metadata-zero' ? 'outside-key'
                                    : mutation === 'primary-positive' ? 'key-b'
                                    : 'key-a';
                                assert.deepEqual(authorizations, [`Bearer ${expectedKey}`]);
                                assert.deepEqual(refunds, [[handle]]);
                            }
                        } finally {
                            commit.resolve();
                            gate.resolve();
                            await Promise.allSettled([write, ...(settled ? [settled] : []), ...reads]);
                            context.secrets.store = originalStore;
                            context.globalState.update = originalUpdate;
                            tracked.dispose();
                        }
                    });
                }
            }
        }

        for (const ending of [
            'unchanged',
            'failure',
            'cancel-resolve',
            'cancel-reject',
            'same-operation-metadata',
            'same-operation-key',
            'mode-roundtrip',
            'primary-change',
            'authority'
        ] as const) {
            test(`${sdk}: fallback eligibility ${ending} keeps the pre-dispatch boundary`, async () => {
                await ConfigSetStore.setSwitchMode(slot, 'failover');
                const gate = deferred();
                const reached = deferred();
                const reads: Array<Promise<string | undefined>> = [];
                ConfigSetStore.getApiKey = (...args) => {
                    const pending = (async () => {
                        if (captureFinished) {
                            reached.resolve();
                            await gate.promise;
                            if (ending === 'failure' || ending === 'cancel-reject') {
                                throw new Error('eligibility key storage unavailable');
                            }
                        }
                        return originalSaved.apply(ConfigSetStore, args);
                    })();
                    reads.push(pending);
                    return pending;
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdk);
                };
                const tracked = trackedCancellation();
                const observed = { grants: 0, handle };
                const operation = ConfigSetStore.getApplyOperationToken(slot);
                const settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token).then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        reached.promise,
                        settled.then(() => {
                            throw new Error('Eligibility boundary was not reached');
                        })
                    ]);
                    if (ending === 'cancel-resolve' || ending === 'cancel-reject') {
                        tracked.cancel();
                        assert.equal((await settleBeforeGate(settled)).state, 'rejected');
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    } else if (ending === 'same-operation-metadata') {
                        await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 }, undefined, operation);
                        assert.equal(ConfigSetStore.getApplyOperationToken(slot), operation);
                    } else if (ending === 'same-operation-key') {
                        await ConfigSetStore.setApiKey(slot, 'a', 'outside-key', operation);
                        assert.equal(ConfigSetStore.getApplyOperationToken(slot), operation);
                    } else if (ending === 'mode-roundtrip') {
                        await ConfigSetStore.setSwitchMode(slot, 'off');
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                        await ConfigSetStore.setSwitchMode(slot, 'failover');
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    } else if (ending === 'primary-change') {
                        await ApiKeyManager.setApiKey(slot, 'key-a');
                    } else if (ending === 'authority') {
                        ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                    }
                    gate.resolve();
                    const result = await settled;
                    await Promise.allSettled(reads);
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    if (ending === 'unchanged' || ending === 'authority') {
                        assert.equal(result.state, 'resolved');
                        assert.deepEqual(authorizations, ['Bearer outside-key']);
                        assert.deepEqual(refunds, [[handle]]);
                    } else {
                        assert.ok(result.state === 'rejected' && result.error instanceof Error);
                        if (ending === 'cancel-resolve' || ending === 'cancel-reject') {
                            assert.ok(result.error instanceof vscode.CancellationError);
                        } else if (ending === 'failure') {
                            assert.match(result.error.message, /eligibility key storage unavailable/);
                        } else if (ending === 'same-operation-key') {
                            assert.match(result.error.message, /positive-weight API key/);
                        } else {
                            assert.match(result.error.message, /Configuration changed while capturing/);
                        }
                        assert.deepEqual(authorizations, []);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    }
                } finally {
                    gate.resolve();
                    await settled;
                    await Promise.allSettled(reads);
                    tracked.dispose();
                }
            });
        }

        for (const scenario of ['manual', 'unmatched', 'balance-fallback', 'bound-failover', 'missing'] as const) {
            test(`${sdk}: handler consumption preserves the prepared ${scenario} credential`, async () => {
                const mode =
                    scenario === 'manual' || scenario === 'missing' ? 'off'
                    : scenario === 'balance-fallback' ? 'balance'
                    : 'failover';
                await ConfigSetStore.setSwitchMode(slot, mode);
                if (scenario === 'balance-fallback') {
                    LeaderElectionService.isInitialized = () => false;
                } else if (scenario === 'bound-failover') {
                    await ApiKeyManager.setApiKey(slot, 'key-b');
                } else if (scenario === 'missing') {
                    await ApiKeyManager.deleteApiKey(slot);
                }
                const gate = deferred();
                const reached = deferred();
                ApiKeyManager.getApiKeyForRequest = async (...args) => {
                    reached.resolve();
                    await gate.promise;
                    return originalRequestKey.apply(ApiKeyManager, args);
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdk);
                };
                const tracked = trackedCancellation();
                const observed = { grants: 0, handle };
                const settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token, [], randomUUID()).then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        reached.promise,
                        settled.then(() => {
                            throw new Error('Handler credential boundary was not reached');
                        })
                    ]);
                    await ApiKeyManager.setApiKey(slot, 'key-a');
                    await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 });
                    await ConfigSetStore.setSwitchMode(slot, 'failover');
                    ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    gate.resolve();
                    const result = await settled;
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    if (scenario === 'missing') {
                        assert.ok(result.state === 'rejected' && result.error instanceof Error);
                        assert.match(result.error.message, /Missing .* API key/);
                        assert.deepEqual(authorizations, []);
                    } else {
                        assert.equal(result.state, 'resolved');
                        assert.deepEqual(authorizations, [
                            scenario === 'bound-failover' ? 'Bearer key-b' : 'Bearer outside-key'
                        ]);
                        assert.deepEqual(refunds, [[handle]]);
                    }
                } finally {
                    gate.resolve();
                    await settled;
                    tracked.dispose();
                }
            });
        }
    }
});
