/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API 处理器
 *  专门处理 OpenAI Responses API 的消息转换和请求处理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { APIError, ClientOptions } from 'openai';
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses';
import { CliAuthFactory } from '../../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../../cli/auth/codexCliAuth';
import type { GenericUsageData } from '../../usages/fileLogger/types';
import { TokenUsagesManager } from '../../usages/usagesManager';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toCostBreakdownLog,
    toNanoAiu
} from '../../utils/pricing/costCalculator';
import { t } from '../../utils/runtime/l10n';
import { Logger } from '../../utils/runtime/logger';
import { markFinalStatusRecorded } from '../../utils/runtime/finalStatusMarker';
import { RequestDiagnostics } from '../../utils/net/requestDiagnostics';
import { isCancellationError } from '../../utils/text/cancellationError';
import { createOpenCodeHeaders } from '../../utils/text/formatUtils';
import { getCustomHeaderDeletionMarkers } from '../../utils/net/httpHeaders';
import { ModelChatResponseOptions, ModelConfig, ModelTokenPricing } from '../../types/sharedTypes';
import type { OpenAIClientFactory, ResolvedOpenAIConnectionParameters } from './transport/clientFactory';
import { leaseProxyDispatcher } from '../../utils/net/proxyAgent';
import { ResponsesConnectionPool, responsesConnectionPool } from './transport/responsesConnectionPool';
import type {
    ResponsesConnection,
    ResponsesConnectionIdentity,
    ResponsesConnectionLease
} from './transport/responsesConnectionPool';
import {
    ResponsesWebSocketTransport,
    ResponsesTransportFailure,
    UndiciResponsesSocket
} from './transport/responsesWebSocketTransport';
import type {
    ResponsesRequestHandle,
    ResponsesSocket,
    ResponsesWebSocketOptions
} from './transport/responsesWebSocketTransport';
import { ResponsesContinuationPlanner } from './responses/responsesContinuationPlanner';
import type { ResponsesRequestPlan } from './responses/responsesContinuationPlanner';
import { openAIImages } from './shared/images';
import { runStreamCleanup } from './shared/streamCleanup';
import { StreamReporter } from '../streamReporter';
import * as liveMetrics from '../liveMetrics';
import { getScopedRequestClassification, isVerifiedAgentConversation } from '../classification/requestClassification';
import type { GenericModelProvider } from '../../providers/genericModelProvider';
import { OpenAIResponsesMessageConverter } from './openaiResponsesMessageConverter';
import { OpenAIResponsesRequestBuilder } from './openaiResponsesRequestBuilder';
import { OpenAIResponsesStreamProcessor } from './openaiResponsesStreamProcessor';

interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
}

export interface ResponsesRequestScope {
    readonly origin: string;
    readonly purpose: string;
    readonly branchId: string;
    readonly turn?: string | number;
}

export interface ResponsesWebSocketServices {
    pool?: ResponsesConnectionPool;
    allowDelta?: boolean;
    socket?: (options: ResponsesWebSocketOptions) => ResponsesSocket;
    dispatcher?: typeof leaseProxyDispatcher;
}

// 日志用紧凑 usage：保留标量与常见 token 明细，丢弃 attribution 等按条目展开的大对象
function compactUsageForLog(usage: GenericUsageData | undefined): Record<string, unknown> | undefined {
    if (!usage) {
        return undefined;
    }
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(usage)) {
        if (typeof value === 'number' || typeof value === 'string') {
            compact[key] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value) && key.endsWith('_details')) {
            compact[key] = value;
        }
    }
    return compact;
}

/**
 * OpenAI Responses API 处理器
 * 专门处理 Responses API 的消息转换和请求
 */
export class OpenAIResponsesHandler {
    private clientFactory: Pick<OpenAIClientFactory, 'createOpenAIClient'> &
        Partial<Pick<OpenAIClientFactory, 'resolveConnectionParameters'>>;
    private messageConverter: OpenAIResponsesMessageConverter;
    private requestBuilder: OpenAIResponsesRequestBuilder;
    private readonly ownerId = randomUUID();
    private readonly planners = new WeakMap<ResponsesConnection, ResponsesContinuationPlanner>();
    private readonly pool: ResponsesConnectionPool;
    private disposed = false;

    constructor(
        private providerInstance: GenericModelProvider,
        clientFactory: Pick<OpenAIClientFactory, 'createOpenAIClient'> &
            Partial<Pick<OpenAIClientFactory, 'resolveConnectionParameters'>>,
        private readonly webSocketServices: ResponsesWebSocketServices = {}
    ) {
        this.clientFactory = clientFactory;
        this.pool = webSocketServices.pool ?? responsesConnectionPool;
        this.messageConverter = new OpenAIResponsesMessageConverter(openAIImages, this.displayName);
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

    retireConnections(): void {
        this.pool.retireOwner(this.ownerId);
    }

    dispose(): Promise<void> {
        this.disposed = true;
        return this.pool.disposeOwner(this.ownerId);
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
        requestStartTime?: number,
        onRequestDispatched?: (requestMetricStartTime: number) => void,
        wasThrottled = false,
        diagnostics?: RequestDiagnostics,
        webSocketScope?: ResponsesRequestScope
    ): Promise<void> {
        const trace =
            diagnostics ??
            new RequestDiagnostics(
                {
                    requestId,
                    sessionId,
                    subSessionId: (options.modelOptions as { subSessionId?: string })?.subSessionId,
                    provider: modelConfig.provider || this.providerKey,
                    modelId: model.id,
                    sdkMode: 'openai-responses'
                },
                entry => Logger.debug('[Request lifecycle]', entry),
                () => ({ tokenCancelled: token.isCancellationRequested })
            );
        let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
        Logger.debug(`${model.name} starting ${this.displayName} Responses API request handling`);
        let reporter: StreamReporter | undefined;
        let requestMetricStartTime = requestStartTime;

        try {
            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            trace.bindSignal(abortController.signal);
            const cancellationListener = token.onCancellationRequested(() => {
                trace.abort('host_token');
                abortController.abort();
            });
            let finalUsage: GenericUsageData | undefined = undefined;
            let finishReason: string | null = null;
            // 记录流处理的开始和结束时间（response.created 到达前为 undefined，避免使用进入函数的旧时间）
            let streamStartTime: number | undefined;
            let streamEndTime: number | undefined = undefined;
            let streamProcessor: OpenAIResponsesStreamProcessor | undefined;
            let streamFailed = false;
            let webSocketLease: ResponsesConnectionLease | undefined;
            let webSocketHandle: ResponsesRequestHandle | undefined;
            let planner: ResponsesContinuationPlanner | undefined;
            let plan: ResponsesRequestPlan | undefined;
            let webSocketSucceeded = false;
            let canReuseConnection = false;

            try {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                if (this.disposed) {
                    throw new vscode.CancellationError();
                }
                if (
                    modelConfig.useWebSocket !== undefined &&
                    (typeof modelConfig.useWebSocket !== 'boolean' || modelConfig.sdkMode !== 'openai-responses')
                ) {
                    throw new Error('useWebSocket must be a boolean for openai-responses models');
                }
                Logger.info(`🚀 ${model.name} Sending ${this.displayName} Responses API request`);

                const useWebSocket =
                    modelConfig.useWebSocket === true &&
                    isVerifiedAgentConversation(getScopedRequestClassification(options));
                const { requestBody } = this.requestBuilder.build({
                    model,
                    modelConfig:
                        modelConfig.useWebSocket && !useWebSocket ?
                            { ...modelConfig, useWebSocket: false }
                        :   modelConfig,
                    messages,
                    options,
                    sessionId
                });

                let resolved: ResolvedOpenAIConnectionParameters | undefined;
                if (useWebSocket) {
                    for (const field of ['previous_response_id', 'conversation', 'type', 'useWebSocket']) {
                        if (modelConfig.extraBody && field in modelConfig.extraBody) {
                            throw new Error(`Conflicting Responses WebSocket field: ${field}`);
                        }
                    }
                    if (!this.clientFactory.resolveConnectionParameters) {
                        throw new Error('Responses WebSocket connection parameters are unavailable');
                    }
                    resolved = await this.clientFactory.resolveConnectionParameters(modelConfig, sessionId);
                    const { resolveResponsesEndpoint } = await import('./transport/clientFactory');
                    const endpoint = resolveResponsesEndpoint(resolved, modelConfig.endpoint);
                    canReuseConnection = !!webSocketScope && this.providerKey !== 'opencode';
                    webSocketLease = await this.acquireWebSocket(
                        model,
                        modelConfig,
                        sessionId,
                        resolved,
                        endpoint,
                        webSocketScope ?? {
                            origin: 'request',
                            purpose: 'isolated',
                            branchId: randomUUID()
                        },
                        abortController.signal,
                        requestId
                    );
                    if (!webSocketLease) {
                        throw new Error('Responses WebSocket connection unavailable: pool capacity or circuit limit');
                    }
                } else if (!modelConfig.useWebSocket) {
                    this.pool.retireModel(this.ownerId, modelConfig.provider || this.providerKey, model.id);
                }
                const transport = webSocketLease?.connection;
                if (transport && !(transport instanceof ResponsesWebSocketTransport)) {
                    throw new Error('Invalid Responses connection transport');
                }
                const client =
                    useWebSocket ? undefined : (
                        await this.clientFactory.createOpenAIClient(modelConfig, sessionId, trace, resolved)
                    );
                if (client) {
                    await this.configureClientHeaders(client, requestId, sessionId);
                }
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                Logger.info(`🎯 ${model.name} Using session_id: ${sessionId}`);

                requestMetricStartTime = Date.now();
                const dispatched = () => {
                    requestMetricStartTime = Date.now();
                    reporter = new StreamReporter({
                        modelName: model.name,
                        modelId: model.id,
                        provider: modelConfig.provider || this.providerKey,
                        sdkMode: 'openai-responses',
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
                    onRequestDispatched?.(requestMetricStartTime);
                };

                // 使用原始事件流而非 SDK ResponseStream：后者的快照累积器在 response.failed
                // 先于 response.created 到达时会先于事件分发抛内部状态错误，吞掉服务端真实错误消息
                const requestHeaders = getCustomHeaderDeletionMarkers(
                    this.providerInstance.providerConfig?.customHeader,
                    modelConfig?.customHeader
                );
                if (transport && webSocketLease) {
                    planner = this.planners.get(transport);
                    if (!planner) {
                        planner = new ResponsesContinuationPlanner(webSocketScope?.origin === 'copilot-sdk');
                        this.planners.set(transport, planner);
                    }
                    plan = planner.plan(
                        requestBody,
                        webSocketLease.generation,
                        this.webSocketServices.allowDelta !== false,
                        webSocketScope?.turn
                    );
                    webSocketHandle = transport.begin(plan.body, dispatched, plan.previousResponseId);
                    Logger.info('Responses transport selected', {
                        transport: 'websocket',
                        requestId,
                        mode: plan.mode,
                        generation: webSocketLease.generation,
                        contextEpoch: plan.contextEpoch,
                        reason: plan.reason,
                        fullInputItems: Array.isArray(plan.fullBody.input) ? plan.fullBody.input.length : undefined,
                        sentInputItems: Array.isArray(plan.body.input) ? plan.body.input.length : undefined
                    });
                }
                if (!webSocketHandle) {
                    dispatched();
                }
                const streamReporter = reporter!;
                const stream =
                    webSocketHandle?.events ??
                    (await client!.responses.create(
                        { ...requestBody, stream: true } as unknown as ResponseCreateParamsStreaming,
                        {
                            signal: abortController.signal,
                            ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {})
                        }
                    ));
                streamProcessor = new OpenAIResponsesStreamProcessor({
                    modelName: model.name,
                    displayName: this.displayName,
                    token,
                    abortController,
                    streamReporter,
                    sessionId,
                    requireExplicitTerminal: !!webSocketHandle
                });
                streamProcessor.attach(trace);
                await streamProcessor.consume(stream, trace);

                if (webSocketHandle && abortController.signal.aborted) {
                    throw new vscode.CancellationError();
                }
                finalUsage = streamProcessor.getFinalUsage();
                finishReason = streamProcessor.getFinishReason();
                streamStartTime = streamProcessor.getStreamStartTime();
                streamEndTime = streamProcessor.getStreamEndTime();

                const completionResult = this.reportCompletion({
                    finishReason,
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
                    requestStartTime: requestMetricStartTime,
                    wasThrottled
                });
                streamStartTime = completionResult.streamStartTime;
                if (webSocketHandle && planner && plan) {
                    if (abortController.signal.aborted) {
                        throw new vscode.CancellationError();
                    }
                    const receipt = webSocketHandle.receipt;
                    const committed = planner.commit(plan, receipt, webSocketLease?.isCurrent() === true);
                    Logger.info('Responses checkpoint commit', {
                        requestId,
                        committed,
                        generation: plan.generation,
                        ...(receipt?.outputIncompleteReason ?
                            { outputIncompleteReason: receipt.outputIncompleteReason }
                        :   {}),
                        ...planner.diagnostics()
                    });
                    webSocketSucceeded = true;
                }
            } catch (caught) {
                const error =
                    (
                        webSocketHandle &&
                        !(caught instanceof ResponsesTransportFailure) &&
                        !token.isCancellationRequested
                    ) ?
                        new ResponsesTransportFailure(
                            'Responses WebSocket consumer failed',
                            'consume',
                            'possibly-sent',
                            webSocketHandle.acceptance,
                            undefined,
                            undefined,
                            caught
                        )
                    :   caught;
                streamFailed = true;
                trace.error(error);
                if (token.isCancellationRequested || isCancellationError(error)) {
                    outcome = 'cancelled';
                    streamStartTime ??= streamProcessor?.getStreamStartTime() ?? reporter?.getMetricStreamStartTime();
                    streamEndTime ??= streamProcessor?.getStreamEndTime() ?? Date.now();
                    const cancellationError = new vscode.CancellationError();
                    runStreamCleanup(
                        [
                            () => {
                                this.reportCancellation({
                                    modelName: model.name,
                                    requestId,
                                    sessionId,
                                    finalUsage: streamProcessor?.getFinalUsage(),
                                    tokenPricing: modelConfig.tokenPricing,
                                    requestServiceTier: (options.modelConfiguration as ModelChatResponseOptions)
                                        ?.serviceTier,
                                    requestMetricStartTime,
                                    streamStartTime,
                                    streamEndTime,
                                    wasThrottled
                                });
                                markFinalStatusRecorded(cancellationError);
                            }
                        ],
                        true
                    );
                    throw cancellationError;
                } else {
                    streamStartTime ??= streamProcessor?.getStreamStartTime() ?? reporter?.getMetricStreamStartTime();
                    streamEndTime ??= streamProcessor?.getStreamEndTime() ?? Date.now();
                    if (
                        requestId &&
                        reporter &&
                        (reporter.hasContent || webSocketHandle) &&
                        !(
                            error instanceof ResponsesTransportFailure &&
                            (error.retryWithFullContext || (error.retryIfNoOutput && !reporter.hasContent))
                        )
                    ) {
                        const finalUsage = streamProcessor?.getFinalUsage();
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
                                    Logger.debug(formatCostBreakdownLog(reporter.getModelName(), breakdown));
                                }
                                costNanoAiu = toNanoAiu(breakdown.total);
                            }
                        }
                        runStreamCleanup(
                            [
                                () => reporter?.reportUsage(finalUsage, costNanoAiu),
                                () => {
                                    if (!streamProcessor?.isResponseFinalized()) {
                                        reporter?.flushAll(null, undefined, finalUsage);
                                    }
                                },
                                () => {
                                    TokenUsagesManager.instance.updateActualTokens({
                                        requestId,
                                        sessionId,
                                        rawUsage: finalUsage,
                                        status: 'failed',
                                        ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
                                        wasThrottled,
                                        streamStartTime,
                                        streamEndTime,
                                        estimatedCost: breakdown?.total,
                                        costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                                    });
                                    markFinalStatusRecorded(error);
                                }
                            ],
                            true
                        );
                    }
                    Logger.error(`${model.name} Responses API stream processing error: ${error}`);
                    throw error;
                }
            } finally {
                webSocketHandle?.finish(webSocketSucceeded);
                if (!webSocketSucceeded) {
                    planner?.invalidate();
                }
                webSocketLease?.release(webSocketSucceeded && webSocketLease.connection.reusable && canReuseConnection);
                runStreamCleanup([() => cancellationListener.dispose()], streamFailed);
            }

            outcome = token.isCancellationRequested ? 'cancelled' : 'completed';
            Logger.debug(`${model.name} ${this.displayName} Responses API request ${outcome}`);
        } catch (error) {
            trace.error(error);
            this.rethrowResponsesError(error, model.name);
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

    private async acquireWebSocket(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        sessionId: string,
        parameters: ResolvedOpenAIConnectionParameters,
        endpoint: URL,
        scope: ResponsesRequestScope,
        signal: AbortSignal,
        requestId: string
    ): Promise<ResponsesConnectionLease | undefined> {
        if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
            throw new Error('Responses WebSocket requires an HTTP or HTTPS endpoint');
        }
        const headers = new Headers({
            Authorization: `Bearer ${parameters.apiKey}`
        });
        for (const [name, value] of Object.entries(parameters.defaultHeaders)) {
            if (value === null) {
                headers.delete(name);
            } else {
                headers.set(name, value);
            }
        }
        for (const [name, value] of Object.entries(await this.resolveProviderHeaders(requestId, sessionId))) {
            headers.set(name, value);
        }
        const connectionHeaders: Record<string, string> = {};
        headers.forEach((value, name) => {
            connectionHeaders[name] = value;
        });
        const url = new URL(endpoint);
        url.protocol = endpoint.protocol === 'http:' ? 'ws:' : 'wss:';
        const network = (this.webSocketServices.dispatcher ?? leaseProxyDispatcher)(parameters.proxyUrl, true);
        const identity: ResponsesConnectionIdentity = {
            ownerId: this.ownerId,
            provider: modelConfig.provider || this.providerKey,
            modelId: model.id,
            sessionId,
            origin: scope.origin,
            purpose: scope.purpose,
            branchId: scope.branchId,
            binding: this.pool.fingerprint([
                modelConfig.model || modelConfig.id,
                endpoint.href,
                'responses-flat-v1',
                connectionHeaders,
                network.fingerprint,
                modelConfig
            ])
        };
        let created = false;
        try {
            this.pool.retireSuperseded(identity);
            const lease = await this.pool.acquire(
                identity,
                () => {
                    const socket = (this.webSocketServices.socket ?? (options => new UndiciResponsesSocket(options)))({
                        url: url.href,
                        headers: connectionHeaders,
                        dispatcher: network.dispatcher,
                        abortPending: network.abortPending
                    });
                    created = true;
                    return new ResponsesWebSocketTransport(socket, undefined, undefined, network, eventType => {
                        Logger.warn(`Responses WebSocket ignored unknown event: ${eventType}`);
                    });
                },
                signal,
                true
            );
            if (!created) {
                await network.release();
            }
            return lease;
        } catch (error) {
            if (!created) {
                await network.release();
            }
            this.pool.recordResult(identity, error instanceof ResponsesTransportFailure && error.status === undefined);
            throw error;
        }
    }

    private async configureClientHeaders(client: unknown, requestId: string, sessionId: string): Promise<void> {
        const { _options: clientOptions } = client as { _options: ClientOptions };
        const { defaultHeaders: optHeaders } = clientOptions as { defaultHeaders: Record<string, string> };
        Object.assign(optHeaders, await this.resolveProviderHeaders(requestId, sessionId));
    }

    private async resolveProviderHeaders(requestId: string, sessionId: string): Promise<Record<string, string>> {
        const headers: Record<string, string> = { conversation_id: sessionId, session_id: sessionId };

        if (this.providerKey === 'opencode') {
            Object.assign(headers, createOpenCodeHeaders(requestId, sessionId));
        }

        if (this.providerKey !== 'codex') {
            return headers;
        }

        const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth;
        const accountId = await codexAuth?.getAccountId();
        if (accountId && accountId.trim()) {
            headers['chatgpt-account-id'] = accountId.trim();
        }
        return headers;
    }

    private reportCompletion(params: {
        finishReason?: string | null;
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
        wasThrottled?: boolean;
    }): { streamStartTime?: number } {
        const {
            finishReason,
            modelName,
            tokenPricing,
            options,
            requestId,
            sessionId,
            token,
            streamReporter,
            finalUsage,
            streamEndTime,
            requestStartTime,
            wasThrottled
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
        if (finishReason) {
            Logger.info(
                `📊 ${modelName} Responses API request completed with finish reason: ${finishReason}`,
                compactUsageForLog(finalUsage)
            );
        } else {
            Logger.info(`📊 ${modelName} Responses API request completed`, compactUsageForLog(finalUsage));
        }

        streamStartTime ??= streamReporter.getMetricStreamStartTime();

        if (requestId) {
            // 更新实际 token（同步调用，内部写盘 fire-and-forget，不阻塞响应完成链路）
            TokenUsagesManager.instance.updateActualTokens({
                requestId,
                sessionId,
                rawUsage: finalUsage,
                status: token.isCancellationRequested ? 'cancelled' : 'completed',
                ...(requestStartTime !== undefined ? { requestMetricStartTime: requestStartTime } : {}),
                wasThrottled,
                streamStartTime,
                streamEndTime,
                estimatedCost: breakdown?.total,
                costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
            });
        }

        Logger.debug(
            `${modelName} ${this.displayName} Responses API stream completed${finishReason ? ` (${finishReason})` : ''}`
        );
        return { streamStartTime };
    }

    private reportCancellation(params: {
        modelName: string;
        requestId: string;
        sessionId: string;
        finalUsage?: GenericUsageData;
        tokenPricing?: ModelTokenPricing;
        requestServiceTier?: string;
        requestMetricStartTime?: number;
        streamStartTime?: number;
        streamEndTime?: number;
        wasThrottled?: boolean;
    }): void {
        const {
            modelName,
            requestId,
            sessionId,
            finalUsage,
            tokenPricing,
            requestServiceTier,
            requestMetricStartTime,
            streamStartTime,
            streamEndTime,
            wasThrottled
        } = params;
        const breakdown =
            tokenPricing ?
                calculateCostWithBreakdown(
                    finalUsage,
                    tokenPricing,
                    requestMetricStartTime !== undefined ? new Date(requestMetricStartTime) : new Date(),
                    requestServiceTier
                )
            :   undefined;
        Logger.info(`${modelName} Responses API request was cancelled`);
        // 记录取消状态（同步调用，内部写盘 fire-and-forget，不阻塞取消链路）
        TokenUsagesManager.instance.updateActualTokens({
            requestId,
            sessionId,
            rawUsage: finalUsage,
            status: 'cancelled',
            ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
            wasThrottled,
            streamStartTime,
            streamEndTime: streamEndTime ?? Date.now(),
            estimatedCost: breakdown?.total,
            costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
        });
    }

    private rethrowResponsesError(error: unknown, modelName: string): never {
        if (error instanceof APIError && (error.status !== undefined || error.error !== undefined)) {
            Logger.error(`${modelName} ${this.displayName} Responses API request failed: ${error.message}`);
            throw error;
        }

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
                }
            }

            Logger.error(`${modelName} ${this.displayName} Responses API request failed: ${errorMessage}`);
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
