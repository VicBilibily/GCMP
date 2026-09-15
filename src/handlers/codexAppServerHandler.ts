/*---------------------------------------------------------------------------------------------
 *  Codex App Server 处理器（sdkMode: codex-app-server）
 *  经本机 codex app-server（JSON-RPC over stdio）完成对话。
 *  模式 A（ephemeral thread，每请求独立，默认）与模式 B（persistent thread，增量 + marker 恢复）；
 *  取消经 turn/interrupt。工具调用经 item/tool/call 委派回聊天循环执行，结果随下轮请求注入。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getCodexAppServerClient, getCodexAppServerConfig } from '../cli/appServer';
import type { CodexAppServerClient } from '../cli/appServer/client';
import { codexThreadSessionStore } from '../cli/appServer/threadSessionStore';
import type {
    AgentMessageDeltaNotification,
    CodexErrorInfoStatusCarrier,
    DynamicToolCallParams,
    DynamicToolFunctionSpec,
    ItemCompletedNotification,
    JsonRpcNotificationFrame,
    JsonRpcServerRequestFrame,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ThreadStartResponse,
    ThreadTokenUsageUpdatedNotification,
    ThreadTurnsListResponse,
    TokenUsageBreakdown,
    TurnCompletedNotification,
    TurnError,
    TurnStartResponse,
    TurnStatus,
    UserInput
} from '../cli/appServer/protocolTypes';
import type { GenericUsageData } from '../usages/fileLogger/types';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toCostBreakdownLog,
    toNanoAiu
} from '../utils/pricing/costCalculator';
import { Logger } from '../utils/runtime/logger';
import { GCMP_SYSTEM_MESSAGE_NAME } from './types';
import { getAllStatefulMarkersAndIndicies, type StatefulMarkerContainer } from './statefulMarker';
import { isSubRequest, type RequestKind } from './requestClassifier';
import * as liveMetrics from './liveMetrics';
import { StreamReporter } from './streamReporter';
import type { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import type { RetryableError } from '../utils/retry/retryManager';
import type { JsonValue } from '../cli/appServer/protocolTypes';

/** vscode 消息 → thread 输入的转换结果 */
interface ThreadInputParts {
    /** 系统提示词（拼接，作为 thread/start.developerInstructions） */
    developerInstructions?: string;
    /** 历史轮次注入项（Responses ResponseItem 格式，thread/inject_items） */
    historyItems: JsonValue[];
    /** 本轮用户输入（turn/start.input） */
    turnInput: UserInput[];
    /** 本轮消息中的工具结果（function_call_output，经 thread/inject_items 注入；委派回聊天循环的工具经此回调结果） */
    turnToolOutputs: JsonValue[];
}

/** 本轮仅工具结果时的续接输入（codex turn/start input 不接受 function_call_output） */
const TOOL_RESULT_CONTINUATION_TEXT = 'Continue with the tool results provided above.';

/** 一轮对话的执行策略（模式 A/B 归一后的执行输入） */
interface TurnStrategy extends ThreadInputParts {
    /** 已存在且 resume 成功的持久 thread ID；undefined = 新建 thread */
    resumeThreadId?: string;
    /** 新建 thread 是否持久（模式 B 全新会话）；回退/模式 A 为 false */
    persistentNew: boolean;
    /** Dynamic Tools 注册表（仅新建 thread 时传入） */
    dynamicTools?: DynamicToolFunctionSpec[];
}

export class CodexAppServerHandler {
    /** 当前 client 上已注册的反向请求兜底（client 重建后需重绑） */
    private static fallbackClient?: CodexAppServerClient;

    constructor(
        private readonly providerInstance: GenericModelProvider,
        private readonly context: vscode.ExtensionContext
    ) {}

    private get providerKey(): string {
        return this.providerInstance.provider;
    }

    private get displayName(): string {
        return this.providerInstance.providerConfig.displayName;
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
        Logger.debug(`${model.name} starting ${this.displayName} Codex App Server request handling`);
        let reporter: StreamReporter | undefined;
        let requestMetricStartTime = requestStartTime;
        let streamEndTime: number | undefined;
        /** 模式 B：turn 完成后写入 store/marker 的持久 thread 信息 */
        let persistentResult: { threadId: string; turnId: string } | undefined;
        let turnUsage: GenericUsageData | undefined;

        try {
            const client = getCodexAppServerClient(this.context);
            this.registerServerRequestFallback(client);
            await client.ensureReady();

            const threadMode = getCodexAppServerConfig().threadMode ?? 'ephemeral';
            const dynamicTools = this.buildDynamicTools(options, modelConfig);
            const toolNames = dynamicTools?.map(t => t.name).sort();
            // 协议侧模型标识用原始 slug（modelConfig.id）；model.id 带 vendor 前缀（gcmp.codex:::），仅用于 marker 匹配
            const strategy: TurnStrategy =
                threadMode === 'persistent' ?
                    await this.resolvePersistentStrategy(
                        client,
                        messages,
                        model.id,
                        modelConfig.id,
                        sessionId,
                        toolNames
                    )
                :   { ...this.convertMessages(messages), persistentNew: false };
            if (!strategy.resumeThreadId) {
                strategy.dynamicTools = dynamicTools;
            }
            if (strategy.turnInput.length === 0) {
                throw new Error('Codex App Server: no user input found in messages');
            }

            // resume 成功的持久 thread 直接复用；否则新建（模式 B 全新会话为持久 thread）。
            // 并发闸门（withTurnSlot）限制同一 app-server 进程上的并发 active turn，超出排队等位
            let turnId = '';
            const threadId = await client.withTurnSlot(async () => {
                const activeThreadId =
                    strategy.resumeThreadId ?? (await this.startThread(client, modelConfig.id, strategy));
                Logger.debug(
                    `[CodexAppServer] thread ready: ${activeThreadId} (${
                        strategy.resumeThreadId ? 'resumed'
                        : strategy.persistentNew ? 'persistent-new'
                        : 'ephemeral'
                    })`
                );

                await client.withThreadLock(activeThreadId, async () => {
                    const injectItems = [...strategy.historyItems, ...strategy.turnToolOutputs];
                    if (injectItems.length > 0) {
                        await client.request('thread/inject_items', {
                            threadId: activeThreadId,
                            items: injectItems
                        });
                    }

                    requestMetricStartTime = Date.now();
                    onRequestDispatched?.(requestMetricStartTime);

                    reporter = new StreamReporter({
                        modelName: model.name,
                        modelId: model.id,
                        provider: modelConfig.provider || this.providerKey,
                        sdkMode: 'codex-app-server',
                        progress,
                        sessionId,
                        requestId,
                        requestStartTime: requestMetricStartTime,
                        onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
                    });

                    Logger.info(`🚀 ${model.name} Sending ${this.displayName} Codex App Server turn`);
                    const turnResp = await client.request<TurnStartResponse>('turn/start', {
                        threadId: activeThreadId,
                        input: strategy.turnInput,
                        ...this.resolveTurnOverrides(options, modelConfig)
                    });
                    turnId = turnResp.turn.id;
                    reporter.setResponseId(turnId);

                    // Dynamic Tools：本 thread 的 item/tool/call 委派回聊天循环执行
                    const turnReporter = reporter;
                    const toolCallHandler =
                        strategy.dynamicTools || strategy.resumeThreadId ?
                            client.registerServerRequestHandler(activeThreadId, msg =>
                                this.handleServerRequest(client, msg, turnReporter)
                            )
                        :   undefined;

                    const cancellationListener = token.onCancellationRequested(() => {
                        void client
                            .request('turn/interrupt', { threadId: activeThreadId, turnId })
                            .catch(error => Logger.warn(`[CodexAppServer] turn/interrupt failed: ${error}`));
                    });
                    try {
                        turnUsage = await this.waitTurnCompletion(client, activeThreadId, turnId, reporter, token);
                    } finally {
                        cancellationListener.dispose();
                        toolCallHandler?.dispose();
                    }
                    streamEndTime = Date.now();
                });
                return activeThreadId;
            });

            const streamReporter = reporter;
            if (!streamReporter) {
                return;
            }

            // 取消路径：interrupt 生效后 turn/completed status=interrupted
            if (token.isCancellationRequested) {
                this.reportCancellation(
                    model.name,
                    requestId,
                    sessionId,
                    requestMetricStartTime,
                    streamEndTime,
                    wasThrottled
                );
                throw new vscode.CancellationError();
            }

            // 模式 B：turn 完成后登记持久会话（写 marker + store，淘汰项 archive）
            if (threadMode === 'persistent' && turnId) {
                persistentResult = { threadId, turnId };
                const evicted = codexThreadSessionStore.set({
                    sessionId,
                    threadId,
                    lastTurnId: turnId,
                    modelId: model.id,
                    toolNames,
                    updatedAt: Date.now()
                });
                for (const entry of evicted) {
                    void client
                        .request('thread/archive', { threadId: entry.threadId })
                        .catch(error => Logger.warn(`[CodexAppServer] thread/archive failed: ${error}`));
                }
            }

            const finalUsage = turnUsage;
            let costNanoAiu: number | undefined;
            let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
            if (modelConfig.tokenPricing) {
                const costAt = requestMetricStartTime ? new Date(requestMetricStartTime) : new Date();
                breakdown = calculateCostWithBreakdown(finalUsage, modelConfig.tokenPricing, costAt);
                if (breakdown) {
                    if (breakdown.total > 0) {
                        Logger.debug(formatCostBreakdownLog(streamReporter.getModelName(), breakdown));
                    }
                    costNanoAiu = toNanoAiu(breakdown.total);
                }
            }
            streamReporter.reportUsage(finalUsage, costNanoAiu);
            // 模式 B 写 codex thread marker（供下轮增量定位）；模式 A/回退不写
            // responseId 复用 turnId（codex 模式无 response 概念，turn 即响应单元）
            streamReporter.flushAll(
                null,
                {
                    sessionId,
                    responseId: turnId,
                    ...(persistentResult ?
                        {
                            codexThreadId: persistentResult.threadId,
                            codexLastTurnId: persistentResult.turnId
                        }
                    :   {})
                },
                finalUsage
            );
            Logger.info(`📊 ${model.name} Codex App Server request completed`);
            TokenUsagesManager.instance.updateActualTokens({
                requestId,
                sessionId,
                rawUsage: finalUsage,
                status: 'completed',
                requestMetricStartTime,
                wasThrottled,
                streamStartTime: streamReporter.getMetricStreamStartTime(),
                streamEndTime,
                estimatedCost: breakdown?.total,
                costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
            });
            Logger.debug(`✅ ${model.name} ${this.displayName} Codex App Server request completed`);
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`${model.name} ${this.displayName} Codex App Server request failed: ${errorMessage}`);
            throw error;
        } finally {
            reporter?.finishMetrics();
        }
    }

    /** 新建 thread（模式 A ephemeral / 模式 B 全新持久会话） */
    private async startThread(client: CodexAppServerClient, modelId: string, strategy: TurnStrategy): Promise<string> {
        // 写沙盒禁绝 + 审批关闭（PoC 实测 0 审批请求、0 命令泄露）
        const threadResp = await client.request<ThreadStartResponse>('thread/start', {
            model: modelId,
            ephemeral: !strategy.persistentNew,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            ...(strategy.developerInstructions ? { developerInstructions: strategy.developerInstructions } : {}),
            ...(strategy.dynamicTools?.length ? { dynamicTools: strategy.dynamicTools } : {})
        });
        return threadResp.thread.id;
    }

    /**
     * vscode tools → DynamicToolFunctionSpec（仅 toolCalling 能力开启时注册）
     */
    private buildDynamicTools(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelConfig: ModelConfig
    ): DynamicToolFunctionSpec[] | undefined {
        if (!options.tools?.length || !modelConfig.capabilities?.toolCalling) {
            return undefined;
        }
        const specs: DynamicToolFunctionSpec[] = [];
        for (const tool of options.tools) {
            if (!tool.name) {
                continue;
            }
            specs.push({
                type: 'function',
                name: tool.name,
                description: tool.description ?? '',
                inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as JsonValue
            });
        }
        return specs.length > 0 ? specs : undefined;
    }

    /**
     * 服务端反向请求处理（thread 级）：
     * - item/tool/call：委派回聊天循环（流出 ToolCallPart 由 Copilot 执行）
     * - 其他（审批类）：拒绝兜底
     */
    private handleServerRequest(
        client: CodexAppServerClient,
        msg: JsonRpcServerRequestFrame,
        reporter: StreamReporter
    ): void {
        if (msg.method !== 'item/tool/call') {
            Logger.warn(`[CodexAppServer] unexpected server request ${msg.method}, rejecting`);
            client.respond(msg.id, { decision: 'decline' });
            return;
        }
        this.delegateToolCall(client, msg.id, msg.params as DynamicToolCallParams, reporter);
    }

    /**
     * item/tool/call → 聊天循环 ToolCallPart：提供商拿不到 ChatRequest，invokeTool 无法覆盖
     * 私有/上下文依赖工具；respond 委派回执后立即 interrupt 当前 turn——codex 串行调用工具，
     * 不中断则 turn 永不结束，而聊天循环要等响应流结束才执行工具，结果随下一轮请求注入。
     */
    private delegateToolCall(
        client: CodexAppServerClient,
        requestId: number | string,
        params: DynamicToolCallParams,
        reporter: StreamReporter
    ): void {
        let toolInput: unknown = params.arguments;
        if (typeof params.arguments === 'string') {
            try {
                toolInput = JSON.parse(params.arguments);
            } catch {
                // 保留字符串原文
            }
        }
        Logger.debug(`[CodexAppServer] delegating tool call ${params.tool} (${params.callId}) to chat loop`);
        reporter.reportToolCall(params.callId, params.tool, (toolInput ?? {}) as Record<string, unknown>);
        client.respond(requestId, {
            contentItems: [
                {
                    type: 'inputText',
                    text: 'Tool execution delegated to the host chat loop; the result will be provided in the next request.'
                }
            ],
            success: false
        });
        void client
            .request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId })
            .catch(error => Logger.warn(`[CodexAppServer] turn/interrupt after tool delegation failed: ${error}`));
    }

    /**
     * 模式 B 会话策略：marker/store 命中持久 thread 时 resume + 增量注入；
     * resume 失败、turn 对账失配或无增量输入时回退为全新持久会话全量重放。
     * 工具集漂移（toolNames 与注册时不同）时放弃 resume：resume 的 thread 保留首轮注册的
     * dynamicTools 不可更新，漂移即新建持久 thread 全量重放，旧 thread 归档。
     */
    private async resolvePersistentStrategy(
        client: CodexAppServerClient,
        messages: readonly vscode.LanguageModelChatMessage[],
        markerModelId: string,
        wireModelId: string,
        sessionId: string,
        toolNames?: string[]
    ): Promise<TurnStrategy> {
        const markerHit = this.extractCodexMarker(messages);
        const stored = codexThreadSessionStore.get(sessionId);
        const threadId = markerHit?.marker.codexThreadId ?? stored?.threadId;
        const lastTurnId = markerHit?.marker.codexLastTurnId ?? stored?.lastTurnId;

        if (threadId && markerHit && markerHit.marker.modelId === markerModelId) {
            const drifted = stored !== undefined && (stored.toolNames ?? []).join(',') !== (toolNames ?? []).join(',');
            if (drifted) {
                Logger.info(
                    `[CodexAppServer] tool set changed (${(stored?.toolNames ?? []).join('/') || '(none)'} → ${(toolNames ?? []).join('/') || '(none)'}), new persistent thread`
                );
            } else {
                try {
                    await client.request('thread/resume', { threadId, model: wireModelId, excludeTurns: true });
                    // turn 对账：thread 尾部 turn 应与 marker 记录一致，否则历史不可信
                    if (lastTurnId) {
                        const turns = await client.request<ThreadTurnsListResponse>('thread/turns/list', {
                            threadId,
                            limit: 1,
                            sortDirection: 'desc'
                        });
                        const latest = turns.data?.[0];
                        if (latest && latest.id !== lastTurnId) {
                            throw new Error(`thread tail mismatch (latest=${latest.id}, marker=${lastTurnId})`);
                        }
                    }
                    // 增量：仅转换 marker 之后的消息
                    const incremental = this.convertMessages(messages.slice(markerHit.index + 1));
                    if (incremental.turnInput.length === 0) {
                        throw new Error('no new user input after marker');
                    }
                    return {
                        resumeThreadId: threadId,
                        // resume 不覆盖既有 thread 的 developerInstructions
                        historyItems: incremental.historyItems,
                        turnInput: incremental.turnInput,
                        turnToolOutputs: incremental.turnToolOutputs,
                        persistentNew: false
                    };
                } catch (error) {
                    Logger.warn(
                        `[CodexAppServer] persistent resume failed, falling back to new persistent thread: ${error}`
                    );
                }
            }
        } else if (threadId && markerHit && markerHit.marker.modelId !== markerModelId) {
            Logger.debug(`[CodexAppServer] model changed (${markerHit.marker.modelId} → ${markerModelId}), new thread`);
        }

        if (threadId) {
            this.archiveAbandonedThread(client, sessionId, threadId);
        }

        // 全新持久会话：全量历史注入
        return { ...this.convertMessages(messages), persistentNew: true };
    }

    private archiveAbandonedThread(client: CodexAppServerClient, sessionId: string, threadId: string): void {
        codexThreadSessionStore.delete(sessionId);
        void client
            .request('thread/archive', { threadId })
            .catch(error => Logger.warn(`[CodexAppServer] thread/archive failed: ${error}`));
    }

    /** 倒序提取最近的 codex-app-server marker（含其消息索引，用于增量切分） */
    private extractCodexMarker(
        messages: readonly vscode.LanguageModelChatMessage[]
    ): { marker: StatefulMarkerContainer; index: number } | undefined {
        for (const hit of getAllStatefulMarkersAndIndicies(messages)) {
            const marker = hit.statefulMarker.marker;
            if (marker.sdkMode === 'codex-app-server' && marker.codexThreadId) {
                return { marker, index: hit.index };
            }
        }
        return undefined;
    }

    /**
     * 等待 turn 完成：映射流式通知到 StreamReporter。
     * 返回本轮 usage（局部变量，避免 handler 单例并发串用量）。
     * 进程退出 / turn/completed 后结束；failed 走错误路径。
     */
    private waitTurnCompletion(
        client: CodexAppServerClient,
        threadId: string,
        turnId: string,
        reporter: StreamReporter,
        token: vscode.CancellationToken
    ): Promise<GenericUsageData | undefined> {
        return new Promise<GenericUsageData | undefined>((resolve, reject) => {
            let settled = false;
            let usage: GenericUsageData | undefined;
            const finish = (fn: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                subscription.dispose();
                exitSub.dispose();
                fn();
            };
            const subscription = client.onNotification((msg: JsonRpcNotificationFrame) => {
                switch (msg.method) {
                    case 'item/agentMessage/delta': {
                        const p = msg.params as AgentMessageDeltaNotification;
                        if (p.turnId === turnId) {
                            reporter.reportText(p.delta);
                        }
                        break;
                    }
                    case 'item/reasoning/textDelta': {
                        const p = msg.params as ReasoningTextDeltaNotification;
                        if (p.turnId === turnId) {
                            reporter.bufferThinking(p.delta);
                        }
                        break;
                    }
                    case 'item/reasoning/summaryTextDelta': {
                        const p = msg.params as ReasoningSummaryTextDeltaNotification;
                        if (p.turnId === turnId) {
                            reporter.bufferThinking(p.delta);
                        }
                        break;
                    }
                    case 'thread/tokenUsage/updated': {
                        const p = msg.params as ThreadTokenUsageUpdatedNotification;
                        if (p.turnId === turnId) {
                            usage = this.mapUsage(p.tokenUsage.last);
                        }
                        break;
                    }
                    case 'item/completed': {
                        const p = msg.params as ItemCompletedNotification;
                        if (p.turnId === turnId && p.item.type === 'reasoning') {
                            reporter.endThinkingChain();
                        }
                        break;
                    }
                    case 'turn/completed': {
                        const p = msg.params as TurnCompletedNotification;
                        if (p.turn.id !== turnId) {
                            break;
                        }
                        if (p.turn.status === 'completed') {
                            finish(() => resolve(usage));
                        } else if (p.turn.status === 'interrupted' || token.isCancellationRequested) {
                            finish(() => resolve(usage));
                        } else {
                            finish(() => reject(this.toTurnFailureError(p.turn.error, p.turn.status)));
                        }
                        break;
                    }
                    default:
                        break;
                }
            }, threadId);
            const exitSub = client.onProcessExit(() => {
                finish(() => reject(new Error('Codex app-server exited during turn')));
            });
        });
    }

    /** Codex TokenUsageBreakdown → OpenAI 风格 GenericUsageData */
    private mapUsage(last: TokenUsageBreakdown): GenericUsageData {
        return {
            prompt_tokens: last.inputTokens + last.cachedInputTokens,
            completion_tokens: last.outputTokens + last.reasoningOutputTokens,
            total_tokens: last.totalTokens,
            cached_tokens: last.cachedInputTokens,
            prompt_tokens_details: { cached_tokens: last.cachedInputTokens },
            completion_tokens_details: { reasoning_tokens: last.reasoningOutputTokens }
        };
    }

    /**
     * turn/start 的 effort/summary 覆盖：
     * - 子请求（summarization/title 等）：effort 降至模型支持的最低档（none→minimal→low），summary 关闭
     * - 主请求：透传用户选择的 reasoningEffort（限模型支持列表内，防非法值被服务端 400）
     */
    private resolveTurnOverrides(
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelConfig: ModelConfig
    ): { effort?: string; summary?: string } {
        const requestKind = (options.modelOptions as { requestKind?: string } | undefined)?.requestKind as
            | RequestKind
            | undefined;
        const supported = modelConfig.reasoningEffort as readonly string[] | undefined;
        if (requestKind !== undefined && isSubRequest(requestKind)) {
            const effort = ['none', 'minimal', 'low'].find(candidate => supported?.includes(candidate));
            return { ...(effort ? { effort } : {}), summary: 'none' };
        }
        const configured = (options.modelConfiguration as ModelChatResponseOptions | undefined)?.reasoningEffort;
        if (configured && supported?.includes(configured)) {
            return { effort: configured };
        }
        return {};
    }

    /**
     * turn/completed 失败 → RetryManager 可分类的错误（结构化 codexErrorInfo 优先于消息文案）：
     * usageLimitExceeded/contextWindowExceeded/sessionBudgetExceeded → 永久错误 code（不重试）；
     * rateLimitExceeded → 可重试限流 code；serverOverloaded → 529；连接/断流类透传上游 httpStatusCode。
     */
    private toTurnFailureError(turnError: TurnError | null, status: TurnStatus): Error {
        const error = new Error(turnError?.message || `Codex turn failed with status ${status}`) as RetryableError;
        const info = turnError?.codexErrorInfo;
        if (typeof info === 'string') {
            switch (info) {
                case 'usageLimitExceeded':
                    error.code = 'usage_limit_reached';
                    break;
                case 'contextWindowExceeded':
                    error.code = 'context_window_exceeded';
                    break;
                case 'sessionBudgetExceeded':
                    error.code = 'session_budget_exceeded';
                    break;
                case 'rateLimitExceeded':
                    error.code = 'rate_limit_exceeded';
                    break;
                case 'serverOverloaded':
                    error.status = 529;
                    break;
                case 'unauthorized':
                    error.status = 401;
                    break;
                case 'internalServerError':
                    error.status = 500;
                    break;
                case 'badRequest':
                    error.status = 400;
                    break;
                case 'cyberPolicy':
                case 'misalignmentPolicyViolation':
                    error.status = 400;
                    break;
                default:
                    break;
            }
        } else if (info && typeof info === 'object') {
            // 对象变体（httpConnectionFailed/responseStream*/responseTooManyFailedAttempts）：透传上游状态码
            const carrier = Object.values(info)[0] as CodexErrorInfoStatusCarrier | undefined;
            if (typeof carrier?.httpStatusCode === 'number') {
                error.status = carrier.httpStatusCode;
            }
        }
        return error;
    }

    /**
     * vscode 消息 → developerInstructions + 历史注入项 + 本轮输入。
     * 系统消息：role=System 或 name=GCMP_SYSTEM_MESSAGE_NAME 的 user 消息。
     * 历史注入采用 Responses ResponseItem 格式（PoC-7 实测模型可见）。
     * 图片等 DataPart 阶段 1 暂不支持（跳过并告警）。
     */
    private convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): ThreadInputParts {
        const systemParts: string[] = [];
        const historyItems: JsonValue[] = [];
        const turnToolOutputs: JsonValue[] = [];
        let turnInput: UserInput[] = [];

        // 定位最后一条 user 消息（本轮输入）；其余全部进入历史注入
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
                lastUserIndex = i;
                break;
            }
        }

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            const isSystem =
                message.role === vscode.LanguageModelChatMessageRole.System ||
                (message.role === vscode.LanguageModelChatMessageRole.User &&
                    message.name === GCMP_SYSTEM_MESSAGE_NAME);
            if (isSystem) {
                const text = this.extractText(message);
                if (text) {
                    systemParts.push(text);
                }
                continue;
            }

            if (message.role === vscode.LanguageModelChatMessageRole.User) {
                if (i === lastUserIndex) {
                    turnInput = this.toUserInputs(message);
                    turnToolOutputs.push(...this.toToolOutputItems(message));
                    if (turnInput.length === 0 && turnToolOutputs.length > 0) {
                        turnInput = [{ type: 'text', text: TOOL_RESULT_CONTINUATION_TEXT, text_elements: [] }];
                    }
                } else {
                    // 历史 user 消息：文本 + 工具结果（function_call_output，按 call_id 归属）
                    historyItems.push(...this.toUserHistoryItems(message));
                }
                continue;
            }

            // assistant → 历史注入（输出文本 + 工具调用 function_call，保持 part 顺序）
            historyItems.push(...this.toAssistantHistoryItems(message));
        }

        return {
            developerInstructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            historyItems,
            turnInput,
            turnToolOutputs
        };
    }

    private extractText(message: vscode.LanguageModelChatMessage): string {
        const parts: string[] = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                parts.push(part.value);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                Logger.warn('[CodexAppServer] image/data part skipped in history (not supported yet)');
            }
        }
        return parts.join('');
    }

    private toUserInputs(message: vscode.LanguageModelChatMessage): UserInput[] {
        const inputs: UserInput[] = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value) {
                    inputs.push({ type: 'text', text: part.value, text_elements: [] });
                }
            } else if (part instanceof vscode.LanguageModelDataPart) {
                Logger.warn('[CodexAppServer] image/data part skipped in turn input (not supported yet)');
            }
        }
        return inputs;
    }

    /** 本轮 user 消息中的工具结果 → function_call_output（call_id 归属，经 inject_items 注入） */
    private toToolOutputItems(message: vscode.LanguageModelChatMessage): JsonValue[] {
        const items: JsonValue[] = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
                items.push({
                    type: 'function_call_output',
                    call_id: part.callId,
                    output: this.toolResultText(part)
                } as JsonValue);
            }
        }
        return items;
    }

    /** 历史 user 消息 → 注入项：文本聚合为 message 项，工具结果为 function_call_output（call_id 归属） */
    private toUserHistoryItems(message: vscode.LanguageModelChatMessage): JsonValue[] {
        const items: JsonValue[] = [];
        let texts: string[] = [];
        const flushTexts = (): void => {
            const text = texts.join('');
            if (text) {
                items.push({
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text }]
                } as JsonValue);
            }
            texts = [];
        };
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value) {
                    texts.push(part.value);
                }
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                flushTexts();
                items.push({
                    type: 'function_call_output',
                    call_id: part.callId,
                    output: this.toolResultText(part)
                } as JsonValue);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                Logger.warn('[CodexAppServer] image/data part skipped in history (not supported yet)');
            }
        }
        flushTexts();
        return items;
    }

    /** 历史 assistant 消息 → 注入项：文本聚合为 message 项，工具调用为 function_call（保持 part 顺序） */
    private toAssistantHistoryItems(message: vscode.LanguageModelChatMessage): JsonValue[] {
        const items: JsonValue[] = [];
        let texts: string[] = [];
        const flushTexts = (): void => {
            const text = texts.join('');
            if (text) {
                items.push({
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text }]
                } as JsonValue);
            }
            texts = [];
        };
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value) {
                    texts.push(part.value);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                flushTexts();
                items.push({
                    type: 'function_call',
                    call_id: part.callId,
                    name: part.name,
                    arguments: JSON.stringify(part.input ?? {})
                } as JsonValue);
            } else if (part instanceof vscode.LanguageModelDataPart) {
                Logger.warn('[CodexAppServer] image/data part skipped in history (not supported yet)');
            }
        }
        flushTexts();
        return items;
    }

    /** LanguageModelToolResultPart → 纯文本输出（function_call_output.output 字符串形态） */
    private toolResultText(part: vscode.LanguageModelToolResultPart): string {
        const text = part.content
            .map(sub => (sub instanceof vscode.LanguageModelTextPart ? sub.value : ''))
            .filter(Boolean)
            .join('\n');
        return text || '(no output)';
    }

    /**
     * 服务端反向请求兜底：approvalPolicy='never' 下审批不应出现，出现即拒绝；
     * item/tool/call 无 thread 级处理器时按失败兜底，避免挂起 turn。
     */
    private registerServerRequestFallback(client: CodexAppServerClient): void {
        if (CodexAppServerHandler.fallbackClient === client) {
            return;
        }
        CodexAppServerHandler.fallbackClient = client;
        client.onServerRequest((msg: JsonRpcServerRequestFrame) => {
            if (msg.method === 'item/tool/call') {
                Logger.warn(`[CodexAppServer] unexpected item/tool/call without dynamic tools: ${msg.id}`);
                client.respond(msg.id, { contentItems: [], success: false });
            } else {
                Logger.warn(`[CodexAppServer] unexpected server request ${msg.method}, rejecting`);
                client.respond(msg.id, { decision: 'decline' });
            }
        });
    }

    private reportCancellation(
        modelName: string,
        requestId: string,
        sessionId: string,
        requestMetricStartTime?: number,
        streamEndTime?: number,
        wasThrottled?: boolean
    ): void {
        Logger.info(`${modelName} Codex App Server request was cancelled by the user`);
        TokenUsagesManager.instance.updateActualTokens({
            requestId,
            sessionId,
            status: 'cancelled',
            ...(requestMetricStartTime !== undefined ? { requestMetricStartTime } : {}),
            wasThrottled,
            streamEndTime: streamEndTime ?? Date.now()
        });
    }
}
