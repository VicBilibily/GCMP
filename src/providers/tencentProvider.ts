/*---------------------------------------------------------------------------------------------
 *  腾讯云专用 Provider
 *  为腾讯云 Coding Plan、Token Plan、TokenHub 与 Token Plan Enterprise 提供多密钥管理和协议切换功能
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
import { Logger, ApiKeyManager, isCancellationError } from '../utils';
import { TencentWizard } from '../wizards/tencentWizard';
import { TokenUsagesManager } from '../usages/usagesManager';
import { classifyRequest } from '../handlers/requestClassifier';

export class TencentProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: TencentProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);

        const provider = new TencentProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await TencentWizard.setCodingPlanApiKey(providerConfig.codingKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await TencentWizard.setTokenPlanApiKey(providerConfig.tokenKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenHubApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenHubApiKey`,
            async () => {
                await TencentWizard.setTokenHubApiKey(providerConfig.apiKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenEnterpriseApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenEnterpriseApiKey`,
            async () => {
                await TencentWizard.setTokenEnterpriseApiKey(providerConfig.apiKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await TencentWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand,
            setTokenHubApiKeyCommand,
            setTokenEnterpriseApiKeyCommand,
            configWizardCommand
        ];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    protected override modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        return super.modelConfigToInfo(model);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        const hasCodingKey = await ApiKeyManager.hasValidApiKey('tencent-coding');
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('tencent-token');
        const hasTokenHubKey = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
        const hasTokenPlanEnterpriseKey = await ApiKeyManager.hasValidApiKey('tencent-token-enterprise');
        const hasAnyKey = hasCodingKey || hasTokenPlanKey || hasTokenHubKey || hasTokenPlanEnterpriseKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        if (!options.silent) {
            await TencentWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const codingKeyValid = await ApiKeyManager.hasValidApiKey('tencent-coding');
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('tencent-token');
            const tokenHubKeyValid = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
            const tokenPlanEnterpriseKeyValid = await ApiKeyManager.hasValidApiKey('tencent-token-enterprise');
            if (!codingKeyValid && !tokenPlanKeyValid && !tokenHubKeyValid && !tokenPlanEnterpriseKeyValid) {
                Logger.warn(
                    `${this.providerConfig.displayName}: user did not configure any keys, returning empty model list`
                );
                return [];
            }
        }

        // 根据已配置的 API Key 过滤模型
        const filteredModels = await this.filterModelsByAvailableKeys(this.providerConfig.models);
        Logger.trace(
            `${this.providerConfig.displayName}: ${filteredModels.length}/${this.providerConfig.models.length} models available after key filtering`
        );
        return filteredModels.map(model => this.modelConfigToInfo(model));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const rawModelConfig = this.findModelConfigById(model);
        if (!rawModelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const modelConfig = rawModelConfig;
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            throw new Error(`${this.providerConfig.displayName}: invalid ${this.getKeyLabel(providerKey)} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${providerKey} key - model: ${modelConfig.name}`
        );

        // 请求分类 + 注入到 options.modelOptions（上层已设置 requestKind 时直接使用）
        const rtOpts = options as { modelOptions?: { requestKind?: string } };
        if (!rtOpts.modelOptions) {
            rtOpts.modelOptions = {};
        }
        const kind = rtOpts.modelOptions.requestKind ?? classifyRequest(messages, options.tools);
        rtOpts.modelOptions.requestKind = kind;

        const { totalInputTokens, maxInputTokens, estimatedIncrement } = await this.updateContextUsageStatusBar(
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
                providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens,
                estimatedIncrement,
                maxInputTokens,
                requestKind: kind,
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
            if (isCancellationError(error)) {
                await this.reportRequestCancelled(requestId, sessionId);
                throw error;
            }
            this.reportRequestFailure(requestId, sessionId);
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }

    private getKeyLabel(providerKey: string): string {
        switch (providerKey) {
            case 'tencent-coding':
                return 'Coding Plan dedicated';
            case 'tencent-token':
                return 'Token Plan dedicated';
            case 'tencent-tokenhub':
                return 'TokenHub dedicated';
            case 'tencent-token-enterprise':
                return 'Token Plan Enterprise dedicated';
            default:
                return 'unknown plan';
        }
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(
            `Model ${modelConfig.name} is missing the ${this.getKeyLabel(providerKey)} API key, entering setup flow`
        );

        if (providerKey === 'tencent-coding') {
            await TencentWizard.setCodingPlanApiKey(this.providerConfig.codingKeyTemplate);
        } else if (providerKey === 'tencent-token') {
            await TencentWizard.setTokenPlanApiKey(this.providerConfig.tokenKeyTemplate);
        } else if (providerKey === 'tencent-tokenhub') {
            await TencentWizard.setTokenHubApiKey(this.providerConfig.apiKeyTemplate);
        } else if (providerKey === 'tencent-token-enterprise') {
            await TencentWizard.setTokenEnterpriseApiKey(this.providerConfig.apiKeyTemplate);
        } else {
            Logger.warn(
                `${this.providerConfig.displayName}: unsupported provider key "${providerKey}" for model ${modelConfig.name}, no setup flow available`
            );
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${this.getKeyLabel(providerKey)} API key configured successfully`);
            return apiKey;
        }

        throw new Error(
            `${this.providerConfig.displayName}: user did not configure the ${this.getKeyLabel(providerKey)} API key`
        );
    }
}
