import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { setCrossInstanceBroadcaster } from '../../../src/handlers/liveMetrics';
import { InterInstanceBus } from '../../../src/interInstance';
import { registerInterInstanceHandlers } from '../../../src/interInstance/activation';
import type { ApiKeyBalanceLeaseHandoff, LeaderResigningEvent } from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { AtomicJsonFile } from '../../../src/usages/atomicJsonFile';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { readBalanceLeaseHandoff } from '../../../src/utils/config/failover/balanceLeaseHandoffFile';
import { createContext, identity } from '../balance/retryFixture';

interface ElectionInternals {
    context: vscode.ExtensionContext | undefined;
    instanceId: string;
    initialized: boolean;
    agentsWindow: boolean;
    _isLeader: boolean;
    ownElectedAt: number;
    electionPausedUntil: number;
    resignationPromise: Promise<'resigned' | 'not-leader' | 'no-follower'> | undefined;
    lastLeaderIdentityKey: string | undefined;
    rateLimitSnapshotProvider: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[0];
    rateLimitSnapshotValidator: Parameters<typeof LeaderElectionService.setRateLimitSnapshotProvider>[1];
    balanceLeaseSnapshotProvider: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[0];
    balanceLeaseSnapshotValidator: Parameters<typeof LeaderElectionService.setBalanceLeaseSnapshotProvider>[1];
}

const election = LeaderElectionService as unknown as ElectionInternals;
const manager = ApiKeyFailoverManager as unknown as {
    balanceLeases: Map<string, ApiKeyBalanceLeaseHandoff['leases'][number] & { authorityTerm: string }>;
    balanceResigningTerm: string | undefined;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    persistBalanceLeases: (authorityTerm?: string, strict?: boolean) => Promise<void>;
};
const leaderKey = 'gcmp.leader.info.v2';
const oldTerm = 'leader-old:100000';
const nextTerm = 'follower-first:100001';
const balanceKey = Array.from({ length: 100 }, (_, index) => `s:empty-handoff-${index}`).find(
    value => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 2 === 0
);
assert.ok(balanceKey);

suite('负载均衡空快照交接', () => {
    const originalNow = Date.now;
    const originalWrite = AtomicJsonFile.writeJsonAtomically;
    const originalBus = {
        getConnectedFollowerIds: InterInstanceBus.getConnectedFollowerIds,
        getEligibleFollowerIds: InterInstanceBus.getEligibleFollowerIds,
        publishIpcOnly: InterInstanceBus.publishIpcOnly
    };
    let previousElection: ElectionInternals;
    let context: vscode.ExtensionContext;
    let now: number;
    let events: Array<Parameters<typeof InterInstanceBus.publishIpcOnly>[0]>;

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
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
        now = 100_000;
        Date.now = () => now;
        context = createContext();
        events = [];
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-empty-handoff-')));
        await context.globalState.update(leaderKey, {
            instanceId: 'leader-old',
            electedAt: now,
            lastHeartbeat: now
        });
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
            rateLimitSnapshotProvider: undefined,
            rateLimitSnapshotValidator: undefined
        });
        InterInstanceBus.getConnectedFollowerIds = () => ['follower-first'];
        InterInstanceBus.getEligibleFollowerIds = () => ['follower-first'];
        InterInstanceBus.publishIpcOnly = event => {
            events.push(event);
            return true;
        };
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b']) {
            await ConfigSetStore.add('slot', { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive('slot', 'a');
        await ApiKeyManager.setApiKey('slot', 'key-a');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        registerInterInstanceHandlers(context);
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        Object.assign(LeaderElectionService, previousElection);
        Object.assign(InterInstanceBus, originalBus);
        Date.now = originalNow;
        setBalanceHandoffDirectoryOverride(undefined);
        setCrossInstanceBroadcaster(undefined);
        assert.equal(manager.balanceLeases.size, 0);
        assert.equal(manager.balanceLeaseRenewalTimers.size, 0);
    });

    test('空状态校验区分显式快照和缺失快照，时钟变化不改变版本', () => {
        const snapshot = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
        assert.ok(snapshot);
        assert.deepEqual(snapshot.leases, []);
        assert.ok(snapshot.revision);
        assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(snapshot), true);
        assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(undefined), false);
        now++;
        assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(snapshot), true);
        assert.equal(ApiKeyFailoverManager.exportBalanceLeaseHandoff(true)?.revision, snapshot.revision);
    });

    test('没有所属任期时不生成空交接快照', async () => {
        const snapshot = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
        assert.ok(snapshot);
        election._isLeader = false;
        assert.equal(ApiKeyFailoverManager.exportBalanceLeaseHandoff(true), undefined);
        assert.equal(await ApiKeyFailoverManager.prepareBalanceLeaseHandoff(), undefined);
        assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(undefined), true);
        assert.equal(ApiKeyFailoverManager.isBalanceLeaseHandoffCurrent(snapshot), false);
    });

    for (const manual of [false, true]) {
        for (const delta of [0, 1]) {
            for (const lastLease of [false, true]) {
                for (const denied of [false, true]) {
                    for (const origin of ['local', 'remote'] as const) {
                        test(`释放租约后发布并恢复最新状态：${manual}, ${delta}, ${lastLease}, ${denied}, ${origin}`, async () => {
                            const owner = origin === 'local' ? 'leader-old' : 'follower-first';
                            const initialIds = lastLease ? ['a'] : ['a', 'b'];
                            for (const id of initialIds) {
                                const leaseId = `empty-${id}`;
                                manager.balanceLeases.set(leaseId, {
                                    leaseId,
                                    slot: 'slot',
                                    balanceKey: `s:${leaseId}`,
                                    configId: id,
                                    credentialId: identity(`key-${id}`),
                                    ownerInstanceId: owner,
                                    expiresAt: now + 25_000,
                                    authorityTerm: oldTerm
                                });
                            }
                            await manager.persistBalanceLeases(oldTerm, true);
                            const diskBefore = await readBalanceLeaseHandoff();
                            assert.equal(diskBefore?.sourceAuthorityTerm, oldTerm);
                            assert.equal(diskBefore?.leases.length, initialIds.length);
                            const oldFile = createHash('sha256').update(oldTerm).digest('hex') + '.json';
                            const storageError = Object.assign(new Error('empty handoff storage denied'), {
                                code: 'EACCES'
                            });
                            let rejectedWrites = 0;
                            AtomicJsonFile.writeJsonAtomically = async (...args) => {
                                if (denied && args[0].endsWith(oldFile)) {
                                    rejectedWrites++;
                                    throw storageError;
                                }
                                return originalWrite.apply(AtomicJsonFile, args);
                            };
                            now += delta;
                            const releasedId = lastLease ? 'empty-a' : 'empty-b';
                            if (origin === 'local') {
                                ApiKeyFailoverManager.releaseBalanceLease(releasedId, oldTerm);
                            } else {
                                ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
                                    { leaseId: releasedId, authorityTerm: oldTerm },
                                    owner
                                );
                            }
                            const live = ApiKeyFailoverManager.exportBalanceLeaseHandoff(true);
                            assert.ok(live);
                            assert.equal(live.leases.length, lastLease ? 0 : 1);
                            if (manual && denied) {
                                await assert.rejects(
                                    LeaderElectionService.resignLeadership(),
                                    error => error === storageError
                                );
                                assert.equal(LeaderElectionService.getOwnedAuthorityTerm(), oldTerm);
                                assert.equal(election.electionPausedUntil, 0);
                                assert.equal(manager.balanceResigningTerm, undefined);
                                assert.equal(events.filter(event => event.type === 'leaderResigning').length, 0);
                                assert.equal(rejectedWrites, 2);
                                return;
                            }
                            if (manual) {
                                assert.equal(await LeaderElectionService.resignLeadership(), 'resigned');
                            } else {
                                await LeaderElectionService.stop();
                            }
                            AtomicJsonFile.writeJsonAtomically = originalWrite;
                            assert.equal(context.globalState.get(leaderKey), undefined);
                            assert.equal(LeaderElectionService.isLeader(), false);
                            const published = events.filter(event => event.type === 'leaderResigning');
                            assert.equal(published.length, 1);
                            const event = published[0] as Omit<LeaderResigningEvent, 'timestamp' | 'senderInstanceId'>;
                            assert.equal(event.payload.reason, manual ? 'manual' : 'shutdown');
                            assert.equal(event.payload.sourceAuthorityTerm, oldTerm);
                            assert.equal(
                                JSON.stringify(await readBalanceLeaseHandoff()),
                                JSON.stringify(denied ? diskBefore : live)
                            );
                            const serialized = JSON.stringify(event);
                            const received = JSON.parse(serialized) as typeof event;
                            ApiKeyFailoverManager.handleBalanceAuthorityLost();
                            if (received.payload.balanceLeaseSnapshot) {
                                ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                                    received.payload.balanceLeaseSnapshot,
                                    received.payload.leaderId,
                                    received.payload.nextLeaderId,
                                    oldTerm,
                                    now
                                );
                            }
                            await context.globalState.update(leaderKey, {
                                instanceId: 'follower-first',
                                electedAt: 100001,
                                lastHeartbeat: now
                            });
                            Object.assign(election, {
                                instanceId: 'follower-first',
                                ownElectedAt: 100001,
                                initialized: true,
                                _isLeader: true,
                                electionPausedUntil: 0
                            });
                            await ApiKeyFailoverManager.becomeBalanceAuthority(nextTerm);
                            assert.deepEqual(
                                [...manager.balanceLeases.values()].map(lease => ({
                                    id: lease.leaseId,
                                    expiresAt: lease.expiresAt
                                })),
                                live.leases.map(lease => ({ id: lease.leaseId, expiresAt: lease.expiresAt }))
                            );
                            const restored = await readBalanceLeaseHandoff();
                            assert.equal(restored?.sourceAuthorityTerm, nextTerm);
                            assert.equal(JSON.stringify(restored?.leases), JSON.stringify(live.leases));
                            const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'empty-next');
                            assert.equal(next?.activeId, lastLease ? 'a' : 'b');
                            assert.ok(received.payload.balanceLeaseSnapshot);
                            assert.equal(JSON.stringify(received.payload.balanceLeaseSnapshot), JSON.stringify(live));
                            assert.equal(JSON.stringify(event), serialized);
                            assert.equal(rejectedWrites, denied ? 2 : 0);
                        });
                    }
                }
            }
        }
    }
});
