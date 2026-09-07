import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodexProvider } from '../../src/cli/codexProvider';
import { configProviders } from '../../src/providers/config';
import { RateLimiter } from '../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import { ConfigManager } from '../../src/utils/config/configManager';
import {
    getRemoteModelsOverlay,
    hashModelsText,
    setRemoteProviderModels
} from '../../src/utils/metadata/modelsResolver';
import { RemoteMetadataService } from '../../src/utils/metadata/remoteMetadataService';
import { hashCliMetadata } from '../../src/utils/metadata/metadataResolver';
import { RemoteModelsService } from '../../src/utils/metadata/remoteModelsService';
import type { ModelConfig } from '../../src/types/sharedTypes';

interface CacheState {
    cacheDir: string;
    isDevelopment: boolean;
    extensionVersion: string;
    refreshPromise?: Promise<void>;
    currentContentHashes: Map<string, string>;
    currentManifestHash?: string;
    cacheLoadGeneration: number;
    handleLeaderChanged(isLeader: boolean): void;
    refreshCore(): Promise<void>;
    loadFromCache(): Promise<boolean>;
    readText(filePath: string): Promise<string | undefined>;
    fetchText(url: string, maxBytes: number): Promise<string | undefined>;
    pushToProviders(changedProviders: ReadonlyMap<string, ModelConfig[]>): void;
    pruneStaleCacheFiles(
        entries: readonly { id: string; contentHash: string }[],
        isCurrent?: () => boolean
    ): Promise<boolean>;
    persistCache(
        text: string,
        downloads: ReadonlyMap<string, string>,
        entries: readonly { id: string; contentHash: string }[],
        isCurrent?: () => boolean
    ): Promise<boolean>;
}

interface LeaderState {
    isLeader(): boolean;
}

interface MetadataState {
    cacheFilePath: string;
    currentContentHash?: string;
    fetchText(url: string): Promise<string | undefined>;
    isDevelopment: boolean;
    loadFromCache(): Promise<boolean>;
    cacheLoadGeneration: number;
    refreshPromise?: Promise<void>;
    handleLeaderChanged(isLeader: boolean): void;
    refreshCore(): Promise<void>;
}

interface FetchState {
    fetchWithProxy(url: string, options?: { signal?: AbortSignal }): Promise<Response>;
}

interface CodexState {
    dynamicModelGeneration: number;
    resolveDynamicModels(generation: number): Promise<ModelConfig[]>;
    refreshPromise?: Promise<ModelConfig[]>;
    refreshCancellationRequested: boolean;
    dynamicModelWaiterCount: number;
    currentAbortController?: AbortController;
    getDynamicModels(): Promise<ModelConfig[]>;
    waitForDynamicModels(token: vscode.CancellationToken): Promise<ModelConfig[]>;
}

suite('Remote models lifecycle regression', () => {
    test('provider 下载失败且卸任后不再发起后续下载', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const original = {
            isDevelopment: state.isDevelopment,
            extensionVersion: state.extensionVersion,
            currentContentHashes: state.currentContentHashes,
            fetchText: state.fetchText,
            persistCache: state.persistCache
        };
        const originalIsLeader = LeaderElectionService.isLeader;
        const providers = Object.keys(configProviders).slice(0, 2);
        assert.equal(providers.length, 2);
        let isLeader = true;
        const requests: string[] = [];
        let commits = 0;
        try {
            state.isDevelopment = false;
            state.extensionVersion = '1.0.0';
            state.currentContentHashes = new Map();
            LeaderElectionService.isLeader = () => isLeader;
            state.persistCache = async () => {
                commits++;
                return true;
            };
            state.fetchText = async url => {
                requests.push(url);
                if (requests.length === 1) {
                    return JSON.stringify({
                        schemaVersion: 1,
                        gcmpVersion: '1.0.0',
                        providers: providers.map(id => ({ id, contentHash: '0123456789ab' }))
                    });
                }
                isLeader = false;
                throw new Error('download failed after leadership loss');
            };
            await state.refreshCore();
            assert.equal(requests.length, 2);
            assert.ok(requests[1].endsWith(`/${providers[0]}.json`));
            assert.equal(commits, 0);
        } finally {
            Object.assign(state, original);
            LeaderElectionService.isLeader = originalIsLeader;
        }
    });

    test('同版本清单拒绝无效或更旧时间戳并保留缓存', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const originalDirectory = state.cacheDir;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-manifest-freshness-'));
        const manifest = (generatedAt?: string, gcmpVersion = '1.0.0'): string =>
            JSON.stringify({ schemaVersion: 1, gcmpVersion, generatedAt, providers: [] });
        const latest = manifest('2026-09-07T00:00:00Z');
        try {
            state.cacheDir = directory;
            await fs.writeFile(path.join(directory, 'index.json'), latest);
            for (const timestamp of [undefined, 'invalid', '2026-09-01T00:00:00Z']) {
                assert.equal(await state.persistCache(manifest(timestamp), new Map(), []), false);
                assert.equal(await fs.readFile(path.join(directory, 'index.json'), 'utf8'), latest);
            }
            assert.equal(await state.persistCache(latest, new Map(), []), true);
            assert.equal(await state.persistCache(manifest('2026-09-08T00:00:00Z'), new Map(), []), true);
            assert.equal(await state.persistCache(manifest(undefined, '1.1.0'), new Map(), []), true);
            assert.equal(await state.persistCache(manifest(undefined, '1.0.0'), new Map(), []), false);
        } finally {
            state.cacheDir = originalDirectory;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('Leader 模型限流采用用户覆盖、远程和内置优先级', () => {
        const providerKey = Object.keys(configProviders)[0] as keyof typeof configProviders;
        const builtin = configProviders[providerKey].models[0];
        assert.ok(builtin);
        const previousOverlay = getRemoteModelsOverlay().get(providerKey);
        const originalOverrides = ConfigManager.getProviderOverrides;
        const originalProviderLimit = ConfigManager.getProviderRateLimitConfig;
        const limiter = RateLimiter as unknown as {
            resolveAuthoritativeDims(bucketKey: string): ModelConfig['limit'];
        };
        const remote: ModelConfig = { ...builtin, limit: { rpm: 10, tpm: 1000 } };
        const added: ModelConfig = { ...remote, id: 'remote-limit-regression' };
        try {
            ConfigManager.getProviderOverrides = () => ({});
            ConfigManager.getProviderRateLimitConfig = () => undefined;
            setRemoteProviderModels(providerKey, undefined);
            const baseline = limiter.resolveAuthoritativeDims(`${providerKey}::${builtin.id}`);
            setRemoteProviderModels(providerKey, [remote, added]);
            assert.deepEqual(limiter.resolveAuthoritativeDims(`${providerKey}::${builtin.id}`), remote.limit);
            assert.deepEqual(limiter.resolveAuthoritativeDims(`${providerKey}::${added.id}`), added.limit);
            ConfigManager.getProviderOverrides = () => ({
                [providerKey]: { models: [{ id: builtin.id, limit: { rpm: 3 } }] }
            });
            assert.deepEqual(limiter.resolveAuthoritativeDims(`${providerKey}::${builtin.id}`), {
                rpm: 3,
                tpm: 1000
            });
            ConfigManager.getProviderOverrides = () => ({});
            setRemoteProviderModels(providerKey, [{ ...remote, limit: { rpm: 20 } }]);
            assert.deepEqual(limiter.resolveAuthoritativeDims(`${providerKey}::${builtin.id}`), { rpm: 20 });
            setRemoteProviderModels(providerKey, undefined);
            assert.deepEqual(limiter.resolveAuthoritativeDims(`${providerKey}::${builtin.id}`), baseline);
        } finally {
            ConfigManager.getProviderOverrides = originalOverrides;
            ConfigManager.getProviderRateLimitConfig = originalProviderLimit;
            setRemoteProviderModels(providerKey, previousOverlay ? [...previousOverlay] : undefined);
        }
    });

    test('CLI 同内容刷新推进时间戳并拒绝旧的或无时间戳响应', async () => {
        const state = RemoteMetadataService as unknown as MetadataState;
        const original = {
            cacheFilePath: state.cacheFilePath,
            currentContentHash: state.currentContentHash,
            fetchText: state.fetchText,
            isDevelopment: state.isDevelopment
        };
        const originalIsLeader = LeaderElectionService.isLeader;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-metadata-freshness-'));
        const payload = (version: string, generatedAt?: string): string =>
            JSON.stringify({ schemaVersion: 1, generatedAt, cli: { codexTui: { version } } });
        const latest = payload('0.200.0', '2026-09-07T00:00:00Z');
        let response = latest;
        try {
            state.cacheFilePath = path.join(directory, 'metadata.json');
            state.currentContentHash = hashCliMetadata({ codexTuiVersion: '0.200.0' });
            state.isDevelopment = false;
            state.fetchText = async () => response;
            LeaderElectionService.isLeader = () => true;
            await fs.writeFile(state.cacheFilePath, payload('0.200.0', '2026-09-01T00:00:00Z'));
            await state.refreshCore();
            assert.equal(await fs.readFile(state.cacheFilePath, 'utf8'), latest);
            for (const timestamp of ['2026-09-04T00:00:00Z', undefined, 'invalid']) {
                response = payload('0.199.0', timestamp);
                await state.refreshCore();
                assert.equal(await fs.readFile(state.cacheFilePath, 'utf8'), latest);
                assert.equal(state.currentContentHash, hashCliMetadata({ codexTuiVersion: '0.200.0' }));
            }
        } finally {
            Object.assign(state, original);
            LeaderElectionService.isLeader = originalIsLeader;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('清理目录读取失败不撤销已经提交的清单', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const originalDirectory = state.cacheDir;
        const originalPrune = state.pruneStaleCacheFiles;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-commit-test-'));
        const manifest = JSON.stringify({ schemaVersion: 1, gcmpVersion: '1.0.0', providers: [] });
        try {
            state.cacheDir = directory;
            state.pruneStaleCacheFiles = async () => {
                throw new Error('readdir failed');
            };
            assert.equal(await state.persistCache(manifest, new Map(), []), true);
            assert.equal(await fs.readFile(path.join(directory, 'index.json'), 'utf8'), manifest);
        } finally {
            state.cacheDir = originalDirectory;
            state.pruneStaleCacheFiles = originalPrune;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('清理判定失败不撤销已经提交的清单', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const originalDirectory = state.cacheDir;
        const originalPrune = state.pruneStaleCacheFiles;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-commit-false-test-'));
        const manifest = JSON.stringify({ schemaVersion: 1, gcmpVersion: '1.0.0', providers: [] });
        try {
            state.cacheDir = directory;
            state.pruneStaleCacheFiles = async () => false;
            assert.equal(await state.persistCache(manifest, new Map(), []), true);
            assert.equal(await fs.readFile(path.join(directory, 'index.json'), 'utf8'), manifest);
        } finally {
            state.cacheDir = originalDirectory;
            state.pruneStaleCacheFiles = originalPrune;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('主实例任期失效后不再删除过期缓存文件', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const originalDirectory = state.cacheDir;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-prune-term-test-'));
        const staleFile = path.join(directory, 'provider.0123456789ab.json');
        try {
            state.cacheDir = directory;
            await fs.writeFile(staleFile, '{}', 'utf8');
            assert.equal(await state.pruneStaleCacheFiles([], () => false), false);
            await fs.access(staleFile);
        } finally {
            state.cacheDir = originalDirectory;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('主实例切换会使在途的旧缓存读取失效', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const providerKey = Object.keys(configProviders)[0] as keyof typeof configProviders;
        const providerText = JSON.stringify({
            models: [
                {
                    id: 'stale-cache-load-test',
                    name: 'Stale Cache Load Test',
                    maxInputTokens: 1024,
                    maxOutputTokens: 128
                }
            ]
        });
        const contentHash = hashModelsText(providerText);
        const manifestText = JSON.stringify({
            schemaVersion: 1,
            gcmpVersion: '1.0.0',
            providers: [{ id: providerKey, contentHash }]
        });
        const originalDirectory = state.cacheDir;
        const originalVersion = state.extensionVersion;
        const originalHashes = state.currentContentHashes;
        const originalManifestHash = state.currentManifestHash;
        const originalGeneration = state.cacheLoadGeneration;
        const originalReadText = state.readText;
        const originalPush = state.pushToProviders;
        const originalOverlay = getRemoteModelsOverlay().get(providerKey);
        let releaseProvider!: () => void;
        let providerRead!: () => void;
        const providerStarted = new Promise<void>(resolve => {
            providerRead = resolve;
        });
        const providerReleased = new Promise<void>(resolve => {
            releaseProvider = resolve;
        });
        let readCount = 0;
        let pushes = 0;
        try {
            state.cacheDir = 'unused';
            state.extensionVersion = '1.0.0';
            state.currentContentHashes = new Map();
            state.currentManifestHash = undefined;
            state.cacheLoadGeneration = 0;
            state.readText = async () => {
                readCount++;
                if (readCount === 1) {
                    return manifestText;
                }
                providerRead();
                await providerReleased;
                return providerText;
            };
            state.pushToProviders = () => {
                pushes++;
            };
            const loading = state.loadFromCache();
            await providerStarted;
            state.cacheLoadGeneration++;
            releaseProvider();
            assert.equal(await loading, false);
            assert.equal(pushes, 0);
            assert.equal(state.currentContentHashes.size, 0);
            assert.equal(getRemoteModelsOverlay().has(providerKey), false);
        } finally {
            releaseProvider();
            state.cacheDir = originalDirectory;
            state.extensionVersion = originalVersion;
            state.currentContentHashes = originalHashes;
            state.currentManifestHash = originalManifestHash;
            state.cacheLoadGeneration = originalGeneration;
            state.readText = originalReadText;
            state.pushToProviders = originalPush;
            setRemoteProviderModels(providerKey, originalOverlay ? [...originalOverlay] : undefined);
        }
    });

    test('非主实例只重读共享缓存，不发起远程同步', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const leader = LeaderElectionService as unknown as LeaderState;
        const originalDevelopment = state.isDevelopment;
        const originalRefreshPromise = state.refreshPromise;
        const originalLoadFromCache = state.loadFromCache;
        const originalFetchText = state.fetchText;
        const originalIsLeader = leader.isLeader;
        let cacheLoads = 0;
        let fetches = 0;
        try {
            state.isDevelopment = false;
            state.refreshPromise = undefined;
            state.loadFromCache = async () => {
                cacheLoads++;
                return true;
            };
            state.fetchText = async () => {
                fetches++;
                return undefined;
            };
            leader.isLeader = () => false;
            await RemoteModelsService.refresh();
            assert.equal(cacheLoads, 1);
            assert.equal(fetches, 0);
        } finally {
            state.isDevelopment = originalDevelopment;
            state.refreshPromise = originalRefreshPromise;
            state.loadFromCache = originalLoadFromCache;
            state.fetchText = originalFetchText;
            leader.isLeader = originalIsLeader;
        }
    });

    test('升主时等待在途刷新结束后再以主实例身份同步', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const leader = LeaderElectionService as unknown as LeaderState;
        const originalRefreshPromise = state.refreshPromise;
        const originalRefreshCore = state.refreshCore;
        const originalIsLeader = leader.isLeader;
        let releasePending!: () => void;
        const pending = new Promise<void>(resolve => {
            releasePending = resolve;
        });
        const coreLeadership: boolean[] = [];
        try {
            leader.isLeader = () => false;
            state.refreshPromise = undefined;
            state.refreshCore = async () => {
                coreLeadership.push(leader.isLeader());
                if (coreLeadership.length === 1) {
                    await pending;
                }
            };
            const first = RemoteModelsService.refresh();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(coreLeadership.length, 1);
            leader.isLeader = () => true;
            state.handleLeaderChanged(true);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(coreLeadership.length, 1);
            releasePending();
            await first;
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(coreLeadership, [false, true]);
        } finally {
            releasePending();
            state.refreshPromise = originalRefreshPromise;
            state.refreshCore = originalRefreshCore;
            leader.isLeader = originalIsLeader;
        }
    });

    test('CLI 升主时等待在途刷新结束后再以主实例身份同步', async () => {
        const state = RemoteMetadataService as unknown as MetadataState;
        const leader = LeaderElectionService as unknown as LeaderState;
        const originalRefreshPromise = state.refreshPromise;
        const originalRefreshCore = state.refreshCore;
        const originalIsLeader = leader.isLeader;
        let releasePending!: () => void;
        const pending = new Promise<void>(resolve => {
            releasePending = resolve;
        });
        const coreLeadership: boolean[] = [];
        try {
            leader.isLeader = () => false;
            state.refreshPromise = undefined;
            state.refreshCore = async () => {
                coreLeadership.push(leader.isLeader());
                if (coreLeadership.length === 1) {
                    await pending;
                }
            };
            const first = RemoteMetadataService.refresh();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(coreLeadership.length, 1);
            leader.isLeader = () => true;
            state.handleLeaderChanged(true);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(coreLeadership.length, 1);
            releasePending();
            await first;
            await new Promise(resolve => setImmediate(resolve));
            assert.deepEqual(coreLeadership, [false, true]);
        } finally {
            releasePending();
            state.refreshPromise = originalRefreshPromise;
            state.refreshCore = originalRefreshCore;
            leader.isLeader = originalIsLeader;
        }
    });

    test('共享缓存重载按哈希热推送新增与移除的 provider', async () => {
        const state = RemoteModelsService as unknown as CacheState;
        const providerKey = Object.keys(configProviders)[0] as keyof typeof configProviders;
        const builtinModels = configProviders[providerKey].models;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gcmp-cache-reload-test-'));
        const providerText = JSON.stringify({
            models: [
                {
                    id: 'remote-cache-reload-test',
                    name: 'Remote Cache Reload Test',
                    maxInputTokens: 1024,
                    maxOutputTokens: 128
                }
            ]
        });
        const contentHash = hashModelsText(providerText);
        const originalDirectory = state.cacheDir;
        const originalVersion = state.extensionVersion;
        const originalHashes = state.currentContentHashes;
        const originalManifestHash = state.currentManifestHash;
        const originalPush = state.pushToProviders;
        const originalOverlay = getRemoteModelsOverlay().get(providerKey);
        const pushes: ReadonlyMap<string, ModelConfig[]>[] = [];
        try {
            state.cacheDir = directory;
            state.extensionVersion = '1.0.0';
            state.currentContentHashes = new Map();
            state.currentManifestHash = undefined;
            state.pushToProviders = changed => {
                pushes.push(changed);
            };
            await fs.writeFile(path.join(directory, `${providerKey}.${contentHash}.json`), providerText, 'utf8');
            await fs.writeFile(
                path.join(directory, 'index.json'),
                JSON.stringify({
                    schemaVersion: 1,
                    gcmpVersion: '1.0.0',
                    providers: [{ id: providerKey, contentHash }]
                }),
                'utf8'
            );

            assert.equal(await state.loadFromCache(), true);
            assert.equal(state.currentContentHashes.get(providerKey), contentHash);
            assert.equal(pushes.length, 1);
            assert.equal(
                pushes[0]?.get(providerKey)?.some(model => model.id === 'remote-cache-reload-test'),
                true
            );

            await fs.writeFile(
                path.join(directory, 'index.json'),
                JSON.stringify({ schemaVersion: 1, gcmpVersion: '1.0.0', providers: [] }),
                'utf8'
            );
            assert.equal(await state.loadFromCache(), true);
            assert.equal(state.currentContentHashes.has(providerKey), false);
            assert.equal(pushes.length, 2);
            assert.deepEqual(pushes[1]?.get(providerKey), builtinModels);
        } finally {
            state.cacheDir = originalDirectory;
            state.extensionVersion = originalVersion;
            state.currentContentHashes = originalHashes;
            state.currentManifestHash = originalManifestHash;
            state.pushToProviders = originalPush;
            setRemoteProviderModels(providerKey, originalOverlay ? [...originalOverlay] : undefined);
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    test('非主实例刷新 CLI 元数据时不访问远程地址', async () => {
        const state = RemoteMetadataService as unknown as MetadataState;
        const leader = LeaderElectionService as unknown as LeaderState;
        const config = ConfigManager as unknown as FetchState;
        const originalDevelopment = state.isDevelopment;
        const originalRefreshPromise = state.refreshPromise;
        const originalLoadFromCache = state.loadFromCache;
        const originalIsLeader = leader.isLeader;
        const originalFetch = config.fetchWithProxy;
        let cacheLoads = 0;
        let fetches = 0;
        try {
            state.isDevelopment = false;
            state.refreshPromise = undefined;
            state.loadFromCache = async () => {
                cacheLoads++;
                return true;
            };
            leader.isLeader = () => false;
            config.fetchWithProxy = async () => {
                fetches++;
                return new Response('{}');
            };
            await RemoteMetadataService.refresh();
            assert.equal(cacheLoads, 1);
            assert.equal(fetches, 0);
        } finally {
            state.isDevelopment = originalDevelopment;
            state.refreshPromise = originalRefreshPromise;
            state.loadFromCache = originalLoadFromCache;
            leader.isLeader = originalIsLeader;
            config.fetchWithProxy = originalFetch;
        }
    });

    test('最后等待者取消后，多个后来者共享下一次刷新', async () => {
        const state = Object.create(CodexProvider.prototype) as CodexState;
        state.dynamicModelGeneration = 0;
        state.dynamicModelWaiterCount = 0;
        state.refreshCancellationRequested = false;
        state.currentAbortController = new AbortController();
        let failOld!: (reason: Error) => void;
        let finishNew!: (models: ModelConfig[]) => void;
        const old = new Promise<ModelConfig[]>((_, reject) => {
            failOld = reject;
        });
        const next = new Promise<ModelConfig[]>(resolve => {
            finishNew = resolve;
        });
        let requests = 0;
        state.resolveDynamicModels = () => (++requests === 1 ? old : next);
        const first = new vscode.CancellationTokenSource();
        const second = new vscode.CancellationTokenSource();
        const third = new vscode.CancellationTokenSource();
        try {
            const cancelled = state.waitForDynamicModels(first.token);
            first.cancel();
            await assert.rejects(cancelled, vscode.CancellationError);
            assert.equal(state.currentAbortController.signal.aborted, true);
            const resultB = state.waitForDynamicModels(second.token);
            const resultC = state.waitForDynamicModels(third.token);
            assert.equal(requests, 1);
            failOld(new Error('cancelled refresh'));
            const models: ModelConfig[] = [];
            finishNew(models);
            assert.deepEqual(await Promise.all([resultB, resultC]), [models, models]);
            assert.equal(requests, 2);
            assert.equal(state.dynamicModelWaiterCount, 0);
            assert.equal(state.refreshPromise, undefined);
        } finally {
            failOld(new Error('cleanup'));
            finishNew([]);
            first.dispose();
            second.dispose();
            third.dispose();
        }
    });

    test('取消后的新等待者在旧刷新结束后取得新结果', async () => {
        const state = Object.create(CodexProvider.prototype) as CodexState;
        let finish!: () => void;
        const old = new Promise<ModelConfig[]>(resolve => {
            finish = () => resolve([]);
        });
        state.refreshPromise = old;
        state.refreshCancellationRequested = true;
        state.dynamicModelWaiterCount = 0;
        let freshRequests = 0;
        const models: ModelConfig[] = [];
        state.getDynamicModels = () => {
            freshRequests++;
            state.refreshCancellationRequested = false;
            return Promise.resolve(models);
        };
        const token = new vscode.CancellationTokenSource();
        try {
            const result = state.waitForDynamicModels(token.token);
            assert.equal(freshRequests, 0);
            finish();
            assert.equal(await result, models);
            assert.equal(freshRequests, 1);
            assert.equal(state.dynamicModelWaiterCount, 0);
        } finally {
            finish();
            token.dispose();
        }
    });

    test('等待旧刷新结束期间取消，不启动下一次刷新', async () => {
        const state = Object.create(CodexProvider.prototype) as CodexState;
        let finish!: () => void;
        const old = new Promise<ModelConfig[]>(resolve => {
            finish = () => resolve([]);
        });
        state.refreshPromise = old;
        state.refreshCancellationRequested = true;
        state.dynamicModelWaiterCount = 0;
        let freshRequests = 0;
        state.getDynamicModels = () => {
            freshRequests++;
            return Promise.resolve([]);
        };
        const token = new vscode.CancellationTokenSource();
        try {
            const result = state.waitForDynamicModels(token.token);
            token.cancel();
            await assert.rejects(result, vscode.CancellationError);
            finish();
            await old;
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(freshRequests, 0);
        } finally {
            finish();
            token.dispose();
        }
    });
});
