/*---------------------------------------------------------------------------------------------
 *  Codex App Server 处理器（sdkMode: codex-app-server）
 *  经本机 codex app-server（JSON-RPC over stdio）完成对话。
 *  模式 A（ephemeral thread，每请求独立，默认）与模式 B（persistent thread，增量 + marker 恢复）；
 *  取消经 turn/interrupt。Dynamic Tools 由后续任务扩展。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getCodexAppServerClient, getCodexAppServerConfig } from '../cli/appServer';
import type { CodexAppServerClient } from '../cli/appServer/client';
import { codexThreadSessionStore } from '../cli/appServer/threadSessionStore';
import type {
    AgentMessageDeltaNotification,
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
    TurnStartResponse,
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
import * as liveMetrics from './liveMetrics';
import { StreamReporter } from './streamReporter';
import type { ModelConfig } from '../types/sharedTypes';
import type { JsonValue } from '../cli/appServer/protocolTypes';

/** vscode 消息 → thread 输入的转换结果 */
interface ThreadInputParts {
    /** 系统提示词（拼接，作为 thread/start.developerInstructions） */
    developerInstructions?: string;
    /** 历史轮次注入项（Responses ResponseItem 格式，thread/inject_items） */
    historyItems: JsonValue[];
    /** 本轮用户输入（turn/start.input） */
    turnInput: UserInput[];
}

/** 一轮对话的执行策略（模式 A/B 归一后的执行输入） */
interface TurnStrategy extends ThreadInputParts {
    /** 已存在且 resume 成功的持久 thread ID；undefined = 新建 thread */
    resumeThreadId?: string;
    /** 新建 thread 是否持久（模式 B 全新会话）；回退/模式 A 为 false */
    persistentNew: boolean;
    /** Dynamic Tools 注册表（仅新建 thread 时传入） */
    dynamicTools?: DynamicToolFunctionSpec[];
}

/** Dynamic Tool 调用的执行超时（2 分钟，超时按失败兜底，避免挂死 turn） */
const TOOL_CALL_TIMEOUT_MS = 120_000;

export class CodexAppServerHandler {
    /** 服务端反向请求兜底已注册标记（进程级一次） */
    private static serverRequestFallbackRegistered = false;

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

        try {
            const client = getCodexAppServerClient(this.context);
            this.registerServerRequestFallback(client);
            await client.ensureReady();

            const threadMode = getCodexAppServerConfig().threadMode ?? 'ephemeral';
            const dynamicTools = this.buildDynamicTools(options, modelConfig);
            // 协议侧模型标识用原始 slug（modelConfig.id）；model.id 带 vendor 前缀（gcmp.codex:::），仅用于 marker 匹配
            const strategy: TurnStrategy =
                threadMode === 'persistent' ?
                    await this.resolvePersistentStrategy(client, messages, model.id, modelConfig.id, sessionId)
                :   { ...this.convertMessages(messages), persistentNew: false };
            if (!strategy.resumeThreadId) {
                strategy.dynamicTools = dynamicTools;
            }
            if (strategy.turnInput.length === 0) {
                throw new Error('Codex App Server: no user input found in messages');
            }

            // resume 成功的持久 thread 直接复用；否则新建（模式 B 全新会话为持久 thread）
            const threadId = strategy.resumeThreadId ?? (await this.startThread(client, modelConfig.id, strategy));
            Logger.debug(
                `[CodexAppServer] thread ready: ${threadId} (${
                    strategy.resumeThreadId ? 'resumed'
                    : strategy.persistentNew ? 'persistent-new'
                    : 'ephemeral'
                })`
            );

            let turnId = '';
            await client.withThreadLock(threadId, async () => {
                if (strategy.historyItems.length > 0) {
                    await client.request('thread/inject_items', { threadId, items: strategy.historyItems });
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
                    threadId,
                    input: strategy.turnInput
                });
                turnId = turnResp.turn.id;

                // Dynamic Tools：本 thread 的 item/tool/call 路由到工具执行闭环
                const toolCallHandler =
                    strategy.dynamicTools || strategy.resumeThreadId ?
                        client.registerServerRequestHandler(threadId, msg =>
                            this.handleServerRequest(client, msg, token)
                        )
                    :   undefined;

                const cancellationListener = token.onCancellationRequested(() => {
                    void client
                        .request('turn/interrupt', { threadId, turnId })
                        .catch(error => Logger.warn(`[CodexAppServer] turn/interrupt failed: ${error}`));
                });
                try {
                    await this.waitTurnCompletion(client, threadId, turnId, reporter, token);
                } finally {
                    cancellationListener.dispose();
                    toolCallHandler?.dispose();
                }
                streamEndTime = Date.now();
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
                    updatedAt: Date.now()
                });
                for (const entry of evicted) {
                    void client
                        .request('thread/archive', { threadId: entry.threadId })
                        .catch(error => Logger.warn(`[CodexAppServer] thread/archive failed: ${error}`));
                }
            }

            const finalUsage = this.lastUsage;
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
                persistentResult ?
                    {
                        sessionId,
                        responseId: persistentResult.turnId,
                        codexThreadId: persistentResult.threadId,
                        codexLastTurnId: persistentResult.turnId
                    }
                :   undefined,
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
     * - item/tool/call：invokeTool 执行（2 分钟超时），结果/失败均闭环响应，避免挂死 turn
     * - 其他（审批类）：拒绝兜底
     */
    private handleServerRequest(
        client: CodexAppServerClient,
        msg: JsonRpcServerRequestFrame,
        token: vscode.CancellationToken
    ): void {
        if (msg.method !== 'item/tool/call') {
            Logger.warn(`[CodexAppServer] unexpected server request ${msg.method}, rejecting`);
            client.respond(msg.id, { decision: 'decline' });
            return;
        }
        void this.executeToolCall(client, msg.id, msg.params as DynamicToolCallParams, token);
    }

    private async executeToolCall(
        client: CodexAppServerClient,
        requestId: number | string,
        params: DynamicToolCallParams,
        token: vscode.CancellationToken
    ): Promise<void> {
        const fail = (reason: string): void => {
            Logger.warn(`[CodexAppServer] tool call ${params.tool} (${params.callId}) failed: ${reason}`);
            client.respond(requestId, {
                contentItems: [{ type: 'inputText', text: `Tool execution failed: ${reason}` }],
                success: false
            });
        };
        try {
            let toolInput: unknown = params.arguments;
            if (typeof params.arguments === 'string') {
                try {
                    toolInput = JSON.parse(params.arguments);
                } catch {
                    // 保留字符串原文
                }
            }
            const invocation = vscode.lm.invokeTool(
                params.tool,
                {
                    input: toolInput as Record<string, unknown>,
                    // 模型提供商收不到 ChatRequest.toolInvocationToken，只能传 undefined（无聊天内联 UI）
                    toolInvocationToken: undefined
                },
                token
            );
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('tool call timed out')), TOOL_CALL_TIMEOUT_MS)
            );
            const result = await Promise.race([invocation, timeout]);
            const text = result.content
                .map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
                .filter(Boolean)
                .join('\n');
            Logger.debug(`[CodexAppServer] tool call ${params.tool} (${params.callId}) completed`);
            client.respond(requestId, {
                contentItems: [{ type: 'inputText', text: text || '(no output)' }],
                success: true
            });
        } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * 模式 B 会话策略：marker/store 命中持久 thread 时 resume + 增量注入；
     * resume 失败、turn 对账失配或无增量输入时回退 ephemeral 全量重放（官方 Copilot 同款兜底）。
     */
    private async resolvePersistentStrategy(
        client: CodexAppServerClient,
        messages: readonly vscode.LanguageModelChatMessage[],
        markerModelId: string,
        wireModelId: string,
        sessionId: string
    ): Promise<TurnStrategy> {
        const markerHit = this.extractCodexMarker(messages);
        const stored = codexThreadSessionStore.get(sessionId);
        const threadId = markerHit?.marker.codexThreadId ?? stored?.threadId;
        const lastTurnId = markerHit?.marker.codexLastTurnId ?? stored?.lastTurnId;

        if (threadId && markerHit && markerHit.marker.modelId === markerModelId) {
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
                    persistentNew: false
                };
            } catch (error) {
                Logger.warn(`[CodexAppServer] persistent resume failed, falling back to ephemeral replay: ${error}`);
                codexThreadSessionStore.delete(sessionId);
            }
        } else if (threadId && markerHit && markerHit.marker.modelId !== markerModelId) {
            Logger.debug(`[CodexAppServer] model changed (${markerHit.marker.modelId} → ${markerModelId}), new thread`);
        }

        // 全新持久会话：全量历史注入
        return { ...this.convertMessages(messages), persistentNew: true };
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

    /** 最近一次 thread/tokenUsage/updated 的本轮 usage（waitTurnCompletion 内更新） */
    private lastUsage: GenericUsageData | undefined;

    /**
     * 等待 turn 完成：映射流式通知到 StreamReporter。
     * turn/completed 后 resolve；failed/interrupted 走错误/取消路径。
     */
    private waitTurnCompletion(
        client: CodexAppServerClient,
        threadId: string,
        turnId: string,
        reporter: StreamReporter,
        token: vscode.CancellationToken
    ): Promise<void> {
        this.lastUsage = undefined;
        return new Promise<void>((resolve, reject) => {
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
                            this.lastUsage = this.mapUsage(p.tokenUsage.last);
                        }
                        break;
                    }
                    case 'item/completed': {
                        // dynamicToolCall 等条目完成时 flush 思考缓冲
                        const p = msg.params as ItemCompletedNotification;
                        if (p.turnId === turnId && p.item.type === 'reasoning') {
                            reporter.flushAll(null);
                        }
                        break;
                    }
                    case 'turn/completed': {
                        const p = msg.params as TurnCompletedNotification;
                        if (p.turn.id !== turnId) {
                            break;
                        }
                        subscription.dispose();
                        if (p.turn.status === 'completed') {
                            resolve();
                        } else if (p.turn.status === 'interrupted' || token.isCancellationRequested) {
                            resolve(); // 取消由外层 token 状态统一处理
                        } else {
                            reject(
                                new Error(p.turn.error?.message || `Codex turn failed with status ${p.turn.status}`)
                            );
                        }
                        break;
                    }
                    default:
                        break;
                }
            }, threadId);
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
     * vscode 消息 → developerInstructions + 历史注入项 + 本轮输入。
     * 系统消息：role=System 或 name=GCMP_SYSTEM_MESSAGE_NAME 的 user 消息。
     * 历史注入采用 Responses ResponseItem 格式（PoC-7 实测模型可见）。
     * 图片等 DataPart 阶段 1 暂不支持（跳过并告警）。
     */
    private convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): ThreadInputParts {
        const systemParts: string[] = [];
        const historyItems: JsonValue[] = [];
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
                const inputs = this.toUserInputs(message);
                if (i === lastUserIndex) {
                    turnInput = inputs;
                } else if (inputs.length > 0) {
                    historyItems.push({
                        type: 'message',
                        role: 'user',
                        content: inputs.map(input =>
                            input.type === 'text' ? { type: 'input_text', text: input.text } : input
                        )
                    } as JsonValue);
                }
                continue;
            }

            // assistant → 历史注入（agent 输出文本）
            const text = this.extractText(message);
            if (text) {
                historyItems.push({
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text }]
                } as JsonValue);
            }
        }

        return {
            developerInstructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
            historyItems,
            turnInput
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

    /**
     * 服务端反向请求兜底：approvalPolicy='never' 下审批不应出现，出现即拒绝；
     * item/tool/call 由后续 Dynamic Tools 任务接管，此处先按失败兜底，避免挂起 turn。
     */
    private registerServerRequestFallback(client: CodexAppServerClient): void {
        if (CodexAppServerHandler.serverRequestFallbackRegistered) {
            return;
        }
        CodexAppServerHandler.serverRequestFallbackRegistered = true;
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
