import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { deactivate } from '../../src/extension';
import { InterInstanceBus } from '../../src/interInstance';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import { UserActivityService } from '../../src/status/userActivityService';
import { AtomicJsonFile } from '../../src/usages/atomicJsonFile';
import { registeredProviders } from '../../src/utils/config/providerRegistry';
import {
    getClaudeCodeCliVersion,
    getCodexTuiCliHeader,
    hashCliMetadata,
    setRemoteCliMetadata
} from '../../src/utils/metadata/metadataResolver';
import { hashModelsText } from '../../src/utils/metadata/modelsResolver';
import { RemoteMetadataService } from '../../src/utils/metadata/remoteMetadataService';
import { RemoteModelsService } from '../../src/utils/metadata/remoteModelsService';

interface ServiceState {
    isDevelopment: boolean;
    disposed: boolean;
    cacheLoadGeneration: number;
    lifecycleGeneration: number;
    refreshPromise?: Promise<void>;
    cacheFilePath?: string;
    cacheDir?: string;
    currentContentHash?: string;
    currentManifestHash?: string;
    currentContentHashes?: Map<string, string>;
    fetchText(url: string, maxBytes: number): Promise<string | undefined>;
    loadFromCache(): Promise<boolean>;
    dispose(): void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

interface ModelCacheState extends ServiceState {
    persistCache(
        text: string,
        downloads: ReadonlyMap<string, string>,
        entries: readonly { id: string; contentHash: string }[],
        isCurrent: () => boolean
    ): Promise<boolean>;
    pruneStaleCacheFiles(
        entries: readonly { id: string; contentHash: string }[],
        isCurrent?: () => boolean
    ): Promise<boolean>;
}

suite('Metadata disposal regression', () => {
    for (const remoteName of [undefined, 'ssh-remote', 'wsl', 'dev-container']) {
        for (const active of [false, true]) {
            test(`${remoteName ?? 'local leader'} model periodic refresh respects activity=${active} without blocking explicit refresh`, async () => {
                class PeriodicService extends RemoteModelsService {}
                const state = PeriodicService as unknown as ServiceState;
                const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-model-periodic-'));
                const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                const originalActivity = UserActivityService.isUserActive;
                const originalIsLeader = LeaderElectionService.isLeader;
                const originalInterval = globalThis.setInterval;
                const subscriptions: vscode.Disposable[] = [];
                let tick: (() => void) | undefined;
                let requests = 0;
                try {
                    Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                    UserActivityService.isUserActive = () => active;
                    LeaderElectionService.isLeader = () => remoteName === undefined;
                    globalThis.setInterval = ((callback: () => void, delay?: number) => {
                        if (delay === 5 * 60 * 1000) {
                            tick = callback;
                        }
                        return originalInterval(callback, delay);
                    }) as typeof setInterval;
                    state.fetchText = async () => {
                        requests++;
                        return undefined;
                    };
                    await PeriodicService.initialize({
                        extensionMode: vscode.ExtensionMode.Production,
                        extensionPath: directory,
                        globalStorageUri: vscode.Uri.file(directory),
                        subscriptions
                    } as unknown as vscode.ExtensionContext);
                    assert.ok(tick);
                    assert.equal(requests, 0);
                    tick();
                    await state.refreshPromise;
                    const periodicRequests = remoteName === undefined || active ? 1 : 0;
                    assert.equal(requests, periodicRequests);
                    await PeriodicService.refresh();
                    assert.equal(requests, periodicRequests + 1);
                    PeriodicService.startAfterProvidersRegistered();
                    await state.refreshPromise;
                    assert.equal(requests, periodicRequests + 2);
                } finally {
                    state.dispose();
                    for (const subscription of subscriptions.reverse()) {
                        subscription.dispose();
                    }
                    globalThis.setInterval = originalInterval;
                    UserActivityService.isUserActive = originalActivity;
                    LeaderElectionService.isLeader = originalIsLeader;
                    if (originalRemoteName) {
                        Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                    }
                    await fs.rm(directory, { recursive: true, force: true });
                }
            });
        }
    }
    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
        for (const phase of ['active', 'disposed', 'reinitialized'] as const) {
            test(`${remoteName} manual refresh continuation remains in its ${phase} lifecycle`, async () => {
                class CommandService extends RemoteMetadataService {}
                const state = CommandService as unknown as ServiceState;
                const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-command-lifecycle-'));
                const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                const originalRegister = vscode.commands.registerCommand;
                const originalModelsRefresh = RemoteModelsService.refresh;
                const originalActivity = UserActivityService.isUserActive;
                const entered = deferred();
                const release = deferred();
                const subscriptions: vscode.Disposable[] = [];
                const context = {
                    extensionMode: vscode.ExtensionMode.Production,
                    extensionPath: directory,
                    globalStorageUri: vscode.Uri.file(directory),
                    subscriptions
                } as unknown as vscode.ExtensionContext;
                let command: (() => Promise<void>) | undefined;
                let modelRefreshes = 0;
                let pending: Promise<void> | undefined;
                try {
                    Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                    UserActivityService.isUserActive = () => false;
                    vscode.commands.registerCommand = (name, callback) => {
                        assert.equal(name, 'gcmp.metadata.refresh');
                        command = async () => {
                            await callback();
                        };
                        return new vscode.Disposable(() => {
                            command = undefined;
                        });
                    };
                    RemoteModelsService.refresh = async () => {
                        modelRefreshes++;
                    };
                    state.fetchText = async () => {
                        entered.resolve();
                        await release.promise;
                        return undefined;
                    };
                    await CommandService.initialize(context);
                    assert.ok(command);
                    pending = command();
                    await entered.promise;
                    if (phase !== 'active') {
                        for (const subscription of subscriptions.splice(0).reverse()) {
                            subscription.dispose();
                        }
                    }
                    if (phase === 'reinitialized') {
                        await CommandService.initialize(context);
                    }
                    release.resolve();
                    await pending;
                    assert.equal(modelRefreshes, phase === 'active' ? 1 : 0);
                    if (phase === 'reinitialized') {
                        assert.ok(command);
                        await command();
                        assert.equal(modelRefreshes, 1);
                    }
                } finally {
                    release.resolve();
                    await pending;
                    for (const subscription of subscriptions.reverse()) {
                        subscription.dispose();
                    }
                    vscode.commands.registerCommand = originalRegister;
                    RemoteModelsService.refresh = originalModelsRefresh;
                    UserActivityService.isUserActive = originalActivity;
                    if (originalRemoteName) {
                        Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                    }
                    await fs.rm(directory, { recursive: true, force: true });
                }
            });
        }
    }
    for (const remoteName of [undefined, 'ssh-remote', 'wsl', 'dev-container']) {
        for (const target of ['cli', 'models'] as const) {
            for (const phase of ['download', 'write', 'committed', 'restart', 'shutdown'] as const) {
                test(`${remoteName ?? 'local leader'} ${target} disposal during ${phase} preserves lifecycle boundaries`, async () => {
                    const service = target === 'cli' ? RemoteMetadataService : RemoteModelsService;
                    const state = service as unknown as ServiceState;
                    const previous = {
                        isDevelopment: state.isDevelopment,
                        disposed: state.disposed,
                        cacheLoadGeneration: state.cacheLoadGeneration,
                        lifecycleGeneration: state.lifecycleGeneration,
                        refreshPromise: state.refreshPromise,
                        fetchText: state.fetchText,
                        loadFromCache: state.loadFromCache,
                        ...(target === 'cli' ?
                            {
                                cacheFilePath: state.cacheFilePath,
                                currentContentHash: state.currentContentHash
                            }
                        :   {
                                cacheDir: state.cacheDir,
                                currentManifestHash: state.currentManifestHash,
                                currentContentHashes: state.currentContentHashes
                            })
                    };
                    const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                    const originalIsLeader = LeaderElectionService.isLeader;
                    const originalPublish = InterInstanceBus.publish;
                    const originalWrite = AtomicJsonFile.writeJsonAtomically;
                    const originalProviders = { ...registeredProviders };
                    const originalCli = {
                        claudeCodeVersion: getClaudeCodeCliVersion(),
                        codexTuiVersion: getCodexTuiCliHeader().version,
                        codexTuiOriginator: getCodexTuiCliHeader().originator
                    };
                    const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-metadata-disposal-'));
                    const file = join(directory, target === 'cli' ? 'metadata.json' : 'index.json');
                    const payload = (version: string, day: number): string =>
                        JSON.stringify({
                            schemaVersion: 1,
                            generatedAt: `2026-10-${day}T00:00:00Z`,
                            ...(target === 'cli' ?
                                { cli: { codexTui: { version } } }
                            :   {
                                    gcmpVersion: '0.29.2',
                                    providers: []
                                })
                        });
                    const initial = payload('0.200.0', 22);
                    const downloaded = payload('0.201.0', 23);
                    const external = payload('0.299.0', 24);
                    let cacheReads = 0;
                    let fetches = 0;
                    let broadcasts = 0;
                    let disposed = false;
                    let release!: () => void;
                    const response = new Promise<string>(resolve => {
                        release = () => resolve(downloaded);
                    });
                    let pending: Promise<void> | undefined;
                    const dispose = (): void => {
                        disposed = true;
                        state.dispose();
                    };
                    try {
                        Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                        LeaderElectionService.isLeader = () => remoteName === undefined;
                        InterInstanceBus.publish = () => {
                            broadcasts++;
                        };
                        state.isDevelopment = false;
                        state.disposed = false;
                        state.refreshPromise = undefined;
                        if (target === 'cli') {
                            state.cacheFilePath = file;
                            state.currentContentHash = hashCliMetadata({ codexTuiVersion: '0.200.0' });
                            setRemoteCliMetadata({ codexTuiVersion: '0.200.0' });
                        } else {
                            state.cacheDir = directory;
                            state.currentManifestHash = hashModelsText(initial);
                            state.currentContentHashes = new Map();
                        }
                        await fs.writeFile(file, initial);
                        state.loadFromCache = async () => {
                            cacheReads++;
                            return previous.loadFromCache.call(state);
                        };
                        state.fetchText = async url => {
                            fetches++;
                            if (url.includes('registry.npmjs.org')) {
                                return undefined;
                            }
                            return phase === 'download' || phase === 'shutdown' ? response : downloaded;
                        };
                        AtomicJsonFile.writeJsonAtomically = async (destination, value, serializer, canWrite) => {
                            await originalWrite.call(
                                AtomicJsonFile,
                                destination,
                                value,
                                entry => {
                                    const text = serializer ? serializer(entry) : JSON.stringify(entry, null, 2);
                                    if (destination === file && phase === 'write') {
                                        dispose();
                                    }
                                    return text;
                                },
                                canWrite
                            );
                            if (destination === file && phase === 'committed') {
                                dispose();
                            }
                        };
                        if (phase === 'restart') {
                            dispose();
                        }
                        pending = service.refresh();
                        if (phase === 'download') {
                            dispose();
                            await fs.writeFile(file, external);
                            release();
                        }
                        if (phase === 'shutdown') {
                            let stoppedBeforeProviderDispose: boolean | undefined;
                            registeredProviders['metadata-disposal-test'] = {
                                dispose: async () => {
                                    stoppedBeforeProviderDispose = state.disposed;
                                    release();
                                    await pending;
                                }
                            } as unknown as (typeof registeredProviders)[string];
                            disposed = true;
                            await deactivate();
                            assert.equal(stoppedBeforeProviderDispose, true);
                        }
                        await pending;
                        assert.equal(disposed, true);
                        if (phase === 'restart') {
                            assert.equal(fetches, 0);
                        }
                        assert.equal(cacheReads, 0);
                        assert.equal(broadcasts, 0);
                        if (phase === 'committed') {
                            const committed = JSON.parse(await fs.readFile(file, 'utf8')) as { generatedAt: string };
                            assert.equal(Date.parse(committed.generatedAt), Date.parse('2026-10-23T00:00:00Z'));
                        } else {
                            assert.equal(await fs.readFile(file, 'utf8'), phase === 'download' ? external : initial);
                        }
                        assert.equal(
                            target === 'cli' ? getCodexTuiCliHeader().version : state.currentManifestHash,
                            target === 'cli' ? '0.200.0' : hashModelsText(initial)
                        );
                        assert.deepEqual(await fs.readdir(directory), [
                            target === 'cli' ? 'metadata.json' : 'index.json'
                        ]);
                    } finally {
                        release();
                        await pending;
                        Object.assign(state, previous);
                        if (phase === 'shutdown') {
                            delete registeredProviders['metadata-disposal-test'];
                            Object.assign(registeredProviders, originalProviders);
                        }
                        AtomicJsonFile.writeJsonAtomically = originalWrite;
                        LeaderElectionService.isLeader = originalIsLeader;
                        InterInstanceBus.publish = originalPublish;
                        setRemoteCliMetadata(originalCli);
                        if (originalRemoteName) {
                            Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                        }
                        await fs.rm(directory, { recursive: true, force: true });
                    }
                });
            }
        }
    }
});

suite('Metadata cache concurrency regression', () => {
    for (const remoteName of [undefined, 'ssh-remote', 'wsl', 'dev-container']) {
        for (const npmState of ['older', 'missing', 'invalid', 'failed', 'newer', 'site-newer'] as const) {
            test(`${remoteName ?? 'local leader'} CLI versions follow independent sources: ${npmState}`, async () => {
                class VersionService extends RemoteMetadataService {}
                const state = VersionService as unknown as ServiceState;
                const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-cli-version-sources-'));
                const file = join(directory, 'metadata.json');
                const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                const originalIsLeader = LeaderElectionService.isLeader;
                const originalPublish = InterInstanceBus.publish;
                const originalCli = {
                    claudeCodeVersion: getClaudeCodeCliVersion(),
                    codexTuiVersion: getCodexTuiCliHeader().version,
                    codexTuiOriginator: getCodexTuiCliHeader().originator
                };
                const cached = {
                    claudeCodeVersion: '2.1.302',
                    codexTuiVersion: '0.202.0',
                    codexTuiOriginator: 'cached-client'
                };
                const site = {
                    claudeCodeVersion: npmState === 'site-newer' ? '2.1.304' : '2.1.300',
                    codexTuiVersion: npmState === 'site-newer' ? '0.204.0' : '0.200.0',
                    codexTuiOriginator: 'site-client'
                };
                const expected = { ...cached, codexTuiOriginator: site.codexTuiOriginator };
                if (npmState === 'newer') {
                    expected.claudeCodeVersion = '2.1.303';
                    expected.codexTuiVersion = '0.203.0';
                } else if (npmState === 'site-newer') {
                    Object.assign(expected, site);
                }
                const payload = (day: number, cli: typeof cached): string =>
                    JSON.stringify({
                        schemaVersion: 1,
                        generatedAt: `2026-10-${day}T00:00:00Z`,
                        cli: {
                            claudeCode: { version: cli.claudeCodeVersion },
                            codexTui: { version: cli.codexTuiVersion, originator: cli.codexTuiOriginator }
                        }
                    });
                let broadcasts = 0;
                try {
                    Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                    LeaderElectionService.isLeader = () => remoteName === undefined;
                    InterInstanceBus.publish = () => {
                        broadcasts++;
                    };
                    Object.assign(state, {
                        cacheFilePath: file,
                        isDevelopment: false,
                        disposed: false,
                        refreshPromise: undefined,
                        currentContentHash: hashCliMetadata(cached)
                    });
                    setRemoteCliMetadata(cached);
                    await fs.writeFile(file, payload(23, cached));
                    state.fetchText = async url => {
                        if (!url.includes('registry.npmjs.org')) {
                            return payload(24, site);
                        }
                        if (npmState === 'failed') {
                            throw new Error('Registry unavailable');
                        }
                        if (npmState === 'missing' || npmState === 'site-newer') {
                            return undefined;
                        }
                        if (npmState === 'invalid') {
                            return JSON.stringify({ version: 42 });
                        }
                        const version =
                            url.includes('codex') ?
                                npmState === 'newer' ?
                                    '0.203.0'
                                :   '0.201.0'
                            : npmState === 'newer' ? '2.1.303'
                            : '2.1.301';
                        return JSON.stringify({ version });
                    };
                    await VersionService.refresh();
                    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
                        generatedAt: string;
                        contentHash: string;
                        cli: { claudeCode: { version: string }; codexTui: { version: string; originator: string } };
                    };
                    assert.deepEqual(saved.cli, {
                        claudeCode: { version: expected.claudeCodeVersion },
                        codexTui: { version: expected.codexTuiVersion, originator: expected.codexTuiOriginator }
                    });
                    assert.equal(Date.parse(saved.generatedAt), Date.parse('2026-10-24T00:00:00Z'));
                    assert.equal(saved.contentHash, hashCliMetadata(expected));
                    assert.equal(state.currentContentHash, saved.contentHash);
                    assert.equal(getClaudeCodeCliVersion(), expected.claudeCodeVersion);
                    assert.equal(getCodexTuiCliHeader().version, expected.codexTuiVersion);
                    assert.equal(getCodexTuiCliHeader().originator, expected.codexTuiOriginator);
                    assert.equal(broadcasts, remoteName === undefined ? 1 : 0);
                } finally {
                    state.dispose();
                    LeaderElectionService.isLeader = originalIsLeader;
                    InterInstanceBus.publish = originalPublish;
                    setRemoteCliMetadata(originalCli);
                    if (originalRemoteName) {
                        Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                    }
                    await fs.rm(directory, { recursive: true, force: true });
                }
            });
        }
    }

    for (const remoteName of ['ssh-remote', 'wsl', 'dev-container']) {
        for (const sameTimestamp of [false, true]) {
            test(`${remoteName} late CLI response preserves newer cache, same timestamp=${sameTimestamp}`, async () => {
                class SlowService extends RemoteMetadataService {}
                class FastService extends RemoteMetadataService {}
                const slow = SlowService as unknown as ServiceState;
                const fast = FastService as unknown as ServiceState;
                const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-cli-concurrent-'));
                const file = join(directory, 'metadata.json');
                const entered = deferred();
                const release = deferred();
                const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                const originalCli = {
                    claudeCodeVersion: getClaudeCodeCliVersion(),
                    codexTuiVersion: getCodexTuiCliHeader().version,
                    codexTuiOriginator: getCodexTuiCliHeader().originator
                };
                const payload = (day: number): string =>
                    JSON.stringify({
                        schemaVersion: 1,
                        generatedAt: `2026-10-${day}T00:00:00Z`,
                        cli: { codexTui: { version: '0.200.0' } }
                    });
                let pending: Promise<void> | undefined;
                try {
                    Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                    for (const state of [slow, fast]) {
                        Object.assign(state, {
                            cacheFilePath: file,
                            isDevelopment: false,
                            disposed: false,
                            refreshPromise: undefined,
                            currentContentHash: undefined
                        });
                    }
                    await fs.writeFile(file, payload(22));
                    slow.fetchText = async url => {
                        if (!url.includes('registry.npmjs.org')) {
                            return payload(23);
                        }
                        if (!url.includes('codex')) {
                            return undefined;
                        }
                        entered.resolve();
                        await release.promise;
                        return JSON.stringify({ version: '0.201.0' });
                    };
                    fast.fetchText = async url =>
                        url.includes('registry.npmjs.org') ?
                            url.includes('codex') ?
                                JSON.stringify({ version: '0.202.0' })
                            :   undefined
                        :   payload(sameTimestamp ? 23 : 24);
                    pending = SlowService.refresh();
                    await entered.promise;
                    await FastService.refresh();
                    release.resolve();
                    await pending;
                    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as {
                        generatedAt: string;
                        cli: { codexTui: { version: string } };
                    };
                    assert.equal(saved.cli.codexTui.version, '0.202.0');
                    assert.equal(
                        Date.parse(saved.generatedAt),
                        Date.parse(`2026-10-${sameTimestamp ? 23 : 24}T00:00:00Z`)
                    );
                    assert.equal(getCodexTuiCliHeader().version, '0.202.0');
                } finally {
                    release.resolve();
                    await pending;
                    slow.dispose();
                    fast.dispose();
                    setRemoteCliMetadata(originalCli);
                    if (originalRemoteName) {
                        Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                    }
                    await fs.rm(directory, { recursive: true, force: true });
                }
            });
        }

        for (const newerFirst of [false, true]) {
            test(`${remoteName} model commit and pruning remain one transaction, newer first=${newerFirst}`, async () => {
                class FirstService extends RemoteModelsService {}
                class SecondService extends RemoteModelsService {}
                const first = FirstService as unknown as ModelCacheState;
                const second = SecondService as unknown as ModelCacheState;
                const directory = await fs.mkdtemp(join(tmpdir(), 'gcmp-models-concurrent-'));
                const file = join(directory, 'index.json');
                const pruning = deferred();
                const release = deferred();
                const competing = deferred();
                const originalMkdir = filesystem.mkdir;
                const originalRemoteName = Object.getOwnPropertyDescriptor(vscode.env, 'remoteName');
                let secondStarted = false;
                let pending: Promise<boolean> | undefined;
                let next: Promise<boolean> | undefined;
                const snapshot = (day: number) => {
                    const text = JSON.stringify({
                        models: [
                            { id: `model-${day}`, name: `Model ${day}`, maxInputTokens: 1024, maxOutputTokens: 128 }
                        ]
                    });
                    const entries = [{ id: 'test-provider', contentHash: hashModelsText(text) }];
                    return {
                        text,
                        entries,
                        manifest: JSON.stringify({
                            schemaVersion: 1,
                            gcmpVersion: '0.29.2',
                            generatedAt: `2026-10-${day}T00:00:00Z`,
                            providers: entries
                        })
                    };
                };
                const older = snapshot(23);
                const newer = snapshot(24);
                const initial = newerFirst ? newer : older;
                const candidate = newerFirst ? older : newer;
                try {
                    Object.defineProperty(vscode.env, 'remoteName', { configurable: true, value: remoteName });
                    first.cacheDir = directory;
                    second.cacheDir = directory;
                    const originalPrune = first.pruneStaleCacheFiles;
                    first.pruneStaleCacheFiles = async (entries, current) => {
                        pruning.resolve();
                        await release.promise;
                        return originalPrune.call(first, entries, current);
                    };
                    filesystem.mkdir = (async (...args: Parameters<typeof filesystem.mkdir>) => {
                        if (secondStarted && String(args[0]) === `${file}.refresh.lock`) {
                            competing.resolve();
                        }
                        return originalMkdir(...args);
                    }) as typeof filesystem.mkdir;
                    pending = first.persistCache(
                        initial.manifest,
                        new Map([['test-provider', initial.text]]),
                        initial.entries,
                        () => true
                    );
                    await pruning.promise;
                    secondStarted = true;
                    next = second.persistCache(
                        candidate.manifest,
                        new Map([['test-provider', candidate.text]]),
                        candidate.entries,
                        () => true
                    );
                    await Promise.race([next, competing.promise]);
                    release.resolve();
                    assert.deepEqual(await Promise.all([pending, next]), [true, !newerFirst]);
                    assert.equal(await fs.readFile(file, 'utf8'), newer.manifest);
                    const providerFile = `test-provider.${newer.entries[0].contentHash}.json`;
                    assert.equal(await fs.readFile(join(directory, providerFile), 'utf8'), newer.text);
                    assert.deepEqual((await fs.readdir(directory)).sort(), ['index.json', providerFile]);
                } finally {
                    release.resolve();
                    await Promise.allSettled([pending, next]);
                    filesystem.mkdir = originalMkdir;
                    if (originalRemoteName) {
                        Object.defineProperty(vscode.env, 'remoteName', originalRemoteName);
                    }
                    await fs.rm(directory, { recursive: true, force: true });
                }
            });
        }
    }
});
