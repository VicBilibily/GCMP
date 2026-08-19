import assert from 'node:assert/strict';

import { GistSyncService } from '../../src/sync/gistSyncService';
import { encrypt } from '../../src/sync/syncCrypto';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';

interface MockableGistSyncService {
    createGist(token: string, syncData: unknown): Promise<string | undefined>;
    decrypt(encryptedPayload: string): Promise<string | undefined>;
    decryptSyncData(syncData: {
        version: number;
        timestamp: string;
        keys: Record<string, string>;
    }): Promise<{ version: number; timestamp: string; keys: Record<string, string> } | undefined>;
    findExistingSyncGist(token: string): Promise<string | undefined>;
    getGistId(): string | undefined;
    getGithubId(): string | undefined;
    notifyProviders(keyNames: string[]): void;
    readSyncData(
        token: string,
        gistId: string
    ): Promise<{ version: number; timestamp: string; keys: Record<string, string> } | undefined>;
    updateGist(token: string, gistId: string, syncData: unknown): Promise<boolean>;
}

suite('gistSyncService', () => {
    test('decryptRemoteKeysWithPassphrase rejects partial decrypts', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalGetGithubId = service.getGithubId;
        const originalReadSyncData = service.readSyncData;

        service.getGithubId = () => 'user-1';
        service.readSyncData = async () => ({
            version: 1,
            timestamp: '2026-08-15T00:00:00.000Z',
            keys: {
                'valid.apiKey': (await encrypt('user-1', 'plain-secret', 'passphrase'))!,
                'broken.apiKey': 'not-an-encrypted-payload'
            }
        });

        try {
            const decrypted = await GistSyncService.decryptRemoteKeysWithPassphrase('token', 'gist-1', 'passphrase');
            assert.equal(decrypted, undefined);
        } finally {
            service.getGithubId = originalGetGithubId;
            service.readSyncData = originalReadSyncData;
        }
    });

    test('readDecryptedSyncData ignores blank entries', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalDecrypt = service.decrypt;
        const originalReadSyncData = service.readSyncData;

        service.decrypt = async encryptedPayload => (encryptedPayload === 'valid-payload' ? 'plain-secret' : undefined);
        service.readSyncData = async () => ({
            version: 1,
            timestamp: '2026-08-15T00:00:00.000Z',
            keys: {
                'valid.apiKey': 'valid-payload',
                'empty.apiKey': '',
                'whitespace.apiKey': '   '
            }
        });

        try {
            const decrypted = await GistSyncService.readDecryptedSyncData('token', 'gist-1');
            assert.deepEqual(decrypted?.keys, { 'valid.apiKey': 'plain-secret' });
        } finally {
            service.decrypt = originalDecrypt;
            service.readSyncData = originalReadSyncData;
        }
    });

    test('decryptSyncData uses the provided snapshot without reading Gist again', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalDecrypt = service.decrypt;
        const originalReadSyncData = service.readSyncData;
        let readCalls = 0;

        service.decrypt = async encryptedPayload => (encryptedPayload === 'valid-payload' ? 'plain-secret' : undefined);
        service.readSyncData = async () => {
            readCalls++;
            return undefined;
        };

        try {
            const decrypted = await service.decryptSyncData({
                version: 1,
                timestamp: '2026-08-15T00:00:00.000Z',
                keys: { 'valid.apiKey': 'valid-payload' }
            });
            assert.deepEqual(decrypted?.keys, { 'valid.apiKey': 'plain-secret' });
            assert.equal(readCalls, 0);
        } finally {
            service.decrypt = originalDecrypt;
            service.readSyncData = originalReadSyncData;
        }
    });

    test('decryptRemoteKeysWithPassphrase ignores blank entries', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalGetGithubId = service.getGithubId;
        const originalReadSyncData = service.readSyncData;

        service.getGithubId = () => 'user-1';
        service.readSyncData = async () => ({
            version: 1,
            timestamp: '2026-08-15T00:00:00.000Z',
            keys: {
                'valid.apiKey': (await encrypt('user-1', 'plain-secret', 'passphrase'))!,
                'empty.apiKey': '',
                'whitespace.apiKey': '   '
            }
        });

        try {
            const decrypted = await GistSyncService.decryptRemoteKeysWithPassphrase('token', 'gist-1', 'passphrase');
            assert.deepEqual(decrypted, { 'valid.apiKey': 'plain-secret' });
        } finally {
            service.getGithubId = originalGetGithubId;
            service.readSyncData = originalReadSyncData;
        }
    });

    test('uploadKeys aborts when existing gist cannot be read', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalGetGistId = service.getGistId;
        const originalReadSyncData = service.readSyncData;
        const originalUpdateGist = service.updateGist;
        const originalFindExistingSyncGist = service.findExistingSyncGist;
        const originalCreateGist = service.createGist;
        let updateCalled = false;
        let findCalled = false;
        let createCalled = false;

        service.getGistId = () => 'gist-1';
        service.readSyncData = async () => undefined;
        service.updateGist = async () => {
            updateCalled = true;
            return true;
        };
        service.findExistingSyncGist = async () => {
            findCalled = true;
            return undefined;
        };
        service.createGist = async () => {
            createCalled = true;
            return 'new-gist';
        };

        try {
            const gistId = await GistSyncService.uploadKeys('token', { 'demo.apiKey': 'encrypted' });
            assert.equal(gistId, undefined);
            assert.equal(updateCalled, false);
            assert.equal(findCalled, false);
            assert.equal(createCalled, false);
        } finally {
            service.getGistId = originalGetGistId;
            service.readSyncData = originalReadSyncData;
            service.updateGist = originalUpdateGist;
            service.findExistingSyncGist = originalFindExistingSyncGist;
            service.createGist = originalCreateGist;
        }
    });

    test('findExistingSyncGist scans later pages', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        const originalReadSyncData = service.readSyncData;
        let pageCalls = 0;

        ConfigManager.fetchWithProxy = (async () => {
            pageCalls += 1;
            if (pageCalls === 1) {
                return {
                    ok: true,
                    json: async () =>
                        Array.from({ length: 100 }, (_, index) => ({
                            id: `page-1-${index}`,
                            public: false,
                            description: 'Unrelated gist',
                            files: {}
                        }))
                } as never;
            }
            return {
                ok: true,
                json: async () => [
                    {
                        id: 'target-gist',
                        public: false,
                        description: 'GCMP Sync - API Key configuration backup',
                        files: {
                            'gcmp-sync.json': {
                                filename: 'gcmp-sync.json',
                                type: 'application/json',
                                language: 'JSON',
                                raw_url: '',
                                size: 1
                            }
                        }
                    }
                ]
            } as never;
        }) as typeof ConfigManager.fetchWithProxy;

        service.readSyncData = async (_token: string, gistId: string) =>
            gistId === 'target-gist' ? { version: 1, timestamp: '2026-08-15T00:00:00.000Z', keys: {} } : undefined;

        try {
            const gistId = await GistSyncService.findExistingSyncGist('token');
            assert.equal(gistId, 'target-gist');
            assert.equal(pageCalls, 2);
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            service.readSyncData = originalReadSyncData;
        }
    });

    test('resolveGistFileContent fetches raw_url for truncated files', async () => {
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let fetchUrl: string | undefined;

        ConfigManager.fetchWithProxy = (async url => {
            fetchUrl = String(url);
            return {
                ok: true,
                text: async () => '{"version":1}'
            } as never;
        }) as typeof ConfigManager.fetchWithProxy;

        try {
            const content = await GistSyncService.resolveGistFileContent('token', {
                truncated: true,
                raw_url: 'https://gist.githubusercontent.com/demo/raw/gcmp-sync.json'
            });

            assert.equal(content, '{"version":1}');
            assert.equal(fetchUrl, 'https://gist.githubusercontent.com/demo/raw/gcmp-sync.json');
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
        }
    });

    test('resolveGistFileContent rejects unexpected raw_url host', async () => {
        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let fetchCalls = 0;

        ConfigManager.fetchWithProxy = (async () => {
            fetchCalls += 1;
            return {
                ok: true,
                text: async () => 'unexpected'
            } as never;
        }) as typeof ConfigManager.fetchWithProxy;

        try {
            const content = await GistSyncService.resolveGistFileContent('token', {
                truncated: true,
                raw_url: 'https://example.com/raw/gcmp-sync.json'
            });

            assert.equal(content, undefined);
            assert.equal(fetchCalls, 0);
        } finally {
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
        }
    });

    test('applyKeysAndNotify uses ApiKeyManager pipeline and notifies only applied keys', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const mutableKeys = ApiKeyManager as unknown as {
            getApiKey: typeof ApiKeyManager.getApiKey;
            setApiKey: typeof ApiKeyManager.setApiKey;
        };
        const originalGetApiKey = mutableKeys.getApiKey;
        const originalSetApiKey = mutableKeys.setApiKey;
        const originalNotifyProviders = service.notifyProviders;
        const applied: Array<{ provider: string; value: string }> = [];
        let notified: string[] | undefined;

        mutableKeys.getApiKey = async () => undefined;
        mutableKeys.setApiKey = async (provider, value) => {
            applied.push({ provider, value });
        };
        service.notifyProviders = keyNames => {
            notified = keyNames;
        };

        try {
            const count = await GistSyncService.applyKeysAndNotify({
                'demo.apiKey': ' demo-secret ',
                'blank.apiKey': '   '
            });

            assert.equal(count, 1);
            assert.deepEqual(applied, [{ provider: 'demo', value: 'demo-secret' }]);
            assert.deepEqual(notified, ['demo.apiKey']);
        } finally {
            mutableKeys.getApiKey = originalGetApiKey;
            mutableKeys.setApiKey = originalSetApiKey;
            service.notifyProviders = originalNotifyProviders;
        }
    });

    test('applyKeysAndNotify rolls back earlier keys when a later key apply fails', async () => {
        const service = GistSyncService as unknown as MockableGistSyncService;
        const mutableKeys = ApiKeyManager as unknown as {
            getApiKey: typeof ApiKeyManager.getApiKey;
            setApiKey: typeof ApiKeyManager.setApiKey;
            deleteApiKey: typeof ApiKeyManager.deleteApiKey;
        };
        const originalGetApiKey = mutableKeys.getApiKey;
        const originalSetApiKey = mutableKeys.setApiKey;
        const originalDeleteApiKey = mutableKeys.deleteApiKey;
        const originalNotifyProviders = service.notifyProviders;
        const store = new Map<string, string | undefined>([
            ['first', 'old-first'],
            ['second', undefined]
        ]);
        const calls: string[] = [];
        let notified = false;

        mutableKeys.getApiKey = async provider => store.get(provider);
        mutableKeys.setApiKey = async (provider, value) => {
            calls.push(`set:${provider}:${value}`);
            if (provider === 'second') {
                throw new Error('apply failed');
            }
            store.set(provider, value);
        };
        mutableKeys.deleteApiKey = async provider => {
            calls.push(`delete:${provider}`);
            store.delete(provider);
        };
        service.notifyProviders = () => {
            notified = true;
        };

        try {
            await assert.rejects(
                () =>
                    GistSyncService.applyKeysAndNotify({
                        'first.apiKey': 'new-first',
                        'second.apiKey': 'new-second'
                    }),
                /apply failed/
            );
        } finally {
            mutableKeys.getApiKey = originalGetApiKey;
            mutableKeys.setApiKey = originalSetApiKey;
            mutableKeys.deleteApiKey = originalDeleteApiKey;
            service.notifyProviders = originalNotifyProviders;
        }

        assert.equal(store.get('first'), 'old-first');
        assert.equal(store.get('second'), undefined);
        assert.equal(notified, false);
        assert.deepEqual(calls, ['set:first:new-first', 'set:second:new-second', 'set:first:old-first']);
    });
});
