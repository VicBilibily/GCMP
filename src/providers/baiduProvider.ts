/*-----------------------------------------------------------------
 * 百度千帆专用 Provider
 * 为百度千帆提供商提供多密钥管理和专属配置向导功能
 *--------------------------------------------------------------------------------*/
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
import { Logger, ApiKeyManager } from '../utils';
import { BaiduWizard } from '../utils/baiduWizard';
import { TokenUsagesManager } from '../usages/usagesManager';
/**
 * 百度千帆专用模型提供商类
 * 继承 GenericModelProvider，添加多密钥管理和配置向导功能
 */
export class BaiduProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }
    /**
     * 静态工厂方法 - 创建并激活百度千帆提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: BaiduProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);
        // 创建提供商实例
        const provider = new BaiduProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置普通 API 密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await BaiduWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });
        // 注册设置 Coding Plan 专用密钥命令
        const setCodingKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await BaiduWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                // API 密钥变更后清除缓存
                await provider.modelInfoCache?.invalidateCache('baidu-coding');
                // 触发模型信息变更事件
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );
        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await BaiduWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });
        const disposables = [providerDisposable, setApiKeyCommand, setCodingKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
    /**
     * 获取模型对应的 provider key（考虑 provider 字段和默认值）
     */
    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        // 优先使用模型特定的 provider 字段
        if (modelConfig.provider) {
            return modelConfig.provider;
        }
        // 否则使用提供商默认的 provider key
        return this.providerKey;
    }
    /**
     * 获取模型对应的密钥，确保存在有效密钥
     * @param modelConfig 模型配置
     * @returns 返回可用的 API 密钥
     */
    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'baidu-coding';
        const keyType = isCodingPlan ? 'Coding Plan dedicated' : 'standard';
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
        if (isCodingPlan) {
            // Coding Plan 模型直接进入专用密钥设置
            await BaiduWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else {
            // 普通模型直接进入普通密钥设置
            await BaiduWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
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
     * 重写：获取模型信息 - 添加密钥检查与模型过滤
     * 根据每个模型对应的 API Key 是否已配置来过滤模型列表
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
        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('baidu-coding');
        const hasAnyKey = hasNormalKey || hasCodingKey;
        // 如果是静默模式且没有任何密钥，直接返回空列表
        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }
        // 非静默模式：启动配置向导
        if (!options.silent) {
            await BaiduWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate
            );
            // 重新检查是否设置了密钥
            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('baidu-coding');
            // 如果用户仍未设置任何密钥，返回空列表
            if (!normalKeyValid && !codingKeyValid) {
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
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }
        // 请求前：确保模型对应的密钥存在
        // 这会在没有密钥时弹出设置对话框
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType = providerKey === 'baidu-coding' ? 'Coding Plan dedicated' : 'standard';
            throw new Error(`${this.providerConfig.displayName}: invalid ${keyType} API key`);
        }
        Logger.debug(
            `${this.providerConfig.displayName}: about to handle request using ${providerKey === 'baidu-coding' ? 'Coding Plan' : 'standard'} key - model: ${modelConfig.name}`
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
        // 根据模型的 sdkMode 选择使用的 handler
        // 注：此处不调用 super.provideLanguageModelChatResponse，而是直接处理
        // 避免双重密钥检查，因为我们已经在 ensureApiKeyForModel 中检查过了
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
        }
    }
}
