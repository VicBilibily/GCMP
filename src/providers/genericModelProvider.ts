/*---------------------------------------------------------------------------------------------
 *  通用Provider类
 *  基于配置文件动态创建提供商实现
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
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, ConfigManager, Logger, ModelInfoCache, TokenCounter, PromptAnalyzer } from '../utils';
import { OpenAIHandler } from '../handlers/openaiHandler';
import { OpenAICustomHandler } from '../handlers/openaiCustomHandler';
import { AnthropicHandler } from '../handlers/anthropicHandler';
import { GeminiHandler } from '../handlers/geminiHandler';
import { ContextUsageStatusBar } from '../status/contextUsageStatusBar';
import { TokenUsagesManager } from '../usages/usagesManager';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';

/**
 * 通用模型提供商类
 * 基于配置文件动态创建提供商实现
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    protected readonly openaiHandler: OpenAIHandler;
    protected readonly openaiCustomHandler: OpenAICustomHandler;
    protected readonly openaiResponsesHandler: OpenAIResponsesHandler;
    protected readonly anthropicHandler: AnthropicHandler;
    protected readonly geminiHandler: GeminiHandler;
    protected readonly providerKey: string;
    protected baseProviderConfig: ProviderConfig; // protected 以支持子类访问
    protected cachedProviderConfig: ProviderConfig; // 缓存的配置
    protected configListener?: vscode.Disposable; // 配置监听器
    protected modelInfoCache?: ModelInfoCache; // 模型信息缓存

    // 模型信息变更事件
    protected _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        this.providerKey = providerKey;
        // 保存原始配置（不应用覆盖）
        this.baseProviderConfig = providerConfig;
        // 初始化缓存配置（应用覆盖）
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, this.baseProviderConfig);
        // 初始化模型信息缓存
        this.modelInfoCache = new ModelInfoCache(context);

        // 监听配置变更
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            // 检查是否是 providerOverrides 的变更
            if (e.affectsConfiguration('gcmp.providerOverrides') && providerKey !== 'compatible') {
                // 重新计算配置
                this.cachedProviderConfig = ConfigManager.applyProviderOverrides(
                    this.providerKey,
                    this.baseProviderConfig
                );
                // 清除缓存
                this.modelInfoCache
                    ?.invalidateCache(this.providerKey)
                    .catch(err => Logger.warn(`[${this.providerKey}] 清除缓存失败:`, err));
                Logger.trace(`${this.providerKey} 配置已更新`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
            if (e.affectsConfiguration('gcmp.editToolMode')) {
                Logger.trace(`${this.providerKey} 检测到 editToolMode 变更`);
                // 清除缓存
                this.modelInfoCache
                    ?.invalidateCache(this.providerKey)
                    .catch(err => Logger.warn(`[${this.providerKey}] 清除缓存失败:`, err));
                this._onDidChangeLanguageModelChatInformation.fire();
            }
        });

        // 创建 OpenAI SDK 处理器
        this.openaiHandler = new OpenAIHandler(providerKey, providerConfig);
        // 创建 OpenAI 自定义 SSE 处理器
        this.openaiCustomHandler = new OpenAICustomHandler(providerKey, providerConfig, this.openaiHandler);
        // 创建 OpenAI Responses API 处理器
        this.openaiResponsesHandler = new OpenAIResponsesHandler(
            providerKey,
            this.providerConfig.displayName,
            this.openaiHandler
        );
        // 创建 Anthropic SDK 处理器
        this.anthropicHandler = new AnthropicHandler(providerKey, providerConfig);
        // 创建 Gemini HTTP SSE 处理器
        this.geminiHandler = new GeminiHandler(providerKey, providerConfig);
    }

    /**
     * 释放资源
     */
    dispose(): void {
        // 释放配置监听器
        this.configListener?.dispose();
        // 释放事件发射器
        this._onDidChangeLanguageModelChatInformation.dispose();
        Logger.info(`🧹 ${this.providerConfig.displayName}: 扩展销毁`);
    }

    /**
     * 获取当前有效的 provider 配置
     */
    get providerConfig(): ProviderConfig {
        return this.cachedProviderConfig;
    }

    /**
     * 静态工厂方法 - 根据配置创建并激活提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: GenericModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 模型扩展已激活!`);
        // 创建提供商实例
        const provider = new GenericModelProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });
        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 将ModelConfig转换为LanguageModelChatInformation
     */
    protected modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        // 读取编辑工具模式设置
        const editToolMode = vscode.workspace.getConfiguration('gcmp').get('editToolMode', 'claude') as string;

        let family: string;
        if (editToolMode && editToolMode !== 'none') {
            family = editToolMode.startsWith('claude') ? 'claude-sonnet-4.5' : editToolMode;
        } else if (editToolMode === 'none') {
            family = model.id;
        } else {
            family = model.id; // 回退到使用模型ID
        }

        const info: LanguageModelChatInformation = {
            id: model.id,
            name: model.name,
            detail: this.providerConfig.displayName,
            tooltip: model.tooltip,
            family: family,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            capabilities: model.capabilities
        };

        return info;
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // 快速路径：检查缓存
        try {
            const apiKeyHash = await this.getApiKeyHash();
            let cachedModels = await this.modelInfoCache?.getCachedModels(this.providerKey, apiKeyHash);

            if (cachedModels) {
                Logger.trace(`✓ [${this.providerKey}] 从缓存返回模型列表 ` + `(${cachedModels.length} 个模型)`);

                // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能时）
                const rememberLastModel = ConfigManager.getRememberLastModel();
                if (rememberLastModel) {
                    const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(this.providerKey);
                    if (lastSelectedId) {
                        cachedModels = cachedModels.map(model => ({
                            ...model,
                            isDefault: model.id === lastSelectedId
                        }));
                    }
                }

                // 后台异步更新缓存（不阻塞返回，不等待 await）
                this.updateModelCacheAsync(apiKeyHash);

                return cachedModels;
            }
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] 缓存查询失败，降级到原始逻辑:`,
                err instanceof Error ? err.message : String(err)
            );
        }

        // 原始逻辑：检查 API 密钥并构建模型列表
        const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            // 非静默模式下，直接触发API密钥设置
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.setApiKey`);
            // 重新检查API密钥
            const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerKey);
            if (!hasApiKeyAfterSet) {
                // 如果用户取消设置或设置失败，返回空列表
                return [];
            }
        }
        // 将配置中的模型转换为VS Code所需的格式
        let models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

        // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能且提供商匹配时）
        const rememberLastModel = ConfigManager.getRememberLastModel();
        if (rememberLastModel) {
            const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(this.providerKey);
            if (lastSelectedId) {
                models = models.map(model => ({
                    ...model,
                    isDefault: model.id === lastSelectedId
                }));
            }
        }

        // 异步缓存结果（不阻塞返回）
        try {
            const apiKeyHash = await this.getApiKeyHash();
            this.updateModelCacheAsync(apiKeyHash);
        } catch (err) {
            Logger.warn(`[${this.providerKey}] 缓存保存失败:`, err);
        }

        return models;
    }

    /**
     * 异步更新模型缓存（不阻塞调用者）
     */
    protected updateModelCacheAsync(apiKeyHash: string): void {
        // 使用 Promise 在后台执行，不等待结果
        (async () => {
            try {
                const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

                await this.modelInfoCache?.cacheModels(this.providerKey, models, apiKeyHash);
            } catch (err) {
                // 后台更新失败不应影响扩展运行
                Logger.trace(
                    `[${this.providerKey}] 后台缓存更新失败:`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        })();
    }

    /**
     * 计算 API 密钥的哈希值（用于缓存检查）
     */
    protected async getApiKeyHash(): Promise<string> {
        try {
            const apiKey = await ApiKeyManager.getApiKey(this.providerKey);
            if (!apiKey) {
                return 'no-key';
            }
            return await ModelInfoCache.computeApiKeyHash(apiKey);
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] 计算 API 密钥哈希失败:`,
                err instanceof Error ? err.message : String(err)
            );
            return 'hash-error';
        }
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 保存用户选择的模型及其提供商（仅当启用记忆功能时）
        const rememberLastModel = ConfigManager.getRememberLastModel();
        if (rememberLastModel) {
            this.modelInfoCache
                ?.saveLastSelectedModel(this.providerKey, model.id)
                .catch(err => Logger.warn(`[${this.providerKey}] 保存模型选择失败:`, err));
        }

        // 查找对应的模型配置
        const modelConfig = this.providerConfig.models.find((m: ModelConfig) => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 根据模型配置中的 provider 字段确定实际使用的提供商
        // 这样可以正确处理同一提供商下不同模型使用不同密钥的情况
        const effectiveProviderKey = modelConfig.provider || this.providerKey;

        // 计算输入 token 数量并更新状态栏
        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

        // === Token 统计: 记录预估输入 token ===
        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: effectiveProviderKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('记录预估Token失败，继续执行请求:', err);
        }

        // 确保对应提供商的 API 密钥存在
        await ApiKeyManager.ensureApiKey(effectiveProviderKey, this.providerConfig.displayName);

        // 根据模型的 sdkMode 选择使用的 handler
        const sdkMode = modelConfig.sdkMode || 'openai';
        let sdkName = 'OpenAI SDK';
        if (sdkMode === 'anthropic') {
            sdkName = 'Anthropic SDK';
        } else if (sdkMode === 'openai-sse') {
            sdkName = 'OpenAI SSE';
        } else if (sdkMode === 'openai-responses') {
            sdkName = 'OpenAI Responses API';
        } else if (sdkMode === 'gemini-sse') {
            sdkName = 'Gemini SSE';
        }
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            if (sdkMode === 'anthropic') {
                await this.anthropicHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    token,
                    requestId
                );
            } else if (sdkMode === 'gemini-sse') {
                await this.geminiHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    token,
                    requestId
                );
            } else if (sdkMode === 'openai-sse') {
                // OpenAI SSE 模式：使用自定义 SSE 流处理
                await this.openaiCustomHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    token,
                    requestId
                );
            } else if (sdkMode === 'openai-responses') {
                // OpenAI Responses API 模式：使用 Responses API
                await this.openaiResponsesHandler.handleResponsesRequest(
                    model,
                    { ...modelConfig, provider: effectiveProviderKey },
                    messages,
                    options,
                    progress,
                    token,
                    requestId
                );
            } else {
                await this.openaiHandler.handleRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    token,
                    requestId
                );
            }
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);

            // === Token 统计: 更新失败状态 ===
            if (requestId) {
                try {
                    await usagesManager.updateActualTokens({
                        requestId,
                        status: 'failed'
                    });
                } catch (err) {
                    Logger.warn('更新Token统计失败状态失败:', err);
                }
            }

            // 直接抛出错误，让VS Code处理重试
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
        }
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatMessage,
        _token: CancellationToken
    ): Promise<number> {
        return TokenCounter.getInstance().countTokens(model, text);
    }

    /**
     * 更新上下文占用状态栏
     * 计算输入 token 数量和占用百分比，更新状态栏显示
     * 供子类复用
     * @returns totalInputTokens - 返回计算的输入token数量，供Token统计使用
     */
    protected async updateContextUsageStatusBar(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<number> {
        try {
            // 统计提示词各部分的占用（包含总 token 数）
            const promptParts = await PromptAnalyzer.analyzePromptParts(this.providerKey, model, messages, options);

            // 使用 promptParts.context 作为总 token 占用
            const totalInputTokens = promptParts.context || 0;
            const maxInputTokens = model.maxInputTokens || modelConfig.maxInputTokens;
            const percentage = (totalInputTokens / maxInputTokens) * 100;

            // const countMessagesTokens = await TokenCounter.getInstance().countMessagesTokens(
            //     model,
            //     messages,
            //     modelConfig,
            //     options
            // );
            // Logger.debug(
            //     `[${this.providerKey}] 详细 Token 计算: 消息总计 ${countMessagesTokens}，` +
            //         `提示词各部分: ${JSON.stringify(promptParts)}`
            // );

            // 更新上下文占用状态栏
            const contextUsageStatusBar = ContextUsageStatusBar.getInstance();
            if (contextUsageStatusBar) {
                contextUsageStatusBar.updateWithPromptParts(
                    model.name || modelConfig.name,
                    maxInputTokens,
                    promptParts
                );
            }

            Logger.debug(
                `[${this.providerKey}] Token 计算: ${totalInputTokens}/${maxInputTokens} (${percentage.toFixed(1)}%)`
            );
            return totalInputTokens;
        } catch (error) {
            // Token 计算失败不应阻止请求，只记录警告
            Logger.warn(`[${this.providerKey}] Token 计算失败:`, error);
            return 0;
        }
    }
}
