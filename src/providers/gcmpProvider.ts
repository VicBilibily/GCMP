import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation, PrepareLanguageModelChatModelOptions } from 'vscode';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager, GCMPProviderConfigManager, Logger, ModelInfoCache } from '../utils';
import { GenericModelProvider } from './genericModelProvider';

export class GCMPProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'gcmp';
    private configChangeListener?: vscode.Disposable;

    constructor(context: vscode.ExtensionContext) {
        const virtualConfig: ProviderConfig = GCMPProviderConfigManager.getVirtualProviderConfig();
        super(context, GCMPProvider.PROVIDER_KEY, virtualConfig);

        this.cachedProviderConfig = GCMPProviderConfigManager.getVirtualProviderConfig();
        this.baseProviderConfig = this.cachedProviderConfig;
        this.configChangeListener = GCMPProviderConfigManager.onDidChange(() => {
            this.cachedProviderConfig = GCMPProviderConfigManager.getVirtualProviderConfig();
            this.baseProviderConfig = this.cachedProviderConfig;

            this.modelInfoCache
                ?.invalidateCache(GCMPProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[gcmp] 清除缓存失败:', err));

            this._onDidChangeLanguageModelChatInformation.fire();
        });
    }

    override dispose(): void {
        this.configChangeListener?.dispose();
        super.dispose();
    }

    override async provideLanguageModelChatInformation(
        _options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const apiKeyHash = await this.getApiKeyHash();
        const cachedModels = await this.modelInfoCache?.getCachedModels(GCMPProvider.PROVIDER_KEY, apiKeyHash);
        if (cachedModels) {
            return cachedModels;
        }

        const models = this.providerConfig.models.map(model => this.toModelInfo(model));
        this.updateModelCacheAsync(apiKeyHash);
        return models;
    }

    protected override updateModelCacheAsync(apiKeyHash: string): void {
        (async () => {
            try {
                const models = this.providerConfig.models.map(model => this.toModelInfo(model));
                await this.modelInfoCache?.cacheModels(GCMPProvider.PROVIDER_KEY, models, apiKeyHash);
            } catch (error) {
                Logger.trace('[gcmp] 后台缓存更新失败:', error instanceof Error ? error.message : String(error));
            }
        })();
    }

    protected override async getApiKeyHash(): Promise<string> {
        try {
            const providerIds = new Set(this.providerConfig.models.map(model => model.provider).filter(Boolean));
            const apiKeys: string[] = [];

            for (const providerId of providerIds) {
                const apiKey = await ApiKeyManager.getApiKey(providerId!);
                if (apiKey) {
                    apiKeys.push(`${providerId}:${apiKey}`);
                }
            }

            if (apiKeys.length === 0) {
                return 'no-key';
            }

            return await ModelInfoCache.computeApiKeyHash(apiKeys.sort().join('|'));
        } catch (error) {
            Logger.warn('[gcmp] 计算 API 密钥哈希失败:', error);
            return 'hash-error';
        }
    }

    private toModelInfo(model: ModelConfig): LanguageModelChatInformation {
        const info = this.modelConfigToInfo(model);
        return {
            ...info,
            detail: GCMPProviderConfigManager.getProviderDisplayName(model.provider || GCMPProvider.PROVIDER_KEY)
        };
    }

    static createAndActivate(context: vscode.ExtensionContext): {
        provider: GCMPProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('GCMP 实验统一 Provider 已激活');
        const provider = new GCMPProvider(context);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp', provider);
        const disposables = [providerDisposable];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
}
