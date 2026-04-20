/*---------------------------------------------------------------------------------------------
 *  腾讯云专用 Provider
 *  为腾讯云付费模型、Coding Plan、Token Plan 与 DeepSeek 提供多密钥管理和协议切换功能
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
import { Logger, ApiKeyManager, TencentWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class TencentProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: TencentProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);

        const provider = new TencentProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await TencentWizard.setApiKey(providerConfig.apiKeyTemplate);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

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

        const setDeepSeekApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setDeepSeekApiKey`,
            async () => {
                await TencentWizard.setDeepSeekApiKey(providerConfig.apiKeyTemplate);
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

        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`启动 ${providerConfig.displayName} 配置向导`);
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
            setApiKeyCommand,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand,
            setDeepSeekApiKeyCommand,
            setTokenHubApiKeyCommand,
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

        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('tencent-coding');
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('tencent-token');
        const hasDeepSeekKey = await ApiKeyManager.hasValidApiKey('tencent-deepseek');
        const hasTokenHubKey = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
        const hasAnyKey = hasNormalKey || hasCodingKey || hasTokenPlanKey || hasDeepSeekKey || hasTokenHubKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: 静默模式下，未检测到任何密钥，返回空模型列表`);
            return [];
        }

        if (!options.silent) {
            await TencentWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('tencent-coding');
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('tencent-token');
            const deepSeekKeyValid = await ApiKeyManager.hasValidApiKey('tencent-deepseek');
            const tokenHubKeyValid = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
            if (!normalKeyValid && !codingKeyValid && !tokenPlanKeyValid && !deepSeekKeyValid && !tokenHubKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: 用户未设置任何密钥，返回空模型列表`);
                return [];
            }
        }

        return this.providerConfig.models.map(model => this.modelConfigToInfo(model));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const rawModelConfig = this.findModelConfigById(model);
        if (!rawModelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const modelConfig = rawModelConfig;
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            throw new Error(`${this.providerConfig.displayName}: 无效的 ${this.getKeyLabel(providerKey)} API 密钥`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: 即将处理请求，使用 ${providerKey} 密钥 - 模型: ${modelConfig.name}`
        );

        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('记录预估Token失败，继续执行请求:', err);
        }

        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                _token,
                requestId,
                providerKey
            );
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

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private getKeyLabel(providerKey: string): string {
        switch (providerKey) {
            case 'tencent-coding':
                return 'Coding Plan 专用';
            case 'tencent-token':
                return 'Token Plan 专用';
            case 'tencent-deepseek':
                return 'DeepSeek 专用';
            case 'tencent-tokenhub':
                return 'TokenHub 专用';
            default:
                return '付费模型';
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

        Logger.warn(`模型 ${modelConfig.name} 缺少 ${this.getKeyLabel(providerKey)} API 密钥，进入设置流程`);

        if (providerKey === 'tencent-coding') {
            await TencentWizard.setCodingPlanApiKey(this.providerConfig.codingKeyTemplate);
        } else if (providerKey === 'tencent-token') {
            await TencentWizard.setTokenPlanApiKey(this.providerConfig.tokenKeyTemplate);
        } else if (providerKey === 'tencent-deepseek') {
            await TencentWizard.setDeepSeekApiKey(this.providerConfig.apiKeyTemplate);
        } else if (providerKey === 'tencent-tokenhub') {
            await TencentWizard.setTokenHubApiKey(this.providerConfig.apiKeyTemplate);
        } else {
            await TencentWizard.setApiKey(this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${this.getKeyLabel(providerKey)}密钥设置成功`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: 用户未设置 ${this.getKeyLabel(providerKey)} API 密钥`);
    }
}
