import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InterInstanceBus } from '../../../src/interInstance';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../../src/utils/config/failover/apiKeyFailoverManager';
import { createContext, identity, slot } from './retryFixture';

suite('balance previous turn selection', () => {
    const originalElection = {
        isInitialized: LeaderElectionService.isInitialized,
        isLeader: LeaderElectionService.isLeader,
        getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm,
        getInstanceId: LeaderElectionService.getInstanceId
    };
    const originalAuthorityTerm = InterInstanceBus.getAuthorityTerm;
    let context: ReturnType<typeof createContext>;
    const term = 'turn-selection-leader:1';

    setup(async () => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-turn-selection-')));
        Object.assign(LeaderElectionService, {
            isInitialized: () => true,
            isLeader: () => true,
            getOwnedAuthorityTerm: () => term,
            getInstanceId: () => 'turn-selection-leader'
        });
        InterInstanceBus.getAuthorityTerm = () => term;
        context = createContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        for (const id of ['a', 'b', 'c']) {
            await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
        }
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setSwitchMode(slot, 'balance');
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(undefined);
        for (const disposable of context.subscriptions) {
            disposable.dispose();
        }
        Object.assign(LeaderElectionService, originalElection);
        InterInstanceBus.getAuthorityTerm = originalAuthorityTerm;
    });

    for (const action of [
        'idle',
        'busy-alternatives',
        'alias',
        'removed',
        'isolated',
        'only-previous',
        'all-isolated',
        'single-key',
        'current-affinity'
    ] as const) {
        test(`Leader respects previous-turn avoidance and availability: ${action}`, async () => {
            const balanceKey = 'm:session:turn:5';
            const previous = identity('key-a');
            if (action === 'alias') {
                await ConfigSetStore.add(slot, { id: 'alias', label: 'alias' }, 'key-a');
            }
            if (action === 'removed') {
                await ConfigSetStore.remove(slot, 'a');
                await ConfigSetStore.setActive(slot, 'b');
                await ApiKeyManager.setApiKey(slot, 'key-b');
            }
            if (action === 'single-key') {
                await ConfigSetStore.remove(slot, 'b');
                await ConfigSetStore.remove(slot, 'c');
            }
            for (const id of ['a', 'b', 'c']) {
                if (action === 'busy-alternatives' && id !== 'a') {
                    const busy = await ApiKeyFailoverManager.captureAttempt(
                        slot,
                        `busy-${id}`,
                        `busy-${id}`,
                        identity(`key-${id}`)
                    );
                    assert.equal(busy?.identity, identity(`key-${id}`));
                }
                if (
                    action === 'all-isolated' ||
                    (action === 'only-previous' && id !== 'a') ||
                    (action === 'isolated' && id === 'a')
                ) {
                    await ConfigSetStore.addBalanceExclusion(slot, balanceKey, identity(`key-${id}`), Date.now(), term);
                }
            }
            const attempt = await ApiKeyFailoverManager.captureAttempt(
                slot,
                balanceKey,
                'new-turn',
                action === 'current-affinity' ? previous : undefined,
                previous
            );
            if (action === 'single-key') {
                assert.equal(attempt, undefined);
                assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
                return;
            }
            assert.ok(attempt?.balanceLeaseId);
            if (action === 'only-previous' || action === 'current-affinity') {
                assert.equal(attempt.identity, previous);
            } else {
                assert.notEqual(attempt.identity, previous);
            }
            const repeated = await ApiKeyFailoverManager.captureAttempt(
                slot,
                balanceKey,
                'new-turn',
                undefined,
                previous
            );
            assert.equal(repeated?.balanceLeaseId, attempt.balanceLeaseId);
            assert.equal(repeated?.identity, attempt.identity);
            ApiKeyFailoverManager.releaseBalanceLease(attempt.balanceLeaseId);
        });
    }

    test('Leader applies a Follower avoidance hint without creating a permanent exclusion', async () => {
        const balanceKey = 'm:session:turn:5';
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'follower-new-turn',
                requestedBy: 'turn-follower',
                authorityTerm: term,
                slot,
                balanceKey,
                previousCredentialId: identity('key-a')
            },
            'turn-follower'
        );
        assert.equal(assigned?.handled, true);
        assert.notEqual(assigned?.credentialId, identity('key-a'));
        assert.deepEqual(ConfigSetStore.getBalanceExclusions(slot), []);
        const repeated = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'follower-new-turn',
                requestedBy: 'turn-follower',
                authorityTerm: term,
                slot,
                balanceKey,
                previousCredentialId: identity('key-a')
            },
            'turn-follower'
        );
        assert.equal(repeated?.leaseId, assigned?.leaseId);
        assert.equal(repeated?.credentialId, assigned?.credentialId);
        assert.ok(assigned?.leaseId);
        ApiKeyFailoverManager.releaseBalanceLease(assigned.leaseId);
    });
});
