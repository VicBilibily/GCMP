import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

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
