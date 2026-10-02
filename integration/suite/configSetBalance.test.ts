import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { InterInstanceBus } from '../../src/interInstance';
import { registerInterInstanceHandlers } from '../../src/interInstance/activation';
import { setBalanceHandoffDirectoryOverride } from '../../src/interInstance/pathResolver';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { applyConfigSet, enqueueConfigSetMutation } from '../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import {
    ApiKeyFailoverManager,
    type ApiKeyFailoverAttempt
} from '../../src/utils/config/failover/apiKeyFailoverManager';

function createContext(): vscode.ExtensionContext {
    const keys = new Map<string, string>();
    const state = new Map<string, unknown>();
    const globalState: vscode.Memento = {
        get<T>(key: string, fallback?: T): T {
            return (state.has(key) ? state.get(key) : fallback) as T;
        },
        keys: () => [...state.keys()],
        async update(key: string, value: unknown): Promise<void> {
            if (value === undefined) {
                state.delete(key);
            } else {
                state.set(key, structuredClone(value));
            }
        }
    };
    return {
        globalState,
        get globalStorageUri(): vscode.Uri {
            throw new Error('Config Set must not require a filesystem storage directory');
        },
        subscriptions: [],
        secrets: {
            get: async (key: string) => keys.get(key),
            store: async (key: string, value: string) => {
                keys.set(key, value);
            },
            delete: async (key: string) => {
                keys.delete(key);
            },
            onDidChange: () => ({ dispose() {} })
        }
    } as unknown as vscode.ExtensionContext;
}

function initialize(context = createContext()): vscode.ExtensionContext {
    ApiKeyManager.initialize(context);
    ConfigSetStore.initialize(context);
    return context;
}

async function seed(slot: string, ids = ['a', 'b', 'c']): Promise<void> {
    for (const id of ids) {
        await ConfigSetStore.add(slot, { id, label: `label-${id}` }, `key-${slot}-${id}`);
    }
    await ConfigSetStore.setActive(slot, ids[0]);
    await ApiKeyManager.setApiKey(slot, `key-${slot}-${ids[0]}`);
}

function balanceKeyForBucket(index: number, count: number): string {
    const key = Array.from({ length: 64 }, (_, candidate) => `s:balance-regression-${candidate}`).find(
        value => parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) % count === index
    );
    assert.ok(key);
    return key;
}

function credentialId(apiKey: string, site?: string): string {
    return createHash('sha256')
        .update(`${apiKey}\u0000${site ?? ''}`)
        .digest('hex');
}

class BalanceRequestProvider extends GenericModelProvider {
    static async runRequest(balanceKey: string, handler: (apiKey: string | undefined) => Promise<void>): Promise<void> {
        const provider = Object.create(BalanceRequestProvider.prototype) as BalanceRequestProvider;
        const config: ModelConfig = {
            id: 'balance-test',
            name: 'Balance Test',
            tooltip: 'Balance Test',
            provider: 'slot',
            sdkMode: 'openai',
            baseUrl: 'https://balance.test/v1',
            maxInputTokens: 1024,
            maxOutputTokens: 1024,
            capabilities: { imageInput: true, toolCalling: false }
        };
        Object.assign(provider, {
            providerKey: 'slot',
            cachedProviderConfig: { displayName: 'Balance Test', models: [] },
            openaiHandler: {
                async handleRequest(_model: vscode.LanguageModelChatInformation, modelConfig: ModelConfig) {
                    await handler(await ApiKeyManager.getApiKeyForRequest('slot', modelConfig));
                }
            }
        });
        const cancellation = new vscode.CancellationTokenSource();
        try {
            await provider.executeModelRequest(
                { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                config,
                [],
                {
                    modelOptions: { requestKind: 'main-agent' }
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                { report() {} },
                '',
                'balance-test-session',
                cancellation.token,
                'slot',
                Date.now(),
                0,
                undefined,
                undefined,
                balanceKey
            );
        } finally {
            cancellation.dispose();
        }
    }

    protected override async acquireRateLimit(): Promise<undefined> {
        return undefined;
    }

    protected override getRequestRetryConfig() {
        return { enabled: true, maxAttempts: 20, initialDelayMs: 0, maxDelayMs: 0 };
    }
}

async function isolateAttempt(balanceKey: string, attempt: ApiKeyFailoverAttempt): Promise<void> {
    const decision = await ApiKeyFailoverManager.handleFailure(
        'slot',
        new Error('401 unauthorized'),
        attempt,
        new Set(),
        3,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        balanceKey
    );
    assert.deepEqual(decision, { handled: true, shouldRetry: true, switched: true });
}

suite('config set balance mode regressions', () => {
    const originalInitialized = LeaderElectionService.isInitialized;
    const originalLeader = LeaderElectionService.isLeader;
    const originalAgents = LeaderElectionService.isAgentsWindow;
    const originalOwnedTerm = LeaderElectionService.getOwnedAuthorityTerm;
    const originalInstanceId = LeaderElectionService.getInstanceId;
    const originalAuthorityTerm = InterInstanceBus.getAuthorityTerm;
    const originalHasActiveTransport = InterInstanceBus.hasActiveTransport;
    const originalPublishIpcOnly = InterInstanceBus.publishIpcOnly;

    setup(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(mkdtempSync(join(tmpdir(), 'gcmp-balance-suite-')));
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => true;
        LeaderElectionService.isAgentsWindow = () => false;
        const authorityTerm = `balance-test:${randomUUID()}`;
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;
    });

    teardown(() => {
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        setBalanceHandoffDirectoryOverride(undefined);
        LeaderElectionService.isInitialized = originalInitialized;
        LeaderElectionService.isLeader = originalLeader;
        LeaderElectionService.isAgentsWindow = originalAgents;
        LeaderElectionService.getOwnedAuthorityTerm = originalOwnedTerm;
        LeaderElectionService.getInstanceId = originalInstanceId;
        InterInstanceBus.getAuthorityTerm = originalAuthorityTerm;
        InterInstanceBus.hasActiveTransport = originalHasActiveTransport;
        InterInstanceBus.publishIpcOnly = originalPublishIpcOnly;
    });

    test('legacy auto switch boolean migrates to failover mode', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setAutoSwitchEnabled('slot', true);
        assert.equal(ConfigSetStore.getSwitchMode('slot'), 'failover');

        await ConfigSetStore.setSwitchMode('slot', 'balance');
        assert.equal(ConfigSetStore.getSwitchMode('slot'), 'balance');

        await ConfigSetStore.setSwitchMode('slot', 'off');
        assert.equal(ConfigSetStore.getSwitchMode('slot'), 'off');
        assert.equal(ConfigSetStore.isAutoSwitchEnabled('slot'), false);
    });

    test('balance capture is deterministic per balance key and resolves pool members', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1', 'request-1');
        const second = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1', 'request-1');
        assert.equal(first?.activeId, second?.activeId);
        assert.ok(['a', 'b', 'c'].includes(first?.activeId ?? ''));
        assert.equal(first?.apiKey, `key-slot-${first?.activeId}`);
        assert.equal(first?.apiKeyName, `label-${first?.activeId}`);

        const other = await ApiKeyFailoverManager.captureAttempt('slot', 'a:sub-1');
        assert.ok(['a', 'b', 'c'].includes(other?.activeId ?? ''));
    });

    test('balance capture falls back to the primary key without a Leader', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        LeaderElectionService.isInitialized = () => false;
        LeaderElectionService.isLeader = () => false;
        assert.equal(await ApiKeyFailoverManager.captureAttempt('slot', 's:no-leader'), undefined);
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
    });

    test('Agents window uses an ordinary window Leader assignment over IPC', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.isAgentsWindow = () => true;
        LeaderElectionService.getInstanceId = () => 'agents-a';
        InterInstanceBus.getAuthorityTerm = () => 'leader-a:1';
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type !== 'apiKeyBalanceAssignmentRequested') {
                return true;
            }
            const payload = event.payload as { requestId: string };
            queueMicrotask(() => {
                ApiKeyFailoverManager.resolveBalanceAssignment({
                    requestId: payload.requestId,
                    targetInstanceId: 'agents-a',
                    authorityTerm: 'leader-a:1',
                    handled: true,
                    leaseId: 'lease-a',
                    configId: 'b',
                    credentialId: credentialId('key-slot-b'),
                    apiKeyName: 'label-b',
                    expiresAt: Date.now() + 30_000
                });
            });
            return true;
        };

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 'a:sub-1', 'request-agents-1');
        assert.equal(attempt?.activeId, 'b');
        assert.equal(attempt?.balanceAuthorityTerm, 'leader-a:1');
        assert.equal(attempt?.apiKeyName, 'label-b');
    });

    test('repeated remote assignment reuses the lease metadata', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        const payload = {
            requestId: 'request-repeated-assignment',
            requestedBy: 'follower-a',
            authorityTerm,
            slot: 'slot',
            balanceKey: 's:repeated-assignment'
        };

        const first = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'follower-a');
        const second = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(payload, 'follower-a');

        assert.equal(first?.handled, true);
        assert.equal(second?.handled, true);
        assert.equal(second?.leaseId, first?.leaseId);
        assert.equal(second?.configId, first?.configId);
        assert.equal(second?.apiKeyName, first?.apiKeyName);
        assert.ok(second?.apiKeyName);
    });

    test('expired remote lease rejects a late renewal', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-expired-renewal',
                requestedBy: 'follower-a',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:expired-renewal'
            },
            'follower-a'
        );
        assert.ok(assigned?.leaseId);

        const manager = ApiKeyFailoverManager as unknown as {
            balanceLeases: Map<string, { expiresAt: number }>;
        };
        const lease = manager.balanceLeases.get(assigned.leaseId);
        assert.ok(lease);
        lease.expiresAt = Date.now() - 1;

        ApiKeyFailoverManager.handleRemoteBalanceLeaseRenewal(
            { leaseId: assigned.leaseId, authorityTerm },
            'follower-a'
        );

        assert.equal(manager.balanceLeases.has(assigned.leaseId), false);
    });

    test('disconnect keeps an unexpired follower lease counted', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        const first = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-disconnect-first',
                requestedBy: 'follower-a',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:disconnect-retain'
            },
            'follower-a'
        );
        assert.ok(first?.configId);

        ApiKeyFailoverManager.handleBalanceInstanceDisconnected('follower-a');

        const second = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-disconnect-second',
                requestedBy: 'follower-b',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:disconnect-retain'
            },
            'follower-b'
        );
        assert.ok(second?.configId);
        assert.notEqual(second.configId, first.configId);
    });

    test('disconnect reclaim removes follower leases after the grace period', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-disconnect-reclaim',
                requestedBy: 'follower-a',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:disconnect-reclaim'
            },
            'follower-a'
        );
        assert.ok(assigned?.leaseId);

        ApiKeyFailoverManager.handleBalanceInstanceDisconnected('follower-a');
        await new Promise(resolve => setTimeout(resolve, 3_100));

        const manager = ApiKeyFailoverManager as unknown as {
            balanceLeases: Map<string, unknown>;
        };
        assert.equal(manager.balanceLeases.has(assigned.leaseId), false);
    });

    test('reconnect cancels a pending balance lease reclaim', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        const assigned = await ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-disconnect-reconnect',
                requestedBy: 'follower-a',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:disconnect-reconnect'
            },
            'follower-a'
        );
        assert.ok(assigned?.leaseId);

        ApiKeyFailoverManager.handleBalanceInstanceDisconnected('follower-a');
        ApiKeyFailoverManager.handleBalanceInstanceReconnected('follower-a');
        await new Promise(resolve => setTimeout(resolve, 50));

        const manager = ApiKeyFailoverManager as unknown as {
            balanceLeases: Map<string, unknown>;
        };
        assert.equal(manager.balanceLeases.has(assigned.leaseId), true);
    });

    test('mode change clears runtime balance state for the slot', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:mode-cleanup', 'request-mode-cleanup');
        assert.ok(attempt?.balanceLeaseId);

        ApiKeyFailoverManager.handleBalanceModeChanged('slot');

        const manager = ApiKeyFailoverManager as unknown as {
            balanceLeases: Map<string, unknown>;
            balanceAttemptSnapshots: Map<string, unknown>;
        };
        assert.equal(manager.balanceLeases.size, 0);
        assert.equal(manager.balanceAttemptSnapshots.size, 0);
    });

    test('Follower discards an assignment when its authority changes during secret lookup', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getInstanceId = () => 'follower-a';
        let authorityTerm = 'leader-a:1';
        InterInstanceBus.getAuthorityTerm = () => authorityTerm;
        InterInstanceBus.hasActiveTransport = () => true;

        let unblockSecret!: () => void;
        let secretLookupStarted!: () => void;
        const secretLookup = new Promise<void>(resolve => {
            secretLookupStarted = resolve;
        });
        const secretGate = new Promise<void>(resolve => {
            unblockSecret = resolve;
        });
        const originalGetApiKey = ConfigSetStore.getApiKey.bind(ConfigSetStore);
        ConfigSetStore.getApiKey = async (...args) => {
            secretLookupStarted();
            await secretGate;
            return await originalGetApiKey(...args);
        };
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type !== 'apiKeyBalanceAssignmentRequested') {
                return true;
            }
            const payload = event.payload as { requestId: string };
            queueMicrotask(() => {
                ApiKeyFailoverManager.resolveBalanceAssignment({
                    requestId: payload.requestId,
                    targetInstanceId: 'follower-a',
                    authorityTerm: 'leader-a:1',
                    handled: true,
                    leaseId: 'lease-a',
                    configId: 'b',
                    credentialId: credentialId('key-slot-b'),
                    expiresAt: Date.now() + 30_000
                });
            });
            return true;
        };

        try {
            const captured = ApiKeyFailoverManager.captureAttempt('slot', 'a:sub-1', 'request-late-term');
            await secretLookup;
            authorityTerm = 'leader-a:2';
            unblockSecret();
            assert.equal(await captured, undefined);
        } finally {
            ConfigSetStore.getApiKey = originalGetApiKey;
        }
    });

    test('Follower does not reuse a balance snapshot after transport loss', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getInstanceId = () => 'follower-a';
        InterInstanceBus.getAuthorityTerm = () => 'leader-a:1';
        InterInstanceBus.hasActiveTransport = () => true;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type !== 'apiKeyBalanceAssignmentRequested') {
                return true;
            }
            const payload = event.payload as { requestId: string };
            queueMicrotask(() => {
                ApiKeyFailoverManager.resolveBalanceAssignment({
                    requestId: payload.requestId,
                    targetInstanceId: 'follower-a',
                    authorityTerm: 'leader-a:1',
                    handled: true,
                    leaseId: 'lease-stale-transport',
                    configId: 'b',
                    credentialId: credentialId('key-slot-b'),
                    expiresAt: Date.now() + 30_000
                });
            });
            return true;
        };

        const first = await ApiKeyFailoverManager.captureAttempt(
            'slot',
            's:stale-transport',
            'request-stale-transport'
        );
        assert.ok(first?.balanceLeaseId);
        InterInstanceBus.hasActiveTransport = () => false;

        assert.equal(
            await ApiKeyFailoverManager.captureAttempt('slot', 's:stale-transport', 'request-stale-transport'),
            undefined
        );
    });

    test('Leader loss during balance capture falls back without throwing', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        let unblockSecret!: () => void;
        let secretLookupStarted!: () => void;
        const secretLookup = new Promise<void>(resolve => {
            secretLookupStarted = resolve;
        });
        const secretGate = new Promise<void>(resolve => {
            unblockSecret = resolve;
        });
        const originalGetApiKey = ConfigSetStore.getApiKey.bind(ConfigSetStore);
        ConfigSetStore.getApiKey = async (...args) => {
            secretLookupStarted();
            await secretGate;
            return await originalGetApiKey(...args);
        };

        try {
            const captured = ApiKeyFailoverManager.captureAttempt('slot', 's:leader-loss', 'request-leader-loss');
            await secretLookup;
            LeaderElectionService.isLeader = () => false;
            LeaderElectionService.getOwnedAuthorityTerm = () => undefined;
            unblockSecret();
            assert.equal(await captured, undefined);
        } finally {
            ConfigSetStore.getApiKey = originalGetApiKey;
        }
    });

    test('late balance failure from an old lease term does not isolate under the new term', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        let authorityTerm = 'leader-a:1';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;
        const attempt: ApiKeyFailoverAttempt = {
            mode: 'balance',
            activeId: 'a',
            apiKey: 'key-slot-a',
            identity: credentialId('key-slot-a'),
            balanceLeaseId: 'lease-old',
            balanceLeaseExpiresAt: Date.now() + 30_000,
            balanceAuthorityTerm: authorityTerm
        };

        authorityTerm = 'leader-a:2';
        const decision = await ApiKeyFailoverManager.handleFailure(
            'slot',
            new Error('401 unauthorized'),
            attempt,
            new Set(),
            3,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            's:session-1'
        );

        assert.deepEqual(decision, { handled: true, shouldRetry: false, switched: false });
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
    });

    test('balance isolation write does not affect the new term', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(0, 2);
        let authorityTerm = 'leader-a:1';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(attempt);

        const originalAddBalanceExclusion = ConfigSetStore.addBalanceExclusion.bind(ConfigSetStore);
        let unblockWrite!: () => void;
        let writeStarted!: () => void;
        const writeStartedPromise = new Promise<void>(resolve => {
            writeStarted = resolve;
        });
        const writeGate = new Promise<void>(resolve => {
            unblockWrite = resolve;
        });
        ConfigSetStore.addBalanceExclusion = async (...args) => {
            writeStarted();
            await writeGate;
            return await originalAddBalanceExclusion(...args);
        };

        try {
            const failure = ApiKeyFailoverManager.handleFailure(
                'slot',
                new Error('401 unauthorized'),
                attempt,
                new Set(),
                3,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                balanceKey
            );
            await writeStartedPromise;
            authorityTerm = 'leader-a:2';
            ApiKeyFailoverManager.handleBalanceAuthorityLost();
            unblockWrite();

            assert.deepEqual(await failure, { handled: false, shouldRetry: false, switched: false });
            const exclusion = ConfigSetStore.getBalanceExclusions('slot')[0];
            assert.equal(exclusion?.authorityTerm, 'leader-a:1');

            const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
            assert.equal(next?.identity, attempt.identity);
        } finally {
            ConfigSetStore.addBalanceExclusion = originalAddBalanceExclusion;
        }
    });

    test('late old-term exclusion write does not overwrite the current term', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        let authorityTerm = 'leader-a:1';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;

        const balanceKey = balanceKeyForBucket(0, 2);
        const first = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(first);

        authorityTerm = 'leader-a:2';
        await ConfigSetStore.addBalanceExclusion('slot', balanceKey, first.identity, Date.now(), authorityTerm);
        await ConfigSetStore.addBalanceExclusion('slot', balanceKey, first.identity, Date.now(), 'leader-a:1');

        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(next);
        assert.notEqual(next.identity, first.identity);
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').filter(entry => entry.k === balanceKey).length, 2);
    });

    test('graceful handoff imports valid leases without restoring request state', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        let authorityTerm = 'leader-old:1';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;
        LeaderElectionService.getInstanceId = () => 'leader-new-instance';

        const original = await ApiKeyFailoverManager.captureAttempt('slot', balanceKeyForBucket(0, 2), 'old-request');
        assert.ok(original?.balanceLeaseId);
        const handoff = ApiKeyFailoverManager.exportBalanceLeaseHandoff();
        assert.equal(handoff?.leases.length, 1);
        assert.equal(Object.hasOwn(handoff!.leases[0], 'requestId'), false);

        authorityTerm = 'leader-new:2';
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
            handoff!,
            'leader-old-instance',
            undefined,
            'leader-old:1',
            Date.now()
        );
        await ApiKeyFailoverManager.becomeBalanceAuthority(authorityTerm);

        const manager = ApiKeyFailoverManager as unknown as {
            balanceLeases: Map<
                string,
                { authorityTerm: string; handoffSourceAuthorityTerm?: string; ownerInstanceId: string }
            >;
        };
        const imported = manager.balanceLeases.get(original.balanceLeaseId);
        assert.equal(imported?.authorityTerm, 'leader-new:2');
        assert.equal(imported?.handoffSourceAuthorityTerm, 'leader-old:1');
        assert.equal(imported?.ownerInstanceId, LeaderElectionService.getInstanceId());

        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKeyForBucket(0, 2), 'new-request');
        assert.ok(next);
        assert.notEqual(next.identity, original.identity);

        ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
            { leaseId: original.balanceLeaseId, authorityTerm: 'leader-old:1' },
            LeaderElectionService.getInstanceId()
        );
        assert.equal(manager.balanceLeases.has(original.balanceLeaseId), true);
        ApiKeyFailoverManager.handleRemoteBalanceLeaseRelease(
            { leaseId: original.balanceLeaseId, authorityTerm: 'leader-new:2' },
            LeaderElectionService.getInstanceId()
        );
        assert.equal(manager.balanceLeases.has(original.balanceLeaseId), false);
    });

    test('handoff rejects stale source term and event timestamp', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const sourceAuthorityTerm = 'leader-old:stale';
        const handoff = {
            sourceAuthorityTerm,
            capturedAt: Date.now(),
            leases: [
                {
                    leaseId: 'handoff-stale-lease',
                    slot: 'slot',
                    balanceKey: 's:handoff-stale',
                    configId: 'a',
                    credentialId: credentialId('key-slot-a'),
                    ownerInstanceId: 'follower-a',
                    expiresAt: Date.now() + 30_000
                }
            ]
        };

        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
            handoff,
            'leader-old-instance',
            undefined,
            'leader-other:1',
            Date.now()
        );
        ApiKeyFailoverManager.stageBalanceLeaseHandoff(
            handoff,
            'leader-old-instance',
            undefined,
            sourceAuthorityTerm,
            Date.now() - 10_001
        );

        const manager = ApiKeyFailoverManager as unknown as {
            pendingBalanceLeaseHandoff: unknown;
        };
        assert.equal(manager.pendingBalanceLeaseHandoff, undefined);
    });

    test('leaderResigning handler stages only an authorized handoff', async () => {
        initialize();
        const context = createContext();
        const sourceAuthorityTerm = 'leader-old:event';
        const handoff = {
            sourceAuthorityTerm,
            capturedAt: Date.now(),
            leases: [
                {
                    leaseId: 'handoff-event-lease',
                    slot: 'slot',
                    balanceKey: 's:handoff-event',
                    configId: 'a',
                    credentialId: credentialId('key-slot-a'),
                    ownerInstanceId: 'follower-a',
                    expiresAt: Date.now() + 30_000
                }
            ]
        };
        const handlers = InterInstanceBus as unknown as {
            handlers: Map<string, Set<(event: unknown) => void>>;
        };
        const previousInstanceId = LeaderElectionService.getInstanceId;
        const previousAuthorityTerm = InterInstanceBus.getAuthorityTerm;
        LeaderElectionService.getInstanceId = () => 'leader-new-instance';
        InterInstanceBus.getAuthorityTerm = () => sourceAuthorityTerm;
        registerInterInstanceHandlers(context);

        try {
            const event = {
                type: 'leaderResigning',
                payload: {
                    leaderId: 'leader-old-instance',
                    sourceAuthorityTerm,
                    nextLeaderId: 'leader-new-instance',
                    balanceLeaseSnapshot: handoff
                },
                timestamp: Date.now(),
                senderInstanceId: 'leader-old-instance'
            };
            for (const handler of handlers.handlers.get('leaderResigning') ?? []) {
                handler(event);
            }

            const manager = ApiKeyFailoverManager as unknown as {
                pendingBalanceLeaseHandoff: { sourceLeaderId: string } | undefined;
            };
            assert.equal(manager.pendingBalanceLeaseHandoff?.sourceLeaderId, 'leader-old-instance');
        } finally {
            for (const disposable of context.subscriptions) {
                disposable.dispose();
            }
            LeaderElectionService.getInstanceId = previousInstanceId;
            InterInstanceBus.getAuthorityTerm = previousAuthorityTerm;
        }
    });

    test('mode change in another slot does not discard an in-flight handoff import', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const sourceAuthorityTerm = 'leader-old:cross-slot';
        LeaderElectionService.getOwnedAuthorityTerm = () => sourceAuthorityTerm;
        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:handoff-slot', 'handoff-slot-request');
        assert.ok(first?.balanceLeaseId);
        const handoff = {
            sourceAuthorityTerm,
            capturedAt: Date.now(),
            leases: [
                {
                    leaseId: first.balanceLeaseId,
                    slot: 'slot',
                    balanceKey: 's:handoff-slot',
                    configId: first.activeId,
                    credentialId: first.identity,
                    ownerInstanceId: 'follower-a',
                    expiresAt: Date.now() + 30_000
                }
            ]
        };

        const originalGetApiKey = ConfigSetStore.getApiKey.bind(ConfigSetStore);
        let unblock!: () => void;
        let started!: () => void;
        const gate = new Promise<void>(resolve => {
            unblock = resolve;
        });
        const lookupStarted = new Promise<void>(resolve => {
            started = resolve;
        });
        ConfigSetStore.getApiKey = async (...args) => {
            if (args[0] === 'slot') {
                started();
                await gate;
            }
            return await originalGetApiKey(...args);
        };

        try {
            LeaderElectionService.getOwnedAuthorityTerm = () => 'leader-new:cross-slot';
            ApiKeyFailoverManager.handleBalanceAuthorityLost();
            ApiKeyFailoverManager.stageBalanceLeaseHandoff(
                handoff!,
                'leader-old-instance',
                undefined,
                sourceAuthorityTerm,
                Date.now()
            );
            const staged = ApiKeyFailoverManager as unknown as {
                pendingBalanceLeaseHandoff: unknown;
            };
            assert.ok(staged.pendingBalanceLeaseHandoff);
            const becoming = ApiKeyFailoverManager.becomeBalanceAuthority('leader-new:cross-slot');
            await lookupStarted;
            ApiKeyFailoverManager.handleBalanceModeChanged('other');
            unblock();
            await becoming;

            const manager = ApiKeyFailoverManager as unknown as {
                balanceLeases: Map<string, { slot: string }>;
            };
            assert.equal(
                [...manager.balanceLeases.values()].some(lease => lease.slot === 'slot'),
                true
            );
        } finally {
            ConfigSetStore.getApiKey = originalGetApiKey;
            unblock();
        }
    });

    test('expired balance exclusions are physically removed from term storage', async () => {
        const context = initialize();
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:expired-storage',
            credentialId('key-slot-a'),
            Date.now() - 5 * 60 * 1000 - 1,
            'leader-expired:1'
        );
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 1);

        await ConfigSetStore.cleanupBalanceExclusions('slot');

        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
        assert.equal(
            context.globalState.keys().some(key => key.includes('balanceExclusions.slot.term.')),
            false
        );
    });
    test('authority loss invalidates a cached balance lease', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        let authorityTerm = 'leader-a:1';
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;

        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1', 'request-authority-1');
        assert.ok(first?.balanceLeaseId);
        ApiKeyFailoverManager.handleBalanceAuthorityLost();
        authorityTerm = 'leader-a:2';
        const second = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1', 'request-authority-1');
        assert.ok(second?.balanceLeaseId);
        assert.notEqual(second.balanceLeaseId, first.balanceLeaseId);
        assert.equal(second.balanceAuthorityTerm, 'leader-a:2');
    });

    test('queued remote balance assignment rechecks mode after serialization', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const blocked = enqueueConfigSetMutation(() => gate);
        const changed = enqueueConfigSetMutation(() => ConfigSetStore.setSwitchMode('slot', 'off'));
        const assigned = ApiKeyFailoverManager.handleBalanceAssignmentRequest(
            {
                requestId: 'request-queued-1',
                requestedBy: 'follower-a',
                authorityTerm,
                slot: 'slot',
                balanceKey: 's:session-1'
            },
            'follower-a'
        );
        release();
        await Promise.all([blocked, changed]);
        assert.equal((await assigned)?.handled, false);
    });

    for (const mode of ['off', 'failover'] as const) {
        test(`queued balance capture does not use a snapshot after switching to ${mode}`, async () => {
            initialize();
            await seed('slot');
            await ConfigSetStore.setSwitchMode('slot', 'balance');

            let release!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const blocked = enqueueConfigSetMutation(() => gate);
            const changed = enqueueConfigSetMutation(() => ConfigSetStore.setSwitchMode('slot', mode));
            const captured = ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');

            try {
                release();
                await Promise.all([blocked, changed]);
                assert.equal(ConfigSetStore.getSwitchMode('slot'), mode);
                assert.equal(await captured, undefined);
                assert.equal(ConfigSetStore.getActiveId('slot'), 'a');
                assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
            } finally {
                release();
                await Promise.all([blocked, changed, captured]);
            }
        });
    }

    test('queued balance capture rejects a mode and authority transition together', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        let authorityTerm = LeaderElectionService.getOwnedAuthorityTerm();
        assert.ok(authorityTerm);
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;

        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const blocked = enqueueConfigSetMutation(() => gate);
        const changed = enqueueConfigSetMutation(async () => {
            await ConfigSetStore.setSwitchMode('slot', 'off');
            authorityTerm = 'leader-next:2';
        });
        const captured = ApiKeyFailoverManager.captureAttempt('slot', 's:mode-term-transition', 'request-transition');

        release();
        await Promise.all([blocked, changed]);
        assert.equal(ConfigSetStore.getSwitchMode('slot'), 'off');
        assert.equal(await captured, undefined);

        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const next = await ApiKeyFailoverManager.captureAttempt('slot', 's:mode-term-transition', 'request-transition');
        assert.ok(next?.balanceLeaseId);
        assert.equal(next?.balanceAuthorityTerm, 'leader-next:2');
    });

    test('balanced non-active duplicate credentials omit an ambiguous configuration name', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-b');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        await ConfigSetStore.addBalanceExclusion('slot', 's:session-1', credentialId('key-slot-a'), Date.now());

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'b');
        assert.equal(attempt.apiKey, 'key-slot-b');
        assert.equal(attempt.apiKeyName, undefined);
    });

    test('balanced active credentials preserve the explicitly selected duplicate alias name', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
        await ConfigSetStore.setActive('slot', 'c');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        await ConfigSetStore.addBalanceExclusion('slot', 's:session-1', credentialId('key-slot-b'), Date.now());

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'c');
        assert.equal(attempt.apiKey, 'key-slot-a');
        assert.equal(attempt.apiKeyName, 'label-c');
    });

    test('balanced current duplicate credentials omit the name without an active alias marker', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
        await ConfigSetStore.clearActive('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        await ConfigSetStore.addBalanceExclusion('slot', 's:session-1', credentialId('key-slot-b'), Date.now());

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'a');
        assert.equal(attempt.apiKey, 'key-slot-a');
        assert.equal(attempt.apiKeyName, undefined);
    });

    test('late failure of a replaced key does not isolate the new saved credential', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(1, 2);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'b');

        await enqueueConfigSetMutation(() =>
            ConfigSetStore.updateMeta('slot', 'b', { label: 'Updated B' }, 'replacement-key')
        );
        await isolateAttempt(balanceKey, attempt);

        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.equal(next?.activeId, 'b');
        assert.equal(next?.apiKey, 'replacement-key');
        assert.equal(next?.apiKeyName, 'Updated B');
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
    });

    test('renaming a failed configuration does not remove its isolation', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(1, 2);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(attempt);

        await ConfigSetStore.updateMeta('slot', 'b', { label: 'Renamed B' });
        await isolateAttempt(balanceKey, attempt);

        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.equal(next?.activeId, 'a');
        assert.notEqual(next?.apiKey, attempt.apiKey);
    });

    test('activating a duplicate alias cannot bypass unexpired credential isolation', async () => {
        initialize();
        await seed('slot', ['a', 'c', 'b']);
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(0, 2);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'a');
        await isolateAttempt(balanceKey, attempt);
        assert.equal((await ApiKeyFailoverManager.captureAttempt('slot', balanceKey))?.activeId, 'b');

        const items = ConfigSetStore.list('slot');
        assert.equal(await applyConfigSet('slot', items.find(item => item.id === 'c')!), true);

        const next = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.equal(next?.activeId, 'b');
        assert.notEqual(next?.apiKey, attempt.apiKey);
        assert.deepEqual(ConfigSetStore.list('slot'), items);
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 1);
    });

    test('duplicate aliases refresh one credential exclusion instead of accumulating configuration IDs', async () => {
        initialize();
        await seed('slot', ['a', 'c', 'b']);
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(0, 2);
        const first = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(first);
        assert.equal(await applyConfigSet('slot', ConfigSetStore.list('slot').find(item => item.id === 'c')!), true);
        const second = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.ok(second);
        assert.equal(second.activeId, 'c');
        assert.equal(second.apiKey, first.apiKey);

        await isolateAttempt(balanceKey, first);
        await isolateAttempt(balanceKey, second);

        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 1);
        assert.equal((await ApiKeyFailoverManager.captureAttempt('slot', balanceKey))?.activeId, 'b');
    });

    for (const bucket of [0, 1, 2]) {
        test(`activating a duplicate alias preserves the credential in balance bucket ${bucket}`, async () => {
            initialize();
            await seed('slot', ['a', 'b', 'c', 'd']);
            await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
            await ConfigSetStore.setSwitchMode('slot', 'balance');
            const balanceKey = balanceKeyForBucket(bucket, 3);
            const before = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
            assert.ok(before);
            const items = ConfigSetStore.list('slot');

            assert.equal(await applyConfigSet('slot', items.find(item => item.id === 'c')!), true);

            const after = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
            assert.equal(after?.apiKey, before.apiKey);
            assert.equal(after?.site, before.site);
            assert.equal(after?.identity, before.identity);
            assert.deepEqual(ConfigSetStore.list('slot'), items);
            assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
            if (before.activeId === 'a') {
                assert.equal(after?.activeId, 'c');
                assert.equal(after?.apiKeyName, 'label-c');
            }
        });
    }

    test('failover preserves saved-order rotation when a duplicate alias is active', async () => {
        initialize();
        await seed('slot', ['a', 'b', 'c', 'd']);
        await ConfigSetStore.setApiKey('slot', 'c', 'key-slot-a');
        assert.equal(await applyConfigSet('slot', ConfigSetStore.list('slot').find(item => item.id === 'c')!), true);
        await ConfigSetStore.setSwitchMode('slot', 'failover');
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot');
        assert.ok(attempt);
        assert.equal(attempt.activeId, 'c');

        await isolateAttempt('s:failover-control', attempt);

        assert.equal(ConfigSetStore.getActiveId('slot'), 'd');
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-d');
    });

    test('legacy ID-only and empty isolation records cannot retarget the current credential', async () => {
        const context = initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceKey = balanceKeyForBucket(1, 2);
        await context.globalState.update('configSets.balanceExclusions.slot', [
            { k: balanceKey, id: 'b', at: Date.now() },
            null
        ]);

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', balanceKey);
        assert.equal(attempt?.activeId, 'b');
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
    });

    test('excluded configuration is skipped until the 5 minute isolation expires', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        const original = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(original!.apiKey, original!.site),
            Date.now()
        );

        const redirected = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.notEqual(redirected?.activeId, original?.activeId);

        // 5 分钟 TTL：过期条目被忽略，哈希回落到原配置
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(redirected!.apiKey, redirected!.site),
            Date.now()
        );
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(original!.apiKey, original!.site),
            Date.now() - 6 * 60_000
        );
        const recovered = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.equal(recovered?.activeId, original?.activeId);
    });

    test('an exclusion only affects the balance unit that recorded it', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        const unaffectedBefore = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-2');
        assert.ok(unaffectedBefore);
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(unaffectedBefore.apiKey, unaffectedBefore.site),
            Date.now()
        );

        const unaffectedAfter = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-2');
        assert.equal(unaffectedAfter?.activeId, unaffectedBefore.activeId);
    });

    test('balanced target preserves its own site for request routing and identity', async () => {
        initialize();
        const slot = 'zhipu';
        const configuration = vscode.workspace.getConfiguration('gcmp.zhipu');
        const previousEndpoint = configuration.inspect<string>('endpoint')?.globalValue;

        try {
            await configuration.update('endpoint', 'open.bigmodel.cn', vscode.ConfigurationTarget.Global);
            await ConfigSetStore.add(slot, { id: 'china', label: 'China', site: 'open.bigmodel.cn' }, 'same-key');
            await ConfigSetStore.add(slot, { id: 'global', label: 'Global', site: 'api.z.ai' }, 'same-key');
            await ConfigSetStore.setActive(slot, 'china');
            await ApiKeyManager.setApiKey(slot, 'same-key');
            await ConfigSetStore.setSwitchMode(slot, 'balance');

            let globalAttempt: Awaited<ReturnType<typeof ApiKeyFailoverManager.captureAttempt>>;
            for (let index = 0; index < 64; index += 1) {
                const attempt = await ApiKeyFailoverManager.captureAttempt(slot, `s:site-${index}`);
                if (attempt?.activeId === 'global') {
                    globalAttempt = attempt;
                    break;
                }
            }

            assert.ok(globalAttempt);
            assert.equal(globalAttempt.site, 'api.z.ai');
            assert.equal(globalAttempt.apiKeyName, 'Global');
            assert.equal(globalAttempt.identity, credentialId('same-key', 'api.z.ai'));
            assert.notEqual(globalAttempt.identity, credentialId('same-key', 'open.bigmodel.cn'));
        } finally {
            await configuration.update('endpoint', previousEndpoint, vscode.ConfigurationTarget.Global);
        }
    });

    test('equal keys at different sites do not share balance isolation', async () => {
        initialize();
        const slot = 'zhipu';
        const configuration = vscode.workspace.getConfiguration('gcmp.zhipu');
        const previousEndpoint = configuration.inspect<string>('endpoint')?.globalValue;
        const balanceKey = balanceKeyForBucket(1, 2);

        try {
            await configuration.update('endpoint', 'open.bigmodel.cn', vscode.ConfigurationTarget.Global);
            await ConfigSetStore.add(slot, { id: 'china', label: 'China', site: 'open.bigmodel.cn' }, 'same-key');
            await ConfigSetStore.add(slot, { id: 'global', label: 'Global', site: 'api.z.ai' }, 'same-key');
            await ConfigSetStore.setActive(slot, 'china');
            await ApiKeyManager.setApiKey(slot, 'same-key');
            await ConfigSetStore.setSwitchMode(slot, 'balance');
            const attempt = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
            assert.ok(attempt);
            assert.equal(attempt.activeId, 'global');

            await ApiKeyFailoverManager.handleFailure(
                slot,
                new Error('401 unauthorized'),
                attempt,
                new Set(),
                3,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                balanceKey
            );

            const next = await ApiKeyFailoverManager.captureAttempt(slot, balanceKey);
            assert.equal(next?.activeId, 'china');
            assert.equal(next?.apiKey, attempt.apiKey);
            assert.notEqual(next?.site, attempt.site);
            assert.notEqual(next?.identity, attempt.identity);
            assert.equal(JSON.stringify(ConfigSetStore.getBalanceExclusions(slot)).includes('same-key'), false);
        } finally {
            await configuration.update('endpoint', previousEndpoint, vscode.ConfigurationTarget.Global);
        }
    });

    test('a balance unit can isolate multiple configurations without overwriting earlier ones', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(first!.apiKey, first!.site),
            Date.now()
        );
        const second = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        await ConfigSetStore.addBalanceExclusion(
            'slot',
            's:session-1',
            credentialId(second!.apiKey, second!.site),
            Date.now()
        );

        const third = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        const remaining = ['a', 'b', 'c'].filter(id => id !== first?.activeId && id !== second?.activeId);
        assert.deepEqual([third?.activeId], remaining);
    });

    test('balance failure below threshold retries without switching, at threshold records exclusion', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');

        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(attempt);

        const below = await ApiKeyFailoverManager.handleFailure(
            'slot',
            new Error('401 unauthorized'),
            attempt,
            new Set(),
            2,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            's:session-1'
        );
        assert.deepEqual(below, { handled: true, shouldRetry: true, switched: false });
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);

        const atThreshold = await ApiKeyFailoverManager.handleFailure(
            'slot',
            new Error('401 unauthorized'),
            attempt,
            new Set(),
            3,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            's:session-1'
        );
        assert.deepEqual(atThreshold, { handled: true, shouldRetry: true, switched: true });
        const exclusions = ConfigSetStore.getBalanceExclusions('slot');
        assert.equal(exclusions.length, 1);
        assert.equal(exclusions[0]?.k, 's:session-1');
        assert.equal(exclusions[0]?.credentialId, credentialId(attempt.apiKey, attempt.site));

        const redirected = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.notEqual(redirected?.activeId, attempt.activeId);
    });

    test('Follower reports balance isolation to the Leader for its assigned lease', async () => {
        initialize();
        await seed('slot', ['a', 'b']);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        LeaderElectionService.isInitialized = () => true;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.getInstanceId = () => 'follower-a';
        InterInstanceBus.getAuthorityTerm = () => 'leader-a:1';
        InterInstanceBus.hasActiveTransport = () => true;
        const attempt: ApiKeyFailoverAttempt = {
            mode: 'balance',
            activeId: 'a',
            apiKey: 'key-slot-a',
            identity: credentialId('key-slot-a'),
            balanceLeaseId: 'lease-a',
            balanceLeaseExpiresAt: Date.now() + 30_000,
            balanceAuthorityTerm: 'leader-a:1'
        };
        let reported = false;
        InterInstanceBus.publishIpcOnly = event => {
            if (event.type !== 'apiKeyBalanceFailureReported') {
                return true;
            }
            const payload = event.payload as { requestId: string; leaseId: string; credentialId: string };
            reported = true;
            assert.equal(payload.leaseId, 'lease-a');
            assert.equal(payload.credentialId, credentialId('key-slot-a'));
            queueMicrotask(() => {
                ApiKeyFailoverManager.resolveBalanceFailure({
                    requestId: payload.requestId,
                    targetInstanceId: 'follower-a',
                    authorityTerm: 'leader-a:1',
                    handled: true,
                    shouldRetry: true,
                    switched: true
                });
            });
            return true;
        };

        const decision = await ApiKeyFailoverManager.handleFailure(
            'slot',
            new Error('401 unauthorized'),
            attempt,
            new Set(),
            3,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            's:session-1'
        );
        assert.equal(reported, true);
        assert.deepEqual(decision, { handled: true, shouldRetry: true, switched: true });
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
    });

    test('attempts captured under another switch mode cannot trigger the new mode policy', async () => {
        initialize();
        await seed('slot');

        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const balanceAttempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(balanceAttempt);
        await ConfigSetStore.setSwitchMode('slot', 'failover');
        assert.deepEqual(
            await ApiKeyFailoverManager.handleFailure(
                'slot',
                new Error('boom'),
                balanceAttempt,
                new Set(),
                3,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                's:session-1'
            ),
            { handled: false, shouldRetry: false, switched: false }
        );

        const failoverAttempt = await ApiKeyFailoverManager.captureAttempt('slot');
        assert.ok(failoverAttempt);
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        assert.deepEqual(
            await ApiKeyFailoverManager.handleFailure(
                'slot',
                new Error('boom'),
                failoverAttempt,
                new Set(),
                3,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                's:session-1'
            ),
            { handled: false, shouldRetry: false, switched: false }
        );
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
    });

    test('balance failure does not report a switch when its queued mode check no longer matches', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.ok(attempt);

        const originalGetSwitchMode = ConfigSetStore.getSwitchMode;
        let reads = 0;
        ConfigSetStore.getSwitchMode = () => (++reads === 1 ? 'balance' : 'off');
        try {
            assert.deepEqual(
                await ApiKeyFailoverManager.handleFailure(
                    'slot',
                    new Error('boom'),
                    attempt,
                    new Set(),
                    3,
                    undefined,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    's:session-1'
                ),
                { handled: false, shouldRetry: false, switched: false }
            );
        } finally {
            ConfigSetStore.getSwitchMode = originalGetSwitchMode;
        }
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
    });

    for (const leader of [false, true]) {
        for (const scenario of ['failover', 'balance-a', 'balance-b'] as const) {
            test(`${scenario} reaches the healthy third key after entering failover (leader=${leader})`, async () => {
                initialize();
                LeaderElectionService.isInitialized = () => leader;
                LeaderElectionService.isLeader = () => leader;
                await seed('slot');
                await ConfigSetStore.setSwitchMode('slot', scenario === 'failover' ? 'failover' : 'balance');
                const usedKeys: string[] = [];
                await BalanceRequestProvider.runRequest(
                    balanceKeyForBucket(scenario === 'balance-b' ? 1 : 0, 3),
                    async apiKey => {
                        usedKeys.push(apiKey ?? '');
                        if (scenario !== 'failover' && usedKeys.length === 1) {
                            await enqueueConfigSetMutation(() => ConfigSetStore.setSwitchMode('slot', 'failover'));
                        }
                        if (apiKey !== 'key-slot-c') {
                            throw Object.assign(new Error('unavailable'), { status: 503 });
                        }
                    }
                );

                const expected = ['a', 'a', 'a', 'b', 'b', 'b', 'c'];
                if (scenario !== 'failover') {
                    expected.unshift(scenario === 'balance-b' && leader ? 'b' : 'a');
                }
                assert.deepEqual(
                    usedKeys,
                    expected.map(id => `key-slot-${id}`)
                );
                assert.equal(ConfigSetStore.getActiveId('slot'), 'c');
            });
        }

        for (const transition of ['off', 'balance', 'unchanged'] as const) {
            test(`failover loop state respects a ${transition} mode phase (leader=${leader})`, async () => {
                initialize();
                LeaderElectionService.isInitialized = () => leader;
                LeaderElectionService.isLeader = () => leader;
                await seed('slot', ['a', 'b']);
                await ConfigSetStore.setSwitchMode('slot', 'failover');
                const usedKeys: string[] = [];
                const request = BalanceRequestProvider.runRequest(balanceKeyForBucket(1, 2), async apiKey => {
                    usedKeys.push(apiKey ?? '');
                    if (transition !== 'unchanged') {
                        if (usedKeys.length === 7) {
                            await enqueueConfigSetMutation(() => ConfigSetStore.setSwitchMode('slot', transition));
                        } else if (usedKeys.length === 8) {
                            await enqueueConfigSetMutation(() => ConfigSetStore.setSwitchMode('slot', 'failover'));
                        } else if (usedKeys.length > 8 && apiKey === 'key-slot-b') {
                            return;
                        }
                    }
                    throw Object.assign(new Error('unavailable'), { status: 503 });
                });

                const expected = ['a', 'a', 'a', 'b', 'b', 'b', 'a'];
                if (transition === 'unchanged') {
                    await assert.rejects(request, { status: 503 });
                } else {
                    await request;
                    expected.push(transition === 'balance' && leader ? 'b' : 'a', 'a', 'a', 'a', 'b');
                }
                assert.deepEqual(
                    usedKeys,
                    expected.map(id => `key-slot-${id}`)
                );
                assert.equal(ConfigSetStore.getActiveId('slot'), transition === 'unchanged' ? 'a' : 'b');
            });
        }
    }

    for (const change of ['none', 'rename', 'alias'] as const) {
        test(`balance isolates the same credential after three failures despite ${change}`, async () => {
            initialize();
            await seed('slot', ['a', 'alias-a', 'b']);
            await ConfigSetStore.setApiKey('slot', 'alias-a', 'key-slot-a');
            await ConfigSetStore.setSwitchMode('slot', 'balance');
            const usedKeys: string[] = [];
            let applied: boolean | undefined;
            await BalanceRequestProvider.runRequest(balanceKeyForBucket(0, 2), async apiKey => {
                usedKeys.push(apiKey ?? '');
                if (usedKeys.length === 2) {
                    if (change === 'alias') {
                        applied = await applyConfigSet(
                            'slot',
                            ConfigSetStore.list('slot').find(item => item.id === 'alias-a')!
                        );
                    } else if (change === 'rename') {
                        await ConfigSetStore.updateMeta('slot', 'a', { label: 'renamed A' });
                    }
                }
                if (apiKey !== 'key-slot-b') {
                    throw Object.assign(new Error('unavailable'), { status: 503 });
                }
            });

            assert.deepEqual(usedKeys, ['key-slot-a', 'key-slot-a', 'key-slot-a', 'key-slot-b']);
            assert.equal(applied, change === 'alias' ? true : undefined);
            assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
            assert.equal(ConfigSetStore.getActiveId('slot'), change === 'alias' ? 'alias-a' : 'a');
            const exclusions = ConfigSetStore.getBalanceExclusions('slot');
            assert.equal(exclusions.length, 1);
            assert.equal(exclusions[0].credentialId, credentialId('key-slot-a'));
        });
    }

    test('switching away from balance clears exclusions', async () => {
        initialize();
        await seed('slot');
        await ConfigSetStore.setSwitchMode('slot', 'balance');
        await ConfigSetStore.addBalanceExclusion('slot', 's:session-1', credentialId('key-slot-a'), Date.now());
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 1);

        await ConfigSetStore.setSwitchMode('slot', 'failover');
        assert.equal(ConfigSetStore.getBalanceExclusions('slot').length, 0);
        assert.equal(ConfigSetStore.getSwitchMode('slot'), 'failover');
    });
});
