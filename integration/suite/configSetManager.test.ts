import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { GistSyncService } from '../../src/sync/gistSyncService';
import { runSetPassphraseFlow } from '../../src/sync/passphraseFlow';
import { StatusBarManager } from '../../src/status';
import { CrudHost } from '../../src/ui/configSetManager/crudHost';
import { ConfigSetSyncHost } from '../../src/ui/configSetManager/syncHost';
import type { PanelContext } from '../../src/ui/configSetManager/types';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { enqueueConfigSetMutation } from '../../src/utils/config/configSetCommands';
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

    test('CrudHost.handleAdd keeps the saved configuration when automatic activation fails', async () => {
        const context = createExtensionContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);

        const posts: unknown[] = [];
        const host = new CrudHost(createPanelContext(posts));
        const mutableKeys = ApiKeyManager as unknown as {
            setApiKey: typeof ApiKeyManager.setApiKey;
        };
        const originalSetApiKey = mutableKeys.setApiKey;
        mutableKeys.setApiKey = async () => {
            throw new Error('runtime apply failed');
        };

        try {
            await host.handleAdd('slot-add', 'Config A', undefined, undefined, 'saved-key');
        } finally {
            mutableKeys.setApiKey = originalSetApiKey;
        }

        assert.deepEqual(
            ConfigSetStore.list('slot-add').map(item => item.label),
            ['Config A']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-add', ConfigSetStore.list('slot-add')[0]!.id), 'saved-key');
        assert.equal(await ApiKeyManager.getApiKey('slot-add'), undefined);

        const result = posts.find(msg => (msg as { command?: string }).command === 'addResult') as
            | { command: 'addResult'; ok: boolean; note?: string }
            | undefined;
        assert.ok(result, 'expected an addResult message');
        assert.equal(result?.ok, true);
        assert.match(result?.note ?? '', /自动激活失败|automatic activation failed/i);
    });

    test('CrudHost.handleApply stays successful when panel refresh fails after commit', async () => {
        const context = createExtensionContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add('slot-apply', { id: 'apply-a', label: 'Apply A' }, 'apply-key');

        const posts: unknown[] = [];
        const mutableWindow = vscode.window as unknown as {
            showWarningMessage: typeof vscode.window.showWarningMessage;
        };
        const originalShowWarningMessage = mutableWindow.showWarningMessage;
        mutableWindow.showWarningMessage = async () => undefined;

        const host = new CrudHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {
                throw new Error('refresh failed');
            },
            async refreshCliProviders(): Promise<void> {},
            async refreshCliUsage(): Promise<void> {},
            isAlive(): boolean {
                return true;
            }
        });

        try {
            await host.handleApply('slot-apply', 'apply-a');
        } finally {
            mutableWindow.showWarningMessage = originalShowWarningMessage;
        }

        assert.equal(ConfigSetStore.getActiveId('slot-apply'), 'apply-a');
        assert.equal(await ApiKeyManager.getApiKey('slot-apply'), 'apply-key');

        const result = posts.find(msg => (msg as { command?: string }).command === 'applyResult') as
            | { command: 'applyResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected an applyResult message');
        assert.equal(result?.ok, true);
        assert.equal(result?.error, undefined);
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

    test('ConfigSetSyncHost.handleDownload exposes skipped remote items to the UI', async () => {
        ConfigSetStore.initialize(createExtensionContext());

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            postSyncState: () => Promise<void>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    skipped?: number;
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
        const originalPostSyncState = mutableHost.postSyncState;

        mutableHost.ensureGistToken = async () => ({ id: 1, login: 'tester', token: 'token' });
        mutableHost.resolveGistId = async () => 'gist-1';
        mutableHost.readConfigSetsWithFallback = async () => ({
            result: {
                status: 'ok',
                skipped: 2,
                data: {
                    slots: {
                        'slot-sync': {
                            items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' }]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleDownload();
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
            mutableHost.postSyncState = originalPostSyncState;
        }

        const prep = posts.find(msg => (msg as { command?: string }).command === 'downloadPrep') as
            | { command: 'downloadPrep'; warning?: string }
            | undefined;
        assert.ok(prep, 'expected a downloadPrep message');
        assert.match(prep.warning ?? '', /2/);
    });

    test('ConfigSetSyncHost.handleUpload blocks when remote data still has skipped undecryptable items', async () => {
        const context = createExtensionContext();
        ConfigSetStore.initialize(context);
        await ConfigSetStore.add('slot-sync', { id: 'local-a', label: 'Local A' }, 'local-key-a');

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            postSyncState: () => Promise<void>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    skipped?: number;
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
        const originalPostSyncState = mutableHost.postSyncState;

        mutableHost.ensureGistToken = async () => ({ id: 1, login: 'tester', token: 'token' });
        mutableHost.resolveGistId = async () => 'gist-1';
        mutableHost.readConfigSetsWithFallback = async () => ({
            result: {
                status: 'ok',
                skipped: 1,
                data: {
                    slots: {
                        'slot-sync': {
                            items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' }]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleUpload();
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
            mutableHost.postSyncState = originalPostSyncState;
        }

        const result = posts.find(msg => (msg as { command?: string }).command === 'uploadResult') as
            | { command: 'uploadResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected an uploadResult message');
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /1/);
        assert.equal(
            posts.some(msg => (msg as { command?: string }).command === 'uploadPrep'),
            false
        );
    });

    test('ConfigSetSyncHost.handleUploadSelected rejects remote deletions when local selection is not a full slot', async () => {
        const context = createExtensionContext();
        ConfigSetStore.initialize(context);
        await ConfigSetStore.writeAll(
            'slot-sync',
            [
                { id: 'local-a', label: 'Local A' },
                { id: 'local-b', label: 'Local B' }
            ],
            {
                'local-a': 'local-key-a',
                'local-b': undefined
            }
        );

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            postSyncState: () => Promise<void>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    skipped?: number;
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
                                { id: 'local-a', label: 'Remote A', apiKey: 'remote-key-a' },
                                { id: 'remote-only', label: 'Remote Only', apiKey: 'remote-only-key' }
                            ]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });
        mutableHost.postSyncState = async () => {};

        try {
            await host.handleUploadSelected([
                {
                    slot: 'slot-sync',
                    itemIds: ['local-a'],
                    removeItemIds: ['remote-only']
                }
            ]);
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
            mutableHost.postSyncState = originalPostSyncState;
        }

        const result = posts.find(msg => (msg as { command?: string }).command === 'uploadResult') as
            | { command: 'uploadResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected an uploadResult message');
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /重新打开上传对话框|upload dialog/i);
    });

    test('ConfigSetSyncHost.handleListRemoteConfigs blocks when remote data still has skipped undecryptable items', async () => {
        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    skipped?: number;
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

        mutableHost.ensureGistToken = async () => ({ id: 1, login: 'tester', token: 'token' });
        mutableHost.resolveGistId = async () => 'gist-1';
        mutableHost.readConfigSetsWithFallback = async () => ({
            result: {
                status: 'ok',
                skipped: 1,
                data: {
                    slots: {
                        'slot-sync': {
                            items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' }]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });

        try {
            await host.handleListRemoteConfigs();
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
        }

        const result = posts.find(msg => (msg as { command?: string }).command === 'remoteConfigsResult') as
            | { command: 'remoteConfigsResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected a remoteConfigsResult message');
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /1/);
        assert.equal(
            posts.some(msg => (msg as { command?: string }).command === 'remoteConfigsPrep'),
            false
        );
    });

    test('ConfigSetSyncHost.handleApplyRemoteConfigs blocks when remote data still has skipped undecryptable items', async () => {
        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            ensureGistToken: () => Promise<{ id: number; login: string; token: string } | undefined>;
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: {
                    status: 'ok';
                    skipped?: number;
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

        mutableHost.ensureGistToken = async () => ({ id: 1, login: 'tester', token: 'token' });
        mutableHost.resolveGistId = async () => 'gist-1';
        mutableHost.readConfigSetsWithFallback = async () => ({
            result: {
                status: 'ok',
                skipped: 1,
                data: {
                    slots: {
                        'slot-sync': {
                            items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'remote-key-a' }]
                        }
                    }
                }
            },
            usedGistId: 'gist-1'
        });

        try {
            await host.handleApplyRemoteConfigs([{ slot: 'slot-sync', itemIds: ['remote-a'] }]);
        } finally {
            mutableHost.ensureGistToken = originalEnsureGistToken;
            mutableHost.resolveGistId = originalResolveGistId;
            mutableHost.readConfigSetsWithFallback = originalReadConfigSetsWithFallback;
        }

        const result = posts.find(msg => (msg as { command?: string }).command === 'remoteConfigsResult') as
            | { command: 'remoteConfigsResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected a remoteConfigsResult message');
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /1/);
    });

    test('ConfigSetSyncHost.handleDownloadWithPassphrase does not persist partial passphrases', async () => {
        const posts: unknown[] = [];
        const warnings: string[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            pendingPassphraseDownload?: { token: string; gistId: string };
            postSyncState: () => Promise<void>;
            preparedDownloadSlots?: Record<string, { items: Array<{ apiKey: string; id: string; label: string }> }>;
        };
        const mutableGist = GistSyncService as unknown as {
            createBatchDecryptorWithPassphrase: typeof GistSyncService.createBatchDecryptorWithPassphrase;
            setCustomPassphrase: typeof GistSyncService.setCustomPassphrase;
            verifyPassphrase: typeof GistSyncService.verifyPassphrase;
        };
        const mutableWindow = vscode.window as unknown as {
            showWarningMessage: typeof vscode.window.showWarningMessage;
        };
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalCreateBatchDecryptorWithPassphrase = mutableGist.createBatchDecryptorWithPassphrase;
        const originalSetCustomPassphrase = mutableGist.setCustomPassphrase;
        const originalVerifyPassphrase = mutableGist.verifyPassphrase;
        const originalShowWarningMessage = mutableWindow.showWarningMessage;
        const originalPostSyncState = mutableHost.postSyncState;
        let savedPassphrase: string | undefined;

        mutableHost.pendingPassphraseDownload = { token: 'token', gistId: 'gist-1' };
        mutableHost.postSyncState = async () => {};
        ConfigManager.fetchWithProxy = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                files: {
                    'gcmp-configsets.json': {
                        content: JSON.stringify({
                            version: 1,
                            timestamp: '2026-08-15T00:00:00.000Z',
                            slots: {
                                'slot-sync': {
                                    items: [
                                        { id: 'remote-a', label: 'Remote A', apiKey: 'enc-ok' },
                                        { id: 'remote-b', label: 'Remote B', apiKey: 'enc-bad' }
                                    ]
                                }
                            }
                        })
                    }
                }
            })
        })) as unknown as typeof ConfigManager.fetchWithProxy;
        mutableGist.createBatchDecryptorWithPassphrase = (() =>
            Object.assign(async (payload: string) => (payload === 'enc-ok' ? 'plain-ok' : undefined), {
                dispose(): void {}
            })) as typeof GistSyncService.createBatchDecryptorWithPassphrase;
        mutableGist.verifyPassphrase = (async () => false) as typeof GistSyncService.verifyPassphrase;
        mutableGist.setCustomPassphrase = (async (passphrase: string) => {
            savedPassphrase = passphrase;
            return true;
        }) as typeof GistSyncService.setCustomPassphrase;
        mutableWindow.showWarningMessage = (async (message: string) => {
            warnings.push(message);
            return undefined;
        }) as typeof vscode.window.showWarningMessage;

        try {
            await host.handleDownloadWithPassphrase('passphrase');
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            mutableGist.createBatchDecryptorWithPassphrase = originalCreateBatchDecryptorWithPassphrase;
            mutableGist.setCustomPassphrase = originalSetCustomPassphrase;
            mutableGist.verifyPassphrase = originalVerifyPassphrase;
            mutableWindow.showWarningMessage = originalShowWarningMessage;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.equal(savedPassphrase, undefined);
        assert.ok(warnings.some(message => /1/.test(message)));
        assert.ok(mutableHost.preparedDownloadSlots?.['slot-sync']);
        const prep = posts.find(msg => (msg as { command?: string }).command === 'downloadPrep') as
            | { command: 'downloadPrep'; warning?: string }
            | undefined;
        assert.ok(prep, 'expected a downloadPrep message');
        assert.match(prep?.warning ?? '', /1/);
    });

    test('ConfigSetSyncHost.readConfigSetsWithFallback switches to another readable gist after decrypt failure', async () => {
        const host = new ConfigSetSyncHost({
            post() {},
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            readConfigSetsWithFallback: (
                token: string,
                gistId: string
            ) => Promise<{
                result: { status: string; data?: { slots: Record<string, unknown> } };
                usedGistId: string | undefined;
            }>;
        };
        const mutableGist = GistSyncService as unknown as {
            createBatchDecryptor: typeof GistSyncService.createBatchDecryptor;
            saveConfigSetGistId: typeof GistSyncService.saveConfigSetGistId;
        };
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalCreateBatchDecryptor = mutableGist.createBatchDecryptor;
        const originalSaveConfigSetGistId = mutableGist.saveConfigSetGistId;
        const savedIds: string[] = [];

        ConfigManager.fetchWithProxy = (async url => {
            const href = String(url);
            if (href.includes('/gists/bad-gist')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        files: {
                            'gcmp-configsets.json': {
                                content: JSON.stringify({
                                    version: 1,
                                    timestamp: '2026-08-18T00:00:00.000Z',
                                    slots: {
                                        'slot-sync': {
                                            items: [{ id: 'bad', label: 'Bad', apiKey: 'bad-payload' }]
                                        }
                                    }
                                })
                            }
                        }
                    })
                } as never;
            }
            if (href.includes('per_page=100&page=1')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => [
                        {
                            id: 'good-gist',
                            public: false,
                            description: 'GCMP ConfigSets - Provider configuration backup',
                            files: { 'gcmp-configsets.json': { filename: 'gcmp-configsets.json' } }
                        }
                    ]
                } as never;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    files: {
                        'gcmp-configsets.json': {
                            content: JSON.stringify({
                                version: 1,
                                timestamp: '2026-08-18T00:00:00.000Z',
                                slots: {
                                    'slot-sync': {
                                        items: [{ id: 'good', label: 'Good', apiKey: 'enc-ok' }]
                                    }
                                }
                            })
                        }
                    }
                })
            } as never;
        }) as typeof ConfigManager.fetchWithProxy;
        mutableGist.createBatchDecryptor = (async () =>
            Object.assign(async (payload: string) => (payload === 'enc-ok' ? 'plain-ok' : undefined), {
                dispose(): void {}
            })) as typeof GistSyncService.createBatchDecryptor;
        mutableGist.saveConfigSetGistId = (async gistId => {
            savedIds.push(gistId);
        }) as typeof GistSyncService.saveConfigSetGistId;

        try {
            const result = await mutableHost.readConfigSetsWithFallback('token', 'bad-gist');
            assert.equal(result.usedGistId, 'good-gist');
            assert.equal(result.result.status, 'ok');
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            mutableGist.createBatchDecryptor = originalCreateBatchDecryptor;
            mutableGist.saveConfigSetGistId = originalSaveConfigSetGistId;
        }

        assert.deepEqual(savedIds, ['good-gist']);
    });

    test('runSetPassphraseFlow aborts reupload when config set snapshot still has skipped items', async () => {
        const mutableGist = GistSyncService as unknown as {
            getGistId: typeof GistSyncService.getGistId;
            getStatus: typeof GistSyncService.getStatus;
            getUserInfo: typeof GistSyncService.getUserInfo;
            hasCustomPassphrase: typeof GistSyncService.hasCustomPassphrase;
            readDecryptedSyncData: typeof GistSyncService.readDecryptedSyncData;
            saveConfigSetGistId: typeof GistSyncService.saveConfigSetGistId;
            getConfigSetGistId: typeof GistSyncService.getConfigSetGistId;
            createBatchDecryptor: typeof GistSyncService.createBatchDecryptor;
            getCustomPassphrase: typeof GistSyncService.getCustomPassphrase;
            setCustomPassphrase: typeof GistSyncService.setCustomPassphrase;
        };
        const mutableWindow = vscode.window as unknown as {
            showErrorMessage: typeof vscode.window.showErrorMessage;
            showInformationMessage: typeof vscode.window.showInformationMessage;
            showInputBox: typeof vscode.window.showInputBox;
            showWarningMessage: typeof vscode.window.showWarningMessage;
        };
        const originalGetGistId = mutableGist.getGistId;
        const originalGetStatus = mutableGist.getStatus;
        const originalGetUserInfo = mutableGist.getUserInfo;
        const originalHasCustomPassphrase = mutableGist.hasCustomPassphrase;
        const originalReadDecryptedSyncData = mutableGist.readDecryptedSyncData;
        const originalSaveConfigSetGistId = mutableGist.saveConfigSetGistId;
        const originalGetConfigSetGistId = mutableGist.getConfigSetGistId;
        const originalCreateBatchDecryptor = mutableGist.createBatchDecryptor;
        const originalGetCustomPassphrase = mutableGist.getCustomPassphrase;
        const originalSetCustomPassphrase = mutableGist.setCustomPassphrase;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalShowErrorMessage = mutableWindow.showErrorMessage;
        const originalShowInformationMessage = mutableWindow.showInformationMessage;
        const originalShowInputBox = mutableWindow.showInputBox;
        const originalShowWarningMessage = mutableWindow.showWarningMessage;
        const errorMessages: string[] = [];
        let setPassphraseCalled = false;
        let inputCallCount = 0;

        mutableGist.getGistId = () => 'legacy-gist';
        mutableGist.getStatus = (async () => ({
            isLoggedIn: true,
            githubUser: 'tester',
            hasGist: true,
            hasCustomPassphrase: true
        })) as typeof GistSyncService.getStatus;
        mutableGist.getUserInfo = (async () => ({
            id: 1,
            login: 'tester',
            token: 'token'
        })) as typeof GistSyncService.getUserInfo;
        mutableGist.hasCustomPassphrase = (async () => true) as typeof GistSyncService.hasCustomPassphrase;
        mutableGist.readDecryptedSyncData = (async () => ({
            version: 1,
            timestamp: '2026-08-18T00:00:00.000Z',
            keys: {}
        })) as typeof GistSyncService.readDecryptedSyncData;
        mutableGist.saveConfigSetGistId = (async () => {}) as typeof GistSyncService.saveConfigSetGistId;
        mutableGist.getConfigSetGistId = () => 'config-gist';
        mutableGist.createBatchDecryptor = (async () =>
            Object.assign(async (payload: string) => (payload === 'enc-ok' ? 'plain-ok' : undefined), {
                dispose(): void {}
            })) as typeof GistSyncService.createBatchDecryptor;
        mutableGist.getCustomPassphrase = (async () => 'old-passphrase') as typeof GistSyncService.getCustomPassphrase;
        mutableGist.setCustomPassphrase = (async () => {
            setPassphraseCalled = true;
            return true;
        }) as typeof GistSyncService.setCustomPassphrase;
        ConfigManager.fetchWithProxy = (async url => {
            const href = String(url);
            if (href.includes('/gists/config-gist')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        files: {
                            'gcmp-configsets.json': {
                                content: JSON.stringify({
                                    version: 1,
                                    timestamp: '2026-08-18T00:00:00.000Z',
                                    slots: {
                                        'slot-sync': {
                                            items: [
                                                { id: 'good', label: 'Good', apiKey: 'enc-ok' },
                                                { id: 'bad', label: 'Bad', apiKey: 'bad-payload' }
                                            ]
                                        }
                                    }
                                })
                            }
                        }
                    })
                } as never;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({ files: {} })
            } as never;
        }) as typeof ConfigManager.fetchWithProxy;
        mutableWindow.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;
        mutableWindow.showInputBox = (async () => {
            inputCallCount += 1;
            return 'new-passphrase';
        }) as typeof vscode.window.showInputBox;
        mutableWindow.showWarningMessage = (async (
            _message: string,
            _options: vscode.MessageOptions | undefined,
            ...items: string[]
        ) => items[0]) as typeof vscode.window.showWarningMessage;
        mutableWindow.showErrorMessage = (async (message: string) => {
            errorMessages.push(message);
            return undefined;
        }) as typeof vscode.window.showErrorMessage;

        try {
            await runSetPassphraseFlow(true);
        } finally {
            mutableGist.getGistId = originalGetGistId;
            mutableGist.getStatus = originalGetStatus;
            mutableGist.getUserInfo = originalGetUserInfo;
            mutableGist.hasCustomPassphrase = originalHasCustomPassphrase;
            mutableGist.readDecryptedSyncData = originalReadDecryptedSyncData;
            mutableGist.saveConfigSetGistId = originalSaveConfigSetGistId;
            mutableGist.getConfigSetGistId = originalGetConfigSetGistId;
            mutableGist.createBatchDecryptor = originalCreateBatchDecryptor;
            mutableGist.getCustomPassphrase = originalGetCustomPassphrase;
            mutableGist.setCustomPassphrase = originalSetCustomPassphrase;
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            mutableWindow.showErrorMessage = originalShowErrorMessage;
            mutableWindow.showInformationMessage = originalShowInformationMessage;
            mutableWindow.showInputBox = originalShowInputBox;
            mutableWindow.showWarningMessage = originalShowWarningMessage;
        }

        assert.equal(inputCallCount, 2);
        assert.equal(setPassphraseCalled, false);
        assert.ok(errorMessages.some(message => /口令未更改|not changed/i.test(message)));
    });

    test('ConfigSetSyncHost.resolveGistId ignores the legacy API key gist when no config-set gist exists', async () => {
        const host = new ConfigSetSyncHost({
            post() {},
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            resolveGistId: (token: string) => Promise<string | undefined>;
        };
        const mutableGist = GistSyncService as unknown as {
            getConfigSetGistId: typeof GistSyncService.getConfigSetGistId;
            getGistId: typeof GistSyncService.getGistId;
            saveConfigSetGistId: typeof GistSyncService.saveConfigSetGistId;
        };
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalGetConfigSetGistId = mutableGist.getConfigSetGistId;
        const originalGetGistId = mutableGist.getGistId;
        const originalSaveConfigSetGistId = mutableGist.saveConfigSetGistId;
        let fetchCalls = 0;
        let savedGistId: string | undefined;

        ConfigManager.fetchWithProxy = (async () => {
            fetchCalls += 1;
            return { ok: true, json: async () => [] } as never;
        }) as unknown as typeof ConfigManager.fetchWithProxy;
        mutableGist.getConfigSetGistId = () => undefined;
        mutableGist.getGistId = () => 'legacy-gist';
        mutableGist.saveConfigSetGistId = (async (gistId: string) => {
            savedGistId = gistId;
        }) as typeof GistSyncService.saveConfigSetGistId;

        try {
            const gistId = await mutableHost.resolveGistId('token');
            assert.equal(gistId, undefined);
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            mutableGist.getConfigSetGistId = originalGetConfigSetGistId;
            mutableGist.getGistId = originalGetGistId;
            mutableGist.saveConfigSetGistId = originalSaveConfigSetGistId;
        }

        assert.equal(fetchCalls, 1);
        assert.equal(savedGistId, undefined);
    });

    test('ConfigSetSyncHost.resolveGistId discovers config-set data stored on a legacy gist', async () => {
        const host = new ConfigSetSyncHost({
            post() {},
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            resolveGistId: (token: string) => Promise<string | undefined>;
        };
        const mutableGist = GistSyncService as unknown as {
            createBatchDecryptor: typeof GistSyncService.createBatchDecryptor;
            getConfigSetGistId: typeof GistSyncService.getConfigSetGistId;
            getGistId: typeof GistSyncService.getGistId;
            saveConfigSetGistId: typeof GistSyncService.saveConfigSetGistId;
        };
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalCreateBatchDecryptor = mutableGist.createBatchDecryptor;
        const originalGetConfigSetGistId = mutableGist.getConfigSetGistId;
        const originalGetGistId = mutableGist.getGistId;
        const originalSaveConfigSetGistId = mutableGist.saveConfigSetGistId;
        let savedGistId: string | undefined;

        ConfigManager.fetchWithProxy = (async (url: string | URL | Request) => {
            if (String(url).includes('?per_page=100&page=1')) {
                return {
                    ok: true,
                    json: async () => [
                        {
                            id: 'legacy-configset-gist',
                            public: false,
                            description: 'GCMP Sync - API Key configuration backup',
                            files: {
                                'gcmp-configsets.json': {
                                    filename: 'gcmp-configsets.json'
                                }
                            }
                        }
                    ]
                } as never;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    files: {
                        'gcmp-configsets.json': {
                            content: JSON.stringify({
                                version: 1,
                                timestamp: '2026-08-15T00:00:00.000Z',
                                slots: {
                                    'slot-sync': {
                                        items: [{ id: 'remote-a', label: 'Remote A', apiKey: 'enc-ok' }]
                                    }
                                }
                            })
                        }
                    }
                })
            } as never;
        }) as unknown as typeof ConfigManager.fetchWithProxy;
        mutableGist.createBatchDecryptor = (async () =>
            Object.assign(async () => 'plain-ok', {
                dispose(): void {}
            })) as typeof GistSyncService.createBatchDecryptor;
        mutableGist.getConfigSetGistId = () => undefined;
        mutableGist.getGistId = () => 'legacy-gist';
        mutableGist.saveConfigSetGistId = (async (gistId: string) => {
            savedGistId = gistId;
        }) as typeof GistSyncService.saveConfigSetGistId;

        try {
            const gistId = await mutableHost.resolveGistId('token');
            assert.equal(gistId, 'legacy-configset-gist');
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            mutableGist.createBatchDecryptor = originalCreateBatchDecryptor;
            mutableGist.getConfigSetGistId = originalGetConfigSetGistId;
            mutableGist.getGistId = originalGetGistId;
            mutableGist.saveConfigSetGistId = originalSaveConfigSetGistId;
        }

        assert.equal(savedGistId, 'legacy-configset-gist');
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

    test('CrudHost.handleListActiveKeys includes outside runtime keys without saved configs', async () => {
        const context = createExtensionContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        await ApiKeyManager.setApiKey('zhipu', 'outside-runtime-key');

        const posts: unknown[] = [];
        const host = new CrudHost(createPanelContext(posts));

        await host.handleListActiveKeys();

        const prep = posts.find(msg => (msg as { command?: string }).command === 'activeKeysPrep') as
            | {
                  command: 'activeKeysPrep';
                  snapshots: Array<{ slot: string; outsideActive: boolean; items: unknown[] }>;
              }
            | undefined;
        assert.ok(prep, 'expected an activeKeysPrep message');

        const zhipu = prep?.snapshots.find(snapshot => snapshot.slot === 'zhipu');
        assert.ok(zhipu, 'expected zhipu snapshot to be included');
        assert.equal(zhipu?.outsideActive, true);
        assert.deepEqual(zhipu?.items, []);
    });

    test('CrudHost.handleApplyActiveKeys rolls back earlier slots when a later activation fails', async () => {
        const context = createExtensionContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);

        await ConfigSetStore.add('zhipu', { id: 'z-old', label: 'Z Old' }, 'z-old-key');
        await ConfigSetStore.add('zhipu', { id: 'z-new', label: 'Z New' }, 'z-new-key');
        await ConfigSetStore.setActive('zhipu', 'z-old');
        await ApiKeyManager.setApiKey('zhipu', 'z-old-key');

        await ConfigSetStore.add('deepseek', { id: 'd-old', label: 'D Old' }, 'd-old-key');
        await ConfigSetStore.add('deepseek', { id: 'd-new', label: 'D New' }, 'd-new-key');
        await ConfigSetStore.setActive('deepseek', 'd-old');
        await ApiKeyManager.setApiKey('deepseek', 'd-old-key');

        const posts: unknown[] = [];
        let sendStatesCalls = 0;
        const host = new CrudHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {
                sendStatesCalls += 1;
            },
            async refreshCliProviders(): Promise<void> {},
            async refreshCliUsage(): Promise<void> {},
            isAlive(): boolean {
                return true;
            }
        });

        const mutableKeys = ApiKeyManager as unknown as {
            setApiKey: typeof ApiKeyManager.setApiKey;
        };
        const originalSetApiKey = mutableKeys.setApiKey;
        mutableKeys.setApiKey = async (provider, apiKey) => {
            if (provider === 'deepseek' && apiKey === 'd-new-key') {
                throw new Error('apply failed');
            }
            return await originalSetApiKey.call(ApiKeyManager, provider, apiKey);
        };

        try {
            await host.handleApplyActiveKeys([
                { slot: 'zhipu', activateId: 'z-new' },
                { slot: 'deepseek', activateId: 'd-new' }
            ]);
        } finally {
            mutableKeys.setApiKey = originalSetApiKey;
        }

        assert.equal(sendStatesCalls, 0, 'sendStates should not run after failed batch apply');
        assert.equal(ConfigSetStore.getActiveId('zhipu'), 'z-old');
        assert.equal(await ApiKeyManager.getApiKey('zhipu'), 'z-old-key');
        assert.equal(ConfigSetStore.getActiveId('deepseek'), 'd-old');
        assert.equal(await ApiKeyManager.getApiKey('deepseek'), 'd-old-key');

        const result = posts.find(msg => (msg as { command?: string }).command === 'activeKeysResult') as
            | { command: 'activeKeysResult'; ok: boolean; error?: string }
            | undefined;
        assert.ok(result, 'expected an activeKeysResult message');
        assert.equal(result?.ok, false);
        assert.match(result?.error ?? '', /apply failed/);
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

    test('ConfigSetSyncHost.handleRestore preserves queued local mutations that finish before restore runs', async () => {
        ConfigSetStore.initialize(createExtensionContext());
        await ConfigSetStore.add('slot-race', { id: 'local-base', label: 'Local Base' }, 'local-key-base');

        const posts: unknown[] = [];
        const host = new ConfigSetSyncHost({
            post(msg) {
                posts.push(msg);
            },
            async sendStates(): Promise<void> {}
        });
        const mutableHost = host as unknown as {
            preparedDownloadSlots?: Record<string, { items: Array<{ id: string; label: string; apiKey: string }> }>;
            postSyncState: () => Promise<void>;
        };
        const originalPostSyncState = mutableHost.postSyncState;

        mutableHost.preparedDownloadSlots = {
            'slot-race': {
                items: [{ id: 'remote-new', label: 'Remote New', apiKey: 'remote-key-new' }]
            }
        };
        mutableHost.postSyncState = async () => {};

        try {
            const queuedMutation = enqueueConfigSetMutation(async () => {
                await ConfigSetStore.add('slot-race', { id: 'queued-local', label: 'Queued Local' }, 'queued-key');
            });

            await host.handleRestore([{ slot: 'slot-race', itemIds: ['remote-new'] }]);
            await queuedMutation;
        } finally {
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.deepEqual(
            ConfigSetStore.list('slot-race').map(item => item.id),
            ['local-base', 'queued-local', 'remote-new']
        );
        assert.equal(await ConfigSetStore.getApiKey('slot-race', 'queued-local'), 'queued-key');
        assert.equal(await ConfigSetStore.getApiKey('slot-race', 'remote-new'), 'remote-key-new');
        assert.ok(posts.some(msg => (msg as { command?: string; ok?: boolean }).command === 'downloadResult'));
        assert.ok(posts.some(msg => (msg as { ok?: boolean }).ok === true));
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

    test('ConfigSetSyncHost.handleRestore finishes rollback before queued mutations resume', async () => {
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
        let observerTask: Promise<void> | undefined;
        let observedIds: string[] | undefined;

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
            if (slot === 'slot-fail' && !observerTask) {
                observerTask = enqueueConfigSetMutation(async () => {
                    observedIds = ConfigSetStore.list('slot-ok').map(item => item.id);
                });
                throw new Error('restore failed');
            }
            return await originalWriteAll.call(ConfigSetStore, slot, items, keys, activeId);
        };

        try {
            await host.handleRestore([
                { slot: 'slot-ok', itemIds: ['remote-ok'] },
                { slot: 'slot-fail', itemIds: ['remote-fail'] }
            ]);
            await observerTask;
        } finally {
            mutableStore.writeAll = originalWriteAll;
            mutableHost.confirmLocalActive = originalConfirmLocalActive;
            mutableHost.postSyncState = originalPostSyncState;
        }

        assert.deepEqual(observedIds, ['local-ok']);
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
