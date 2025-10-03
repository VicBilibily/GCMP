import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation, Progress, ProvideLanguageModelChatResponseOptions, LanguageModelChatMessage, LanguageModelResponsePart } from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager } from '../utils';
import { GenericModelProvider } from './genericModelProvider';
import { UCloudApiClient } from '../utils/ucloudApiClient';

export class UCloudDynamicProvider {
    private readonly genericProvider: GenericModelProvider;
    private readonly originalProviderConfig: ProviderConfig;
    private dynamicModels: ModelConfig[] = [];
    private lastModelFetch = 0;
    private readonly MODEL_CACHE_DURATION = 5 * 60 * 1000;

    constructor(providerKey: string, staticProviderConfig: ProviderConfig) {
        this.originalProviderConfig = staticProviderConfig;
        this.genericProvider = new GenericModelProvider(providerKey, staticProviderConfig);
        Logger.trace(`UCloud 动态提供商已初始化: ${staticProviderConfig.displayName}`);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        staticProviderConfig: ProviderConfig
    ): { provider: UCloudDynamicProvider; disposables: vscode.Disposable[] } {
        const provider = new UCloudDynamicProvider(providerKey, staticProviderConfig);

        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(providerKey, staticProviderConfig.displayName, staticProviderConfig.apiKeyTemplate);
        });

        const refreshModelsCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.refreshModels`, async () => {
            await provider.refreshModels();
            vscode.window.showInformationMessage('UCloud 模型列表已刷新');
        });

        const disposables: vscode.Disposable[] = [providerDisposable, setApiKeyCommand, refreshModelsCommand];
        return { provider, disposables };
    }

    private async getEffectiveModels(): Promise<ModelConfig[]> {
        const now = Date.now();
        if (now - this.lastModelFetch > this.MODEL_CACHE_DURATION) {
            try {
                this.dynamicModels = await UCloudApiClient.fetchModels();
                this.lastModelFetch = now;
                Logger.info(`已更新 UCloud 动态模型列表，共 ${this.dynamicModels.length} 个模型`);
            } catch (error) {
                Logger.warn('获取 UCloud 动态模型失败，使用静态模型列表:', error);
                if (this.dynamicModels.length === 0) {
                    this.dynamicModels = this.originalProviderConfig.models;
                }
            }
        }

        const allModels = [...this.dynamicModels];
        for (const staticModel of this.originalProviderConfig.models) {
            const isDuplicate = allModels.some(dynamicModel => dynamicModel.id === staticModel.id);
            if (!isDuplicate) allModels.push(staticModel);
        }
        return allModels;
    }

    private async createDynamicProviderConfig(): Promise<ProviderConfig> {
        const effectiveModels = await this.getEffectiveModels();
        return { ...this.originalProviderConfig, models: effectiveModels };
    }

    async provideLanguageModelChatInformation(options: { silent: boolean }, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
        // silent 模式下如果没有 API Key，直接跳过加载
        const hasApiKey = await ApiKeyManager.hasValidApiKey('ucloud');
        if (options.silent && !hasApiKey) {
            Logger.trace('UCloud silent 模式且未设置 API Key，跳过模型加载');
            return [];
        }
        const dynamicConfig = await this.createDynamicProviderConfig();
        const originalConfig = this.genericProvider.getProviderConfig();
        this.genericProvider.updateProviderConfig(dynamicConfig);
        const result = await this.genericProvider.provideLanguageModelChatInformation(options, _token);
        this.genericProvider.updateProviderConfig(originalConfig);
        return result;
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        const originalConfig = this.genericProvider.getProviderConfig();
        try {
            const dynamicConfig = await this.createDynamicProviderConfig();
            this.genericProvider.updateProviderConfig(dynamicConfig);
            await this.genericProvider.provideLanguageModelChatResponse(model, messages, options, progress, token);
            this.genericProvider.updateProviderConfig(originalConfig);
        } catch (error) {
            this.genericProvider.updateProviderConfig(originalConfig);
            throw error;
        }
    }

    async provideTokenCount(model: LanguageModelChatInformation, text: string | vscode.LanguageModelChatMessage, token: CancellationToken): Promise<number> {
        return await this.genericProvider.provideTokenCount(model, text, token);
    }

    async refreshModels(): Promise<void> {
        Logger.info('手动刷新 UCloud 模型列表...');
        this.lastModelFetch = 0;
        UCloudApiClient.clearCache();
        await this.getEffectiveModels();
        Logger.info('UCloud 模型列表刷新完成');
    }

    dispose(): void {
        // nothing special
    }
}
