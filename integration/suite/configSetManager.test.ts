import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { StatusBarManager } from '../../src/status';
import { CrudHost } from '../../src/ui/configSetManager/crudHost';
import { ConfigSetSyncHost } from '../../src/ui/configSetManager/syncHost';
import type { PanelContext } from '../../src/ui/configSetManager/types';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigSetStore, type ConfigSetItem } from '../../src/utils/config/configSetStore';

function createMemento(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
        get<T>(key: string, defaultValue?: T): T {
            return (store.has(key) ? store.get(key) : defaultValue) as T;
        },
        keys(): readonly string[] {
            return Array.from(store.keys());
        },
        async update(key: string, value: unknown): Promise<void> {
            if (value === undefined) {
                store.delete(key);
                return;
            }
            store.set(key, value);
        }
    };
}

function createSecretStorage(): vscode.SecretStorage {
    const store = new Map<string, string>();
    const emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    return {
        keys(): Thenable<string[]> {
            return Promise.resolve(Array.from(store.keys()));
        },
        get(key: string): Thenable<string | undefined> {
            return Promise.resolve(store.get(key));
        },
        store(key: string, value: string): Thenable<void> {
            store.set(key, value);
            emitter.fire({ key });
            return Promise.resolve();
        },
        delete(key: string): Thenable<void> {
            store.delete(key);
            emitter.fire({ key });
            return Promise.resolve();
        },
        onDidChange: emitter.event
    };
}

function createExtensionContext(): vscode.ExtensionContext {
    return {
        globalState: createMemento(),
        workspaceState: createMemento(),
        secrets: createSecretStorage(),
        subscriptions: [],
        extensionMode: vscode.ExtensionMode.Test,
        extensionUri: vscode.Uri.file('v:/GitHub/Copilots/CopilotModel/GCMP'),
        storageUri: undefined,
        storagePath: undefined,
        globalStorageUri: vscode.Uri.file('v:/tmp/gcmp-tests/global'),
        globalStoragePath: 'v:/tmp/gcmp-tests/global',
        logUri: vscode.Uri.file('v:/tmp/gcmp-tests/log'),
        logPath: 'v:/tmp/gcmp-tests/log',
        extensionPath: 'v:/GitHub/Copilots/CopilotModel/GCMP',
        environmentVariableCollection: {} as vscode.GlobalEnvironmentVariableCollection,
        asAbsolutePath(relativePath: string): string {
            return relativePath;
        },
        extension: {} as vscode.Extension<unknown>,
        languageModelAccessInformation: {} as vscode.LanguageModelAccessInformation,
        storagePathUri: undefined
    } as unknown as vscode.ExtensionContext;
}

function createPanelContext(posts: unknown[]): PanelContext {
    return {
        post(msg) {
            posts.push(msg);
        },
        async sendStates(): Promise<void> {},
        async refreshCliProviders(): Promise<void> {},
        async refreshCliUsage(): Promise<void> {},
        isAlive(): boolean {
            return true;
        }
    };
}

suite('config set label behavior', () => {
    test('ConfigSetStore.add allows duplicate labels in the same slot', async () => {
        ConfigSetStore.initialize(createExtensionContext());

        await ConfigSetStore.add('slot-a', { id: 'a', label: 'duplicate' }, 'key-a');
        await ConfigSetStore.add('slot-a', { id: 'b', label: 'duplicate' }, 'key-b');

        assert.deepEqual(
            ConfigSetStore.list('slot-a').map(item => item.id),
            ['a', 'b']
        );
    });

    test('ConfigSetStore.updateMeta allows renaming to an existing label', async () => {
        ConfigSetStore.initialize(createExtensionContext());

        await ConfigSetStore.add('slot-b', { id: 'a', label: 'duplicate' }, 'key-a');
        await ConfigSetStore.add('slot-b', { id: 'b', label: 'other' }, 'key-b');

        await ConfigSetStore.updateMeta('slot-b', 'b', { label: 'duplicate' });

        assert.deepEqual(
            ConfigSetStore.list('slot-b').map(item => ({ id: item.id, label: item.label })),
            [
                { id: 'a', label: 'duplicate' },
                { id: 'b', label: 'duplicate' }
            ]
        );
    });

    test('CrudHost.handleAdd does not reject duplicate labels', async () => {
        const posts: unknown[] = [];
        const host = new CrudHost(createPanelContext(posts));
        const mutableStore = ConfigSetStore as unknown as {
            add: typeof ConfigSetStore.add;
            ensureMigrated: typeof ConfigSetStore.ensureMigrated;
            list: typeof ConfigSetStore.list;
        };
        const mutableKeys = ApiKeyManager as unknown as {
            getApiKey: typeof ApiKeyManager.getApiKey;
        };
        const originalEnsureMigrated = mutableStore.ensureMigrated;
        const originalList = mutableStore.list;
        const originalAdd = mutableStore.add;
        const originalGetApiKey = mutableKeys.getApiKey;
        let addedItem: ConfigSetItem | undefined;

        mutableStore.ensureMigrated = async () => {};
        mutableStore.list = () => [{ id: 'existing', label: 'duplicate' }];
        mutableStore.add = async (_slot, item) => {
            addedItem = item;
        };
        mutableKeys.getApiKey = async () => 'runtime-key';

        try {
            await host.handleAdd('slot-c', 'duplicate', undefined, undefined, 'new-key');
        } finally {
            mutableStore.ensureMigrated = originalEnsureMigrated;
            mutableStore.list = originalList;
            mutableStore.add = originalAdd;
            mutableKeys.getApiKey = originalGetApiKey;
        }

        assert.ok(addedItem, 'expected duplicate label item to be added');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'addResult'));
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).ok === true));
    });

    test('CrudHost.handleEdit does not reject duplicate labels', async () => {
        const posts: unknown[] = [];
        const host = new CrudHost(createPanelContext(posts));
        const mutableStore = ConfigSetStore as unknown as {
            getApiKey: typeof ConfigSetStore.getApiKey;
            list: typeof ConfigSetStore.list;
            updateMeta: typeof ConfigSetStore.updateMeta;
        };
        const mutableKeys = ApiKeyManager as unknown as {
            getApiKey: typeof ApiKeyManager.getApiKey;
        };
        const originalList = mutableStore.list;
        const originalUpdateMeta = mutableStore.updateMeta;
        const originalGetSavedKey = mutableStore.getApiKey;
        const originalGetApiKey = mutableKeys.getApiKey;
        let updated = false;

        mutableStore.list = () => [
            { id: 'a', label: 'duplicate' },
            { id: 'b', label: 'other' }
        ];
        mutableStore.updateMeta = async () => {
            updated = true;
        };
        mutableStore.getApiKey = async () => 'saved-key';
        mutableKeys.getApiKey = async () => undefined;

        try {
            await host.handleEdit('slot-d', 'b', 'duplicate', undefined, undefined);
        } finally {
            mutableStore.list = originalList;
            mutableStore.updateMeta = originalUpdateMeta;
            mutableStore.getApiKey = originalGetSavedKey;
            mutableKeys.getApiKey = originalGetApiKey;
        }

        assert.equal(updated, true, 'expected duplicate label edit to reach updateMeta');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'editResult'));
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).ok === true));
    });

    test('ConfigSetSyncHost.handleRestore keeps local-only configs when all remote items are selected', async () => {
        ConfigSetStore.initialize(createExtensionContext());
        await ConfigSetStore.add('slot-sync', { id: 'local-only', label: 'Local Only' }, 'local-key');

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            confirmLocalActive: (slot: string) => Promise<void>;
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            postSyncState: () => Promise<void>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    data: {
                        slots: Record<string, { items: Array<{ apiKey: string; id: string; label: string }> }>;
                    };
                };
                usedGistId: string | undefined;
            }>;
            resolveGistId: (token: string) => Promise<string | undefined>;
        };
        const originalEnsureGistToken = mutableHost.ensureGistToken;
        const originalResolveGistId = mutableHost.resolveGistId;
        const originalReadConfigSetsWithFallback = mutableHost.readConfigSetsWithFallback;
        const originalConfirmLocalActive = mutableHost.confirmLocalActive;
        const originalPostSyncState = mutableHost.postSyncState;

        mutableHost.ensureGistToken = async () => ({ id: 1, login: 'tester', token: 'token' });
        mutableHost.resolveGistId = async () => 'gist-1';
        mutableHost.readConfigSetsWithFallback = async () => ({
            result: {
                status: 'ok',
                data: {
                    slots: {
                        'slot-sync': {
                            items: [
                                { id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' },
                                { id: 'remote-b', label: 'Remote B', apiKey: 'remote-key-b' }
                            ]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });
        mutableHost.confirmLocalActive = async () => {};
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleRestore([{ slot: 'slot-sync', itemIds: ['remote-a', 'remote-b'] }]);
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
            mutableHost.confirmLocalActive = originalConfirmLocalActive;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.deepEqual(
            ConfigSetStore.list('slot-sync').map(item => item.id),
            ['local-only', 'remote-a', 'remote-b']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-sync', 'local-only'), 'local-key');
        assert.equal(await ConfigSetStore.getApiKey('slot-sync', 'remote-a'), 'remote-key-a');
        assert.equal(await ConfigSetStore.getApiKey('slot-sync', 'remote-b'), 'remote-key-b');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'downloadResult'));
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).ok === true));
    });

    test('ConfigSetSyncHost.handleRestore uses prepared snapshot without re-reading remote data', async () => {
        ConfigSetStore.initialize(createExtensionContext());

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            preparedDownloadSlots?: Record<string, { items: Array<{ id: string; label: string; apiKey: string }> }>;
            confirmLocalActive: (slot: string) => Promise<void>;
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            postSyncState: () => Promise<void>;
        };
        const originalEnsureGistToken = mutableHost.ensureGistToken;
        const originalConfirmLocalActive = mutableHost.confirmLocalActive;
        const originalPostSyncState = mutableHost.postSyncState;
        let ensureCalls = 0;

        mutableHost.preparedDownloadSlots = {
            'slot-prepared': {
                items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' }]
            }
        };
        mutableHost.ensureGistToken = async () => {
            ensureCalls += 1;
            return undefined;
        };
        mutableHost.confirmLocalActive = async () => {};
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleRestore([{ slot: 'slot-prepared', itemIds: ['remote-a'] }]);
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.confirmLocalActive = originalConfirmLocalActive;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.equal(ensureCalls, 0, 'prepared snapshot should avoid re-reading remote data');
        assert.deepEqual(
            ConfigSetStore.list('slot-prepared').map(item => item.id),
            ['remote-a']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-prepared', 'remote-a'), 'remote-key-a');
        assert.equal(mutableHost.preparedDownloadSlots, undefined, 'prepared snapshot should be cleared after restore');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'downloadResult'));
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).ok === true));
    });

    test('ApiKeyManager.setApiKey stays successful when status refresh hooks fail', async () => {
        const context = createExtensionContext();
        ApiKeyManager.initialize(context);

        const mutableStatusBarManager = StatusBarManager as unknown as {
            getStatusBar: unknown;
            compatible: unknown;
        };
        const originalGetStatusBar = mutableStatusBarManager.getStatusBar;
        const originalCompatible = mutableStatusBarManager.compatible;
        let eventCount = 0;
        const subscription = ApiKeyManager.onDidChangeApiKey(({ provider, action }) => {
            if (provider === 'slot-status' && action === 'set') {
                eventCount += 1;
            }
        });

        mutableStatusBarManager.getStatusBar = (() => ({
            checkAndShowStatus: async () => {
                throw new Error('status refresh failed');
            }
        })) as unknown;
        mutableStatusBarManager.compatible = {
            refreshAfterApiKeyChange: async () => {
                throw new Error('compatible refresh failed');
            }
        } as unknown;

        try {
            await ApiKeyManager.setApiKey('slot-status', 'runtime-key');
        } finally {
            subscription.dispose();
            mutableStatusBarManager.getStatusBar = originalGetStatusBar;
            mutableStatusBarManager.compatible = originalCompatible;
        }

        assert.equal(await ApiKeyManager.getApiKey('slot-status'), 'runtime-key');
        assert.equal(eventCount, 1);
    });

    test('ConfigSetSyncHost.handleRestore rolls back earlier slots when a later slot fails', async () => {
        ConfigSetStore.initialize(createExtensionContext());
        await ConfigSetStore.add('slot-ok', { id: 'local-ok', label: 'Local OK' }, 'local-key-ok');
        await ConfigSetStore.add('slot-fail', { id: 'local-fail', label: 'Local Fail' }, 'local-key-fail');

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            preparedDownloadSlots?: Record<string, { items: Array<{ id: string; label: string; apiKey: string }> }>;
            confirmLocalActive: (slot: string) => Promise<void>;
            postSyncState: () => Promise<void>;
        };
        const mutableStore = ConfigSetStore as unknown as {
            writeAll: typeof ConfigSetStore.writeAll;
        };
        const originalWriteAll = mutableStore.writeAll;
        const originalConfirmLocalActive = mutableHost.confirmLocalActive;
        const originalPostSyncState = mutableHost.postSyncState;
        let failed = false;

        mutableHost.preparedDownloadSlots = {
            'slot-ok': {
                items: [{ id: 'remote-ok', label: 'Remote OK', apiKey: 'remote-key-ok' }]
            },
            'slot-fail': {
                items: [{ id: 'remote-fail', label: 'Remote Fail', apiKey: 'remote-key-fail' }]
            }
        };
        mutableHost.confirmLocalActive = async () => {};
        mutableHost.postSyncState = async () => {};
        mutableStore.writeAll = async (slot, items, keys, activeId) => {
            if (slot === 'slot-fail' && !failed) {
                failed = true;
                throw new Error('restore failed');
            }
            return await originalWriteAll.call(ConfigSetStore, slot, items, keys, activeId);
        };

        try {
            await host.handleRestore([
                { slot: 'slot-ok', itemIds: ['remote-ok'] },
                { slot: 'slot-fail', itemIds: ['remote-fail'] }
            ]);
        } finally {
            mutableStore.writeAll = originalWriteAll;
            mutableHost.confirmLocalActive = originalConfirmLocalActive;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.deepEqual(
            ConfigSetStore.list('slot-ok').map(item => item.id),
            ['local-ok']
        );
        assert.deepEqual(
            ConfigSetStore.list('slot-fail').map(item => item.id),
            ['local-fail']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-ok', 'local-ok'), 'local-key-ok');
        assert.equal(await ConfigSetStore.getApiKey('slot-fail', 'local-fail'), 'local-key-fail');
        assert.equal(mutableHost.preparedDownloadSlots, undefined, 'prepared snapshot should be cleared after failure');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'downloadResult'));
        assert.ok(posts.some(msg => (msg as { ok?: boolean }).ok === false));
    });

    test('ConfigSetSyncHost.handleRestore rolls back current slot when confirmLocalActive fails', async () => {
        ConfigSetStore.initialize(createExtensionContext());
        await ConfigSetStore.add('slot-confirm', { id: 'local-confirm', label: 'Local Confirm' }, 'local-key-confirm');

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            preparedDownloadSlots?: Record<string, { items: Array<{ id: string; label: string; apiKey: string }> }>;
            confirmLocalActive: (slot: string) => Promise<void>;
            postSyncState: () => Promise<void>;
        };
        const originalConfirmLocalActive = mutableHost.confirmLocalActive;
        const originalPostSyncState = mutableHost.postSyncState;

        mutableHost.preparedDownloadSlots = {
            'slot-confirm': {
                items: [{ id: 'remote-confirm', label: 'Remote Confirm', apiKey: 'remote-key-confirm' }]
            }
        };
        mutableHost.confirmLocalActive = async () => {
            throw new Error('confirm failed');
        };
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleRestore([{ slot: 'slot-confirm', itemIds: ['remote-confirm'] }]);
        } finally {
            mutableHost.confirmLocalActive = originalConfirmLocalActive;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.deepEqual(
            ConfigSetStore.list('slot-confirm').map(item => item.id),
            ['local-confirm']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-confirm', 'local-confirm'), 'local-key-confirm');
        assert.equal(await ConfigSetStore.getApiKey('slot-confirm', 'remote-confirm'), undefined);
        assert.equal(mutableHost.preparedDownloadSlots, undefined, 'prepared snapshot should be cleared after failure');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'downloadResult'));
        assert.ok(posts.some(msg => (msg as { ok?: boolean }).ok === false));
    });

    test('ConfigSetSyncHost.discardPreparedRestore clears prepared snapshot', () => {
        const host = new ConfigSetSyncHost({
            post() {},
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            preparedDownloadSlots?: Record<string, { items: Array<{ id: string; label: string; apiKey: string }> }>;
        };

        mutableHost.preparedDownloadSlots = {
            slot: { items: [{ id: 'remote', label: 'Remote', apiKey: 'remote-key' }] }
        };

        host.discardPreparedRestore();

        assert.equal(mutableHost.preparedDownloadSlots, undefined);
    });
});
