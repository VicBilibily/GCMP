import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { enqueueConfigSetMutation } from '../../../../src/utils/config/configSetCommands';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import {
    RetryProvider,
    balanceKey,
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

async function beforeGate<T>(settled: Promise<T>): Promise<T | { state: 'pending' }> {
    return Promise.race([
        settled,
        new Promise<{ state: 'pending' }>(resolve => {
            setImmediate(() => setImmediate(() => resolve({ state: 'pending' })));
        })
    ]);
}

suite('failover capture cancellation', () => {
    const originalSaved = ConfigSetStore.getApiKey;
    const originalPrimary = ApiKeyManager.getApiKey;
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    const originalPublish = InterInstanceBus.publish;
    let context: vscode.ExtensionContext;

    setup(async () => {
        InterInstanceBus.publish = () => {};
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'a', balanceWeight: 1 }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', balanceWeight: 1 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'failover');
    });

    teardown(() => {
        ConfigSetStore.getApiKey = originalSaved;
        ApiKeyManager.getApiKey = originalPrimary;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        InterInstanceBus.publish = originalPublish;
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
    });

    for (const sdk of ['openai', 'openai-responses'] as const) {
        for (const source of ['primary', 'saved'] as const) {
            for (const ending of ['normal', 'failure', 'cancel-resolve', 'cancel-reject'] as const) {
                test(`${sdk}: ${source} lookup ${ending}`, async () => {
                    const tracked = trackedCancellation();
                    const gate = deferred();
                    const reached = deferred();
                    const reads: Array<Promise<string | undefined>> = [];
                    const lookupError = new Error('Failover secret lookup failed');
                    const lookup = (readKey: () => Promise<string | undefined>) => {
                        const read = (async () => {
                            reached.resolve();
                            await gate.promise;
                            if (ending === 'failure' || ending === 'cancel-reject') {
                                throw lookupError;
                            }
                            return readKey();
                        })();
                        reads.push(read);
                        return read;
                    };
                    if (source === 'primary') {
                        ApiKeyManager.getApiKey = (...args) => lookup(() => originalPrimary.apply(ApiKeyManager, args));
                    } else {
                        ConfigSetStore.getApiKey = (...args) => lookup(() => originalSaved.apply(ConfigSetStore, args));
                    }
                    const handle: RateLimitHandle = {
                        grantId: randomUUID(),
                        costs: { requests: 1, tokens: 50 },
                        leaseMs: 30_000,
                        authoritative: true,
                        authorityTerm: 'failover-capture:1'
                    };
                    const observed = { grants: 0, handle };
                    const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                    const wires: Array<string | null> = [];
                    RateLimiter.release = (...args) => {
                        refunds.push(args);
                    };
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        wires.push(new Request(input, init).headers.get('authorization'));
                        return successResponse(sdk);
                    };
                    const settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token).then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    let queued: Promise<{ state: 'queue-free' }> | undefined;
                    try {
                        await Promise.race([
                            reached.promise,
                            settled.then(() => {
                                throw new Error('Secret lookup did not start');
                            })
                        ]);
                        const cancelled = ending.startsWith('cancel-');
                        if (cancelled) {
                            tracked.cancel();
                        }
                        const early = await beforeGate(settled);
                        queued = enqueueConfigSetMutation(async () => ({ state: 'queue-free' as const }));
                        const queueEarly = await beforeGate(queued);
                        if (cancelled) {
                            assert.ok(early.state === 'rejected' && early.error instanceof vscode.CancellationError);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                            assert.equal(queueEarly.state, 'queue-free');
                        } else {
                            assert.equal(early.state, 'pending');
                            assert.equal(queueEarly.state, 'pending');
                            assert.deepEqual(refunds, []);
                        }
                        gate.resolve();
                        const result = await settled;
                        await Promise.allSettled([...reads, queued]);
                        assert.equal(observed.grants, 1);
                        assert.equal(tracked.disposals, tracked.subscriptions);
                        if (ending === 'normal') {
                            assert.equal(result.state, 'resolved');
                            assert.deepEqual(wires, ['Bearer key-a']);
                            assert.deepEqual(refunds, [[handle]]);
                        } else {
                            assert.ok(result.state === 'rejected');
                            if (cancelled) {
                                assert.ok(result.error instanceof vscode.CancellationError);
                            } else {
                                assert.equal(result.error, lookupError);
                            }
                            assert.deepEqual(wires, []);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                        }
                    } finally {
                        gate.resolve();
                        await Promise.allSettled([settled, ...reads, ...(queued ? [queued] : [])]);
                        tracked.dispose();
                    }
                });
            }
        }

        for (const ending of ['normal', 'cancel'] as const) {
            test(`${sdk}: queued capture ${ending} does not interfere with the earlier mutation`, async () => {
                const gate = deferred();
                const entered = deferred();
                const captureStarted = deferred();
                let mutationFinished = false;
                let keyReads = 0;
                const blocker = enqueueConfigSetMutation(async () => {
                    entered.resolve();
                    await gate.promise;
                    mutationFinished = true;
                });
                await entered.promise;
                ApiKeyFailoverManager.captureAttempt = (...args) => {
                    captureStarted.resolve();
                    return originalCapture.apply(ApiKeyFailoverManager, args);
                };
                ApiKeyManager.getApiKey = (...args) => {
                    keyReads++;
                    return originalPrimary.apply(ApiKeyManager, args);
                };
                ConfigSetStore.getApiKey = (...args) => {
                    keyReads++;
                    return originalSaved.apply(ConfigSetStore, args);
                };
                const tracked = trackedCancellation();
                const handle: RateLimitHandle = {
                    grantId: randomUUID(),
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: 'failover-capture:1'
                };
                const observed = { grants: 0, handle };
                const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                const wires: Array<string | null> = [];
                RateLimiter.release = (...args) => {
                    refunds.push(args);
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    wires.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdk);
                };
                const settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token).then(
                    () => ({ state: 'resolved' as const }),
                    (error: unknown) => ({ state: 'rejected' as const, error })
                );
                let queued: Promise<{ state: 'queue-free' }> | undefined;
                try {
                    await Promise.race([
                        captureStarted.promise,
                        settled.then(() => {
                            throw new Error('Capture did not start');
                        })
                    ]);
                    if (ending === 'cancel') {
                        tracked.cancel();
                    }
                    const early = await beforeGate(settled);
                    assert.equal(mutationFinished, false);
                    assert.equal(keyReads, 0);
                    queued = enqueueConfigSetMutation(async () => ({ state: 'queue-free' as const }));
                    assert.equal((await beforeGate(queued)).state, 'pending');
                    if (ending === 'cancel') {
                        assert.ok(early.state === 'rejected' && early.error instanceof vscode.CancellationError);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    } else {
                        assert.equal(early.state, 'pending');
                        assert.deepEqual(refunds, []);
                    }
                    gate.resolve();
                    const result = await settled;
                    await Promise.all([blocker, queued]);
                    assert.equal(mutationFinished, true);
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    if (ending === 'cancel') {
                        assert.ok(result.state === 'rejected' && result.error instanceof vscode.CancellationError);
                        assert.equal(keyReads, 0);
                        assert.deepEqual(wires, []);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    } else {
                        assert.equal(result.state, 'resolved');
                        assert.equal(keyReads, 3);
                        assert.deepEqual(wires, ['Bearer key-a']);
                        assert.deepEqual(refunds, [[handle]]);
                    }
                } finally {
                    gate.resolve();
                    await Promise.allSettled([settled, blocker, ...(queued ? [queued] : [])]);
                    tracked.dispose();
                }
            });
        }
    }

    for (const phase of ['pre-cancelled', 'subscription'] as const) {
        test(`${phase} cancellation never starts failover key reads`, async () => {
            const tracked = trackedCancellation(phase === 'subscription');
            let keyReads = 0;
            ApiKeyManager.getApiKey = async () => {
                keyReads++;
                return 'key-a';
            };
            ConfigSetStore.getApiKey = async () => {
                keyReads++;
                return 'key-a';
            };
            if (phase === 'pre-cancelled') {
                tracked.cancel();
            }
            let attempt: Awaited<ReturnType<typeof ApiKeyFailoverManager.captureAttempt>>;
            try {
                attempt = await ApiKeyFailoverManager.captureAttempt(
                    slot,
                    balanceKey,
                    randomUUID(),
                    undefined,
                    tracked.token
                );
                assert.equal(attempt, undefined);
                assert.equal(keyReads, 0);
                assert.equal(tracked.subscriptions, phase === 'pre-cancelled' ? 0 : 1);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }
});
