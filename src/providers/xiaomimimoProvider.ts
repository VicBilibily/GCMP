/*---------------------------------------------------------------------------------------------
 *  Xiaomi MiMo 专用 Provider
 *  为 Xiaomi MiMo 提供多密钥管理和 Token Plan 支持
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, XiaomimimoWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class XiaomimimoProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: XiaomimimoProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);

        const provider = new XiaomimimoProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 普通 API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await XiaomimimoWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Token Plan 专用 API Key
        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await XiaomimimoWizard.setTokenPlanApiKey(providerConfig.displayName, providerConfig.tokenKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('xiaomimimo-token');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenPlanEndpointCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenPlanEndpoint`,
            async () => {
                Logger.info(`User manually opened ${providerConfig.displayName} Token Plan endpoint selection`);
                await XiaomimimoWizard.setTokenPlanEndpoint(providerConfig.displayName);
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await XiaomimimoWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setTokenPlanApiKeyCommand,
            setTokenPlanEndpointCommand,
            configWizardCommand
        ];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isTokenPlan = providerKey === 'xiaomimimo-token';
        const keyType = isTokenPlan ? 'Token Plan dedicated' : 'standard';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} is missing the ${keyType} API key, entering setup flow`);

        if (isTokenPlan) {
            await XiaomimimoWizard.setTokenPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate
            );
        } else {
            await XiaomimimoWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType} API key configured successfully`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: user did not configure the ${keyType} API key`);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('xiaomimimo-token');
        const hasAnyKey = hasNormalKey || hasTokenPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        if (!options.silent) {
            await XiaomimimoWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('xiaomimimo-token');
            if (!normalKeyValid && !tokenPlanKeyValid) {
                Logger.warn(
                    `${this.providerConfig.displayName}: user did not configure any keys, returning empty model list`
                );
                return [];
            }
        }

        // 根据已配置的 API Key 过滤模型
        const filteredModels = await this.filterModelsByAvailableKeys(this.providerConfig.models);
        Logger.debug(
            `${this.providerConfig.displayName}: ${filteredModels.length}/${this.providerConfig.models.length} models available after key filtering`
        );
        // 将配置中的模型转换为 VS Code 所需的格式
        return filteredModels.map(m => this.modelConfigToInfo(m));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType = providerKey === 'xiaomimimo-token' ? 'Token Plan dedicated' : 'standard';
            throw new Error(`${this.providerConfig.displayName}: invalid ${keyType} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${providerKey === 'xiaomimimo-token' ? 'Token Plan' : 'standard'} key - model: ${modelConfig.name}`
        );

        const { totalInputTokens, maxInputTokens } = await this.updateContextUsageStatusBar(
            model,
            messages,
            modelConfig,
            options
        );

        const usagesManager = TokenUsagesManager.instance;
        let requestId = '';
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sessionId = this.getSessionIdFromMessages(messages, sdkMode);
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens,
                maxInputTokens,
                sessionId,
                ...this.getEstimatedRequestMetadata(options)
            });
        } catch (err) {
            Logger.warn('Failed to record estimated tokens, continuing request:', err);
        }

        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(
            `${this.providerConfig.displayName} Provider started handling request (${sdkName}): ${modelConfig.name}`
        );

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                requestId,
                sessionId,
                token,
                providerKey
            );
        } catch (error) {
            this.reportRequestFailure(requestId, sessionId);
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }
}
