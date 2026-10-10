import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { CancellationToken, ExtensionContext, LanguageModelChatInformation } from 'vscode';
import type { CompatibleModelConfig, CompatibleModelManager } from '../utils/config/compatibleModelManager';
import type { ModelInfoCache } from '../utils/model/modelInfoCache';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import type { CompatibleProvider } from './compatibleProvider';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('provider configuration wizards refresh BYOK model information', async () => {
    const commands = new Map<string, () => Promise<void>>();
    const refreshes: Array<{ provider: string; slot: string | undefined }> = [];
    const wizardRuns: string[] = [];
    const keys = new Map<string, string>();

    class FakeGenericModelProvider {
        protected readonly providerKey: string;
        protected readonly providerConfig: { displayName: string };
        protected readonly modelInfoCache = {
            invalidateCache: async (_slot: string): Promise<void> => undefined
        };
        protected readonly _onDidChangeLanguageModelChatInformation = { fire: (): void => undefined };

        constructor(_context: unknown, providerKey: string, providerConfig: { displayName: string }) {
            this.providerKey = providerKey;
            this.providerConfig = providerConfig;
        }

        invalidateAndNotify(slot?: string): void {
            refreshes.push({ provider: this.providerKey, slot });
        }
    }

    const wizard = (name: string): Record<string, (...args: unknown[]) => Promise<void>> =>
        new Proxy(
            {},
            {
                get: (_target, property) => async () => {
                    if (property === 'startWizard') {
                        wizardRuns.push(name);
                    }
                }
            }
        ) as Record<string, (...args: unknown[]) => Promise<void>>;

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                commands: {
                    registerCommand: (command: string, callback: () => Promise<void>) => {
                        commands.set(command, callback);
                        return { dispose: (): void => undefined };
                    },
                    executeCommand: async (): Promise<void> => undefined
                },
                lm: {
                    registerLanguageModelChatProvider: () => ({ dispose: (): void => undefined })
                }
            };
        }
        if (/genericModelProvider(?:\.ts)?$/.test(id)) {
            return { GenericModelProvider: FakeGenericModelProvider };
        }
        if (/minimaxWizard(?:\.ts)?$/.test(id)) {
            return { MiniMaxWizard: wizard('minimax') };
        }
        if (/moonshotWizard(?:\.ts)?$/.test(id)) {
            return { MoonshotWizard: wizard('moonshot') };
        }
        if (/stepfunWizard(?:\.ts)?$/.test(id)) {
            return { StepFunWizard: wizard('stepfun') };
        }
        if (/zhipuWizard(?:\.ts)?$/.test(id)) {
            return { ZhipuWizard: wizard('zhipu') };
        }
        if (/apiKeyManager(?:\.ts)?$/.test(id)) {
            return {
                ApiKeyManager: {
                    hasValidApiKey: async (provider: string) => keys.has(provider),
                    getApiKey: async (provider: string) => keys.get(provider),
                    setApiKey: async (provider: string, key: string) => {
                        keys.set(provider, key);
                    },
                    deleteApiKey: async (provider: string) => {
                        keys.delete(provider);
                    },
                    promptAndSetApiKey: async (): Promise<void> => undefined
                }
            };
        }
        if (/configManager(?:\.ts)?$/.test(id)) {
            return { ConfigManager: {} };
        }
        if (/cancellationError(?:\.ts)?$/.test(id)) {
            return { isCancellationError: () => false };
        }
        if (/retryManager(?:\.ts)?$/.test(id)) {
            return { RetryableError: class RetryableError extends Error {} };
        }
        if (/(?:^|\/)status(?:BarManager)?(?:\.ts)?$/.test(id)) {
            return { StatusBarManager: {} };
        }
        if (/(?:^|\/)logger(?:\.ts)?$/.test(id)) {
            return {
                Logger: { trace: (): void => undefined, info: (): void => undefined, warn: (): void => undefined }
            };
        }
        return originalRequire.call(this, id);
    };

    try {
        const [{ MiniMaxProvider }, { MoonshotProvider }, { StepFunProvider }, { ZhipuProvider }] = await Promise.all([
            import('./minimaxProvider'),
            import('./moonshotProvider'),
            import('./stepfunProvider'),
            import('./zhipuProvider')
        ]);
        const context = { subscriptions: [] as Array<{ dispose(): void }> };
        const config = {
            displayName: 'Test',
            baseUrl: 'https://example.com',
            apiKeyTemplate: 'test',
            codingKeyTemplate: 'test',
            models: []
        };

        MiniMaxProvider.createAndActivate(context as never, 'minimax', config);
        MoonshotProvider.createAndActivate(context as never, 'moonshot', config);
        StepFunProvider.createAndActivate(context as never, 'stepfun', config);
        ZhipuProvider.createAndActivate(context as never, 'zhipu', config);

        for (const provider of ['minimax', 'moonshot', 'stepfun', 'zhipu']) {
            const command = commands.get(`gcmp.${provider}.configWizard`);
            assert.ok(command, `${provider} config wizard command should be registered`);
            await command();
        }

        assert.deepEqual(wizardRuns, ['minimax', 'moonshot', 'stepfun', 'zhipu']);
        assert.deepEqual(refreshes, [
            { provider: 'minimax', slot: undefined },
            { provider: 'moonshot', slot: undefined },
            { provider: 'stepfun', slot: undefined },
            { provider: 'zhipu', slot: undefined }
        ]);

        refreshes.length = 0;
        keys.set('minimax-coding', 'legacy-key');
        MiniMaxProvider.createAndActivate(context as never, 'minimax-migration', config);
        await new Promise<void>(resolve => setImmediate(resolve));

        assert.equal(keys.get('minimax-token'), 'legacy-key');
        assert.equal(keys.has('minimax-coding'), false);
        assert.deepEqual(refreshes, [{ provider: 'minimax-migration', slot: 'minimax-token' }]);
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

function compatibleWizardFixture(initialModels: CompatibleModelConfig[]) {
    class FixtureEventEmitter<T> {
        private readonly listeners = new Set<(value: T) => void>();
        readonly event = (listener: (value: T) => void) => {
            this.listeners.add(listener);
            return { dispose: () => this.listeners.delete(listener) };
        };
        fire(value: T): void {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
        dispose(): void {
            this.listeners.clear();
        }
    }

    const configEvents = new FixtureEventEmitter<{ affectsConfiguration(name: string): boolean }>();
    const settings = new Map<string, unknown>([['compatibleModels', structuredClone(initialModels)]]);
    const errors: unknown[][] = [];
    const noop = (): void => undefined;
    const logs = { trace: noop, debug: noop, info: noop, warn: noop, error: (...args: unknown[]) => errors.push(args) };
    const vscode = {
        EventEmitter: FixtureEventEmitter,
        ConfigurationTarget: { Global: 1 },
        workspace: {
            onDidChangeConfiguration: configEvents.event,
            getConfiguration: () => ({
                get: (key: string, fallback?: unknown) =>
                    settings.has(key) ? structuredClone(settings.get(key)) : fallback,
                update: async (key: string, value: unknown) => {
                    settings.set(key, structuredClone(value));
                    configEvents.fire({ affectsConfiguration: name => name === `gcmp.${key}` });
                }
            })
        }
    };
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const sourceFiles = new Set([
        'providers/compatibleProvider.ts',
        'providers/genericModelProvider.ts',
        'utils/config/compatibleModelManager.ts',
        'utils/model/modelInfoCache.ts',
        'utils/model/languageModelInfo.ts',
        'utils/model/compatibleServiceTier.ts'
    ]);
    const modules = new Map<string, { exports: unknown }>();
    const handlerNames: Record<string, string> = {
        openaiHandler: 'OpenAIHandler',
        openaiCustomHandler: 'OpenAICustomHandler',
        openaiResponsesHandler: 'OpenAIResponsesHandler',
        anthropicHandler: 'AnthropicHandler',
        geminiHandler: 'GeminiHandler'
    };
    const dependencies: Record<string, unknown> = {
        logger: { Logger: logs },
        l10n: { t: (_english: string, chinese: string) => chinese },
        config: { configProviders: { codex: { displayName: 'Codex', models: [] } } },
        configManager: {
            ConfigManager: {
                getProviderOverrides: () => ({}),
                applyProviderOverrides: (_key: string, config: ProviderConfig) => config
            }
        },
        apiKeyManager: { ApiKeyManager: { getApiKey: async () => undefined } },
        knownProviders: { KnownProviders: {} },
        metadataResolver: { withCodexCliMetadata: (config: ProviderConfig) => config },
        httpHeaders: { mergeCustomHeaders: () => ({}) },
        cliUserAgent: { fillCodexRequestHeaders: noop, fillClaudeCodeRequestHeaders: noop },
        proxyAgent: { sanitizeConfigForLogging: (value: unknown) => value },
        status: { StatusBarManager: {} }
    };
    function load<T>(file: string): T {
        const cached = modules.get(file);
        if (cached) {
            return cached.exports as T;
        }
        const filename = resolve(sourceRoot, file);
        const module: { exports: unknown } = { exports: {} };
        modules.set(file, module);
        const code = transformSync(readFileSync(filename, 'utf8'), {
            loader: 'ts',
            format: 'cjs',
            target: 'es2022'
        }).code;
        runInNewContext(
            code,
            {
                module,
                exports: module.exports,
                require: (id: string): unknown => {
                    if (id === 'vscode') {
                        return vscode;
                    }
                    if (id.startsWith('node:')) {
                        return require(id);
                    }
                    const source = relative(sourceRoot, resolve(dirname(filename), `${id}.ts`))
                        .split(sep)
                        .join('/');
                    if (sourceFiles.has(source)) {
                        return load<unknown>(source);
                    }
                    const name = basename(id);
                    if (handlerNames[name]) {
                        return { [handlerNames[name]]: class {} };
                    }
                    return dependencies[name] ?? {};
                },
                setTimeout,
                setImmediate
            },
            { filename }
        );
        return module.exports as T;
    }

    const { CompatibleModelManager: manager } = load<{ CompatibleModelManager: typeof CompatibleModelManager }>(
        'utils/config/compatibleModelManager.ts'
    );
    manager.initialize();
    const { CompatibleProvider: Provider } = load<{ CompatibleProvider: typeof CompatibleProvider }>(
        'providers/compatibleProvider.ts'
    );
    const { ModelInfoCache: Cache } = load<{ ModelInfoCache: typeof ModelInfoCache }>('utils/model/modelInfoCache.ts');
    const cache = new Cache(context);
    const provider = new Provider(context);
    const token = { isCancellationRequested: false } as CancellationToken;
    const convert = Reflect.get(provider, 'modelConfigToInfo') as (model: ModelConfig) => LanguageModelChatInformation;
    let builds = 0;
    Reflect.set(provider, 'modelConfigToInfo', (model: ModelConfig) => {
        builds++;
        return convert.call(provider, model);
    });
    return { provider, manager, cache, token, errors, getBuildCount: () => builds };
}

const compatibleWizardModel = (id: string, name: string, maxInputTokens = 1000): CompatibleModelConfig => ({
    id,
    name,
    provider: 'fixture',
    sdkMode: 'openai',
    maxInputTokens,
    maxOutputTokens: 100,
    capabilities: { toolCalling: true, imageInput: false }
});

const compatibleWizardScenarios: Array<{
    name: string;
    initial: CompatibleModelConfig[];
    expected: CompatibleModelConfig[];
    change(manager: typeof CompatibleModelManager): Promise<void>;
}> = [
    {
        name: 'edits',
        initial: [compatibleWizardModel('a', 'Before')],
        expected: [compatibleWizardModel('a', 'After', 2000)],
        change: manager => manager.updateModel('a', { name: 'After', maxInputTokens: 2000 })
    },
    {
        name: 'additions',
        initial: [compatibleWizardModel('a', 'Before')],
        expected: [compatibleWizardModel('a', 'Before'), compatibleWizardModel('b', 'Added')],
        change: manager => manager.addModel(compatibleWizardModel('b', 'Added'))
    },
    {
        name: 'removal of the last model',
        initial: [compatibleWizardModel('a', 'Before')],
        expected: [],
        change: manager => manager.removeModel('a')
    }
];

for (const scenario of compatibleWizardScenarios) {
    test(`compatible wizard ${scenario.name} return and cache the latest model list`, async () => {
        const f = compatibleWizardFixture(scenario.initial);
        const describe = (models: LanguageModelChatInformation[]) =>
            Array.from(models, model => ({ id: model.id, name: model.name, maxInputTokens: model.maxInputTokens }));
        const expected = (models: CompatibleModelConfig[]) =>
            models.map(model => ({
                id: `gcmp.${model.provider}:::${model.id}`,
                name: model.name,
                maxInputTokens: model.maxInputTokens
            }));

        try {
            const initial = await f.provider.provideLanguageModelChatInformation({ silent: true }, f.token);
            assert.deepEqual(describe(initial), expected(scenario.initial));
            assert.equal(f.getBuildCount(), scenario.initial.length);
            let notifications = 0;
            f.provider.onDidChangeLanguageModelChatInformation(() => notifications++);
            f.manager.configureModelOrUpdateAPIKey = async () => {
                await scenario.change(f.manager);
                assert.ok(notifications > 0);
                assert.equal(await f.cache.getCachedModels('compatible', 'no-key'), null);
            };
            const buildsBefore = f.getBuildCount();
            const updated = await f.provider.provideLanguageModelChatInformation({ silent: false }, f.token);
            const next = await f.provider.provideLanguageModelChatInformation({ silent: true }, f.token);
            const again = await f.provider.provideLanguageModelChatInformation({ silent: true }, f.token);
            assert.deepEqual(f.errors, []);
            assert.deepEqual(describe(updated), expected(scenario.expected));
            assert.deepEqual(describe(next), expected(scenario.expected));
            assert.deepEqual(describe(again), expected(scenario.expected));
            assert.strictEqual(next, updated);
            assert.strictEqual(again, updated);
            assert.equal(f.getBuildCount() - buildsBefore, scenario.expected.length);
        } finally {
            f.provider.dispose();
            f.manager.dispose();
            await f.cache.clearAll();
        }
    });
}
