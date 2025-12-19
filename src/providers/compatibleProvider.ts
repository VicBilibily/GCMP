/*---------------------------------------------------------------------------------------------
 *  独立兼容提供商
 *  继承 GenericModelProvider，重写必要方法以支持完全用户配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig, ModelOverride } from '../types/sharedTypes';
import { Logger, ApiKeyManager, CompatibleModelManager, RetryManager, ConfigManager } from '../utils';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status';
import OpenAI from 'openai';
import { ExtendedDelta } from '../utils/openaiHandler';
import { KnownProviders } from '../utils';
import { configProviders } from './config';

/**
 * 工具调用缓存结构
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    arguments: string;
}

/**
 * 独立兼容模型提供商类
 * 继承 GenericModelProvider，重写模型配置获取方法
 */
export class CompatibleProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'compatible';
    private modelsChangeListener?: vscode.Disposable;
    private retryManager: RetryManager;

    constructor(context: vscode.ExtensionContext) {
        // 创建一个虚拟的 ProviderConfig，实际模型配置从 CompatibleModelManager 获取
        const virtualConfig: ProviderConfig = {
            displayName: 'Compatible',
            baseUrl: 'https://api.openai.com/v1', // 默认值，实际使用时会覆盖
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            models: [] // 空模型列表，实际从 CompatibleModelManager 获取
        };
        super(context, CompatibleProvider.PROVIDER_KEY, virtualConfig);

        // 为 Compatible 配置特定的重试参数
        this.retryManager = new RetryManager({
            maxAttempts: 3,
            initialDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
            jitterEnabled: true
        });

        this.getProviderConfig(); // 初始化配置缓存
        // 监听 CompatibleModelManager 的变更事件
        this.modelsChangeListener = CompatibleModelManager.onDidChangeModels(() => {
            Logger.debug('[compatible] 接收到模型变化事件，刷新配置和缓存');
            this.getProviderConfig(); // 刷新配置缓存
            // 清除模型缓存
            this.modelInfoCache
                ?.invalidateCache(CompatibleProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[compatible] 清除缓存失败:', err));
            this._onDidChangeLanguageModelChatInformation.fire();
            Logger.debug('[compatible] 已触发语言模型信息变化事件');
        });
    }

    override dispose(): void {
        this.modelsChangeListener?.dispose();
        super.dispose();
    }

    /**
     * 重写：获取动态的提供商配置
     * 从 CompatibleModelManager 获取用户配置的模型
     */
    getProviderConfig(): ProviderConfig {
        try {
            const models = CompatibleModelManager.getModels();
            // 将 CompatibleModelManager 的模型转换为 ModelConfig 格式
            const modelConfigs: ModelConfig[] = models.map(model => {
                let customHeader = model.customHeader;
                if (model.provider) {
                    const provider = KnownProviders[model.provider];
                    if (provider?.customHeader) {
                        const existingHeaders = model.customHeader || {};
                        customHeader = { ...existingHeaders, ...provider.customHeader };
                    }

                    let knownOverride: Omit<ModelOverride, 'id'> | undefined;
                    if (model.sdkMode === 'anthropic' && provider?.anthropic) {
                        knownOverride = provider.anthropic;
                    } else if (model.sdkMode !== 'anthropic' && provider?.openai) {
                        knownOverride = provider.openai.extraBody;
                    }

                    if (knownOverride) {
                        const extraBody = knownOverride.extraBody || {};
                        const modelBody = model.extraBody || {};
                        model.extraBody = { ...extraBody, ...modelBody };
                    }
                }
                return {
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    tooltip: model.tooltip || `${model.name} (${model.sdkMode})`,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    sdkMode: model.sdkMode,
                    capabilities: model.capabilities,
                    ...(model.baseUrl && { baseUrl: model.baseUrl }),
                    ...(model.model && { model: model.model }),
                    ...(customHeader && { customHeader: customHeader }),
                    ...(model.extraBody && { extraBody: model.extraBody }),
                    ...(model.outputThinking !== undefined && { outputThinking: model.outputThinking }),
                    ...(model.includeThinking !== undefined && { includeThinking: model.includeThinking })
                };
            });

            Logger.debug(`Compatible Provider 加载了 ${modelConfigs.length} 个用户配置的模型`);

            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1', // 默认值，模型级别的配置会覆盖
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: modelConfigs
            };
        } catch (error) {
            Logger.error('获取 Compatible Provider 配置失败:', error);
            // 返回基础配置作为后备
            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: []
            };
        }
        return this.cachedProviderConfig;
    }

    /**
     * 重写：提供语言模型聊天信息
     * 直接获取最新的动态配置，不依赖构造时的配置
     * 检查所有模型涉及的提供商的 API Key
     * 集成模型缓存机制以提高性能
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
            // 获取 API 密钥的哈希值用于缓存验证
            const apiKeyHash = await this.getApiKeyHash();

            // 快速路径：检查缓存
            let cachedModels = await this.modelInfoCache?.getCachedModels(CompatibleProvider.PROVIDER_KEY, apiKeyHash);
            if (cachedModels) {
                Logger.trace(`✓ Compatible Provider 缓存命中: ${cachedModels.length} 个模型`);

                // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能时）
                const rememberLastModel = ConfigManager.getRememberLastModel();
                if (rememberLastModel) {
                    const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(CompatibleProvider.PROVIDER_KEY);
                    if (lastSelectedId) {
                        cachedModels = cachedModels.map(model => ({
                            ...model,
                            isDefault: model.id === lastSelectedId
                        }));
                    }
                }

                // 后台异步更新缓存
                this.updateModelCacheAsync(apiKeyHash);
                return cachedModels;
            }

            // 获取最新的动态配置
            const currentConfig = this.providerConfig;
            // 如果没有模型，直接返回空列表
            if (currentConfig.models.length === 0) {
                // 异步触发新增模型流程，但不阻塞配置获取
                if (!options.silent) {
                    setImmediate(async () => {
                        try {
                            await CompatibleModelManager.configureModelOrUpdateAPIKey();
                        } catch {
                            Logger.debug('自动触发新增模型失败或被用户取消');
                        }
                    });
                }
                return [];
            }

            // 获取所有模型涉及的提供商（去重）
            const providers = new Set<string>();
            for (const model of currentConfig.models) {
                if (model.provider) {
                    providers.add(model.provider);
                }
            }
            // 检查每个提供商的 API Key
            for (const provider of providers) {
                if (!options.silent) {
                    // 非静默模式下，使用 ensureApiKey 逐一确认和设置
                    const hasValidKey = await ApiKeyManager.ensureApiKey(provider, provider, false);
                    if (!hasValidKey) {
                        Logger.warn(`Compatible Provider 用户未设置提供商 "${provider}" 的 API 密钥`);
                        return [];
                    }
                }
            }

            // 将最新配置中的模型转换为 VS Code 所需的格式
            let modelInfos = currentConfig.models.map(model => {
                const info = this.modelConfigToInfo(model);
                const sdkModeDisplay = model.sdkMode === 'anthropic' ? 'Anthropic' : 'OpenAI';

                if (model.provider) {
                    const knownProvider = KnownProviders[model.provider];
                    if (knownProvider?.displayName) {
                        return { ...info, detail: knownProvider.displayName };
                    }
                    const provider = configProviders[model.provider as keyof typeof configProviders];
                    if (provider?.displayName) {
                        return { ...info, detail: provider.displayName };
                    }
                }

                return { ...info, detail: `${sdkModeDisplay} Compatible` };
            });

            // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能时）
            const rememberLastModel = ConfigManager.getRememberLastModel();
            if (rememberLastModel) {
                const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(CompatibleProvider.PROVIDER_KEY);
                if (lastSelectedId) {
                    modelInfos = modelInfos.map(model => ({
                        ...model,
                        isDefault: model.id === lastSelectedId
                    }));
                }
            }

            Logger.debug(`Compatible Provider 提供了 ${modelInfos.length} 个模型信息`); // 后台异步更新缓存
            this.updateModelCacheAsync(apiKeyHash);

            return modelInfos;
        } catch (error) {
            Logger.error('获取 Compatible Provider 模型信息失败:', error);
            return [];
        }
    }

    /**
     * 重写：异步更新模型缓存
     * 需要正确设置 detail 字段以显示 SDK 模式
     */
    protected override updateModelCacheAsync(apiKeyHash: string): void {
        (async () => {
            try {
                const currentConfig = this.providerConfig;

                const models = currentConfig.models.map(model => {
                    const info = this.modelConfigToInfo(model);
                    const sdkModeDisplay = model.sdkMode === 'anthropic' ? 'Anthropic' : 'OpenAI';

                    if (model.provider) {
                        const knownProvider = KnownProviders[model.provider];
                        if (knownProvider?.displayName) {
                            return { ...info, detail: knownProvider.displayName };
                        }
                        const provider = configProviders[model.provider as keyof typeof configProviders];
                        if (provider?.displayName) {
                            return { ...info, detail: provider.displayName };
                        }
                    }

                    return { ...info, detail: `${sdkModeDisplay} Compatible` };
                });

                await this.modelInfoCache?.cacheModels(CompatibleProvider.PROVIDER_KEY, models, apiKeyHash);
            } catch (err) {
                Logger.trace('[compatible] 后台缓存更新失败:', err instanceof Error ? err.message : String(err));
            }
        })();
    }

    /**
     * 重写：提供语言模型聊天响应
     * 使用最新的动态配置处理请求，并添加失败重试机制
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // 保存用户选择的模型及其提供商（仅当启用记忆功能时）
        const rememberLastModel = ConfigManager.getRememberLastModel();
        if (rememberLastModel) {
            this.modelInfoCache
                ?.saveLastSelectedModel(CompatibleProvider.PROVIDER_KEY, model.id)
                .catch(err => Logger.warn('[compatible] 保存模型选择失败:', err));
        }

        try {
            // 获取最新的动态配置
            const currentConfig = this.providerConfig;

            // 查找对应的模型配置
            const modelConfig = currentConfig.models.find(m => m.id === model.id);
            if (!modelConfig) {
                const errorMessage = `Compatible Provider 未找到模型: ${model.id}`;
                Logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            // 检查 API 密钥（使用 throwError: false 允许静默失败）
            const hasValidKey = await ApiKeyManager.ensureApiKey(
                modelConfig.provider!,
                currentConfig.displayName,
                false
            );
            if (!hasValidKey) {
                throw new Error(`模型 ${modelConfig.name} 的 API 密钥尚未设置`);
            }

            // 根据模型的 sdkMode 选择使用的 handler
            const sdkMode = modelConfig.sdkMode || 'openai';
            let sdkName = 'OpenAI SDK';
            if (sdkMode === 'anthropic') {
                sdkName = 'Anthropic SDK';
            } else if (sdkMode === 'openai-sse') {
                sdkName = 'OpenAI SSE';
            }

            Logger.info(`Compatible Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

            // 计算输入 token 数量并更新状态栏
            await this.updateTokenUsageStatusBar(model, messages, modelConfig, options);

            try {
                // 使用重试机制执行请求
                await this.retryManager.executeWithRetry(
                    async () => {
                        if (sdkMode === 'anthropic') {
                            await this.anthropicHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token
                            );
                        } else if (sdkMode === 'openai-sse') {
                            // OpenAI 模式：使用自定义 SSE 流处理
                            await this.handleRequestWithCustomSSE(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token
                            );
                        } else {
                            await this.openaiHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token
                            );
                        }
                    },
                    error => RetryManager.isRateLimitError(error),
                    this.providerConfig.displayName
                );
            } catch (error) {
                const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
                Logger.error(errorMessage);
                throw error;
            } finally {
                Logger.info(`✅ Compatible Provider: ${model.name} 请求已完成`);
                // 延时更新状态栏以反映最新余额
                StatusBarManager.compatible?.delayedUpdate(modelConfig.provider!, 2000);
            }
        } catch (error) {
            Logger.error('Compatible Provider 处理请求失败:', error);
            throw error;
        }
    }

    /**
     * 使用自定义 SSE 流处理的请求方法
     */
    private async handleRequestWithCustomSSE(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const provider = modelConfig.provider || this.providerKey;
        const apiKey = await ApiKeyManager.getApiKey(provider);
        if (!apiKey) {
            throw new Error(`缺少 ${provider} API 密钥`);
        }

        const baseURL = modelConfig.baseUrl || 'https://api.openai.com/v1';
        const url = `${baseURL}/chat/completions`;

        Logger.info(`[${model.name}] 处理 ${messages.length} 条消息，使用自定义 SSE 处理`);

        // 构建请求参数
        const requestBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: modelConfig.model || model.id,
            messages: this.openaiHandler.convertMessagesToOpenAI(
                messages,
                model.capabilities || undefined,
                modelConfig
            ),
            max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
            stream: true,
            temperature: ConfigManager.getTemperature(),
            top_p: ConfigManager.getTopP()
        };

        // 添加工具支持（如果有）
        if (options.tools && options.tools.length > 0 && model.capabilities?.toolCalling) {
            requestBody.tools = this.openaiHandler.convertToolsToOpenAI([...options.tools]);
            requestBody.tool_choice = 'auto';
        }

        // 合并extraBody参数（如果有）
        if (modelConfig.extraBody) {
            const filteredExtraBody = modelConfig.extraBody;
            Object.assign(requestBody, filteredExtraBody);
            Logger.trace(`${model.name} 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`);
        }

        Logger.debug(`[${model.name}] 发送 API 请求`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            // 处理 customHeader 中的 API 密钥替换
            const processedCustomHeader = ApiKeyManager.processCustomHeader(modelConfig?.customHeader, apiKey);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    ...processedCustomHeader
                },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API请求失败: ${response.status} ${response.statusText} - ${errorText}`);
            }

            if (!response.body) {
                throw new Error('响应体为空');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let hasReceivedContent = false;
            let hasThinkingContent = false; // 标记是否输出了 thinking 内容
            let chunkCount = 0;
            const toolCallsBuffer = new Map<number, ToolCallBuffer>();
            let currentThinkingId: string | null = null; // 思维链追踪
            let thinkingContentBuffer: string = ''; // 思考内容缓存
            const MAX_THINKING_BUFFER_LENGTH = 10; // 思考内容缓存的最大长度

            try {
                while (true) {
                    if (token.isCancellationRequested) {
                        Logger.warn(`[${model.name}] 用户取消了请求`);
                        break;
                    }

                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim() || line.trim() === '') {
                            continue;
                        }

                        // 处理 SSE 数据行
                        if (line.startsWith('data:')) {
                            const data = line.substring(5).trim();

                            if (data === '[DONE]') {
                                Logger.debug(`[${model.name}] 收到流结束标记`);
                                continue;
                            }

                            try {
                                const chunk = JSON.parse(data);
                                chunkCount++;
                                // 输出完整的 chunk 到 trace 日志
                                // Logger.trace(`[${model.name}] Chunk #${chunkCount}: ${JSON.stringify(chunk)}`);

                                let hasContent = false;

                                // 检查是否是包含usage信息的最终chunk
                                if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
                                    Logger.debug(`[${model.name}] 收到使用统计信息: ${JSON.stringify(chunk.usage)}`);
                                    // 继续处理下一个chunk，不设置 hasReceivedContent
                                } else {
                                    // 处理正常的choices
                                    for (const choice of chunk.choices || []) {
                                        const delta = choice.delta as ExtendedDelta | undefined;

                                        // 处理思考内容（reasoning_content）- 使用缓冲累积策略
                                        if (
                                            delta &&
                                            delta.reasoning_content &&
                                            typeof delta.reasoning_content === 'string'
                                        ) {
                                            Logger.trace(
                                                `[${model.name}] 接收到思考内容: ${delta.reasoning_content.length} 字符, 内容="${delta.reasoning_content}"`
                                            );
                                            // 如果当前没有 active id，则生成一个用于本次思维链
                                            if (!currentThinkingId) {
                                                currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                                                Logger.trace(`[${model.name}] 创建新思维链 ID: ${currentThinkingId}`);
                                            }

                                            // 将思考内容添加到缓冲
                                            thinkingContentBuffer += delta.reasoning_content;

                                            // 检查是否达到报告条件
                                            if (thinkingContentBuffer.length >= MAX_THINKING_BUFFER_LENGTH) {
                                                // 达到最大长度，立即报告
                                                try {
                                                    progress.report(
                                                        new vscode.LanguageModelThinkingPart(
                                                            thinkingContentBuffer,
                                                            currentThinkingId
                                                        )
                                                    );
                                                    thinkingContentBuffer = ''; // 清空缓冲
                                                    hasThinkingContent = true; // 标记已输出 thinking 内容
                                                } catch (e) {
                                                    Logger.trace(`[${model.name}] 报告思考内容失败: ${String(e)}`);
                                                }
                                            } else {
                                                // 即使没有立即报告，也标记有 thinking 内容
                                                hasThinkingContent = true;
                                            }
                                        }

                                        // 处理文本内容（即使 delta 存在但可能为空对象）
                                        if (delta && delta.content && typeof delta.content === 'string') {
                                            Logger.trace(
                                                `[${model.name}] 输出文本内容: ${delta.content.length} 字符, preview=${delta.content}`
                                            );
                                            // 遇到可见 content 前，如果有缓存的思考内容，先报告出来
                                            if (thinkingContentBuffer.length > 0 && currentThinkingId) {
                                                try {
                                                    progress.report(
                                                        new vscode.LanguageModelThinkingPart(
                                                            thinkingContentBuffer,
                                                            currentThinkingId
                                                        )
                                                    );
                                                    thinkingContentBuffer = ''; // 清空缓冲
                                                    hasThinkingContent = true; // 标记已输出 thinking 内容
                                                } catch (e) {
                                                    Logger.trace(`[${model.name}] 报告剩余思考内容失败: ${String(e)}`);
                                                }
                                            }

                                            // 然后结束当前思维链
                                            if (currentThinkingId) {
                                                try {
                                                    Logger.trace(
                                                        `[${model.name}] 在输出content前结束思维链 ID: ${currentThinkingId}`
                                                    );
                                                    progress.report(
                                                        new vscode.LanguageModelThinkingPart('', currentThinkingId)
                                                    );
                                                } catch (e) {
                                                    Logger.trace(
                                                        `[${model.name}] 发送 thinking done(id=${currentThinkingId}) 失败: ${String(e)}`
                                                    );
                                                }
                                                currentThinkingId = null;
                                            }

                                            progress.report(new vscode.LanguageModelTextPart(delta.content));
                                            hasContent = true;
                                        }

                                        // 处理工具调用 - 支持分块数据的累积处理
                                        if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
                                            for (const toolCall of delta.tool_calls) {
                                                const toolIndex = toolCall.index ?? 0;

                                                // 检查是否有工具调用开始（tool_calls 存在但还没有 arguments）
                                                if (toolIndex !== undefined && !toolCall.function?.arguments) {
                                                    // 在工具调用开始时，如果有缓存的思考内容，先报告出来
                                                    if (thinkingContentBuffer.length > 0 && currentThinkingId) {
                                                        try {
                                                            progress.report(
                                                                new vscode.LanguageModelThinkingPart(
                                                                    thinkingContentBuffer,
                                                                    currentThinkingId
                                                                )
                                                            );
                                                            // 结束当前思维链
                                                            progress.report(
                                                                new vscode.LanguageModelThinkingPart(
                                                                    '',
                                                                    currentThinkingId
                                                                )
                                                            );
                                                            thinkingContentBuffer = ''; // 清空缓冲
                                                            hasThinkingContent = true; // 标记已输出 thinking 内容
                                                        } catch (e) {
                                                            Logger.trace(
                                                                `[${model.name}] 报告剩余思考内容失败: ${String(e)}`
                                                            );
                                                        }
                                                    }
                                                    Logger.trace(
                                                        `🔧 [${model.name}] 工具调用开始: ${toolCall.function?.name || 'unknown'} (索引: ${toolIndex})`
                                                    );
                                                }

                                                // 获取或创建工具调用缓存
                                                let bufferedTool = toolCallsBuffer.get(toolIndex);
                                                if (!bufferedTool) {
                                                    bufferedTool = { arguments: '' };
                                                    toolCallsBuffer.set(toolIndex, bufferedTool);
                                                }

                                                // 累积工具调用数据
                                                if (toolCall.id) {
                                                    bufferedTool.id = toolCall.id;
                                                }
                                                if (toolCall.function?.name) {
                                                    bufferedTool.name = toolCall.function.name;
                                                }
                                                if (toolCall.function?.arguments) {
                                                    const newArgs = toolCall.function.arguments;
                                                    // 检查是否是重复数据：新数据是否已经包含在当前累积的字符串中
                                                    // 某些 API（如 DeepSeek）可能会重复发送之前的 arguments 片段
                                                    if (bufferedTool.arguments.endsWith(newArgs)) {
                                                        // 完全重复，跳过
                                                        Logger.trace(
                                                            `[${model.name}] 跳过重复的工具调用参数 [${toolIndex}]: "${newArgs}"`
                                                        );
                                                    } else if (
                                                        bufferedTool.arguments.length > 0 &&
                                                        newArgs.startsWith(bufferedTool.arguments)
                                                    ) {
                                                        // 新数据包含了旧数据（完全重复+新增），只取新增部分
                                                        const incrementalArgs = newArgs.substring(
                                                            bufferedTool.arguments.length
                                                        );
                                                        bufferedTool.arguments += incrementalArgs;
                                                        Logger.trace(
                                                            `[${model.name}] 检测到部分重复，提取增量部分 [${toolIndex}]: "${incrementalArgs}"`
                                                        );
                                                    } else {
                                                        // 正常累积
                                                        bufferedTool.arguments += newArgs;
                                                    }
                                                }

                                                Logger.trace(
                                                    `[${model.name}] 累积工具调用数据 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                                                );
                                            }
                                        }

                                        // 检查是否完成
                                        if (choice.finish_reason) {
                                            Logger.debug(`[${model.name}] 流已结束，原因: ${choice.finish_reason}`);

                                            // 如果有缓存的思考内容，先报告出来
                                            if (thinkingContentBuffer.length > 0 && currentThinkingId) {
                                                try {
                                                    progress.report(
                                                        new vscode.LanguageModelThinkingPart(
                                                            thinkingContentBuffer,
                                                            currentThinkingId
                                                        )
                                                    );
                                                    thinkingContentBuffer = ''; // 清空缓冲
                                                    hasThinkingContent = true; // 标记已输出 thinking 内容
                                                } catch (e) {
                                                    Logger.trace(`[${model.name}] 报告剩余思考内容失败: ${String(e)}`);
                                                }
                                            }

                                            // 如果有未结束的思维链，在 finish_reason 时结束它
                                            if (currentThinkingId && choice.finish_reason !== 'length') {
                                                try {
                                                    Logger.trace(
                                                        `[${model.name}] 流结束前结束思维链 ID: ${currentThinkingId}`
                                                    );
                                                    progress.report(
                                                        new vscode.LanguageModelThinkingPart('', currentThinkingId)
                                                    );
                                                } catch (e) {
                                                    Logger.warn(`[${model.name}] 结束思维链失败: ${String(e)}`);
                                                }
                                                currentThinkingId = null;
                                            }

                                            // 如果是工具调用结束，处理缓存中的工具调用
                                            if (choice.finish_reason === 'tool_calls') {
                                                let toolProcessed = false;
                                                for (const [toolIndex, bufferedTool] of toolCallsBuffer.entries()) {
                                                    if (bufferedTool.name && bufferedTool.arguments) {
                                                        try {
                                                            const args = JSON.parse(bufferedTool.arguments);
                                                            const toolCallId =
                                                                bufferedTool.id || `tool_${Date.now()}_${toolIndex}`;

                                                            progress.report(
                                                                new vscode.LanguageModelToolCallPart(
                                                                    toolCallId,
                                                                    bufferedTool.name,
                                                                    args
                                                                )
                                                            );

                                                            Logger.info(
                                                                `[${model.name}] 成功处理工具调用: ${bufferedTool.name}, args: ${bufferedTool.arguments}`
                                                            );
                                                            toolProcessed = true;
                                                        } catch (error) {
                                                            Logger.error(
                                                                `[${model.name}] 无法解析工具调用参数: ${bufferedTool.name}, args: ${bufferedTool.arguments}, error: ${error}`
                                                            );
                                                        }
                                                    } else {
                                                        Logger.warn(
                                                            `[${model.name}] 不完整的工具调用 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                                                        );
                                                    }
                                                }

                                                if (toolProcessed) {
                                                    hasContent = true;
                                                    Logger.trace(`[${model.name}] 工具调用已处理，标记为已接收内容`);
                                                }
                                            } else if (choice.finish_reason === 'stop') {
                                                // 对于 stop，只有在真正接收到内容时才标记（不包括仅有思考内容的情况）
                                                if (!hasContent) {
                                                    Logger.trace(`[${model.name}] finish_reason=stop，未收到文本内容`);
                                                }
                                                // 注意：不再强制设置 hasContent = true
                                                // 只有在前面真正接收到文本或工具调用时，hasContent 才会是 true
                                            }
                                        }
                                    }
                                }

                                if (hasContent) {
                                    hasReceivedContent = true;
                                }
                            } catch (error) {
                                Logger.error(`[${model.name}] 解析 JSON 失败: ${data}`, error);
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }

            Logger.trace(
                `[${model.name}] SSE 流处理统计: ${chunkCount} 个 chunk, hasReceivedContent=${hasReceivedContent}`
            );

            Logger.debug(`[${model.name}] 流处理完成`);

            // 只有在输出了 thinking 内容但没有输出 content 时才添加 <think/> 占位符
            if (hasThinkingContent && !hasReceivedContent) {
                progress.report(new vscode.LanguageModelTextPart('<think/>'));
                Logger.warn(`[${model.name}] 消息流结束时只有思考内容没有文本内容，添加了 <think/> 占位符作为输出`);
            }

            Logger.debug(`[${model.name}] API请求完成`);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${model.name}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            cancellationListener.dispose();
        }
    }

    /**
     * 注册命令
     */
    private static registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];
        // 注册 manageModels 命令
        disposables.push(
            vscode.commands.registerCommand('gcmp.compatible.manageModels', async () => {
                try {
                    await CompatibleModelManager.configureModelOrUpdateAPIKey();
                } catch (error) {
                    Logger.error('管理 Compatible 模型失败:', error);
                    vscode.window.showErrorMessage(
                        `管理模型失败: ${error instanceof Error ? error.message : '未知错误'}`
                    );
                }
            })
        );
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.debug('Compatible Provider 命令已注册');
        return disposables;
    }

    /**
     * 静态工厂方法 - 创建并激活提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: CompatibleProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('Compatible Provider 已激活!');
        // 创建提供商实例
        const provider = new CompatibleProvider(context);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.compatible', provider);
        // 注册命令
        const commandDisposables = this.registerCommands(context);
        const disposables = [providerDisposable, ...commandDisposables];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
}
