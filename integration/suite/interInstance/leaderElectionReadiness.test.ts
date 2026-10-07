import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { RateLimiter, type RateLimitHandle } from '../../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../../src/utils/config/configManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../../src/utils/config/failover/balanceAffinityCache';
import {
    RetryProvider,
    createContext,
    defaultRetry,
    slot,
    successResponse,
    trackedCancellation
} from '../balance/retryFixture';

interface LeaderRecord {
    instanceId: string;
    lastHeartbeat: number;
    electedAt: number;
}

interface ElectionState {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    electionPausedUntil: number;
    lastLeaderIdentityKey: string | undefined;
}

interface ElectionInternals extends ElectionState {
    checkLeader(): Promise<void>;
    becomeLeader(force?: boolean): Promise<void>;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

suite('Leader election authority readiness', () => {
    const election = LeaderElectionService as unknown as ElectionInternals;
    const originalNow = Date.now;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalRelease = RateLimiter.release;
    const originalBus = {
        getAuthorityTerm: InterInstanceBus.getAuthorityTerm,
        hasActiveTransport: InterInstanceBus.hasActiveTransport,
        isAuthorityTransitioning: InterInstanceBus.isAuthorityTransitioning,
        publishIpcOnly: InterInstanceBus.publishIpcOnly,
        publish: InterInstanceBus.publish
    };
    let previous: ElectionState;
    let context: vscode.ExtensionContext;
    let now: number;
    let eventTerms: Array<string | undefined>;
    let written: ReturnType<typeof deferred>;

    setup(async () => {
        previous = {
            context: election.context,
            instanceId: election.instanceId,
            initialized: election.initialized,
            agentsWindow: election.agentsWindow,
            _isLeader: election._isLeader,
            ownElectedAt: election.ownElectedAt,
            electionPausedUntil: election.electionPausedUntil,
            lastLeaderIdentityKey: election.lastLeaderIdentityKey
        };
        now = originalNow();
        Date.now = () => now;
        written = deferred();
        eventTerms = [];
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        context = createContext();
        const originalUpdate = context.globalState.update;
        context.globalState.update = async (key: string, value: unknown) => {
            await originalUpdate.call(context.globalState, key, value);
            if (key === 'gcmp.leader.info.v2') {
                written.resolve();
            }
        };
        Object.assign(election, {
            context,
            instanceId: `readiness-${randomUUID()}`,
            initialized: true,
            agentsWindow: false,
            _isLeader: false,
            ownElectedAt: 0,
            electionPausedUntil: 0,
            lastLeaderIdentityKey: undefined
        });
        Object.assign(InterInstanceBus, {
            getAuthorityTerm: () => LeaderElectionService.getOwnedAuthorityTerm(),
            hasActiveTransport: () => false,
            isAuthorityTransitioning: () => false,
            publishIpcOnly: () => false,
            publish: () => {}
        });
        context.subscriptions.push(
            LeaderElectionService.onLeaderChanged(value => {
                if (value) {
                    eventTerms.push(LeaderElectionService.getOwnedAuthorityTerm());
                }
            })
        );
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-election-readiness-')));
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add(slot, { id: 'a', label: 'a', balanceWeight: 1 }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b', balanceWeight: 0 }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        BalanceAffinityCache.instance.clear();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(election, previous);
        Object.assign(InterInstanceBus, originalBus);
        ConfigManager.createProxyAwareFetch = originalFetch;
        RateLimiter.release = originalRelease;
        Date.now = originalNow;
        setBalanceHandoffDirectoryOverride(undefined);
    });

    for (const sdk of ['openai', 'openai-responses'] as const) {
        for (const scenario of [
            'election-control',
            'overlap',
            'overlap-heartbeats',
            'overlap-failover',
            'no-leader-zero'
        ] as const) {
            test(`${sdk}: ${scenario} keeps an unchanged request dispatchable`, async () => {
                if (scenario === 'overlap-failover') {
                    await ConfigSetStore.setSwitchMode(slot, 'failover');
                }
                if (scenario === 'no-leader-zero') {
                    await ConfigSetStore.updateMeta(slot, 'a', { balanceWeight: 0 });
                } else {
                    const pendingElection = election.becomeLeader(true);
                    try {
                        await written.promise;
                        if (scenario !== 'election-control') {
                            await election.checkLeader();
                        }
                    } finally {
                        await pendingElection;
                    }
                }
                const electedAt = context.globalState.get<LeaderRecord>('gcmp.leader.info.v2')?.electedAt;
                if (scenario === 'overlap-heartbeats') {
                    for (let index = 0; index < 3; index++) {
                        now += 5000;
                        await election.checkLeader();
                    }
                }
                const tracked = trackedCancellation();
                const handle: RateLimitHandle = {
                    grantId: randomUUID(),
                    costs: { requests: 1, tokens: 50 },
                    leaseMs: 30_000,
                    authoritative: true,
                    authorityTerm: 'election-readiness:1'
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
                const metadata = JSON.stringify(ConfigSetStore.list(slot));
                const operationToken = ConfigSetStore.getApplyOperationToken(slot);
                try {
                    const result = await RetryProvider.run(sdk, defaultRetry, observed, tracked.token).then(
                        () => ({ state: 'resolved' as const }),
                        (error: unknown) => ({ state: 'rejected' as const, error })
                    );
                    const message =
                        result.state === 'rejected' && result.error instanceof Error ? result.error.message : '';
                    assert.equal(JSON.stringify(ConfigSetStore.list(slot)), metadata);
                    assert.equal(ConfigSetStore.getApplyOperationToken(slot), operationToken);
                    assert.equal(observed.grants, 1);
                    assert.equal(tracked.disposals, tracked.subscriptions);
                    assert.equal(result.state, 'resolved', `Unchanged configuration was rejected: ${message}`);
                    assert.deepEqual(wires, ['Bearer key-a']);
                    assert.deepEqual(refunds, [[handle]]);
                    if (scenario !== 'no-leader-zero' && scenario !== 'overlap-failover') {
                        const expectedTerm = `${election.instanceId}:${electedAt}`;
                        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerm);
                        assert.deepEqual(eventTerms, [expectedTerm]);
                        assert.equal(
                            context.globalState.get<LeaderRecord>('gcmp.leader.info.v2')?.electedAt,
                            electedAt
                        );
                    }
                } finally {
                    tracked.dispose();
                }
            });
        }
    }

    for (const previousTerm of ['missing', 'older'] as const) {
        test(`heartbeat adoption establishes the owned term when the previous term is ${previousTerm}`, async () => {
            election.ownElectedAt = previousTerm === 'older' ? now - 10_000 : 0;
            const electedAt = now - 5000;
            await context.globalState.update('gcmp.leader.info.v2', {
                instanceId: election.instanceId,
                electedAt,
                lastHeartbeat: now
            });
            await election.checkLeader();
            const expectedTerm = `${election.instanceId}:${electedAt}`;
            assert.equal(LeaderElectionService.isLeader(), true);
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerm);
            assert.deepEqual(eventTerms, [expectedTerm]);
            now += 5000;
            await election.checkLeader();
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerm);
            assert.equal(context.globalState.get<LeaderRecord>('gcmp.leader.info.v2')?.electedAt, electedAt);
        });
    }

    test('older election completion adopts the confirmed newer self record, not its own candidate timestamp', async () => {
        const first = election.becomeLeader(true);
        let second: Promise<void> | undefined;
        try {
            await written.promise;
            written = deferred();
            now += 1;
            second = election.becomeLeader(true);
            await written.promise;
            const expectedTerm = `${election.instanceId}:${now}`;
            await first;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerm);
            assert.deepEqual(eventTerms, [expectedTerm]);
            await second;
            assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), expectedTerm);
        } finally {
            await Promise.allSettled([first, ...(second ? [second] : [])]);
        }
    });

    for (const scenario of ['follower', 'older-incumbent', 'newer-incumbent'] as const) {
        test(`${scenario} does not import a foreign electedAt into the owned term`, async () => {
            const wasLeader = scenario !== 'follower';
            election._isLeader = wasLeader;
            election.ownElectedAt = wasLeader ? now - 1000 : 0;
            const originalOwnedAt = election.ownElectedAt;
            const record: LeaderRecord = {
                instanceId: 'foreign-leader',
                electedAt: scenario === 'older-incumbent' ? now - 2000 : now,
                lastHeartbeat: now
            };
            await context.globalState.update('gcmp.leader.info.v2', record);
            await election.checkLeader();
            assert.equal(election.ownElectedAt, originalOwnedAt);
            assert.equal(LeaderElectionService.isLeader(), scenario === 'older-incumbent');
            assert.equal(
                LeaderElectionService.getOwnedAuthorityTerm(),
                scenario === 'older-incumbent' ? `${election.instanceId}:${originalOwnedAt}` : undefined
            );
            assert.deepEqual(eventTerms, []);
        });
    }

    test('paused election does not adopt a visible self candidate', async () => {
        election.electionPausedUntil = now + 5000;
        await context.globalState.update('gcmp.leader.info.v2', {
            instanceId: election.instanceId,
            electedAt: now,
            lastHeartbeat: now
        });
        await election.checkLeader();
        assert.equal(LeaderElectionService.isLeader(), false);
        assert.equal(election.ownElectedAt, 0);
        assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), undefined);
        assert.deepEqual(eventTerms, []);
    });
});
