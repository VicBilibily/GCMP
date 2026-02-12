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
import { StreamReporter } from './streamReporter';

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
            stream_options: { include_usage: true }
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

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress
            });

            await this.processStream(model, response.body, reporter, requestId || '', token);

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
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let chunkCount = 0;

        // Token 统计: 收集 usage 信息
        let finalUsage: ExtendedCompletionUsage | undefined;
        // 记录流处理的开始和结束时间
        let streamStartTime: number | undefined = undefined;

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

                // 记录首个 chunk 的时间作为流开始时间
                if (streamStartTime === undefined) {
                    streamStartTime = Date.now();
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

                            // 提取响应 ID（从首个 chunk）
                            if (chunk.id && typeof chunk.id === 'string') {
                                reporter.setResponseId(chunk.id);
                            }

                            // 检查是否是包含 usage 信息的最终 chunk
                            if (chunk.usage) {
                                finalUsage = chunk.usage;
                            }

                            // 处理正常的 choices
                            for (const choice of chunk.choices || []) {
                                const delta = choice.delta as ExtendedDelta | undefined;

                                // 处理思考内容（reasoning_content）
                                if (delta && delta.reasoning_content && typeof delta.reasoning_content === 'string') {
                                    reporter.bufferThinking(delta.reasoning_content);
                                }

                                // 处理文本内容
                                if (delta && delta.content && typeof delta.content === 'string') {
                                    reporter.reportText(delta.content);
                                }

                                // 处理工具调用 - 支持分块数据的累积处理
                                if (delta && delta.tool_calls && Array.isArray(delta.tool_calls)) {
                                    for (const toolCall of delta.tool_calls) {
                                        const toolIndex = toolCall.index ?? 0;
                                        reporter.accumulateToolCall(
                                            toolIndex,
                                            toolCall.id,
                                            toolCall.function?.name,
                                            toolCall.function?.arguments
                                        );
                                    }
                                }

                                // 注意：不在这里调用 flushAll，统一在流结束时处理
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

        // 记录流结束时间
        const streamEndTime = Date.now();

        // 流结束，输出所有剩余内容
        reporter.flushAll(null);

        Logger.trace(`[${model.name}] SSE 流处理统计: ${chunkCount} 个 chunk, hasContent=${reporter.hasContent}`);
        Logger.debug(`[${model.name}] 流处理完成`);

        if (finalUsage) {
            // 提取缓存 token 信息
            const cacheReadTokens = finalUsage.prompt_tokens_details?.cached_tokens ?? 0;
            // 计算输出速度
            const duration = streamStartTime && streamEndTime ? streamEndTime - streamStartTime : 0;
            const speed = duration > 0 ? ((finalUsage.completion_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.info(
                `📊 ${model.name} Token使用: 输入${finalUsage.prompt_tokens}${cacheReadTokens > 0 ? ` (缓存:${cacheReadTokens})` : ''} + 输出${finalUsage.completion_tokens} = 总计${finalUsage.total_tokens}, 耗时=${duration}ms, 速度=${speed} tokens/s`
            );
        }

        // === Token 统计: 更新实际 token ===
        try {
            const usagesManager = TokenUsagesManager.instance;
            await usagesManager.updateActualTokens({
                requestId,
                rawUsage: finalUsage || {},
                status: 'completed',
                streamStartTime,
                streamEndTime
            });
        } catch (err) {
            Logger.warn('更新Token统计失败:', err);
        }
    }
}
