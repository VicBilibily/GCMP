/*---------------------------------------------------------------------------------------------
 *  Gemini API 兼容处理器
 *  使用 Google Generative Language API（:streamGenerateContent?alt=sse）处理模型请求，
 *  思维链内容以 thought part 内联返回，通过 StreamReporter 恢复思考过程。
 *  结构对齐 openaiCustomHandler（裸 fetch + 手写 SSE 流解析）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { hasFinalStatusRecorded, markFinalStatusRecorded } from '../utils/runtime/finalStatusMarker';
import { isCancellationError } from '../utils/text/cancellationError';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toNanoAiu,
    toCostBreakdownLog
} from '../utils/pricing/costCalculator';
import { RetryableError } from '../utils/retry/retryManager';
import { ConfigManager } from '../utils/config/configManager';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import {
    applyCustomHeaders,
    canonicalizeUserAgentHeader,
    mergeCustomHeaders
} from '../utils/net/httpHeaders';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { convertMessagesToGemini, convertToolsToGemini } from './gemini/geminiConverter';
import { buildGeminiRequest, normalizeGeminiUsage } from './gemini/geminiRequestBuilder';
import {
    GeminiStreamCancelledError,
    processGeminiJsonResponse,
    processGeminiStream
} from './gemini/geminiStreamProcessor';
import { StreamReporter } from './streamReporter';
import * as liveMetrics from './liveMetrics';
import { t } from '../utils/runtime/l10n';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import { isSubRequest, type RequestKind } from './requestClassifier';

/** 默认 Gemini API 地址 */
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Gemini API 兼容处理器
 * 使用原生 fetch API 调用 :streamGenerateContent?alt=sse 端点
 */
export class GeminiHandler {
    constructor(private readonly providerInstance: GenericModelProvider) {}
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }

    /**
     * 构建请求 URL：{baseUrl}/models/{model}:streamGenerateContent?alt=sse
     * modelConfig.endpoint 可覆盖默认路径（完整 URL 直接使用，相对路径拼接 baseUrl）
     */
    private buildRequestUrl(baseURL: string, modelConfig: ModelConfig, modelId: string): string {
        const customEndpoint = modelConfig.endpoint;
        if (customEndpoint) {
            if (customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://')) {
                return customEndpoint;
            }
            return `${baseURL}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`;
        }
        return `${baseURL}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    }

    /**
     * 认证头策略：
     * - 官方 Gemini API（generativelanguage.googleapis.com）使用 x-goog-api-key
     * - 其余（三方网关 / 代理）使用 Authorization: Bearer；
     *   同时发送两种头会导致部分网关路由异常（实测返回空内容）
     */
    private buildAuthHeaders(apiKey: string, baseURL: string): Record<string, string> {
        const isGoogleOfficial = /(^|\.)generativelanguage\.googleapis\.com$/i.test(
            baseURL.replace(/^https?:\/\//i, '').split('/')[0]
        );
        if (isGoogleOfficial) {
            return { 'x-goog-api-key': apiKey };
        }
        return { Authorization: `Bearer ${apiKey}` };
    }

    /**
     * 使用 Gemini API 处理请求
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
        wasThrottled = false
    ): Promise<void> {
        const provider = modelConfig.provider || this.provider;
        const apiKey = await ApiKeyManager.getApiKey(provider);
        if (!apiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', provider));
        }

        const baseURL = (modelConfig.baseUrl || this.providerConfig?.baseUrl || DEFAULT_GEMINI_BASE_URL).replace(
            /\/$/,
            ''
        );
        const modelId = modelConfig.model || modelConfig.id;
        const url = this.buildRequestUrl(baseURL, modelConfig, modelId);

        Logger.info(`[${model.name}] Processing ${messages.length} messages with Gemini API handler`);

        // 转换消息与工具
        const { contents, systemInstruction } = convertMessagesToGemini(modelConfig, messages);
        const tools = options.tools ? convertToolsToGemini([...options.tools]) : [];

        // 思考配置：子请求（提交、标题生成等）强制关闭思考
        const settings = options.modelConfiguration as ModelChatResponseOptions | undefined;
        const requestKind = (options.modelOptions as { requestKind?: RequestKind })?.requestKind;
        const thinkingOptions = {
            thinking: settings?.thinking,
            reasoningEffort: settings?.reasoningEffort,
            isSubRequest: requestKind ? isSubRequest(requestKind) : false
        };

        const requestBody = buildGeminiRequest({
            contents,
            systemInstruction,
            tools,
            maxOutputTokens: model.maxOutputTokens,
            thinkingOptions,
            extraBody: modelConfig.extraBody
        });

        Logger.debug(`[${model.name}] Sending Gemini API request, model: ${modelId}`);

        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());
        let reporter: StreamReporter | undefined;
        let requestMetricStartTime = requestStartTime;
        let partialStreamStartTime: number | undefined;

        try {
            // 合并提供商级别和模型级别的 customHeader
            const mergedCustomHeader = mergeCustomHeaders(this.providerConfig?.customHeader, modelConfig?.customHeader);
            const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey, sessionId);

            const requestHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                ...this.buildAuthHeaders(apiKey, baseURL)
            };
            applyCustomHeaders(requestHeaders, processedCustomHeader);
            canonicalizeUserAgentHeader(requestHeaders);

            requestMetricStartTime = Date.now();
            onRequestDispatched?.(requestMetricStartTime);

            reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider,
                sdkMode: 'gemini',
                progress,
                sessionId,
                requestId,
                requestStartTime: requestMetricStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });
            const streamReporter = reporter;

            const response = await ConfigManager.fetchWithProxy(
                url,
                {
                    method: 'POST',
                    headers: requestHeaders,
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

                let errorCode: string | number | undefined;
                try {
                    const errorJson = JSON.parse(errorText) as {
                        error?: { message?: string; code?: string | number; status?: string } | string;
                    };
                    if (typeof errorJson.error === 'string') {
                        errorMessage = errorJson.error;
                    } else if (errorJson.error?.message) {
                        errorMessage = errorJson.error.message;
                        errorCode = errorJson.error.code;
                    }
                } catch {
                    if (errorText) {
                        errorMessage = `${errorMessage} - ${errorText}`;
                    }
                }

                const error = new Error(errorMessage) as RetryableError;
                error.status = response.status;
                error.code = errorCode;
                throw error;
            }

            if (!response.body) {
                throw new Error(t('Response body is empty', '响应体为空'));
            }

            // 流式 / 非流式（部分网关忽略 alt=sse 直接返回 JSON）
            const contentType = response.headers.get('content-type') || '';
            let usageMetadata;
            let streamStartTime: number | undefined;
            let chunkCount = 0;

            if (contentType.includes('text/event-stream')) {
                const result = await processGeminiStream(
                    response.body as ReadableStream<Uint8Array>,
                    streamReporter,
                    () => token.isCancellationRequested
                );
                usageMetadata = result.usage;
                streamStartTime = result.streamStartTime;
                chunkCount = result.chunkCount;
            } else {
                const bodyText = await response.text();
                const result = processGeminiJsonResponse(bodyText, streamReporter);
                usageMetadata = result.usage;
                streamStartTime = result.streamStartTime;
                chunkCount = result.chunkCount;
            }
            partialStreamStartTime = streamStartTime;

            const streamEndTime = Date.now();
            const finalUsage = normalizeGeminiUsage(usageMetadata);

            // 流结束，输出所有剩余内容
            streamReporter.flushAll(null, undefined, finalUsage);

            // 客户端成本估算：仅在模型配置了 tokenPricing 时才执行
            const requestServiceTier = settings?.serviceTier;
            let costNanoAiu: number | undefined;
            let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
            if (modelConfig.tokenPricing) {
                const costAt = requestMetricStartTime ? new Date(requestMetricStartTime) : new Date();
                breakdown = calculateCostWithBreakdown(finalUsage, modelConfig.tokenPricing, costAt, requestServiceTier);
                if (breakdown) {
                    if (breakdown.total > 0) {
                        Logger.debug(formatCostBreakdownLog(model.name, breakdown));
                    }
                    costNanoAiu = toNanoAiu(breakdown.total);
                }
            }
            streamReporter.reportUsage(finalUsage, costNanoAiu);

            Logger.trace(`[${model.name}] Gemini stream stats: ${chunkCount} chunks, hasContent=${streamReporter.hasContent}`);

            if (finalUsage) {
                const cacheReadTokens = finalUsage.prompt_tokens_details?.cached_tokens ?? 0;
                const reasoningTokens = finalUsage.completion_tokens_details?.reasoning_tokens ?? 0;
                const duration = streamStartTime && streamEndTime ? streamEndTime - streamStartTime : 0;
                const speed = duration > 0 ? ((finalUsage.completion_tokens / duration) * 1000).toFixed(1) : 'N/A';
                Logger.info(
                    `[${model.name}] Token usage: input ${finalUsage.prompt_tokens}${cacheReadTokens > 0 ? ` (cached: ${cacheReadTokens})` : ''} + output ${finalUsage.completion_tokens}${reasoningTokens > 0 ? ` (thinking: ${reasoningTokens})` : ''} = total ${finalUsage.total_tokens}, duration=${duration}ms, speed=${speed} tokens/s`
                );
            }

            // === Token 统计: 更新实际 token（同步调用，内部写盘 fire-and-forget，不阻塞响应完成链路）===
            TokenUsagesManager.instance.updateActualTokens({
                requestId: requestId || '',
                sessionId: streamReporter.getSessionId(),
                rawUsage: finalUsage,
                status: token.isCancellationRequested ? 'cancelled' : 'completed',
                ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                wasThrottled,
                streamStartTime,
                streamEndTime,
                estimatedCost: breakdown?.total,
                costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
            });

            Logger.debug(`[${model.name}] Gemini API request completed`);
        } catch (error) {
            const cancelled = error instanceof GeminiStreamCancelledError || isCancellationError(error);
            if (cancelled) {
                Logger.warn(`[${model.name}] Request was cancelled by the user`);
                TokenUsagesManager.instance.updateActualTokens({
                    requestId: requestId || '',
                    sessionId: reporter?.getSessionId(),
                    status: 'cancelled',
                    ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                    wasThrottled,
                    streamStartTime: partialStreamStartTime ?? reporter?.getMetricStreamStartTime(),
                    streamEndTime: Date.now()
                });
                throw new vscode.CancellationError();
            }
            if (requestId && reporter?.hasContent) {
                if (!hasFinalStatusRecorded(error)) {
                    reporter.discardToolCalls();
                    reporter.flushAll(null);
                    TokenUsagesManager.instance.updateActualTokens({
                        requestId: requestId || '',
                        sessionId: reporter?.getSessionId(),
                        status: 'failed',
                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                        wasThrottled,
                        streamStartTime: partialStreamStartTime ?? reporter?.getMetricStreamStartTime(),
                        streamEndTime: Date.now()
                    });
                    markFinalStatusRecorded(error);
                }
            }
            throw error;
        } finally {
            reporter?.finishMetrics();
            cancellationListener.dispose();
        }
    }
}
