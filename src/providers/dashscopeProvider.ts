/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 专用 Provider
 *  为 Dashscope 提供商提供多密钥管理和配置向导功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    Progress,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, DashscopeWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class DashscopeProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: DashscopeProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);

        const provider = new DashscopeProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 普通 API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await DashscopeWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Coding Plan 专用 API Key
        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await DashscopeWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('dashscope-coding');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`启动 ${providerConfig.displayName} 配置向导`);
            await DashscopeWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, setCodingPlanApiKeyCommand, configWizardCommand];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'dashscope-coding';
        const keyType = isCodingPlan ? 'Coding Plan 专用' : '普通';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`模型 ${modelConfig.name} 缺少 ${keyType} API 密钥，进入设置流程`);

        if (isCodingPlan) {
            await DashscopeWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else {
            await DashscopeWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType}密钥设置成功`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: 用户未设置 ${keyType} API 密钥`);
    }

    override async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('dashscope-coding');
        const hasAnyKey = hasNormalKey || hasCodingKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: 静默模式下，未检测到任何密钥，返回空模型列表`);
            return [];
        }

        if (!options.silent) {
            await DashscopeWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('dashscope-coding');
            if (!normalKeyValid && !codingKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: 用户未设置任何密钥，返回空模型列表`);
                return [];
            }
        }

        const models = this.providerConfig.models.map(m => this.modelConfigToInfo(m));

        return models;
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        const modelConfig = this.providerConfig.models.find((m: ModelConfig) => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType = providerKey === 'dashscope-coding' ? 'Coding Plan 专用' : '普通';
            throw new Error(`${this.providerConfig.displayName}: 无效的 ${keyType} API 密钥`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: 即将处理请求，使用 ${providerKey === 'dashscope-coding' ? 'Coding Plan' : '普通'} 密钥 - 模型: ${modelConfig.name}`
        );

        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('记录预估Token失败，继续执行请求:', err);
        }

        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = sdkMode === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            if (sdkMode === 'anthropic') {
                await this.anthropicHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    _token,
                    requestId
                );
            } else {
                await this.openaiHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    _token,
                    requestId
                );
            }
        } catch (error) {
            if (requestId) {
                try {
                    await usagesManager.updateActualTokens({ requestId, status: 'failed' });
                } catch (err) {
                    Logger.warn('更新Token统计失败状态失败:', err);
                }
            }
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
        }
    }
}
