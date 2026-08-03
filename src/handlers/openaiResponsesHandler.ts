/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API 处理器
 *  专门处理 OpenAI Responses API 的消息转换和请求处理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClientOptions } from 'openai';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import type { GenericUsageData } from '../usages/fileLogger/types';
import { TokenUsagesManager } from '../usages/usagesManager';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toCostBreakdownLog,
    toNanoAiu
} from '../utils/pricing/costCalculator';
import { t } from '../utils/runtime/l10n';
import { Logger } from '../utils/runtime/logger';
import { isCancellationError } from '../utils/text/cancellationError';
import { createOpenCodeHeaders } from '../utils/text/formatUtils';
import { ModelChatResponseOptions, ModelConfig, ModelTokenPricing } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { StreamReporter } from './streamReporter';
import * as liveMetrics from './liveMetrics';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import { OpenAIResponsesMessageConverter } from './openai/openaiResponsesMessageConverter';
import { OpenAIResponsesRequestBuilder } from './openai/openaiResponsesRequestBuilder';
import { OpenAIResponsesStreamProcessor } from './openai/openaiResponsesStreamProcessor';

interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
}

/**
 * OpenAI Responses API 处理器
 * 专门处理 Responses API 的消息转换和请求
 */
export class OpenAIResponsesHandler {
    private handler: OpenAIHandler;
    private messageConverter: OpenAIResponsesMessageConverter;
    private requestBuilder: OpenAIResponsesRequestBuilder;

    constructor(
        private providerInstance: GenericModelProvider,
        handler: OpenAIHandler
    ) {
        this.handler = handler;
        this.messageConverter = new OpenAIResponsesMessageConverter(handler, this.displayName);
        this.requestBuilder = new OpenAIResponsesRequestBuilder(
            this.displayName,
            this.messageConverter,
            this.providerKey
        );
    }

    private get providerKey(): string {
        return this.providerInstance.provider;
    }

    private get displayName(): string {
        return this.providerInstance.providerConfig.displayName;
    }

    /**
     * 处理 Responses API 请求 - 使用 OpenAI SDK 流式接口
     * 这是处理 openai-responses 模式的专用方法
     */
    async handleResponsesRequest(
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
        Logger.debug(`${model.name} starting ${this.displayName} Responses API request handling`);
        let reporter: StreamReporter | undefined;

        try {
            const client = await this.handler.createOpenAIClient(modelConfig);
            Logger.info(`🚀 ${model.name} Sending ${this.displayName} Responses API request`);

            // 创建统一的流报告器
            reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.providerKey,
                sdkMode: 'openai-responses',
                progress,
                sessionId,
                requestId,
                requestStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });
            // 局部收窄：try 块内用 const 引用确保 TypeScript 知道非 undefined，
            // 外层 let reporter 供 finally 兜底使用
            const streamReporter = reporter;

            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let finalUsage: GenericUsageData | undefined = undefined;
            // 记录流处理的开始和结束时间（response.created 到达前为 undefined，避免使用进入函数的旧时间）
            let streamStartTime: number | undefined;
            let streamEndTime: number | undefined = undefined;

            try {
                const { requestBody } = this.requestBuilder.build({
                    model,
                    modelConfig,
                    messages,
                    options,
                    sessionId
                });

                await this.configureClientHeaders(client, requestId, sessionId);

                Logger.info(`🎯 ${model.name} Using session_id: ${sessionId}`);

                // 调用 Responses API 的流式方法
                const stream = client.responses.stream(requestBody, { signal: abortController.signal });
                const streamProcessor = new OpenAIResponsesStreamProcessor({
                    modelName: model.name,
                    displayName: this.displayName,
                    token,
                    abortController,
                    streamReporter,
                    sessionId
                });
                streamProcessor.attach(stream);
                await streamProcessor.waitForCompletion(stream);

                finalUsage = streamProcessor.getFinalUsage();
                streamStartTime = streamProcessor.getStreamStartTime();
                streamEndTime = streamProcessor.getStreamEndTime();

                const completionResult = this.reportCompletion({
                    modelName: model.name,
                    tokenPricing: modelConfig.tokenPricing,
                    options,
                    requestId,
                    sessionId,
                    token,
                    streamReporter,
                    finalUsage,
                    streamStartTime,
                    streamEndTime,
                    requestStartTime
                });
                streamStartTime = completionResult.streamStartTime;
            } catch (error) {
                if (token.isCancellationRequested || isCancellationError(error)) {
                    this.reportCancellation({
                        modelName: model.name,
                        requestId,
                        sessionId,
                        streamStartTime,
                        streamEndTime
                    });
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} Responses API stream processing error: ${error}`);
                    throw error;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Responses API request completed`);
        } catch (error) {
            this.rethrowResponsesError(error, model.name);
        } finally {
            reporter?.finishMetrics();
        }
    }

    private async configureClientHeaders(client: unknown, requestId: string, sessionId: string): Promise<void> {
        const { _options: clientOptions } = client as { _options: ClientOptions };
        const { defaultHeaders: optHeaders } = clientOptions as { defaultHeaders: Record<string, string> };
        optHeaders['conversation_id'] = optHeaders['session_id'] = sessionId;

        if (this.providerKey === 'opencode') {
            Object.assign(optHeaders, createOpenCodeHeaders(requestId, sessionId));
        }

        if (this.providerKey !== 'codex') {
            return;
        }

        const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth;
        const accountId = await codexAuth?.getAccountId();
        if (accountId && accountId.trim()) {
            optHeaders['chatgpt-account-id'] = accountId.trim();
        }
    }

    private reportCompletion(params: {
        modelName: string;
        tokenPricing?: ModelTokenPricing;
        options: vscode.ProvideLanguageModelChatResponseOptions;
        requestId: string;
        sessionId: string;
        token: vscode.CancellationToken;
        streamReporter: StreamReporter;
        finalUsage?: GenericUsageData;
        streamStartTime?: number;
        streamEndTime?: number;
        requestStartTime?: number;
    }): { streamStartTime?: number } {
        const {
            modelName,
            tokenPricing,
            options,
            requestId,
            sessionId,
            token,
            streamReporter,
            finalUsage,
            streamEndTime,
            requestStartTime
        } = params;

        let streamStartTime = params.streamStartTime;
        let costNanoAiu: number | undefined;
        let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;

        if (tokenPricing) {
            const costAt = requestStartTime ? new Date(requestStartTime) : new Date();
            const requestServiceTier = (options.modelConfiguration as ModelChatResponseOptions)?.serviceTier;
            breakdown = calculateCostWithBreakdown(finalUsage, tokenPricing, costAt, requestServiceTier);
            if (breakdown) {
                if (breakdown.total > 0) {
                    Logger.debug(formatCostBreakdownLog(streamReporter.getModelName(), breakdown));
                }
                costNanoAiu = toNanoAiu(breakdown.total);
            }
        }

        streamReporter.reportUsage(finalUsage, costNanoAiu);
        Logger.info(`📊 ${modelName} Responses API request completed`, finalUsage);

        streamStartTime ??= streamReporter.getMetricStreamStartTime();

        if (requestId) {
            // 更新实际 token（同步调用，内部写盘 fire-and-forget，不阻塞响应完成链路）
            TokenUsagesManager.instance.updateActualTokens({
                requestId,
                sessionId,
                rawUsage: finalUsage,
                status: token.isCancellationRequested ? 'cancelled' : 'completed',
                streamStartTime,
                streamEndTime,
                estimatedCost: breakdown?.total,
                costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
            });
        }

        Logger.debug(`${modelName} ${this.displayName} Responses API stream completed`);
        return { streamStartTime };
    }

    private reportCancellation(params: {
        modelName: string;
        requestId: string;
        sessionId: string;
        streamStartTime?: number;
        streamEndTime?: number;
    }): void {
        const { modelName, requestId, sessionId, streamStartTime, streamEndTime } = params;
        Logger.info(`${modelName} Responses API request was cancelled by the user`);
        // 记录取消状态（同步调用，内部写盘 fire-and-forget，不阻塞取消链路）
        TokenUsagesManager.instance.updateActualTokens({
            requestId,
            sessionId,
            status: 'cancelled',
            streamStartTime,
            streamEndTime: streamEndTime ?? Date.now()
        });
    }

    private rethrowResponsesError(error: unknown, modelName: string): never {
        if (error instanceof Error) {
            let errorMessage = error.message || t('Unknown error', '未知错误');

            const apiError = error as APIErrorWithError;
            if (apiError.error && typeof apiError.error === 'object') {
                const errorDetail = apiError.error as APIErrorDetail;
                if (errorDetail.message && typeof errorDetail.message === 'string') {
                    errorMessage = errorDetail.message;
                    Logger.debug(`${modelName} Extracted detailed error message from APIError.error: ${errorMessage}`);
                }
            }

            if (error.cause instanceof Error) {
                const causeMessage = error.cause.message || '';
                if (causeMessage && causeMessage !== errorMessage) {
                    errorMessage = causeMessage;
                    Logger.debug(`${modelName} Extracted detailed error message from error.cause: ${errorMessage}`);
                    throw error.cause;
                }
            }

            Logger.error(`${modelName} ${this.displayName} Responses API request failed: ${errorMessage}`);

            if (
                errorMessage.includes('502') ||
                errorMessage.includes('Bad Gateway') ||
                errorMessage.includes('500') ||
                errorMessage.includes('Internal Server Error') ||
                errorMessage.includes('503') ||
                errorMessage.includes('Service Unavailable') ||
                errorMessage.includes('504') ||
                errorMessage.includes('Gateway Timeout')
            ) {
                throw new vscode.LanguageModelError(errorMessage);
            }

            throw error;
        }

        if (isCancellationError(error)) {
            throw new vscode.CancellationError();
        }

        if (error instanceof vscode.LanguageModelError) {
            throw error;
        }

        throw error;
    }
}
