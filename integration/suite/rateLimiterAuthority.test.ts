import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { InterInstanceBus } from '../../src/interInstance';
import { RateLimiter, type RateLimitHandle } from '../../src/rateLimit/rateLimiter';
import { RateLimitStore, type RateLimitStoreSnapshot } from '../../src/rateLimit/rateLimitStore';
import { LeaderElectionService } from '../../src/status/leaderElectionService';

interface RateLimiterInternals {
    context:
        | {
              globalState: {
                  get: <T>(key: string) => T | undefined;
                  update: (key: string, value: unknown) => Thenable<void>;
              };
          }
        | undefined;
    acquireForCurrentRole: (
        bucketKey: string,
        dims: { rpm: number },
        costs: { requests: number; tokens: number },
        options?: unknown,
        authorityChangeAttempts?: number
    ) => Promise<RateLimitHandle | undefined>;
    acquireViaIpc: (...args: unknown[]) => Promise<RateLimitHandle | undefined>;
    acquireViaLocalStore: (...args: unknown[]) => Promise<RateLimitHandle | undefined>;
    handleRemoteRelease: (payload: {
        authorityTerm: string;
        grantId: string;
        refund?: { requests?: number; tokens?: number };
    }) => void;
    handleRemoteAcquireCancelled: (payload: { authorityTerm: string; requestId: string; bucketKey: string }) => void;
    leaderStore: RateLimitStore;
    clientCore:
        | {
              settlePendingAsDegraded?: () => void;
              acquire: (
                  ...args: unknown[]
              ) => Promise<
                  | { status: 'granted'; grantId: string; waitMs: number; authorityTerm: string }
                  | { status: 'authority-changed' }
                  | { status: 'degraded'; reason: 'timeout' | 'authority-unavailable' }
                  | { status: 'cancelled' }
              >;
          }
        | undefined;
    release: (handle: RateLimitHandle, refund?: { requests?: number; tokens?: number }) => void;
    renewLease: (handle: RateLimitHandle) => boolean;
    startLeaseHeartbeat: (handle: RateLimitHandle, renewEveryMsOverride?: number) => void;
    stopLeaseHeartbeat: (grantId: string) => void;
    retainAuthoritativeGrantsAfterRoleLoss: () => void;
    activeHandles: Map<string, RateLimitHandle>;
    shouldUseIpc: () => boolean;
    sleepOrRefund: (
        waitMs: number,
        handle: RateLimitHandle,
        token?: vscode.CancellationToken,
        bucketKey?: string,
        dims?: { rpm: number },
        options?: unknown
    ) => Promise<RateLimitHandle | undefined>;
    waitForAuthorityRecovery: (token?: vscode.CancellationToken) => Promise<boolean>;
    initialized: boolean;
    degraded: boolean;
    degradedNotified: boolean;
    lastProbeAt: number;
    pendingLeaderHandoff?: {
        leaderId: string;
        snapshot: RateLimitStoreSnapshot;
        receivedAt: number;
    };
    handleLeaderResigning: (payload: {
        leaderId: string;
        nextLeaderId?: string;
        rateLimitSnapshot?: RateLimitStoreSnapshot;
    }) => void;
    becomeLeaderWithFreshState: () => void;
}

interface PatchedInterInstanceBus {
    onAuthorityChanged: typeof InterInstanceBus.onAuthorityChanged;
    getAuthorityTerm: typeof InterInstanceBus.getAuthorityTerm;
    isConnected: typeof InterInstanceBus.isConnected;
    publish: typeof InterInstanceBus.publish;
}

interface PatchedLeaderElectionService {
    isLeader: typeof LeaderElectionService.isLeader;
}

suite('RateLimiter authority change', () => {
    test('sleepOrRefund returns the reacquired handle after authority change', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const oldHandle: RateLimitHandle = {
            grantId: 'old-grant',
            costs: { requests: 1, tokens: 10 },
            leaseMs: 60_000,
            authorityTerm: 'leader-a:1',
            authoritative: true
        };
        const newHandle: RateLimitHandle = {
            grantId: 'new-grant',
            costs: { requests: 1, tokens: 10 },
            leaseMs: 60_000,
            authorityTerm: 'leader-b:2',
            authoritative: true
        };
        const releaseCalls: Array<{ handle: RateLimitHandle; refund?: { requests?: number; tokens?: number } }> = [];

        const originalOnAuthorityChanged = patchedBus.onAuthorityChanged;
        const originalAcquireForCurrentRole = rateLimiter.acquireForCurrentRole;
        const originalRelease = rateLimiter.release;

        try {
            patchedBus.onAuthorityChanged = listener => {
                queueMicrotask(() => listener(undefined));
                return new vscode.Disposable(() => {});
            };
            rateLimiter.acquireForCurrentRole = async () => newHandle;
            rateLimiter.release = (handle: RateLimitHandle, refund?: { requests?: number; tokens?: number }) => {
                releaseCalls.push({ handle, refund });
            };

            const result = await rateLimiter.sleepOrRefund(1_000, oldHandle, undefined, 'bucket', { rpm: 60 });

            assert.equal(result, newHandle);
            assert.deepEqual(releaseCalls, [
                {
                    handle: oldHandle,
                    refund: { requests: 1, tokens: 10 }
                }
            ]);
        } finally {
            patchedBus.onAuthorityChanged = originalOnAuthorityChanged;
            rateLimiter.acquireForCurrentRole = originalAcquireForCurrentRole;
            rateLimiter.release = originalRelease;
        }
    });

    test('requeue acquire waits for authority recovery before using local fallback', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const expectedHandle: RateLimitHandle = {
            grantId: 'ipc-grant',
            costs: { requests: 1, tokens: 0 },
            leaseMs: 60_000,
            authorityTerm: 'leader-b:2',
            authoritative: true
        };

        const originalInitialized = rateLimiter.initialized;
        const originalShouldUseIpc = rateLimiter.shouldUseIpc;
        const originalWaitForAuthorityRecovery = rateLimiter.waitForAuthorityRecovery;
        const originalAcquireViaIpc = rateLimiter.acquireViaIpc;
        const originalAcquireViaLocalStore = rateLimiter.acquireViaLocalStore;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalIsConnected = patchedBus.isConnected;

        let waited = 0;
        let localAcquireCalls = 0;
        let ipcAcquireCalls = 0;
        let authorityTerm: string | undefined;
        let connected = false;

        try {
            rateLimiter.initialized = true;
            rateLimiter.shouldUseIpc = () => false;
            rateLimiter.waitForAuthorityRecovery = async () => {
                waited += 1;
                authorityTerm = 'leader-b:2';
                connected = true;
                return true;
            };
            rateLimiter.acquireViaIpc = async () => {
                ipcAcquireCalls += 1;
                return expectedHandle;
            };
            rateLimiter.acquireViaLocalStore = async () => {
                localAcquireCalls += 1;
                return undefined;
            };
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => authorityTerm;
            patchedBus.isConnected = () => connected;

            const result = await rateLimiter.acquireForCurrentRole(
                'bucket',
                { rpm: 60 },
                { requests: 1, tokens: 0 },
                undefined,
                1
            );

            assert.equal(waited, 1);
            assert.equal(ipcAcquireCalls, 1);
            assert.equal(localAcquireCalls, 0);
            assert.equal(result, expectedHandle);
        } finally {
            rateLimiter.initialized = originalInitialized;
            rateLimiter.shouldUseIpc = originalShouldUseIpc;
            rateLimiter.waitForAuthorityRecovery = originalWaitForAuthorityRecovery;
            rateLimiter.acquireViaIpc = originalAcquireViaIpc;
            rateLimiter.acquireViaLocalStore = originalAcquireViaLocalStore;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.isConnected = originalIsConnected;
        }
    });

    test('authority change retry exhaustion falls back only the current acquire', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;

        const originalInitialized = rateLimiter.initialized;
        const originalAcquireViaLocalStore = rateLimiter.acquireViaLocalStore;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalIsConnected = patchedBus.isConnected;
        const originalDegraded = rateLimiter.degraded;
        const originalDegradedNotified = rateLimiter.degradedNotified;
        const originalLastProbeAt = rateLimiter.lastProbeAt;

        let localAcquireCalls = 0;

        try {
            rateLimiter.initialized = true;
            rateLimiter.degraded = false;
            rateLimiter.degradedNotified = false;
            rateLimiter.lastProbeAt = 0;
            rateLimiter.acquireViaLocalStore = async () => {
                localAcquireCalls += 1;
                return undefined;
            };
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => 'leader-a:1';
            patchedBus.isConnected = () => true;

            const result = await rateLimiter.acquireForCurrentRole(
                'bucket',
                { rpm: 60 },
                { requests: 1, tokens: 0 },
                undefined,
                3
            );

            assert.equal(result, undefined);
            assert.equal(localAcquireCalls, 1);
            assert.equal(rateLimiter.shouldUseIpc(), true);
        } finally {
            rateLimiter.initialized = originalInitialized;
            rateLimiter.acquireViaLocalStore = originalAcquireViaLocalStore;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.isConnected = originalIsConnected;
            rateLimiter.degraded = originalDegraded;
            rateLimiter.degradedNotified = originalDegradedNotified;
            rateLimiter.lastProbeAt = originalLastProbeAt;
        }
    });

    test('ipc timeout fallback does not poison future ipc attempts', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;

        const originalClientCore = rateLimiter.clientCore;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalIsConnected = patchedBus.isConnected;
        const originalDegraded = rateLimiter.degraded;
        const originalDegradedNotified = rateLimiter.degradedNotified;
        const originalLastProbeAt = rateLimiter.lastProbeAt;

        try {
            rateLimiter.clientCore = {
                acquire: async () => ({ status: 'degraded', reason: 'timeout' })
            };
            rateLimiter.degraded = false;
            rateLimiter.degradedNotified = false;
            rateLimiter.lastProbeAt = 0;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => 'leader-a:1';
            patchedBus.isConnected = () => true;

            const result = await rateLimiter.acquireViaIpc('bucket', { rpm: 60 }, { requests: 1, tokens: 0 });

            assert.equal(result, undefined);
            assert.equal(rateLimiter.shouldUseIpc(), true);
        } finally {
            rateLimiter.clientCore = originalClientCore;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.isConnected = originalIsConnected;
            rateLimiter.degraded = originalDegraded;
            rateLimiter.degradedNotified = originalDegradedNotified;
            rateLimiter.lastProbeAt = originalLastProbeAt;
        }
    });

    test('authority unavailable still enters global degraded mode after recovery timeout', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;

        const originalClientCore = rateLimiter.clientCore;
        const originalWaitForAuthorityRecovery = rateLimiter.waitForAuthorityRecovery;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalIsConnected = patchedBus.isConnected;
        const originalDegraded = rateLimiter.degraded;
        const originalDegradedNotified = rateLimiter.degradedNotified;
        const originalLastProbeAt = rateLimiter.lastProbeAt;

        try {
            rateLimiter.clientCore = {
                acquire: async () => ({ status: 'degraded', reason: 'authority-unavailable' })
            };
            rateLimiter.waitForAuthorityRecovery = async () => false;
            rateLimiter.degraded = false;
            rateLimiter.degradedNotified = true;
            rateLimiter.lastProbeAt = 0;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => 'leader-a:1';
            patchedBus.isConnected = () => true;

            const result = await rateLimiter.acquireViaIpc('bucket', { rpm: 60 }, { requests: 1, tokens: 0 });

            assert.equal(result, undefined);
            assert.equal(rateLimiter.shouldUseIpc(), false);
        } finally {
            rateLimiter.clientCore = originalClientCore;
            rateLimiter.waitForAuthorityRecovery = originalWaitForAuthorityRecovery;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.isConnected = originalIsConnected;
            rateLimiter.degraded = originalDegraded;
            rateLimiter.degradedNotified = originalDegradedNotified;
            rateLimiter.lastProbeAt = originalLastProbeAt;
        }
    });

    test('graceful leader handoff restores authoritative bucket instead of empty start', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const source = new RateLimitStore('leader-a');
        const now = Date.now();
        const granted = source.acquire('r1', 'bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'follower-a'
        });
        if (granted.kind !== 'granted') {
            assert.fail('r1 should be granted');
        }
        source.acquire('r2', 'bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'follower-b'
        });
        const snapshot = source.exportSnapshot(now);

        const originalLeaderStore = rateLimiter.leaderStore;
        const originalPendingLeaderHandoff = rateLimiter.pendingLeaderHandoff;
        const originalClientCore = rateLimiter.clientCore;
        const originalDegraded = rateLimiter.degraded;
        const originalDegradedNotified = rateLimiter.degradedNotified;

        let settledPending = 0;

        try {
            rateLimiter.leaderStore = new RateLimitStore('before');
            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.clientCore = {
                acquire: async () => ({ status: 'cancelled' }),
                settlePendingAsDegraded: () => {
                    settledPending += 1;
                }
            };
            rateLimiter.degraded = true;
            rateLimiter.degradedNotified = true;

            rateLimiter.handleLeaderResigning({
                leaderId: 'leader-a',
                nextLeaderId: 'leader-b',
                rateLimitSnapshot: snapshot
            });
            rateLimiter.becomeLeaderWithFreshState();

            assert.equal(settledPending, 1);
            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight, 1);
            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.pending, 0);

            const released = rateLimiter.leaderStore.release(granted.grantId, undefined, now + 100);
            assert.equal(released.length, 0);
        } finally {
            rateLimiter.leaderStore = originalLeaderStore;
            rateLimiter.pendingLeaderHandoff = originalPendingLeaderHandoff;
            rateLimiter.clientCore = originalClientCore;
            rateLimiter.degraded = originalDegraded;
            rateLimiter.degradedNotified = originalDegradedNotified;
        }
    });

    test('graceful leader handoff accepts previous-term release for imported grant', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const source = new RateLimitStore('leader-a');
        const now = Date.now();
        const granted = source.acquire('r1', 'bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'follower-a'
        });
        if (granted.kind !== 'granted') {
            assert.fail('r1 should be granted');
        }
        const snapshot = source.exportSnapshot(now);

        const originalLeaderStore = rateLimiter.leaderStore;
        const originalPendingLeaderHandoff = rateLimiter.pendingLeaderHandoff;
        const originalClientCore = rateLimiter.clientCore;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            rateLimiter.leaderStore = new RateLimitStore('before');
            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.clientCore = undefined;
            patchedLeaderElection.isLeader = () => true;

            rateLimiter.handleLeaderResigning({
                leaderId: 'leader-a',
                nextLeaderId: 'leader-b',
                rateLimitSnapshot: snapshot
            });
            rateLimiter.becomeLeaderWithFreshState();
            rateLimiter.handleRemoteRelease({
                authorityTerm: 'leader-a:1',
                grantId: granted.grantId
            });

            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight ?? 0, 0);
        } finally {
            rateLimiter.leaderStore = originalLeaderStore;
            rateLimiter.pendingLeaderHandoff = originalPendingLeaderHandoff;
            rateLimiter.clientCore = originalClientCore;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('graceful leader handoff preserves old leader local grants until previous-term release', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const source = new RateLimitStore('leader-a');
        const now = Date.now();
        const localGranted = source.acquire(
            'local-r1',
            'bucket',
            { parallel: 1, rpm: 60 },
            { requests: 1, tokens: 0 },
            now
        );
        if (localGranted.kind !== 'granted') {
            assert.fail('local-r1 should be granted');
        }
        const snapshot = source.exportSnapshot(now);

        const originalLeaderStore = rateLimiter.leaderStore;
        const originalPendingLeaderHandoff = rateLimiter.pendingLeaderHandoff;
        const originalClientCore = rateLimiter.clientCore;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            rateLimiter.leaderStore = new RateLimitStore('before');
            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.clientCore = undefined;
            patchedLeaderElection.isLeader = () => true;

            rateLimiter.handleLeaderResigning({
                leaderId: 'leader-a',
                nextLeaderId: 'leader-b',
                rateLimitSnapshot: snapshot
            });
            rateLimiter.becomeLeaderWithFreshState();

            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight, 1);

            rateLimiter.handleRemoteRelease({
                authorityTerm: 'leader-a:1',
                grantId: localGranted.grantId
            });

            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight ?? 0, 0);
        } finally {
            rateLimiter.leaderStore = originalLeaderStore;
            rateLimiter.pendingLeaderHandoff = originalPendingLeaderHandoff;
            rateLimiter.clientCore = originalClientCore;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('graceful leader handoff eventually drops old leader local grants without release', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const source = new RateLimitStore('leader-a');
        const now = Date.now();
        const localGranted = source.acquire(
            'local-r1',
            'bucket',
            { parallel: 1, rpm: 60 },
            { requests: 1, tokens: 0 },
            now
        );
        if (localGranted.kind !== 'granted') {
            assert.fail('local-r1 should be granted');
        }
        const snapshot = source.exportSnapshot(now);

        const originalLeaderStore = rateLimiter.leaderStore;
        const originalPendingLeaderHandoff = rateLimiter.pendingLeaderHandoff;
        const originalClientCore = rateLimiter.clientCore;

        try {
            rateLimiter.leaderStore = new RateLimitStore('before');
            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.clientCore = undefined;

            rateLimiter.handleLeaderResigning({
                leaderId: 'leader-a',
                nextLeaderId: 'leader-b',
                rateLimitSnapshot: snapshot
            });
            rateLimiter.becomeLeaderWithFreshState();

            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight, 1);
            rateLimiter.leaderStore.sweep(now + 6_000);
            assert.equal(rateLimiter.leaderStore.stats('bucket', now + 6_000)?.inflight ?? 0, 0);
        } finally {
            rateLimiter.leaderStore = originalLeaderStore;
            rateLimiter.pendingLeaderHandoff = originalPendingLeaderHandoff;
            rateLimiter.clientCore = originalClientCore;
        }
    });

    test('role loss immediately renews in-flight authoritative grants and shortens heartbeat', async () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;

        const handle: RateLimitHandle = {
            grantId: 'handoff-grant',
            costs: { requests: 1, tokens: 0 },
            leaseMs: 600_000,
            authorityTerm: 'leader-a:1',
            authoritative: true
        };
        const published: Array<{ type: string; payload: unknown }> = [];

        const originalInitialized = rateLimiter.initialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalPublish = patchedBus.publish;

        try {
            rateLimiter.initialized = true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.publish = ((event: { type: string; payload: unknown }) => {
                published.push(event);
            }) as typeof InterInstanceBus.publish;

            rateLimiter.startLeaseHeartbeat(handle);
            rateLimiter.retainAuthoritativeGrantsAfterRoleLoss();

            const immediateRenewals = published.filter(event => event.type === 'rateLimitLeaseRenewed');
            assert.equal(immediateRenewals.length, 1);
            assert.deepEqual(immediateRenewals[0].payload, { authorityTerm: 'leader-a:1', grantId: 'handoff-grant' });
            assert.equal(rateLimiter.activeHandles.has('handoff-grant'), true);

            // 默认心跳间隔为 leaseMs/2（300s），改短后应在 handoff 宽限（5s）内再次续租
            await new Promise(resolve => setTimeout(resolve, 2_800));
            const laterRenewals = published.filter(event => event.type === 'rateLimitLeaseRenewed');
            assert.ok(laterRenewals.length >= 2, 'shortened heartbeat should renew again within the handoff grace');
        } finally {
            rateLimiter.stopLeaseHeartbeat('handoff-grant');
            rateLimiter.initialized = originalInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.publish = originalPublish;
        }
    });

    test('leader takeover restores persisted handoff after restart-like gap', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const source = new RateLimitStore('leader-a');
        const now = Date.now();
        const granted = source.acquire('r1', 'bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'follower-a'
        });
        if (granted.kind !== 'granted') {
            assert.fail('r1 should be granted');
        }
        source.acquire('r2', 'bucket', { parallel: 1 }, { requests: 1, tokens: 0 }, now, {
            ownerInstanceId: 'follower-b'
        });
        const snapshot = source.exportSnapshot(now);
        const state = new Map<string, unknown>();
        const fakeContext = {
            globalState: {
                get: <T>(key: string) => state.get(key) as T | undefined,
                update: (key: string, value: unknown) => {
                    if (value === undefined) {
                        state.delete(key);
                    } else {
                        state.set(key, value);
                    }
                    return Promise.resolve();
                }
            }
        };

        const originalContext = rateLimiter.context;
        const originalLeaderStore = rateLimiter.leaderStore;
        const originalPendingLeaderHandoff = rateLimiter.pendingLeaderHandoff;
        const originalClientCore = rateLimiter.clientCore;

        let settledPending = 0;

        try {
            rateLimiter.context = fakeContext;
            rateLimiter.leaderStore = new RateLimitStore('before');
            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.clientCore = {
                acquire: async () => ({ status: 'cancelled' }),
                settlePendingAsDegraded: () => {
                    settledPending += 1;
                }
            };

            rateLimiter.handleLeaderResigning({
                leaderId: 'leader-a',
                nextLeaderId: 'leader-b',
                rateLimitSnapshot: snapshot
            });

            rateLimiter.pendingLeaderHandoff = undefined;
            rateLimiter.becomeLeaderWithFreshState();

            assert.equal(settledPending, 1);
            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.inflight, 1);
            assert.equal(rateLimiter.leaderStore.stats('bucket', now)?.pending, 0);
            assert.equal(state.get('gcmp.rateLimit.handoff.v1'), undefined);
        } finally {
            rateLimiter.context = originalContext;
            rateLimiter.leaderStore = originalLeaderStore;
            rateLimiter.pendingLeaderHandoff = originalPendingLeaderHandoff;
            rateLimiter.clientCore = originalClientCore;
        }
    });

    test('release still publishes to the granted authority term during transient disconnect', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const handle: RateLimitHandle = {
            grantId: 'grant-1',
            costs: { requests: 1, tokens: 10 },
            leaseMs: 60_000,
            authorityTerm: 'leader-a:1',
            authoritative: true
        };
        const published: Array<{ type: string; payload: unknown; alsoFallback?: boolean }> = [];

        const originalInitialized = rateLimiter.initialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalPublish = patchedBus.publish;

        try {
            rateLimiter.initialized = true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => undefined;
            patchedBus.publish = (event, options) => {
                published.push({
                    type: event.type,
                    payload: event.payload,
                    alsoFallback: options?.alsoFallback
                });
            };

            rateLimiter.release(handle, { tokens: 10 });

            assert.deepEqual(published, [
                {
                    type: 'rateLimitReleased',
                    payload: {
                        authorityTerm: 'leader-a:1',
                        grantId: 'grant-1',
                        refund: { tokens: 10 }
                    },
                    alsoFallback: true
                }
            ]);
        } finally {
            rateLimiter.initialized = originalInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.publish = originalPublish;
        }
    });

    test('renewLease still renews the granted authority term during transient disconnect', () => {
        const rateLimiter = RateLimiter as unknown as RateLimiterInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const handle: RateLimitHandle = {
            grantId: 'grant-1',
            costs: { requests: 1, tokens: 10 },
            leaseMs: 60_000,
            authorityTerm: 'leader-a:1',
            authoritative: true
        };
        const published: Array<{ type: string; payload: unknown; alsoFallback?: boolean }> = [];

        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalPublish = patchedBus.publish;

        try {
            patchedLeaderElection.isLeader = () => false;
            patchedBus.getAuthorityTerm = () => undefined;
            patchedBus.publish = (event, options) => {
                published.push({
                    type: event.type,
                    payload: event.payload,
                    alsoFallback: options?.alsoFallback
                });
            };

            const renewed = rateLimiter.renewLease(handle);

            assert.equal(renewed, true);
            assert.deepEqual(published, [
                {
                    type: 'rateLimitLeaseRenewed',
                    payload: {
                        authorityTerm: 'leader-a:1',
                        grantId: 'grant-1'
                    },
                    alsoFallback: true
                }
            ]);
        } finally {
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.publish = originalPublish;
        }
    });
});
