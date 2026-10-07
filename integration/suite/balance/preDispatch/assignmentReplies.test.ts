import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../../src/interInstance/activation';
import type {
    ApiKeyBalanceAssignmentResolvedEvent,
    InterInstanceEventBase
} from '../../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../../src/utils/config/failover/balanceAffinityCache';
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

suite('balance assignment rejection replies', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        isAgentsWindow: LeaderElectionService.isAgentsWindow,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
        getLeaderId: LeaderElectionService.getLeaderId,
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
    const originalHandle = ApiKeyFailoverManager.handleBalanceAssignmentRequest;
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    const manager = ApiKeyFailoverManager as unknown as {
        balanceLeases: Map<string, unknown>;
        pendingBalanceAssignments: Map<string, unknown>;
        balanceAttemptSnapshots: Map<string, unknown>;
        balanceLeaseRenewalTimers: Map<string, unknown>;
    };
    let context: vscode.ExtensionContext;
    let leader: boolean;
    let transport: boolean;
    let term: string;
    let replies: ApiKeyBalanceAssignmentResolvedEvent['payload'][];
    let leaderErrors: unknown[];
    let operations: Promise<unknown>[];
    let reads: Array<Promise<string | undefined>>;
    let requested: ReturnType<typeof deferred>;

    function deliver(event: InterInstanceEventBase) {
        const bus = InterInstanceBus as unknown as {
            handlers: Map<string, Set<(event: InterInstanceEventBase) => void>>;
        };
        const handlers = bus.handlers.get(event.type);
        assert.ok(handlers?.size);
        for (const callback of handlers) {
            callback(event);
        }
    }

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        leader = true;
        transport = true;
        term = `assignment-reply:${randomUUID()}`;
        replies = [];
        leaderErrors = [];
        operations = [];
        reads = [];
        requested = deferred();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-assignment-reply-')));
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => leader,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => (leader ? term : undefined),
            getAuthorityTerm: () => term,
            getLeaderId: () => 'assignment-reply-leader',
            getInstanceId: () => (leader ? 'assignment-reply-leader' : 'assignment-reply-follower')
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => term,
            hasActiveTransport: () => transport,
            isAuthorityTransitioning: () => false,
            publish: () => {},
            publishIpcOnly: () => true
        });
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'a', balanceWeight: 1 }, 'key-old');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', balanceWeight: 0 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-new');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
        registerInterInstanceHandlers(context);
        ApiKeyFailoverManager.handleBalanceAssignmentRequest = (...args) => {
            const operation = originalHandle.apply(ApiKeyFailoverManager, args).catch((error: unknown) => {
                leaderErrors.push(error);
                leader = false;
                throw error;
            });
            operations.push(operation);
            return operation;
        };
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                leader = true;
                deliver({ ...event, timestamp: Date.now(), senderInstanceId: 'assignment-reply-follower' });
                requested.resolve();
            } else if (event.type === 'apiKeyBalanceAssignmentResolved') {
                replies.push(event.payload as ApiKeyBalanceAssignmentResolvedEvent['payload']);
                leader = false;
                deliver({ ...event, timestamp: Date.now(), senderInstanceId: 'assignment-reply-leader' });
            }
            return true;
        };
    });

    teardown(async () => {
        await Promise.allSettled([...operations, ...reads]);
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        ConfigSetStore.getApiKey = originalSaved;
        ApiKeyFailoverManager.handleBalanceAssignmentRequest = originalHandle;
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        setBalanceHandoffDirectoryOverride(undefined);
    });

    for (const sdk of ['openai', 'openai-responses'] as const) {
        for (const scenario of [
            'inflight-zero',
            'committed-zero',
            'positive',
            'saved-key-failure',
            'reused-read-failure',
            'reused-zero-lease'
        ] as const) {
            test(`${sdk}: ${scenario} replies without waiting for assignment timeout`, async () => {
                const writing = deferred();
                const commit = deferred();
                const reached = deferred();
                const gate = deferred();
                const originalUpdate = context.globalState.update;
                const tracked = trackedCancellation();
                const handle: RateLimitHandle = {
                    grantId: randomUUID(),
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: term
                };
                const observed = { grants: 0, handle };
                const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                const wires: Array<string | null> = [];
                let write: Promise<void> | undefined;
                let settled: Promise<{ state: 'resolved' } | { state: 'rejected'; error: unknown }> | undefined;
                let existingLeaseId: string | undefined;
                const inFlight = scenario === 'inflight-zero' || scenario === 'positive';
                RateLimiter.release = (...args) => {
                    refunds.push(args);
                };
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    wires.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdk);
                };
                try {
                    if (scenario.startsWith('reused-')) {
                        await ApiKeyManager.setApiKey(slot, 'key-old');
                        const requestId = randomUUID();
                        const initial = await originalHandle.call(
                            ApiKeyFailoverManager,
                            {
                                requestId,
                                requestedBy: 'assignment-reply-follower',
                                authorityTerm: term,
                                slot,
                                balanceKey
                            },
                            'assignment-reply-follower'
                        );
                        assert.ok(initial?.leaseId);
                        existingLeaseId = initial.leaseId;
                        await ConfigSetStore.updateMeta(slot, 'a', { balanceWeight: 0 });
                        ApiKeyFailoverManager.captureAttempt = (...args) =>
                            originalCapture.call(
                                ApiKeyFailoverManager,
                                args[0],
                                args[1],
                                requestId,
                                args[3],
                                args[4],
                                args[5]
                            );
                    } else if (scenario === 'committed-zero') {
                        await ConfigSetStore.writeAll(
                            slot,
                            [{ id: 'a', label: 'a', balanceWeight: 0 }],
                            { a: 'key-new' },
                            'a'
                        );
                    }
                    if (inFlight) {
                        context.globalState.update = async (key: string, value: unknown) => {
                            if (key === `configSets.items.${slot}`) {
                                writing.resolve();
                                await commit.promise;
                            }
                            await originalUpdate.call(context.globalState, key, value);
                        };
                        ConfigSetStore.getApiKey = (...args) => {
                            const read = (async () => {
                                reached.resolve();
                                await gate.promise;
                                return originalSaved.apply(ConfigSetStore, args);
                            })();
                            reads.push(read);
                            return read;
                        };
                        write = ConfigSetStore.writeAll(
                            slot,
                            [
                                { id: 'a', label: 'a', balanceWeight: scenario === 'positive' ? 1 : 0 },
                                { id: 'b', label: 'b', balanceWeight: 0 }
                            ],
                            { a: 'key-new', b: 'key-b' },
                            'a'
                        );
                        await Promise.race([
                            writing.promise,
                            write.then(() => {
                                throw new Error('Write boundary was not reached');
                            })
                        ]);
                    } else if (scenario.endsWith('failure')) {
                        ConfigSetStore.getApiKey = async () => {
                            throw new Error('Assignment secret lookup failed');
                        };
                    }
                    const operation = ConfigSetStore.getApplyOperationToken(slot);
                    leader = false;
                    settled = RetryProvider.run(sdk, defaultRetry, observed, tracked.token).then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    await Promise.race([
                        requested.promise,
                        settled.then(() => {
                            throw new Error('Assignment was not requested');
                        })
                    ]);
                    if (inFlight) {
                        await Promise.race([
                            reached.promise,
                            settled.then(() => {
                                throw new Error('Pool boundary was not reached');
                            })
                        ]);
                        assert.equal(ConfigSetStore.list(slot)[0]?.balanceWeight, 1);
                        assert.equal(await context.secrets.get(`configSet.${slot}.a`), 'key-old');
                        commit.resolve();
                        await write;
                        assert.equal(ConfigSetStore.getApplyOperationToken(slot), operation);
                        assert.equal(ConfigSetStore.list(slot)[0]?.balanceWeight, scenario === 'positive' ? 1 : 0);
                        assert.equal(await context.secrets.get(`configSet.${slot}.a`), 'key-new');
                        gate.resolve();
                    }
                    await Promise.allSettled(operations);
                    await new Promise<void>(resolve => setImmediate(resolve));
                    assert.equal(replies.length, 1, 'Every processed allocation must send a resolution');
                    assert.deepEqual(leaderErrors, []);
                    const result = await settled;
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    assert.equal(manager.pendingBalanceAssignments.size, 0);
                    assert.equal(manager.balanceAttemptSnapshots.size, 0);
                    assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                    if (scenario === 'positive' || scenario === 'reused-zero-lease') {
                        assert.equal(result.state, 'resolved');
                        assert.equal(replies[0]?.handled, true);
                        assert.deepEqual(wires, [`Bearer ${existingLeaseId ? 'key-old' : 'key-new'}`]);
                        assert.deepEqual(refunds, [[handle]]);
                        if (existingLeaseId) {
                            assert.equal(replies[0]?.leaseId, existingLeaseId);
                        }
                    } else {
                        assert.ok(result.state === 'rejected' && result.error instanceof Error);
                        assert.match(result.error.message, /Configuration changed while capturing|No positive-weight/);
                        assert.equal(replies[0]?.handled, false);
                        assert.equal(replies[0]?.leaseId, undefined);
                        assert.equal(manager.balanceLeases.size, existingLeaseId ? 1 : 0);
                        assert.equal(
                            scenario === 'committed-zero' ?
                                replies[0]?.weightBlocked
                            :   replies[0]?.assignmentInvalidated,
                            true
                        );
                        assert.deepEqual(wires, []);
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    }
                } finally {
                    tracked.cancel();
                    commit.resolve();
                    gate.resolve();
                    await Promise.allSettled([
                        ...(write ? [write] : []),
                        ...(settled ? [settled] : []),
                        ...operations,
                        ...reads
                    ]);
                    context.globalState.update = originalUpdate;
                    tracked.dispose();
                }
            });
        }

        for (const source of ['off', 'no-leader'] as const) {
            test(`${sdk}: zero-weight ${source} is still allowed`, async () => {
                leader = false;
                transport = source !== 'no-leader';
                await ConfigSetStore.writeAll(slot, [{ id: 'a', label: 'a', balanceWeight: 0 }], { a: 'key-new' }, 'a');
                await ConfigSetStore.setSwitchMode(slot, source === 'off' ? 'off' : 'balance');
                const wires: Array<string | null> = [];
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    wires.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdk);
                };
                const tracked = trackedCancellation();
                try {
                    await RetryProvider.run(sdk, defaultRetry, { grants: 0 }, tracked.token);
                    assert.deepEqual(wires, ['Bearer key-new']);
                    assert.equal(replies.length, 0);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                } finally {
                    tracked.dispose();
                }
            });
        }
    }
});
