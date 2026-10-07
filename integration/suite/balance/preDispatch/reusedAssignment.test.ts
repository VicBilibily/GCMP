import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterInstanceBus } from '../../../../src/interInstance';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceAssignmentResolvedEvent,
    ApiKeyBalanceLeaseReleasedEvent
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
    identity,
    slot,
    successResponse,
    trackedCancellation
} from '../retryFixture';

type AssignmentRequest = ApiKeyBalanceAssignmentRequestedEvent['payload'];
type Assignment = ApiKeyBalanceAssignmentResolvedEvent['payload'];
const term = 'reused-assignment:1';
const followerId = 'reused-follower';

suite('balance reused assignment boundaries', () => {
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
    const originalCapture = ApiKeyFailoverManager.captureAttempt;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalGetSaved = ConfigSetStore.getApiKey;
    const originalGetPrimary = ApiKeyManager.getApiKey;
    const originalRelease = RateLimiter.release;
    const originalNow = Date.now;
    const manager = ApiKeyFailoverManager as unknown as {
        pendingBalanceAssignments: Map<string, unknown>;
        balanceAttemptSnapshots: Map<string, unknown>;
        balanceLeaseRenewalTimers: Map<string, unknown>;
    };
    let context: ReturnType<typeof createContext>;
    let leader: boolean;
    let operations: Promise<void>[];
    let requests: AssignmentRequest[];
    let replies: Assignment[];
    let releases: ApiKeyBalanceLeaseReleasedEvent['payload'][];

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-reused-assignment-')));
        leader = true;
        operations = [];
        requests = [];
        replies = [];
        releases = [];
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => leader,
            isAgentsWindow: () => false,
            getOwnedAuthorityTerm: () => (leader ? term : undefined),
            getAuthorityTerm: () => term,
            getInstanceId: () => (leader ? 'reused-leader' : followerId)
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.isAuthorityTransitioning = () => false;
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'A', balanceWeight: 0 }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'B', balanceWeight: 1 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
        await ApiKeyFailoverManager.becomeBalanceAuthority(term);
        InterInstanceBus.publishIpcOnly = () => true;
    });

    teardown(async () => {
        await Promise.allSettled(operations);
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        setBalanceHandoffDirectoryOverride(undefined);
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        Object.assign(InterInstanceBus, originalBus);
        ApiKeyFailoverManager.captureAttempt = originalCapture;
        ConfigManager.createProxyAwareFetch = originalFetch;
        ConfigSetStore.getApiKey = originalGetSaved;
        ApiKeyManager.getApiKey = originalGetPrimary;
        RateLimiter.release = originalRelease;
        Date.now = originalNow;
    });

    function follow(reply: (request: AssignmentRequest) => Promise<Assignment | undefined>) {
        leader = false;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type === 'apiKeyBalanceAssignmentRequested') {
                const request = event.payload as AssignmentRequest;
                requests.push(request);
                operations.push(
                    (async () => {
                        leader = true;
                        try {
                            const resolved = await reply(request);
                            leader = false;
                            assert.ok(resolved);
                            replies.push(resolved);
                            ApiKeyFailoverManager.resolveBalanceAssignment(resolved);
                        } finally {
                            leader = false;
                        }
                    })()
                );
            } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                releases.push(event.payload as ApiKeyBalanceLeaseReleasedEvent['payload']);
            }
            return true;
        };
    }

    for (const sdkMode of ['openai', 'openai-responses'] as const) {
        for (const action of [
            'valid-zero-lease',
            'unmatched-primary',
            'expired-during-read',
            'released-during-read'
        ] as const) {
            test(`${sdkMode}: repeated assignment preserves ${action} dispatch and refund rules`, async () => {
                const seeded: AssignmentRequest = {
                    requestId: `${sdkMode}-${action}`,
                    requestedBy: followerId,
                    authorityTerm: term,
                    slot,
                    balanceKey
                };
                const initial = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(seeded, followerId);
                assert.ok(initial?.leaseId);
                assert.equal(initial.configId, 'b');
                await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 });
                if (action === 'unmatched-primary') {
                    await ApiKeyManager.setApiKey(slot, 'outside-key');
                }
                ApiKeyFailoverManager.captureAttempt = (...args) =>
                    originalCapture.call(
                        ApiKeyFailoverManager,
                        args[0],
                        args[1],
                        seeded.requestId,
                        args[3],
                        args[4],
                        args[5]
                    );
                if (action.endsWith('during-read')) {
                    let reads = 0;
                    ConfigSetStore.getApiKey = async (...args) => {
                        const key = await originalGetSaved.apply(ConfigSetStore, args);
                        if (++reads === 3) {
                            if (action === 'expired-during-read') {
                                Date.now = () => initial.expiresAt! + 1;
                            } else {
                                ApiKeyFailoverManager.releaseBalanceLease(initial.leaseId!, term);
                            }
                        }
                        return key;
                    };
                }
                follow(request => ApiKeyFailoverManager.handleBalanceAssignmentRequest(request, followerId));
                let primaryReads = 0;
                ApiKeyManager.getApiKey = async (...args) => {
                    primaryReads++;
                    return originalGetPrimary.apply(ApiKeyManager, args);
                };
                const authorizations: Array<string | null> = [];
                ConfigManager.createProxyAwareFetch = () => async (input, init) => {
                    authorizations.push(new Request(input, init).headers.get('authorization'));
                    return successResponse(sdkMode);
                };
                const handle: RateLimitHandle = {
                    grantId: seeded.requestId,
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: term
                };
                const refunds: Array<Parameters<typeof RateLimiter.release>> = [];
                RateLimiter.release = (...args) => refunds.push(args);
                const observed = { grants: 0, handle };
                const tracked = trackedCancellation();
                try {
                    const pending = RetryProvider.run(sdkMode, defaultRetry, observed, tracked.token);
                    if (action === 'valid-zero-lease') {
                        await pending;
                        assert.deepEqual(authorizations, ['Bearer key-b']);
                        assert.equal(replies[0]?.leaseId, initial.leaseId);
                        assert.notEqual(replies[0]?.assignmentInvalidated, true);
                        assert.deepEqual(refunds, [[handle]]);
                    } else {
                        await assert.rejects(pending, /Configuration changed while capturing/);
                        assert.deepEqual(authorizations, []);
                        assert.equal(replies[0]?.handled, false);
                        assert.equal(replies[0]?.assignmentInvalidated, true);
                        assert.notEqual(replies[0]?.weightBlocked, true);
                        assert.equal(primaryReads, 1, 'Only the Leader pool read may access the primary key');
                        assert.deepEqual(refunds, [[handle, handle.costs]]);
                    }
                    await Promise.all(operations);
                    assert.equal(requests.length, 1);
                    assert.equal(observed.grants, 1);
                    assert.equal(manager.pendingBalanceAssignments.size, 0);
                    assert.equal(manager.balanceAttemptSnapshots.size, 0);
                    assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    assert.equal(
                        await originalGetPrimary.call(ApiKeyManager, slot),
                        action === 'unmatched-primary' ? 'outside-key' : 'key-a'
                    );
                } finally {
                    tracked.dispose();
                }
            });
        }
    }

    for (const handled of [false, true]) {
        test(`invalidated response with handled:${handled} never starts primary or assigned-key I/O`, async () => {
            follow(async request => ({
                requestId: request.requestId,
                targetInstanceId: followerId,
                authorityTerm: term,
                handled,
                assignmentInvalidated: true,
                leaseId: 'invalid-response-lease',
                configId: 'b',
                credentialId: identity('key-b'),
                expiresAt: Date.now() + 30_000
            }));
            let keyReads = 0;
            ApiKeyManager.getApiKey = async () => {
                keyReads++;
                throw new Error('Primary fallback must not be read');
            };
            ConfigSetStore.getApiKey = async () => {
                keyReads++;
                throw new Error('Invalidated assigned key must not be read');
            };
            let fallbacks = 0;
            const tracked = trackedCancellation();
            try {
                assert.equal(
                    await ApiKeyFailoverManager.captureAttempt(
                        slot,
                        balanceKey,
                        'invalid-response',
                        undefined,
                        tracked.token,
                        () => fallbacks++
                    ),
                    undefined
                );
                await Promise.all(operations);
                assert.equal(keyReads, 0);
                assert.equal(fallbacks, 0);
                assert.deepEqual(releases, [{ leaseId: 'invalid-response-lease', authorityTerm: term }]);
                assert.equal(manager.pendingBalanceAssignments.size, 0);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }

    for (const source of ['empty-leader-pool', 'legacy-unhandled', 'explicit-valid', 'no-transport'] as const) {
        test(`normal fallback remains available for a zero-weight primary: ${source}`, async () => {
            await ConfigSetStore.updateMeta(slot, 'b', { balanceWeight: 0 });
            if (source === 'empty-leader-pool') {
                await ConfigSetStore.remove(slot, 'a');
                await ConfigSetStore.remove(slot, 'b');
                follow(request => ApiKeyFailoverManager.handleBalanceAssignmentRequest(request, followerId));
            } else {
                follow(async request => ({
                    requestId: request.requestId,
                    targetInstanceId: followerId,
                    authorityTerm: term,
                    handled: false,
                    ...(source === 'explicit-valid' ? { assignmentInvalidated: false } : {})
                }));
                if (source === 'no-transport') {
                    InterInstanceBus.hasActiveTransport = () => false;
                }
            }
            let snapshot: string | undefined;
            const tracked = trackedCancellation();
            try {
                assert.equal(
                    await ApiKeyFailoverManager.captureAttempt(
                        slot,
                        balanceKey,
                        'normal-fallback',
                        undefined,
                        tracked.token,
                        value => {
                            snapshot = value.apiKey;
                        }
                    ),
                    undefined
                );
                await Promise.all(operations);
                assert.equal(snapshot, 'key-a');
                assert.notEqual(replies[0]?.assignmentInvalidated, true);
                assert.equal(tracked.disposals, tracked.subscriptions);
            } finally {
                tracked.dispose();
            }
        });
    }
});
