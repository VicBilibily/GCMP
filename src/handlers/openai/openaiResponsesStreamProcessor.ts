import * as vscode from 'vscode';
import OpenAI, { APIUserAbortError } from 'openai';

import type { GenericUsageData } from '../../usages/fileLogger/types';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
import { StreamReporter } from '../streamReporter';
import type { Stream } from 'openai/streaming';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

type SDKResponsesStream = ReturnType<OpenAI['responses']['stream']>;
type ResponseReasoningItem = OpenAI.Responses.ResponseReasoningItem;

/**
 * 本地 Responses 事件分发器：仅复用 SDK ResponseStream 的事件注册签名。
 * SDK ResponseStream 的快照累积器在 response.failed 先于 response.created 到达时
 * 会先于事件分发抛内部状态错误，吞掉服务端真实错误消息；
 * 改为消费原始事件流（client.responses.create）并自行分发可规避该问题。
 */
export class OpenAIResponsesEventStream {
    private readonly listeners = new Map<string, Array<(event: never) => void>>();

    readonly on: SDKResponsesStream['on'] = ((type: string, handler: (event: never) => void) => {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
        return this;
    }) as unknown as SDKResponsesStream['on'];

    /** 与 SDK 事件分发顺序一致：先通用 event，再具体事件类型 */
    dispatch(event: ResponseStreamEvent): void {
        for (const handler of this.listeners.get('event') ?? []) {
            handler(event as never);
        }
        for (const handler of this.listeners.get(event.type) ?? []) {
            handler(event as never);
        }
    }
}

export interface OpenAIResponsesToolCallBuffer {
    id: string;
    name: string;
    args: string;
}

type OpenAIResponsesFinishReason = string | null;

function getContentEventKey(itemId?: string, contentIndex?: number): string | undefined {
    if (!itemId) {
        return undefined;
    }
    return `${itemId}:${contentIndex ?? -1}`;
}

function getSummaryEventKey(itemId?: string, summaryIndex?: number): string | undefined {
    if (!itemId) {
        return undefined;
    }
    return `${itemId}:summary:${summaryIndex ?? -1}`;
}

export function buildWebSearchCallContent(item: Record<string, unknown>): string {
    const action = item.action as Record<string, unknown> | undefined;
    if (!action) {
        return JSON.stringify({ type: 'web_search_call' });
    }

    const actionType = typeof action.type === 'string' ? action.type : '';
    if (actionType === 'search') {
        const queries = Array.isArray(action.queries) ? action.queries : undefined;
        const query = typeof action.query === 'string' ? action.query : undefined;
        return JSON.stringify({ type: 'web_search_call', action_type: 'search', query, queries });
    }

    if (actionType === 'open_page' && typeof action.url === 'string') {
        return JSON.stringify({ type: 'web_search_call', action_type: 'open_page', url: action.url });
    }

    if (actionType === 'find_in_page' && typeof action.pattern === 'string') {
        return JSON.stringify({
            type: 'web_search_call',
            action_type: 'find_in_page',
            pattern: action.pattern
        });
    }

    return JSON.stringify({ type: 'web_search_call', action_type: actionType || undefined });
}

export class OpenAIResponsesStreamState {
    private readonly textDeltaKeys = new Set<string>();
    private readonly refusalDeltaKeys = new Set<string>();
    private readonly reasoningTextDeltaKeys = new Set<string>();
    private readonly reasoningSummaryDeltaKeys = new Set<string>();
    private readonly reasoningSummaryItemIds = new Set<string>();

    private readonly toolCallBuffers = new Map<number, OpenAIResponsesToolCallBuffer>();
    private readonly completedToolCallIndices = new Set<number>();
    private readonly deltaCountedToolCallIndices = new Set<number>();
    private readonly toolCallIdToIndex = new Map<string, number>();
    private readonly completedWebSearchCallIds = new Set<string>();
    private nextToolCallIndex = 0;
    private lastTextDeltaOutputIndex: number | undefined;

    rememberOutputTextDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.textDeltaKeys.add(eventKey);
        }
    }

    shouldSkipOutputTextDone(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.textDeltaKeys.has(eventKey));
    }

    rememberRefusalDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.refusalDeltaKeys.add(eventKey);
        }
    }

    shouldSkipRefusalDone(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.refusalDeltaKeys.has(eventKey));
    }

    rememberReasoningTextDelta(itemId?: string, contentIndex?: number): void {
        const eventKey = getContentEventKey(itemId, contentIndex);
        if (eventKey) {
            this.reasoningTextDeltaKeys.add(eventKey);
        }
    }

    hasReasoningTextDelta(itemId?: string, contentIndex?: number): boolean {
        const eventKey = getContentEventKey(itemId, contentIndex);
        return Boolean(eventKey && this.reasoningTextDeltaKeys.has(eventKey));
    }

    rememberReasoningSummaryDelta(itemId?: string, summaryIndex?: number): void {
        const eventKey = getSummaryEventKey(itemId, summaryIndex);
        if (eventKey) {
            this.reasoningSummaryDeltaKeys.add(eventKey);
        }
        this.rememberReasoningSummaryItem(itemId);
    }

    rememberReasoningSummaryItem(itemId?: string): void {
        if (itemId) {
            this.reasoningSummaryItemIds.add(itemId);
        }
    }

    hasReasoningSummaryDelta(itemId?: string, summaryIndex?: number): boolean {
        const eventKey = getSummaryEventKey(itemId, summaryIndex);
        return Boolean(eventKey && this.reasoningSummaryDeltaKeys.has(eventKey));
    }

    hasReasoningSummaryItem(itemId?: string): boolean {
        return Boolean(itemId && this.reasoningSummaryItemIds.has(itemId));
    }

    getToolCallIndex(callId: string): number {
        if (!this.toolCallIdToIndex.has(callId)) {
            this.toolCallIdToIndex.set(callId, this.nextToolCallIndex++);
        }
        return this.toolCallIdToIndex.get(callId)!;
    }

    linkToolCallId(callId: string, idx: number): void {
        this.toolCallIdToIndex.set(callId, idx);
    }

    getStableToolCallIndex(itemId?: string, callId?: string): number | undefined {
        const primaryId = callId || itemId;
        if (!primaryId) {
            return undefined;
        }

        const idx = this.getToolCallIndex(primaryId);
        if (itemId && itemId !== primaryId) {
            this.linkToolCallId(itemId, idx);
        }
        if (callId && callId !== primaryId) {
            this.linkToolCallId(callId, idx);
        }
        return idx;
    }

    getToolCallBuffer(idx: number): OpenAIResponsesToolCallBuffer | undefined {
        return this.toolCallBuffers.get(idx);
    }

    setToolCallBuffer(idx: number, buffer: OpenAIResponsesToolCallBuffer): void {
        this.toolCallBuffers.set(idx, buffer);
    }

    isToolCallCompleted(idx: number): boolean {
        return this.completedToolCallIndices.has(idx);
    }

    markToolCallCompleted(idx: number): void {
        this.completedToolCallIndices.add(idx);
    }

    markToolCallDeltaCounted(idx: number): void {
        this.deltaCountedToolCallIndices.add(idx);
    }

    wasToolCallDeltaCounted(idx: number): boolean {
        return this.deltaCountedToolCallIndices.has(idx);
    }

    markWebSearchCallReported(wsId?: string): boolean {
        if (!wsId || this.completedWebSearchCallIds.has(wsId)) {
            return false;
        }

        this.completedWebSearchCallIds.add(wsId);
        return true;
    }

    /** 跨 output_index 的正文需要分段，避免 commentary 与最终答案粘连。 */
    shouldSeparateOutputText(outputIndex?: number): boolean {
        if (typeof outputIndex !== 'number') {
            return false;
        }

        const shouldSeparate =
            this.lastTextDeltaOutputIndex !== undefined && this.lastTextDeltaOutputIndex !== outputIndex;
        this.lastTextDeltaOutputIndex = outputIndex;
        return shouldSeparate;
    }
}

interface OpenAIResponsesStreamProcessorOptions {
    modelName: string;
    displayName: string;
    token: vscode.CancellationToken;
    abortController: AbortController;
    streamReporter: StreamReporter;
    sessionId: string;
}

export class OpenAIResponsesStreamProcessor {
    private readonly modelName: string;
    private readonly displayName: string;
    private readonly token: vscode.CancellationToken;
    private readonly abortController: AbortController;
    private readonly streamReporter: StreamReporter;
    private readonly sessionId: string;

    private streamError: Error | null = null;
    private hasFinalizedResponse = false;
    private finishReason: OpenAIResponsesFinishReason = null;
    private finalUsage: GenericUsageData | undefined = undefined;
    private streamStartTime: number | undefined;
    private streamEndTime: number | undefined = undefined;
    private readonly state = new OpenAIResponsesStreamState();
    private readonly events = new OpenAIResponsesEventStream();

    constructor(options: OpenAIResponsesStreamProcessorOptions) {
        this.modelName = options.modelName;
        this.displayName = options.displayName;
        this.token = options.token;
        this.abortController = options.abortController;
        this.streamReporter = options.streamReporter;
        this.sessionId = options.sessionId;
    }

    attach(): void {
        this.events
            .on('event', () => {
                // 心跳：每个 SSE 事件触发一次实时指标更新，确保首流前 latency 平滑增长
                this.streamReporter.heartbeat();
            })
            .on('response.created', () => {
                // 响应开始事件 - 记录流开始时间，同时固定首流延迟（共用时间戳）
                const now = Date.now();
                this.streamStartTime = now;
                this.streamReporter.markStreamStarted(now);
            })
            .on('response.output_text.delta', event => {
                if (this.token.isCancellationRequested) {
                    this.abortController.abort();
                    return;
                }
                this.state.rememberOutputTextDelta(event.item_id, event.content_index);
                const delta = event.delta;
                if (delta && typeof delta === 'string') {
                    this.reportOutputText(delta, event.output_index);
                }
            })
            .on('response.output_text.done', event => {
                // 某些网关只发送最终的 done 事件（没有增量）；去重必须按 output item/content part 粒度处理
                if (this.state.shouldSkipOutputTextDone(event.item_id, event.content_index)) {
                    return;
                }
                const text = event.text || '';
                if (text) {
                    this.reportOutputText(text, event.output_index);
                }
            })
            .on('response.output_text.annotation.added', event => {
                // 处理输出文本中的 URL 引用注解
                // 官方 Responses API 在 web_search 结果中会附带 url_citation 注解
                if (this.token.isCancellationRequested) {
                    return;
                }
                const annotation = event.annotation as Record<string, unknown> | undefined;
                if (annotation?.type === 'url_citation') {
                    const url = typeof annotation.url === 'string' ? annotation.url : '';
                    const title = typeof annotation.title === 'string' ? annotation.title : '';
                    if (url) {
                        const citationContent = JSON.stringify({
                            type: 'url_citation',
                            url,
                            title: title || undefined,
                            start_index:
                                typeof annotation.start_index === 'number' ? annotation.start_index : undefined,
                            end_index: typeof annotation.end_index === 'number' ? annotation.end_index : undefined
                        });
                        this.streamReporter.reportToolResult(
                            `citation_${event.item_id || ''}_${event.annotation_index ?? ''}`,
                            citationContent
                        );
                        Logger.debug(`${this.displayName} url_citation: ${url}${title ? ` "${title}"` : ''}`);
                    }
                }
            })
            .on('response.refusal.delta', event => {
                // 处理拒绝增量（当作普通文本）
                if (this.token.isCancellationRequested) {
                    this.abortController.abort();
                    return;
                }
                this.state.rememberRefusalDelta(event.item_id, event.content_index);
                const delta = event.delta;
                if (delta && typeof delta === 'string') {
                    this.streamReporter.reportText(delta);
                }
            })
            .on('response.refusal.done', event => {
                // 某些网关只发送 refusal.done，需要按 item/content 粒度兜底输出
                if (this.token.isCancellationRequested) {
                    return;
                }
                if (this.state.shouldSkipRefusalDone(event.item_id, event.content_index)) {
                    return;
                }
                const refusal = event.refusal || '';
                if (refusal) {
                    this.streamReporter.reportText(refusal);
                }
            })
            .on('response.reasoning_text.delta', event => {
                // 处理思维链文本增量
                if (this.token.isCancellationRequested) {
                    this.abortController.abort();
                    return;
                }
                this.state.rememberReasoningTextDelta(event.item_id, event.content_index);
                const delta = event.delta;
                if (delta && typeof delta === 'string') {
                    this.streamReporter.bufferThinking(delta);
                }
            })
            .on('response.reasoning_text.done', event => {
                // 处理思维链文本完成
                if (this.token.isCancellationRequested) {
                    return;
                }
                // 某些网关只发送最终的 done 事件（没有增量）
                if (!this.state.hasReasoningTextDelta(event.item_id, event.content_index) && event.text) {
                    this.streamReporter.bufferThinking(event.text);
                }
                this.streamReporter.endThinkingChain();
            })
            .on('response.reasoning_summary_text.delta', event => {
                // 处理思维链摘要增量（与官方实现一致：记录展示过摘要防止重复）
                this.state.rememberReasoningSummaryDelta(event.item_id, event.summary_index);
                if (this.token.isCancellationRequested) {
                    this.abortController.abort();
                    return;
                }
                const delta = event.delta;
                if (delta && typeof delta === 'string') {
                    this.streamReporter.bufferThinking(delta);
                }
            })
            .on('response.reasoning_summary_text.done', event => {
                // 处理思维链摘要完成
                this.state.rememberReasoningSummaryItem(event.item_id);
                if (this.token.isCancellationRequested) {
                    return;
                }
                // 某些网关只发送最终的 done 事件（没有增量）
                if (!this.state.hasReasoningSummaryDelta(event.item_id, event.summary_index) && event.text) {
                    this.streamReporter.bufferThinking(event.text);
                }
                this.streamReporter.endThinkingChain();
            })
            .on('response.reasoning_summary_part.done', event => {
                // 推理摘要 part 完成（与官方实现对齐）
                // 官方在此事件记录摘要已出现，避免 output_item.done 再次带出同一 item 的摘要文本
                this.state.rememberReasoningSummaryItem(event.item_id);
            })
            .on('response.function_call_arguments.delta', event => {
                // 仅当 arguments 增量能映射到稳定的工具调用身份时，才计入实时 chars/s。
                // 优先使用服务端返回的 call_id；只有兼容网关缺失时才退回 item_id。
                // 这里宁可少记，也不要重复计数。
                if (this.token.isCancellationRequested) {
                    return;
                }

                const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
                const callId = this.getEventCallId(event);
                const idx = this.state.getStableToolCallIndex(itemId, callId);
                if (idx === undefined) {
                    return;
                }

                // 某些兼容网关可能在 output_item.added 已带完整 args 后又补发 delta，
                // 此时该 call 已 completed，跳过避免重复计数
                if (this.state.isToolCallCompleted(idx)) {
                    return;
                }

                const delta = typeof event.delta === 'string' ? event.delta : '';
                if (delta.length > 0) {
                    this.streamReporter.reportToolArgDelta(delta);
                    this.state.markToolCallDeltaCounted(idx);
                }
            })
            .on('response.function_call_arguments.done', event => {
                if (this.token.isCancellationRequested) {
                    return;
                }

                const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
                const eventCallId = this.getEventCallId(event);
                const args = event.arguments || '';

                const idx = this.state.getStableToolCallIndex(itemId, eventCallId);
                if (idx === undefined) {
                    return;
                }

                if (this.state.isToolCallCompleted(idx)) {
                    return;
                }

                // 优先复用 added 事件中的 call_id；若其缺失，则使用 done 事件自带的服务端 call_id，
                // 只有兼容网关两者都不给时才退回 item_id。
                const buf = this.state.getToolCallBuffer(idx);
                const name = buf?.name || event.name;
                const callId = buf?.id || eventCallId || itemId;
                if (!callId) {
                    return;
                }
                if (!name) {
                    Logger.warn(`Tool call ${callId || itemId || 'unknown'} has no name`);
                    return;
                }

                // 使用 done 事件的完整参数
                this.state.setToolCallBuffer(idx, { id: callId, name, args });
                this.reportToolCallFromArguments(callId, name, args, idx);
            })
            .on('response.output_item.added', event => {
                // 处理输出项添加事件
                if (this.token.isCancellationRequested) {
                    return;
                }
                const item = event.item;
                // 官方实现：output_item.added 仅处理 function_call，reasoning 在 output_item.done 中处理
                if (item && item.type === 'function_call') {
                    const itemId = item.id;
                    if (!itemId) {
                        return;
                    }

                    // call_id 可能不存在，此时使用 itemId
                    const callId = item.call_id || itemId;
                    const name = item.name || '';
                    const args = item.arguments || '';

                    // 使用 item.id 作为索引（delta/done 事件中的 item_id 对应这里）
                    const idx = this.state.getToolCallIndex(itemId);
                    if (this.state.isToolCallCompleted(idx)) {
                        return;
                    }

                    // 如果 call_id 和 item.id 不同，也建立 call_id 的映射
                    if (item.call_id && item.call_id !== itemId) {
                        this.state.linkToolCallId(item.call_id, idx);
                    }

                    // 初始化或更新工具调用缓冲区
                    // 注意：此时 arguments 可能为空，参数会在后续的 delta/done 事件中累积
                    const buf = this.state.getToolCallBuffer(idx) || { id: callId, name: '', args: '' };
                    buf.id = callId;
                    if (name) {
                        buf.name = name;
                    }
                    // 如果已经有参数（某些情况下），使用它
                    if (args) {
                        buf.args = args;
                    }
                    this.state.setToolCallBuffer(idx, buf);

                    // 只有当参数完整时才发送工具调用
                    // 否则等待后续的 delta/done 事件
                    if (args && name) {
                        this.reportToolCallFromArguments(callId, name, args, idx);
                    }
                }
            })
            .on('response.output_item.done', event => {
                // 处理输出项完成事件（兼容某些网关）
                if (this.token.isCancellationRequested) {
                    return;
                }
                const item = event.item;
                // 推理项完成：与官方实现对齐，在 output_item.done 处理 reasoning
                // 官方对所有 reasoning 项都进入此分支，有加密内容时输出，无加密内容时为 no-op
                if (item && item.type === 'reasoning') {
                    const reasoningItem = item as unknown as ResponseReasoningItem;
                    if (reasoningItem.encrypted_content) {
                        // 仅当摘要文本未经流式传输时才包含
                        // （参照官方实现: hasReceivedReasoningSummary 为 true 时传 undefined 避免重复）
                        const summaryText =
                            reasoningItem.id && this.state.hasReasoningSummaryItem(reasoningItem.id) ?
                                undefined
                            :   reasoningItem.summary?.map(summary => summary.text);
                        this.streamReporter.reportEncryptedThinking(
                            reasoningItem.encrypted_content,
                            reasoningItem.id,
                            summaryText
                        );
                    }
                    // else: 无加密内容，no-op（与官方 onProgress({ thinking: undefined }) 行为一致）
                }
                if (item && typeof item === 'object' && item.type === 'function_call') {
                    const itemObj = item as unknown as Record<string, unknown>;
                    const itemId = typeof itemObj.id === 'string' ? itemObj.id : '';
                    const callId = itemObj.call_id || itemObj.id;
                    const name = typeof itemObj.name === 'string' ? itemObj.name : '';
                    const args = typeof itemObj.arguments === 'string' ? itemObj.arguments : '';

                    if (!itemId || !callId || !name || !args) {
                        return;
                    }

                    const idx = this.state.getToolCallIndex(itemId);
                    if (this.state.isToolCallCompleted(idx)) {
                        return;
                    }

                    this.reportToolCallFromArguments(callId as string, name, args, idx);
                }
                // 处理内置 web_search_call：在 output_item.done 上报（此时 item 含完整 action）
                // 抓包验证：output_item.added 时 item 仅含 id/type/status，无 action；
                // action（search/open_page/find_in_page）只在 output_item.done 的 item.action 中出现
                if (item && typeof item === 'object' && item.type === 'web_search_call') {
                    this.reportWebSearchCall(item as unknown as Record<string, unknown>, 'done');
                }
            })
            .on('response.failed', event => {
                this.streamEndTime ??= Date.now();
                const usage = (event.response as { usage?: unknown }).usage;
                if (usage) {
                    this.finalUsage ??= usage as GenericUsageData;
                }
                const errorMessage = event.response.error?.message || t('Response generation failed', '响应生成失败');
                Logger.warn(`${this.modelName} Responses API response.failed: ${errorMessage}`);
                this.streamError ??= new Error(errorMessage);
            })
            .on('response.incomplete', event => {
                const reason =
                    typeof event.response.incomplete_details?.reason === 'string' ?
                        event.response.incomplete_details.reason
                    :   undefined;
                const finishReason: OpenAIResponsesFinishReason =
                    reason === 'max_output_tokens' ? 'length'
                    : typeof reason === 'string' ? reason
                    : null;
                this.finalizeResponse(event.response, finishReason);
                if (finishReason === 'length') {
                    Logger.warn(`${this.modelName} Responses API response.incomplete: max_output_tokens`);
                    return;
                }

                const errorMessage =
                    event.response.error?.message ||
                    (reason === 'content_filter' ?
                        t('Response blocked by content filter', '响应被内容过滤器拦截')
                    :   t('Response generation incomplete', '响应生成未完成'));
                Logger.warn(`${this.modelName} Responses API response.incomplete: ${errorMessage}`);
                this.streamError ??= new Error(errorMessage);
            })
            .on('response.completed', event => {
                this.finalizeResponse(event.response);
            })
            .on('error', error => {
                // 保存错误，并中止请求
                if (error instanceof Error) {
                    this.streamError = error;
                } else {
                    // ResponseErrorEvent 不是 Error 类型，需要转换
                    const errorMsg = 'message' in error ? (error as { message: string }).message : String(error);
                    this.streamError = new Error(errorMsg);
                }
                this.abortController.abort();
            });
    }

    async consume(stream: Stream<ResponseStreamEvent>): Promise<void> {
        try {
            for await (const event of stream) {
                this.events.dispatch(event);
                // 终态或错误后提前结束消费，避免对端继续保持连接造成的无效等待
                if (this.streamError || this.hasFinalizedResponse) {
                    break;
                }
            }
            // 原始流在 abort 时静默结束迭代（SDK 内部 isAbortError 直接 return），
            // 补偿 SDK ResponseStream 的取消语义：用户取消时抛取消错误，避免被误报为成功完成
            if (!this.streamError && this.token.isCancellationRequested) {
                this.streamError = new APIUserAbortError();
            }
        } catch (error) {
            if (!this.streamError) {
                this.streamError = error instanceof Error ? error : new Error(String(error));
            }
        }

        this.streamEndTime ??= Date.now();

        if (this.streamError) {
            throw this.streamError;
        }
    }

    getFinalUsage(): GenericUsageData | undefined {
        return this.finalUsage;
    }

    getFinishReason(): OpenAIResponsesFinishReason {
        return this.finishReason;
    }

    getStreamStartTime(): number | undefined {
        return this.streamStartTime;
    }

    getStreamEndTime(): number | undefined {
        return this.streamEndTime;
    }

    // 兼容 SDK 类型未声明 call_id 的情况，从事件对象中安全提取该字段。
    private getEventCallId(event: unknown): string | undefined {
        const value = (event as { call_id?: unknown }).call_id;
        return typeof value === 'string' ? value : undefined;
    }

    private reportOutputText(text: string, outputIndex?: number): void {
        if (this.state.shouldSeparateOutputText(outputIndex)) {
            this.streamReporter.reportText('\n\n');
        }
        this.streamReporter.reportText(text);
    }

    private finalizeResponse(
        response: {
            id?: string;
            usage?: unknown;
            output?: Array<{
                type?: string;
                id?: string;
                name?: string;
                call_id?: string;
                arguments?: string;
            }>;
        },
        finishReason: OpenAIResponsesFinishReason = null
    ): void {
        this.streamEndTime = Date.now();
        this.hasFinalizedResponse = true;
        this.finishReason = finishReason;

        if (response.usage) {
            this.finalUsage = response.usage as GenericUsageData;
        }

        const output = response.output;
        if (Array.isArray(output)) {
            for (const item of output) {
                if (item.type === 'function_call' && item.id && item.name) {
                    const callId = item.call_id || item.id;
                    const idx = this.state.getToolCallIndex(item.id);
                    if (this.state.isToolCallCompleted(idx)) {
                        continue;
                    }

                    this.reportToolCallFromArguments(callId, item.name, item.arguments || '{}', idx);
                }
                if (item.type === 'web_search_call' && item.id) {
                    this.reportWebSearchCall(item as unknown as Record<string, unknown>, 'completed');
                }
            }
        }

        const responseId = response.id;
        if (responseId) {
            this.streamReporter.flushAll(
                finishReason,
                {
                    sessionId: this.sessionId,
                    responseId
                },
                this.finalUsage
            );
            Logger.debug(
                `💾 ${this.modelName} Passed StatefulMarker: sessionId=${this.sessionId}, responseId=${responseId}`
            );
        } else {
            this.streamReporter.flushAll(finishReason, undefined, this.finalUsage);
        }
    }

    private reportToolCallFromArguments(callId: string, name: string, args: string, idx: number): void {
        try {
            const input = JSON.parse(args || '{}');
            this.streamReporter.reportToolCall(callId, name, input, {
                countArgs: !this.state.wasToolCallDeltaCounted(idx)
            });
            this.state.markToolCallCompleted(idx);
        } catch (error) {
            Logger.warn(`Failed to parse tool call arguments: ${args}`, error);
        }
    }

    private reportWebSearchCall(item: Record<string, unknown>, stage: 'done' | 'completed'): void {
        const wsId = typeof item.id === 'string' ? item.id : '';
        if (!this.state.markWebSearchCallReported(wsId)) {
            return;
        }
        const content = buildWebSearchCallContent(item);
        this.streamReporter.reportToolResult(wsId, content);
        Logger.debug(`${this.displayName} web_search_call ${stage}: ${wsId}`);
    }
}
