import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    PrepareLanguageModelChatModelOptions
} from 'vscode';
import { CliModelProvider } from '../cli/cliModelProvider';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager, ConfigManager, Logger } from '../utils';
import { parseCodexModelsResponse } from './codexModels';

const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const CACHE_KEY = 'gcmp_codex_models_v1';
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000;

interface CachedCodexModels {
    extensionVersion: string;
    apiKeyHash: string;
    timestamp: number;
    models: ModelConfig[];
}

export class CodexModelProvider extends CliModelProvider {
    private readonly context: vscode.ExtensionContext;
    private readonly staticProviderConfig: ProviderConfig;
    private readonly codexConfigListener: vscode.Disposable;
    private refreshPromise?: Promise<ModelConfig[]>;

    constructor(context: vscode.ExtensionContext, providerConfig: ProviderConfig) {
        super(context, 'codex', providerConfig);
        this.context = context;
        this.staticProviderConfig = providerConfig;
        this.codexConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gcmp.providerOverrides')) {
                void this.context.globalState.update(CACHE_KEY, undefined);
            }
        });
        context.subscriptions.push(this.codexConfigListener);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerConfig: ProviderConfig
    ): { provider: CodexModelProvider; disposables: vscode.Disposable[] } {
        const provider = new CodexModelProvider(context, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.codex', provider);
        const setApiKeyCommand = vscode.commands.registerCommand('gcmp.codex.setApiKey', async () => {
            await ApiKeyManager.promptAndSetApiKey('codex', providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.invalidateModelCaches();
            provider._onDidChangeLanguageModelChatInformation.fire();
        });
        const configWizardCommand = vscode.commands.registerCommand('gcmp.codex.configWizard', async () => {
            await CodexModelProvider.startConfigWizard('codex', providerConfig.displayName);
            await provider.invalidateModelCaches();
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const initialModels = await super.provideLanguageModelChatInformation(options, token);
        if (options.configuration || initialModels.length === 0 || token.isCancellationRequested) {
            return initialModels;
        }

        try {
            const models = await this.waitForDynamicModels(token);
            const previousModels = this.providerConfig.models;
            this.applyModels(models);
            const modelsChanged = this.haveModelsChanged(previousModels, this.providerConfig.models);
            const apiKeyHash = await this.getApiKeyHash();
            const infos = this.providerConfig.models.map(model => this.modelConfigToInfo(model));
            await this.modelInfoCache?.cacheModels(this.providerKey, infos, apiKeyHash);
            if (modelsChanged) {
                queueMicrotask(() => this._onDidChangeLanguageModelChatInformation.fire());
            }
            return infos;
        } catch (error) {
            if (token.isCancellationRequested) {
                return initialModels;
            }
            const previousModels = this.providerConfig.models;
            this.applyModels(this.staticProviderConfig.models);
            const modelsChanged = this.haveModelsChanged(previousModels, this.providerConfig.models);
            Logger.warn(
                '[codex] Failed to refresh remote model list; using bundled models:',
                error instanceof Error ? error.message : String(error)
            );
            const infos = this.providerConfig.models.map(model => this.modelConfigToInfo(model));
            const apiKeyHash = await this.getApiKeyHash();
            await this.modelInfoCache?.cacheModels(this.providerKey, infos, apiKeyHash);
            if (modelsChanged) {
                queueMicrotask(() => this._onDidChangeLanguageModelChatInformation.fire());
            }
            return infos;
        }
    }

    private waitForDynamicModels(token: CancellationToken): Promise<ModelConfig[]> {
        if (token.isCancellationRequested) {
            return Promise.reject(new vscode.CancellationError());
        }

        const refresh = this.getDynamicModels();
        return new Promise<ModelConfig[]>((resolve, reject) => {
            const cancellation = token.onCancellationRequested(() => {
                cancellation.dispose();
                reject(new vscode.CancellationError());
            });
            refresh.then(
                models => {
                    cancellation.dispose();
                    resolve(models);
                },
                error => {
                    cancellation.dispose();
                    reject(error);
                }
            );
        });
    }

    private getDynamicModels(): Promise<ModelConfig[]> {
        if (!this.refreshPromise) {
            this.refreshPromise = this.refreshModels().finally(() => {
                this.refreshPromise = undefined;
            });
        }
        return this.refreshPromise;
    }

    private async refreshModels(): Promise<ModelConfig[]> {
        const credentials = await CliAuthFactory.ensureAuthenticated('codex');
        const accessToken = credentials?.access_token ?? (await ApiKeyManager.getApiKey('codex'));
        if (!accessToken) {
            throw new Error('Codex access token is unavailable');
        }
        await ApiKeyManager.setApiKey('codex', accessToken);

        const apiKeyHash = await this.getApiKeyHash();
        const cached = this.getCachedModelConfigs(apiKeyHash);
        if (cached) {
            return cached;
        }

        const accountId = await CliAuthFactory.getCodexAccountId();
        if (!accountId) {
            throw new Error('ChatGPT account ID is unavailable; run Codex CLI login again');
        }

        const modelsUrl = new URL(CODEX_MODELS_URL);
        const clientVersion = this.providerConfig.customHeader?.version;
        if (clientVersion) {
            modelsUrl.searchParams.set('client_version', clientVersion);
        }
        const headers: Record<string, string> = {
            Accept: 'application/json',
            ...this.providerConfig.customHeader,
            Authorization: `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId
        };
        const response = await ConfigManager.fetchWithProxy(
            modelsUrl,
            { method: 'GET', headers },
            { providerKey: 'codex' }
        );
        if (!response.ok) {
            throw new Error(`Codex models request failed with HTTP ${response.status}`);
        }

        const models = parseCodexModelsResponse(await response.json(), this.staticProviderConfig.models);
        if (models.length === 0) {
            throw new Error('Codex models response contains no selectable models');
        }

        await this.context.globalState.update(CACHE_KEY, {
            extensionVersion: this.extensionVersion,
            apiKeyHash,
            timestamp: Date.now(),
            models
        } satisfies CachedCodexModels);
        Logger.info(`[codex] Remote model list updated (${models.length} models)`);
        return models;
    }

    private getCachedModelConfigs(apiKeyHash: string): ModelConfig[] | undefined {
        if (this.context.extensionMode === vscode.ExtensionMode.Development) {
            return undefined;
        }
        const cached = this.context.globalState.get<CachedCodexModels>(CACHE_KEY);
        if (
            !cached ||
            cached.extensionVersion !== this.extensionVersion ||
            cached.apiKeyHash !== apiKeyHash ||
            Date.now() - cached.timestamp > CACHE_EXPIRY_MS ||
            !Array.isArray(cached.models) ||
            cached.models.length === 0
        ) {
            return undefined;
        }
        return cached.models;
    }

    private applyModels(models: ModelConfig[]): void {
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, {
            ...this.staticProviderConfig,
            models
        });
    }

    private haveModelsChanged(current: ModelConfig[], next: ModelConfig[]): boolean {
        if (current.length !== next.length) {
            return true;
        }
        return current.some((model, index) => JSON.stringify(model) !== JSON.stringify(next[index]));
    }

    private async invalidateModelCaches(): Promise<void> {
        await Promise.all([
            this.modelInfoCache?.invalidateCache(this.providerKey),
            this.context.globalState.update(CACHE_KEY, undefined)
        ]);
        this.applyModels(this.staticProviderConfig.models);
    }

    private get extensionVersion(): string {
        return vscode.extensions.getExtension('vicanent.gcmp')?.packageJSON.version ?? '';
    }
}
