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
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import {
    ApiKeyManager,
    ConfigManager,
    Logger,
    ModelInfoCache,
    PromptAnalyzer,
    RetryManager,
    TokenCounter
} from '../utils';
import type { RetryableError } from '../utils';
import { OpenAIHandler } from '../handlers/openaiHandler';
import { OpenAICustomHandler } from '../handlers/openaiCustomHandler';
import { AnthropicHandler } from '../handlers/anthropicHandler';
import { GeminiHandler } from '../handlers/geminiHandler';
import { ContextUsageStatusBar } from '../status/contextUsageStatusBar';
import { TokenUsagesManager } from '../usages/usagesManager';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';
import { JSONSchema7 } from 'json-schema';

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
            // 检查是否是 autoPrefixModelId 的变更
            if (e.affectsConfiguration('gcmp.autoPrefixModelId')) {
                Logger.trace(`[${this.providerKey}] autoPrefixModelId 配置已更新，刷新模型列表`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
        });

        // 创建 OpenAI SDK 处理器
        this.openaiHandler = new OpenAIHandler(this);
        // 创建 OpenAI 自定义 SSE 处理器
        this.openaiCustomHandler = new OpenAICustomHandler(this, this.openaiHandler);
        // 创建 OpenAI Responses API 处理器
        this.openaiResponsesHandler = new OpenAIResponsesHandler(this, this.openaiHandler);
        // 创建 Anthropic SDK 处理器
        this.anthropicHandler = new AnthropicHandler(this);
        // 创建 Gemini HTTP SSE 处理器
        this.geminiHandler = new GeminiHandler(this);
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

    /** 获取 providerKey */
    get provider(): string {
        return this.providerKey;
    }
    /** 获取当前有效的 provider 配置 */
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
        // 确定 family：优先使用模型配置的 family 字段，否则根据 sdkMode 自动推断
        const family = this.resolveFamily(model);
        let modelId = model.id;
        if (ConfigManager.getAutoPrefixModelId()) {
            modelId = `${model.provider || this.providerKey}:::${modelId}`;
        }

        // 动态构建 configurationSchema
        type PropertySchema = JSONSchema7 & NonNullable<vscode.LanguageModelConfigurationSchema['properties']>[string];
        const properties: Record<string, PropertySchema> = {};
        // 根据模型配置添加 thinking 选项
        if (model.thinking && model.thinking.length > 0) {
            const schema: PropertySchema = {
                type: 'string',
                title: '思考模式',
                enum: model.thinking,
                enumItemLabels: model.thinking.map(
                    t => ({ disabled: '关', enabled: '思考', auto: 'Auto', adaptive: 'Adaptive' })[t] || t
                ),
                enumDescriptions: model.thinking.map(
                    t =>
                        ({
                            disabled: '关闭思考模式',
                            enabled: '开启思考模式',
                            auto: '模型自行判断',
                            adaptive: '上下文自适应'
                        })[t] || t
                ),
                default: model.thinking[0],
                group: 'navigation'
            };
            if (model.thinking?.includes('auto')) {
                schema.default = 'auto';
            } else if (model.thinking?.includes('adaptive')) {
                schema.default = 'adaptive';
            }
            properties.thinking = schema;
        }
        // 根据模型配置添加 reasoningEffort 选项
        if (model.reasoningEffort && model.reasoningEffort.length > 0) {
            delete properties.thinking; // 与 thinking 选项冲突
            const schema: PropertySchema = {
                type: 'string',
                title: '思考长度',
                enum: model.reasoningEffort,
                enumItemLabels: model.reasoningEffort.map(
                    level =>
                        ({ none: '关', minimal: '关', low: '低', medium: '中', high: '高', xhigh: '超', max: '超' })[
                            level
                        ] || level
                ),
                enumDescriptions: model.reasoningEffort.map(
                    level =>
                        ({
                            none: '关闭思考，直接回答',
                            minimal: '关闭思考，直接回答',
                            low: '轻量思考，快速响应',
                            medium: '均衡模式，兼顾速度与深度',
                            high: '深度分析，处理复杂问题',
                            xhigh: '最大推理深度，速度较慢',
                            max: '绝对最高能力，没有消耗限制'
                        })[level] || level
                ),
                default: model.reasoningEffort[0],
                group: 'navigation'
            };
            if (model.reasoningEffort?.includes('medium')) {
                schema.default = 'medium';
            }
            properties.reasoningEffort = schema;
        }

        // let multiplier = this.providerConfig.displayName;
        // if (model.provider?.endsWith('coding')) {
        //     multiplier += 'CP';
        // } else if (model.provider?.endsWith('token')) {
        //     multiplier += 'TP';
        // } else if (model.id?.endsWith('billing') || model.name?.includes('按量')) {
        //     multiplier += 'PG';
        // }

        const info: LanguageModelChatInformation = {
            id: modelId,
            name: model.name,
            detail: this.providerConfig.displayName,
            tooltip: model.tooltip,
            family: family,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            category: { label: this.providerConfig.displayName, order: 3 },
            capabilities: model.capabilities,
            // multiplier: multiplier,
            configurationSchema: Object.keys(properties).length > 0 ? { properties } : undefined
        };
        return info;
    }

    /**
     * 根据 LanguageModelChatInformation 查找对应的 ModelConfig
     * 适配 autoPrefixModelId 模式：支持带前缀的模型ID解析（如 zhipu:::glm-4.6）
     * @param model 从VS Code模型选择器获取的模型信息（model.id 可能带前缀）
     * @returns 找到的ModelConfig，若未找到则返回undefined
     */
    protected findModelConfigById(model: LanguageModelChatInformation): ModelConfig | undefined {
        // 前缀格式：${provider}:::${modelId}
        // 使用三个冒号作为分隔符，避免与用户输入的模型ID冲突
        const prefixSeparator = ':::';
        const prefixRegex = /^([a-zA-Z0-9_-]+):::(.+)$/;

        if (!model.id.includes(prefixSeparator)) {
            return this.providerConfig.models.find(m => m.id === model.id);
        }

        // 解析带前缀的ID
        const match = model.id.match(prefixRegex);
        if (match) {
            const [, modelProvider, rawModelId] = match;
            // 检查前缀是否是当前 provider
            if (modelProvider === this.providerKey) {
                return this.providerConfig.models.find(m => m.id === rawModelId);
            }
            // 如果模型自己的 provider 字段设置了值，也要检查是否匹配
            const matchedModel = this.providerConfig.models.find(m => {
                if (m.provider && m.provider !== modelProvider) {
                    return false;
                }
                return m.id === rawModelId;
            });
            return matchedModel;
        }

        // 无法解析前缀，当作普通 ID 处理
        return this.providerConfig.models.find(m => m.id === model.id);
    }

    /**
     * 解析模型的 family 标识
     * 优先级：模型配置的 family 字段 > 根据 sdkMode 和模型 ID 自动推断
     */
    protected resolveFamily(model: ModelConfig): string {
        // 优先使用模型配置的 family 字段
        if (model.family) {
            return model.family;
        }

        // 根据 sdkMode 自动推断默认值
        const sdkMode = model.sdkMode || 'openai';
        const modelId = (model.model || model.id).toLowerCase();
        switch (sdkMode) {
            case 'anthropic':
                return 'claude-sonnet-4.6';
            case 'gemini-sse':
                return 'gemini-3-pro';
            case 'openai-responses':
                return 'gpt-5.2';
            case 'openai':
            case 'openai-sse':
            default:
                // openai/openai-sse: 如果模型 ID/名称包含 gpt，使用 gpt-5.2，否则使用 claude-sonnet-4.6
                return modelId.includes('gpt') ? 'gpt-5.2' : 'claude-sonnet-4.6';
        }
    }

    static configedProviders = new Set<string>();

    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // Logger.trace(`[${this.providerKey}] 提供模型列表请求，选项: ` + JSON.stringify(options));

        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        // 检查 API 密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        if (!options.silent || !hasApiKey) {
            Logger.debug(`[${this.providerKey}] 检查 API 密钥: ${hasApiKey ? '已配置' : '未配置'}`);

            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (!hasApiKey && options.silent) {
                return [];
            }

            Logger.info(`[${this.providerKey}] 需要配置 API 密钥`);

            // 非静默模式下，直接触发API密钥设置
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.setApiKey`);
            // 重新检查API密钥
            const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerKey);
            if (!hasApiKeyAfterSet) {
                // 如果用户取消设置或设置失败，返回空列表
                return [];
            }
        }

        // 快速路径：检查缓存
        try {
            const apiKeyHash = await this.getApiKeyHash();
            const cachedModels = await this.modelInfoCache?.getCachedModels(this.providerKey, apiKeyHash);

            if (cachedModels) {
                Logger.trace(`✓ [${this.providerKey}] 从缓存返回模型列表 ` + `(${cachedModels.length} 个模型)`);

                return cachedModels;
            }
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] 缓存查询失败，降级到原始逻辑:`,
                err instanceof Error ? err.message : String(err)
            );
        }

        // 将配置中的模型转换为VS Code所需的格式
        const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

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

    /**
     * 获取当前请求的重试配置
     */
    protected getRequestRetryConfig() {
        return {
            maxAttempts: ConfigManager.getRetryMaxAttempts(),
            initialDelayMs: 1000,
            maxDelayMs: 30000
        };
    }

    /**
     * 获取 SDK 显示名称
     */
    protected getSdkDisplayName(sdkMode: NonNullable<ModelConfig['sdkMode']> | 'openai'): string {
        if (sdkMode === 'anthropic') {
            return 'Anthropic SDK';
        }
        if (sdkMode === 'openai-sse') {
            return 'OpenAI SSE';
        }
        if (sdkMode === 'openai-responses') {
            return 'OpenAI Responses API';
        }
        if (sdkMode === 'gemini-sse') {
            return 'Gemini SSE';
        }
        return 'OpenAI SDK';
    }

    /**
     * 判断请求错误是否允许重试
     */
    protected shouldRetryRequest(error: RetryableError): boolean {
        return RetryManager.isRateLimitError(error);
    }

    /**
     * 执行模型请求，并统一应用重试机制
     */
    protected async executeModelRequest(
        model: LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken,
        requestId: string | null,
        effectiveProviderKey = modelConfig.provider || this.providerKey
    ): Promise<void> {
        const sdkMode = modelConfig.sdkMode || 'openai';
        const retryManager = new RetryManager(this.getRequestRetryConfig());

        await retryManager.executeWithRetry(
            async () => {
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
            },
            error => this.shouldRetryRequest(error),
            this.providerConfig.displayName
        );
    }

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
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                token,
                requestId,
                effectiveProviderKey
            );
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
            const promptParts = await PromptAnalyzer.analyzePromptParts(
                this.providerKey,
                model,
                messages,
                modelConfig,
                options
            );

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
