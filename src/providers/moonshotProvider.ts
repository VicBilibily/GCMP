/*---------------------------------------------------------------------------------------------
 *  MoonshotAI 专用 Provider
 *  为 MoonshotAI 提供商提供多密钥管理和专属配置向导功能
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
import { Logger, ApiKeyManager, MoonshotWizard } from '../utils';
import { StatusBarManager } from '../status';
import { TokenUsagesManager } from '../usages/usagesManager';

/**
 * MoonshotAI 专用模型提供商类
 * 继承 GenericModelProvider，添加多密钥管理和配置向导功能
 */
export class MoonshotProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 MoonshotAI 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: MoonshotProvider; disposables: vscode.Disposable[] } {
        // 创建提供商实例
        const provider = new MoonshotProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册设置 Moonshot API 密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await MoonshotWizard.setMoonshotApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册设置 Kimi API 密钥命令
        const setKimiApiKeyCommand = vscode.commands.registerCommand('gcmp.kimi.setApiKey', async () => {
            await MoonshotWizard.setKimiApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache('kimi');
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await MoonshotWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate
            );
        });

        const disposables = [providerDisposable, setApiKeyCommand, setKimiApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 重写：将 ModelConfig 转换为 LanguageModelChatInformation
     * 当模型的 provider 为 "kimi" 时，显示提供商名称为 "Kimi"
     */
    protected override modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        const info = super.modelConfigToInfo(model);
        // 如果模型使用 kimi provider，修改显示的提供商名称
        if (model.provider === 'kimi') {
            return {
                ...info,
                detail: 'Kimi'
            };
        }
        return info;
    }

    /**
     * 获取模型对应的密钥，确保存在有效密钥
     * @param modelConfig 模型配置
     * @returns 返回可用的 API 密钥
     */
    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = modelConfig.provider || this.providerKey;
        const isKimi = providerKey === 'kimi';
        const keyType = isKimi ? 'Kimi For Coding dedicated' : 'Moonshot';

        // 检查是否已有密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        // 密钥不存在，直接进入设置流程（不弹窗确认）
        Logger.warn(`Model ${modelConfig.name} is missing the ${keyType} API key, entering setup flow`);

        if (isKimi) {
            // Kimi For Coding 模型直接进入专用密钥设置
            await MoonshotWizard.setKimiApiKey(this.providerConfig.displayName, this.providerConfig.codingKeyTemplate);
        } else {
            // Moonshot 模型直接进入普通密钥设置
            await MoonshotWizard.setMoonshotApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        // 重新检查密钥是否设置成功
        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType} API key configured successfully`);
            return apiKey;
        }

        // 用户未设置或设置失败
        throw new Error(`${this.providerConfig.displayName}: user did not configure the ${keyType} API key`);
    }

    /**
     * 重写：获取模型信息 - 添加密钥检查
     * 只要有任意密钥存在就返回所有模型，不进行过滤
     * 具体的密钥验证在实际使用时（provideLanguageModelChatResponse）进行
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        // 检查是否有任意密钥
        const hasMoonshotKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasKimiKey = await ApiKeyManager.hasValidApiKey('kimi');
        const hasAnyKey = hasMoonshotKey || hasKimiKey;

        // 如果是静默模式且没有任何密钥，直接返回空列表
        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        // 非静默模式：启动配置向导
        if (!options.silent) {
            await MoonshotWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate
            );

            // 重新检查是否设置了密钥
            const moonshotKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const kimiKeyValid = await ApiKeyManager.hasValidApiKey('kimi');

            // 如果用户仍未设置任何密钥，返回空列表
            if (!moonshotKeyValid && !kimiKeyValid) {
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
        return filteredModels.map(model => this.modelConfigToInfo(model));
    }

    /**
     * 重写：提供语言模型聊天响应 - 添加请求前密钥确保机制
     * 在处理请求前确保对应的密钥存在
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        // 查找对应的模型配置
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 请求前：确保模型对应的密钥存在
        // 这会在没有密钥时弹出设置对话框
        const providerKey = modelConfig.provider || this.providerKey;
        const apiKey = await this.ensureApiKeyForModel(modelConfig);

        if (!apiKey) {
            const keyType = providerKey === 'kimi' ? 'Kimi For Coding dedicated' : 'Moonshot';
            throw new Error(`${this.providerConfig.displayName}: invalid ${keyType} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${providerKey === 'kimi' ? 'Kimi For Coding' : 'Moonshot'} key - model: ${modelConfig.name}`
        );

        // 计算输入 token 数量并更新状态栏
        const { totalInputTokens, maxInputTokens } = await this.updateContextUsageStatusBar(
            model,
            messages,
            modelConfig,
            options
        );

        // === Token 统计: 记录预估输入 token ===
        const usagesManager = TokenUsagesManager.instance;
        let requestId = '';
        // 根据模型的 sdkMode 选择使用的 handler
        // 注：此处不调用 super.provideLanguageModelChatResponse，而是直接处理
        // 避免双重密钥检查，因为我们已经在 ensureApiKeyForModel 中检查过了
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
            const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            Logger.error(errorMessage);
            this.reportRequestFailure(requestId, sessionId);
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);

            try {
                // 根据使用的密钥类型，延时更新对应的状态栏使用量
                if (providerKey === 'kimi') {
                    StatusBarManager.delayedUpdate('kimi');
                } else {
                    StatusBarManager.delayedUpdate('moonshot');
                }
            } catch (err) {
                Logger.warn('Failed to update status bar:', err);
            }
        }
    }
}
