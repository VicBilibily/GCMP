import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../src/interInstance/activation';
import type { ApiKeyBalanceLeaseHandoff, LeaderResigningEvent } from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../src/rateLimit/rateLimiter';
import { RateLimitStore, type RateLimitStoreSnapshot } from '../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { readBalanceLeaseHandoff } from '../../../src/utils/config/failover/balanceLeaseHandoffFile';
import { setCrossInstanceBroadcaster } from '../../../src/handlers/liveMetrics';
import { AtomicJsonFile } from '../../../src/usages/atomicJsonFile';

type ResignationResult = 'resigned' | 'not-leader' | 'no-follower';

interface ElectionInternals {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    electionPausedUntil: number;
    resignationPromise: Promise<ResignationResult> | undefined;
    lastLeaderIdentityKey: string | undefined;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
    rateLimitSnapshotValidator: ((snapshot: RateLimitStoreSnapshot | undefined) => boolean) | undefined;
    balanceLeaseSnapshotProvider: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[0];
    balanceLeaseSnapshotValidator: ((snapshot: ApiKeyBalanceLeaseHandoff | undefined) => boolean) | undefined;
}

interface LimiterInternals {
    initialized: boolean;
    leaderStore: RateLimitStore;
    persistLeaderHandoffSnapshot: (
        leaderId: string,
        snapshot: RateLimitStoreSnapshot,
        receivedAt?: number,
        options?: { force?: boolean; strict?: boolean }
    ) => Promise<void>;
    sweep: () => void;
}

interface BalanceInternals {
    balanceLeases: Map<string, ApiKeyBalanceLeaseHandoff['leases'][number] & { authorityTerm: string }>;
    balanceAuthorityReady: Promise<void> | undefined;
    balanceResigningTerm: string | undefined;
    persistBalanceLeases: (expectedAuthorityTerm?: string, strict?: boolean) => Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Manual resignation rate-limit boundary', () => {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const limiter = RateLimiter as unknown as LimiterInternals;
    const originalNow = Date.now;
    const originalFollowers = InterInstanceBus.getConnectedFollowerIds;
    const originalEligibleFollowers = InterInstanceBus.getEligibleFollowerIds;
    const originalPublish = InterInstanceBus.publishIpcOnly;
    const originalProviderLimit = ConfigManager.getProviderRateLimitConfig;
    const originalPersist = limiter.persistLeaderHandoffSnapshot;
    let previousElection: ElectionInternals;
    let previousStore: RateLimitStore;
    let context: vscode.ExtensionContext;
    let record: { instanceId: string; electedAt: number; lastHeartbeat: number } | undefined;
    let now: number;
    let followers: string[];
    let events: Array<Parameters<typeof InterInstanceBus.publishIpcOnly>[0]>;
    let persisted: RateLimitStoreSnapshot[];
    let started: ReturnType<typeof deferred>;
    let gate: ReturnType<typeof deferred>;
    let activeResignation: Promise<ResignationResult> | undefined;

    setup(() => {
        assert.equal(limiter.initialized, false);
        previousElection = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            electionPausedUntil: election.electionPausedUntil,
            resignationPromise: election.resignationPromise,
            lastLeaderIdentityKey: election.lastLeaderIdentityKey,
            rateLimitSnapshotProvider: election.rateLimitSnapshotProvider,
            rateLimitSnapshotValidator: election.rateLimitSnapshotValidator,
            balanceLeaseSnapshotProvider: election.balanceLeaseSnapshotProvider,
            balanceLeaseSnapshotValidator: election.balanceLeaseSnapshotValidator
        };
        previousStore = limiter.leaderStore;
        now = 100_000;
        record = { instanceId: 'leader-old', electedAt: now, lastHeartbeat: now };
        followers = ['follower-first'];
        events = [];
        persisted = [];
        started = deferred();
        gate = deferred();
        activeResignation = undefined;
        context = {
            subscriptions: [],
            globalState: {
                get: <T>(key: string): T => {
                    assert.equal(key, 'gcmp.leader.info.v2');
                    return record as T;
                },
                update: async (key: string, value: unknown) => {
                    assert.equal(key, 'gcmp.leader.info.v2');
                    record = value as typeof record;
                }
            }
        } as unknown as vscode.ExtensionContext;
        Object.assign(election, {
            context,
            instanceId: 'leader-old',
            initialized: true,
            agentsWindow: false,
            _isLeader: true,
            ownElectedAt: now,
            electionPausedUntil: 0,
            resignationPromise: undefined,
            lastLeaderIdentityKey: undefined,
            rateLimitSnapshotValidator: undefined,
            balanceLeaseSnapshotProvider: () => undefined,
            balanceLeaseSnapshotValidator: undefined
        });
        Date.now = () => now;
        InterInstanceBus.getConnectedFollowerIds = () => followers;
        InterInstanceBus.getEligibleFollowerIds = () => followers;
        InterInstanceBus.publishIpcOnly = event => {
            events.push(event);
            return true;
        };
        ConfigManager.getProviderRateLimitConfig = () => ({ parallel: 1 });
        limiter.leaderStore = new RateLimitStore('resignation-boundary');
        limiter.persistLeaderHandoffSnapshot = async (_leaderId, snapshot) => {
            persisted.push(structuredClone(snapshot));
            started.resolve();
            await gate.promise;
        };
        RateLimiter.initialize(context);
    });

    teardown(async () => {
        gate.resolve();
        await activeResignation?.catch(() => {});
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        limiter.leaderStore = previousStore;
        limiter.persistLeaderHandoffSnapshot = originalPersist;
        Object.assign(election, previousElection);
        Date.now = originalNow;
        InterInstanceBus.getConnectedFollowerIds = originalFollowers;
        InterInstanceBus.getEligibleFollowerIds = originalEligibleFollowers;
        InterInstanceBus.publishIpcOnly = originalPublish;
        ConfigManager.getProviderRateLimitConfig = originalProviderLimit;
        setCrossInstanceBroadcaster(undefined);
    });

    async function beginHandoff(): Promise<void> {
        activeResignation = LeaderElectionService.resignLeadership();
        await Promise.race([
            started.promise,
            activeResignation.then(() => {
                throw new Error('Persistence boundary was not reached');
            })
        ]);
    }

    function transferredSnapshot(): RateLimitStoreSnapshot {
        const event = events.find(item => item.type === 'leaderResigning') as
            | Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>
            | undefined;
        assert.ok(event?.payload.rateLimitSnapshot);
        return event.payload.rateLimitSnapshot;
    }

    test('a grant acquired before handoff is retained by the successor', async () => {
        const handle = await RateLimiter.acquire('bucket', { parallel: 1 }, { requests: 1, tokens: 1 });
        assert.ok(handle);
        await beginHandoff();
        gate.resolve();
        assert.equal(await activeResignation, 'resigned');
        assert.equal(transferredSnapshot().grants[0]?.grantId, handle.grantId);
        const successor = new RateLimitStore('successor');
        successor.importSnapshot(transferredSnapshot(), now);
        assert.equal(successor.acquire('next', 'bucket', { parallel: 1 }, handle.costs, now).kind, 'queued');
    });

    for (const { name, dims, waitMs } of [
        { name: 'RPM', dims: { rpm: 1 }, waitMs: 59_990 },
        { name: 'RPS', dims: { rps: 1 }, waitMs: 990 },
        { name: 'TPM', dims: { tpm: 1 }, waitMs: 59_990 }
    ] as const) {
        test(`manual handoff preserves spent ${name} after a completed request releases its grant`, async () => {
            ConfigManager.getProviderRateLimitConfig = () => ({ parallel: 1, ...dims });
            const costs = { requests: 1, tokens: 1 };
            const handle = await RateLimiter.acquire('bucket', { parallel: 1, ...dims }, costs);
            assert.ok(handle);
            RateLimiter.release(handle);
            now += 10;
            assert.equal(limiter.leaderStore.stats('bucket', now)?.waitMs, waitMs);
            await beginHandoff();
            gate.resolve();
            assert.equal(await activeResignation, 'resigned');
            const snapshot = transferredSnapshot();
            assert.deepEqual(snapshot.grants, []);
            assert.deepEqual(snapshot, persisted.at(-1));
            const successor = new RateLimitStore('successor');
            successor.importSnapshot(snapshot, now);
            const next = successor.acquire('next', 'bucket', { parallel: 1, ...dims }, costs, now);
            assert.equal(next.kind, 'granted');
            if (next.kind === 'granted') {
                assert.equal(next.waitMs, waitMs);
            }
        });
    }

    for (const scenario of ['empty', 'limit', 'overflow', 'ignored-leases', 'shutdown'] as const) {
        test(`balance handoff capacity boundary: ${scenario}`, async () => {
            const manager = ApiKeyFailoverManager as unknown as BalanceInternals;
            const previous = {
                leases: manager.balanceLeases,
                ready: manager.balanceAuthorityReady,
                resigning: manager.balanceResigningTerm,
                persistence: manager.persistBalanceLeases
            };
            const directory = mkdtempSync(join(tmpdir(), 'gcmp-balance-resignation-capacity-'));
            manager.balanceLeases = new Map();
            manager.balanceAuthorityReady = undefined;
            manager.persistBalanceLeases = (authorityTerm, strict) =>
                strict ? previous.persistence.call(ApiKeyFailoverManager, authorityTerm, strict) : Promise.resolve();
            const count = scenario === 'empty' ? 0 : 1000;
            const addLease = (index: number, expiresAt = now + 30_000, authorityTerm = 'leader-old:100000') => {
                const leaseId = `balance-${index}`;
                manager.balanceLeases.set(leaseId, {
                    leaseId,
                    slot: 'slot',
                    balanceKey: 'balance-key',
                    configId: 'config',
                    credentialId: 'a'.repeat(64),
                    site: 'test',
                    ownerInstanceId: 'follower-first',
                    authorityTerm,
                    expiresAt
                });
            };
            setBalanceHandoffDirectoryOverride(directory);
            try {
                for (let index = 0; index < count; index++) {
                    addLease(index);
                }
                await manager.persistBalanceLeases('leader-old:100000', true);
                const before = await readBalanceLeaseHandoff(directory, now);
                assert.equal(before?.leases.length, count);
                if (scenario === 'overflow' || scenario === 'shutdown') {
                    addLease(1000);
                } else if (scenario === 'ignored-leases') {
                    addLease(1000, now);
                    addLease(1001, now + 30_000, 'another-leader:100000');
                }
                registerInterInstanceHandlers(context);
                gate.resolve();
                if (scenario === 'shutdown') {
                    await LeaderElectionService.stop();
                    assert.equal(LeaderElectionService.isLeader(), false);
                    assert.equal(record, undefined);
                    assert.deepEqual(await readBalanceLeaseHandoff(directory, now), before);
                    return;
                }
                activeResignation = LeaderElectionService.resignLeadership();
                if (scenario === 'overflow') {
                    await assert.rejects(activeResignation, /balance.*1001.*1000/i);
                    assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'leader-old:100000');
                    assert.equal(election.electionPausedUntil, 0);
                    assert.equal(manager.balanceResigningTerm, undefined);
                    assert.deepEqual(events, []);
                    assert.deepEqual(await readBalanceLeaseHandoff(directory, now), before);
                    const handle = await RateLimiter.acquire('bucket', { parallel: 1 }, { requests: 1, tokens: 1 });
                    assert.ok(handle?.authoritative);
                    RateLimiter.release(handle);
                    manager.balanceLeases.delete('balance-1000');
                    activeResignation = LeaderElectionService.resignLeadership();
                }
                assert.equal(await activeResignation, 'resigned');
                const event = events.find(item => item.type === 'leaderResigning') as
                    | Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>
                    | undefined;
                assert.ok(event);
                assert.equal(event.payload.balanceLeaseSnapshot?.leases.length ?? 0, count);
                const saved = await readBalanceLeaseHandoff(directory, now);
                assert.ok(saved);
                assert.deepEqual(saved.leases, event.payload.balanceLeaseSnapshot?.leases ?? []);
            } finally {
                gate.resolve();
                await activeResignation?.catch(() => {});
                setBalanceHandoffDirectoryOverride(undefined);
                manager.balanceLeases = previous.leases;
                manager.balanceAuthorityReady = previous.ready;
                manager.balanceResigningTerm = previous.resigning;
                manager.persistBalanceLeases = previous.persistence;
            }
        });
    }

    test('granting is already frozen while the balance snapshot is still pending', async () => {
        const balanceStarted = deferred();
        const balanceGate = deferred();
        LeaderElectionService.setBalanceLeaseSnapshotProvider(async () => {
            balanceStarted.resolve();
            await balanceGate.promise;
            return undefined;
        });
        activeResignation = LeaderElectionService.resignLeadership();
        try {
            await balanceStarted.promise;
            RateLimiter.handleAcquireRequest(
                {
                    requestId: 'during-balance',
                    authorityTerm: 'leader-old:100000',
                    bucketKey: 'bucket',
                    costs: { requests: 1, tokens: 1 },
                    dims: { parallel: 1 }
                },
                'follower-first'
            );
            assert.equal(limiter.leaderStore.stats('bucket', now)?.pending, 1);
            assert.deepEqual(limiter.leaderStore.exportSnapshot(now).grants, []);
            balanceGate.resolve();
            await started.promise;
            gate.resolve();
            assert.equal(await activeResignation, 'resigned');
            assert.deepEqual(transferredSnapshot().grants, []);
        } finally {
            balanceGate.resolve();
            gate.resolve();
            await activeResignation;
        }
    });

    test('a local acquire remains queued during snapshot persistence and can be cancelled', async () => {
        await beginHandoff();
        const token = new vscode.CancellationTokenSource();
        const queued = deferred();
        let handle: RateLimitHandle | undefined;
        const acquiring = RateLimiter.acquire(
            'bucket',
            { parallel: 1 },
            { requests: 1, tokens: 1 },
            {
                token: token.token,
                onWaiting: () => queued.resolve()
            }
        ).then(value => {
            handle = value;
            return value;
        });
        const cancellation = assert.rejects(acquiring, error => error instanceof vscode.CancellationError);
        try {
            await Promise.race([
                queued.promise,
                acquiring.then(() => {
                    throw new Error('Acquire was granted during handoff');
                })
            ]);
            assert.equal(handle, undefined);
            assert.equal(limiter.leaderStore.stats('bucket', now)?.pending, 1);
            assert.equal(limiter.leaderStore.exportSnapshot(now).grants.length, 0);
        } finally {
            token.cancel();
            await cancellation;
            token.dispose();
            gate.resolve();
            await activeResignation;
        }
    });

    test('remote acquires are queued even when the old bucket is empty', async () => {
        await beginHandoff();
        RateLimiter.handleAcquireRequest(
            {
                requestId: 'during-handoff',
                authorityTerm: 'leader-old:100000',
                bucketKey: 'bucket',
                costs: { requests: 1, tokens: 1 },
                dims: { parallel: 1 }
            },
            'follower-first'
        );
        assert.equal(limiter.leaderStore.stats('bucket', now)?.pending, 1);
        assert.equal(limiter.leaderStore.exportSnapshot(now).grants.length, 0);
        limiter.sweep();
        assert.equal(limiter.leaderStore.exportSnapshot(now).grants.length, 0);
        gate.resolve();
        assert.equal(await activeResignation, 'resigned');
        assert.equal(transferredSnapshot().grants.length, 0);
        assert.deepEqual(
            transferredSnapshot().buckets.flatMap(bucket => bucket.pending),
            []
        );
    });

    for (const action of ['local-release', 'remote-release', 'cancel-granted', 'lease-renewal', 'expiry'] as const) {
        test(`persisted and broadcast state includes changes made while waiting: ${action}`, async () => {
            if (action === 'expiry') {
                limiter.leaderStore = new RateLimitStore('expiry-boundary', 100);
            }
            const handle = await RateLimiter.acquire('local', { parallel: 1 }, { requests: 1, tokens: 1 });
            assert.ok(handle);
            const remote = limiter.leaderStore.acquire(
                'remote-before',
                'remote',
                { parallel: 1 },
                { requests: 1, tokens: 1 },
                now,
                { ownerInstanceId: 'follower-first' }
            );
            assert.equal(remote.kind, 'granted');
            if (remote.kind !== 'granted') {
                return;
            }
            await beginHandoff();
            if (action === 'local-release') {
                RateLimiter.release(handle);
            } else if (action === 'remote-release') {
                RateLimiter.handleRemoteRelease(
                    { authorityTerm: 'leader-old:100000', grantId: remote.grantId },
                    'follower-first'
                );
            } else if (action === 'cancel-granted') {
                RateLimiter.handleRemoteAcquireCancelled(
                    {
                        authorityTerm: 'leader-old:100000',
                        bucketKey: 'remote',
                        requestId: 'remote-before'
                    },
                    'follower-first'
                );
            } else if (action === 'lease-renewal') {
                now += 1000;
                RateLimiter.handleRemoteLeaseRenewal(
                    { authorityTerm: 'leader-old:100000', grantId: remote.grantId },
                    'follower-first'
                );
            } else {
                now = Math.max(...persisted[0].grants.map(grant => grant.expiresAt)) + 1;
            }
            const expected = limiter.leaderStore.exportSnapshot(now);
            gate.resolve();
            assert.equal(await activeResignation, 'resigned');
            assert.deepEqual(transferredSnapshot(), expected);
            assert.deepEqual(persisted.at(-1), expected);
            assert.ok(persisted.length >= 2);
        });
    }

    test('a changed snapshot beyond the handoff deadline aborts without releasing authority', async () => {
        const remote = limiter.leaderStore.acquire(
            'remote-before',
            'remote',
            { parallel: 1 },
            { requests: 1, tokens: 1 },
            now,
            { ownerInstanceId: 'follower-first' }
        );
        assert.equal(remote.kind, 'granted');
        if (remote.kind !== 'granted') {
            return;
        }
        await beginHandoff();
        now += 30_001;
        RateLimiter.handleRemoteLeaseRenewal(
            {
                authorityTerm: 'leader-old:100000',
                grantId: remote.grantId
            },
            'follower-first'
        );
        const failure = assert.rejects(activeResignation!, /deadline/);
        gate.resolve();
        await failure;
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'leader-old:100000');
        assert.equal(election.electionPausedUntil, 0);
        assert.equal(
            events.some(event => event.type === 'leaderResigning'),
            false
        );
    });

    test('a release does not grant an existing waiter while handoff is frozen', async () => {
        const handle = await RateLimiter.acquire('bucket', { parallel: 1 }, { requests: 1, tokens: 1 });
        assert.ok(handle);
        RateLimiter.handleAcquireRequest(
            {
                requestId: 'queued-before',
                authorityTerm: 'leader-old:100000',
                bucketKey: 'bucket',
                costs: { requests: 1, tokens: 1 },
                dims: { parallel: 1 }
            },
            'follower-first'
        );
        await beginHandoff();
        RateLimiter.release(handle);
        limiter.sweep();
        assert.equal(limiter.leaderStore.stats('bucket', now)?.pending, 1);
        assert.equal(limiter.leaderStore.exportSnapshot(now).grants.length, 0);
        gate.resolve();
        assert.equal(await activeResignation, 'resigned');
        assert.equal(transferredSnapshot().grants.length, 0);
    });

    for (const action of ['local-release', 'remote-release', 'lease-renewal', 'expiry'] as const) {
        test(`the final publication boundary includes a late microtask change: ${action}`, async () => {
            if (action === 'expiry') {
                limiter.leaderStore = new RateLimitStore('final-boundary', 100);
            }
            const handle = await RateLimiter.acquire('local', { parallel: 1 }, { requests: 1, tokens: 0 });
            assert.ok(handle);
            const oldStore = limiter.leaderStore;
            const remote = oldStore.acquire(
                'remote-before',
                'remote',
                { parallel: 1 },
                { requests: 1, tokens: 0 },
                now,
                { ownerInstanceId: 'follower-first' }
            );
            assert.equal(remote.kind, 'granted');
            if (remote.kind !== 'granted') {
                return;
            }
            let stateAtPublication: RateLimitStoreSnapshot | undefined;
            let changedWhileLeader = false;
            InterInstanceBus.publishIpcOnly = event => {
                events.push(event);
                if (event.type === 'leaderResigning') {
                    stateAtPublication = oldStore.exportSnapshot(now);
                }
                return true;
            };
            await beginHandoff();
            const lateChange = gate.promise.then(() => {
                queueMicrotask(() => {
                    changedWhileLeader = LeaderElectionService.isLeader();
                    if (action === 'local-release') {
                        RateLimiter.release(handle);
                    } else if (action === 'remote-release') {
                        RateLimiter.handleRemoteRelease(
                            { authorityTerm: 'leader-old:100000', grantId: remote.grantId },
                            'follower-first'
                        );
                    } else if (action === 'lease-renewal') {
                        now += 1000;
                        RateLimiter.handleRemoteLeaseRenewal(
                            { authorityTerm: 'leader-old:100000', grantId: remote.grantId },
                            'follower-first'
                        );
                    } else {
                        now = Math.max(...persisted[0].grants.map(grant => grant.expiresAt)) + 1;
                    }
                });
            });
            gate.resolve();
            assert.equal(await activeResignation, 'resigned');
            await lateChange;
            assert.equal(changedWhileLeader, true);
            assert.deepEqual(transferredSnapshot(), stateAtPublication);
            assert.deepEqual(persisted.at(-1), stateAtPublication);
            assert.ok(persisted.length >= 2);
        });
    }

    for (const failure of ['rate-limit', 'balance'] as const) {
        test(`actual ${failure} storage rejection preserves leadership and restores balance`, async () => {
            const originalExclusive = AtomicJsonFile.runExclusive;
            const manager = ApiKeyFailoverManager as unknown as BalanceInternals;
            let failures = 0;
            try {
                registerInterInstanceHandlers(context);
                if (failure === 'rate-limit') {
                    LeaderElectionService.setBalanceLeaseSnapshotProvider(() => undefined);
                    limiter.persistLeaderHandoffSnapshot = originalPersist;
                }
                AtomicJsonFile.runExclusive = async () => {
                    failures += 1;
                    throw Object.assign(new Error('storage denied'), { code: 'EACCES' });
                };
                gate.resolve();
                activeResignation = LeaderElectionService.resignLeadership();
                await assert.rejects(activeResignation, /storage denied/);
                assert.equal(failures, 1);
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'leader-old:100000');
                assert.equal(election.electionPausedUntil, 0);
                assert.equal(manager.balanceResigningTerm, undefined);
                assert.deepEqual(events, []);
            } finally {
                AtomicJsonFile.runExclusive = originalExclusive;
            }
        });
    }

    test('shutdown keeps best-effort semantics when actual snapshot storage rejects', async () => {
        const originalExclusive = AtomicJsonFile.runExclusive;
        let failures = 0;
        try {
            registerInterInstanceHandlers(context);
            limiter.persistLeaderHandoffSnapshot = originalPersist;
            AtomicJsonFile.runExclusive = async () => {
                failures += 1;
                throw new Error('storage denied');
            };
            await LeaderElectionService.stop();
            assert.equal(failures, 2);
            assert.equal(LeaderElectionService.isLeader(), false);
            assert.equal(record, undefined);
            const event = events.find(item => item.type === 'leaderResigning') as
                | Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>
                | undefined;
            assert.equal(event?.payload.reason, 'shutdown');
        } finally {
            AtomicJsonFile.runExclusive = originalExclusive;
        }
    });

    for (const action of ['release', 'lease-renewal', 'expiry'] as const) {
        test(`actual balance write is revalidated before publication: ${action}`, async () => {
            const manager = ApiKeyFailoverManager as unknown as BalanceInternals;
            const previous = {
                leases: manager.balanceLeases,
                ready: manager.balanceAuthorityReady,
                resigning: manager.balanceResigningTerm,
                persistence: manager.persistBalanceLeases
            };
            const originalWrite = AtomicJsonFile.writeJsonAtomically;
            const directory = mkdtempSync(join(tmpdir(), 'gcmp-balance-resignation-write-'));
            const writeStarted = deferred();
            const writeGate = deferred();
            const leaseId = 'balance-during-write';
            let writes = 0;
            let stateAtPublication: ApiKeyBalanceLeaseHandoff | undefined;
            manager.balanceLeases = new Map([
                [
                    leaseId,
                    {
                        leaseId,
                        slot: 'slot',
                        balanceKey: 'balance-key',
                        configId: 'config',
                        credentialId: 'a'.repeat(64),
                        site: 'test',
                        ownerInstanceId: 'follower-first',
                        authorityTerm: 'leader-old:100000',
                        expiresAt: now + (action === 'expiry' ? 500 : 30_000)
                    }
                ]
            ]);
            manager.balanceAuthorityReady = undefined;
            manager.persistBalanceLeases = (authorityTerm, strict) =>
                strict ? previous.persistence.call(ApiKeyFailoverManager, authorityTerm, strict) : Promise.resolve();
            InterInstanceBus.publishIpcOnly = event => {
                events.push(event);
                if (event.type === 'leaderResigning') {
                    stateAtPublication = ApiKeyFailoverManager.exportBalanceLeaseHandoff();
                }
                return true;
            };
            setBalanceHandoffDirectoryOverride(directory);
            AtomicJsonFile.writeJsonAtomically = async (filePath, value, serializer) => {
                assert.equal(dirname(filePath), directory);
                writes += 1;
                if (writes === 1) {
                    writeStarted.resolve();
                    await writeGate.promise;
                }
                await originalWrite.call(AtomicJsonFile, filePath, value, serializer);
            };
            try {
                registerInterInstanceHandlers(context);
                gate.resolve();
                activeResignation = LeaderElectionService.resignLeadership();
                await Promise.race([
                    writeStarted.promise,
                    activeResignation.then(() => {
                        throw new Error('Balance write boundary was not reached');
                    })
                ]);
                assert.equal(LeaderElectionService.isLeader(), true);
                if (action === 'release') {
                    ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                        { leaseId, authorityTerm: 'leader-old:100000' },
                        'follower-first'
                    );
                } else if (action === 'lease-renewal') {
                    now += 1000;
                    ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                        { leaseId, authorityTerm: 'leader-old:100000' },
                        'follower-first'
                    );
                } else {
                    now += 501;
                }
                writeGate.resolve();
                assert.equal(await activeResignation, 'resigned');
                const saved = await readBalanceLeaseHandoff(directory, now);
                assert.ok(saved);
                assert.deepEqual(saved.leases, stateAtPublication?.leases ?? []);
                const event = events.find(item => item.type === 'leaderResigning') as
                    | Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>
                    | undefined;
                assert.ok(event);
                assert.deepEqual(event.payload.balanceLeaseSnapshot?.leases ?? [], saved.leases);
                assert.equal(writes, 2);
            } finally {
                writeGate.resolve();
                await activeResignation?.catch(() => {});
                AtomicJsonFile.writeJsonAtomically = originalWrite;
                setBalanceHandoffDirectoryOverride(undefined);
                manager.balanceLeases = previous.leases;
                manager.balanceAuthorityReady = previous.ready;
                manager.balanceResigningTerm = previous.resigning;
                manager.persistBalanceLeases = previous.persistence;
            }
        });
    }

    for (const action of ['before-capture', 'release', 'lease-renewal', 'expiry', 'clock-only'] as const) {
        test(`balance state is revalidated after rate-limit persistence: ${action}`, async () => {
            const manager = ApiKeyFailoverManager as unknown as BalanceInternals;
            const previous = {
                leases: manager.balanceLeases,
                ready: manager.balanceAuthorityReady,
                resigning: manager.balanceResigningTerm,
                persistence: manager.persistBalanceLeases
            };
            const leaseId = 'balance-before-handoff';
            const balancePersisted: ApiKeyBalanceLeaseHandoff[] = [];
            let stateAtPublication: ApiKeyBalanceLeaseHandoff | undefined;
            manager.balanceLeases = new Map([
                [
                    leaseId,
                    {
                        leaseId,
                        slot: 'slot',
                        balanceKey: 'balance-key',
                        configId: 'config',
                        credentialId: 'a'.repeat(64),
                        ownerInstanceId: 'follower-first',
                        authorityTerm: 'leader-old:100000',
                        expiresAt: now + (action === 'expiry' ? 500 : 30_000)
                    }
                ]
            ]);
            manager.balanceAuthorityReady = undefined;
            manager.persistBalanceLeases = async () => {
                const snapshot = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
                assert.ok(snapshot);
                balancePersisted.push(snapshot);
            };
            InterInstanceBus.publishIpcOnly = event => {
                events.push(event);
                if (event.type === 'leaderResigning') {
                    stateAtPublication = ApiKeyFailoverManager.exportBalanceLeaseHandoff();
                }
                return true;
            };
            const release = () =>
                ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                    { leaseId, authorityTerm: 'leader-old:100000' },
                    'follower-first'
                );
            try {
                registerInterInstanceHandlers(context);
                if (action === 'before-capture') {
                    release();
                }
                await beginHandoff();
                if (action === 'release') {
                    release();
                } else if (action === 'lease-renewal') {
                    now += 1000;
                    ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                        { leaseId, authorityTerm: 'leader-old:100000' },
                        'follower-first'
                    );
                } else if (action === 'expiry') {
                    now += 501;
                } else if (action === 'clock-only') {
                    now += 1000;
                }
                gate.resolve();
                assert.equal(await activeResignation, 'resigned');
                const event = events.find(item => item.type === 'leaderResigning') as
                    | Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>
                    | undefined;
                assert.ok(event);
                assert.deepEqual(event.payload.balanceLeaseSnapshot?.leases ?? [], stateAtPublication?.leases ?? []);
                assert.deepEqual(balancePersisted.at(-1)?.leases ?? [], stateAtPublication?.leases ?? []);
                if (action === 'clock-only') {
                    assert.equal(balancePersisted.length, 1);
                }
            } finally {
                gate.resolve();
                await activeResignation?.catch(() => {});
                manager.balanceLeases = previous.leases;
                manager.balanceAuthorityReady = previous.ready;
                manager.balanceResigningTerm = previous.resigning;
                manager.persistBalanceLeases = previous.persistence;
            }
        });
    }

    for (const failure of ['candidate-gone', 'not-sent', 'persistence-failed'] as const) {
        test(`aborted handoff unfreezes local requests and balance authority: ${failure}`, async () => {
            const manager = ApiKeyFailoverManager as unknown as { balanceResigningTerm: string | undefined };
            const previousTerm = manager.balanceResigningTerm;
            const token = new vscode.CancellationTokenSource();
            const waiting = deferred();
            let acquiring: Promise<RateLimitHandle | undefined> | undefined;
            try {
                registerInterInstanceHandlers(context);
                LeaderElectionService.setBalanceLeaseSnapshotProvider(() => {
                    manager.balanceResigningTerm = 'leader-old:100000';
                    return undefined;
                });
                if (failure === 'persistence-failed') {
                    limiter.persistLeaderHandoffSnapshot = async () => {
                        started.resolve();
                        await gate.promise;
                        throw new Error('persistence failed');
                    };
                }
                await beginHandoff();
                acquiring = RateLimiter.acquire(
                    'bucket',
                    { parallel: 1 },
                    { requests: 1, tokens: 1 },
                    {
                        token: token.token,
                        onWaiting: () => waiting.resolve()
                    }
                );
                await Promise.race([
                    waiting.promise,
                    acquiring.then(() => {
                        throw new Error('Acquire was granted before handoff aborted');
                    })
                ]);
                if (failure === 'candidate-gone') {
                    followers = [];
                }
                if (failure === 'not-sent') {
                    InterInstanceBus.publishIpcOnly = () => false;
                }
                const outcome =
                    failure === 'candidate-gone' ? undefined : (
                        assert.rejects(activeResignation!, /failed|publish|IPC/i)
                    );
                gate.resolve();
                if (outcome) {
                    await outcome;
                } else {
                    assert.equal(await activeResignation, 'no-follower');
                }
                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), 'leader-old:100000');
                assert.equal(manager.balanceResigningTerm, undefined);
                const handle = await acquiring;
                assert.ok(handle);
                assert.equal(handle.authoritative, true);
                RateLimiter.release(handle);
            } finally {
                token.cancel();
                await acquiring?.catch(() => {});
                manager.balanceResigningTerm = previousTerm;
                token.dispose();
            }
        });
    }
});
