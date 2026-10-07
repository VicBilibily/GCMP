import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt
} from '../../../../src/utils/config/failover/apiKeyFailoverManager';
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

suite('configuration pool snapshot consistency', () => {
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
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalExport = ApiKeyFailoverManager.exportBalanceLeaseHandoff;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    let context: vscode.ExtensionContext;
    let leader: boolean;
    let initialized: boolean;
    let term: string;
    let createdLeases: Set<string>;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        leader = false;
        initialized = true;
        term = `pool-snapshot:${randomUUID()}`;
        createdLeases = new Set();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-pool-snapshot-')));
        Object.assign(LeaderElectionService, {
            isInitialized: () => initialized,
            isLeader: () => leader,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => (leader ? term : undefined),
            getAuthorityTerm: () => term,
            getInstanceId: () => 'pool-snapshot-instance'
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => true,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => false,
            publish: () => {}
        });
        ApiKeyFailoverManager.exportBalanceLeaseHandoff = (...args) => {
            const snapshot = originalExport.apply(ApiKeyFailoverManager, args);
            for (const lease of snapshot?.leases ?? []) {
                createdLeases.add(lease.leaseId);
            }
            return snapshot;
        };
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'a', balanceWeight: 1 }, 'key-old');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', balanceWeight: 0 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        ConfigSetStore.getApiKey = originalSaved;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ApiKeyFailoverManager.exportBalanceLeaseHandoff = originalExport;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        setBalanceHandoffDirectoryOverride(undefined);
    });

    for (const sdk of ['openai', 'openai-responses'] as const) {
        for (const source of ['failover', 'leader-balance', 'off', 'no-leader'] as const) {
            for (const scenario of ['in-flight-zero', 'in-flight-positive', 'prepared-zero'] as const) {
                test(`${sdk}: ${source} ${scenario}`, async () => {
                    const mode = source === 'leader-balance' || source === 'no-leader' ? 'balance' : source;
                    const runtimeKey = scenario === 'prepared-zero' ? 'key-old' : 'key-new';
                    await ApiKeyManager.setApiKey(slot, runtimeKey);
                    await ConfigSetStore.setSwitchMode(slot, mode);
                    leader = source === 'leader-balance';
                    initialized = source !== 'no-leader';
                    if (leader) {
                        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
                    }
                    const originalUpdate = context.globalState.update;
                    const originalStore = context.secrets.store;
                    const writing = deferred();
                    const commit = deferred();
                    const reached = deferred();
                    const gate = deferred();
                    const reads: Array<Promise<string | undefined>> = [];
                    const persistedStates: Array<{
                        phase: 'metadata' | 'secret';
                        key: string | undefined;
                        weight: number | undefined;
                    }> = [];
                    const wires: Array<string | null> = [];
                    const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                    let attempt: ApiKeyFailoverAttempt | undefined;
                    let captureFinished = false;
                    const positiveAfterWrite = scenario === 'in-flight-positive';
                    context.globalState.update = async (key: string, value: unknown) => {
                        if (key === `configSets.items.${slot}`) {
                            writing.resolve();
                            await commit.promise;
                        }
                        await originalUpdate.call(context.globalState, key, value);
                        if (key === `configSets.items.${slot}`) {
                            persistedStates.push({
                                phase: 'metadata',
                                key: await context.secrets.get(`configSet.${slot}.a`),
                                weight: ConfigSetStore.list(slot).find(item => item.id === 'a')?.balanceWeight
                            });
                        }
                    };
                    context.secrets.store = async (key, value) => {
                        await originalStore.call(context.secrets, key, value);
                        if (key === `configSet.${slot}.a`) {
                            persistedStates.push({
                                phase: 'secret',
                                key: value,
                                weight: ConfigSetStore.list(slot).find(item => item.id === 'a')?.balanceWeight
                            });
                        }
                    };
                    ConfigSetStore.getApiKey = (...args) => {
                        const read = (async () => {
                            if (scenario !== 'prepared-zero' || source === 'off' || source === 'no-leader') {
                                reached.resolve();
                                await gate.promise;
                            }
                            return originalSaved.apply(ConfigSetStore, args);
                        })();
                        reads.push(read);
                        return read;
                    };
                    ApiKeyFailoverManager.captureAttempt = async (...args) => {
                        attempt = await originalCapture.apply(ApiKeyFailoverManager, args);
                        captureFinished = true;
                        if (scenario === 'prepared-zero' && (source === 'failover' || source === 'leader-balance')) {
                            reached.resolve();
                            await gate.promise;
                        }
                        return attempt;
                    };
                    ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                        wires.push(new Request(input, init).headers.get('authorization'));
                        return successResponse(sdk);
                    };
                    RateLimiter.release = (...args) => {
                        refunds.push(args);
                    };
                    const handle: RateLimitHandle = {
                        grantId: randomUUID(),
                        costs: { requests: 1, tokens: 50 },
                        leaseMs: 30_000,
                        authoritative: true,
                        authorityTerm: term
                    };
                    const observed = { grants: 0, handle };
                    const tracked = trackedCancellation();
                    const previousOperation = ConfigSetStore.getApplyOperationToken(slot);
                    const write = ConfigSetStore.writeAll(
                        slot,
                        [
                            { id: 'a', label: 'a', balanceWeight: positiveAfterWrite ? 1 : 0 },
                            { id: 'b', label: 'b', balanceWeight: 0 }
                        ],
                        { a: runtimeKey, b: 'key-b' },
                        'a'
                    );
                    let settled: Promise<{ state: 'resolved' } | { state: 'rejected'; error: unknown }> | undefined;
                    try {
                        await Promise.race([
                            writing.promise,
                            write.then(() => {
                                throw new Error('Write boundary was not reached');
                            })
                        ]);
                        const operation = ConfigSetStore.getApplyOperationToken(slot);
                        assert.notEqual(operation, previousOperation);
                        assert.equal(ConfigSetStore.list(slot).find(item => item.id === 'a')?.balanceWeight, 1);
                        assert.equal(await context.secrets.get(`configSet.${slot}.a`), 'key-old');
                        settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token, [], randomUUID()).then(
                            () => ({ state: 'resolved' as const }),
                            (error: unknown) => ({ state: 'rejected' as const, error })
                        );
                        await Promise.race([
                            reached.promise,
                            settled.then(() => {
                                throw new Error('Capture boundary was not reached');
                            })
                        ]);
                        if (source === 'failover' || source === 'leader-balance') {
                            assert.equal(captureFinished, scenario === 'prepared-zero');
                        }
                        commit.resolve();
                        await write;
                        assert.equal(ConfigSetStore.getApplyOperationToken(slot), operation);
                        assert.deepEqual(persistedStates, [
                            { phase: 'metadata', key: 'key-old', weight: positiveAfterWrite ? 1 : 0 },
                            { phase: 'secret', key: runtimeKey, weight: positiveAfterWrite ? 1 : 0 }
                        ]);
                        gate.resolve();
                        const result = await settled;
                        await Promise.allSettled(reads);
                        assert.equal(observed.grants, 1);
                        assert.equal(tracked.disposals, tracked.subscriptions);
                        if (scenario === 'in-flight-zero' && (source === 'failover' || source === 'leader-balance')) {
                            assert.deepEqual(wires, []);
                            assert.ok(result.state === 'rejected' && result.error instanceof Error);
                            assert.match(result.error.message, /Configuration changed while capturing/);
                            assert.equal(attempt, undefined);
                            assert.equal(createdLeases.size, 0);
                            assert.deepEqual(refunds, [[handle, handle.costs]]);
                        } else {
                            assert.equal(result.state, 'resolved');
                            assert.deepEqual(wires, [`Bearer ${runtimeKey}`]);
                            assert.deepEqual(refunds, [[handle]]);
                            assert.equal(createdLeases.size, leader ? 1 : 0);
                            if (source === 'failover' || source === 'leader-balance') {
                                assert.equal(attempt?.apiKey, runtimeKey);
                            }
                        }
                    } finally {
                        commit.resolve();
                        gate.resolve();
                        await Promise.allSettled([write, ...(settled ? [settled] : []), ...reads]);
                        context.globalState.update = originalUpdate;
                        context.secrets.store = originalStore;
                        tracked.dispose();
                    }
                });
            }
        }
    }
});
