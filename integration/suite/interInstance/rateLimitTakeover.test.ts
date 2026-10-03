import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import type { InterInstanceEvent } from '../../../src/interInstance/eventProtocol';
import { setRateLimitHandoffFilePathOverride } from '../../../src/interInstance/pathResolver';
import {
    writeRateLimitLeaderHandoff,
    type RateLimitLeaderHandoffPayload
} from '../../../src/rateLimit/leaderHandoffFile';
import { RateLimiter, type RateLimitHandle } from '../../../src/rateLimit/rateLimiter';
import { RateLimitStore, type RateLimitStoreSnapshot } from '../../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../../src/usages/atomicJsonFile';
import { ConfigManager } from '../../../src/utils/config/configManager';

interface ElectionState {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    electionPausedUntil: number;
}
interface TakeoverInternals {
    initialized: boolean;
    leaderStore: RateLimitStore;
    leaderRestoreReady: Promise<void> | undefined;
    pendingLeaderHandoff: { leaderId: string; snapshot: RateLimitStoreSnapshot; receivedAt: number } | undefined;
    pendingPersistedLeaderHandoff: TakeoverInternals['pendingLeaderHandoff'];
    importPersistedLeaderHandoff: (handoff?: RateLimitLeaderHandoffPayload) => Promise<void>;
    becomeLeaderWithFreshState: () => void;
    renewLease: (handle: RateLimitHandle) => boolean;
    sweep: () => void;
    exportLeaderStateSnapshot: (strict?: boolean) => Promise<RateLimitStoreSnapshot | undefined>;
    persistLeaderHandoffSnapshot: (...args: unknown[]) => Promise<void>;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Rate-limit takeover readiness', () => {
    const limiter = RateLimiter as unknown as TakeoverInternals;
    const election = LeaderElectionService as unknown as ElectionState & { setLeaderState: (value: boolean) => void };
    let previousElection: ElectionState;
    let previousStore: RateLimitStore;
    let previousPending: TakeoverInternals['pendingLeaderHandoff'];
    let previousPersisted: TakeoverInternals['pendingPersistedLeaderHandoff'];
    let previousReady: Promise<void> | undefined;
    let originalImport: TakeoverInternals['importPersistedLeaderHandoff'];
    let originalPersist: TakeoverInternals['persistLeaderHandoffSnapshot'];
    let context: vscode.ExtensionContext;
    let record: { instanceId: string; electedAt: number; lastHeartbeat: number };
    let now: number;
    let events: Array<Parameters<typeof InterInstanceBus.publish>[0]>;
    let gate: ReturnType<typeof deferred>;
    let blockedFile: Promise<void> | undefined;
    let restores: Promise<void>[];
    let acquisitions: Array<Promise<RateLimitHandle | undefined>>;
    let handles: RateLimitHandle[];
    let tokens: vscode.CancellationTokenSource[];
    let persistCalls: number;
    let handoffPath: string;
    const originalNow = Date.now;
    const originalPublish = InterInstanceBus.publish;
    const originalProviderLimit = ConfigManager.getProviderRateLimitConfig;

    setup(() => {
        assert.equal(limiter.initialized, false);
        previousElection = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            electionPausedUntil: election.electionPausedUntil
        };
        previousStore = limiter.leaderStore;
        previousPending = limiter.pendingLeaderHandoff;
        previousPersisted = limiter.pendingPersistedLeaderHandoff;
        previousReady = limiter.leaderRestoreReady;
        originalImport = limiter.importPersistedLeaderHandoff;
        originalPersist = limiter.persistLeaderHandoffSnapshot;
        now = 100_000;
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        events = [];
        restores = [];
        acquisitions = [];
        handles = [];
        tokens = [];
        gate = deferred();
        blockedFile = undefined;
        persistCalls = 0;
        handoffPath = join(mkdtempSync(join(tmpdir(), 'gcmp-takeover-test-')), 'handoff.json');
        setRateLimitHandoffFilePathOverride(handoffPath);
        context = {
            subscriptions: [],
            globalState: { get: () => record, update: async () => {} }
        } as unknown as vscode.ExtensionContext;
        Object.assign(election, {
            context,
            instanceId: 'successor',
            initialized: true,
            agentsWindow: false,
            _isLeader: true,
            ownElectedAt: now,
            electionPausedUntil: 0
        });
        Date.now = () => now;
        InterInstanceBus.publish = event => {
            events.push(event);
        };
        ConfigManager.getProviderRateLimitConfig = () => ({ parallel: 1 });
        limiter.leaderStore = new RateLimitStore('before-takeover');
        limiter.pendingLeaderHandoff = undefined;
        limiter.pendingPersistedLeaderHandoff = undefined;
        limiter.leaderRestoreReady = undefined;
        limiter.persistLeaderHandoffSnapshot = async () => {
            persistCalls += 1;
        };
        limiter.importPersistedLeaderHandoff = handoff => {
            const restore = originalImport.call(RateLimiter, handoff);
            restores.push(restore);
            return restore;
        };
        RateLimiter.initialize(context);
    });

    teardown(async () => {
        gate.resolve();
        for (const token of tokens) {
            token.cancel();
        }
        await blockedFile?.catch(() => {});
        await Promise.all(restores.map(restore => restore.catch(() => {})));
        await limiter.leaderRestoreReady?.catch(() => {});
        await Promise.all(acquisitions.map(acquiring => acquiring.catch(() => {})));
        for (const handle of handles) {
            RateLimiter.release(handle);
        }
        for (const token of tokens) {
            token.dispose();
        }
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        limiter.leaderStore = previousStore;
        limiter.pendingLeaderHandoff = previousPending;
        limiter.pendingPersistedLeaderHandoff = previousPersisted;
        limiter.leaderRestoreReady = previousReady;
        limiter.importPersistedLeaderHandoff = originalImport;
        limiter.persistLeaderHandoffSnapshot = originalPersist;
        Object.assign(election, previousElection);
        Date.now = originalNow;
        InterInstanceBus.publish = originalPublish;
        ConfigManager.getProviderRateLimitConfig = originalProviderLimit;
        setRateLimitHandoffFilePathOverride();
    });

    async function beginRestore(leaseMs?: number): Promise<string> {
        const filePath = handoffPath;
        const source = new RateLimitStore('prior', leaseMs);
        const old = source.acquire('prior-request', 'prior-bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'prior-follower'
        });
        assert.equal(old.kind, 'granted');
        if (old.kind !== 'granted') {
            throw new Error('Prior grant was not created');
        }
        await writeRateLimitLeaderHandoff(
            {
                leaderId: 'prior',
                authorityTerm: 'prior:99999',
                receivedAt: now,
                snapshot: source.exportSnapshot(now)
            },
            filePath,
            { strict: true }
        );
        const entered = deferred();
        blockedFile = AtomicJsonFile.runExclusive(filePath, async () => {
            entered.resolve();
            await gate.promise;
        });
        await entered.promise;
        limiter.becomeLeaderWithFreshState();
        return old.grantId;
    }
    async function finishRestore(): Promise<void> {
        gate.resolve();
        await blockedFile;
        await Promise.all(restores);
        await limiter.leaderRestoreReady;
    }
    function acquire(dims = { parallel: 1 }, onWaiting?: () => void): Promise<RateLimitHandle | undefined> {
        const token = new vscode.CancellationTokenSource();
        tokens.push(token);
        const acquiring = RateLimiter.acquire(
            'successor-bucket',
            dims,
            { requests: 1, tokens: 1 },
            {
                token: token.token,
                onWaiting
            }
        ).then(handle => {
            if (handle) {
                handles.push(handle);
            }
            return handle;
        });
        acquisitions.push(acquiring);
        return acquiring;
    }

    test('idle takeover restores the persisted grant', async () => {
        const oldGrantId = await beginRestore();
        await finishRestore();
        assert.equal(limiter.leaderStore.hasGrant(oldGrantId), true);
    });

    test('local acquire waits outside the store and retains its grant after recovery', async () => {
        await beginRestore();
        const waiting = deferred();
        let delivered = false;
        const acquiring = acquire(undefined, () => waiting.resolve()).then(handle => {
            delivered = true;
            return handle;
        });
        await Promise.race([waiting.promise, acquiring]);
        assert.equal(delivered, false);
        assert.deepEqual(limiter.leaderStore.exportSnapshot(now).grants, []);
        assert.equal(limiter.leaderStore.stats('successor-bucket', now), undefined);
        await finishRestore();
        const handle = await acquiring;
        assert.ok(handle?.authoritative);
        assert.equal(limiter.leaderStore.hasGrant(handle.grantId), true);
    });

    for (const { name, dims, waitMs } of [
        { name: 'RPM', dims: { rpm: 1 }, waitMs: 59_990 },
        { name: 'RPS', dims: { rps: 1 }, waitMs: 990 },
        { name: 'TPM', dims: { tpm: 1 }, waitMs: 59_990 }
    ] as const) {
        test(`completed successor request retains spent ${name} after delayed recovery`, async () => {
            await beginRestore();
            const waiting = deferred();
            let early: RateLimitHandle | undefined;
            const acquiring = acquire({ parallel: 1, ...dims }, () => waiting.resolve()).then(handle => {
                early = handle;
                return handle;
            });
            await Promise.race([waiting.promise, acquiring]);
            const completedBeforeRestore = Boolean(early);
            if (early) {
                RateLimiter.release(early);
                now += 10;
            }
            await finishRestore();
            const handle = await acquiring;
            assert.ok(handle);
            if (!completedBeforeRestore) {
                RateLimiter.release(handle);
                now += 10;
            }
            assert.equal(limiter.leaderStore.stats('successor-bucket', now)?.waitMs ?? 0, waitMs);
        });
    }

    test('local cancellation settles without waiting for file recovery', async () => {
        await beginRestore();
        const waiting = deferred();
        const acquiring = acquire(undefined, () => waiting.resolve());
        await Promise.race([waiting.promise, acquiring]);
        const rejected = assert.rejects(acquiring, error => error instanceof vscode.CancellationError);
        tokens[0].cancel();
        await rejected;
        await finishRestore();
        assert.equal(limiter.leaderStore.stats('successor-bucket', now), undefined);
    });

    for (const cancel of [false, true]) {
        test(`remote acquire is acknowledged but not granted before recovery; cancellation=${cancel}`, async () => {
            await beginRestore();
            RateLimiter.handleAcquireRequest(
                {
                    requestId: 'remote-new',
                    bucketKey: 'successor-bucket',
                    authorityTerm: 'successor:100000',
                    dims: { parallel: 1 },
                    costs: { requests: 1, tokens: 1 }
                },
                'remote'
            );
            assert.equal(events.filter(event => event.type === 'rateLimitAcquireGranted').length, 0);
            assert.equal(events.filter(event => event.type === 'rateLimitQueueUpdated').length, 1);
            assert.equal(limiter.leaderStore.stats('successor-bucket', now), undefined);
            if (cancel) {
                RateLimiter.handleRemoteAcquireCancelled(
                    {
                        authorityTerm: 'successor:100000',
                        bucketKey: 'successor-bucket',
                        requestId: 'remote-new'
                    },
                    'remote'
                );
            }
            await finishRestore();
            assert.equal(limiter.leaderStore.stats('successor-bucket', now)?.inflight, cancel ? 0 : 1);
        });
    }

    for (const action of ['release', 'renewal'] as const) {
        test(`previous-owner ${action} received during restoration is replayed after import`, async () => {
            const oldGrantId = await beginRestore(100);
            now += 50;
            if (action === 'release') {
                RateLimiter.handleRemoteRelease(
                    { authorityTerm: 'prior:99999', grantId: oldGrantId },
                    'prior-follower'
                );
            } else {
                RateLimiter.handleRemoteLeaseRenewal(
                    { authorityTerm: 'prior:99999', grantId: oldGrantId },
                    'prior-follower'
                );
            }
            await finishRestore();
            if (action === 'release') {
                assert.equal(limiter.leaderStore.hasGrant(oldGrantId), false);
            }
            now += 75;
            limiter.leaderStore.sweep(now);
            assert.equal(limiter.leaderStore.hasGrant(oldGrantId), action === 'renewal');
        });
    }

    test('periodic sweep does not persist the empty pre-recovery store', async () => {
        await beginRestore();
        limiter.sweep();
        assert.equal(persistCalls, 0);
        await finishRestore();
    });

    test('manual handoff snapshot waits for takeover recovery', async () => {
        const oldGrantId = await beginRestore();
        let exported: RateLimitStoreSnapshot | undefined;
        let completed = false;
        const exporting = limiter.exportLeaderStateSnapshot(true).then(snapshot => {
            exported = snapshot;
            completed = true;
        });
        await Promise.race([exporting, Promise.resolve()]);
        assert.equal(persistCalls, 0);
        assert.equal(completed, false);
        await finishRestore();
        await exporting;
        assert.equal(exported?.grants[0]?.grantId, oldGrantId);
    });

    test('late restoration cannot overwrite a new store or a newer owned term', async () => {
        await beginRestore();
        election.setLeaderState(false);
        now += 200;
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        election.ownElectedAt = now;
        election.setLeaderState(true);
        const waiting = deferred();
        const acquiring = acquire(undefined, () => waiting.resolve());
        await Promise.race([waiting.promise, acquiring]);
        await finishRestore();
        const handle = await acquiring;
        assert.ok(handle?.authoritative);
        assert.equal(handle.authorityTerm, 'successor:100200');
        assert.equal(limiter.leaderStore.hasGrant(handle.grantId), true);
        assert.equal(limiter.leaderStore.stats('prior-bucket', now)?.inflight, 1);
    });

    test('actual recovery I/O failure rejects local acquisition and blocks sweep persistence', async () => {
        await beginRestore();
        const waiting = deferred();
        const acquiring = acquire(undefined, () => waiting.resolve());
        await Promise.race([waiting.promise, acquiring]);
        assert.equal(handles.length, 0);
        renameSync(handoffPath, `${handoffPath}.prior`);
        mkdirSync(handoffPath);
        const rejected = assert.rejects(acquiring);
        await assert.rejects(finishRestore());
        await rejected;
        limiter.sweep();
        assert.equal(persistCalls, 0);
        assert.equal(limiter.leaderStore.stats('successor-bucket', now), undefined);
    });

    test('dispose invalidates the recovery store and preserves unimported persisted state', async () => {
        const oldGrantId = await beginRestore();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        await finishRestore();
        assert.equal(limiter.initialized, false);
        assert.equal(limiter.leaderStore.hasGrant(oldGrantId), false);
        const restored: { snapshot: RateLimitStoreSnapshot } = JSON.parse(readFileSync(handoffPath, 'utf8'));
        assert.equal(restored.snapshot.grants[0]?.grantId, oldGrantId);
    });

    test('a later owned term can recover after an actual previous recovery failure', async () => {
        const oldGrantId = await beginRestore();
        renameSync(handoffPath, `${handoffPath}.prior`);
        mkdirSync(handoffPath);
        await assert.rejects(finishRestore());
        rmdirSync(handoffPath);
        renameSync(`${handoffPath}.prior`, handoffPath);
        election.setLeaderState(false);
        now += 200;
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        election.ownElectedAt = now;
        election.setLeaderState(true);
        await limiter.leaderRestoreReady;
        const handle = await acquire();
        assert.ok(handle?.authoritative);
        assert.equal(limiter.leaderStore.hasGrant(oldGrantId), true);
        assert.equal(limiter.leaderStore.hasGrant(handle.grantId), true);
    });

    test('state retained after role loss cannot bypass a newer persisted snapshot', async () => {
        const oldGrantId = await beginRestore();
        election.setLeaderState(false);
        await finishRestore();
        now += 200;
        const preserved: { snapshot: RateLimitStoreSnapshot } = JSON.parse(readFileSync(handoffPath, 'utf8'));
        const newer = new RateLimitStore('newer');
        newer.importSnapshot(preserved.snapshot, now);
        newer.release(oldGrantId, undefined, now);
        const granted = newer.acquire(
            'newer-request',
            'prior-bucket',
            { parallel: 1 },
            { requests: 1, tokens: 0 },
            now,
            {
                ownerInstanceId: 'newer-follower'
            }
        );
        assert.equal(granted.kind, 'granted');
        if (granted.kind !== 'granted') {
            throw new Error('Newer grant was not created');
        }
        await writeRateLimitLeaderHandoff(
            { leaderId: 'newer', receivedAt: now, snapshot: newer.exportSnapshot(now) },
            handoffPath,
            { strict: true }
        );
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        election.ownElectedAt = now;
        election.setLeaderState(true);
        await limiter.leaderRestoreReady;
        assert.equal(limiter.leaderStore.hasGrant(granted.grantId), true);
        assert.equal(limiter.leaderStore.hasGrant(oldGrantId), false);
    });

    test('valid shared state remains present while a lost owner is returning its read snapshot', async () => {
        const oldGrantId = await beginRestore();
        const returning = deferred();
        const allowReturn = deferred();
        const originalWrite = AtomicJsonFile.writeJsonAtomically;
        try {
            AtomicJsonFile.writeJsonAtomically = async (...args) => {
                if (args[0] === handoffPath) {
                    returning.resolve();
                    await allowReturn.promise;
                }
                await originalWrite.apply(AtomicJsonFile, args);
            };
            election.setLeaderState(false);
            gate.resolve();
            await returning.promise;
            assert.equal(existsSync(handoffPath), true);
            const stillShared: { snapshot: RateLimitStoreSnapshot } = JSON.parse(readFileSync(handoffPath, 'utf8'));
            assert.equal(stillShared.snapshot.grants[0]?.grantId, oldGrantId);
        } finally {
            allowReturn.resolve();
            await finishRestore();
            AtomicJsonFile.writeJsonAtomically = originalWrite;
        }
    });

    for (const scenario of ['single', 'latest-grant', 'latest-empty'] as const) {
        test(`new memory survives pending recoveries; scenario=${scenario}`, async () => {
            await beginRestore();
            const hops = scenario === 'single' ? 1 : 2;
            for (let hop = 1; hop <= hops; hop++) {
                election.setLeaderState(false);
                now += 200;
                record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
                election.ownElectedAt = now;
                const leaderId = hop === hops ? 'new-memory-bucket' : 'intermediate-bucket';
                const source = new RateLimitStore(leaderId);
                if (hop < hops || scenario !== 'latest-empty') {
                    source.acquire('memory-new', leaderId, { parallel: 1 }, { requests: 1, tokens: 0 }, now);
                }
                limiter.pendingLeaderHandoff = { leaderId, snapshot: source.exportSnapshot(now), receivedAt: now };
                election.setLeaderState(true);
            }
            await finishRestore();
            const expected = scenario === 'latest-empty' ? 0 : 1;
            assert.equal(limiter.leaderStore.stats('new-memory-bucket', now)?.inflight ?? 0, expected);
            assert.equal(limiter.leaderStore.stats('intermediate-bucket', now)?.inflight ?? 0, 0);
            assert.equal(limiter.leaderStore.stats('prior-bucket', now)?.inflight ?? 0, 0);
        });
    }

    test('ownership change without a role event cannot authorize an empty recovery store', async () => {
        await beginRestore();
        const waiting = deferred();
        const acquiring = acquire(undefined, () => waiting.resolve());
        await Promise.race([waiting.promise, acquiring]);
        assert.equal(handles.length, 0);
        record = { instanceId: 'another-leader', electedAt: now + 1, lastHeartbeat: now + 1 };
        const rejected = assert.rejects(acquiring);
        await assert.rejects(finishRestore());
        await rejected;
        assert.equal(limiter.leaderStore.exportSnapshot(now).grants.length, 0);
    });

    for (const state of ['missing', 'corrupt', 'stale'] as const) {
        test(`${state} handoff permits an empty start only after recovery settles`, async () => {
            if (state === 'corrupt') {
                writeFileSync(handoffPath, 'not-json');
            }
            if (state === 'stale') {
                await writeRateLimitLeaderHandoff(
                    {
                        leaderId: 'prior',
                        receivedAt: now - 30_001,
                        snapshot: { buckets: [], grants: [] }
                    },
                    handoffPath,
                    { strict: true }
                );
            }
            limiter.becomeLeaderWithFreshState();
            await limiter.leaderRestoreReady;
            const handle = await acquire();
            assert.ok(handle?.authoritative);
            assert.equal(limiter.leaderStore.hasGrant(handle.grantId), true);
        });
    }

    test('valid in-memory handoff waits for version comparison before granting', async () => {
        const source = new RateLimitStore('memory');
        source.acquire('memory-request', 'memory-bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now);
        limiter.pendingLeaderHandoff = { leaderId: 'prior', snapshot: source.exportSnapshot(now), receivedAt: now };
        limiter.becomeLeaderWithFreshState();
        await limiter.leaderRestoreReady;
        assert.equal(restores.length, 1);
        assert.equal(limiter.leaderStore.stats('memory-bucket', now)?.inflight, 1);
        const handle = await acquire();
        assert.ok(handle?.authoritative);
    });

    for (const newerDisk of [false, true]) {
        test(`ordinary follower compares its memory handoff with disk; newerDisk=${newerDisk}`, async () => {
            election.setLeaderState(false);
            record = { instanceId: 'prior', electedAt: 99_999, lastHeartbeat: now };
            const source = new RateLimitStore('memory-prior');
            const original = source.acquire(
                'old-request',
                'prior-bucket',
                { parallel: 1 },
                { requests: 1, tokens: 0 },
                now,
                {
                    ownerInstanceId: 'prior-follower'
                }
            );
            assert.equal(original.kind, 'granted');
            if (original.kind !== 'granted') {
                throw new Error('Source grant missing');
            }
            const oldSnapshot = source.exportSnapshot(now);
            await writeRateLimitLeaderHandoff(
                {
                    leaderId: 'prior',
                    authorityTerm: 'prior:99999',
                    receivedAt: now,
                    snapshot: oldSnapshot
                },
                handoffPath,
                { strict: true }
            );
            const bus = InterInstanceBus as unknown as {
                authorityTerm: string | undefined;
                dispatchEvent: (event: InterInstanceEvent) => void;
            };
            const previousTerm = bus.authorityTerm;
            try {
                bus.authorityTerm = 'prior:99999';
                bus.dispatchEvent({
                    type: 'leaderResigning',
                    timestamp: now,
                    senderInstanceId: 'prior',
                    payload: {
                        leaderId: 'prior',
                        nextLeaderId: 'intermediate',
                        sourceAuthorityTerm: 'prior:99999',
                        reason: 'manual',
                        rateLimitSnapshot: oldSnapshot
                    }
                });
            } finally {
                bus.authorityTerm = previousTerm;
            }
            assert.equal(limiter.pendingLeaderHandoff?.leaderId, 'prior');
            let expectedGrantId = original.grantId;
            if (newerDisk) {
                now += 200;
                record = { instanceId: 'intermediate', electedAt: now, lastHeartbeat: now };
                const intermediate = new RateLimitStore('intermediate');
                intermediate.importSnapshot(oldSnapshot, now);
                intermediate.release(original.grantId, undefined, now);
                const next = intermediate.acquire(
                    'new-request',
                    'prior-bucket',
                    { parallel: 1 },
                    { requests: 1, tokens: 0 },
                    now,
                    {
                        ownerInstanceId: 'intermediate-follower'
                    }
                );
                assert.equal(next.kind, 'granted');
                if (next.kind !== 'granted') {
                    throw new Error('Intermediate grant missing');
                }
                expectedGrantId = next.grantId;
                await writeRateLimitLeaderHandoff(
                    {
                        leaderId: 'intermediate',
                        authorityTerm: `intermediate:${now}`,
                        receivedAt: now,
                        snapshot: intermediate.exportSnapshot(now)
                    },
                    handoffPath,
                    { strict: true }
                );
            }
            now += 16_000;
            record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
            election.ownElectedAt = now;
            election.setLeaderState(true);
            await limiter.leaderRestoreReady;
            assert.equal(limiter.leaderStore.hasGrant(expectedGrantId), true);
            assert.equal(limiter.leaderStore.hasGrant(original.grantId), !newerDisk);
        });
    }

    test('new memory handoff wins over an older valid disk snapshot', async () => {
        await writeRateLimitLeaderHandoff(
            {
                leaderId: 'old',
                receivedAt: now - 200,
                snapshot: { buckets: [], grants: [] }
            },
            handoffPath,
            { strict: true }
        );
        const source = new RateLimitStore('new-memory');
        const grant = source.acquire(
            'memory-request',
            'memory-bucket',
            { parallel: 1 },
            { requests: 1, tokens: 0 },
            now
        );
        assert.equal(grant.kind, 'granted');
        if (grant.kind !== 'granted') {
            throw new Error('Memory grant missing');
        }
        limiter.pendingLeaderHandoff = { leaderId: 'prior', snapshot: source.exportSnapshot(now), receivedAt: now };
        limiter.becomeLeaderWithFreshState();
        await limiter.leaderRestoreReady;
        assert.equal(limiter.leaderStore.hasGrant(grant.grantId), true);
    });

    for (const state of ['same-version', 'invalid-newer-memory'] as const) {
        test(`disk remains authoritative over non-newer usable memory; state=${state}`, async () => {
            const source = new RateLimitStore('memory');
            const grant = source.acquire(
                'memory-request',
                'memory-bucket',
                { parallel: 1 },
                { requests: 1, tokens: 0 },
                now
            );
            assert.equal(grant.kind, 'granted');
            if (grant.kind !== 'granted') {
                throw new Error('Memory grant missing');
            }
            limiter.pendingLeaderHandoff = {
                leaderId: 'prior',
                receivedAt: state === 'same-version' ? now : now + 1,
                snapshot:
                    state === 'same-version' ?
                        source.exportSnapshot(now)
                    :   ({ invalid: true } as unknown as RateLimitStoreSnapshot)
            };
            await writeRateLimitLeaderHandoff(
                {
                    leaderId: 'disk',
                    receivedAt: now,
                    snapshot: { buckets: [], grants: [] }
                },
                handoffPath,
                { strict: true }
            );
            limiter.becomeLeaderWithFreshState();
            await limiter.leaderRestoreReady;
            assert.equal(limiter.leaderStore.hasGrant(grant.grantId), false);
        });
    }

    test('memory handoff after a failed recovery still compares the newer disk snapshot', async () => {
        const oldGrantId = await beginRestore();
        const oldPayload = JSON.parse(readFileSync(handoffPath, 'utf8')) as RateLimitLeaderHandoffPayload;
        renameSync(handoffPath, `${handoffPath}.prior`);
        mkdirSync(handoffPath);
        await assert.rejects(finishRestore());
        rmdirSync(handoffPath);
        renameSync(`${handoffPath}.prior`, handoffPath);
        election.setLeaderState(false);
        now += 200;
        const source = new RateLimitStore('new-disk');
        const grant = source.acquire('new-request', 'prior-bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'new-follower'
        });
        assert.equal(grant.kind, 'granted');
        if (grant.kind !== 'granted') {
            throw new Error('Disk grant missing');
        }
        await writeRateLimitLeaderHandoff(
            {
                leaderId: 'new-disk',
                receivedAt: now,
                snapshot: source.exportSnapshot(now)
            },
            handoffPath,
            { strict: true }
        );
        limiter.pendingLeaderHandoff = oldPayload;
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        election.ownElectedAt = now;
        election.setLeaderState(true);
        await limiter.leaderRestoreReady;
        assert.equal(limiter.leaderStore.hasGrant(grant.grantId), true);
        assert.equal(limiter.leaderStore.hasGrant(oldGrantId), false);
    });

    test('valid memory cannot bypass a real disk comparison failure', async () => {
        const source = new RateLimitStore('memory');
        source.acquire('memory-request', 'memory-bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now);
        limiter.pendingLeaderHandoff = { leaderId: 'prior', snapshot: source.exportSnapshot(now), receivedAt: now };
        mkdirSync(handoffPath);
        limiter.becomeLeaderWithFreshState();
        await assert.rejects(limiter.leaderRestoreReady ?? Promise.resolve());
        await assert.rejects(acquire());
        limiter.sweep();
        assert.equal(persistCalls, 0);
        rmdirSync(handoffPath);
        election.setLeaderState(false);
        now += 200;
        record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
        election.ownElectedAt = now;
        election.setLeaderState(true);
        await limiter.leaderRestoreReady;
        assert.equal(limiter.leaderStore.stats('memory-bucket', now)?.inflight, 1);
    });

    for (const scenario of [
        'early',
        'cross-expiry',
        'wrong-owner',
        'late',
        'at-expiry',
        'missing-sender',
        'no-renewal',
        'repeat',
        'release-before-renewal',
        'release-after-renewal',
        'cancel-before-renewal',
        'cancel-after-renewal',
        'local',
        'ownerless'
    ] as const) {
        test(`recovery applies renewal at its received time before expiry pruning; scenario=${scenario}`, async () => {
            const startedAt = now;
            const source = new RateLimitStore('original-owner');
            const original = source.acquire(
                'original-request',
                'prior-bucket',
                { parallel: 1 },
                { requests: 1, tokens: 0 },
                now
            );
            assert.equal(original.kind, 'granted');
            if (original.kind !== 'granted') {
                throw new Error('Original grant missing');
            }
            const prior = new RateLimitStore('first-successor');
            const owner =
                scenario === 'local' ? 'successor'
                : scenario === 'ownerless' ? 'prior'
                : 'prior-follower';
            prior.importSnapshot(source.exportSnapshot(now), now, {
                ownerlessGrantGraceMs: 5_000,
                ownerlessGrantOwnerInstanceId: owner
            });
            const snapshot = scenario === 'ownerless' ? source.exportSnapshot(now) : prior.exportSnapshot(now);
            const pristine = JSON.stringify(snapshot);
            assert.equal(snapshot.grants[0]?.leaseMs, 600_000);
            await writeRateLimitLeaderHandoff(
                {
                    leaderId: 'prior',
                    authorityTerm: 'prior:99999',
                    receivedAt: now,
                    snapshot
                },
                handoffPath,
                { strict: true }
            );
            const entered = deferred();
            blockedFile = AtomicJsonFile.runExclusive(handoffPath, async () => {
                entered.resolve();
                await gate.promise;
            });
            await entered.promise;
            limiter.becomeLeaderWithFreshState();
            now +=
                scenario === 'late' ? 5_500
                : scenario === 'at-expiry' ? 5_000
                : 2_500;
            let lastReceivedAt = now;
            if (scenario === 'release-before-renewal') {
                RateLimiter.handleRemoteRelease({ authorityTerm: 'prior:99999', grantId: original.grantId }, owner);
            }
            if (scenario === 'cancel-before-renewal') {
                RateLimiter.handleRemoteAcquireCancelled(
                    {
                        authorityTerm: 'prior:99999',
                        bucketKey: 'prior-bucket',
                        requestId: 'original-request'
                    },
                    owner
                );
            }
            if (scenario === 'local') {
                assert.equal(
                    limiter.renewLease({
                        grantId: original.grantId,
                        authorityTerm: 'prior:99999',
                        authoritative: true,
                        leaseMs: 600_000,
                        costs: { requests: 1, tokens: 0 }
                    }),
                    true
                );
            } else if (scenario !== 'no-renewal') {
                RateLimiter.handleRemoteLeaseRenewal(
                    { authorityTerm: 'prior:99999', grantId: original.grantId },
                    scenario === 'wrong-owner' ? 'wrong-owner'
                    : scenario === 'missing-sender' ? ''
                    : owner
                );
            }
            if (scenario === 'repeat') {
                now += 3_000;
                lastReceivedAt = now;
                RateLimiter.handleRemoteLeaseRenewal(
                    { authorityTerm: 'prior:99999', grantId: original.grantId },
                    owner
                );
            }
            if (scenario === 'release-after-renewal') {
                RateLimiter.handleRemoteRelease({ authorityTerm: 'prior:99999', grantId: original.grantId }, owner);
            }
            if (scenario === 'cancel-after-renewal') {
                RateLimiter.handleRemoteAcquireCancelled(
                    {
                        authorityTerm: 'prior:99999',
                        bucketKey: 'prior-bucket',
                        requestId: 'original-request'
                    },
                    owner
                );
            }
            now =
                startedAt +
                (scenario === 'early' ? 3_500
                : scenario === 'repeat' || scenario === 'late' ? 6_500
                : 5_500);
            await finishRestore();
            const expectedPresent = ['early', 'cross-expiry', 'repeat', 'local', 'ownerless'].includes(scenario);
            assert.equal(limiter.leaderStore.hasGrant(original.grantId), expectedPresent);
            if (expectedPresent) {
                const restored = limiter.leaderStore
                    .exportSnapshot(now)
                    .grants.find(grant => grant.grantId === original.grantId);
                assert.equal(restored?.expiresAt, lastReceivedAt + 600_000);
                assert.equal(restored?.ownerInstanceId, owner);
            }
            RateLimiter.handleAcquireRequest(
                {
                    requestId: 'competing-request',
                    bucketKey: 'prior-bucket',
                    authorityTerm: 'successor:100000',
                    dims: { parallel: 1 },
                    costs: { requests: 1, tokens: 0 }
                },
                'competing-follower'
            );
            assert.equal(
                events.some(event => event.type === 'rateLimitAcquireGranted'),
                !expectedPresent
            );
            assert.equal(JSON.stringify(snapshot), pristine);
            assert.equal(
                JSON.stringify(
                    (JSON.parse(readFileSync(handoffPath, 'utf8')) as RateLimitLeaderHandoffPayload).snapshot
                ),
                pristine
            );
        });
    }

    for (const action of [
        'acquire-before-renewal',
        'cancel-acquire-after-renewal',
        'removed-in-new-disk',
        'role-loss',
        'renewal-expired'
    ] as const) {
        test(`buffered renewal retains recovery ordering and lifecycle boundaries; action=${action}`, async () => {
            const oldGrantId = await beginRestore(5_000);
            const request = {
                requestId: 'competing-request',
                bucketKey: 'prior-bucket',
                authorityTerm: 'successor:100000',
                dims: { parallel: 1 },
                costs: { requests: 1, tokens: 0 }
            };
            now += 2_500;
            if (action === 'acquire-before-renewal' || action === 'cancel-acquire-after-renewal') {
                RateLimiter.handleAcquireRequest(request, 'competing-follower');
            }
            RateLimiter.handleRemoteLeaseRenewal(
                { authorityTerm: 'prior:99999', grantId: oldGrantId },
                'prior-follower'
            );
            if (action === 'cancel-acquire-after-renewal') {
                RateLimiter.handleRemoteAcquireCancelled(request, 'competing-follower');
            }
            if (action === 'removed-in-new-disk') {
                now += 100;
                writeFileSync(
                    handoffPath,
                    JSON.stringify({
                        leaderId: 'newer',
                        receivedAt: now,
                        snapshot: { buckets: [], grants: [] }
                    })
                );
            }
            if (action === 'role-loss') {
                election.setLeaderState(false);
            }
            now = action === 'renewal-expired' ? 107_500 : 105_500;
            await finishRestore();
            if (action === 'role-loss') {
                record = { instanceId: 'successor', electedAt: now, lastHeartbeat: now };
                election.ownElectedAt = now;
                election.setLeaderState(true);
                await limiter.leaderRestoreReady;
            }
            const retained = action === 'acquire-before-renewal' || action === 'cancel-acquire-after-renewal';
            assert.equal(limiter.leaderStore.hasGrant(oldGrantId), retained);
            assert.equal(
                events.some(event => event.type === 'rateLimitAcquireGranted'),
                false
            );
            assert.equal(
                limiter.leaderStore.stats('prior-bucket', now)?.pending ?? 0,
                action === 'acquire-before-renewal' ? 1 : 0
            );
        });
    }
});
