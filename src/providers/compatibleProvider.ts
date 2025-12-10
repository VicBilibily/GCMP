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
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, CompatibleModelManager, RetryManager, ConfigManager } from '../utils';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status';
import OpenAI from 'openai';
import { ExtendedDelta } from '../utils/openaiHandler';

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
            this.getProviderConfig(); // 刷新配置缓存
            // 清除模型缓存
            this.modelInfoCache
                ?.invalidateCache(CompatibleProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[compatible] 清除缓存失败:', err));
            this._onDidChangeLanguageModelChatInformation.fire();
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
                    const provider = CompatibleModelManager.KnownProviders[model.provider];
                    if (provider?.customHeader) {
                        const existingHeaders = model.customHeader || {};
                        customHeader = {
                            ...existingHeaders,
                            ...provider.customHeader
                        };
                    }
                }
                return {
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    tooltip: model.tooltip || `自定义模型: ${model.name}`,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    sdkMode: model.sdkMode,
                    capabilities: model.capabilities,
                    ...(model.baseUrl && { baseUrl: model.baseUrl }),
                    ...(model.model && { model: model.model }),
                    ...(customHeader && { customHeader: customHeader }),
                    ...(model.extraBody && { extraBody: model.extraBody }),
                    ...(model.outputThinking !== undefined && { outputThinking: model.outputThinking })
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
                    const provider = CompatibleModelManager.KnownProviders[model.provider];
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
                        const provider = CompatibleModelManager.KnownProviders[model.provider];
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
            const sdkName = sdkMode === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';

            Logger.info(`Compatible Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

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
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
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
            messages: this.openaiHandler.convertMessagesToOpenAI(messages, model.capabilities || undefined),
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

            const hasReceivedContent = await this.processStream(response.body, progress, token, model.name);

            Logger.debug(`[${model.name}] 流处理完成`);

            // 注意：工具调用响应可能不包含文本内容，这是正常的
            if (!hasReceivedContent) {
                Logger.debug(`[${model.name}] 流结束但未收到文本内容（可能是纯工具调用响应）`);
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
     * 处理 SSE 流
     */
    private async processStream(
        body: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        modelName: string
    ): Promise<boolean> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hasReceivedContent = false;
        let chunkCount = 0;
        const toolCallsBuffer = new Map<number, ToolCallBuffer>();
        let currentThinkingId: string | null = null; // 思维链追踪

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    Logger.warn(`[${modelName}] 用户取消了请求`);
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
                            Logger.debug(`[${modelName}] 收到流结束标记`);
                            continue;
                        }

                        try {
                            const chunk = JSON.parse(data);
                            chunkCount++;
                            // 输出完整的 chunk 到 trace 日志
                            Logger.trace(`[${modelName}] Chunk #${chunkCount}: ${JSON.stringify(chunk)}`);
                            const { hasContent, thinkingId } = this.handleStreamChunk(
                                chunk,
                                progress,
                                modelName,
                                toolCallsBuffer,
                                currentThinkingId
                            );
                            if (hasContent) {
                                hasReceivedContent = true;
                            }
                            currentThinkingId = thinkingId;
                        } catch (error) {
                            Logger.error(`[${modelName}] 解析 JSON 失败: ${data}`, error);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        Logger.trace(`[${modelName}] SSE 流处理统计: ${chunkCount} 个 chunk, hasReceivedContent=${hasReceivedContent}`);
        return hasReceivedContent;
    }

    /**
     * 处理流式响应块
     */
    private handleStreamChunk(
        chunk: {
            usage?: unknown;
            choices?: Array<{
                delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                        index?: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                    }>;
                };
                finish_reason?: string;
            }>;
        },
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        modelName: string,
        toolCallsBuffer: Map<number, ToolCallBuffer>,
        currentThinkingId: string | null
    ): { hasContent: boolean; thinkingId: string | null } {
        let hasContent = false;
        let newThinkingId = currentThinkingId;

        // 检查是否是包含usage信息的最终chunk
        if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
            Logger.debug(`[${modelName}] 收到使用统计信息: ${JSON.stringify(chunk.usage)}`);
            return { hasContent: true, thinkingId: newThinkingId };
        }

        // 处理正常的choices
        for (const choice of chunk.choices || []) {
            const delta = choice.delta as ExtendedDelta | undefined;

            // 处理思考内容（reasoning_content）
            if (delta && delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                Logger.trace(`[${modelName}] 接收到思考内容: ${delta.reasoning_content.length} 字符`);
                // 如果当前没有 active id，则生成一个用于本次思维链
                if (!newThinkingId) {
                    newThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    Logger.trace(`[${modelName}] 创建新思维链 ID: ${newThinkingId}`);
                }
                try {
                    progress.report(new vscode.LanguageModelThinkingPart(delta.reasoning_content, newThinkingId));
                    hasContent = true;
                } catch (e) {
                    Logger.warn(`[${modelName}] 报告思维链失败: ${String(e)}`);
                }
            }

            // 处理文本内容（即使 delta 存在但可能为空对象）
            if (delta && delta.content && typeof delta.content === 'string') {
                Logger.trace(`[${modelName}] 输出文本内容: ${delta.content.length} 字符`);
                // 遇到可见 content 前，如果有未结束的 thinking，则先结束之
                if (newThinkingId) {
                    try {
                        Logger.trace(`[${modelName}] 在输出文本前结束思维链 ID: ${newThinkingId}`);
                        progress.report(new vscode.LanguageModelThinkingPart('', newThinkingId));
                    } catch (e) {
                        Logger.warn(`[${modelName}] 结束思维链失败: ${String(e)}`);
                    }
                    newThinkingId = null;
                }
                progress.report(new vscode.LanguageModelTextPart(delta.content));
                hasContent = true;
            }

            // 处理工具调用 - 支持分块数据的累积处理
            if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                    const toolIndex = toolCall.index ?? 0;

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
                        bufferedTool.arguments += toolCall.function.arguments;
                    }

                    Logger.debug(
                        `[${modelName}] 累积工具调用数据 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                    );
                }
            }

            // 检查是否完成
            if (choice.finish_reason) {
                Logger.debug(`[${modelName}] 流已结束，原因: ${choice.finish_reason}`);

                // 如果有未结束的思维链，在 finish_reason 时结束它
                if (newThinkingId && choice.finish_reason !== 'length') {
                    try {
                        Logger.trace(`[${modelName}] 流结束前结束思维链 ID: ${newThinkingId}`);
                        progress.report(new vscode.LanguageModelThinkingPart('', newThinkingId));
                    } catch (e) {
                        Logger.warn(`[${modelName}] 结束思维链失败: ${String(e)}`);
                    }
                    newThinkingId = null;
                }

                // 如果是工具调用结束，处理缓存中的工具调用
                if (choice.finish_reason === 'tool_calls') {
                    const toolProcessed = this.processBufferedToolCalls(progress, modelName, toolCallsBuffer);
                    if (toolProcessed) {
                        hasContent = true;
                        Logger.trace(`[${modelName}] 工具调用已处理，标记为已接收内容`);
                    }
                } else if (choice.finish_reason === 'stop') {
                    // 对于 stop，标记为已处理（即使没有文本内容，也可能有之前的工具调用）
                    if (!hasContent) {
                        Logger.trace(`[${modelName}] finish_reason=stop，未收到文本内容`);
                    }
                    // 如果有任何处理（文本或工具调用），都算作有效响应
                    // 即使只是流结束标记，也应该算作接收到响应
                    hasContent = true;
                }
            }
        }

        return { hasContent, thinkingId: newThinkingId };
    }

    /**
     * 处理缓存中的工具调用
     */
    private processBufferedToolCalls(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        modelName: string,
        toolCallsBuffer: Map<number, ToolCallBuffer>
    ): boolean {
        let hasProcessed = false;

        for (const [toolIndex, bufferedTool] of toolCallsBuffer.entries()) {
            if (bufferedTool.name && bufferedTool.arguments) {
                try {
                    const args = JSON.parse(bufferedTool.arguments);
                    const toolCallId = bufferedTool.id || `tool_${Date.now()}_${toolIndex}`;

                    progress.report(new vscode.LanguageModelToolCallPart(toolCallId, bufferedTool.name, args));

                    Logger.info(
                        `[${modelName}] 成功处理工具调用: ${bufferedTool.name}, args: ${bufferedTool.arguments}`
                    );
                    hasProcessed = true;
                } catch (error) {
                    Logger.error(
                        `[${modelName}] 无法解析工具调用参数: ${bufferedTool.name}, args: ${bufferedTool.arguments}, error: ${error}`
                    );
                }
            } else {
                Logger.warn(
                    `[${modelName}] 不完整的工具调用 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                );
            }
        }

        return hasProcessed;
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
