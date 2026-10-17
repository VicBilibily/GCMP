import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import type * as vscode from 'vscode';
import * as eventProtocol from '../../interInstance/eventProtocol';
import type { FallbackTransport } from '../../interInstance/fallbackTransport';
import { gate } from '../../usages/tests/snapshotFixture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nativeRequire = createRequire(import.meta.url);
const noop = (): void => {};
const silentLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };

function evaluate<Exports>(
    source: string,
    mocks: Record<string, unknown>,
    globals: Record<string, unknown> = {}
): Exports {
    const module = { exports: {} };
    runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
        module,
        exports: module.exports,
        require(id: string): unknown {
            if (Object.hasOwn(mocks, id)) {
                return mocks[id];
            }
            if (id.startsWith('node:')) {
                return nativeRequire(id);
            }
            throw new Error(`Unexpected lifecycle dependency: ${id}`);
        },
        console,
        process,
        Buffer,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        ...globals
    });
    return module.exports as Exports;
}

function loadSource<Exports>(relativePath: string, mocks: Record<string, unknown>): Exports {
    return evaluate(readFileSync(resolve(root, relativePath), 'utf8'), mocks);
}

function loadDispose<State>(relativePath: string, className: string, globals: Record<string, unknown>) {
    const filename = resolve(root, relativePath);
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = source.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    const method = owner?.members.find(
        (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) && member.name.getText(source) === 'dispose'
    );
    assert.ok(method?.body);
    return evaluate<{ dispose(this: State): Promise<void> }>(
        `export async function dispose() ${method.body.getText(source)}`,
        {},
        globals
    ).dispose;
}

function entryFixture() {
    const calls: string[] = [];
    const failures = new Set<string>();
    const activationFailure = new Error('Injected activation failure');
    const channels: Array<{ name: string; disposed: boolean; disposeCount: number }> = [];
    const invoke = (name: string): void => {
        calls.push(name);
        if (failures.has(name)) {
            throw new Error(`Injected ${name}`);
        }
    };
    const context = { subscriptions: [] as vscode.Disposable[], extensionMode: 1 };
    const host = {
        ExtensionMode: { Development: 2 },
        extensions: { getExtension: noop },
        window: {
            createOutputChannel(name: string) {
                invoke(name.includes('Status') ? 'status.create' : 'logger.create');
                const channel = { name, disposed: false, disposeCount: 0 };
                channels.push(channel);
                const write = (): void => {
                    if (channel.disposed) {
                        throw new Error('Channel has been closed');
                    }
                };
                return {
                    trace: write,
                    debug: write,
                    info: write,
                    warn: write,
                    error: write,
                    dispose() {
                        channel.disposed = true;
                        channel.disposeCount++;
                        invoke(name.includes('Status') ? 'status.dispose' : 'logger.dispose');
                    }
                };
            },
            showErrorMessage() {
                invoke('notification');
            }
        }
    };
    const { Logger } = loadSource<typeof import('./logger')>('src/utils/runtime/logger.ts', {
        vscode: host,
        './l10n': { t: (value: string) => value }
    });
    const { StatusLogger } = loadSource<typeof import('./statusLogger')>('src/utils/runtime/statusLogger.ts', {
        vscode: host
    });
    const disposable = { dispose: noop };
    const mocks: Record<string, unknown> = {
        vscode: host,
        './utils/runtime/logger': { Logger },
        './utils/runtime/statusLogger': { StatusLogger },
        './utils/config/apiKeyManager': {
            ApiKeyManager: { getApiKey: noop, initialize: noop, setApiKeyConsumerRefresher: noop }
        },
        './utils/config/configManager': {
            ConfigManager: {
                fetchWithProxy: noop,
                initialize: () => disposable,
                async dispose() {
                    invoke('config.dispose');
                }
            }
        },
        './utils/config/jsonSchemaProvider': {
            JsonSchemaProvider: { getAllAvailableProviders: noop, initialize: noop, dispose: noop }
        },
        './utils/net/proxyAgent': {
            closeProxyAgents: async () => {
                invoke('proxy.close');
            }
        },
        './utils/net/harRecorder': { registerHarRecorderCommand: noop },
        './utils/metadata/remoteMetadataService': {
            RemoteMetadataService: {
                initialize() {
                    if (failures.has('activation')) {
                        throw activationFailure;
                    }
                }
            }
        },
        './utils/metadata/remoteModelsService': {
            RemoteModelsService: { initialize: noop, startAfterProvidersRegistered: noop }
        },
        './cli/cliAuthCommands': { registerCliAuthCommands: noop },
        './cli/auth/cliAuthFactory': { CliAuthFactory: { initialize: noop } },
        './ui/configSetManager': { registerConfigSetCommands: noop },
        './utils/config/configSetStore': { ConfigSetStore: { initialize: noop } },
        './utils/config/failover/apiKeyFailoverManager': { ApiKeyFailoverManager: { becomeBalanceAuthority: noop } },
        './sync/gistSyncService': { GistSyncService: { initialize: noop } },
        './usages/usagesManager': {
            TokenUsagesManager: {
                instance: {
                    initialize: noop,
                    async dispose() {
                        invoke('usages.dispose');
                    }
                }
            }
        },
        './usages/usageActivation': { registerUsageRefreshHandlers: noop },
        './ui/usagesView': { registerTokenUsageCommands: noop },
        './utils/config/compatibleModelManager': {
            CompatibleModelManager: {
                initialize: noop,
                dispose() {
                    invoke('compatible.dispose');
                }
            }
        },
        './status': {
            LeaderElectionService: {
                initialize() {
                    context.subscriptions.push({
                        dispose() {
                            invoke('subscription.first');
                        }
                    });
                    context.subscriptions.push({
                        dispose() {
                            invoke('subscription.second');
                        }
                    });
                },
                registerCommands: noop,
                subscribeToLeaderResigning: noop,
                getOwnedAuthorityTerm: noop,
                async stop() {
                    invoke('leader.stop');
                }
            },
            StatusBarManager: {
                initializeAll: noop,
                disposeAll() {
                    invoke('statusBars.dispose');
                },
                getStatusBar: noop
            }
        },
        './interInstance': {
            InterInstanceBus: {
                initialize: noop,
                async dispose() {
                    invoke('bus.dispose');
                }
            }
        },
        './interInstance/activation': { registerInterInstanceHandlers: noop },
        './utils/config/configSetCommands': { registerConfigSetProviderChangeHandlers: noop },
        './rateLimit/rateLimiter': { RateLimiter: { initialize: noop } },
        './tools': { registerAllTools: noop },
        './commit': { registerCommitCommands: noop, registerGitAvailability: noop },
        './providers': { activateCompatibleProvider: noop, activateProviders: noop },
        './utils/config/providerRegistry': {
            clearRegisteredProviders: noop,
            notifyRegisteredProvidersChanged: noop,
            registeredProviders: {
                review: {
                    dispose() {
                        invoke('provider.dispose');
                    }
                }
            }
        },
        './utils/runtime/l10n': { t: (value: string) => value },
        './utils/runtime/copilotChatActivation': { activateCopilotChatInBackground: () => disposable },
        './wizards/visionWizard': { registerVisionModelCommand: noop },
        './ui/auxiliaryModelSettings': { registerAuxiliaryModelSettingsCommands: noop },
        './wizards/startupWizard': { runStartupWizardIfNeeded: noop }
    };
    const entry = loadSource<{
        activate(extensionContext: typeof context): Promise<unknown>;
        deactivate(): Promise<void>;
    }>('src/extension.ts', mocks);
    return { entry, context, calls, channels, failures, activationFailure, Logger, StatusLogger };
}

const cleanupOrder = [
    'statusBars.dispose',
    'leader.stop',
    'bus.dispose',
    'provider.dispose',
    'compatible.dispose',
    'config.dispose',
    'proxy.close',
    'usages.dispose',
    'status.dispose',
    'logger.dispose'
];

for (const failure of [undefined, ...cleanupOrder]) {
    test(`entry cleanup attempts every stage after ${failure ?? 'normal activation'}`, async () => {
        const fixture = entryFixture();
        await fixture.entry.activate(fixture.context);
        fixture.calls.length = 0;
        if (failure) {
            fixture.failures.add(failure);
        }
        await fixture.entry.deactivate();
        assert.deepEqual(fixture.calls, cleanupOrder);
        assert.ok(fixture.channels.every(channel => channel.disposed));
    });
}

for (const failure of [undefined, 'subscription.second', 'notification']) {
    test(`activation rollback preserves the original error with ${failure ?? 'ordinary cleanup'}`, async () => {
        const fixture = entryFixture();
        let preexistingDisposed = false;
        const preexisting = {
            dispose() {
                preexistingDisposed = true;
            }
        };
        fixture.context.subscriptions.push(preexisting);
        fixture.failures.add('activation');
        if (failure) {
            fixture.failures.add(failure);
        }
        await assert.rejects(fixture.entry.activate(fixture.context), error => error === fixture.activationFailure);
        assert.ok(fixture.calls.includes('subscription.first'));
        assert.ok(fixture.calls.includes('subscription.second'));
        assert.deepEqual(fixture.context.subscriptions, [preexisting]);
        assert.equal(preexistingDisposed, false);
        assert.ok(fixture.channels.every(channel => channel.disposed));
    });
}

test('activation rolls back the first channel when second channel creation fails', async () => {
    const fixture = entryFixture();
    fixture.failures.add('status.create');
    await assert.rejects(fixture.entry.activate(fixture.context), /Injected status.create/);
    assert.equal(fixture.channels.length, 1);
    assert.equal(fixture.channels[0].disposed, true);
});

for (const loggerName of ['Logger', 'StatusLogger'] as const) {
    test(`${loggerName} releases replaced channels and tolerates logging after disposal`, () => {
        const fixture = entryFixture();
        const logger = fixture[loggerName];
        logger.initialize('first');
        logger.initialize('second');
        logger.dispose();
        logger.dispose();
        assert.doesNotThrow(() => logger.info('late completion'));
        assert.deepEqual(
            fixture.channels.map(channel => channel.disposeCount),
            [1, 1]
        );
    });
}

for (const failure of ['listener', 'client', 'publisher', 'server', 'fallback']) {
    test(`bus disposal drains other resources after ${failure} fails`, async () => {
        const calls: string[] = [];
        const invoke = (name: string): void => {
            calls.push(name);
            if (name === failure) {
                throw new Error(`Injected ${name}`);
            }
        };
        const state = {
            initialized: true,
            lifecycleGeneration: 1,
            cancelLeaderLiveness: noop,
            reconnectTimer: undefined,
            reconnectAttempts: 1,
            remoteLeaderLivenessCompatible: true,
            confirmedLeaderAuthorityTerm: 'old',
            leaderChangeDisposable: {
                dispose() {
                    invoke('listener');
                }
            },
            roleSwitchChain: Promise.resolve(),
            client: {
                async disconnect() {
                    invoke('client');
                }
            },
            clientTarget: {},
            async stopLeaderFilePublisher() {
                invoke('publisher');
            },
            server: {
                async stop() {
                    invoke('server');
                }
            },
            fallbackTransport: {
                async stop() {
                    invoke('fallback');
                }
            },
            handlers: new Map([['review', new Set()]]),
            context: {},
            extensionVersion: 'review',
            remoteUsagesQueryCompatible: true,
            roleTransitioning: 0
        };
        const dispose = loadDispose<typeof state>('src/interInstance/interInstanceBus.ts', 'InterInstanceBus', {
            StatusLogger: silentLogger
        });
        await dispose.call(state).catch(() => undefined);
        assert.deepEqual(calls, ['listener', 'client', 'publisher', 'server', 'fallback']);
        assert.equal(state.handlers.size, 0);
        assert.equal(state.context, undefined);
    });
}

test('configuration listener failure still drains HAR and clears references', async () => {
    const failure = new Error('Injected configuration listener failure');
    const state = {
        configListener: {
            dispose() {
                throw failure;
            }
        },
        cache: {},
        context: {},
        extensionVersion: 'review'
    };
    let harDisposed = false;
    const dispose = loadDispose<typeof state>('src/utils/config/configManager.ts', 'ConfigManager', {
        Logger: silentLogger,
        HarRecorder: {
            getInstance: () => ({
                async dispose() {
                    await Promise.resolve();
                    harDisposed = true;
                }
            })
        }
    });
    await assert.rejects(dispose.call(state), error => error === failure);
    assert.equal(harDisposed, true);
    assert.equal(state.configListener, null);
    assert.equal(state.context, null);
});

class Watcher extends EventEmitter {
    closeCount = 0;
    close(): void {
        this.closeCount++;
    }
}

interface FallbackInternals {
    directoryWatcher?: Watcher;
    fileStates: Map<string, { position: number; watcher?: Watcher }>;
    readTasks: Set<Promise<void>>;
    activeReadCount: number;
    readWaiters: Array<() => void>;
    readNewEvents(filename: string, replayed?: boolean): Promise<void>;
    initializeExistingFiles(replayed?: boolean): void;
    cleanupStaleFiles(): void;
}

async function fallbackFixture(context: TestContext, watchFailures = 0, autoStart = true) {
    const directory = await fs.promises.mkdtemp(join(tmpdir(), 'gcmp-fallback-lifecycle-'));
    const eventsDir = join(directory, 'inter-instance');
    await fs.promises.mkdir(eventsDir);
    const received: Array<{ event: eventProtocol.InterInstanceEvent; replayed: boolean }> = [];
    const watchers: Watcher[] = [];
    const watchedFiles: string[] = [];
    const timers = new Map<object, () => void>();
    const intervals = new Set<object>();
    const state = {
        watchFailures,
        openHandles: 0,
        peakOpenHandles: 0,
        statCalls: [] as string[],
        openedFiles: [] as string[],
        ioFailures: new Map<string, 'open' | 'read' | 'close'>(),
        raisedFailures: 0,
        readGate: undefined as { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined,
        onStat: undefined as (() => void) | undefined,
        onEvent: undefined as (() => void) | undefined
    };
    const { FallbackTransport: Transport } = evaluate<typeof import('../../interInstance/fallbackTransport')>(
        readFileSync(resolve(root, 'src/interInstance/fallbackTransport.ts'), 'utf8'),
        {
            './eventProtocol': eventProtocol,
            '../utils/runtime/statusLogger': { StatusLogger: silentLogger },
            'node:fs': {
                ...fs,
                watch(filename: string, callback: (...args: unknown[]) => void) {
                    watchedFiles.push(filename);
                    if (state.watchFailures > 0) {
                        state.watchFailures--;
                        throw Object.assign(new Error('Injected watch failure'), { code: 'EPERM' });
                    }
                    const watcher = new Watcher();
                    watcher.on('change', callback);
                    watchers.push(watcher);
                    return watcher;
                },
                promises: {
                    ...fs.promises,
                    async stat(filename: string) {
                        state.statCalls.push(filename);
                        const stats = await fs.promises.stat(filename);
                        state.onStat?.();
                        return stats;
                    },
                    async open(...args: Parameters<typeof fs.promises.open>) {
                        const filename = String(args[0]);
                        state.openedFiles.push(filename);
                        if (state.ioFailures.get(filename) === 'open') {
                            state.raisedFailures++;
                            throw new Error('Injected open failure');
                        }
                        const handle = await fs.promises.open(...args);
                        state.openHandles++;
                        state.peakOpenHandles = Math.max(state.peakOpenHandles, state.openHandles);
                        return {
                            async read(buffer: Buffer, offset: number, length: number, position: number) {
                                if (state.ioFailures.get(filename) === 'read') {
                                    state.raisedFailures++;
                                    throw new Error('Injected read failure');
                                }
                                if (state.readGate) {
                                    state.readGate.entered.release();
                                    await state.readGate.release.promise;
                                }
                                return handle.read(buffer, offset, length, position);
                            },
                            stat: () => handle.stat(),
                            async close() {
                                await handle.close();
                                state.openHandles--;
                                if (state.ioFailures.get(filename) === 'close') {
                                    state.raisedFailures++;
                                    throw new Error('Injected close failure');
                                }
                            }
                        };
                    }
                }
            }
        },
        {
            setTimeout(callback: () => void) {
                const timer = { unref: noop };
                timers.set(timer, callback);
                return timer;
            },
            clearTimeout(timer: object) {
                timers.delete(timer);
            },
            setInterval() {
                const timer = {};
                intervals.add(timer);
                return timer;
            },
            clearInterval(timer: object) {
                intervals.delete(timer);
            }
        }
    );
    const transport: FallbackTransport = new Transport({
        instanceId: 'local',
        onEvent(event, replayed) {
            received.push({ event, replayed });
            state.onEvent?.();
        }
    });
    const internals = transport as unknown as FallbackInternals;
    const extensionContext = { globalStorageUri: { fsPath: directory } } as vscode.ExtensionContext;
    context.after(async () => {
        state.readGate?.release.release();
        await transport.stop();
        await fs.promises.rm(directory, { recursive: true, force: true });
    });
    if (autoStart) {
        transport.start(extensionContext);
    }
    async function drainReads(): Promise<void> {
        while (internals.readTasks.size > 0) {
            await Promise.all(internals.readTasks);
        }
    }
    function event(sequence: number): eventProtocol.InterInstanceEvent {
        return {
            type: 'configChanged',
            senderInstanceId: 'remote',
            timestamp: sequence,
            payload: { changedKeys: [`key-${sequence}`] }
        };
    }
    async function writeEvents(sequences: number[], instanceId = 'remote'): Promise<string> {
        const filename = join(eventsDir, `events-${instanceId}.jsonl`);
        await fs.promises.appendFile(
            filename,
            sequences
                .map(sequence => JSON.stringify({ ...event(sequence), senderInstanceId: instanceId }) + '\n')
                .join('')
        );
        return filename;
    }
    async function recover(): Promise<void> {
        assert.equal(timers.size, 1);
        const [timer, callback] = [...timers][0];
        timers.delete(timer);
        callback();
        await drainReads();
    }
    return {
        transport,
        internals,
        extensionContext,
        received,
        watchers,
        watchedFiles,
        timers,
        intervals,
        state,
        event,
        writeEvents,
        drainReads,
        recover
    };
}

test('fallback lifecycle stop drains open readers and suppresses late delivery', { timeout: 5000 }, async context => {
    const fixture = await fallbackFixture(context);
    const filename = await fixture.writeEvents([1, 2]);
    fixture.state.readGate = { entered: gate(), release: gate() };
    fixture.internals.initializeExistingFiles();
    await fixture.state.readGate.entered.promise;
    let returned = false;
    const stopping = fixture.transport.stop().then(() => {
        returned = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const earlyReturn = returned;
    assert.equal(fixture.state.openHandles, 1);
    fixture.state.readGate.release.release();
    await stopping;
    await fixture.internals.readNewEvents(filename);
    assert.equal(earlyReturn, false);
    assert.equal(fixture.state.openHandles, 0);
    assert.equal(fixture.received.length, 0);
    assert.equal(fixture.internals.readTasks.size, 0);
    assert.equal(fixture.intervals.size, 0);
});

test('fallback lifecycle callback-triggered stop suppresses later records in the same batch', async context => {
    const fixture = await fallbackFixture(context);
    await fixture.writeEvents([1, 2, 3]);
    let stopping: Promise<void> | undefined;
    fixture.state.onEvent = () => {
        stopping = fixture.transport.stop();
    };
    fixture.internals.initializeExistingFiles();
    await fixture.drainReads();
    await stopping;
    assert.equal(fixture.received.length, 1);
    assert.equal(fixture.state.openHandles, 0);
});

for (const kind of ['directory', 'file'] as const) {
    test(`fallback lifecycle restores ${kind} watcher without resetting read offsets`, async context => {
        const fixture = await fallbackFixture(context);
        const filename = await fixture.writeEvents([1]);
        fixture.internals.initializeExistingFiles();
        await fixture.drainReads();
        const fileState = fixture.internals.fileStates.get(filename)!;
        const offset = fileState.position;
        const watcher = kind === 'directory' ? fixture.internals.directoryWatcher! : fileState.watcher!;
        watcher.emit('error', Object.assign(new Error('Injected watcher error'), { code: 'EPERM' }));
        watcher.emit('error', new Error('Repeated stale watcher error'));
        await fixture.drainReads();
        assert.equal(watcher.closeCount, 1);
        assert.equal(fixture.timers.size, 1);
        await fixture.writeEvents([2]);
        await fixture.recover();
        assert.equal(fixture.internals.fileStates.get(filename), fileState);
        assert.ok(fileState.position > offset);
        assert.deepEqual(
            fixture.received.map(entry => [entry.event.timestamp, entry.replayed]),
            [
                [1, true],
                [2, false]
            ]
        );
        const replacement = kind === 'directory' ? fixture.internals.directoryWatcher : fileState.watcher;
        assert.ok(replacement);
        assert.notEqual(replacement, watcher);
        watcher.emit('error', new Error('Late old watcher error'));
        assert.equal(fixture.timers.size, 0);
        await fixture.writeEvents([3]);
        fileState.watcher!.emit('change', 'change', 'events-remote.jsonl');
        await fixture.drainReads();
        assert.equal(fixture.received.length, 3);
        assert.equal(fixture.received[2].replayed, false);
    });
}

test('fallback lifecycle stop cancels recovery and ignores stale errors and restart', async context => {
    const fixture = await fallbackFixture(context);
    const watcher = fixture.internals.directoryWatcher!;
    watcher.emit('error', new Error('Injected directory error'));
    const callback = [...fixture.timers.values()][0];
    await fixture.transport.stop();
    callback();
    watcher.emit('error', new Error('Late directory error'));
    fixture.transport.start(fixture.extensionContext);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.intervals.size, 0);
    assert.equal(fixture.internals.directoryWatcher, undefined);
    assert.equal(fixture.watchers.length, 1);
});

test('fallback lifecycle retries watcher creation and discovers live files after recovery', async context => {
    const fixture = await fallbackFixture(context, 2);
    assert.equal(fixture.internals.directoryWatcher, undefined);
    await fixture.writeEvents([1]);
    await fixture.recover();
    assert.equal(fixture.timers.size, 1);
    await fixture.recover();
    assert.ok(fixture.internals.directoryWatcher);
    assert.equal(fixture.timers.size, 0);
    assert.deepEqual(
        fixture.received.map(entry => [entry.event.timestamp, entry.replayed]),
        [[1, false]]
    );
});

test('fallback lifecycle repeated start does not replace watchers or cleanup timers', async context => {
    const fixture = await fallbackFixture(context);
    const watcher = fixture.internals.directoryWatcher;
    fixture.transport.start(fixture.extensionContext);
    assert.equal(fixture.internals.directoryWatcher, watcher);
    assert.equal(fixture.watchers.length, 1);
    assert.equal(fixture.intervals.size, 1);
});

for (const fileCount of [8, 64]) {
    test(`fallback limits concurrent reads across ${fileCount} event files`, { timeout: 5000 }, async context => {
        const fixture = await fallbackFixture(context);
        for (let index = 0; index < fileCount; index++) {
            await fixture.writeEvents([index + 1], `remote-${index}`);
        }
        const scanned = gate();
        let statCount = 0;
        fixture.state.onStat = () => {
            if (++statCount === fileCount) {
                scanned.release();
            }
        };
        fixture.state.readGate = { entered: gate(), release: gate() };
        fixture.internals.initializeExistingFiles();
        await scanned.promise;
        await fixture.state.readGate.entered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        const admittedReads = fixture.state.openedFiles.length;
        fixture.state.readGate.release.release();
        await fixture.drainReads();

        assert.ok(admittedReads <= 4, `Admitted ${admittedReads} reads while the first batch was blocked`);
        assert.ok(fixture.state.peakOpenHandles <= 4, `Opened ${fixture.state.peakOpenHandles} files at once`);
        assert.equal(fixture.state.openHandles, 0);
        assert.equal(fixture.received.length, fileCount);
        assert.equal(new Set(fixture.received.map(entry => entry.event.timestamp)).size, fileCount);
        assert.ok(fixture.received.every(entry => entry.replayed));
    });
}

test('fallback stop drains active reads without opening queued files', { timeout: 5000 }, async context => {
    const fixture = await fallbackFixture(context);
    for (let index = 0; index < 8; index++) {
        await fixture.writeEvents([index + 1], `remote-${index}`);
    }
    fixture.state.readGate = { entered: gate(), release: gate() };
    fixture.internals.initializeExistingFiles();
    await fixture.state.readGate.entered.promise;
    const openedBeforeStop = fixture.state.openedFiles.length;
    let returned = false;
    const stopping = fixture.transport.stop().then(() => {
        returned = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    fixture.state.readGate.release.release();
    await stopping;

    assert.ok(openedBeforeStop <= 4, `Opened ${openedBeforeStop} files before stop`);
    assert.equal(fixture.state.openedFiles.length, openedBeforeStop);
    assert.equal(fixture.state.openHandles, 0);
    assert.equal(fixture.internals.readTasks.size, 0);
    assert.equal(fixture.internals.activeReadCount, 0);
    assert.equal(fixture.internals.readWaiters.length, 0);
    assert.equal(fixture.received.length, 0);
    assert.ok(fixture.watchers.every(watcher => watcher.closeCount === 1));
});

test('fallback startup removes stale files before watching or reading them', async context => {
    const fixture = await fallbackFixture(context, 0, false);
    const staleFile = await fixture.writeEvents([1], 'stale');
    const freshFile = await fixture.writeEvents([2], 'fresh');
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.promises.utimes(staleFile, expired, expired);
    fixture.transport.start(fixture.extensionContext);
    await fixture.drainReads();

    assert.equal(fs.existsSync(staleFile), false);
    assert.equal(fixture.watchedFiles.includes(staleFile), false);
    assert.equal(fixture.state.statCalls.includes(staleFile), false);
    assert.ok(fixture.watchedFiles.includes(freshFile));
    assert.deepEqual(
        fixture.received.map(entry => [entry.event.timestamp, entry.replayed]),
        [[2, true]]
    );
});

test(
    'fallback queued reads preserve replay boundaries and coalesce notifications',
    { timeout: 5000 },
    async context => {
        const fixture = await fallbackFixture(context);
        const files: string[] = [];
        for (let index = 0; index < 8; index++) {
            files.push(await fixture.writeEvents([index + 1], `remote-${index}`));
        }
        const scanned = gate();
        let statCount = 0;
        fixture.state.onStat = () => {
            if (++statCount === files.length) {
                scanned.release();
            }
        };
        fixture.state.readGate = { entered: gate(), release: gate() };
        fixture.internals.initializeExistingFiles();
        await scanned.promise;
        await fixture.state.readGate.entered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        const queuedIndex = files.findIndex(filename => !fixture.state.openedFiles.includes(filename));
        assert.ok(queuedIndex >= 0, 'Expected an event file to remain queued');
        const filename = await fixture.writeEvents([100], `remote-${queuedIndex}`);
        await Promise.all(Array.from({ length: 20 }, () => fixture.internals.readNewEvents(filename)));
        assert.equal(fixture.internals.readTasks.size, files.length);
        fixture.state.readGate.release.release();
        await fixture.drainReads();

        assert.deepEqual(
            fixture.received
                .filter(entry => entry.event.senderInstanceId === `remote-${queuedIndex}`)
                .map(entry => [entry.event.timestamp, entry.replayed]),
            [
                [queuedIndex + 1, true],
                [100, false]
            ]
        );
        assert.equal(fixture.state.openedFiles.filter(opened => opened === filename).length, 2);
        assert.equal(fixture.received.length, 9);
        assert.ok(fixture.state.peakOpenHandles <= 4);
        assert.equal(fixture.state.openHandles, 0);
    }
);

for (const operation of ['open', 'read', 'close'] as const) {
    test(`fallback releases read slots after ${operation} errors`, { timeout: 5000 }, async context => {
        const fixture = await fallbackFixture(context);
        for (let index = 0; index < 8; index++) {
            const filename = await fixture.writeEvents([index + 1], `remote-${index}`);
            if (index < 4) {
                fixture.state.ioFailures.set(filename, operation);
            }
        }
        fixture.internals.initializeExistingFiles();
        await fixture.drainReads();

        assert.equal(fixture.state.raisedFailures, 4);
        assert.equal(fixture.received.length, operation === 'close' ? 8 : 4);
        assert.ok(fixture.state.peakOpenHandles <= 4);
        assert.equal(fixture.state.openHandles, 0);
        assert.equal(fixture.internals.activeReadCount, 0);
        assert.equal(fixture.internals.readWaiters.length, 0);
        fixture.state.ioFailures.clear();
        const filename = await fixture.writeEvents([100], 'remote-0');
        await fixture.internals.readNewEvents(filename);
        await fixture.drainReads();
        assert.ok(fixture.received.some(entry => entry.event.timestamp === 100 && !entry.replayed));
        assert.equal(fixture.state.openHandles, 0);
    });
}

for (const recreate of [false, true]) {
    test(`fallback skips expired queued reader state: recreate=${recreate}`, { timeout: 5000 }, async context => {
        const fixture = await fallbackFixture(context);
        const files: string[] = [];
        for (let index = 0; index < 8; index++) {
            files.push(await fixture.writeEvents([index + 1], `remote-${index}`));
        }
        const scanned = gate();
        let statCount = 0;
        fixture.state.onStat = () => {
            if (++statCount === files.length) {
                scanned.release();
            }
        };
        fixture.state.readGate = { entered: gate(), release: gate() };
        fixture.internals.initializeExistingFiles();
        await scanned.promise;
        await fixture.state.readGate.entered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        const queuedIndex = files.findIndex(filename => !fixture.state.openedFiles.includes(filename));
        assert.ok(queuedIndex >= 0);
        const filename = files[queuedIndex];
        const oldState = fixture.internals.fileStates.get(filename)!;
        const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await fs.promises.utimes(filename, expired, expired);
        fixture.internals.cleanupStaleFiles();
        assert.equal(fixture.internals.fileStates.has(filename), false);
        assert.equal(oldState.watcher!.closeCount, 1);
        if (recreate) {
            await fixture.writeEvents([200], `remote-${queuedIndex}`);
            fixture.internals.initializeExistingFiles(false);
            assert.notEqual(fixture.internals.fileStates.get(filename), oldState);
        }
        fixture.state.readGate.release.release();
        await fixture.drainReads();

        assert.equal(fixture.state.openedFiles.filter(opened => opened === filename).length, recreate ? 1 : 0);
        assert.deepEqual(
            fixture.received
                .filter(entry => entry.event.senderInstanceId === `remote-${queuedIndex}`)
                .map(entry => [entry.event.timestamp, entry.replayed]),
            recreate ? [[200, false]] : []
        );
        assert.equal(fixture.received.length, recreate ? 8 : 7);
        assert.ok(fixture.state.peakOpenHandles <= 4);
        assert.equal(fixture.state.openHandles, 0);
        assert.equal(fixture.internals.activeReadCount, 0);
        assert.equal(fixture.internals.readWaiters.length, 0);
    });
}
