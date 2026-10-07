import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../../src/interInstance/activation';
import type { ApiKeyFailoverToggledEvent } from '../../../../src/interInstance/eventProtocol';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { captureRequestApiKeyNames } from '../../../../src/utils/config/configSetCommands';
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

suite('balance pre-dispatch boundaries', () => {
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
    const originalGetPrimary = ApiKeyManager.getApiKey;
    const originalGetSaved = ConfigSetStore.getApiKey;
    const originalValidate = ApiKeyFailoverManager.validateBalanceFallback;
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalBind = ApiKeyManager.bindRequestApiKey;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    let context: vscode.ExtensionContext;
    const term = 'pre-dispatch-leader:1';
    let lastModeEventTimestamp = 0;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        Object.assign(LeaderElectionService, {
            isInitialized: () => false,
            isLeader: () => false,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => undefined,
            getAuthorityTerm: () => term,
            getInstanceId: () => 'pre-dispatch-follower'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        InterInstanceBus.publishIpcOnly = () => false;
        InterInstanceBus.publish = () => {};
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
        ApiKeyManager.getApiKey = originalGetPrimary;
        ConfigSetStore.getApiKey = originalGetSaved;
        ApiKeyFailoverManager.validateBalanceFallback = originalValidate;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ApiKeyManager.bindRequestApiKey = originalBind;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
    });

    for (const action of ['pre-cancel', 'cancel-on-subscribe', 'success', 'failure'] as const) {
        test(`name metadata capture handles ${action} without leaking its listener`, async () => {
            const tracked = trackedCancellation(action === 'cancel-on-subscribe');
            let keyReads = 0;
            ConfigSetStore.getApiKey = async (...args) => {
                keyReads++;
                if (action === 'failure') {
                    throw new Error('optional names unavailable');
                }
                return originalGetSaved.apply(ConfigSetStore, args);
            };
            if (action === 'pre-cancel') {
                tracked.cancel();
            }
            try {
                const pending = captureRequestApiKeyNames(slot, undefined, tracked.token);
                if (action === 'pre-cancel' || action === 'cancel-on-subscribe') {
                    await assert.rejects(pending, vscode.CancellationError);
                    assert.equal(keyReads, 0);
                } else {
                    const names = await pending;
                    assert.equal(keyReads, 2);
                    if (action === 'failure') {
                        assert.equal(names.size, 0);
                    } else {
                        assert.equal(names.size, 2);
                        assert.equal(names.get(createHash('sha256').update('key-a').digest('hex')), 'a');
                    }
                }
                assert.equal(tracked.subscriptions, action === 'pre-cancel' ? 0 : 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }

    test('fallback captures the primary key without reading saved secrets', async () => {
        let savedReads = 0;
        ConfigSetStore.getApiKey = async () => {
            savedReads++;
            throw new Error('saved secrets unavailable');
        };
        assert.deepEqual(await ApiKeyFailoverManager.validateBalanceFallback(slot), {
            apiKey: 'key-a',
            site: undefined
        });
        assert.equal(savedReads, 0);
    });

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const phase of ['validation', 'names'] as const) {
            for (const ending of ['resolve', 'reject'] as const) {
                test(`${sdkMode}: cancellation refunds before ${phase} storage ${ending}`, async () => {
                    const tracked = trackedCancellation();
                    const gate = deferred();
                    const started = deferred();
                    const handle: RateLimitHandle = {
                        grantId: randomUUID(),
                        costs: { requests: 1, tokens: 50 },
                        leaseMs: 30_000,
                        authoritative: true,
                        authorityTerm: term
                    };
                    const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                    const reads: Array<Promise<string | undefined>> = [];
                    let validationFinished = false;
                    let validations = 0;
                    let wireCount = 0;
                    ApiKeyFailoverManager.validateBalanceFallback = async (...args) => {
                        validations++;
                        const snapshot = await originalValidate.apply(ApiKeyFailoverManager, args);
                        validationFinished = true;
                        return snapshot;
                    };
                    ApiKeyManager.getApiKey = (...args) => {
                        const read = (async () => {
                            if (phase === 'validation') {
                                started.resolve();
                                await gate.promise;
                                if (ending === 'reject') {
                                    throw new Error('primary secret storage unavailable');
                                }
                            }
                            return originalGetPrimary.apply(ApiKeyManager, args);
                        })();
                        reads.push(read);
                        return read;
                    };
                    ConfigSetStore.getApiKey = (...args) => {
                        const read = (async () => {
                            if (phase === 'names' && validationFinished) {
                                started.resolve();
                                await gate.promise;
                                if (ending === 'reject') {
                                    throw new Error('metadata storage unavailable');
                                }
                            }
                            return originalGetSaved.apply(ConfigSetStore, args);
                        })();
                        reads.push(read);
                        return read;
                    };
                    RateLimiter.release = (...args) => {
                        refunds.push(args);
                    };
                    ConfigManager.createProxyAwareFetch = () => async () => {
                        wireCount++;
                        return successResponse(sdkMode);
                    };
                    const observed = { grants: 0, handle };
                    const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, [], randomUUID());
                    const settled = pending.then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    try {
                        await Promise.race([
                            started.promise,
                            settled.then(() => {
                                throw new Error('The intended storage gate was not reached');
                            })
                        ]);
                        assert.equal(validationFinished, phase === 'names');
                        tracked.cancel();
                        const beforeGate = await settleBeforeGate(settled);
                        const refundsBeforeGate = refunds.length;
                        gate.resolve();
                        const result = await settled;
                        await Promise.allSettled(reads);
                        assert.equal(beforeGate.state, 'rejected');
                        assert.equal(refundsBeforeGate, 1);
                        assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                        assert.equal(wireCount, 0);
                        assert.equal(observed.grants, 1);
                        assert.equal(validations, 1);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
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

        test(`${sdkMode}: optional name metadata failure does not block a validated fallback`, async () => {
            const tracked = trackedCancellation();
            let validationFinished = false;
            ApiKeyFailoverManager.validateBalanceFallback = async (...args) => {
                const snapshot = await originalValidate.apply(ApiKeyFailoverManager, args);
                validationFinished = true;
                return snapshot;
            };
            ConfigSetStore.getApiKey = async (...args) => {
                if (validationFinished) {
                    throw new Error('optional key names unavailable');
                }
                return originalGetSaved.apply(ConfigSetStore, args);
            };
            const authorizations: Array<string | null> = [];
            ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                authorizations.push(new Request(input, init).headers.get('authorization'));
                return successResponse(sdkMode);
            };
            const observed = { grants: 0 };
            try {
                await RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, [], randomUUID());
                assert.deepEqual(authorizations, ['Bearer key-a']);
                assert.equal(observed.grants, 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });

        for (const scenario of [
            'always-balance',
            'remain-off',
            'off-then-balance',
            'off-then-failover',
            'off-then-failover-then-authority'
        ] as const) {
            test(`${sdkMode}: fallback dispatch preserves ${scenario} binding and refund rules`, async () => {
                await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 });
                const tracked = trackedCancellation();
                const captured = deferred();
                const captureGate = deferred();
                const namesStarted = deferred();
                const namesGate = deferred();
                const reads: Array<Promise<string | undefined>> = [];
                const bindings: string[] = [];
                const authorizations: Array<string | null> = [];
                const wireModes: string[] = [];
                let captureFinished = false;
                let capturedAttempt = false;
                let validatedKey: string | undefined;
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
                ApiKeyFailoverManager.captureAttempt = async (...args) => {
                    const attempt = await originalCapture.call(
                        ApiKeyFailoverManager,
                        args[0],
                        args[1],
                        args[2],
                        args[3],
                        args[4],
                        snapshot => {
                            validatedKey = snapshot.apiKey;
                            args[5]?.(snapshot);
                        }
                    );
                    capturedAttempt = !!attempt;
                    captureFinished = true;
                    captured.resolve();
                    await captureGate.promise;
                    return attempt;
                };
                ApiKeyManager.bindRequestApiKey = (target, apiKey) => {
                    bindings.push(apiKey);
                    originalBind.call(ApiKeyManager, target, apiKey);
                };
                ConfigSetStore.getApiKey = (...args) => {
                    const read = (async () => {
                        if (captureFinished) {
                            namesStarted.resolve();
                            await namesGate.promise;
                        }
                        return originalGetSaved.apply(ConfigSetStore, args);
                    })();
                    reads.push(read);
                    return read;
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    wireModes.push(ConfigSetStore.getSwitchMode(slot));
                    return successResponse(sdkMode);
                };
                const observed = { grants: 0, handle };
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, [], randomUUID());
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        captured.promise,
                        settled.then(() => {
                            throw new Error('Fallback snapshot was not captured');
                        })
                    ]);
                    assert.equal(capturedAttempt, false);
                    assert.equal(validatedKey, 'key-a');
                    if (scenario !== 'always-balance') {
                        await ConfigSetStore.setSwitchMode(slot, 'off');
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    }
                    captureGate.resolve();
                    await Promise.race([
                        namesStarted.promise,
                        settled.then(() => {
                            throw new Error('Name metadata boundary was not reached');
                        })
                    ]);
                    assert.deepEqual(bindings, scenario === 'always-balance' ? ['key-a'] : []);
                    await ApiKeyManager.setApiKey(slot, 'key-b');
                    if (scenario === 'off-then-balance' || scenario === 'off-then-failover') {
                        await ConfigSetStore.setSwitchMode(
                            slot,
                            scenario === 'off-then-balance' ? 'balance' : 'failover'
                        );
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    }
                    if (scenario === 'off-then-failover-then-authority') {
                        await ConfigSetStore.setSwitchMode(slot, 'failover');
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                        ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                    }
                    namesGate.resolve();
                    const result = await settled;
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    if (
                        scenario === 'off-then-balance' ||
                        scenario === 'off-then-failover' ||
                        scenario === 'off-then-failover-then-authority'
                    ) {
                        assert.deepEqual(authorizations, []);
                        assert.deepEqual(wireModes, []);
                        assert.ok(
                            result.state === 'rejected' &&
                                result.error instanceof Error &&
                                /Configuration changed while capturing/.test(result.error.message)
                        );
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    } else {
                        assert.equal(result.state, 'resolved');
                        assert.deepEqual(authorizations, [
                            scenario === 'always-balance' ? 'Bearer key-a' : 'Bearer key-b'
                        ]);
                        assert.deepEqual(wireModes, [scenario === 'always-balance' ? 'balance' : 'off']);
                        assert.deepEqual(refunds, [[handle]]);
                    }
                } finally {
                    captureGate.resolve();
                    namesGate.resolve();
                    await settled;
                    await Promise.allSettled(reads);
                    tracked.dispose();
                }
            });
        }

        test(`${sdkMode}: authority change without mode change preserves unmatched fallback`, async () => {
            const tracked = trackedCancellation();
            const captureReturned = deferred();
            const captureGate = deferred();
            const handle: RateLimitHandle = {
                grantId: randomUUID(),
                costs: { requests: 1, tokens: 50 },
                leaseMs: 30_000,
                authoritative: true,
                authorityTerm: term
            };
            const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
            const authorizations: Array<string | null> = [];
            RateLimiter.release = (...args) => {
                refunds.push(args);
            };
            await ApiKeyManager.setApiKey(slot, 'outside-key');
            await ConfigSetStore.setSwitchMode(slot, 'failover');
            ApiKeyFailoverManager.handleBalanceModeChanged(slot);
            ApiKeyFailoverManager.captureAttempt = async (...args) => {
                const attempt = await originalCapture.apply(ApiKeyFailoverManager, args);
                captureReturned.resolve();
                await captureGate.promise;
                return attempt;
            };
            ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                authorizations.push(new Request(input, init).headers.get('authorization'));
                return successResponse(sdkMode);
            };
            const observed = { grants: 0, handle };
            const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, [], randomUUID());
            const settled = pending.then(
                () => ({ state: 'resolved' as const }),
                (error: unknown) => ({ state: 'rejected' as const, error })
            );
            try {
                await Promise.race([
                    captureReturned.promise,
                    settled.then(() => {
                        throw new Error('Failover fallback capture was not reached');
                    })
                ]);
                ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                captureGate.resolve();
                const result = await settled;
                assert.equal(result.state, 'resolved');
                assert.deepEqual(authorizations, ['Bearer outside-key']);
                assert.deepEqual(refunds, [[handle]]);
                assert.equal(observed.grants, 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                captureGate.resolve();
                await settled;
                tracked.dispose();
            }
        });

        for (const scenario of [
            'completed-notification',
            'visible-before-notification',
            'remain-off',
            'unchanged-failover',
            'stale-event',
            'stale-event-after-authority',
            'duplicate-event-after-authority',
            'new-event-after-authority',
            'other-slot-event-after-authority'
        ] as const) {
            test(`${sdkMode}: mode publication boundary preserves ${scenario}`, async () => {
                LeaderElectionService.isInitialized = () => true;
                await ConfigSetStore.updateMeta(slot, 'a', { balanceWeight: 0 });
                const switching = scenario === 'completed-notification' || scenario === 'visible-before-notification';
                const initialMode = switching || scenario === 'remain-off' ? 'off' : 'failover';
                await ApiKeyManager.setApiKey(slot, initialMode === 'off' ? 'key-a' : 'outside-key');
                await ConfigSetStore.setSwitchMode(slot, initialMode);
                registerInterInstanceHandlers(context);
                const bus = InterInstanceBus as unknown as {
                    handlers: Map<string, Set<(event: ApiKeyFailoverToggledEvent) => void>>;
                };
                const handlers = bus.handlers.get('apiKeyFailoverToggled');
                assert.ok(handlers?.size);
                const deliverMode = (timestamp: number, mode: 'off' | 'failover', eventSlot = slot) => {
                    for (const handler of handlers) {
                        handler({
                            type: 'apiKeyFailoverToggled',
                            timestamp,
                            senderInstanceId: 'pre-dispatch-other-window',
                            payload: { slot: eventSlot, enabled: mode !== 'off', mode }
                        });
                    }
                };
                const timestamp = Math.max(Date.now(), lastModeEventTimestamp + 2);
                lastModeEventTimestamp = timestamp + 2;
                const generationBeforeEvent = ApiKeyFailoverManager.getSwitchModeGeneration(slot);
                deliverMode(timestamp, initialMode);
                const initialGeneration = ApiKeyFailoverManager.getSwitchModeGeneration(slot);
                assert.equal(initialGeneration, generationBeforeEvent + 1);
                const namesStarted = deferred();
                const namesGate = deferred();
                const modeStored = deferred();
                const storageGate = deferred();
                const reads: Array<Promise<string | undefined>> = [];
                const bindings: string[] = [];
                const wires: Array<{ authorization: string | null; mode: string }> = [];
                let captureFinished = false;
                let capturedAttempt = false;
                let modeChange: Promise<void> | undefined;
                const handle: RateLimitHandle = {
                    grantId: randomUUID(),
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: term
                };
                const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                ApiKeyFailoverManager.captureAttempt = async (...args) => {
                    const attempt = await originalCapture.apply(ApiKeyFailoverManager, args);
                    captureFinished = true;
                    capturedAttempt = !!attempt;
                    return attempt;
                };
                ConfigSetStore.getApiKey = (...args) => {
                    const read = (async () => {
                        if (captureFinished) {
                            namesStarted.resolve();
                            await namesGate.promise;
                        }
                        return originalGetSaved.apply(ConfigSetStore, args);
                    })();
                    reads.push(read);
                    return read;
                };
                ApiKeyManager.bindRequestApiKey = (config, key) => {
                    bindings.push(key);
                    originalBind.call(ApiKeyManager, config, key);
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    wires.push({
                        authorization: new Request(input, init).headers.get('authorization'),
                        mode: ConfigSetStore.getSwitchMode(slot)
                    });
                    return successResponse(sdkMode);
                };
                RateLimiter.release = (...args) => {
                    refunds.push(args);
                };
                const originalUpdate = context.globalState.update;
                const tracked = trackedCancellation();
                const observed = { grants: 0, handle };
                const settled = RetryProvider.run(
                    sdkMode,
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
                        namesStarted.promise,
                        settled.then(() => {
                            throw new Error('Name metadata boundary was not reached');
                        })
                    ]);
                    assert.equal(capturedAttempt, false);
                    assert.deepEqual(bindings, []);
                    if (switching) {
                        if (scenario === 'visible-before-notification') {
                            context.globalState.update = async (key: string, value: unknown) => {
                                if (key === `configSets.autoSwitch.${slot}`) {
                                    modeStored.resolve();
                                    await storageGate.promise;
                                }
                                await originalUpdate.call(context.globalState, key, value);
                            };
                        }
                        modeChange = ConfigSetStore.setSwitchMode(slot, 'failover').then(() => {
                            ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                        });
                        if (scenario === 'completed-notification') {
                            await modeChange;
                        } else {
                            await Promise.race([
                                modeStored.promise,
                                modeChange.then(() => {
                                    throw new Error('Mode storage boundary was not reached');
                                })
                            ]);
                        }
                    } else {
                        if (scenario.endsWith('after-authority')) {
                            LeaderElectionService.getAuthorityTerm = () => 'pre-dispatch-leader:2';
                            InterInstanceBus.getAuthorityTerm = () => 'pre-dispatch-leader:2';
                            ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                        }
                        if (scenario === 'stale-event' || scenario === 'stale-event-after-authority') {
                            deliverMode(timestamp - 1, 'off');
                        } else if (scenario === 'duplicate-event-after-authority') {
                            deliverMode(timestamp, 'failover');
                        } else if (scenario === 'new-event-after-authority') {
                            await ConfigSetStore.setSwitchMode(slot, 'off');
                            await ConfigSetStore.setSwitchMode(slot, 'failover');
                            deliverMode(timestamp + 1, 'failover');
                        } else if (scenario === 'other-slot-event-after-authority') {
                            deliverMode(timestamp + 1, 'failover', `${slot}-other`);
                        }
                    }
                    assert.equal(ConfigSetStore.getSwitchMode(slot), scenario === 'remain-off' ? 'off' : 'failover');
                    namesGate.resolve();
                    const result = await settled;
                    await Promise.allSettled(reads);
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    const shouldReject = switching || scenario === 'new-event-after-authority';
                    assert.deepEqual(
                        bindings,
                        shouldReject ? [] : [scenario === 'remain-off' ? 'key-a' : 'outside-key']
                    );
                    if (shouldReject) {
                        assert.deepEqual(wires, []);
                        assert.ok(
                            result.state === 'rejected' &&
                                result.error instanceof Error &&
                                /Configuration changed while capturing/.test(result.error.message)
                        );
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    } else {
                        assert.equal(result.state, 'resolved');
                        assert.deepEqual(wires, [
                            {
                                authorization: scenario === 'remain-off' ? 'Bearer key-a' : 'Bearer outside-key',
                                mode: scenario === 'remain-off' ? 'off' : 'failover'
                            }
                        ]);
                        assert.deepEqual(refunds, [[handle]]);
                    }
                    if (scenario !== 'completed-notification') {
                        assert.equal(
                            ApiKeyFailoverManager.getSwitchModeGeneration(slot),
                            initialGeneration + (scenario === 'new-event-after-authority' ? 1 : 0)
                        );
                    }
                } finally {
                    storageGate.resolve();
                    namesGate.resolve();
                    await modeChange;
                    await settled;
                    await Promise.allSettled(reads);
                    context.globalState.update = originalUpdate;
                    tracked.dispose();
                }
            });
        }

        for (const finalMode of ['off', 'balance'] as const) {
            test(`${sdkMode}: mode change during metadata preserves ${finalMode} allocation rules`, async () => {
                LeaderElectionService.isInitialized = () => true;
                const sent = deferred();
                InterInstanceBus.publishIpcOnly = event => {
                    if (event.type === 'apiKeyBalanceAssignmentRequested') {
                        sent.resolve();
                    }
                    return true;
                };
                const tracked = trackedCancellation();
                const gate = deferred();
                const namesStarted = deferred();
                const reads: Array<Promise<string | undefined>> = [];
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
                let capturedAttempt = false;
                let validations = 0;
                const authorizations: Array<string | null> = [];
                const wireModes: string[] = [];
                ApiKeyFailoverManager.captureAttempt = async (...args) => {
                    const attempt = await originalCapture.apply(ApiKeyFailoverManager, args);
                    capturedAttempt = !!attempt;
                    return attempt;
                };
                ApiKeyFailoverManager.validateBalanceFallback = async (...args) => {
                    validations++;
                    return originalValidate.apply(ApiKeyFailoverManager, args);
                };
                ConfigSetStore.getApiKey = (...args) => {
                    const read = (async () => {
                        namesStarted.resolve();
                        await gate.promise;
                        return originalGetSaved.apply(ConfigSetStore, args);
                    })();
                    reads.push(read);
                    return read;
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    wireModes.push(ConfigSetStore.getSwitchMode(slot));
                    return successResponse(sdkMode);
                };
                const observed = { grants: 0, handle };
                const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token, [], randomUUID());
                const settled = pending.then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                try {
                    await Promise.race([
                        sent.promise,
                        settled.then(() => {
                            throw new Error('No balance assignment was requested');
                        })
                    ]);
                    await ConfigSetStore.setSwitchMode(slot, 'off');
                    ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    await Promise.race([
                        namesStarted.promise,
                        settled.then(() => {
                            throw new Error('Provider did not reach name metadata');
                        })
                    ]);
                    for (const id of ['a', 'b']) {
                        await ConfigSetStore.updateMeta(slot, id, { balanceWeight: 0 });
                    }
                    if (finalMode === 'balance') {
                        await ConfigSetStore.setSwitchMode(slot, 'balance');
                        ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                    }
                    gate.resolve();
                    const result = await settled;
                    assert.equal(capturedAttempt, false);
                    assert.equal(validations, 0);
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    if (finalMode === 'off') {
                        assert.equal(result.state, 'resolved');
                        assert.deepEqual(authorizations, ['Bearer key-a']);
                        assert.deepEqual(wireModes, ['off']);
                        assert.deepEqual(refunds, [[handle]]);
                    } else {
                        assert.deepEqual(authorizations, []);
                        assert.deepEqual(wireModes, []);
                        assert.ok(
                            result.state === 'rejected' &&
                                result.error instanceof Error &&
                                /Configuration changed while capturing/.test(result.error.message)
                        );
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
    }
});
