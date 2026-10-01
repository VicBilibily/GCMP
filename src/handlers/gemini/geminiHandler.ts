/*---------------------------------------------------------------------------------------------
 *  Gemini HTTP Handler
 *  纯 fetch + 自定义流解析（兼容 SSE data: 与 JSON 行流），不依赖 Google SDK
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigManager } from '../../utils/config/configManager';
import { Logger } from '../../utils/runtime/logger';
import { isCancellationError } from '../../utils/text/cancellationError';
import { hasFinalStatusRecorded, markFinalStatusRecorded } from '../../utils/runtime/finalStatusMarker';
import { applyCustomHeaders, mergeCustomHeaders } from '../../utils/net/httpHeaders';
import { replaceSessionIdInBody } from '../../utils/text/formatUtils';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toNanoAiu,
    toCostBreakdownLog
} from '../../utils/pricing/costCalculator';
import { t } from '../../utils/runtime/l10n';
import { TokenUsagesManager } from '../../usages/usagesManager';
import type { ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../../types/sharedTypes';
import type { GenericUsageData, RawUsageData } from '../../usages/fileLogger/types';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { convertMessagesToGemini, convertToolsToGemini } from './geminiConverter';
import { StreamReporter } from '../streamReporter';
import * as liveMetrics from '../liveMetrics';
import type { GenericModelProvider } from '../../providers/genericModelProvider';
import type {
    GeminiGenerateContentResponse,
    GeminiPart,
    GeminiSafetyRating,
    GeminiTool,
    GeminiUsageMetadata
} from './geminiType';
import { buildGeminiAuthHeaders, buildGeminiEndpoint, buildGeminiRequest, GeminiStreamParser } from './geminiRequest';
import type { RetryableError } from '../../utils/retry/retryManager';

interface GeminiTerminationIssue {
    kind: 'blocked' | 'failed';
    reason: string;
    message?: string;
}

interface GeminiResponseState {
    finishReason?: string;
    issue?: GeminiTerminationIssue;
}

interface GeminiPendingToolCall {
    callId: string;
    upstreamCallId?: string;
    name: string;
    args: Record<string, unknown>;
    signature?: string;
    rawPart: GeminiPart;
}

interface GeminiStreamState {
    historyParts: GeminiPart[];
    toolCalls: GeminiPendingToolCall[];
    toolCallsById: Map<string, GeminiPendingToolCall>;
    lastNamedToolCalls: GeminiPendingToolCall[];
    pendingSignature?: string;
}

interface GeminiStreamFailureContext {
    finalUsage?: RawUsageData;
    streamStartTime?: number;
    streamEndTime: number;
}

const geminiStreamFailureContexts = new WeakMap<Error, GeminiStreamFailureContext>();

const GEMINI_UNSPECIFIED_REASONS = new Set(['FINISH_REASON_UNSPECIFIED', 'BLOCKED_REASON_UNSPECIFIED']);
const GEMINI_STREAM_IDLE_TIMEOUT_MS = 300_000;
const GEMINI_BLOCKED_FINISH_REASONS = new Set([
    'SAFETY',
    'RECITATION',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'IMAGE_OTHER',
    'NO_IMAGE',
    'JAILBREAK',
    'MODEL_ARMOR'
]);

function normalizeGeminiReason(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : undefined;
}

function getBlockedSafetyCategories(ratings: GeminiSafetyRating[] | undefined): string[] {
    if (!Array.isArray(ratings)) {
        return [];
    }
    return ratings
        .filter(rating => rating?.blocked === true)
        .map(rating => normalizeGeminiReason(rating.category))
        .filter((category): category is string => Boolean(category));
}

function inspectGeminiResponse(event: GeminiGenerateContentResponse): GeminiResponseState {
    const promptReason = normalizeGeminiReason(event.promptFeedback?.blockReason);
    const promptSafetyCategories = getBlockedSafetyCategories(event.promptFeedback?.safetyRatings);
    if ((promptReason && !GEMINI_UNSPECIFIED_REASONS.has(promptReason)) || promptSafetyCategories.length > 0) {
        return {
            finishReason: 'content_filter',
            issue: {
                kind: 'blocked',
                reason: promptReason || promptSafetyCategories.join(', ') || 'SAFETY',
                message: event.promptFeedback?.blockReasonMessage
            }
        };
    }

    const candidate = Array.isArray(event.candidates) ? event.candidates[0] : undefined;
    const finishReason = normalizeGeminiReason(candidate?.finishReason);
    const candidateSafetyCategories = getBlockedSafetyCategories(candidate?.safetyRatings);
    if (candidateSafetyCategories.length > 0) {
        return {
            finishReason: 'content_filter',
            issue: {
                kind: 'blocked',
                reason: finishReason || candidateSafetyCategories.join(', '),
                message: candidate?.finishMessage
            }
        };
    }
    if (!finishReason || GEMINI_UNSPECIFIED_REASONS.has(finishReason)) {
        return {};
    }
    if (finishReason === 'STOP') {
        return { finishReason: 'stop' };
    }
    if (finishReason === 'MAX_TOKENS') {
        return { finishReason: 'length' };
    }
    if (GEMINI_BLOCKED_FINISH_REASONS.has(finishReason)) {
        return {
            finishReason: 'content_filter',
            issue: { kind: 'blocked', reason: finishReason, message: candidate?.finishMessage }
        };
    }
    return {
        finishReason: finishReason.toLowerCase(),
        issue: { kind: 'failed', reason: finishReason, message: candidate?.finishMessage }
    };
}

function mergeGeminiUsage(current: GenericUsageData | undefined, next: GeminiUsageMetadata): GenericUsageData {
    const merged: GenericUsageData = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(next)) {
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    return merged;
}

function rememberGeminiStreamFailure(error: unknown, context: GeminiStreamFailureContext): Error {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    geminiStreamFailureContexts.set(normalizedError, context);
    return normalizedError;
}

function getGeminiStreamFailureContext(error: unknown): GeminiStreamFailureContext | undefined {
    return error instanceof Error ? geminiStreamFailureContexts.get(error) : undefined;
}

/** 判断流异常是否携带已采集的部分 usage，供 provider 避免无依据重试。 */
export function hasGeminiPartialUsage(error: unknown): boolean {
    const usage = getGeminiStreamFailureContext(error)?.finalUsage;
    return usage !== undefined && Object.keys(usage).length > 0;
}

function parseHttpStatus(value: unknown): number | undefined {
    const status =
        typeof value === 'number' ? value
        : typeof value === 'string' && /^\d{3}$/.test(value.trim()) ? Number(value)
        : undefined;
    return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function getGeminiErrorStatus(value: unknown, depth = 0): number | undefined {
    if (!value || typeof value !== 'object' || depth > 2) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ['statusCode', 'status', 'code']) {
        const status = parseHttpStatus(record[key]);
        if (status !== undefined) {
            return status;
        }
    }
    return (
        getGeminiErrorStatus(record.error, depth + 1) ??
        getGeminiErrorStatus(record.cause, depth + 1) ??
        getGeminiErrorStatus(record.details, depth + 1)
    );
}

function createGeminiTerminationError(issue: GeminiTerminationIssue): Error {
    const detail = issue.message?.trim() || issue.reason;
    if (issue.kind === 'blocked') {
        return vscode.LanguageModelError.Blocked(t('Gemini response blocked: {0}', 'Gemini 响应被拦截：{0}', detail));
    }
    return new Error(t('Gemini response generation failed: {0}', 'Gemini 响应生成失败：{0}', detail));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeGeminiArgs(
    base: Record<string, unknown> | undefined,
    delta: Record<string, unknown>
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(base ?? {}) };
    for (const [key, value] of Object.entries(delta)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            continue;
        }
        const current = merged[key];
        merged[key] = isPlainRecord(current) && isPlainRecord(value) ? mergeGeminiArgs(current, value) : value;
    }
    return merged;
}

export class GeminiHandler {
    constructor(private readonly providerInstance: GenericModelProvider) {}

    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    private async getApiKey(modelConfig?: ModelConfig): Promise<string> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKeyForRequest(providerKey, modelConfig);
        if (!currentApiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', this.displayName));
        }
        return currentApiKey;
    }

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
        const baseUrl = modelConfig.baseUrl?.trim() || '';
        if (!baseUrl) {
            throw new Error(
                t('Gemini mode requires baseUrl in modelInfo', 'Gemini 模式需要在 modelInfo 中指定 baseUrl')
            );
        }
        const apiKey = await this.getApiKey(modelConfig);

        const processedHeaders = ApiKeyManager.processCustomHeader(
            mergeCustomHeaders(this.providerConfig?.customHeader, modelConfig.customHeader),
            apiKey,
            sessionId
        );
        ApiKeyManager.validateRequestApiKeyHash(modelConfig, apiKey, processedHeaders);
        const requestHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            ...buildGeminiAuthHeaders(baseUrl, apiKey)
        };
        applyCustomHeaders(requestHeaders, processedHeaders);

        const wireModelId = modelConfig.model || modelConfig.id;
        const endpoint = buildGeminiEndpoint(baseUrl, wireModelId);
        if (!endpoint) {
            throw new Error(
                t(
                    'Failed to build Gemini request URL (please check baseUrl / model configuration)',
                    '无法构建 Gemini 请求地址（请检查 baseUrl / model 配置）'
                )
            );
        }
        const markerProvider = modelConfig.provider || this.provider;
        const markerModelId = model.id;
        const markerRequestIdentity = crypto
            .createHash('sha256')
            .update(endpoint)
            .update('\0')
            .update(wireModelId)
            .digest('base64url');
        const { contents, systemInstruction } = convertMessagesToGemini(messages, {
            allowMedia: modelConfig.capabilities?.imageInput === true,
            provider: markerProvider,
            modelId: markerModelId,
            requestIdentity: markerRequestIdentity
        });
        const tools: GeminiTool[] = convertToolsToGemini(options.tools);
        const settings = options.modelConfiguration as ModelChatResponseOptions | undefined;
        const expandedExtraBody =
            modelConfig.extraBody ? replaceSessionIdInBody(modelConfig.extraBody, sessionId) : undefined;
        const requestBody = buildGeminiRequest(
            {
                contents,
                ...(systemInstruction ?
                    { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } }
                :   {})
            },
            { ...modelConfig, extraBody: expandedExtraBody },
            settings,
            model.maxOutputTokens,
            tools,
            options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
        );

        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        // 解析代理设置
        const proxyUrl = ConfigManager.resolveProxyForModel(modelConfig, this.provider);

        Logger.info(`🚀 ${model.name} Sending ${this.displayName} Gemini HTTP request (model=${wireModelId})`);

        // 创建统一的流报告器
        let reporter: StreamReporter | undefined;
        let requestMetricStartTime = requestStartTime;
        let partialStreamStartTime: number | undefined;
        let partialStreamEndTime: number | undefined;

        const calculateUsageCost = (usage: RawUsageData | undefined) => {
            let costNanoAiu: number | undefined;
            let estimatedCost: number | undefined;
            let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
            if (usage && modelConfig.tokenPricing) {
                const costAt = requestMetricStartTime ? new Date(requestMetricStartTime) : new Date();
                try {
                    breakdown = calculateCostWithBreakdown(
                        usage,
                        modelConfig.tokenPricing,
                        costAt,
                        settings?.serviceTier
                    );
                    if (breakdown) {
                        if (breakdown.total > 0) {
                            Logger.debug(formatCostBreakdownLog(model.name, breakdown));
                        }
                        costNanoAiu = toNanoAiu(breakdown.total);
                        estimatedCost = breakdown.total;
                    }
                } catch (err) {
                    Logger.warn(`[${model.name}] Failed to calculate cost:`, err);
                }
            }
            return { costNanoAiu, estimatedCost, breakdown };
        };

        try {
            requestMetricStartTime = Date.now();
            onRequestDispatched?.(requestMetricStartTime);

            reporter = new StreamReporter({
                modelName: model.name,
                modelId: markerModelId,
                provider: markerProvider,
                sdkMode: 'gemini',
                progress,
                sessionId,
                subSessionId: (options.modelOptions as { subSessionId?: string })?.subSessionId,
                requestId,
                requestStartTime: requestMetricStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });

            // 用途：执行 fetch 请求
            const response = await ConfigManager.fetchWithProxy(
                endpoint,
                {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody),
                    signal: abortController.signal
                } satisfies UndiciRequestInit,
                { proxyUrl }
            );

            // 用途：非 2xx 直接提取可读错误信息并抛出。
            if (!response.ok) {
                const text = await response.text();
                const message = this.extractErrorMessage(text || '', response.status, response.statusText);
                const error = new Error(message) as RetryableError;
                error.status = response.status;
                error.code = this.extractErrorCode(text);
                throw error;
            }

            // 用途：SSE/行流响应必须存在 response.body。
            if (!response.body) {
                throw new Error(t('Response body is empty', '响应体为空'));
            }

            // 用途：处理流式响应，返回 usage 和时间戳
            const { finalUsage, streamStartTime, streamEndTime, cancelled, terminalError } = await this.processStream(
                response.body as ReadableStream<Uint8Array>,
                reporter,
                token,
                GEMINI_STREAM_IDLE_TIMEOUT_MS,
                markerRequestIdentity
            );
            partialStreamStartTime = streamStartTime;
            partialStreamEndTime = streamEndTime;

            // 取消时保留已收集的部分 usage（对齐 vscode-copilot-chat 取消口径）
            if (cancelled) {
                const cancelError = new vscode.CancellationError();
                const partialCost = calculateUsageCost(finalUsage);
                reporter.reportUsage(finalUsage, partialCost.costNanoAiu);
                if (requestId) {
                    TokenUsagesManager.instance.updateActualTokens({
                        requestId,
                        sessionId: reporter.getSessionId(),
                        rawUsage: finalUsage,
                        status: 'cancelled',
                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                        wasThrottled,
                        streamStartTime,
                        streamEndTime,
                        estimatedCost: partialCost.estimatedCost,
                        costBreakdown: partialCost.breakdown ? toCostBreakdownLog(partialCost.breakdown) : undefined
                    });
                    markFinalStatusRecorded(cancelError);
                }
                throw cancelError;
            }

            const { costNanoAiu, estimatedCost, breakdown } = calculateUsageCost(finalUsage);
            reporter.reportUsage(finalUsage, costNanoAiu);

            if (terminalError) {
                if (requestId) {
                    TokenUsagesManager.instance.updateActualTokens({
                        requestId,
                        sessionId: reporter.getSessionId(),
                        rawUsage: finalUsage,
                        status: 'failed',
                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                        wasThrottled,
                        streamStartTime,
                        streamEndTime,
                        estimatedCost,
                        costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                    });
                }
                markFinalStatusRecorded(terminalError);
                throw terminalError;
            }

            // Token 统计: 更新实际 token
            if (requestId) {
                TokenUsagesManager.instance.updateActualTokens({
                    requestId,
                    sessionId: reporter.getSessionId(),
                    rawUsage: finalUsage,
                    status: 'completed',
                    ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                    wasThrottled,
                    streamStartTime,
                    streamEndTime,
                    estimatedCost,
                    costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                });
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Gemini HTTP request completed`);
        } catch (error) {
            abortController.abort();
            const streamFailure = getGeminiStreamFailureContext(error);
            const partialUsage = streamFailure?.finalUsage;
            partialStreamStartTime = streamFailure?.streamStartTime ?? partialStreamStartTime;
            partialStreamEndTime = streamFailure?.streamEndTime ?? partialStreamEndTime;
            const partialCost = calculateUsageCost(partialUsage);

            if (token.isCancellationRequested || isCancellationError(error)) {
                Logger.warn(`[${model.name}] Request was cancelled by the user`);
                reporter?.reportUsage(partialUsage, partialCost.costNanoAiu);
                if (requestId && !hasFinalStatusRecorded(error)) {
                    TokenUsagesManager.instance.updateActualTokens({
                        requestId,
                        sessionId: reporter?.getSessionId(),
                        rawUsage: partialUsage,
                        status: 'cancelled',
                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                        wasThrottled,
                        streamStartTime: partialStreamStartTime ?? reporter?.getMetricStreamStartTime(),
                        streamEndTime: partialStreamEndTime ?? Date.now(),
                        estimatedCost: partialCost.estimatedCost,
                        costBreakdown: partialCost.breakdown ? toCostBreakdownLog(partialCost.breakdown) : undefined
                    });
                    markFinalStatusRecorded(error);
                }
                throw new vscode.CancellationError();
            }

            if (requestId && reporter && (reporter.hasContent || partialUsage) && !hasFinalStatusRecorded(error)) {
                reporter.discardToolCalls();
                reporter.reportUsage(partialUsage, partialCost.costNanoAiu);
                reporter.flushAll(null, undefined, partialUsage);
                TokenUsagesManager.instance.updateActualTokens({
                    requestId,
                    sessionId: reporter.getSessionId(),
                    rawUsage: partialUsage,
                    status: 'failed',
                    ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                    wasThrottled,
                    streamStartTime: partialStreamStartTime ?? reporter.getMetricStreamStartTime(),
                    streamEndTime: partialStreamEndTime ?? Date.now(),
                    estimatedCost: partialCost.estimatedCost,
                    costBreakdown: partialCost.breakdown ? toCostBreakdownLog(partialCost.breakdown) : undefined
                });
                markFinalStatusRecorded(error);
            }

            Logger.error(`[${model.name}] Gemini HTTP error:`, error);

            throw error;
        } finally {
            reporter?.finishMetrics();
            cancelSub.dispose();
        }
    }

    /**
     * 处理 Gemini HTTP 流式响应，解析 SSE/行流增量输出并返回 usage 及时间戳。
     */
    private async processStream(
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        token: vscode.CancellationToken,
        idleTimeoutMs = GEMINI_STREAM_IDLE_TIMEOUT_MS,
        markerRequestIdentity?: string
    ): Promise<{
        finalUsage?: RawUsageData;
        streamStartTime?: number;
        streamEndTime?: number;
        cancelled?: boolean;
        finishReason?: string;
        terminalError?: Error;
    }> {
        // 用途：读取 Web ReadableStream，按标准 SSE 事件边界解析，同时兼容 JSON 行流。
        const reader = body.getReader();
        const decoder = new TextDecoder();
        const parser = new GeminiStreamParser();

        // Token 统计: 收集 usage 信息
        let finalUsage: RawUsageData | undefined;
        // 记录流处理的开始时间（首次接收数据时记录）
        let streamStartTime: number | undefined = undefined;
        let cancelled = false;
        let finishReason: string | undefined;
        let terminalError: Error | undefined;
        const streamState: GeminiStreamState = {
            historyParts: [],
            toolCalls: [],
            toolCallsById: new Map(),
            lastNamedToolCalls: []
        };

        const processPayload = (payload: string, isSse: boolean): void => {
            if (!payload || payload === '[DONE]') {
                return;
            }

            let chunk: unknown;
            try {
                chunk = JSON.parse(payload);
            } catch {
                throw new Error(
                    isSse ?
                        t('Invalid JSON in Gemini SSE data', 'Gemini SSE data 中包含无效 JSON')
                    :   t('Invalid JSON in Gemini response', 'Gemini 响应中包含无效 JSON')
                );
            }

            const events = Array.isArray(chunk) ? chunk : [chunk];
            for (const rawEvent of events) {
                if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
                    throw new Error(t('Invalid Gemini response payload', 'Gemini 响应负载无效'));
                }

                if (streamStartTime === undefined) {
                    const now = Date.now();
                    streamStartTime = now;
                    reporter.markStreamStarted(now);
                }

                const event = rawEvent as GeminiGenerateContentResponse;
                const errorObj = event.error;
                if (errorObj) {
                    const errorRecord =
                        typeof errorObj === 'object' && errorObj !== null ?
                            (errorObj as Record<string, unknown>)
                        :   { message: String(errorObj) };
                    const errorMsg =
                        typeof errorRecord.message === 'string' && errorRecord.message.trim() ?
                            errorRecord.message
                        :   JSON.stringify(errorRecord, null, 2);
                    const error = new Error(errorMsg) as RetryableError;
                    const errorCode = errorRecord.code ?? errorRecord.status;
                    if (typeof errorCode === 'string' || typeof errorCode === 'number') {
                        error.code = errorCode;
                    }
                    error.status = getGeminiErrorStatus(errorRecord);
                    (error as unknown as { error?: unknown }).error = errorRecord;
                    throw error;
                }

                if (event.responseId && typeof event.responseId === 'string') {
                    reporter.setResponseId(event.responseId);
                }
                if (event.usageMetadata) {
                    finalUsage = mergeGeminiUsage(finalUsage as GenericUsageData | undefined, event.usageMetadata);
                }

                const responseState = inspectGeminiResponse(event);
                if (responseState.finishReason) {
                    finishReason = responseState.finishReason;
                }
                if (responseState.issue) {
                    terminalError = createGeminiTerminationError(responseState.issue);
                    return;
                }

                this.processGeminiEvent(event, reporter, streamState);
            }
        };

        try {
            streamLoop: while (true) {
                if (token.isCancellationRequested) {
                    cancelled = true;
                    break;
                }
                const { done, value } = await this.readStreamChunk(reader, idleTimeoutMs);
                if (token.isCancellationRequested) {
                    cancelled = true;
                    break;
                }
                if (done) {
                    break;
                }
                reporter.heartbeat();
                for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
                    processPayload(payload.data, payload.isSse);
                    if (terminalError) {
                        break streamLoop;
                    }
                }
            }

            // 取消时不做 EOF flush：缓冲中的残缺事件按丢弃处理
            if (!cancelled && !terminalError) {
                for (const payload of parser.push(decoder.decode())) {
                    processPayload(payload.data, payload.isSse);
                    if (terminalError) {
                        break;
                    }
                }
                if (!terminalError) {
                    for (const payload of parser.finish()) {
                        processPayload(payload.data, payload.isSse);
                        if (terminalError) {
                            break;
                        }
                    }
                }
            }
        } catch (error) {
            throw rememberGeminiStreamFailure(error, {
                finalUsage,
                streamStartTime,
                streamEndTime: Date.now()
            });
        } finally {
            // HAR 克隆流的取消可能等待另一分支，不能阻塞错误返回。
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }

        // 记录流结束时间
        const streamEndTime = Date.now();

        if (!cancelled && !terminalError && !finishReason) {
            terminalError = new Error(
                t('Gemini response ended before receiving finishReason', 'Gemini 响应在收到 finishReason 前提前结束')
            );
        }

        // 流正常结束时，输出所有剩余内容
        if (!cancelled) {
            if (terminalError) {
                reporter.discardToolCalls();
            } else {
                for (const call of streamState.toolCalls) {
                    if (call.signature) {
                        reporter.setThoughtSignature(call.signature);
                    }
                    reporter.reportToolCall(call.callId, call.name, call.args, { recordOutputTime: false });
                }
                if (streamState.pendingSignature) {
                    reporter.setThoughtSignature(streamState.pendingSignature);
                }
            }
            reporter.flushAll(
                finishReason ?? null,
                {
                    sessionId: reporter.getSessionId(),
                    responseId: reporter.getResponseId() ?? '',
                    geminiRequestIdentity: markerRequestIdentity,
                    geminiToolCalls:
                        !terminalError && streamState.toolCalls.length > 0 ?
                            streamState.toolCalls.map(call => ({
                                localCallId: call.callId,
                                ...(call.upstreamCallId ? { upstreamCallId: call.upstreamCallId } : {}),
                                name: call.name
                            }))
                        :   undefined,
                    geminiContents:
                        !terminalError && streamState.historyParts.length > 0 ?
                            [{ role: 'model', parts: streamState.historyParts }]
                        :   undefined
                },
                finalUsage
            );
        }

        return { finalUsage, streamStartTime, streamEndTime, cancelled, finishReason, terminalError };
    }

    private async readStreamChunk(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        idleTimeoutMs: number
    ): Promise<ReadableStreamReadResult<Uint8Array>> {
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                const timeoutError = new Error(
                    t('ETIMEDOUT: Gemini stream timed out while waiting for data', 'ETIMEDOUT：Gemini 流等待数据超时')
                ) as RetryableError;
                timeoutError.code = 'ETIMEDOUT';
                reject(timeoutError);
            }, idleTimeoutMs);
        });

        try {
            return await Promise.race([reader.read(), timeoutPromise]);
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    private processGeminiEvent(
        event: GeminiGenerateContentResponse,
        reporter: StreamReporter,
        state: GeminiStreamState
    ): void {
        // 关键说明：流式场景通常只关心第一候选，其他候选（如有）暂不输出。
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        const cand = candidates.length > 0 ? candidates[0] : undefined;
        const parts = Array.isArray(cand?.content?.parts) ? (cand?.content?.parts as GeminiPart[]) : [];

        const currentNamedToolCalls: GeminiPendingToolCall[] = [];

        for (const part of parts) {
            // 解析 thoughtSignature：用于把“即将输出的 thinking”与后续 tool call 关联。
            const sig =
                (typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : '') ||
                (typeof part.thought_signature === 'string' && part.thought_signature ? part.thought_signature : '');
            // 解析 thinking：向 UI 输出。
            if (part.thought === true && typeof part.text === 'string' && part.text) {
                const effectiveSignature = sig || state.pendingSignature;
                state.pendingSignature = undefined;
                if (effectiveSignature) {
                    reporter.setThoughtSignature(effectiveSignature);
                }
                reporter.bufferThinking(part.text);
                // Gemini 的每个 thought part 是独立的思考块，处理完后立即结束
                reporter.flushThinking('Gemini thought part completed');
                reporter.endThinkingChain();
                state.historyParts.push(part);
                continue;
            }

            // 解析普通文本：直接增量输出。
            if (typeof part.text === 'string' && part.text) {
                const effectiveSignature = sig || state.pendingSignature;
                state.pendingSignature = undefined;
                if (effectiveSignature) {
                    reporter.setThoughtSignature(effectiveSignature);
                }
                reporter.reportText(part.text);
                state.historyParts.push(part);
                continue;
            }

            if (part.functionCall && typeof part.functionCall.name === 'string' && part.functionCall.name) {
                const upstreamCallId =
                    typeof part.functionCall.id === 'string' && part.functionCall.id ? part.functionCall.id : undefined;
                const callId = upstreamCallId ?? crypto.randomUUID();
                const args =
                    part.functionCall.args && typeof part.functionCall.args === 'object' ?
                        (part.functionCall.args as Record<string, unknown>)
                    :   {};
                if (upstreamCallId) {
                    const previous = state.toolCallsById.get(upstreamCallId);
                    const current = { name: part.functionCall.name, args };
                    if (previous) {
                        if (!isDeepStrictEqual({ name: previous.name, args: previous.args }, current)) {
                            throw new Error(
                                t(
                                    'Gemini repeated tool call {0} with conflicting content',
                                    'Gemini 重复返回了内容冲突的工具调用 {0}',
                                    upstreamCallId
                                )
                            );
                        }
                        if (sig && !previous.signature) {
                            previous.signature = sig;
                            if (!previous.rawPart.thoughtSignature && !previous.rawPart.thought_signature) {
                                previous.rawPart.thoughtSignature = sig;
                            }
                        }
                        currentNamedToolCalls.push(previous);
                        continue;
                    }
                }
                const rawPart: GeminiPart = {
                    ...part,
                    functionCall: {
                        ...part.functionCall,
                        ...(part.functionCall.args !== undefined ? { args } : {})
                    }
                };
                const pendingCall: GeminiPendingToolCall = {
                    callId,
                    upstreamCallId,
                    name: part.functionCall.name,
                    args,
                    signature: sig || state.pendingSignature,
                    rawPart
                };
                state.pendingSignature = undefined;
                state.toolCalls.push(pendingCall);
                state.toolCallsById.set(upstreamCallId ?? callId, pendingCall);
                currentNamedToolCalls.push(pendingCall);
                state.historyParts.push(rawPart);
                reporter.reportOutputEvent();
                continue;
            }

            if (part.functionCall) {
                const anonymousCall = part.functionCall as unknown as {
                    id?: string;
                    args?: Record<string, unknown>;
                };
                const candidates = currentNamedToolCalls.length > 0 ? currentNamedToolCalls : state.lastNamedToolCalls;
                let target =
                    typeof anonymousCall.id === 'string' && anonymousCall.id ?
                        state.toolCallsById.get(anonymousCall.id)
                    :   undefined;
                if (!target && candidates.length === 1) {
                    target = candidates[0];
                }
                if (!target && candidates.length > 1) {
                    throw new Error(
                        t(
                            'Gemini returned an anonymous argument delta for parallel tool calls',
                            'Gemini 为并行工具调用返回了无法归属的匿名参数增量'
                        )
                    );
                }
                if (target) {
                    if (isPlainRecord(anonymousCall.args)) {
                        const mergedArgs = mergeGeminiArgs(target.args, anonymousCall.args);
                        if (!isDeepStrictEqual(target.args, mergedArgs)) {
                            reporter.reportOutputEvent();
                        }
                        target.args = mergedArgs;
                        if (target.rawPart.functionCall) {
                            target.rawPart.functionCall.args = target.args;
                        }
                    }
                    if (sig && !target.signature) {
                        target.signature = sig;
                    }
                    if (sig && !target.rawPart.thoughtSignature && !target.rawPart.thought_signature) {
                        target.rawPart.thoughtSignature = sig;
                    }
                } else if (sig) {
                    state.pendingSignature = sig;
                }
                continue;
            }

            if (sig) {
                state.pendingSignature = sig;
            }
            state.historyParts.push(part);
        }

        if (currentNamedToolCalls.length > 0) {
            state.lastNamedToolCalls = currentNamedToolCalls;
        }
    }

    /**
     * 安全 JSON 解析：解析失败返回 null（用于忽略心跳/噪声行）。
     */
    private safeJsonParse(text: string): unknown | null {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private extractErrorCode(bodyText: string): string | number | undefined {
        const parsed = this.safeJsonParse(bodyText);
        if (!parsed || typeof parsed !== 'object') {
            return undefined;
        }
        const error = 'error' in parsed ? (parsed as { error?: unknown }).error : parsed;
        if (!error || typeof error !== 'object' || !('code' in error)) {
            return undefined;
        }
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' || typeof code === 'number' ? code : undefined;
    }

    private extractErrorMessage(bodyText: string, status: number, statusText: string): string {
        let msg = `API请求失败: ${status} ${statusText}`;
        const parsed = this.safeJsonParse(bodyText);
        let isExtracted = false;
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const err = (parsed as { error?: unknown }).error;
            if (err && typeof err === 'object' && 'message' in err) {
                const m = (err as { message?: unknown }).message;
                if (typeof m === 'string' && m.trim()) {
                    msg = m;
                    isExtracted = true;
                }
            }
        }
        if (parsed && typeof parsed === 'object' && 'detail' in parsed && !isExtracted) {
            const detail = (parsed as { detail?: unknown }).detail;
            if (typeof detail === 'string' && detail.trim()) {
                msg = detail;
                isExtracted = true;
            }
        }
        if (!isExtracted && bodyText.trim()) {
            msg = `${msg} - ${bodyText}`;
        }
        return msg;
    }
}
