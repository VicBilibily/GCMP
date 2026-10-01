import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
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

    setup(() => {
        LeaderElectionService.isInitialized = () => false;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.isAgentsWindow = () => false;
        const authorityTerm = `balance-test:${randomUUID()}`;
        LeaderElectionService.getOwnedAuthorityTerm = () => authorityTerm;
    });

    teardown(() => {
        LeaderElectionService.isInitialized = originalInitialized;
        LeaderElectionService.isLeader = originalLeader;
        LeaderElectionService.isAgentsWindow = originalAgents;
        LeaderElectionService.getOwnedAuthorityTerm = originalOwnedTerm;
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

        const first = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        const second = await ApiKeyFailoverManager.captureAttempt('slot', 's:session-1');
        assert.equal(first?.activeId, second?.activeId);
        assert.ok(['a', 'b', 'c'].includes(first?.activeId ?? ''));
        assert.equal(first?.apiKey, `key-slot-${first?.activeId}`);
        assert.equal(first?.apiKeyName, `label-${first?.activeId}`);

        const other = await ApiKeyFailoverManager.captureAttempt('slot', 'a:sub-1');
        assert.ok(['a', 'b', 'c'].includes(other?.activeId ?? ''));
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
                    expected.unshift(scenario === 'balance-b' ? 'b' : 'a');
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
                    expected.push(transition === 'balance' ? 'b' : 'a', 'a', 'a', 'a', 'b');
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
