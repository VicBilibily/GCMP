/*---------------------------------------------------------------------------------------------
 *  ModelScope 专用 Provider
 *  继承 GenericModelProvider，使用自定义的 SSE 流处理逻辑
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
import { ApiKeyManager, Logger, ConfigManager } from '../utils';
import { GenericModelProvider } from './genericModelProvider';
import OpenAI from 'openai';

/**
 * 工具调用缓存结构
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    arguments: string;
}

/**
 * OpenAI 格式的消息类型（直接使用 OpenAI SDK 类型）
 */
type OpenAIMessage = OpenAI.Chat.ChatCompletionMessageParam;

type OpenAITool = OpenAI.Chat.ChatCompletionTool;

interface OpenAIRequestBody {
    model: string;
    messages: OpenAIMessage[];
    max_tokens: number;
    stream: boolean;
    temperature: number;
    top_p: number;
    tools?: OpenAITool[];
    tool_choice?: string | { type: 'function'; function: { name: string } };
}

/**
 * ModelScope 专用模型供应商类
 * 继承 GenericModelProvider，只重写流处理部分以使用自定义 SSE 解析
 */
export class ModelScopeProvider extends GenericModelProvider implements LanguageModelChatProvider {
    // 工具调用缓存 - 用于处理分块的工具调用数据
    private toolCallsBuffer = new Map<number, ToolCallBuffer>();

    constructor(providerKey: string, providerConfig: ProviderConfig) {
        super(providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 ModelScope 供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: ModelScopeProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);

        // 创建供应商实例
        const provider = new ModelScopeProvider(providerKey, providerConfig);

        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
        });

        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));

        return { provider, disposables };
    }

    /**
     * 重写请求处理方法，根据 sdkMode 选择不同的处理策略
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.providerConfig.models.find(m => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 确保有API密钥
        await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName);

        // 根据模型的 sdkMode 选择使用的 handler
        const sdkMode = modelConfig.sdkMode || 'openai';

        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求: ${modelConfig.name} (SDK: ${sdkMode})`);

        try {
            if (sdkMode === 'anthropic') {
                // 使用 Anthropic SDK
                await this.anthropicHandler.handleRequest(model, modelConfig, messages, options, progress, token);
            } else {
                // 使用自定义的 SSE 流处理（OpenAI 兼容）
                await this.handleRequestWithCustomSSE(model, modelConfig, messages, options, progress, token);
            }
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
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
        // 清理工具调用缓存
        this.toolCallsBuffer.clear();

        const apiKey = await ApiKeyManager.getApiKey(this.providerKey);
        if (!apiKey) {
            throw new Error(`缺少 ${this.providerConfig.displayName} API密钥`);
        }

        const baseURL = modelConfig.baseUrl || this.providerConfig.baseUrl;
        const url = `${baseURL}/chat/completions`;

        Logger.info(`[${model.name}] 处理 ${messages.length} 条消息，使用 ${this.providerConfig.displayName}`);

        // 构建请求参数
        const requestBody: OpenAIRequestBody = {
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

        Logger.debug(`[${model.name}] 发送 ${this.providerConfig.displayName} API 请求`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`
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

            Logger.debug(`[${model.name}] ${this.providerConfig.displayName} API请求完成`);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${model.name}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            cancellationListener.dispose();
            this.toolCallsBuffer.clear();
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
                            const hasContent = this.handleStreamChunk(chunk, progress, modelName);
                            if (hasContent) {
                                hasReceivedContent = true;
                            }
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
                    tool_calls?: Array<{
                        index?: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                    }>;
                };
                finish_reason?: string;
            }>;
        },
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        modelName: string
    ): boolean {
        let hasContent = false;

        // 检查是否是包含usage信息的最终chunk
        if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
            Logger.debug(`[${modelName}] 收到使用统计信息: ${JSON.stringify(chunk.usage)}`);
            return true;
        }

        // 处理正常的choices
        for (const choice of chunk.choices || []) {
            const delta = choice.delta;

            // 处理文本内容（即使 delta 存在但可能为空对象）
            if (delta && delta.content && typeof delta.content === 'string') {
                Logger.trace(`[${modelName}] 输出文本内容: ${delta.content.length} 字符`);
                progress.report(new vscode.LanguageModelTextPart(delta.content));
                hasContent = true;
            }

            // 处理工具调用 - 支持分块数据的累积处理
            if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                    const toolIndex = toolCall.index ?? 0;

                    // 获取或创建工具调用缓存
                    let bufferedTool = this.toolCallsBuffer.get(toolIndex);
                    if (!bufferedTool) {
                        bufferedTool = { arguments: '' };
                        this.toolCallsBuffer.set(toolIndex, bufferedTool);
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

                // 如果是工具调用结束，处理缓存中的工具调用
                if (choice.finish_reason === 'tool_calls') {
                    const toolProcessed = this.processBufferedToolCalls(progress, modelName);
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

        return hasContent;
    }

    /**
     * 处理缓存中的工具调用
     */
    private processBufferedToolCalls(
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        modelName: string
    ): boolean {
        let hasProcessed = false;

        for (const [toolIndex, bufferedTool] of this.toolCallsBuffer.entries()) {
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
}
