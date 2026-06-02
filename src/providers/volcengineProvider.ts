/*---------------------------------------------------------------------------------------------
 *  Volcengine (火山方舟) 专用 Provider
 *  为火山方舟提供多密钥管理（Coding Plan / Agent Plan）和配置向导功能
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
import { Logger, ApiKeyManager, VolcengineWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class VolcengineProvider extends GenericModelProvider implements LanguageModelChatProvider {
    private static readonly AGENT_PLAN_KEY = 'volcengine-agent';

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: VolcengineProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);

        const provider = new VolcengineProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // Coding Plan API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await VolcengineWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Agent Plan 专用 API Key
        const setAgentPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setAgentPlanApiKey`,
            async () => {
                await VolcengineWizard.setAgentPlanApiKey(
                    providerConfig.displayName,
                    providerConfig.tokenKeyTemplate || providerConfig.apiKeyTemplate
                );
                await provider.modelInfoCache?.invalidateCache(VolcengineProvider.AGENT_PLAN_KEY);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await VolcengineWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, setAgentPlanApiKeyCommand, configWizardCommand];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isAgentPlan = providerKey === VolcengineProvider.AGENT_PLAN_KEY;
        const keyType = isAgentPlan ? 'Agent Plan dedicated' : 'Coding Plan';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} is missing the ${keyType} API key, entering setup flow`);

        if (isAgentPlan) {
            await VolcengineWizard.setAgentPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate || this.providerConfig.apiKeyTemplate
            );
        } else {
            await VolcengineWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate
            );
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
            return [];
        }

        const hasCodingKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasAgentPlanKey = await ApiKeyManager.hasValidApiKey(VolcengineProvider.AGENT_PLAN_KEY);
        const hasAnyKey = hasCodingKey || hasAgentPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        if (!options.silent) {
            await VolcengineWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const codingKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const agentPlanKeyValid = await ApiKeyManager.hasValidApiKey(VolcengineProvider.AGENT_PLAN_KEY);
            if (!codingKeyValid && !agentPlanKeyValid) {
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
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType = providerKey === VolcengineProvider.AGENT_PLAN_KEY ? 'Agent Plan dedicated' : 'Coding Plan';
            throw new Error(`${this.providerConfig.displayName}: invalid ${keyType} API key`);
        }

        const keyLabel = providerKey === VolcengineProvider.AGENT_PLAN_KEY ? 'Agent Plan' : 'Coding Plan';
        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${keyLabel} key - model: ${modelConfig.name}`
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
