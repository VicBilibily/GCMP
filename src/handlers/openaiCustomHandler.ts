/*---------------------------------------------------------------------------------------------
 *  OpenAI 自定义 SSE 处理器
 *  使用原生 fetch API 和自定义 SSE 流处理，支持 reasoning_content 等扩展字段
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';

/**
 * OpenAI Handler 接口（用于类型安全的消息和工具转换）
 */
interface IOpenAIHandler {
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[];
    convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[];
}

/**
 * 扩展Delta类型以支持reasoning_content字段
 */
export interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
}

/**
 * 工具调用缓存结构
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    arguments: string;
}

/**
 * 扩展的 CompletionUsage 接口，包含 prompt_tokens_details 和 completion_tokens_details
 */
interface ExtendedCompletionUsage extends OpenAI.Completions.CompletionUsage {
    prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
}

/**
 * OpenAI 自定义 SSE 处理器
 * 使用原生 fetch API 和自定义 SSE 流处理
 */
export class OpenAICustomHandler {
    constructor(
        private provider: string,
        private providerConfig: ProviderConfig,
        private openaiHandler: IOpenAIHandler
    ) {}

    /**
     * 使用自定义 SSE 流处理的请求方法
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        const provider = modelConfig.provider || this.provider;
        const apiKey = await ApiKeyManager.getApiKey(provider);
        if (!apiKey) {
            throw new Error(`缺少 ${provider} API 密钥`);
        }

        const baseURL = modelConfig.baseUrl || 'https://api.openai.com/v1';
        const url = `${baseURL}/chat/completions`;

        Logger.info(`[${model.name}] 处理 ${messages.length} 条消息，使用自定义 SSE 处理`);

        if (!this.openaiHandler) {
            throw new Error('OpenAI 处理器未初始化');
        }

        // 构建请求参数
        const requestBody: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: modelConfig.model || model.id,
            messages: this.openaiHandler.convertMessagesToOpenAI(messages, modelConfig),
            max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
            stream: true,
            stream_options: { include_usage: true },
            temperature: ConfigManager.getTemperature(),
            top_p: ConfigManager.getTopP()
        };

        // 添加工具支持（如果有）
        if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
            requestBody.tools = this.openaiHandler.convertToolsToOpenAI([...options.tools]);
        }

        // 合并 extraBody 参数（如果有）
        if (modelConfig.extraBody) {
            const filteredExtraBody = modelConfig.extraBody;
            Object.assign(requestBody, filteredExtraBody);
            Logger.trace(`${model.name} 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`);
        }

        Logger.debug(`[${model.name}] 发送 API 请求`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            // 合并提供商级别和模型级别的 customHeader
            // 模型级别的 customHeader 会覆盖提供商级别的同名头部
            const mergedCustomHeader = {
                ...this.providerConfig?.customHeader,
                ...modelConfig?.customHeader
            };

            // 处理合并后的 customHeader 中的 API 密钥替换
            const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

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
                let errorMessage = `API请求失败: ${response.status} ${response.statusText}`;

                // 尝试解析错误响应，提取详细的错误信息
                try {
                    const errorJson = JSON.parse(errorText);
                    if (errorJson.error) {
                        if (typeof errorJson.error === 'string') {
                            errorMessage = errorJson.error;
                        } else if (errorJson.error.message) {
                            errorMessage = errorJson.error.message;
                        }
                    }
                } catch {
                    // 如果解析失败，使用原始错误文本
                    if (errorText) {
                        errorMessage = `${errorMessage} - ${errorText}`;
                    }
                }

                throw new Error(errorMessage);
            }

            if (!response.body) {
                throw new Error('响应体为空');
            }

            await this.processStream(model, response.body, progress, token, requestId);

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
        model: vscode.LanguageModelChatInformation,
        body: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hasReceivedContent = false;
        let hasThinkingContent = false; // 标记是否输出了 thinking 内容
        let chunkCount = 0;
        const toolCallsBuffer = new Map<number, ToolCallBuffer>();
        let currentThinkingId: string | null = null; // 思维链追踪

        // Token 统计: 收集 usage 信息
        let finalUsage: ExtendedCompletionUsage | undefined;

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

                            let hasContent = false;

                            // 检查是否是包含 usage 信息的最终 chunk
                            if (chunk.usage) {
                                finalUsage = chunk.usage;
                            }

                            // 处理正常的 choices
                            for (const choice of chunk.choices || []) {
                                const delta = choice.delta as ExtendedDelta | undefined;

                                // 处理思考内容（reasoning_content）
                                if (delta && delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                                    // Logger.trace(
                                    //     `[${model.name}] 接收到思考内容: ${delta.reasoning_content.length} 字符, 内容="${delta.reasoning_content}"`
                                    // );
                                    // 如果当前没有 active id，则生成一个用于本次思维链
                                    if (!currentThinkingId) {
                                        currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                                        Logger.trace(`[${model.name}] 创建新思维链 ID: ${currentThinkingId}`);
                                    }

                                    try {
                                        progress.report(
                                            new vscode.LanguageModelThinkingPart(
                                                delta.reasoning_content,
                                                currentThinkingId
                                            )
                                        );
                                        hasThinkingContent = true; // 标记已输出 thinking 内容
                                    } catch (e) {
                                        Logger.trace(`[${model.name}] 报告思考内容失败: ${String(e)}`);
                                    }
                                }

                                // 处理文本内容（即使 delta 存在但可能为空对象）
                                if (delta && delta.content && typeof delta.content === 'string') {
                                    // Logger.trace(
                                    //     `[${model.name}] 输出文本内容: ${delta.content.length} 字符, preview=${delta.content}`
                                    // );
                                    // 在输出 content 前，结束思维链
                                    if (currentThinkingId) {
                                        this.endThinkingChain(progress, currentThinkingId, '文本内容出现', model.name);
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
                                            // 在工具调用开始时，结束思维链
                                            if (currentThinkingId) {
                                                this.endThinkingChain(
                                                    progress,
                                                    currentThinkingId,
                                                    '工具调用开始',
                                                    model.name
                                                );
                                                currentThinkingId = null;
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
                                                // Logger.trace(
                                                //     `[${model.name}] 检测到部分重复，提取增量部分 [${toolIndex}]: "${incrementalArgs}"`
                                                // );
                                            } else {
                                                // 正常累积
                                                bufferedTool.arguments += newArgs;
                                            }
                                        }

                                        // Logger.trace(
                                        //     `[${model.name}] 累积工具调用数据 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                                        // );
                                    }
                                }

                                // 检查是否完成
                                if (choice.finish_reason) {
                                    Logger.debug(`[${model.name}] 流已结束，原因: ${choice.finish_reason}`);

                                    // 如果是工具调用结束，处理缓存中的工具调用
                                    if (choice.finish_reason === 'tool_calls') {
                                        // 在报告工具调用前，结束思维链
                                        if (currentThinkingId) {
                                            this.endThinkingChain(
                                                progress,
                                                currentThinkingId,
                                                '工具调用结束',
                                                model.name
                                            );
                                            currentThinkingId = null;
                                        }

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

        if (finalUsage) {
            // 提取缓存 token 信息
            const cacheReadTokens = finalUsage.prompt_tokens_details?.cached_tokens ?? 0;
            Logger.info(
                `📊 ${model.name} Token使用: 输入${finalUsage.prompt_tokens}${cacheReadTokens > 0 ? ` (缓存:${cacheReadTokens})` : ''} + 输出${finalUsage.completion_tokens} = 总计${finalUsage.total_tokens}`
            );
        }

        // === Token 统计: 更新实际 token ===
        if (requestId) {
            try {
                const usagesManager = TokenUsagesManager.instance;
                await usagesManager.updateActualTokens({
                    requestId,
                    rawUsage: finalUsage || {},
                    status: 'completed'
                });
            } catch (err) {
                Logger.warn('更新Token统计失败:', err);
            }
        }
    }

    /**
     * 结束思维链
     * @param progress VS Code 进度报告器
     * @param thinkingId 思维链 ID
     * @param context 上下文描述（用于日志）
     * @param modelName 模型名称（用于日志）
     */
    private endThinkingChain(
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        thinkingId: string,
        context: string,
        modelName: string
    ): void {
        try {
            progress.report(new vscode.LanguageModelThinkingPart('', thinkingId));
            Logger.trace(`[${modelName}] ${context}时结束思维链: ${thinkingId}`);
        } catch (e) {
            Logger.trace(`[${modelName}] ${context}时结束思维链失败: ${String(e)}`);
        }
    }
}
