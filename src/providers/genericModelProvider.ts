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
    createLanguageModelChatInformation,
    Logger,
    ModelInfoCache,
    PromptAnalyzer,
    RetryManager,
    TokenCounter
} from '../utils';
import { getEffectiveMaxInputTokens } from '../utils/languageModelInfo';
import type { RetryableError } from '../utils';
import { OpenAIHandler } from '../handlers/openaiHandler';
import { OpenAICustomHandler } from '../handlers/openaiCustomHandler';
import { AnthropicHandler } from '../handlers/anthropicHandler';
import { GeminiHandler } from '../handlers/geminiHandler';
import { ContextUsageStatusBar } from '../status/contextUsageStatusBar';
import { TokenUsagesManager } from '../usages/usagesManager';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';
import { getAllStatefulMarkersAndIndicies } from '../handlers/statefulMarker';
import * as crypto from 'node:crypto';

interface ContextUsageSummary {
    totalInputTokens: number;
    maxInputTokens: number;
}

interface RuntimeModelOptionsTelemetry {
    _capturingTokenCorrelationId?: string;
    _otelTraceContext?: {
        traceId?: string;
        spanId?: string;
    };
}

type RuntimeProvideLanguageModelChatResponseOptions = ProvideLanguageModelChatResponseOptions & {
    modelOptions?: RuntimeModelOptionsTelemetry;
};

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
                    .catch(err => Logger.warn(`[${this.providerKey}] Failed to clear cache:`, err));
                Logger.trace(`${this.providerKey} configuration updated`);
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

        // 延迟触发模型信息变更事件，确保所有提供商都已注册完成后重新报告一次模型列表
        setTimeout(() => {
            this._onDidChangeLanguageModelChatInformation.fire();
        }, 2000);
    }

    /**
     * 释放资源
     */
    dispose(): void {
        // 释放配置监听器
        this.configListener?.dispose();
        // 释放事件发射器
        this._onDidChangeLanguageModelChatInformation.dispose();
        Logger.info(`🧹 ${this.providerConfig.displayName}: extension disposed`);
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
        Logger.trace(`${providerConfig.displayName} model extension activated`);
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
     * 根据已配置的 API Key 过滤模型列表
     * 仅返回对应密钥已配置的模型
     * @param models 要过滤的模型配置列表
     * @returns 过滤后的模型配置列表（仅包含对应密钥已配置的模型）
     */
    protected async filterModelsByAvailableKeys(models: ModelConfig[]): Promise<ModelConfig[]> {
        const filteredModels: ModelConfig[] = [];
        const checkedKeys = new Map<string, boolean>();

        for (const model of models) {
            const keyProvider = model.provider || this.providerKey;

            // 缓存检查结果，避免重复查询 SecretStorage
            if (!checkedKeys.has(keyProvider)) {
                const hasKey = await ApiKeyManager.hasValidApiKey(keyProvider);
                checkedKeys.set(keyProvider, hasKey);
            }

            if (checkedKeys.get(keyProvider)) {
                filteredModels.push(model);
            } else {
                Logger.debug(
                    `[${this.providerKey}] Model ${model.id} (requires ${keyProvider} key) filtered out - key not configured`
                );
            }
        }

        return filteredModels;
    }

    /**
     * 将ModelConfig转换为LanguageModelChatInformation
     */
    protected modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        return createLanguageModelChatInformation(model, {
            providerKey: this.providerKey,
            providerDisplayName: this.providerConfig.displayName,
            family: this.resolveFamily(model)
        });
    }

    /**
     * 根据 LanguageModelChatInformation 查找对应的 ModelConfig
     * 支持带前缀的模型ID解析（如 gcmp.zhipu:::glm-4.6）
     * @param model 从VS Code模型选择器获取的模型信息（model.id 可能带前缀）
     * @returns 找到的ModelConfig，若未找到则返回undefined
     */
    protected findModelConfigById(model: LanguageModelChatInformation): ModelConfig | undefined {
        // 前缀格式：gcmp.${provider}:::${modelId}
        const prefixSeparator = ':::';
        // 直接捕获不带 gcmp. 前缀的 provider key（支持中文字符）
        const prefixRegex = /^gcmp\.([^:]+?):::(.+)$/;

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
        switch (sdkMode) {
            case 'gemini-sse':
                return 'gemini-3-pro';
            // 默认全部归为 claude-sonnet-4.6 系列，用户可以通过 family 字段覆盖
            case 'anthropic':
            default:
                return 'claude-sonnet-4.6';
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
            Logger.debug(`[${this.providerKey}] Checking API key: ${hasApiKey ? 'configured' : 'not configured'}`);

            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (!hasApiKey && options.silent) {
                return [];
            }

            Logger.info(`[${this.providerKey}] API key configuration is required`);

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
                Logger.trace(`✓ [${this.providerKey}] Returning model list from cache (${cachedModels.length} models)`);

                return cachedModels;
            }
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] Cache lookup failed, falling back to direct logic:`,
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
            Logger.warn(`[${this.providerKey}] Failed to save cache:`, err);
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
                    `[${this.providerKey}] Background cache update failed:`,
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
                `[${this.providerKey}] Failed to compute API key hash:`,
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
        requestId: string,
        sessionId: string,
        token: CancellationToken,
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
                        requestId,
                        sessionId,
                        token
                    );
                } else if (sdkMode === 'gemini-sse') {
                    await this.geminiHandler.handleRequest(
                        model,
                        modelConfig,
                        messages,
                        options,
                        progress,
                        requestId,
                        sessionId,
                        token
                    );
                } else if (sdkMode === 'openai-sse') {
                    await this.openaiCustomHandler.handleRequest(
                        model,
                        modelConfig,
                        messages,
                        options,
                        progress,
                        requestId,
                        sessionId,
                        token
                    );
                } else if (sdkMode === 'openai-responses') {
                    await this.openaiResponsesHandler.handleResponsesRequest(
                        model,
                        { ...modelConfig, provider: effectiveProviderKey },
                        messages,
                        options,
                        progress,
                        requestId,
                        sessionId,
                        token
                    );
                } else {
                    await this.openaiHandler.handleRequest(
                        model,
                        modelConfig,
                        messages,
                        options,
                        progress,
                        requestId,
                        sessionId,
                        token
                    );
                }
            },
            error => this.shouldRetryRequest(error),
            this.providerConfig.displayName
        );
    }

    protected getEstimatedRequestMetadata(options: ProvideLanguageModelChatResponseOptions): {
        requestInitiator?: string;
        capturingTokenCorrelationId?: string;
        otelTraceContext?: {
            traceId: string;
            spanId: string;
        };
    } {
        const runtimeOptions = options as RuntimeProvideLanguageModelChatResponseOptions;
        const otelTraceContext = runtimeOptions.modelOptions?._otelTraceContext;

        return {
            requestInitiator: options.requestInitiator,
            capturingTokenCorrelationId: runtimeOptions.modelOptions?._capturingTokenCorrelationId,
            otelTraceContext:
                otelTraceContext?.traceId && otelTraceContext?.spanId ?
                    {
                        traceId: otelTraceContext.traceId,
                        spanId: otelTraceContext.spanId
                    }
                :   undefined
        };
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

        // 根据模型配置中的 provider 字段确定实际使用的提供商
        // 这样可以正确处理同一提供商下不同模型使用不同密钥的情况
        const effectiveProviderKey = modelConfig.provider || this.providerKey;

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
        // 提取或生成 sessionId（根据 sdkMode，新会话时生成 UUID）
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sessionId = this.getSessionIdFromMessages(messages, sdkMode);
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: effectiveProviderKey,
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
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(
            `${this.providerConfig.displayName} Provider started handling request (${sdkName}): ${modelConfig.name}`
        );

        try {
            // 确保对应提供商的 API 密钥存在
            await ApiKeyManager.ensureApiKey(effectiveProviderKey, this.providerConfig.displayName);

            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                requestId,
                sessionId,
                token,
                effectiveProviderKey
            );
        } catch (error) {
            const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            Logger.error(errorMessage);
            // === Token 统计: 更新失败状态（仅在最终失败时上报）===
            this.reportRequestFailure(requestId, sessionId);
            // 直接抛出错误，让VS Code处理重试
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }

    /**
     * 从消息中提取或生成 sessionId
     * 优先从已有 statefulMarker 中提取，不存在时根据 sdkMode 生成新的 UUID
     * @param messages 聊天消息数组
     * @param sdkMode SDK 模式（如 'openai', 'anthropic' 等），用于新会话时生成 sessionId
     * @returns 会话ID
     */
    protected getSessionIdFromMessages(
        messages: readonly LanguageModelChatMessage[],
        _sdkMode: string = 'openai'
    ): string {
        for (const result of getAllStatefulMarkersAndIndicies(messages)) {
            let sessionId = result.statefulMarker?.marker?.sessionId;
            if (sessionId) {
                // 向后兼容旧 anthropic 格式：user_xxx_account__session_UUID → UUID
                const sessionIdx = sessionId.lastIndexOf('_session_');
                if (sessionIdx !== -1) {
                    sessionId = sessionId.slice(sessionIdx + '_session_'.length);
                    Logger.debug(`Backward compat: extracted UUID from old sessionId format: ${sessionId}`);
                }
                return sessionId;
            }
        }
        // 统一生成短格式 sessionId（UUID），各 handler 按需在 metadata 处拼接扩展格式
        return crypto.randomUUID();
    }

    /**
     * 上报请求失败状态到 Token 统计系统
     * 在 Provider 层统一处理，避免重试中间态被误记为失败
     * @param requestId 请求ID
     * @param sessionId 会话ID
     */
    protected reportRequestFailure(requestId: string, sessionId: string): void {
        if (!requestId) {
            return;
        }
        try {
            const usagesManager = TokenUsagesManager.instance;
            usagesManager
                .updateActualTokens({
                    requestId,
                    sessionId,
                    status: 'failed'
                })
                .catch(err => {
                    Logger.warn('Failed to update token usage failure status:', err);
                });
        } catch (err) {
            Logger.warn('Failed to report request failure:', err);
        }
    }

    /**
     * 提供 token 计数
     */
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
     * @returns 返回计算的输入 token 数量及当前生效的上下文窗口大小，供 Token 统计使用
     */
    protected async updateContextUsageStatusBar(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<ContextUsageSummary> {
        try {
            const promptParts = await PromptAnalyzer.analyzePromptParts(
                this.providerKey,
                model,
                messages,
                modelConfig,
                options
            );

            // 使用 promptParts.context 作为总 token 占用
            const totalInputTokens = promptParts.context || 0;
            const maxInputTokens = getEffectiveMaxInputTokens(model, modelConfig, options, this.providerKey);
            const percentage = maxInputTokens > 0 ? (totalInputTokens / maxInputTokens) * 100 : 0;

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

            if (totalInputTokens > maxInputTokens) {
                Logger.warn(
                    `[${this.providerKey}] Estimated context exceeds current contextSize: ${totalInputTokens}/${maxInputTokens}`
                );
            } else {
                Logger.debug(
                    `[${this.providerKey}] Token calc: ${totalInputTokens}/${maxInputTokens} (${percentage.toFixed(1)}%)`
                );
            }
            return { totalInputTokens, maxInputTokens };
        } catch (error) {
            // Token 计算失败不应阻止请求，只记录警告
            Logger.warn(`[${this.providerKey}] Token calculation failed:`, error);
            return {
                totalInputTokens: 0,
                maxInputTokens: getEffectiveMaxInputTokens(model, modelConfig, options, this.providerKey)
            };
        }
    }
}
