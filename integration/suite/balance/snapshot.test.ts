import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../../src/interInstance';
import type {
    ApiKeyBalanceAssignmentRequestedEvent,
    ApiKeyBalanceLeaseHandoff,
    ApiKeyBalanceLeaseReleasedEvent
} from '../../../src/interInstance/eventProtocol';
import { setBalanceHandoffDirectoryOverride } from '../../../src/interInstance/pathResolver';
import { LeaderElectionService } from '../../../src/status/leaderElectionService';
import { ApiKeyManager } from '../../../src/utils/config/apiKeyManager';
import { ConfigSetStore } from '../../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt
} from '../../../src/utils/config/failover/apiKeyFailoverManager';

function createContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        globalState: {
            get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) : fallback) as T,
            keys: () => [...state.keys()],
            async update(key: string, value: unknown) {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, structuredClone(value));
                }
            }
        },
        subscriptions: [],
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            },
            onDidChange: () => ({ dispose() {} })
        }
    } as unknown as vscode.ExtensionContext;
}

const balanceKey = Array.from({ length: 100 }, (_, index) => `s:cache-${index}`).find(
    value => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % 3 === 1
);
assert.ok(balanceKey);
const manager = ApiKeyFailoverManager as unknown as {
    balanceLeases: Map<string, { configId: string }>;
    balanceLeaseRenewalTimers: Map<string, NodeJS.Timeout>;
    balanceAttemptSnapshots: Map<string, { slot: string; attempt: ApiKeyFailoverAttempt }>;
};

for (const source of ['leader', 'follower'] as const) {
    suite(`balance fresh snapshot credentials: ${source}`, () => {
        const originalLeader = LeaderElectionService.isLeader;
        const originalInitialized = LeaderElectionService.isInitialized;
        const originalAgents = LeaderElectionService.isAgentsWindow;
        const originalInstanceId = LeaderElectionService.getInstanceId;
        const originalOwnedTerm = LeaderElectionService.getOwnedAuthorityTerm;
        const originalElectionTerm = LeaderElectionService.getAuthorityTerm;
        const originalAuthorityTerm = InterInstanceBus.getAuthorityTerm;
        const originalHasTransport = InterInstanceBus.hasActiveTransport;
        const originalTransitioning = InterInstanceBus.isAuthorityTransitioning;
        const originalPublish = InterInstanceBus.publishIpcOnly;
        const originalGetApiKey = ConfigSetStore.getApiKey;
        const originalNow = Date.now;
        let context: vscode.ExtensionContext;
        let now: number;
        let authorityTerm: string;
        let assignmentCount: number;
        const remoteLeases = new Set<string>();
        const releases: Array<{ leaseId: string; authorityTerm: string }> = [];

        setup(async () => {
            ApiKeyFailoverManager.handleBalanceAuthorityLost();
            setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-cache-suite-')));
            context = createContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            now = originalNow();
            Date.now = () => now;
            authorityTerm = 'cache-leader:1';
            assignmentCount = 0;
            remoteLeases.clear();
            releases.length = 0;
            LeaderElectionService.isLeader = () => source === 'leader';
            LeaderElectionService.isInitialized = () => true;
            LeaderElectionService.isAgentsWindow = () => false;
            LeaderElectionService.getInstanceId = () => 'cache-instance';
            LeaderElectionService.getOwnedAuthorityTerm = () => (source === 'leader' ? authorityTerm : undefined);
            LeaderElectionService.getAuthorityTerm = () => authorityTerm;
            InterInstanceBus.getAuthorityTerm = () => authorityTerm;
            InterInstanceBus.hasActiveTransport = () => true;
            InterInstanceBus.isAuthorityTransitioning = () => false;
            InterInstanceBus.publishIpcOnly = event => {
                if (event.type === 'apiKeyBalanceAssignmentRequested') {
                    const payload = event.payload as ApiKeyBalanceAssignmentRequestedEvent['payload'];
                    const config =
                        ConfigSetStore.list('slot').find(item => item.id === 'b') ??
                        ConfigSetStore.list('slot').find(item => item.id === 'c');
                    assert.ok(config);
                    const leaseId = `remote-lease-${++assignmentCount}`;
                    remoteLeases.add(leaseId);
                    void originalGetApiKey.call(ConfigSetStore, 'slot', config.id).then(apiKey => {
                        assert.ok(apiKey);
                        ApiKeyFailoverManager.resolveBalanceAssignment({
                            requestId: payload.requestId,
                            targetInstanceId: 'cache-instance',
                            authorityTerm,
                            handled: true,
                            configId: config.id,
                            credentialId: createHash('sha256')
                                .update(`${apiKey}\u0000${config.site ?? ''}`)
                                .digest('hex'),
                            leaseId,
                            site: config.site,
                            expiresAt: now + 30_000
                        });
                    });
                } else if (event.type === 'apiKeyBalanceLeaseReleased') {
                    const payload = event.payload as ApiKeyBalanceLeaseReleasedEvent['payload'];
                    releases.push(payload);
                    remoteLeases.delete(payload.leaseId);
                }
                return true;
            };
            for (const id of ['a', 'b', 'c']) {
                await ConfigSetStore.add('slot', { id, label: id }, `key-${id}`);
            }
            await ConfigSetStore.setActive('slot', 'a');
            await ApiKeyManager.setApiKey('slot', 'key-a');
            await ConfigSetStore.setSwitchMode('slot', 'balance');
        });

        teardown(() => {
            for (const disposable of context.subscriptions) {
                disposable.dispose();
            }
            ApiKeyFailoverManager.handleBalanceAuthorityLost();
            LeaderElectionService.isLeader = originalLeader;
            LeaderElectionService.isInitialized = originalInitialized;
            LeaderElectionService.isAgentsWindow = originalAgents;
            LeaderElectionService.getInstanceId = originalInstanceId;
            LeaderElectionService.getOwnedAuthorityTerm = originalOwnedTerm;
            LeaderElectionService.getAuthorityTerm = originalElectionTerm;
            InterInstanceBus.getAuthorityTerm = originalAuthorityTerm;
            InterInstanceBus.hasActiveTransport = originalHasTransport;
            InterInstanceBus.isAuthorityTransitioning = originalTransitioning;
            InterInstanceBus.publishIpcOnly = originalPublish;
            ConfigSetStore.getApiKey = originalGetApiKey;
            Date.now = originalNow;
            setBalanceHandoffDirectoryOverride(undefined);
        });

        for (const action of [
            'unchanged',
            'other-slot',
            'same-key',
            'rename-label',
            'alias',
            'replace-key',
            'remove-config',
            'remove-with-orphan-key',
            'replace-site'
        ] as const) {
            test(`fresh retry preserves only valid credentials: ${action}`, async () => {
                const before = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'request-cache');
                assert.ok(before?.balanceLeaseId);
                assert.equal(before.activeId, 'b');
                ApiKeyFailoverManager.startBalanceLeaseHeartbeat(before, 'slot');
                now += 1;
                if (action === 'other-slot') {
                    await ConfigSetStore.setApiKey('other', 'x', 'unrelated');
                } else if (action === 'same-key' || action === 'replace-key') {
                    await ConfigSetStore.setApiKey('slot', 'b', action === 'same-key' ? 'key-b' : 'replacement-key');
                } else if (action === 'rename-label') {
                    await ConfigSetStore.updateMeta('slot', 'b', { label: 'renamed' });
                } else if (action === 'alias') {
                    await ConfigSetStore.add('slot', { id: 'alias-b', label: 'alias' }, 'key-b');
                } else if (action === 'remove-config' || action === 'remove-with-orphan-key') {
                    await ConfigSetStore.remove('slot', 'b');
                    if (action === 'remove-with-orphan-key') {
                        await context.secrets.store('configSet.slot.b', 'key-b');
                    }
                    assert.equal(await ApiKeyFailoverManager.disableIfUnavailable('slot'), false);
                } else if (action === 'replace-site') {
                    await ConfigSetStore.remove('slot', 'b');
                    await ConfigSetStore.add('slot', { id: 'b', label: 'b', site: 'replacement-site' }, 'key-b');
                }
                const after = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'request-cache');
                assert.ok(after?.balanceLeaseId);
                const target = ConfigSetStore.list('slot').find(item => item.id === after.activeId);
                assert.ok(target, 'retry must use a configuration that still exists');
                assert.equal(after.apiKey, await originalGetApiKey.call(ConfigSetStore, 'slot', target.id));
                assert.equal(after.site, target.site);
                if (action.startsWith('replace-') || action.startsWith('remove-')) {
                    assert.notEqual(after.identity, before.identity);
                    assert.notEqual(after.balanceLeaseId, before.balanceLeaseId);
                    assert.equal(manager.balanceLeaseRenewalTimers.has(before.balanceLeaseId), false);
                    assert.equal(manager.balanceLeases.has(before.balanceLeaseId), false);
                    if (source === 'follower') {
                        assert.deepEqual(releases, [{ leaseId: before.balanceLeaseId, authorityTerm }]);
                        assert.deepEqual([...remoteLeases], [after.balanceLeaseId]);
                        assert.equal(assignmentCount, 2);
                    } else {
                        assert.equal(manager.balanceLeases.size, 1);
                    }
                } else {
                    assert.strictEqual(after, before);
                    assert.equal(manager.balanceLeaseRenewalTimers.has(before.balanceLeaseId), true);
                    assert.deepEqual(releases, []);
                    if (source === 'follower') {
                        assert.equal(assignmentCount, 1);
                    }
                }
                assert.strictEqual(manager.balanceAttemptSnapshots.get('request-cache')?.attempt, after);
            });
        }

        if (source === 'leader') {
            for (const origin of ['local', 'remote'] as const) {
                for (const action of [
                    'unchanged',
                    'other-slot',
                    'same-key',
                    'rename-label',
                    'alias',
                    'replace-key',
                    'remove-config',
                    'remove-with-orphan-key',
                    'replace-site'
                ] as const) {
                    test(`renewed lease validates current credentials: ${origin}, ${action}`, async () => {
                        const capture = async () => {
                            if (origin === 'local') {
                                return ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'request-renewed');
                            }
                            const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
                                {
                                    requestId: 'request-renewed',
                                    requestedBy: 'cache-follower',
                                    authorityTerm,
                                    slot: 'slot',
                                    balanceKey
                                },
                                'cache-follower'
                            );
                            return assigned?.handled ?
                                    {
                                        activeId: assigned.configId,
                                        identity: assigned.credentialId,
                                        site: assigned.site,
                                        balanceLeaseId: assigned.leaseId
                                    }
                                :   undefined;
                        };
                        const before = await capture();
                        assert.ok(before?.balanceLeaseId);
                        assert.equal(before.activeId, 'b');
                        now += 20_000;
                        if (origin === 'local') {
                            ApiKeyFailoverManager.renewBalanceLease(before.balanceLeaseId, authorityTerm);
                        } else {
                            ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
                                { leaseId: before.balanceLeaseId, authorityTerm },
                                'cache-follower'
                            );
                        }
                        now += 11_000;
                        if (action === 'other-slot') {
                            await ConfigSetStore.setApiKey('other', 'x', 'unrelated');
                        } else if (action === 'same-key' || action === 'replace-key') {
                            await ConfigSetStore.setApiKey('slot', 'b', action === 'same-key' ? 'key-b' : 'new-key');
                        } else if (action === 'rename-label') {
                            await ConfigSetStore.updateMeta('slot', 'b', { label: 'renamed' });
                        } else if (action === 'alias') {
                            await ConfigSetStore.add('slot', { id: 'alias-b', label: 'alias' }, 'key-b');
                        } else if (action === 'remove-config' || action === 'remove-with-orphan-key') {
                            await ConfigSetStore.remove('slot', 'b');
                            if (action === 'remove-with-orphan-key') {
                                await context.secrets.store('configSet.slot.b', 'key-b');
                            }
                        } else if (action === 'replace-site') {
                            await ConfigSetStore.remove('slot', 'b');
                            await ConfigSetStore.add(
                                'slot',
                                { id: 'b', label: 'b', site: 'replacement-site' },
                                'key-b'
                            );
                        }
                        const after = await capture();
                        assert.ok(
                            after?.balanceLeaseId,
                            'an invalid lease must be replaced, not cause primary fallback'
                        );
                        const target = ConfigSetStore.list('slot').find(item => item.id === after.activeId);
                        assert.ok(target, 'the selected configuration must still exist');
                        assert.equal(after.site, target.site);
                        const apiKey = await originalGetApiKey.call(ConfigSetStore, 'slot', target.id);
                        assert.ok(apiKey);
                        assert.equal(
                            after.identity,
                            createHash('sha256')
                                .update(`${apiKey}\u0000${target.site ?? ''}`)
                                .digest('hex')
                        );
                        if (action.startsWith('replace-') || action.startsWith('remove-')) {
                            assert.notEqual(after.balanceLeaseId, before.balanceLeaseId);
                            assert.equal(manager.balanceLeases.has(before.balanceLeaseId), false);
                            assert.equal(manager.balanceLeaseRenewalTimers.has(before.balanceLeaseId), false);
                        } else {
                            assert.equal(after.balanceLeaseId, before.balanceLeaseId);
                        }
                        assert.equal(manager.balanceLeases.size, 1);
                    });
                }
            }
        }

        for (const action of [
            'unchanged',
            'other-slot',
            'pool-config-change',
            'replace-key',
            'remove-config',
            'mode-off',
            'mode-cycle',
            'mode-event',
            'same-term-reset',
            'change-authority',
            'expire',
            'release',
            'transport-lost',
            'transition',
            'freeze'
        ] as const) {
            if (
                (source === 'leader' && (action === 'transport-lost' || action === 'transition')) ||
                (source === 'follower' && action === 'freeze')
            ) {
                continue;
            }
            test(`fresh retry revalidates after key lookup: ${action}`, async () => {
                const before = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'request-cache');
                assert.ok(before?.balanceLeaseId);
                let unblock!: () => void;
                let started!: () => void;
                const gate = new Promise<void>(resolve => {
                    unblock = resolve;
                });
                const lookupStarted = new Promise<void>(resolve => {
                    started = resolve;
                });
                let keyLookups = 0;
                ConfigSetStore.getApiKey = async (...args) => {
                    keyLookups++;
                    const apiKey = await originalGetApiKey.apply(ConfigSetStore, args);
                    started();
                    await gate;
                    return apiKey;
                };
                const pending = ApiKeyFailoverManager.captureAttempt('slot', balanceKey, 'request-cache');
                let resigning: Promise<ApiKeyBalanceLeaseHandoff | undefined> | undefined;
                try {
                    await Promise.race([
                        lookupStarted,
                        pending.then(() => {
                            throw new Error('Fresh snapshot reuse did not reach the blocked key lookup');
                        })
                    ]);
                    if (action === 'other-slot') {
                        await ConfigSetStore.setApiKey('other', 'x', 'unrelated');
                        ApiKeyFailoverManager.handleBalanceModeChanged('other');
                    } else if (action === 'pool-config-change' || action === 'replace-key') {
                        await ConfigSetStore.setApiKey('slot', action === 'replace-key' ? 'b' : 'c', 'replacement-key');
                    } else if (action === 'remove-config') {
                        await ConfigSetStore.remove('slot', 'b');
                    } else if (action === 'mode-off' || action === 'mode-cycle') {
                        await ConfigSetStore.setSwitchMode('slot', 'off');
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        if (action === 'mode-cycle') {
                            await ConfigSetStore.setSwitchMode('slot', 'balance');
                            ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                        }
                    } else if (action === 'mode-event') {
                        ApiKeyFailoverManager.handleBalanceModeChanged('slot');
                    } else if (action === 'same-term-reset' || action === 'change-authority') {
                        if (action === 'change-authority') {
                            authorityTerm = 'cache-leader:2';
                        }
                        ApiKeyFailoverManager.handleBalanceAuthorityLost(true);
                    } else if (action === 'expire') {
                        now += 30_001;
                    } else if (action === 'release') {
                        ApiKeyFailoverManager.releaseBalanceLease(before.balanceLeaseId, authorityTerm);
                    } else if (action === 'transport-lost') {
                        InterInstanceBus.hasActiveTransport = () => false;
                    } else if (action === 'transition') {
                        InterInstanceBus.isAuthorityTransitioning = () => true;
                    } else if (action === 'freeze') {
                        resigning = ApiKeyFailoverManager.prepareBalanceLeaseHandoff();
                    }
                    unblock();
                    assert.strictEqual(
                        await pending,
                        action === 'unchanged' || action === 'other-slot' ? before : undefined
                    );
                    assert.equal(keyLookups, 1, 'retry must not rescan the entire pool');
                } finally {
                    unblock();
                    await pending;
                    await resigning;
                }
            });
        }
    });
}
