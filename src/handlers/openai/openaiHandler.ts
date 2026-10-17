import { OpenAIChatRequestBuilder, filterChatExtraBodyParams } from './chat/requestBuilder';
import { OpenAIChatMessageConverter } from './chat/messageConverter';
import { isImageMimeType, createDataUrl } from './shared/images';
import { runStreamCleanup } from './shared/streamCleanup';
import { OpenAIClientFactory } from './transport/clientFactory';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../../utils/runtime/logger';
import { markFinalStatusRecorded } from '../../utils/runtime/finalStatusMarker';
import { createOpenCodeHeaders } from '../../utils/text/formatUtils';
import { RequestDiagnostics } from '../../utils/net/requestDiagnostics';
import { mergeCustomHeaders } from '../../utils/net/httpHeaders';
import { isCancellationError } from '../../utils/text/cancellationError';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toNanoAiu,
    toCostBreakdownLog
} from '../../utils/pricing/costCalculator';
import { t } from '../../utils/runtime/l10n';
import { TokenUsagesManager } from '../../usages/usagesManager';
import type { CustomHeaders, ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../../types/sharedTypes';
import { StreamReporter } from '../streamReporter';
import * as liveMetrics from '../liveMetrics';
import type { GenericModelProvider } from '../../providers/genericModelProvider';
import { reportChatCompletionText } from './openaiChatStreamText';

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
 * 扩展Choice类型以支持兼容旧格式的message字段
 */
interface ExtendedChoice extends OpenAI.Chat.Completions.ChatCompletionChunk.Choice {
    message?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
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
 * OpenAI API 错误详情类型
 */
interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

/**
 * OpenAI APIError 类型（包含 error 属性）
 */
interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
    status?: number;
    headers?: Headers;
}

interface OpenAIHandlerDependencies {
    clientFactory: OpenAIClientFactory;
    messageConverter: OpenAIChatMessageConverter;
    requestBuilder: OpenAIChatRequestBuilder;
}

/**
 * OpenAI SDK 处理器
 * 使用 OpenAI SDK 实现流式聊天完成，支持工具调用
 */
export class OpenAIHandler {
    // SDK事件去重跟踪器（基于请求级别）
    private currentRequestProcessedEvents = new Set<string>();

    private readonly clientFactory: OpenAIClientFactory;
    private readonly messageConverter: OpenAIChatMessageConverter;
    private readonly requestBuilder: OpenAIChatRequestBuilder;

    constructor(
        private providerInstance: GenericModelProvider,
        dependencies: Partial<OpenAIHandlerDependencies> = {}
    ) {
        // providerInstance 提供动态获取 providerConfig 和 providerKey 的能力
        this.clientFactory = dependencies.clientFactory ?? new OpenAIClientFactory(providerInstance);
        this.messageConverter = dependencies.messageConverter ?? new OpenAIChatMessageConverter(providerInstance);
        this.requestBuilder =
            dependencies.requestBuilder ?? new OpenAIChatRequestBuilder(providerInstance, this.messageConverter);
    }
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    /** 返回 OpenAI 模型请求可删除的自定义 header 标记。 */
    getModelRequestHeaderDeletions(modelConfig?: ModelConfig): CustomHeaders {
        return this.clientFactory.getModelRequestHeaderDeletions(modelConfig);
    }

    /**
     * 创建新的 OpenAI 客户端
     */
    async createOpenAIClient(
        modelConfig?: ModelConfig,
        sessionId?: string,
        diagnostics?: RequestDiagnostics
    ): Promise<OpenAI> {
        return this.clientFactory.createOpenAIClient(modelConfig, sessionId, diagnostics);
    }

    /**
     * 创建自定义 fetch 函数来处理非标准 SSE 格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     * 若 modelConfig.endpoint 已设置，则将 SDK 内部构造的请求 URL 替换为自定义端点
     */
    private createCustomFetch(
        modelConfig?: ModelConfig,
        resolvedBaseURL?: string,
        proxyUrl?: string,
        diagnostics?: RequestDiagnostics
    ): typeof fetch {
        return this.clientFactory.createCustomFetch(modelConfig, resolvedBaseURL, proxyUrl, diagnostics);
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    private async preprocessSSEResponse(response: Response, diagnostics?: RequestDiagnostics): Promise<Response> {
        return this.clientFactory.preprocessSSEResponse(response, diagnostics);
    }

    /**
     * 构建聊天完成请求参数（共享方法，供 openai-sse 等自定义处理器复用）
     */
    buildChatCompletionParams(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        sessionId?: string
    ): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
        return this.requestBuilder.buildChatCompletionParams(model, modelConfig, messages, options, sessionId);
    }

    /**
     * 处理聊天完成请求 - 使用 OpenAI SDK 流式接口
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
        requestStartTime?: number,
        onRequestDispatched?: (requestMetricStartTime: number) => void,
        wasThrottled = false,
        diagnostics?: RequestDiagnostics
    ): Promise<void> {
        const trace =
            diagnostics ??
            new RequestDiagnostics(
                {
                    requestId,
                    sessionId,
                    subSessionId: (options.modelOptions as { subSessionId?: string })?.subSessionId,
                    provider: modelConfig.provider || this.provider,
                    modelId: model.id,
                    sdkMode: 'openai'
                },
                entry => Logger.debug('[Request lifecycle]', entry),
                () => ({ tokenCancelled: token.isCancellationRequested })
            );
        let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
        Logger.debug(`${model.name} starting ${this.displayName} request handling`);
        // 清理当前请求的事件去重跟踪器
        this.currentRequestProcessedEvents.clear();

        let reporter: StreamReporter | undefined;
        let requestMetricStartTime = requestStartTime;

        try {
            // 使用 OpenAI SDK 的事件驱动流式方法，利用内置工具调用处理
            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            trace.bindSignal(abortController.signal);
            const cancellationListener = token.onCancellationRequested(() => {
                trace.abort('host_token');
                abortController.abort();
            });
            let streamError: Error | null = null; // 用于捕获流错误
            let streamFailed = false;
            // 保存最后一个 chunk 的 usage 信息（若有），部分提供商会在每个 chunk 返回 usage
            let finalUsage: OpenAI.Completions.CompletionUsage | undefined = undefined;
            // 记录流处理的开始和结束时间
            let streamStartTime: number | undefined = undefined;
            let streamEndTime: number | undefined = undefined;

            try {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                const client = await this.createOpenAIClient(modelConfig, sessionId, trace);
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                Logger.debug(`${model.name} sending ${messages.length} messages using ${this.displayName}`);

                const createParams = this.buildChatCompletionParams(model, modelConfig, messages, options, sessionId);

                Logger.info(`🚀 ${model.name} Sending ${this.displayName} request`);

                // opencode 专有：传递请求级跟踪标识头
                const streamOptions: Record<string, unknown> = { signal: abortController.signal };
                const requestHeaders = mergeCustomHeaders(
                    this.provider === 'opencode' ? createOpenCodeHeaders(requestId, sessionId) : undefined,
                    this.getModelRequestHeaderDeletions(modelConfig)
                );
                if (Object.keys(requestHeaders).length > 0) {
                    streamOptions.headers = requestHeaders;
                }

                requestMetricStartTime = Date.now();
                onRequestDispatched?.(requestMetricStartTime);

                reporter = new StreamReporter({
                    modelName: model.name,
                    modelId: model.id,
                    provider: modelConfig.provider || this.provider,
                    sdkMode: 'openai',
                    progress: {
                        report: part => {
                            trace.progress();
                            progress.report(part);
                        }
                    },
                    sessionId,
                    subSessionId: (options.modelOptions as { subSessionId?: string })?.subSessionId,
                    requestId,
                    requestStartTime: requestMetricStartTime,
                    onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
                });
                const streamReporter = reporter;

                const stream = client.chat.completions.stream(createParams, streamOptions);
                // 利用 SDK 内置的事件系统处理工具调用和内容
                stream
                    .on('chunk', (chunk, _snapshot: unknown) => {
                        trace.streamEvent();
                        // 记录首个 chunk 的时间作为流开始时间，同时固定首流延迟（共用时间戳）
                        if (streamStartTime === undefined) {
                            const now = Date.now();
                            streamStartTime = now;
                            streamReporter.markStreamStarted(now);
                        }

                        // 心跳：触发实时指标更新（不固定首流延迟）
                        streamReporter.heartbeat();

                        // 处理token使用统计：仅保存到 finalUsage，最后再统一输出
                        if (chunk.usage) {
                            // 直接保存 SDK 返回的 usage 对象（类型为 CompletionUsage）
                            finalUsage = chunk.usage;
                        }

                        // 处理思考内容（reasoning_content）和兼容旧格式：有些模型把最终结果放在 choice.message
                        // 思维链是可重入的：遇到时输出；在后续第一次可见 content 输出前，需要结束当前思维链（done）
                        if (chunk.choices && chunk.choices.length > 0) {
                            // 遍历所有choices，处理每个choice的reasoning_content和message.content
                            for (const choice of chunk.choices) {
                                const extendedChoice = choice as ExtendedChoice;
                                const delta = extendedChoice.delta as ExtendedDelta | undefined;
                                const message = extendedChoice.message;

                                // 处理工具调用 - 支持分块数据的累积处理
                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                    for (const toolCall of delta.tool_calls) {
                                        const toolIndex = toolCall.index ?? 0;
                                        streamReporter.accumulateToolCall(
                                            toolIndex,
                                            toolCall.id,
                                            toolCall.function?.name,
                                            toolCall.function?.arguments,
                                            choice.index ?? 0
                                        );
                                    }
                                }

                                if (choice.finish_reason) {
                                    if (
                                        choice.finish_reason === 'content_filter' ||
                                        choice.finish_reason === 'length'
                                    ) {
                                        streamReporter.discardToolCalls(choice.index ?? 0);
                                    } else {
                                        streamReporter.flushToolCalls(choice.index ?? 0);
                                    }
                                }

                                // 兼容：优先使用 delta 中的 reasoning_content/reasoning，否则尝试从 message 中读取
                                const reasoningContent =
                                    delta?.reasoning_content ??
                                    delta?.reasoning ??
                                    message?.reasoning_content ??
                                    message?.reasoning;
                                if (reasoningContent) {
                                    streamReporter.bufferThinking(reasoningContent);
                                } else {
                                    // reasoning_details 作为 fallback，仅在主源为空时使用，避免重复
                                    const detailsContent = extractReasoningDetailsText(delta?.reasoning_details);
                                    if (detailsContent) {
                                        streamReporter.bufferThinking(detailsContent);
                                    }
                                }

                                reportChatCompletionText({ delta, message }, streamReporter);
                            }
                        }
                    })
                    .on('error', (error: Error) => {
                        trace.error(error);
                        trace.abort('stream_error');
                        // 保存错误，并中止请求
                        streamError = error;
                        abortController.abort();
                    });
                // 等待流处理完成
                await stream.done();

                // 记录流结束时间
                streamEndTime = Date.now();

                // 检查是否有流错误
                if (streamError) {
                    throw streamError;
                }

                // 流结束，输出所有剩余内容
                streamReporter.flushAll(null, undefined, finalUsage);

                // 客户端成本估算：仅在模型配置了 tokenPricing 时才执行
                // 峰谷定价：用请求开始时间匹配 tier，确保整条流式响应按同一档位计费
                // 服务等级计费：传入 serviceTier，让 tier 按 serviceTier 匹配
                let costNanoAiu: number | undefined;
                let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
                if (modelConfig.tokenPricing) {
                    const costAt = requestMetricStartTime ? new Date(requestMetricStartTime) : new Date();
                    const requestServiceTier = (options.modelConfiguration as ModelChatResponseOptions)?.serviceTier;
                    breakdown = calculateCostWithBreakdown(
                        finalUsage,
                        modelConfig.tokenPricing,
                        costAt,
                        requestServiceTier
                    );
                    if (breakdown) {
                        if (breakdown.total > 0) {
                            Logger.debug(formatCostBreakdownLog(model.name, breakdown));
                        }
                        costNanoAiu = toNanoAiu(breakdown.total);
                    }
                }
                streamReporter.reportUsage(finalUsage, costNanoAiu);

                // 计算并记录输出速度
                const usageData = finalUsage as OpenAI.Completions.CompletionUsage | undefined;
                if (usageData && streamStartTime && streamEndTime) {
                    const duration = streamEndTime - streamStartTime;
                    const outputTokens = usageData.completion_tokens ?? 0;
                    const speed = duration > 0 ? ((outputTokens / duration) * 1000).toFixed(1) : 'N/A';
                    Logger.info(
                        `📊 ${model.name} OpenAI request completed, output=${outputTokens} tokens, duration=${duration}ms, speed=${speed} tokens/s`,
                        usageData
                    );
                } else {
                    Logger.info(`📊 ${model.name} OpenAI request completed`, finalUsage);
                }

                if (requestId) {
                    // === Token 统计: 更新实际 token（同步调用，内部写盘 fire-and-forget，不阻塞响应完成链路）===
                    // 直接传递原始 usage 对象，包含流时间信息
                    TokenUsagesManager.instance.updateActualTokens({
                        requestId,
                        sessionId,
                        rawUsage: finalUsage,
                        status: token.isCancellationRequested ? 'cancelled' : 'completed',
                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                        wasThrottled,
                        streamStartTime,
                        streamEndTime,
                        estimatedCost: breakdown?.total,
                        costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                    });
                }

                Logger.debug(`${model.name} ${this.displayName} SDK stream completed`);
            } catch (streamError) {
                streamFailed = true;
                trace.error(streamError);
                if (token.isCancellationRequested || isCancellationError(streamError)) {
                    Logger.info(`${model.name} request was cancelled`);
                    // 记录为中止状态（同步调用，内部写盘 fire-and-forget，不阻塞取消链路），而非错误或完成
                    runStreamCleanup(
                        [
                            () =>
                                TokenUsagesManager.instance.updateActualTokens({
                                    requestId,
                                    sessionId,
                                    status: 'cancelled',
                                    ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                                    wasThrottled,
                                    streamStartTime,
                                    streamEndTime: streamEndTime ?? Date.now()
                                })
                        ],
                        true
                    );
                    throw new vscode.CancellationError();
                } else {
                    const finalStreamEndTime = streamEndTime ?? Date.now();
                    if (requestId && reporter?.hasContent) {
                        let costNanoAiu: number | undefined;
                        let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
                        if (modelConfig.tokenPricing) {
                            const costAt = requestMetricStartTime ? new Date(requestMetricStartTime) : new Date();
                            const requestServiceTier = (options.modelConfiguration as ModelChatResponseOptions)
                                ?.serviceTier;
                            breakdown = calculateCostWithBreakdown(
                                finalUsage,
                                modelConfig.tokenPricing,
                                costAt,
                                requestServiceTier
                            );
                            if (breakdown) {
                                if (breakdown.total > 0) {
                                    Logger.debug(formatCostBreakdownLog(model.name, breakdown));
                                }
                                costNanoAiu = toNanoAiu(breakdown.total);
                            }
                        }
                        runStreamCleanup(
                            [
                                () => reporter?.reportUsage(finalUsage, costNanoAiu),
                                () => reporter?.discardToolCalls(),
                                () => reporter?.flushAll(null, undefined, finalUsage),
                                () => {
                                    TokenUsagesManager.instance.updateActualTokens({
                                        requestId,
                                        sessionId,
                                        rawUsage: finalUsage,
                                        status: 'failed',
                                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                                        wasThrottled,
                                        streamStartTime,
                                        streamEndTime: finalStreamEndTime,
                                        estimatedCost: breakdown?.total,
                                        costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                                    });
                                    markFinalStatusRecorded(streamError);
                                }
                            ],
                            true
                        );
                    }
                    Logger.error(`${model.name} SDK stream processing error: ${streamError}`);
                    throw streamError;
                }
            } finally {
                runStreamCleanup([() => cancellationListener.dispose()], streamFailed);
            }

            outcome = token.isCancellationRequested ? 'cancelled' : 'completed';
            Logger.debug(`${model.name} ${this.displayName} request ${outcome}`);
        } catch (error) {
            trace.error(error);
            // 内层流 catch 已通过 updateActualTokens 记录为 cancelled，这里规范化为 CancellationError 后抛出
            if (token.isCancellationRequested || isCancellationError(error)) {
                outcome = 'cancelled';
                throw new vscode.CancellationError();
            }

            if (error instanceof OpenAI.APIError && (error.status !== undefined || error.error !== undefined)) {
                Logger.error(`${model.name} ${this.displayName} request failed: ${error.message}`);
                throw error;
            }

            if (error instanceof Error) {
                if (error.cause instanceof Error) {
                    const errorMessage = error.cause.message || t('Unknown error', '未知错误');
                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);
                    throw error;
                } else {
                    let errorMessage = error.message || t('Unknown error', '未知错误');

                    // 尝试从 OpenAI SDK 的 APIError 中提取详细的错误信息
                    // APIError 对象有一个 error 属性，其中包含了原始的 API 错误响应
                    const apiError = error as APIErrorWithError;
                    if (apiError.error && typeof apiError.error === 'object') {
                        const errorDetail = apiError.error as APIErrorDetail;
                        if (errorDetail.message && typeof errorDetail.message === 'string') {
                            errorMessage = errorDetail.message;
                            Logger.debug(
                                `${model.name} Extracted detailed error message from APIError.error: ${errorMessage}`
                            );
                        }
                    }

                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);

                    // 对于普通错误，也需要重新抛出
                    throw error;
                }
            }

            // 改进的错误处理，参照官方示例
            if (error instanceof vscode.CancellationError) {
                // 取消错误不需要额外处理，直接重新抛出
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                Logger.debug(`LanguageModelError details: code=${error.code}, cause=${error.cause}`);
                // 根据官方示例的错误处理模式，使用字符串比较
                if (error.code === 'blocked') {
                    Logger.warn('Request blocked, may contain inappropriate content');
                } else if (error.code === 'noPermissions') {
                    Logger.warn('Insufficient permissions, please check API key and model access');
                } else if (error.code === 'notFound') {
                    Logger.warn('Model not found or unavailable');
                } else if (error.code === 'quotaExceeded') {
                    Logger.warn('Quota exceeded, please check API usage limits');
                } else if (error.code === 'unknown') {
                    Logger.warn('Unknown language model error');
                }
                throw error;
            } else {
                // 其他错误类型
                throw error;
            }
        } finally {
            runStreamCleanup(
                [
                    () => reporter?.finishMetrics(),
                    () => {
                        if (!diagnostics) {
                            trace.finish(outcome);
                        }
                    }
                ],
                outcome !== 'completed'
            );
        }
    }

    /**
     * 参照官方实现的消息转换 - 使用 OpenAI SDK 标准模式
     * 支持文本、图片和工具调用
     * 公共方法，可被其他 Provider 复用
     */
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        return this.messageConverter.convertMessagesToOpenAI(messages, modelConfig);
    }

    /**
     * 转换单个消息 - 参照 OpenAI SDK 官方模式
     */
    public convertSingleMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[] | null {
        return this.messageConverter.convertSingleMessage(message, modelConfig);
    }

    /**
     * 工具转换 - 确保参数格式正确
     * 公共方法，可被其他 Provider 复用
     */
    public convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[] {
        return this.messageConverter.convertToolsToOpenAI(tools);
    }

    /**
     * 检查是否为图片MIME类型
     */
    public isImageMimeType(mimeType: string): boolean {
        return isImageMimeType(mimeType);
    }

    /**
     * 创建图片的data URL
     */
    public createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        return createDataUrl(dataPart);
    }

    /**
     * 过滤extraBody中不可修改的核心参数
     * @param extraBody 原始extraBody参数
     * @returns 过滤后的参数，移除了不可修改的核心参数
     */
    public static filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        return filterChatExtraBodyParams(extraBody);
    }
}
