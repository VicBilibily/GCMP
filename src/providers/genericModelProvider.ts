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
import { RateLimiter, type RateLimitHandle } from '../rateLimit/rateLimiter';
import { sanitizeAuthoritativeDims } from '../rateLimit/rateLimitStore';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ConfigManager } from '../utils/config/configManager';
import { createLanguageModelChatInformation } from '../utils/model/languageModelInfo';
import { isCancellationError } from '../utils/text/cancellationError';
import { Logger } from '../utils/runtime/logger';
import { ModelInfoCache } from '../utils/model/modelInfoCache';
import { PromptAnalyzer } from '../utils/model/promptAnalyzer';
import { RetryManager } from '../utils/retry/retryManager';
import { TokenCounter } from '../utils/model/tokenCounter';
import { getEffectiveMaxInputTokens, getEffectiveContextWindow } from '../utils/model/languageModelInfo';
import type { RetryableError } from '../utils/retry/retryManager';
import * as liveMetrics from '../handlers/liveMetrics';
import { OpenAIHandler } from '../handlers/openaiHandler';
import { OpenAICustomHandler } from '../handlers/openaiCustomHandler';
import { AnthropicHandler } from '../handlers/anthropicHandler';
import { getAnthropicRetryDelayMs, shouldRetryAnthropicRequest } from '../handlers/anthropic/anthropicRetry';
import { ContextUsageStatusBar } from '../status/contextUsageStatusBar';
import { TokenUsagesManager } from '../usages/usagesManager';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';
import { getAllStatefulMarkersAndIndicies } from '../handlers/statefulMarker';
import { classifyRequest } from '../handlers/requestClassifier';
import { SessionTitleService } from '../usages/sessionTitleService';
import { SessionRecoveryService } from '../usages/sessionRecoveryService';
import { VisionCache } from '../tools/vision/cache';
import { processVisionMessages } from '../tools/vision/messageProcessor';
import { FilesApiClient } from './files/filesApiClient';
import { ImageFileResolver } from './files/imageFileResolver';
import { resolveFilesApiImages } from './files/messagePreprocessor';
import { StatusBarManager } from '../status/statusBarManager';
import * as crypto from 'node:crypto';
import type { SessionRecoverySource } from '../usages/fileLogger/types';

interface ContextUsageSummary {
    totalInputTokens: number;
    maxInputTokens: number;
    /** 增量预估模式下，本次新增 token 数 (delta) */
    estimatedIncrement?: number;
}

interface RuntimeModelOptionsTelemetry {
    _capturingTokenCorrelationId?: string;
    _otelTraceContext?: {
        traceId?: string;
        spanId?: string;
    };
    _telemetryTurn?: number;
    /** 运行时注入的请求来源类型，供 handler 消费 */
    requestKind?: string;
}

type RuntimeProvideLanguageModelChatResponseOptions = ProvideLanguageModelChatResponseOptions & {
    modelOptions?: RuntimeModelOptionsTelemetry;
};

function isSubagentRequestKind(requestKind?: string): boolean {
    return requestKind === 'search-subagent' || requestKind === 'execution-subagent';
}

function shouldPublishResolvedCrossProviderTraceHint(requestKind?: string): boolean {
    return requestKind === 'main-agent' || requestKind === 'summarization' || isSubagentRequestKind(requestKind);
}

function shouldPublishNewSessionCrossProviderTraceHint(requestKind?: string): boolean {
    return requestKind === 'main-agent' || requestKind === 'summarization';
}

function shouldPublishNewSessionProviderTraceHint(requestKind?: string): boolean {
    return requestKind === 'main-agent' || requestKind === 'summarization';
}

interface EstimatedRequestTrackingParams {
    providerKey: string;
    displayName: string;
    model: LanguageModelChatInformation;
    modelConfig: ModelConfig;
    estimatedInputTokens: number;
    estimatedIncrement?: number;
    maxInputTokens?: number;
    requestKind?: string;
    sessionId: string;
    sessionRecoverySource?: SessionRecoverySource;
    options: ProvideLanguageModelChatResponseOptions;
    timestamp?: number;
}

interface PreparedTrackedRequestContext extends ContextUsageSummary {
    requestKind: string;
    sessionId: string;
    sessionRecoverySource: SessionRecoverySource;
    sdkMode: NonNullable<ModelConfig['sdkMode']> | 'openai';
}

interface SessionIdResolution {
    sessionId: string;
    sessionRecoverySource: SessionRecoverySource;
}

/**
 * 通用模型提供商类
 * 基于配置文件动态创建提供商实现
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    protected readonly openaiHandler: OpenAIHandler;
    protected readonly openaiCustomHandler: OpenAICustomHandler;
    protected readonly openaiResponsesHandler: OpenAIResponsesHandler;
    protected readonly anthropicHandler: AnthropicHandler;
    protected readonly providerKey: string;
    protected baseProviderConfig: ProviderConfig; // protected 以支持子类访问
    protected cachedProviderConfig: ProviderConfig; // 缓存的配置
    protected configListener?: vscode.Disposable; // 配置监听器
    protected modelInfoCache?: ModelInfoCache; // 模型信息缓存
    protected visionCache?: VisionCache; // 图片缓存服务
    protected readonly extensionContext: vscode.ExtensionContext;
    protected filesApiResolver?: ImageFileResolver; // Files API 图片解析器

    // 模型信息变更事件
    protected _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        this.providerKey = providerKey;
        this.extensionContext = context;
        // 保存原始配置（不应用覆盖）
        this.baseProviderConfig = providerConfig;
        // 初始化缓存配置（应用覆盖）
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, this.baseProviderConfig);
        // 初始化模型信息缓存
        this.modelInfoCache = new ModelInfoCache(context);
        // 初始化图片缓存
        if (context.storageUri) {
            this.visionCache = new VisionCache(context.storageUri);
        }

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
        // 清理视觉缓存文件
        this.visionCache?.clearAll();
        Logger.info(`🧹 ${this.providerConfig.displayName}: extension disposed`);
    }

    /**
     * 清除模型缓存并通知 VS Code 重新加载模型列表
     * 供外部（如 SyncManager / ConfigSetManager）在 API Key 变更后调用
     * @param slot 要失效的缓存槽位（缺省 = 主 providerKey）；变体 slot（如 minimax-token）需显式指定
     */
    invalidateAndNotify(slot?: string): void {
        const targetSlot = slot ?? this.providerKey;
        this.modelInfoCache
            ?.invalidateCache(targetSlot)
            .catch(err => Logger.warn(`[${this.providerKey}] Failed to clear cache for ${targetSlot}:`, err));
        this._onDidChangeLanguageModelChatInformation.fire();
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
     * 获取模型对应的 provider key（考虑 provider 字段和默认值）
     * 优先使用模型特定的 provider 字段，否则使用提供商默认的 provider key
     */
    protected getProviderKeyForModel(modelConfig: ModelConfig): string {
        if (modelConfig.provider) {
            return modelConfig.provider;
        }
        return this.providerKey;
    }

    /**
     * 解析请求最终使用的 baseUrl（含接入点/站点切换）。
     * 默认合并模型级与提供商级配置；专用 provider 可覆盖以应用站点域名替换。
     */
    protected resolveRequestBaseUrl(modelConfig: ModelConfig): string | undefined {
        return modelConfig.baseUrl || this.providerConfig.baseUrl;
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
                // Logger.trace(
                //     `[${this.providerKey}] Model ${model.id} (requires ${keyProvider} key) filtered out - key not configured`
                // );
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
     * 确保请求分类已注入到 runtime modelOptions。
     * 上层已设置 requestKind 时直接复用，避免重复分类或被后续消息改写。
     */
    protected ensureRequestKind(
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions
    ): string {
        const rtOpts = options as RuntimeProvideLanguageModelChatResponseOptions;
        if (!rtOpts.modelOptions) {
            rtOpts.modelOptions = {};
        }
        if (!rtOpts.modelOptions.requestKind) {
            rtOpts.modelOptions.requestKind = classifyRequest(messages, options.tools);
        }
        return rtOpts.modelOptions.requestKind;
    }

    /**
     * 统一准备请求分类、上下文估算和 session 跟踪上下文，避免各 provider 重复拼装。
     */
    protected async prepareTrackedRequestContext(
        model: LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions
    ): Promise<PreparedTrackedRequestContext> {
        const requestKind = this.ensureRequestKind(messages, options);
        const { totalInputTokens, maxInputTokens, estimatedIncrement } = await this.updateContextUsageStatusBar(
            model,
            messages,
            modelConfig,
            options
        );
        const sdkMode = modelConfig.sdkMode || 'openai';
        const { sessionId, sessionRecoverySource } = this.getSessionIdFromMessages(
            messages,
            sdkMode,
            requestKind,
            options,
            this.getProviderKeyForModel(modelConfig)
        );
        await this.prepareRequestSession(sessionId, messages, {
            skipHistoricalHydrate: sessionRecoverySource === 'new-uuid'
        });
        return {
            requestKind,
            sessionId,
            sessionRecoverySource,
            sdkMode,
            totalInputTokens,
            maxInputTokens,
            estimatedIncrement
        };
    }

    /**
     * 根据 LanguageModelChatInformation 查找对应的 ModelConfig
     * 支持带前缀的模型ID解析（如 gcmp.zhipu:::glm-4.7）
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
     * 获取当前请求的重试配置。
     *
     * 三层优先级（字段级合并）：
     *   1. providerOverrides.{rootOrExact}["retry.{effectiveProviderKey}"] → providerOverrides.{rootOrExact}.retry
     *   2. configProviders.{rootOrExact}["retry.{effectiveProviderKey}"] → configProviders.{rootOrExact}.retry
     *   3. 全局 gcmp.retry.*                                  （最低优先级）
     *
     * override 路径支持特殊语义：maxAttempts = -1 无限重试、0 禁止重试，且不受 1-10 全局上限约束。
     *
     * @param effectiveProviderKey 用于查找 override 的 provider key，默认使用 this.providerKey
     */
    protected getRequestRetryConfig(effectiveProviderKey?: string) {
        const key = effectiveProviderKey ?? this.providerKey;
        Logger.debug(
            `[Config/Retry] getRequestRetryConfig: effectiveProviderKey="${effectiveProviderKey}", fallback=this.providerKey="${this.providerKey}", resolved key="${key}"`
        );
        return ConfigManager.getProviderRetryConfig(key);
    }

    /**
     * 限流闸门：解析 provider + model 级 limit 配置，向跨实例限流器申请配额。
     * 返回 undefined 表示当前请求未启用限流。
     * 等待期间取消会全额退款并抛 CancellationError（由 RateLimiter 内部处理）。
     */
    protected async acquireRateLimit(
        effectiveProviderKey: string,
        modelConfig: ModelConfig,
        totalInputTokens: number,
        token: CancellationToken,
        requestId: string,
        onThrottled?: () => void
    ): Promise<RateLimitHandle | undefined> {
        const providerLimit = ConfigManager.getProviderRateLimitConfig(effectiveProviderKey);
        const modelLimit = modelConfig.limit;
        const hasModelLimitOverride = !!modelLimit && Object.keys(modelLimit).length > 0;
        const sanitized = sanitizeAuthoritativeDims(providerLimit, hasModelLimitOverride ? modelLimit : undefined);
        if (sanitized === undefined) {
            throw new Error(`Invalid rate limit configuration for ${effectiveProviderKey}`);
        } else if (Object.keys(sanitized).length === 0) {
            return undefined;
        }
        const dims = sanitized ?? {};
        // model 级配置存在时使用独立桶
        const bucketKey = hasModelLimitOverride ? `${effectiveProviderKey}::${modelConfig.id}` : effectiveProviderKey;
        // 边界防御：手写配置缺失/非法产生的 NaN 成本会污染 GCRA 预约队列并导致 sleep 忙循环
        const maxOutputTokens = Number.isFinite(modelConfig.maxOutputTokens) ? modelConfig.maxOutputTokens : 0;
        const outputReserve = Math.min(Math.max(maxOutputTokens, 0), 4096);
        const costs = { requests: 1, tokens: totalInputTokens + outputReserve };
        if (!Number.isFinite(costs.tokens)) {
            Logger.warn(
                `[RateLimit] Skip rate limiting for ${bucketKey}: non-finite token cost (totalInputTokens=${totalInputTokens})`
            );
            return undefined;
        }
        let notifiedWaiting = false;
        return RateLimiter.acquire(bucketKey, dims, costs, {
            token,
            onWaiting: event => {
                // 首次真正等待就立刻上报，避免先闪 ACTIVE 再等队列更新
                if (!notifiedWaiting) {
                    notifiedWaiting = true;
                    onThrottled?.();
                }
                liveMetrics.emitLiveMetrics({
                    type: 'rateLimitWaiting',
                    requestId,
                    providerName: this.providerConfig.displayName,
                    modelName: modelConfig.name,
                    ...event
                });
            }
        });
    }

    /**
     * 解析 Files API 完整上传地址：endpoint 完整 URL 直接用，相对路径拼 baseUrl，未配置默认 {baseUrl}/files。
     */
    private resolveFilesApiUploadUrl(modelConfig: ModelConfig): string | undefined {
        const filesApi = typeof modelConfig.filesApi === 'object' ? modelConfig.filesApi : undefined;
        // 顶层 filesApiEndpoint 优先，其次嵌套 filesApi.endpoint
        const endpoint = modelConfig.filesApiEndpoint ?? filesApi?.endpoint;
        const baseUrl = (modelConfig.baseUrl || this.providerConfig?.baseUrl)?.replace(/\/$/, '');
        if (!endpoint) {
            return baseUrl ? `${baseUrl}/files` : undefined;
        }
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
            return endpoint;
        }
        if (!baseUrl) {
            return undefined;
        }
        return `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    }

    /**
     * 解析 Files API 临时保存时长：默认 2592000 秒（30 天），clamp 到 3600~2592000。
     */
    private resolveFilesApiTtl(modelConfig: ModelConfig): number {
        const filesApi = typeof modelConfig.filesApi === 'object' ? modelConfig.filesApi : undefined;
        const ttl = filesApi?.ttlSeconds ?? 2592000;
        return Math.min(Math.max(ttl, 3600), 2592000);
    }

    /**
     * 懒建 Files API 图片解析器（独立 HTTP 上传客户端，按首次使用的模型配置缓存）。
     */
    protected async ensureFilesApiResolver(modelConfig: ModelConfig): Promise<ImageFileResolver> {
        if (!this.filesApiResolver) {
            const uploadUrl = this.resolveFilesApiUploadUrl(modelConfig);
            const apiKey = await ApiKeyManager.getApiKey(modelConfig.provider || this.providerKey);
            if (!apiKey) {
                throw new Error(`Missing ${this.providerConfig.displayName} API key for Files API`);
            }
            if (!uploadUrl) {
                throw new Error(`Missing ${this.providerConfig.displayName} baseUrl for Files API upload`);
            }
            const proxyUrl = ConfigManager.resolveProxyForModel(modelConfig, this.providerKey);
            // 独立 HTTP 上传：不走任何 SDK 内置 files API（customFetch 的 SSE 预处理会误判 JSON 响应）
            const fetchFn = ConfigManager.createProxyAwareFetch({ proxyUrl });
            this.filesApiResolver = new ImageFileResolver(
                new FilesApiClient({ apiKey, uploadUrl, fetchFn }),
                this.extensionContext.workspaceState
            );
        }
        return this.filesApiResolver;
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
        return 'OpenAI SDK';
    }

    /**
     * 判断请求错误是否允许重试
     * 包括：429/529 限流错误、5xx 服务端错误（502/503/504）、网络连接中断错误（如 terminated）
     */
    protected shouldRetryRequest(error: RetryableError): boolean {
        // Compatible 网关透传的单账号套餐限额（usage_limit_reached 等）经重试切换路由即可恢复，
        const skipPermanentCheck = this.providerKey === 'compatible';
        return (
            RetryManager.isRateLimitError(error, { skipPermanentCheck }) ||
            RetryManager.isServerError(error) ||
            RetryManager.isNetworkError(error)
        );
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
        effectiveProviderKey = modelConfig.provider || this.providerKey,
        requestStartTime = Date.now(),
        totalInputTokens = 0,
        onAttemptStarted?: (requestMetricStartTime: number) => void,
        onThrottled?: () => void
    ): Promise<void> {
        // 站点/接入点切换统一在 provider 层解析，经浅拷贝下发避免污染共享配置
        modelConfig = { ...modelConfig, baseUrl: this.resolveRequestBaseUrl(modelConfig) };
        const sdkMode = modelConfig.sdkMode || 'openai';

        // requestStarted 不再在外层发射，而是移入 retry callback 内部，
        // 每次 attempt 使用 liveAttemptStartTime 作为 live metrics 时间基准。
        // 外层 requestStartTime 保留给 recordEstimatedTokens / 持久化记录使用。

        const retryManager = new RetryManager(this.getRequestRetryConfig(effectiveProviderKey));

        // 请求是否受过节流控制（限流等待/排队，跨 retry 累积）。
        let wasThrottled = false;

        // 失败路径也要依赖真实派发时间补齐延迟统计。
        const handleAttemptStarted = (attemptStartedAt: number) => {
            onAttemptStarted?.(attemptStartedAt);
            if (requestId) {
                liveMetrics.emitLiveMetrics({
                    type: 'requestStarted',
                    requestId,
                    requestStartTime: attemptStartedAt,
                    providerName: this.providerConfig.displayName,
                    modelName: model.name || modelConfig.name
                });
            }
        };

        const requestKind = this.ensureRequestKind(messages, options);

        // Files API：imageInput 且 filesApi 启用的模型，图片上传后转为 file_id 引用
        if (modelConfig.capabilities?.imageInput && modelConfig.filesApi) {
            try {
                const resolver = await this.ensureFilesApiResolver(modelConfig);
                const ttl = this.resolveFilesApiTtl(modelConfig);
                await resolveFilesApiImages(messages, resolver, ttl, sessionId);
            } catch (err) {
                Logger.warn('[FilesAPI] Failed to resolve images:', err instanceof Error ? err.message : String(err));
            }
        } else if (this.visionCache && !modelConfig.capabilities?.imageInput) {
            // 处理消息中的图片 DataPart（仅对 imageInput: false 的模型生效）
            try {
                await processVisionMessages(messages, sessionId, this.visionCache, modelConfig);
            } catch (err) {
                Logger.warn(
                    '[VisionProcessor] Failed to process images:',
                    err instanceof Error ? err.message : String(err)
                );
            }
        }

        // 重试消息的 disposable，模型开始返回数据时立即清除；流程结束时兜底释放
        let retryMessageDisposable: vscode.Disposable | undefined;

        // chat-title 请求：额外累积响应文本，请求成功后回填会话标题
        const isTitleRequest = requestKind === 'chat-title';
        const isSummarizationRequest = requestKind === 'summarization';
        const titleRequestRawText =
            isTitleRequest ? SessionTitleService.extractTitleGenerationRequestText(messages) : undefined;
        let titleResponseBuffer = '';
        let summaryResponseBuffer = '';
        let hasReportedProgress = false;
        const requestMetadata = this.getEstimatedRequestMetadata(options);

        try {
            // 包装 progress：首次 report 时清除重试消息
            const wrappedProgress: Progress<vscode.LanguageModelResponsePart> = {
                report: (value: vscode.LanguageModelResponsePart) => {
                    retryMessageDisposable?.dispose();
                    retryMessageDisposable = undefined;
                    hasReportedProgress = true;
                    if (isTitleRequest && value instanceof vscode.LanguageModelTextPart) {
                        titleResponseBuffer += value.value;
                    }
                    if (isSummarizationRequest && value instanceof vscode.LanguageModelTextPart) {
                        summaryResponseBuffer += value.value;
                    }
                    progress.report(value);
                }
            };

            await retryManager.executeWithRetry(
                async () => {
                    // 标题响应按 attempt 独立累积，避免重试时拼接上一轮的半截文本
                    titleResponseBuffer = '';
                    summaryResponseBuffer = '';

                    // 限流闸门：任一维度触顶即自主延迟；重试也会重新取令牌（文档铁律）
                    const limitHandle = await this.acquireRateLimit(
                        effectiveProviderKey,
                        modelConfig,
                        totalInputTokens,
                        token,
                        requestId,
                        () => {
                            wasThrottled = true;
                            onThrottled?.();
                        }
                    );

                    try {
                        if (sdkMode === 'anthropic') {
                            await this.anthropicHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                wrappedProgress,
                                requestId,
                                sessionId,
                                token,
                                requestStartTime,
                                handleAttemptStarted,
                                wasThrottled
                            );
                        } else if (sdkMode === 'openai-sse') {
                            await this.openaiCustomHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                wrappedProgress,
                                requestId,
                                sessionId,
                                token,
                                requestStartTime,
                                handleAttemptStarted,
                                wasThrottled
                            );
                        } else if (sdkMode === 'openai-responses') {
                            await this.openaiResponsesHandler.handleResponsesRequest(
                                model,
                                { ...modelConfig, provider: effectiveProviderKey },
                                messages,
                                options,
                                wrappedProgress,
                                requestId,
                                sessionId,
                                token,
                                requestStartTime,
                                handleAttemptStarted,
                                wasThrottled
                            );
                        } else {
                            await this.openaiHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                wrappedProgress,
                                requestId,
                                sessionId,
                                token,
                                requestStartTime,
                                handleAttemptStarted,
                                wasThrottled
                            );
                        }
                        // 成功：释放并发槽位但不退款（v1 不做结算）
                        if (limitHandle) {
                            RateLimiter.release(limitHandle);
                        }
                    } catch (error) {
                        // 已发出后失败/取消：tokens 全退、requests 不退（上游已消耗调度成本）
                        if (limitHandle) {
                            RateLimiter.release(limitHandle, { tokens: limitHandle.costs.tokens });
                        }
                        throw error;
                    }
                },
                error => {
                    if (hasReportedProgress) {
                        return false;
                    }
                    const fallback = this.shouldRetryRequest(error);
                    return sdkMode === 'anthropic' ? shouldRetryAnthropicRequest(error, fallback) : fallback;
                },
                this.providerConfig.displayName,
                {
                    shouldCancel: () => token.isCancellationRequested,
                    getRetryDelayMs: sdkMode === 'anthropic' ? getAnthropicRetryDelayMs : undefined,
                    onRetryScheduled: (attempt, maxAttempts, delayMs) => {
                        retryMessageDisposable?.dispose();
                        const maxLabel = maxAttempts === -1 ? '∞' : `${maxAttempts}`;
                        const modelName = model.name || modelConfig.name;
                        const delaySec = Math.ceil(delayMs / 1000);
                        retryMessageDisposable = vscode.window.setStatusBarMessage(
                            `$(sync~spin) ${modelName} retry #${attempt}/${maxLabel} in ${delaySec}s`
                        );
                    },
                    onRetryAttempt: (attempt, maxAttempts) => {
                        retryMessageDisposable?.dispose();
                        const maxLabel = maxAttempts === -1 ? '∞' : `${maxAttempts}`;
                        const modelName = model.name || modelConfig.name;
                        retryMessageDisposable = vscode.window.setStatusBarMessage(
                            `$(sync~spin) ${modelName} retry #${attempt}/${maxLabel}...`
                        );
                    }
                }
            );

            if (isSummarizationRequest && summaryResponseBuffer.trim()) {
                SessionRecoveryService.instance.rememberSummarization(sessionId, summaryResponseBuffer, {
                    providerKey: effectiveProviderKey,
                    telemetryTurn: requestMetadata.telemetryTurn,
                    traceId: requestMetadata.otelTraceContext?.traceId
                });
            }

            // chat-title 请求成功：以原始请求文本为匹配键，把会话标题升级为 VS Code 面板正式标题
            if (isTitleRequest && titleResponseBuffer.trim()) {
                try {
                    if (titleRequestRawText) {
                        const resolved = SessionTitleService.instance.resolveGeneratedTitleDetails(
                            titleRequestRawText,
                            titleResponseBuffer
                        );
                        if (resolved) {
                            await TokenUsagesManager.instance.backfillResolvedSessionTitle(
                                resolved.sessionId,
                                resolved.title,
                                resolved.requestId
                            );
                            TokenUsagesManager.instance.notifyStatsUpdate();
                        }
                    }
                } catch (err) {
                    Logger.debug('Failed to resolve generated session title:', err);
                }
            }
        } finally {
            retryMessageDisposable?.dispose();
            retryMessageDisposable = undefined;

            // 整个重试流程结束后发送 streamEnd，清理 WebView 实时状态
            if (requestId) {
                liveMetrics.emitLiveMetrics({
                    type: 'streamEnd',
                    requestId,
                    requestStartTime,
                    providerName: this.providerConfig.displayName,
                    modelName: model.name || modelConfig.name
                });
            }
        }
    }

    protected getEstimatedRequestMetadata(options: ProvideLanguageModelChatResponseOptions): {
        requestInitiator?: string;
        capturingTokenCorrelationId?: string;
        otelTraceContext?: {
            traceId: string;
            spanId: string;
        };
        telemetryTurn?: number;
    } {
        const runtimeOptions = options as RuntimeProvideLanguageModelChatResponseOptions;
        const otelTraceContext = runtimeOptions.modelOptions?._otelTraceContext;

        return {
            requestInitiator: options.requestInitiator,
            capturingTokenCorrelationId: runtimeOptions.modelOptions?._capturingTokenCorrelationId,
            telemetryTurn: runtimeOptions.modelOptions?._telemetryTurn,
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
        const {
            requestKind,
            totalInputTokens,
            maxInputTokens,
            estimatedIncrement,
            sessionId,
            sessionRecoverySource,
            sdkMode
        } = await this.prepareTrackedRequestContext(model, modelConfig, messages, options);

        // 根据模型的 sdkMode 选择使用的 handler
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(
            `${this.providerConfig.displayName} Provider started handling request (${sdkName}): ${modelConfig.name}`
        );

        let requestId = '';
        let requestStartTime: number;
        let requestMetricStartTime: number | undefined;
        let wasThrottled = false;

        try {
            // 确保对应提供商的 API 密钥存在
            await ApiKeyManager.ensureApiKey(effectiveProviderKey, this.providerConfig.displayName);

            // API Key 确认后开始计时，避免用户输入/授权时间计入实时延迟。
            // 注意：该时间点是 provider 请求处理起点，不是严格的网络请求发出时刻；
            // 可能包含预估 token 记录、请求体构建、SDK/client 初始化、CLI 版本探测等本地准备开销。
            // 因此 live TTFT 表示"provider 开始处理到首个流事件"的近似延迟，
            // 不应在 UI 或日志中描述为"网络请求发出后首流延迟"。
            requestStartTime = Date.now();

            requestId = await this.recordEstimatedRequestTokens({
                providerKey: effectiveProviderKey,
                displayName: this.providerConfig.displayName,
                model,
                modelConfig,
                estimatedInputTokens: totalInputTokens,
                estimatedIncrement,
                maxInputTokens,
                requestKind,
                sessionId,
                sessionRecoverySource,
                options,
                timestamp: requestStartTime
            });

            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                requestId,
                sessionId,
                token,
                effectiveProviderKey,
                requestStartTime,
                totalInputTokens,
                attemptStartedAt => {
                    requestMetricStartTime = attemptStartedAt;
                },
                () => {
                    wasThrottled = true;
                }
            );
        } catch (error) {
            // 取消请求不应记为失败：handler 已记录 cancelled，或在此兜底记录
            if (isCancellationError(error)) {
                this.reportRequestCancelled(requestId, sessionId, requestMetricStartTime, wasThrottled);
                throw new vscode.CancellationError();
            }

            const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            Logger.error(errorMessage);
            // === Token 统计: 更新失败状态（仅在最终失败时上报）===
            this.reportRequestFailure(requestId, sessionId, requestMetricStartTime, wasThrottled);
            // 直接抛出错误，让VS Code处理重试
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);

            try {
                // 通用 provider 也可能绑定独立状态栏（如 deepseek / codex / clinepass）。
                // 请求完成后统一触发一次延迟刷新，让额度/用量类状态栏拉取最新服务端数据。
                StatusBarManager.getStatusBar(effectiveProviderKey)?.delayedUpdate();
            } catch (err) {
                Logger.warn('Failed to update status bar:', err);
            }
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
        _sdkMode: string = 'openai',
        requestKind?: string,
        options?: ProvideLanguageModelChatResponseOptions,
        providerKey = this.providerKey
    ): SessionIdResolution {
        const metadata = options ? this.getEstimatedRequestMetadata(options) : undefined;
        const recoveryMetadata = {
            providerKey,
            telemetryTurn: metadata?.telemetryTurn,
            traceId: metadata?.otelTraceContext?.traceId
        };

        for (const result of getAllStatefulMarkersAndIndicies(messages)) {
            let sessionId = result.statefulMarker?.marker?.sessionId;
            if (sessionId) {
                // 向后兼容旧 anthropic 格式：user_xxx_account__session_UUID → UUID
                const sessionIdx = sessionId.lastIndexOf('_session_');
                if (sessionIdx !== -1) {
                    sessionId = sessionId.slice(sessionIdx + '_session_'.length);
                    Logger.debug(`Backward compat: extracted UUID from old sessionId format: ${sessionId}`);
                }
                SessionRecoveryService.instance.rememberSessionHint(sessionId, recoveryMetadata, undefined, {
                    publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                });
                return {
                    sessionId,
                    sessionRecoverySource: 'stateful-marker'
                };
            }
        }

        if (requestKind === 'main-agent' && options) {
            const recovered = SessionRecoveryService.instance.resolveSessionId(messages, {
                providerKey: recoveryMetadata.providerKey,
                telemetryTurn: recoveryMetadata.telemetryTurn,
                traceId: recoveryMetadata.traceId
            });
            if (recovered) {
                Logger.info(`Recovered sessionId via summary bridge (${recovered.matchType}): ${recovered.sessionId}`);
                SessionRecoveryService.instance.rememberSessionHint(recovered.sessionId, recoveryMetadata, undefined, {
                    publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                });
                return {
                    sessionId: recovered.sessionId,
                    sessionRecoverySource: `summary-bridge-${recovered.matchType}`
                };
            }

            const turnRecoveredSessionId = SessionRecoveryService.instance.resolveSessionIdFromTurn(recoveryMetadata);
            if (turnRecoveredSessionId) {
                Logger.info(`Recovered sessionId via turn bridge: ${turnRecoveredSessionId}`);
                SessionRecoveryService.instance.rememberSessionHint(
                    turnRecoveredSessionId,
                    recoveryMetadata,
                    undefined,
                    {
                        publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                    }
                );
                return {
                    sessionId: turnRecoveredSessionId,
                    sessionRecoverySource: 'turn-bridge'
                };
            }

            // 这里会复用 SessionRecoveryService 内部 turn=1 的唯一候选放宽。
            if (recoveryMetadata.traceId) {
                const crossProviderSessionId =
                    SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(recoveryMetadata);
                if (crossProviderSessionId) {
                    Logger.info(`Recovered sessionId via cross-provider trace bridge: ${crossProviderSessionId}`);
                    SessionRecoveryService.instance.rememberSessionHint(
                        crossProviderSessionId,
                        recoveryMetadata,
                        undefined,
                        {
                            publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                        }
                    );
                    return {
                        sessionId: crossProviderSessionId,
                        sessionRecoverySource: 'trace-bridge'
                    };
                }
            }
        }

        if (requestKind === 'summarization' && recoveryMetadata.traceId) {
            // 同提供商优先；切换模型后压缩请求可能是新提供商在该 trace 下的首个请求，
            // 其提供商维度尚无 hint，需跨提供商回退才能桥接到原会话，避免压缩边界会话分裂。
            const tracedSessionId =
                SessionRecoveryService.instance.resolveSessionIdFromTrace(recoveryMetadata) ??
                SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(recoveryMetadata);
            if (tracedSessionId) {
                Logger.info(`Recovered sessionId via trace bridge: ${tracedSessionId}`);
                SessionRecoveryService.instance.rememberSessionHint(tracedSessionId, recoveryMetadata, undefined, {
                    publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                });
                return {
                    sessionId: tracedSessionId,
                    sessionRecoverySource: 'trace-bridge'
                };
            }
        }

        if (isSubagentRequestKind(requestKind) && recoveryMetadata.traceId) {
            const parentSessionId =
                SessionRecoveryService.instance.resolveSessionIdFromTraceAcrossProviders(recoveryMetadata);
            if (parentSessionId) {
                Logger.info(`Recovered sessionId via subagent trace bridge: ${parentSessionId}`);
                SessionRecoveryService.instance.rememberSessionHint(parentSessionId, recoveryMetadata, undefined, {
                    publishProviderAgnosticTraceHint: shouldPublishResolvedCrossProviderTraceHint(requestKind)
                });
                return {
                    sessionId: parentSessionId,
                    sessionRecoverySource: 'trace-bridge'
                };
            }
        }

        // 统一生成短格式 sessionId（UUID），各 handler 按需在 metadata 处拼接扩展格式。
        // 这里也要立刻登记 trace hint：Copilot 可能在新会话首轮回答后立即触发 summarization，
        // 若不先把“新建 session ↔ 当前 trace”记住，紧随其后的压缩请求会再次掉回 new-uuid。
        const sessionId = crypto.randomUUID();
        const publishNewSessionProviderTraceHint = shouldPublishNewSessionProviderTraceHint(requestKind);
        SessionRecoveryService.instance.rememberSessionHint(
            sessionId,
            recoveryMetadata,
            undefined,
            publishNewSessionProviderTraceHint ?
                {
                    publishProviderAgnosticTraceHint: shouldPublishNewSessionCrossProviderTraceHint(requestKind)
                }
            :   {
                    publishProviderTraceHint: false,
                    publishProviderAgnosticTraceHint: false
                }
        );
        return {
            sessionId,
            sessionRecoverySource: 'new-uuid'
        };
    }

    /**
     * 请求开始前统一准备会话标题上下文：
     * - 从当前 turn 提取原始用户输入并更新 matchKey；
     * - 按 sessionId 懒恢复历史标题快照。
     */
    protected async prepareRequestSession(
        sessionId: string,
        messages: readonly LanguageModelChatMessage[],
        options?: { skipHistoricalHydrate?: boolean }
    ): Promise<void> {
        try {
            const rawUserText = SessionTitleService.extractUserRequestText(messages);
            if (rawUserText) {
                SessionTitleService.instance.registerSession(sessionId, rawUserText);
            }
        } catch (err) {
            Logger.debug('Failed to register session title for current turn:', err);
        }

        // 全新 UUID 在历史日志中必然无标题快照，跳过日志扫描避免阻塞首个请求
        if (options?.skipHistoricalHydrate) {
            return;
        }
        try {
            await TokenUsagesManager.instance.hydrateSessionTitle(sessionId);
        } catch (err) {
            Logger.debug('Failed to hydrate historical session title:', err);
        }
    }

    /**
     * 统一记录请求开始时的预估 token，并自动附带当前会话标题快照。
     * Provider 子类通过该入口即可避免直接依赖 SessionTitleService / TokenUsagesManager 的拼装细节。
     */
    protected async recordEstimatedRequestTokens(params: EstimatedRequestTrackingParams): Promise<string> {
        try {
            const requestId = await TokenUsagesManager.instance.recordEstimatedTokens({
                providerKey: params.providerKey,
                displayName: params.displayName,
                modelId: params.model.id,
                modelName: params.model.name || params.modelConfig.name,
                estimatedInputTokens: params.estimatedInputTokens,
                estimatedIncrement: params.estimatedIncrement,
                maxInputTokens: params.maxInputTokens,
                requestKind: params.requestKind,
                sessionId: params.sessionId,
                sessionRecoverySource: params.sessionRecoverySource ?? 'new-uuid',
                sessionTitle: SessionTitleService.instance.getTitle(params.sessionId),
                timestamp: params.timestamp,
                ...this.getEstimatedRequestMetadata(params.options)
            });
            if (requestId && params.sessionId && params.requestKind !== 'chat-title') {
                SessionTitleService.instance.rememberRequest(params.sessionId, requestId);
            }
            return requestId;
        } catch (err) {
            Logger.warn('Failed to record estimated tokens, continuing request:', err);
            return '';
        }
    }

    /**
     * 上报请求失败状态到 Token 统计系统
     * 在 Provider 层统一处理，避免重试中间态被误记为失败
     * @param requestId 请求ID
     * @param sessionId 会话ID
     */
    protected reportRequestFailure(
        requestId: string,
        sessionId: string,
        requestMetricStartTime?: number,
        wasThrottled?: boolean
    ): void {
        if (!requestId) {
            return;
        }
        // 同步调用，内部写盘 fire-and-forget，不阻塞错误抛出链路
        TokenUsagesManager.instance.updateActualTokens({
            requestId,
            sessionId,
            status: 'failed',
            requestMetricStartTime,
            wasThrottled
        });
    }

    /**
     * 上报请求取消状态到 Token 统计系统
     * handler 通常已记录 cancelled；这里作为 Provider 层兜底，避免取消发生在 handler 之外时遗漏状态迁移
     */
    protected reportRequestCancelled(
        requestId: string,
        sessionId: string,
        requestMetricStartTime?: number,
        wasThrottled?: boolean
    ): void {
        if (!requestId) {
            return;
        }
        // 同步调用，内部写盘 fire-and-forget；
        // handler 已记录 cancelled 时，日志层会对并发重复终态更新做去重保护，不影响取消链路
        TokenUsagesManager.instance.updateActualTokens({
            requestId,
            sessionId,
            status: 'cancelled',
            requestMetricStartTime,
            wasThrottled
        });
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
     * 估算输入 token 数量
     * @returns 返回计算的输入 token 数量及当前生效的上下文窗口大小，供 Token 统计使用
     */
    protected async updateContextUsageStatusBar(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<ContextUsageSummary> {
        try {
            const analysis = await PromptAnalyzer.analyzePromptParts(
                this.providerKey,
                model,
                messages,
                modelConfig,
                options
            );

            const totalInputTokens = analysis.context || 0;
            const maxInputTokens = getEffectiveMaxInputTokens(model, modelConfig, options, this.providerKey);
            const contextWindow = getEffectiveContextWindow(model, modelConfig, options, this.providerKey);

            // 更新上下文占用状态栏（显示总上下文窗口）
            const contextUsageStatusBar = ContextUsageStatusBar.getInstance();
            if (contextUsageStatusBar) {
                contextUsageStatusBar.updateContextUsage(
                    model.name || modelConfig.name,
                    contextWindow,
                    totalInputTokens,
                    (options as RuntimeProvideLanguageModelChatResponseOptions)?.modelOptions?.requestKind,
                    Date.now()
                );
            }

            if (totalInputTokens > maxInputTokens) {
                Logger.warn(
                    `[${this.providerKey}] Estimated context exceeds current contextSize: ${totalInputTokens}/${maxInputTokens}`
                );
            } else {
                Logger.debug(
                    `[${this.providerKey}] Token calc: ${totalInputTokens}/${maxInputTokens} (${((totalInputTokens / maxInputTokens) * 100).toFixed(1)}%)`
                );
            }
            return { totalInputTokens, maxInputTokens, estimatedIncrement: analysis.requestIncrement };
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
