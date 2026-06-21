/*---------------------------------------------------------------------------------------------
 *  OpenAI 自定义 SSE 处理器
 *  使用原生 fetch API 和自定义 SSE 流处理，支持 reasoning_content 等扩展字段
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger, createOpenCodeHeaders } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { StreamReporter } from './streamReporter';
import * as liveMetrics from '../metrics/liveMetrics';
import { t } from '../utils/l10n';
import type { GenericModelProvider } from '../providers/genericModelProvider';

/**
 * OpenAI Handler 接口（用于类型安全的消息和工具转换）
 */
interface IOpenAIHandler {
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[];
    convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[];
    buildChatCompletionParams(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions
    ): OpenAI.Chat.ChatCompletionCreateParamsStreaming;
}

/**
 * 扩展Delta类型以支持reasoning_content和reasoning字段
 */
export interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
    /** OpenRouter 等网关使用的 reasoning 字段 */
    reasoning?: string;
    reasoning_details?: unknown;
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
 * 从 reasoning_details 字段中提取可显示的文本内容。
 * 支持字符串、对象（text/content/reasoning/detail 等常见键）以及嵌套数组。
 * OpenRouter 等网关可能以多种格式返回该字段。
 */
function extractReasoningDetailsText(details: unknown): string | undefined {
    if (typeof details === 'string') {
        return details.length > 0 ? details : undefined;
    }
    if (Array.isArray(details)) {
        const texts: string[] = [];
        for (const item of details) {
            const t = extractReasoningDetailsText(item);
            if (t) {
                texts.push(t);
            }
        }
        return texts.length > 0 ? texts.join('') : undefined;
    }
    if (details && typeof details === 'object') {
        const obj = details as Record<string, unknown>;
        // 尝试常见字段名：text / content / reasoning / detail
        for (const key of ['text', 'content', 'reasoning', 'detail']) {
            const val = obj[key];
            if (typeof val === 'string' && val.length > 0) {
                return val;
            }
            if (Array.isArray(val)) {
                const result = extractReasoningDetailsText(val);
                if (result) {
                    return result;
                }
            }
        }
    }
    return undefined;
}

/**
 * OpenAI 自定义 SSE 处理器
 * 使用原生 fetch API 和自定义 SSE 流处理
 */
export class OpenAICustomHandler {
    constructor(
        private providerInstance: GenericModelProvider,
        private openaiHandler: IOpenAIHandler
    ) {}
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig {
        return this.providerInstance.providerConfig;
    }

    /**
     * 使用自定义 SSE 流处理的请求方法
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        requestStartTime?: number
    ): Promise<void> {
        const provider = modelConfig.provider || this.provider;
        const apiKey = await ApiKeyManager.getApiKey(provider);
        if (!apiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', provider));
        }

        const baseURL = (modelConfig.baseUrl || this.providerConfig?.baseUrl || 'https://api.openai.com/v1').replace(
            /\/$/,
            ''
        );
        const customEndpoint = modelConfig.endpoint;
        const url =
            customEndpoint ?
                customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://') ?
                    customEndpoint
                :   `${baseURL}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`
            :   `${baseURL}/chat/completions`;

        Logger.info(`[${model.name}] Processing ${messages.length} messages with custom SSE handler`);

        if (!this.openaiHandler) {
            throw new Error(t('OpenAI handler is not initialized', 'OpenAI 处理器未初始化'));
        }

        // 构建请求参数（复用 OpenAIHandler 的共享方法）
        const requestBody = this.openaiHandler.buildChatCompletionParams(model, modelConfig, messages, options);

        Logger.debug(`[${model.name}] Sending API request`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        // 提前创建 reporter，使实时 TTFT 从 provider 请求处理起点开始滚动；
        // 该起点不等同于严格的网络请求发出时刻。
        let reporter: StreamReporter | undefined;

        try {
            reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress,
                sessionId,
                requestId,
                requestStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });

            // 合并提供商级别和模型级别的 customHeader
            // 模型级别的 customHeader 会覆盖提供商级别的同名头部
            const mergedCustomHeader = {
                ...this.providerConfig?.customHeader,
                ...modelConfig?.customHeader
            };

            // 处理合并后的 customHeader 中的 API 密钥替换
            const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

            // opencode 专有：传递请求级跟踪标识头
            if (this.provider === 'opencode') {
                Object.assign(processedCustomHeader, createOpenCodeHeaders(requestId, sessionId));
            }

            const response = await ConfigManager.fetchWithProxy(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                        ...processedCustomHeader
                    },
                    body: JSON.stringify(requestBody),
                    signal: abortController.signal
                },
                { modelConfig, providerKey: this.provider }
            );

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = t(
                    'API request failed: {0} {1}',
                    'API 请求失败: {0} {1}',
                    response.status,
                    response.statusText
                );

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
                throw new Error(t('Response body is empty', '响应体为空'));
            }

            await this.processStream(
                model,
                response.body as ReadableStream<Uint8Array>,
                reporter,
                requestId || '',
                token
            );

            Logger.debug(`[${model.name}] API request completed`);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${model.name}] Request was cancelled by the user`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            reporter?.finishMetrics();
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
                    Logger.warn(`[${model.name}] Request was cancelled by the user`);
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                // 记录首个 raw chunk 的时间作为流开始时间，同时固定首令延迟（共用时间戳，保持与原统计口径一致）
                if (streamStartTime === undefined) {
                    const now = Date.now();
                    streamStartTime = now;
                    reporter.markStreamStarted(now);
                }

                // 心跳：触发轻量刷新（不固定首令延迟）
                reporter.heartbeat();

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
                            Logger.debug(`[${model.name}] Received stream end marker`);
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

                                // 处理思考内容（reasoning_content / reasoning）
                                const reasoningContent = delta?.reasoning_content ?? delta?.reasoning;
                                if (reasoningContent && typeof reasoningContent === 'string') {
                                    reporter.bufferThinking(reasoningContent);
                                } else {
                                    // reasoning_details 作为 fallback，仅在主源为空时使用，避免重复
                                    const detailsContent = extractReasoningDetailsText(delta?.reasoning_details);
                                    if (detailsContent) {
                                        reporter.bufferThinking(detailsContent);
                                    }
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
                            Logger.error(`[${model.name}] Failed to parse JSON: ${data}`, error);
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
        reporter.reportUsage(finalUsage);

        Logger.trace(`[${model.name}] SSE stream stats: ${chunkCount} chunks, hasContent=${reporter.hasContent}`);
        Logger.debug(`[${model.name}] Stream processing completed`);

        if (finalUsage) {
            // 提取缓存 token 信息
            const cacheReadTokens = finalUsage.prompt_tokens_details?.cached_tokens ?? 0;
            // 计算输出速度
            const duration = streamStartTime && streamEndTime ? streamEndTime - streamStartTime : 0;
            const speed = duration > 0 ? ((finalUsage.completion_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.info(
                `[${model.name}] Token usage: input ${finalUsage.prompt_tokens}${cacheReadTokens > 0 ? ` (cached: ${cacheReadTokens})` : ''} + output ${finalUsage.completion_tokens} = total ${finalUsage.total_tokens}, duration=${duration}ms, speed=${speed} tokens/s`
            );
        }

        // === Token 统计: 更新实际 token ===
        try {
            const usagesManager = TokenUsagesManager.instance;
            await usagesManager.updateActualTokens({
                requestId,
                sessionId: reporter.getSessionId(),
                rawUsage: finalUsage || {},
                status: 'completed',
                streamStartTime,
                streamEndTime
            });
        } catch (err) {
            Logger.warn('Failed to update token stats:', err);
        }
    }
}
