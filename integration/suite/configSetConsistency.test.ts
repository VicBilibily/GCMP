import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import { CrudHost } from '../../src/ui/configSetManager/crudHost';
import type { HostMessage, PanelContext } from '../../src/ui/configSetManager/types';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import {
    applyConfigSet,
    applyConfigSetUnlocked,
    enqueueConfigSetMutation,
    readCurrentSite
} from '../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../src/utils/config/failover/apiKeyFailoverManager';

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

async function seed(slot: string, ids = ['a', 'b']): Promise<void> {
    for (const id of ids) {
        await ConfigSetStore.add(slot, { id, label: id }, `key-${slot}-${id}`);
    }
    await ConfigSetStore.setActive(slot, ids[0]);
    await ApiKeyManager.setApiKey(slot, `key-${slot}-${ids[0]}`);
    await ConfigSetStore.setAutoSwitchEnabled(slot, true);
}

function createPanel(posts: HostMessage[]): CrudHost {
    const context: PanelContext = {
        post: message => posts.push(message),
        isAlive: () => false,
        sendStates: async () => {},
        refreshCliProviders: async () => {},
        refreshCliUsage: async () => {}
    };
    return new CrudHost(context);
}

suite('config set consistency regressions', () => {
    const originalInitialized = LeaderElectionService.isInitialized;
    const originalLeader = LeaderElectionService.isLeader;
    const originalAgents = LeaderElectionService.isAgentsWindow;

    setup(() => {
        LeaderElectionService.isInitialized = () => false;
        LeaderElectionService.isLeader = () => false;
        LeaderElectionService.isAgentsWindow = () => false;
    });

    teardown(() => {
        LeaderElectionService.isInitialized = originalInitialized;
        LeaderElectionService.isLeader = originalLeader;
        LeaderElectionService.isAgentsWindow = originalAgents;
    });

    test('configuration writes and request snapshots do not require filesystem storage', async () => {
        initialize();
        await seed('slot');
        assert.equal(await applyConfigSet('slot', { id: 'b', label: 'b' }), true);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot');
        assert.equal(attempt?.activeId, 'b');
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-b');
        await ConfigSetStore.remove('slot', 'a');
        assert.deepEqual(ConfigSetStore.listProviders(), ['slot']);
        assert.deepEqual(
            ConfigSetStore.list('slot').map(item => item.id),
            ['b']
        );
    });

    for (const slot of ['zhipu', 'minimax-token', 'custom-remove']) {
        test(`UI removal clears both saved and active secrets for ${slot}`, async () => {
            const context = initialize();
            await seed(slot);
            const posts: HostMessage[] = [];
            const changes: string[] = [];
            const subscription = ApiKeyManager.onDidChangeApiKey(event => {
                if (event.provider === slot) {
                    changes.push(event.action);
                }
            });
            try {
                await createPanel(posts).handleRemove(slot, 'a');
            } finally {
                subscription.dispose();
            }
            const result = posts.at(-1);
            assert.ok(result?.command === 'removeResult');
            assert.equal(result.ok, true);
            assert.equal(await context.secrets.get(`${slot}.apiKey`), undefined);
            assert.equal(await context.secrets.get(`configSet.${slot}.a`), undefined);
            assert.equal(await ApiKeyManager.hasValidApiKey(slot), false);
            assert.equal(ConfigSetStore.getActiveId(slot), undefined);
            assert.deepEqual(
                ConfigSetStore.list(slot).map(item => item.id),
                ['b']
            );
            assert.equal(await ConfigSetStore.getApiKey(slot, 'b'), `key-${slot}-b`);
            assert.deepEqual(changes, ['delete']);
            assert.equal(ConfigSetStore.getSwitchMode(slot), 'off');
            assert.doesNotMatch(result.note ?? '', /continue|stays|继续生效/i);
        });
    }

    test('UI removal clears a matching runtime key without an active marker', async () => {
        const context = initialize();
        await seed('slot');
        await ConfigSetStore.clearActive('slot');
        const posts: HostMessage[] = [];
        await createPanel(posts).handleRemove('slot', 'a');
        assert.equal(await context.secrets.get('slot.apiKey'), undefined);
        assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), undefined);
        assert.equal(ConfigSetStore.getActiveId('slot'), undefined);
        assert.equal(await ConfigSetStore.getApiKey('slot', 'b'), 'key-slot-b');
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && result.ok);
    });

    test('UI removal of an inactive configuration preserves the active key', async () => {
        const context = initialize();
        await seed('slot');
        const posts: HostMessage[] = [];
        await createPanel(posts).handleRemove('slot', 'b');
        assert.equal(await context.secrets.get('slot.apiKey'), 'key-slot-a');
        assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), 'key-slot-a');
        assert.equal(await ConfigSetStore.getApiKey('slot', 'b'), undefined);
        assert.equal(ConfigSetStore.getActiveId('slot'), 'a');
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && result.ok);
    });

    for (const marked of [true, false]) {
        test(`removing an inactive duplicate preserves the effective active configuration (marked=${marked})`, async () => {
            const context = initialize();
            await seed('slot');
            await ConfigSetStore.setApiKey('slot', 'b', 'key-slot-a');
            if (marked) {
                await ConfigSetStore.setActive('slot', 'b');
            } else {
                await ConfigSetStore.clearActive('slot');
            }
            const removedId = marked ? 'a' : 'b';
            const retainedId = marked ? 'b' : 'a';
            const posts: HostMessage[] = [];
            await createPanel(posts).handleRemove('slot', removedId);
            assert.equal(await context.secrets.get('slot.apiKey'), 'key-slot-a');
            assert.equal(await ConfigSetStore.getApiKey('slot', removedId), undefined);
            assert.equal(await ConfigSetStore.getApiKey('slot', retainedId), 'key-slot-a');
            assert.equal(ConfigSetStore.getActiveId('slot'), marked ? 'b' : undefined);
            const result = posts.at(-1);
            assert.ok(result?.command === 'removeResult' && result.ok);
        });
    }

    test('UI removal resolves the active key after earlier queued switches complete', async () => {
        const context = initialize();
        await seed('slot');
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const switching = enqueueConfigSetMutation(async () => {
            await gate;
            await applyConfigSetUnlocked('slot', { id: 'b', label: 'b' });
        });
        const posts: HostMessage[] = [];
        const removing = createPanel(posts).handleRemove('slot', 'b');
        release();
        await Promise.all([switching, removing]);
        assert.equal(await context.secrets.get('slot.apiKey'), undefined);
        assert.equal(await ConfigSetStore.getApiKey('slot', 'b'), undefined);
        assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), 'key-slot-a');
        assert.equal(ConfigSetStore.getActiveId('slot'), undefined);
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && result.ok);
    });

    for (const fault of ['runtime', 'runtime-written', 'saved', 'saved-written', 'index'] as const) {
        test(`failed UI removal restores the saved and runtime credentials (${fault})`, async () => {
            const context = initialize();
            await seed('slot');
            const originalDelete = context.secrets.delete.bind(context.secrets);
            const originalUpdate = context.globalState.update.bind(context.globalState);
            let injected = false;
            context.secrets.delete = async key => {
                const target = fault.startsWith('runtime') ? 'slot.apiKey' : 'configSet.slot.a';
                if (fault !== 'index' && key === target && !injected) {
                    injected = true;
                    if (fault.endsWith('written')) {
                        await originalDelete(key);
                    }
                    throw new Error('removal-storage-failed');
                }
                await originalDelete(key);
            };
            context.globalState.update = async (key, value) => {
                if (
                    fault === 'index' &&
                    key === 'configSets.items.slot' &&
                    Array.isArray(value) &&
                    value.length === 1 &&
                    !injected
                ) {
                    injected = true;
                    throw new Error('removal-storage-failed');
                }
                await originalUpdate(key, value);
            };
            const posts: HostMessage[] = [];
            try {
                await createPanel(posts).handleRemove('slot', 'a');
            } finally {
                context.secrets.delete = originalDelete;
                context.globalState.update = originalUpdate;
            }
            assert.equal(injected, true);
            const result = posts.at(-1);
            assert.ok(result?.command === 'removeResult');
            assert.equal(result.ok, false);
            assert.match(result.error ?? '', /removal-storage-failed/);
            assert.equal(await context.secrets.get('slot.apiKey'), 'key-slot-a');
            assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), 'key-slot-a');
            assert.equal(await ConfigSetStore.getApiKey('slot', 'b'), 'key-slot-b');
            assert.equal(ConfigSetStore.getActiveId('slot'), 'a');
            assert.deepEqual(
                ConfigSetStore.list('slot').map(item => item.id),
                ['a', 'b']
            );
            assert.equal(ConfigSetStore.getSwitchMode('slot'), 'failover');
        });
    }

    test('failed UI removal does not restore its runtime key over a newer direct update', async () => {
        const context = initialize();
        await seed('slot');
        const originalDelete = context.secrets.delete.bind(context.secrets);
        let injected = false;
        context.secrets.delete = async key => {
            if (key === 'configSet.slot.a' && !injected) {
                injected = true;
                await ApiKeyManager.setApiKey('slot', 'newer-manual-key');
                throw new Error('removal-storage-failed');
            }
            await originalDelete(key);
        };
        const posts: HostMessage[] = [];
        try {
            await createPanel(posts).handleRemove('slot', 'a');
        } finally {
            context.secrets.delete = originalDelete;
        }
        assert.equal(injected, true);
        assert.equal(await context.secrets.get('slot.apiKey'), 'newer-manual-key');
        assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), 'key-slot-a');
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && !result.ok);
    });

    test('UI removal preserves the same runtime key used on another site', async () => {
        const context = initialize();
        const currentSite = readCurrentSite('zhipu');
        const otherSite = currentSite === 'api.z.ai' ? 'open.bigmodel.cn' : 'api.z.ai';
        await ConfigSetStore.add('zhipu', { id: 'current', label: 'current', site: currentSite }, 'shared-key');
        await ConfigSetStore.add('zhipu', { id: 'other', label: 'other', site: otherSite }, 'shared-key');
        await ConfigSetStore.setActive('zhipu', 'current');
        await ApiKeyManager.setApiKey('zhipu', 'shared-key');
        const posts: HostMessage[] = [];
        await createPanel(posts).handleRemove('zhipu', 'other');
        assert.equal(await context.secrets.get('zhipu.apiKey'), 'shared-key');
        assert.equal(await ConfigSetStore.getApiKey('zhipu', 'other'), undefined);
        assert.equal(await ConfigSetStore.getApiKey('zhipu', 'current'), 'shared-key');
        assert.equal(ConfigSetStore.getActiveId('zhipu'), 'current');
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && result.ok);
    });

    test('UI removal of a missing configuration does not touch the active credentials', async () => {
        const context = initialize();
        await seed('slot');
        const operation = ConfigSetStore.getApplyOperationToken('slot');
        const posts: HostMessage[] = [];
        await createPanel(posts).handleRemove('slot', 'missing');
        assert.equal(await context.secrets.get('slot.apiKey'), 'key-slot-a');
        assert.equal(await ConfigSetStore.getApiKey('slot', 'a'), 'key-slot-a');
        assert.equal(ConfigSetStore.getActiveId('slot'), 'a');
        assert.equal(ConfigSetStore.getApplyOperationToken('slot'), operation);
        const result = posts.at(-1);
        assert.ok(result?.command === 'removeResult' && !result.ok);
    });

    for (const maintenance of ['migration', 'site-backfill', 'existing-site'] as const) {
        test(`no-op ${maintenance} preserves batch rollback ownership`, async () => {
            initialize();
            await seed('first');
            await seed('second');
            if (maintenance === 'existing-site') {
                await ConfigSetStore.backfillMissingSite('first', 'site');
            }
            const originalSet = ApiKeyManager.setApiKey;
            let failed = false;
            ApiKeyManager.setApiKey = async (...args) => {
                if (args[0] === 'second' && args[1] === 'key-second-b' && !failed) {
                    failed = true;
                    const operation = ConfigSetStore.getApplyOperationToken('first');
                    if (maintenance === 'migration') {
                        await ConfigSetStore.ensureMigrated('first');
                    } else {
                        await ConfigSetStore.backfillMissingSite(
                            'first',
                            maintenance === 'existing-site' ? 'site' : undefined
                        );
                    }
                    assert.equal(ConfigSetStore.getApplyOperationToken('first'), operation);
                    throw new Error('second-slot-write-failed');
                }
                return await originalSet.call(ApiKeyManager, ...args);
            };
            const posts: HostMessage[] = [];
            try {
                await createPanel(posts).handleApplyActiveKeys([
                    { slot: 'first', activateId: 'b' },
                    { slot: 'second', activateId: 'b' }
                ]);
            } finally {
                ApiKeyManager.setApiKey = originalSet;
            }
            assert.equal(failed, true);
            assert.equal((posts.at(-1) as { ok: boolean }).ok, false);
            assert.equal(ConfigSetStore.getActiveId('first'), 'a');
            assert.equal(await ApiKeyManager.getApiKey('first'), 'key-first-a');
        });
    }

    for (const action of ['set', 'delete'] as const) {
        test(`a direct runtime key ${action} survives an older batch rollback`, async () => {
            initialize();
            await seed('first');
            await seed('second');
            const originalSet = ApiKeyManager.setApiKey;
            let failed = false;
            ApiKeyManager.setApiKey = async (...args) => {
                if (args[0] === 'second' && args[1] === 'key-second-b' && !failed) {
                    failed = true;
                    if (action === 'set') {
                        await originalSet.call(ApiKeyManager, 'first', 'manual-key');
                    } else {
                        await ApiKeyManager.deleteApiKey('first');
                    }
                    throw new Error('second-slot-write-failed');
                }
                return await originalSet.call(ApiKeyManager, ...args);
            };
            const posts: HostMessage[] = [];
            try {
                await createPanel(posts).handleApplyActiveKeys([
                    { slot: 'first', activateId: 'b' },
                    { slot: 'second', activateId: 'b' }
                ]);
            } finally {
                ApiKeyManager.setApiKey = originalSet;
            }
            assert.equal(failed, true);
            assert.equal((posts.at(-1) as { ok: boolean }).ok, false);
            assert.equal(await ApiKeyManager.getApiKey('first'), action === 'set' ? 'manual-key' : undefined);
        });

        test(`a failed direct runtime key ${action} preserves batch rollback ownership`, async () => {
            const context = initialize();
            await seed('first');
            await seed('second');
            const originalSet = ApiKeyManager.setApiKey;
            const originalStore = context.secrets.store.bind(context.secrets);
            const originalDelete = context.secrets.delete.bind(context.secrets);
            let failed = false;
            let ownershipPreserved = false;
            context.secrets.store = async (key, value) => {
                if (key === 'first.apiKey' && value === 'manual-key') {
                    throw new Error('direct-key-write-failed');
                }
                await originalStore(key, value);
            };
            context.secrets.delete = async key => {
                if (key === 'first.apiKey') {
                    throw new Error('direct-key-write-failed');
                }
                await originalDelete(key);
            };
            ApiKeyManager.setApiKey = async (...args) => {
                if (args[0] === 'second' && args[1] === 'key-second-b' && !failed) {
                    failed = true;
                    const operation = ConfigSetStore.getApplyOperationToken('first');
                    await assert.rejects(async () => {
                        if (action === 'set') {
                            await originalSet.call(ApiKeyManager, 'first', 'manual-key');
                        } else {
                            await ApiKeyManager.deleteApiKey('first');
                        }
                    }, /direct-key-write-failed/);
                    ownershipPreserved = ConfigSetStore.getApplyOperationToken('first') === operation;
                    throw new Error('second-slot-write-failed');
                }
                return await originalSet.call(ApiKeyManager, ...args);
            };
            const posts: HostMessage[] = [];
            try {
                await createPanel(posts).handleApplyActiveKeys([
                    { slot: 'first', activateId: 'b' },
                    { slot: 'second', activateId: 'b' }
                ]);
            } finally {
                ApiKeyManager.setApiKey = originalSet;
                context.secrets.store = originalStore;
                context.secrets.delete = originalDelete;
            }
            assert.equal(failed, true);
            assert.equal((posts.at(-1) as { ok: boolean }).ok, false);
            assert.match((posts.at(-1) as { error: string }).error, /second-slot-write-failed/);
            assert.equal(ConfigSetStore.getActiveId('first'), 'a');
            assert.equal(await ApiKeyManager.getApiKey('first'), 'key-first-a');
            assert.equal(ConfigSetStore.getActiveId('second'), 'a');
            assert.equal(await ApiKeyManager.getApiKey('second'), 'key-second-a');
            assert.equal(ownershipPreserved, true);
        });

        for (const outcome of ['not-written', 'written', 'read-failed', 'newer-owner'] as const) {
            test(`failed direct key ${action} restores ownership only when safe: ${outcome}`, async () => {
                const context = initialize();
                await context.secrets.store('slot.apiKey', 'original-key');
                if (outcome !== 'not-written') {
                    await ConfigSetStore.setApplyOperationToken('slot', 'previous-owner');
                }
                const previousOperation = ConfigSetStore.getApplyOperationToken('slot');
                const originalGet = context.secrets.get.bind(context.secrets);
                const originalStore = context.secrets.store.bind(context.secrets);
                const originalDelete = context.secrets.delete.bind(context.secrets);
                const writeError = new Error('direct-key-write-failed');
                let failureOccurred = false;
                context.secrets.store = async (key, value) => {
                    if (outcome === 'written') {
                        await originalStore(key, value);
                    }
                    failureOccurred = true;
                    throw writeError;
                };
                context.secrets.delete = async key => {
                    if (outcome === 'written') {
                        await originalDelete(key);
                    }
                    failureOccurred = true;
                    throw writeError;
                };
                context.secrets.get = async key => {
                    const value = await originalGet(key);
                    if (failureOccurred && outcome === 'read-failed') {
                        throw new Error('read-back-failed');
                    }
                    if (failureOccurred && outcome === 'newer-owner') {
                        await ConfigSetStore.setApplyOperationToken('slot', 'newer-owner');
                    }
                    return value;
                };
                try {
                    await assert.rejects(
                        () =>
                            action === 'set' ?
                                ApiKeyManager.setApiKey('slot', 'manual-key')
                            :   ApiKeyManager.deleteApiKey('slot'),
                        error => error === writeError
                    );
                } finally {
                    context.secrets.get = originalGet;
                    context.secrets.store = originalStore;
                    context.secrets.delete = originalDelete;
                }
                assert.equal(failureOccurred, true);
                if (outcome === 'not-written') {
                    assert.equal(ConfigSetStore.getApplyOperationToken('slot'), previousOperation);
                } else if (outcome === 'newer-owner') {
                    assert.equal(ConfigSetStore.getApplyOperationToken('slot'), 'newer-owner');
                } else {
                    assert.notEqual(ConfigSetStore.getApplyOperationToken('slot'), previousOperation);
                }
                assert.equal(
                    await ApiKeyManager.getApiKey('slot'),
                    outcome === 'written' ?
                        action === 'set' ?
                            'manual-key'
                        :   undefined
                    :   'original-key'
                );
            });
        }
    }

    test('a failed ownership write restores its previous marker without writing the key', async () => {
        const context = initialize();
        await seed('slot');
        const previousOperation = ConfigSetStore.getApplyOperationToken('slot');
        const originalUpdate = context.globalState.update.bind(context.globalState);
        const originalStore = context.secrets.store.bind(context.secrets);
        const writeError = new Error('ownership-write-failed');
        let failed = false;
        let keyWrites = 0;
        context.globalState.update = async (key, value) => {
            await originalUpdate(key, value);
            if (key === 'configSets.applyOperation.slot' && !failed) {
                failed = true;
                throw writeError;
            }
        };
        context.secrets.store = async (key, value) => {
            keyWrites += 1;
            await originalStore(key, value);
        };
        try {
            await assert.rejects(
                () => ApiKeyManager.setApiKey('slot', 'manual-key'),
                error => error === writeError
            );
        } finally {
            context.globalState.update = originalUpdate;
            context.secrets.store = originalStore;
        }
        assert.equal(keyWrites, 0);
        assert.equal(ConfigSetStore.getApplyOperationToken('slot'), previousOperation);
        assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-a');
    });

    test('snapshot read failures propagate instead of disabling failover', async () => {
        initialize();
        await seed('slot');
        const originalGet = ConfigSetStore.getApiKey;
        ConfigSetStore.getApiKey = async () => {
            throw new Error('snapshot-read-failed');
        };
        try {
            await assert.rejects(() => ApiKeyFailoverManager.captureAttempt('slot'), /snapshot-read-failed/);
        } finally {
            ConfigSetStore.getApiKey = originalGet;
        }
    });

    test('writing the same runtime key preserves operation ownership', async () => {
        initialize();
        await seed('slot');
        const operation = ConfigSetStore.getApplyOperationToken('slot');
        await ApiKeyManager.setApiKey('slot', 'key-slot-a');
        assert.equal(ConfigSetStore.getApplyOperationToken('slot'), operation);
    });

    for (const target of ['next', 'initial'] as const) {
        test(`failed ${target} failover target is applied once and rolls back the active configuration`, async () => {
            const context = initialize();
            await seed('slot', ['a', 'b', 'c']);
            const attempted = new Set<string>();
            let attempt = await ApiKeyFailoverManager.captureAttempt('slot');
            assert.ok(attempt);
            attempted.add(attempt.identity);
            if (target === 'initial') {
                for (const id of ['b', 'c']) {
                    await applyConfigSet('slot', { id, label: id });
                    attempt = await ApiKeyFailoverManager.captureAttempt('slot');
                    assert.ok(attempt);
                    attempted.add(attempt.identity);
                }
            }
            const sourceId = attempt.activeId;
            const sourceKey = attempt.apiKey;
            const targetKey = target === 'next' ? 'key-slot-b' : 'key-slot-a';
            const originalStore = context.secrets.store.bind(context.secrets);
            let targetWrites = 0;
            context.secrets.store = async (key, value) => {
                if (key === 'slot.apiKey' && value === targetKey) {
                    targetWrites += 1;
                    throw new Error('target-write-failed');
                }
                await originalStore(key, value);
            };
            try {
                const decision = await ApiKeyFailoverManager.handleFailure(
                    'slot',
                    { status: 429 },
                    attempt,
                    attempted,
                    3,
                    'a'
                );
                assert.deepEqual(decision, { handled: true, shouldRetry: false, switched: false });
                assert.equal(targetWrites, 1);
                assert.equal(ConfigSetStore.getActiveId('slot'), sourceId);
                assert.equal(await ApiKeyManager.getApiKey('slot'), sourceKey);
            } finally {
                context.secrets.store = originalStore;
            }
        });
    }

    test('failover does not overwrite a manual switch during target key lookup', async () => {
        initialize();
        await seed('slot', ['a', 'b', 'c']);
        const attempt = await ApiKeyFailoverManager.captureAttempt('slot');
        const originalGet = ConfigSetStore.getApiKey;
        let targetReads = 0;
        ConfigSetStore.getApiKey = async (...args) => {
            if (args[0] === 'slot' && args[1] === 'b' && ++targetReads === 2) {
                await ApiKeyManager.setApiKey('slot', 'key-slot-c');
                await ConfigSetStore.setActive('slot', 'c');
            }
            return await originalGet.call(ConfigSetStore, ...args);
        };
        try {
            const decision = await ApiKeyFailoverManager.handleFailure('slot', { status: 429 }, attempt, new Set(), 3);
            assert.equal(targetReads, 2);
            assert.equal(decision.switched, false);
            assert.equal(ConfigSetStore.getActiveId('slot'), 'c');
            assert.equal(await ApiKeyManager.getApiKey('slot'), 'key-slot-c');
        } finally {
            ConfigSetStore.getApiKey = originalGet;
        }
    });
});
