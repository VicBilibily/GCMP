import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { InterInstanceBus } from '../../src/interInstance';
import { RateLimiter, type RateLimitHandle } from '../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../src/status/leaderElectionService';

interface RateLimiterInternals {
    acquireForCurrentRole: (
        bucketKey: string,
        dims: { rpm: number },
        costs: { requests: number; tokens: number },
        options?: unknown,
        authorityChangeAttempts?: number
    ) => Promise<RateLimitHandle | undefined>;
    acquireViaIpc: (...args: unknown[]) => Promise<RateLimitHandle | undefined>;
    acquireViaLocalStore: (...args: unknown[]) => Promise<RateLimitHandle | undefined>;
    release: (handle: RateLimitHandle, refund?: { requests?: number; tokens?: number }) => void;
    renewLease: (handle: RateLimitHandle) => boolean;
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
