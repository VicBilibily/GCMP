import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { FIMCompletionConfig, GcmpCompletionServices, NESCompletionConfig } from '../types';
import type * as vscodeApi from 'vscode';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const child = resolve(root, 'extensions/gcmp-fim-nes');
const noop = (): void => {};
type Services = GcmpCompletionServices;
interface ConfigReaders {
    getFIMConfig(): FIMCompletionConfig;
    getNESConfig(): NESCompletionConfig;
}
interface Bridge {
    completionLogger: typeof import('../completionLogger').completionLogger;
    acceptCompletionServices(services: object | null): void;
    isGcmpServicesAvailable(): boolean;
    getApiKeyManager(): Services['ApiKeyManager'];
    getConfigManager(): Services['ConfigManager'];
    notifyMainExtension(): void;
    closeProxyAgents(): Promise<void>;
    getAvailableProviders(): ReturnType<Services['getAvailableProviders']>;
}
interface MainExports {
    notifyConsumerReady(id: string): void;
    verifyCompletionServices(candidate: object): boolean;
}
interface ActivationContext {
    subscriptions: Array<{ dispose(): void }>;
    extensionMode?: number;
}
interface Entry {
    activate(context: ActivationContext): Promise<{ acceptCompletionServices(services: object): void }>;
}
interface ShimExports {
    InlineCompletionShim: {
        createAndActivate(context: ActivationContext): { provider: { dispose(): void } };
    };
}

interface CompletionSchema {
    $schema: string;
    properties: Record<
        string,
        {
            additionalProperties: boolean;
            properties: { provider: { type: string; enum?: string[]; enumDescriptions?: string[] } };
        }
    >;
}

function fixture() {
    const registry = new Map<string, { isActive: boolean; exports: unknown }>();
    const channels: Array<{ disposed: boolean; dispose(): void }> = [];
    const registrations: Array<{ disposed: boolean }> = [];
    const commands = new Set<string>();
    const commandCallbacks = new Map<string, () => Promise<void>>();
    const notifications: string[] = [];
    const logMessages: string[] = [];
    const callbacks: Array<() => void> = [];
    const events: Array<{ disposed: boolean; fired: unknown[] }> = [];
    const schemas: Array<{ disposed: boolean; provider: vscodeApi.FileSystemProvider }> = [];
    const configListeners = new Set<
        (event: Pick<vscodeApi.ConfigurationChangeEvent, 'affectsConfiguration'>) => void
    >();
    const logs = { trace: noop, debug: noop, info: noop, warn: noop, error: noop };
    const disposable = () => ({ dispose: noop });
    const vscode = {
        extensions: { getExtension: (id: string) => registry.get(id) },
        ExtensionMode: { Development: 2 },
        ConfigurationTarget: { Global: 1 },
        env: { language: 'en' },
        Uri: {
            parse: (value: string) => {
                const uri = new URL(value);
                return {
                    scheme: uri.protocol.slice(0, -1),
                    authority: uri.host,
                    path: uri.pathname,
                    toString: () => value
                };
            }
        },
        FileType: { File: 1 },
        FileChangeType: { Changed: 1 },
        FileSystemError: {
            FileNotFound: () => new Error('File not found'),
            NoPermissions: () => new Error('Read only')
        },
        Disposable: class {
            constructor(private readonly callback: () => void) {}
            dispose(): void {
                this.callback();
            }
            static from(...resources: Array<{ dispose(): void }>) {
                return { dispose: () => resources.forEach(resource => resource.dispose()) };
            }
        },
        EventEmitter: class {
            private readonly state = { disposed: false, fired: [] as unknown[] };
            event = disposable;
            constructor() {
                events.push(this.state);
            }
            fire(value: unknown): void {
                this.state.fired.push(value);
            }
            dispose(): void {
                this.state.disposed = true;
            }
        },
        workspace: {
            getConfiguration: () => ({
                get: (key: string, fallback?: unknown) => {
                    const [section, ...keys] = key.split('.');
                    const source =
                        section === 'fimCompletion' ? fim
                        : section === 'nesCompletion' ? nes
                        : undefined;
                    const value = keys.reduce<unknown>(
                        (current, name) =>
                            current && typeof current === 'object' ?
                                (current as Record<string, unknown>)[name]
                            :   undefined,
                        source
                    );
                    return value === undefined ? fallback : value;
                }
            }),
            registerFileSystemProvider: (_scheme: string, provider: vscodeApi.FileSystemProvider) => {
                const state = { disposed: false, provider };
                schemas.push(state);
                return {
                    dispose: () => {
                        state.disposed = true;
                    }
                };
            },
            onDidChangeConfiguration: (
                listener: (event: Pick<vscodeApi.ConfigurationChangeEvent, 'affectsConfiguration'>) => void
            ) => {
                configListeners.add(listener);
                return {
                    dispose: () => {
                        configListeners.delete(listener);
                    }
                };
            }
        },
        window: {
            createOutputChannel: (name: string, options: { log: true }) => {
                assert.equal(options.log, true);
                const write = (message: string): void => {
                    if (channel.disposed) {
                        throw new Error('Channel has been closed');
                    }
                    logMessages.push(message);
                };
                const channel = {
                    trace: write,
                    debug: write,
                    info: write,
                    warn: write,
                    error: write,
                    name,
                    disposed: false,
                    dispose(): void {
                        this.disposed = true;
                    }
                };
                channels.push(channel);
                return channel;
            },
            showErrorMessage: noop,
            showInformationMessage: (message: string) => {
                notifications.push(message);
                return Promise.resolve(undefined);
            }
        },
        languages: {
            registerInlineCompletionItemProvider: () => {
                const registration = { disposed: false };
                registrations.push(registration);
                return {
                    dispose: () => {
                        registration.disposed = true;
                    }
                };
            }
        },
        commands: {
            registerCommand: (id: string, callback: () => Promise<void>) => {
                if (commands.has(id)) {
                    throw new Error(`command '${id}' already exists`);
                }
                commands.add(id);
                commandCallbacks.set(id, callback);
                return {
                    dispose: () => {
                        commands.delete(id);
                        commandCallbacks.delete(id);
                    }
                };
            }
        }
    };
    const fim = {
        enabled: false,
        debounceMs: 500,
        timeoutMs: 5000,
        modelConfig: {
            provider: 'review',
            baseUrl: 'https://example.invalid',
            model: 'fim',
            maxTokens: 200,
            extraBody: { nested: { flag: true } }
        }
    };
    const nes = { ...structuredClone(fim), manualOnly: false };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let disconnects = 0;
    const services: Services = {
        ApiKeyManager: { getApiKey: async () => 'synthetic-test-key' },
        ConfigManager: {
            fetchWithProxy: async (input, init) => {
                requests.push({ url: String(input), init });
                return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
            }
        },
        closeProxyAgents: async () => {
            disconnects++;
        },
        getAvailableProviders: () => ({ providerIds: ['review'], enumDescriptions: ['Review'] })
    };
    const cache = new Map<string, unknown>();
    const sandboxes: Array<Record<string, unknown>> = [];
    function load<T>(filename: string, importer?: (id: string) => unknown): T {
        filename = resolve(filename);
        if (cache.has(filename)) {
            return cache.get(filename) as T;
        }
        const module = { exports: {} };
        const code = transformSync(readFileSync(filename, 'utf8'), {
            loader: 'ts',
            format: 'cjs',
            target: 'es2022'
        }).code;
        const sandbox: Record<string, unknown> = {
            module,
            exports: module.exports,
            console: logs,
            structuredClone,
            URL,
            Request,
            Response,
            AbortController,
            ReadableStream,
            TextEncoder,
            TextDecoder,
            Buffer,
            setImmediate: (callback: () => void) => callbacks.push(callback),
            require: (id: string) =>
                id === 'vscode' ? vscode
                : importer ? importer(id)
                : load(resolve(dirname(filename), `${id}.ts`))
        };
        sandboxes.push(sandbox);
        runInNewContext(code, sandbox, { filename });
        cache.set(filename, module.exports);
        return module.exports as T;
    }
    function loadMain() {
        const staticObject: object = new Proxy(noop, {
            get: (_target, key) =>
                key === 'instance' ? staticObject
                : key === 'then' ? undefined
                : noop
        });
        const known: Record<string, unknown> = {
            Logger: { ...logs, initialize: noop, checkAndPromptLogLevel: noop },
            StatusLogger: staticObject,
            ApiKeyManager: { ...services.ApiKeyManager, initialize: noop, setApiKeyConsumerRefresher: noop },
            ConfigManager: {
                ...services.ConfigManager,
                initialize: disposable
            },
            JsonSchemaProvider: { initialize: noop, getAllAvailableProviders: services.getAvailableProviders },
            StatusBarManager: { initializeAll: noop, getStatusBar: () => ({ context: { secrets: {} } }) },
            registeredProviders: {},
            configProviders: { review: {} },
            closeProxyAgents: services.closeProxyAgents,
            t: (english: string) => english,
            activateCopilotChatInBackground: disposable
        };
        const dependency = new Proxy(
            {},
            {
                get: (_target, key: string) =>
                    key === '__esModule' ? true
                    : key in known ? known[key]
                    : staticObject
            }
        );
        return load<{ activate(context: ActivationContext): Promise<MainExports> }>(
            resolve(root, 'src/extension.ts'),
            () => dependency
        );
    }
    const bridge = load<Bridge>(resolve(child, 'src/gcmpServices.ts'));
    const connect = () =>
        registry.set('vicanent.gcmp', {
            isActive: true,
            exports: {
                verifyCompletionServices: (candidate: object) => candidate === services,
                notifyConsumerReady: () => bridge.acceptCompletionServices(services)
            }
        });
    return {
        registry,
        channels,
        registrations,
        commands,
        commandCallbacks,
        notifications,
        logMessages,
        callbacks,
        events,
        schemas,
        configListeners,
        vscode,
        fim,
        nes,
        services,
        requests,
        sandboxes,
        bridge,
        connect,
        load,
        loadMain,
        get disconnects() {
            return disconnects;
        }
    };
}

test('bridge exposes the local logger directly without pure service or logger accessors', () => {
    const f = fixture();
    const local = f.load<typeof import('../completionLogger')>(resolve(child, 'src/completionLogger.ts'));
    assert.equal(f.channels.length, 1);
    assert.equal(local.completionLogger, f.channels[0]);
    assert.equal(f.bridge.completionLogger, local.completionLogger);
    assert.equal('initializeCompletionLogger' in local, false);
    assert.equal('getCompletionLogger' in f.bridge, false);
    assert.doesNotMatch(readFileSync(resolve(child, 'src/gcmpServices.ts'), 'utf8'), /function getServices\(/);
});

test('shared logger uses the native channel methods and disposal without forwarding', () => {
    const f = fixture();
    const messages: unknown[][] = [];
    const local = f.load<typeof import('../completionLogger')>(resolve(child, 'src/completionLogger.ts'));
    const logger = f.bridge.completionLogger;
    assert.equal(logger, f.channels[0]);
    assert.equal(logger, local.completionLogger);
    assert.equal(logger.name, 'GitHub Copilot Inline Completion via GCMP');
    assert.equal(logger.dispose, f.channels[0].dispose);
    logger.trace = function (this: vscodeApi.LogOutputChannel, message: string, ...args: unknown[]): void {
        assert.equal(this, f.channels[0]);
        messages.push([message, ...args]);
    };
    local.completionLogger.trace('active', 0, false);
    assert.deepEqual(messages, [['active', 0, false]]);
    assert.equal(f.load<typeof import('../completionLogger')>(resolve(child, 'src/completionLogger.ts')), local);
    assert.equal(f.channels.length, 1);
    logger.dispose();
    assert.equal(f.channels[0].disposed, true);
});

test('native log methods reject writes after disposal', () => {
    const f = fixture();
    const logger = f.bridge.completionLogger;
    const levels = ['trace', 'debug', 'info', 'warn', 'error'] as const;
    for (const level of levels) {
        logger[level]('before disposal');
    }
    logger.dispose();
    for (const level of levels) {
        assert.throws(() => logger[level]('after disposal'), /Channel has been closed/, level);
    }
});

for (const active of [false, true]) {
    test(`global singleton cannot authorize services (main active=${active})`, () => {
        const f = fixture();
        f.registry.set('vicanent.gcmp', { isActive: active, exports: {} });
        for (const sandbox of f.sandboxes) {
            sandbox.__gcmp_singletons = { ...f.services, CompletionLogger: {}, StatusBarManager: {} };
        }
        assert.equal(f.bridge.isGcmpServicesAvailable(), false);
        assert.throws(() => f.bridge.getApiKeyManager(), /required/);
    });
}

test('minimal verified bridge works without status bars', async () => {
    const f = fixture();
    f.connect();
    f.bridge.acceptCompletionServices(f.services);
    assert.equal(f.bridge.isGcmpServicesAvailable(), true);
    assert.equal(await f.bridge.getApiKeyManager().getApiKey('review'), 'synthetic-test-key');
    assert.equal(f.bridge.getConfigManager(), f.services.ConfigManager);
    assert.equal('isDashscopeProviderSlot' in f.bridge, false);
    assert.equal('getDashscopeEndpoint' in f.bridge.getConfigManager(), false);
    await f.bridge.closeProxyAgents();
    assert.equal(f.disconnects, 1);
});

test('forged services cannot replace an accepted reference', () => {
    const f = fixture();
    Object.assign(f.services, { StatusBarManager: {} });
    f.connect();
    f.bridge.acceptCompletionServices({ ...f.services });
    assert.equal(f.bridge.isGcmpServicesAvailable(), false);
    f.bridge.acceptCompletionServices(f.services);
    f.bridge.acceptCompletionServices({ ...f.services });
    assert.equal(f.bridge.getConfigManager(), f.services.ConfigManager);
});

test('inactive main cannot verify even the correct reference', () => {
    const f = fixture();
    f.connect();
    f.registry.get('vicanent.gcmp')!.isActive = false;
    f.bridge.acceptCompletionServices(f.services);
    assert.equal(f.bridge.isGcmpServicesAvailable(), false);
});

test('verified but incomplete method sets are rejected', () => {
    for (const key of ['fetchWithProxy'] as const) {
        const f = fixture();
        const candidate = {
            ...f.services,
            StatusBarManager: {},
            ConfigManager: { ...f.services.ConfigManager, [key]: undefined }
        };
        f.registry.set('vicanent.gcmp', { isActive: true, exports: { verifyCompletionServices: () => true } });
        f.bridge.acceptCompletionServices(candidate);
        assert.equal(f.bridge.isGcmpServicesAvailable(), false, key);
    }
    for (const key of ['ApiKeyManager', 'closeProxyAgents', 'getAvailableProviders'] as const) {
        const f = fixture();
        f.registry.set('vicanent.gcmp', { isActive: true, exports: { verifyCompletionServices: () => true } });
        f.bridge.acceptCompletionServices({ ...f.services, StatusBarManager: {}, [key]: undefined });
        assert.equal(f.bridge.isGcmpServicesAvailable(), false, key);
    }
});

test('real main injects only the runtime minimum into the actual whitelist target', async () => {
    const f = fixture();
    const injections: Services[] = [];
    f.registry.set('vicanent.gcmp-fim-nes', {
        isActive: true,
        exports: {
            acceptCompletionServices: (services: Services) => injections.push(services)
        }
    });
    const main = await f.loadMain().activate({ subscriptions: [], extensionMode: 1 });
    const count = injections.length;
    main.notifyConsumerReady('other.publisher');
    assert.equal(injections.length, count);
    main.notifyConsumerReady('vicanent.gcmp-fim-nes');
    const services = injections.at(-1)!;
    assert.deepEqual(Object.keys(services).sort(), [
        'ApiKeyManager',
        'ConfigManager',
        'closeProxyAgents',
        'getAvailableProviders'
    ]);
    assert.deepEqual(Object.keys(services.ApiKeyManager), ['getApiKey']);
    assert.deepEqual(Object.keys(services.ConfigManager), ['fetchWithProxy']);
    assert.equal(main.verifyCompletionServices(services), true);
    assert.equal(main.verifyCompletionServices({ ...services }), false);
    assert.equal(await services.ApiKeyManager.getApiKey('review'), 'synthetic-test-key');
    assert.equal(
        JSON.stringify(services.getAvailableProviders()),
        JSON.stringify({ providerIds: ['review'], enumDescriptions: ['Review'] })
    );
});

test('local configuration reads cannot mutate stored configuration', () => {
    const f = fixture();
    const readers = f.load<ConfigReaders>(resolve(child, 'src/utils/completionConfig.ts'));
    readers.getFIMConfig().modelConfig.model = 'changed';
    const extra = readers.getFIMConfig().modelConfig.extraBody as { nested: { flag: boolean } };
    extra.nested.flag = false;
    readers.getNESConfig().modelConfig.model = 'changed';
    assert.equal(f.fim.modelConfig.model, 'fim');
    assert.equal(f.fim.modelConfig.extraBody.nested.flag, true);
    assert.equal(f.nes.modelConfig.model, 'fim');
});

for (const mode of ['FIM', 'NES'] as const) {
    test(`${mode} local reader clones Proxy configuration without changing JSON values or stored settings`, () => {
        const f = fixture();
        const config = mode === 'FIM' ? f.fim : f.nes;
        const extraBody = new Proxy(
            {
                nested: new Proxy({ flag: false }, {}),
                temperature: 0,
                enabled: false,
                values: new Proxy(['stop', 0, false], {}),
                empty: null,
                'dotted.key': 'literal'
            },
            {}
        );
        config.modelConfig.extraBody = extraBody;
        const original = JSON.stringify(config);
        const manager = f.load<ConfigReaders>(resolve(child, 'src/utils/completionConfig.ts'));
        const read = () => (mode === 'FIM' ? manager.getFIMConfig() : manager.getNESConfig());
        const copy = read();
        const extra = copy.modelConfig.extraBody as typeof extraBody;
        assert.equal(JSON.stringify(copy), original);
        assert.equal(types.isProxy(extra), false);
        assert.equal(types.isProxy(extra.nested), false);
        assert.equal(types.isProxy(extra.values), false);
        copy.modelConfig.model = 'changed';
        extra.nested.flag = true;
        extra.temperature = 1;
        extra.values.push('changed');
        assert.equal(JSON.stringify(config), original);
        assert.equal(JSON.stringify(read()), original);
    });
}

for (const main of [
    undefined,
    { isActive: false, exports: {} },
    { isActive: true, exports: {} },
    { isActive: true, exports: { notifyConsumerReady: noop } }
]) {
    test(`incompatible main rejects activation before any registrations (${JSON.stringify(main)})`, async () => {
        const f = fixture();
        if (main) {
            f.registry.set('vicanent.gcmp', main);
        }
        const entry = f.load<Entry>(resolve(child, 'src/extension.ts'));
        const context = { subscriptions: [] };
        await assert.rejects(entry.activate(context), /GCMP.*bridge/i);
        assert.equal(f.registrations.length, 0);
        assert.equal(f.channels.length, 1);
        assert.equal(f.channels[0].disposed, true);
        assert.equal(f.schemas.length, 0);
        assert.equal(f.callbacks.length, 0);
    });
}

test('shim registration failure releases its emitter and partial provider', () => {
    const f = fixture();
    f.commands.add('gcmp.nesCompletion.toggleManual');
    const shim = f.load<ShimExports>(resolve(child, 'src/copilot/inlineCompletionShim.ts'));
    assert.throws(() => shim.InlineCompletionShim.createAndActivate({ subscriptions: [] }), /already exists/);
    assert.equal(f.registrations.length, 1);
    assert.equal(f.registrations[0].disposed, true);
    assert.equal(f.events[0].disposed, true);
    assert.equal(f.commands.has('gcmp.nesCompletion.toggleManual'), true);
});

test('entry propagates registration failure and closes its local log channel', async () => {
    const f = fixture();
    f.connect();
    f.commands.add('gcmp.nesCompletion.toggleManual');
    const entry = f.load<Entry>(resolve(child, 'src/extension.ts'));
    await assert.rejects(entry.activate({ subscriptions: [] }), /already exists/);
    assert.equal(f.registrations[0].disposed, true);
    assert.equal(f.channels[0].disposed, true);
    assert.equal(f.callbacks.length, 0);
    assert.equal(f.schemas[0].disposed, true);
    assert.equal(f.configListeners.size, 0);
    assert.equal(
        f.events.every(event => event.disposed),
        true
    );
});

test('normal entry publishes exports before notification and disposes local resources', async () => {
    const f = fixture();
    Object.assign(f.services, { StatusBarManager: {} });
    f.connect();
    const entry = f.load<Entry>(resolve(child, 'src/extension.ts'));
    const context: ActivationContext = { subscriptions: [] };
    const exports = await entry.activate(context);
    assert.equal(context.subscriptions.at(-1), f.channels[0]);
    assert.equal(context.subscriptions.at(-1), f.bridge.completionLogger);
    assert.equal(typeof exports.acceptCompletionServices, 'function');
    assert.equal(f.bridge.isGcmpServicesAvailable(), false);
    assert.equal(f.callbacks.length, 1);
    f.callbacks[0]();
    assert.equal(f.bridge.isGcmpServicesAvailable(), true);
    for (const disposable of context.subscriptions) {
        disposable.dispose();
    }
    assert.equal(f.registrations[0].disposed, true);
    assert.equal(f.channels[0].disposed, true);
    assert.equal(f.commands.size, 0);
    assert.equal(f.schemas[0].disposed, true);
    assert.equal(f.configListeners.size, 0);
    assert.equal(
        f.events.every(event => event.disposed),
        true
    );
});

test('entry releases a loaded provider and its event forwarding before closing the log', async () => {
    const f = fixture();
    f.connect();
    let activated = false;
    let providerDisposed = false;
    let forwardingDisposed = false;
    class LoadedProvider {
        onDidChange = () => ({
            dispose: () => {
                forwardingDisposed = true;
            }
        });
        activate(): void {
            activated = true;
        }
        dispose(): void {
            assert.equal(f.channels[0].disposed, false);
            f.bridge.completionLogger.trace('Loaded provider cleanup');
            providerDisposed = true;
        }
    }
    const shimPath = resolve(child, 'src/copilot/inlineCompletionShim.ts');
    f.load<ShimExports>(shimPath, id =>
        id === '../dist/copilot.bundle.js' ?
            { InlineCompletionProvider: LoadedProvider }
        :   f.load(resolve(dirname(shimPath), `${id}.ts`))
    );
    const context: ActivationContext = { subscriptions: [] };
    await f.load<Entry>(resolve(child, 'src/extension.ts')).activate(context);
    f.callbacks[0]();
    const provider = context.subscriptions.find(resource => 'loadRealProvider' in resource) as
        | { loadRealProvider(): Promise<vscodeApi.Disposable | null> }
        | undefined;
    assert.ok(provider);
    assert.ok(await provider.loadRealProvider());
    assert.equal(activated, true);
    assert.equal(providerDisposed, false);
    assert.equal(forwardingDisposed, false);
    for (const resource of context.subscriptions) {
        resource.dispose();
    }
    assert.equal(providerDisposed, true);
    assert.equal(forwardingDisposed, true);
    assert.equal(f.registrations[0].disposed, true);
    assert.equal(f.commands.size, 0);
    assert.equal(f.schemas[0].disposed, true);
    assert.equal(f.configListeners.size, 0);
    assert.ok(f.events.every(event => event.disposed));
    assert.equal(f.channels[0].disposed, true);
});

for (const currentState of [false, true]) {
    for (const stopped of [false, true]) {
        for (const rejected of [false, true]) {
            test(`NES mode command preserves update outcomes without late effects (manual=${currentState}, stopped=${stopped}, rejected=${rejected})`, async () => {
                const f = fixture();
                f.connect();
                let resolveUpdate!: () => void;
                let rejectUpdate!: (error: Error) => void;
                const update = new Promise<void>((resolve, reject) => {
                    resolveUpdate = resolve;
                    rejectUpdate = reject;
                });
                const updates: Array<{ key: string; value: boolean; target: number }> = [];
                f.vscode.workspace.getConfiguration = () => ({
                    get: () => currentState,
                    update: (key: string, value: boolean, target: number) => {
                        updates.push({ key, value, target });
                        return update;
                    }
                });
                const context: ActivationContext = { subscriptions: [] };
                await f.load<Entry>(resolve(child, 'src/extension.ts')).activate(context);
                const command = f.commandCallbacks.get('gcmp.nesCompletion.toggleManual');
                assert.ok(command);
                const observed = command().then(
                    value => ({ value, error: null }),
                    (error: unknown) => ({ value: undefined, error })
                );
                try {
                    assert.deepEqual(updates, [
                        { key: 'manualOnly', value: !currentState, target: f.vscode.ConfigurationTarget.Global }
                    ]);
                    assert.equal(f.notifications.length, 0);
                    if (stopped) {
                        context.subscriptions.splice(0).forEach(resource => resource.dispose());
                        assert.equal(f.channels[0].disposed, true);
                        assert.equal(f.commands.size, 0);
                        assert.equal(f.commandCallbacks.size, 0);
                    }
                    const failure = new Error('Settings update rejected');
                    if (rejected) {
                        rejectUpdate(failure);
                    } else {
                        resolveUpdate();
                    }
                    const outcome = await observed;
                    assert.equal(outcome.error, rejected ? failure : null);
                    assert.equal(outcome.value, undefined);
                    const successful = !stopped && !rejected;
                    assert.deepEqual(
                        f.notifications,
                        successful ?
                            [`GCMP: Next code edit suggestion mode: ${currentState ? 'Automatic' : 'Manual'} trigger`]
                        :   []
                    );
                    assert.deepEqual(
                        f.logMessages.filter(message => message.startsWith('[InlineCompletionShim] NES manual')),
                        successful ?
                            [`[InlineCompletionShim] NES manual trigger mode ${currentState ? 'disabled' : 'enabled'}`]
                        :   []
                    );
                    assert.equal(updates.length, 1);
                } finally {
                    resolveUpdate();
                    await observed;
                    context.subscriptions.splice(0).forEach(resource => resource.dispose());
                }
            });
        }
    }
}

test('child schema keeps provider suggestions and refreshes after verified injection', async () => {
    const f = fixture();
    f.connect();
    const entry = f.load<Entry>(resolve(child, 'src/extension.ts'));
    const context: ActivationContext = { subscriptions: [] };
    const exports = await entry.activate(context);
    const provider = f.schemas[0].provider;
    const uri = f.vscode.Uri.parse('gcmp-fim-settings://root/schema.json') as vscodeApi.Uri;
    try {
        const before = JSON.parse(Buffer.from(await provider.readFile(uri)).toString()) as CompletionSchema;
        assert.equal(before.properties['gcmp.fimCompletion.modelConfig'].properties.provider.enum, undefined);
        const oldStat = await provider.stat(uri);
        exports.acceptCompletionServices(f.services);
        const raw = await provider.readFile(uri);
        const schema = JSON.parse(Buffer.from(raw).toString()) as CompletionSchema;
        assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
        assert.deepEqual(Object.keys(schema.properties).sort(), [
            'gcmp.fimCompletion.modelConfig',
            'gcmp.nesCompletion.modelConfig'
        ]);
        for (const mode of ['fim', 'nes']) {
            const model = schema.properties[`gcmp.${mode}Completion.modelConfig`];
            assert.equal(model.additionalProperties, true);
            assert.equal(model.properties.provider.type, 'string');
            assert.deepEqual(model.properties.provider.enum, ['review']);
            assert.deepEqual(model.properties.provider.enumDescriptions, ['Review']);
        }
        const currentStat = await provider.stat(uri);
        assert.ok(currentStat.mtime > oldStat.mtime);
        assert.equal(currentStat.size, raw.byteLength);
        assert.equal(f.events[0].fired.length, 1);
    } finally {
        context.subscriptions.forEach(resource => resource.dispose());
    }
});

test('child schema rereads changed shared provider metadata and ignores unrelated settings', async () => {
    const f = fixture();
    f.connect();
    const context: ActivationContext = { subscriptions: [] };
    const exports = await f.load<Entry>(resolve(child, 'src/extension.ts')).activate(context);
    const provider = f.schemas[0].provider;
    const uri = f.vscode.Uri.parse('gcmp-fim-settings://root/schema.json') as vscodeApi.Uri;
    try {
        exports.acceptCompletionServices(f.services);
        const count = f.events[0].fired.length;
        f.configListeners.forEach(listener => listener({ affectsConfiguration: () => false }));
        assert.equal(f.events[0].fired.length, count);
        const oldStat = await provider.stat(uri);
        f.services.getAvailableProviders = () => ({ providerIds: ['custom'], enumDescriptions: ['Custom provider'] });
        f.configListeners.forEach(listener => listener({ affectsConfiguration: section => section === 'gcmp' }));
        const schema = JSON.parse(Buffer.from(await provider.readFile(uri)).toString()) as CompletionSchema;
        assert.deepEqual(schema.properties['gcmp.nesCompletion.modelConfig'].properties.provider.enum, ['custom']);
        assert.deepEqual(schema.properties['gcmp.fimCompletion.modelConfig'].properties.provider.enumDescriptions, [
            'Custom provider'
        ]);
        assert.ok((await provider.stat(uri)).mtime > oldStat.mtime);
        assert.equal(f.events[0].fired.length, count + 1);
        context.subscriptions.splice(0).forEach(resource => resource.dispose());
        const disposedCount = f.events[0].fired.length;
        exports.acceptCompletionServices(f.services);
        assert.equal(f.events[0].fired.length, disposedCount);
        assert.equal(f.configListeners.size, 0);
    } finally {
        context.subscriptions.splice(0).forEach(resource => resource.dispose());
    }
});

test('child schema rejects foreign URIs and all write operations', async () => {
    const f = fixture();
    f.connect();
    const context: ActivationContext = { subscriptions: [] };
    await f.load<Entry>(resolve(child, 'src/extension.ts')).activate(context);
    const provider = f.schemas[0].provider;
    const uri = f.vscode.Uri.parse('gcmp-fim-settings://root/schema.json') as vscodeApi.Uri;
    try {
        for (const value of [
            'gcmp-settings://root/schema.json',
            'gcmp-fim-settings://other/schema.json',
            'gcmp-fim-settings://root/other.json'
        ]) {
            const other = f.vscode.Uri.parse(value) as vscodeApi.Uri;
            assert.throws(() => provider.readFile(other), /not found/);
            assert.throws(() => provider.stat(other), /not found/);
        }
        assert.throws(() => provider.createDirectory(uri), /Read only/);
        assert.throws(() => provider.writeFile(uri, Buffer.alloc(0), { create: true, overwrite: true }), /Read only/);
        assert.throws(() => provider.delete(uri, { recursive: false }), /Read only/);
        assert.throws(() => provider.rename(uri, uri, { overwrite: true }), /Read only/);
        assert.equal(
            JSON.stringify(
                await provider.readDirectory(f.vscode.Uri.parse('gcmp-fim-settings://root/') as vscodeApi.Uri)
            ),
            JSON.stringify([['schema.json', 1]])
        );
        provider.watch(uri, { recursive: false, excludes: [] }).dispose();
    } finally {
        context.subscriptions.forEach(resource => resource.dispose());
    }
});

test('schema registration failure releases the emitter and log before registering a shim', async () => {
    const f = fixture();
    f.connect();
    f.vscode.workspace.registerFileSystemProvider = () => {
        throw new Error('schema registration failed');
    };
    const entry = f.load<Entry>(resolve(child, 'src/extension.ts'));
    await assert.rejects(entry.activate({ subscriptions: [] }), /schema registration failed/);
    assert.equal(f.events[0].disposed, true);
    assert.equal(f.channels[0].disposed, true);
    assert.equal(f.registrations.length, 0);
    assert.equal(f.configListeners.size, 0);
    assert.equal(f.callbacks.length, 0);
});

test('child manifest associates its independent schema with every original settings location', () => {
    const manifest = JSON.parse(readFileSync(resolve(child, 'package.json'), 'utf8')) as {
        activationEvents: string[];
        contributes: { jsonValidation: Array<{ url: string; fileMatch: string[] }> };
    };
    const main = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as typeof manifest;
    assert.equal(manifest.contributes.jsonValidation[0].url, 'gcmp-fim-settings://root/schema.json');
    assert.deepEqual(manifest.contributes.jsonValidation[0].fileMatch, main.contributes.jsonValidation[0].fileMatch);
    assert.ok(manifest.activationEvents.includes('onFileSystem:gcmp-fim-settings'));
});

for (const suffix of ['/completions', '/chat/completions']) {
    test(`real Fetcher uses only the minimal bridge (${suffix})`, async () => {
        const f = fixture();
        f.connect();
        f.bridge.acceptCompletionServices(f.services);
        class ChatResponse {
            constructor(
                readonly status: number,
                readonly statusText: string,
                readonly headers: object,
                readonly body: ReadableStream<Uint8Array>
            ) {}
        }
        const runtime = f.load<{
            Fetcher: new () => {
                fetch(url: string, options: object): Promise<ChatResponse>;
            };
        }>(resolve(child, 'src/copilot/fetcher.ts'), id => {
            if (id === '../gcmpServices') {
                return f.bridge;
            }
            if (id === '../utils/completionConfig') {
                return f.load<ConfigReaders>(resolve(child, 'src/utils/completionConfig.ts'));
            }
            if (id === '../utils/versionManager') {
                return { VersionManager: { getUserAgent: () => 'test' } };
            }
            if (id.startsWith('@vscode/chat-lib/')) {
                return { Response: ChatResponse, HeadersImpl: { fromMap: (headers: Map<string, string>) => headers } };
            }
            throw new Error(`Unexpected import: ${id}`);
        });
        const response = await new runtime.Fetcher().fetch(`https://example.invalid${suffix}`, {
            method: 'POST',
            json: { prompt: 'test', messages: [{ role: 'system', content: 'test' }] }
        });
        assert.equal(response.status, 200);
        assert.equal(f.requests.length, 1);
        assert.equal(f.requests[0].url, `https://example.invalid${suffix}`);
        assert.equal(new Headers(f.requests[0].init?.headers).get('Authorization'), 'Bearer synthetic-test-key');
        assert.equal(await new Response(response.body).text(), 'data: [DONE]\n\n');
    });
}
