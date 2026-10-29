import { OpenAIResponsesStreamState } from './responses/stream/state';
export { OpenAIResponsesStreamState } from './responses/stream/state';
export type { OpenAIResponsesToolCallBuffer } from './responses/stream/state';
import * as vscode from 'vscode';
import OpenAI, { APIUserAbortError } from 'openai';

import type { GenericUsageData } from '../../usages/fileLogger/types';
import { Logger } from '../../utils/runtime/logger';
import type { RequestDiagnostics } from '../../utils/net/requestDiagnostics';
import { t } from '../../utils/runtime/l10n';
import { StreamReporter } from '../streamReporter';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

export interface ResponsesCancelledEvent {
    type: 'response.cancelled';
    response: { id: string; usage?: GenericUsageData };
}

export type ResponsesProcessorEvent = ResponseStreamEvent | ResponsesCancelledEvent;

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

type OpenAIResponsesFinishReason = string | null;

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

interface OpenAIResponsesStreamProcessorOptions {
    modelName: string;
    displayName: string;
    token: vscode.CancellationToken;
    abortController: AbortController;
    streamReporter: StreamReporter;
    sessionId: string;
    requireExplicitTerminal?: boolean;
}

export class OpenAIResponsesStreamProcessor {
    private readonly modelName: string;
    private readonly displayName: string;
    private readonly token: vscode.CancellationToken;
    private readonly abortController: AbortController;
    private readonly streamReporter: StreamReporter;
    private readonly sessionId: string;
    private readonly requireExplicitTerminal: boolean;

    private streamError: Error | null = null;
    private hasFinalizedResponse = false;
    private finishReason: OpenAIResponsesFinishReason = null;
    private finalUsage: GenericUsageData | undefined = undefined;
    private streamStartTime: number | undefined;
    private streamEndTime: number | undefined = undefined;
    private readonly state = new OpenAIResponsesStreamState();
    private readonly events = new OpenAIResponsesEventStream();
    private readonly deliveredText = new Map<string, string>();
    private readonly textItemIndices = new Map<string, number>();
    private readonly textIndexItems = new Map<number, string>();
    private lastTextKey: string | undefined;
    private lastTextPosition: [number, number] | undefined;

    constructor(options: OpenAIResponsesStreamProcessorOptions) {
        this.modelName = options.modelName;
        this.displayName = options.displayName;
        this.token = options.token;
        this.abortController = options.abortController;
        this.streamReporter = options.streamReporter;
        this.sessionId = options.sessionId;
        this.requireExplicitTerminal = options.requireExplicitTerminal ?? true;
    }

    attach(diagnostics?: RequestDiagnostics): void {
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
                const delta = event.delta;
                if (delta && typeof delta === 'string') {
                    const key = this.textKey(event.item_id, event.output_index, event.content_index);
                    const outputIndex = event.output_index ?? this.textItemIndices.get(event.item_id);
                    this.checkTextPosition(outputIndex, event.content_index);
                    this.deliveredText.set(key, (this.deliveredText.get(key) ?? '') + delta);
                    this.lastTextKey = key;
                    this.reportOutputText(delta, outputIndex);
                }
            })
            .on('response.output_text.done', event => {
                if (this.token.isCancellationRequested) {
                    return;
                }
                this.reconcileText(event.text, event.item_id, event.output_index, event.content_index);
            })
            .on('response.content_part.done', event => {
                if (!this.token.isCancellationRequested && event.part.type === 'output_text') {
                    this.reconcileText(event.part.text, event.item_id, event.output_index, event.content_index);
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
                // 歧义 call_id 缺少 item/index 身份时宁可少计，不混入其他调用。
                if (this.token.isCancellationRequested) {
                    return;
                }

                const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
                const callId = this.getEventCallId(event);
                const idx = this.state.getStableToolCallIndex(itemId, callId, event.output_index);
                if (idx === undefined) {
                    return;
                }

                if (this.state.isToolCallCompleted(idx)) {
                    return;
                }

                const delta = typeof event.delta === 'string' ? event.delta : '';
                if (delta.length > 0) {
                    this.streamReporter.reportToolArgDelta(delta);
                    const buffer = this.state.getToolCallBuffer(idx);
                    if (buffer) {
                        buffer.args = (this.state.wasToolCallDeltaCounted(idx) ? buffer.args : '') + delta;
                    }
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

                const idx = this.state.getStableToolCallIndex(itemId, eventCallId, event.output_index);
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
            })
            .on('response.output_item.added', event => {
                // 处理输出项添加事件
                if (this.token.isCancellationRequested) {
                    return;
                }
                const item = event.item;
                // 官方实现：output_item.added 仅处理 function_call，reasoning 在 output_item.done 中处理
                if (item?.type === 'message') {
                    this.textKey(item.id, event.output_index, 0);
                }
                if (item && item.type === 'function_call') {
                    const itemId = item.id;
                    if (!itemId && !item.call_id && event.output_index === undefined) {
                        return;
                    }

                    // call_id 可能不存在，此时使用 itemId
                    const callId = item.call_id || itemId || `call_output_${event.output_index}`;
                    const name = item.name || '';
                    const args = item.arguments || '';

                    // 使用 item.id 作为索引（delta/done 事件中的 item_id 对应这里）
                    const idx = this.state.getStableToolCallIndex(
                        itemId,
                        item.call_id || undefined,
                        event.output_index
                    );
                    if (idx === undefined || this.state.isToolCallCompleted(idx)) {
                        return;
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
                }
            })
            .on('response.output_item.done', event => {
                // 处理输出项完成事件（兼容某些网关）
                if (this.token.isCancellationRequested) {
                    return;
                }
                const item = event.item;
                // 推理项完成：与官方实现对齐，在 output_item.done 处理 reasoning
                if (item?.type === 'message') {
                    this.reconcileMessage(item, event.output_index);
                }
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
                    const args = typeof itemObj.arguments === 'string' ? itemObj.arguments : undefined;

                    if (!callId || !name) {
                        return;
                    }

                    const idx = this.state.getStableToolCallIndex(
                        itemId,
                        typeof itemObj.call_id === 'string' ? itemObj.call_id : undefined,
                        event.output_index
                    );
                    if (idx === undefined || this.state.isToolCallCompleted(idx)) {
                        return;
                    }

                    this.reportToolCallFromArguments(
                        callId as string,
                        name,
                        args ?? this.state.getToolCallBuffer(idx)?.args ?? '{}',
                        idx
                    );
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
                this.streamError ??= new OpenAI.APIError(
                    undefined,
                    { ...event.response.error, message: errorMessage },
                    errorMessage,
                    undefined
                );
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
                this.finalizeResponse(event.response, finishReason, reason === 'content_filter');
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
                this.streamError ??= new OpenAI.APIError(
                    undefined,
                    { ...event.response.error, message: errorMessage },
                    errorMessage,
                    undefined
                );
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
                    this.streamError = new OpenAI.APIError(
                        undefined,
                        { ...error, message: errorMsg },
                        errorMsg,
                        undefined
                    );
                }
                diagnostics?.error(this.streamError);
                diagnostics?.abort('stream_error');
                this.abortController.abort();
            });
    }

    async consume(stream: AsyncIterable<ResponsesProcessorEvent>, diagnostics?: RequestDiagnostics): Promise<void> {
        try {
            for await (const event of stream) {
                diagnostics?.streamEvent();
                if (
                    event.type === 'response.completed' ||
                    event.type === 'response.incomplete' ||
                    event.type === 'response.failed' ||
                    event.type === 'response.cancelled'
                ) {
                    if (event.response.usage) {
                        this.finalUsage ??= event.response.usage as GenericUsageData;
                    }
                }
                if (this.token.isCancellationRequested && event.type !== 'response.failed' && event.type !== 'error') {
                    throw new APIUserAbortError();
                }
                if (event.type === 'response.cancelled') {
                    throw new Error('Responses request cancelled by upstream');
                }
                this.events.dispatch(event);
                // 终态或错误后提前结束消费，避免对端继续保持连接造成的无效等待
                if (this.streamError || this.hasFinalizedResponse) {
                    if (this.streamError) {
                        diagnostics?.error(this.streamError);
                    }
                    diagnostics?.abort(this.streamError ? 'stream_error' : 'terminal_cleanup');
                    break;
                }
            }
            // 原始流在 abort 时静默结束迭代（SDK 内部 isAbortError 直接 return），
            // 补偿 SDK ResponseStream 的取消语义：用户取消时抛取消错误，避免被误报为成功完成
            if (!this.streamError && this.token.isCancellationRequested) {
                this.streamError = new APIUserAbortError();
            }
        } catch (error) {
            diagnostics?.error(error);
            if (!this.streamError) {
                this.streamError = error instanceof Error ? error : new Error(String(error));
            }
        }

        this.streamEndTime ??= Date.now();

        if (this.streamError) {
            throw this.streamError;
        }
        if (!this.hasFinalizedResponse) {
            if (this.requireExplicitTerminal) {
                throw new Error('Responses stream ended without an explicit terminal event');
            }
            this.flushPendingToolCalls();
            if (!this.streamReporter.hasContent) {
                throw new Error(
                    t('Responses stream ended without receiving any output', 'Responses 流在收到任何内容前提前结束')
                );
            }
            this.finalizeResponse({});
            if (this.token.isCancellationRequested) {
                throw new APIUserAbortError();
            }
        }
    }

    getFinalUsage(): GenericUsageData | undefined {
        return this.finalUsage;
    }

    getFinishReason(): OpenAIResponsesFinishReason {
        return this.finishReason;
    }

    isResponseFinalized(): boolean {
        return this.hasFinalizedResponse;
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

    private textKey(itemId?: string, outputIndex?: number, contentIndex = 0): string {
        if (itemId && outputIndex !== undefined) {
            const previous = this.textItemIndices.get(itemId);
            const previousItem = this.textIndexItems.get(outputIndex);
            if (
                (previous !== undefined && previous !== outputIndex) ||
                (previousItem !== undefined && previousItem !== itemId)
            ) {
                throw new Error('Responses text identity mismatch');
            }
            this.textItemIndices.set(itemId, outputIndex);
            this.textIndexItems.set(outputIndex, itemId);
            const prefix = `item:${itemId}:`;
            for (const [oldKey, text] of previous === undefined ? this.deliveredText : []) {
                if (!oldKey.startsWith(prefix)) continue;
                const partIndex = oldKey.slice(prefix.length);
                if (!/^\d+$/.test(partIndex)) continue;
                const newKey = `index:${outputIndex}:${partIndex}`;
                if (this.deliveredText.has(newKey)) {
                    throw new Error('Responses text identity mismatch');
                }
                this.deliveredText.set(newKey, text);
                this.deliveredText.delete(oldKey);
                if (this.lastTextKey === oldKey) {
                    this.lastTextKey = newKey;
                    this.checkTextPosition(outputIndex, Number(partIndex));
                    this.state.shouldSeparateOutputText(outputIndex);
                }
            }
        }
        const index = outputIndex ?? (itemId ? this.textItemIndices.get(itemId) : undefined);
        if (index === undefined && !itemId) {
            throw new Error('Responses text identity missing');
        }
        return index !== undefined ? `index:${index}:${contentIndex}` : `item:${itemId}:${contentIndex}`;
    }

    private reconcileText(text: string, itemId?: string, outputIndex?: number, contentIndex = 0): void {
        const key = this.textKey(itemId, outputIndex, contentIndex);
        const delivered = this.deliveredText.get(key) ?? '';
        if (!text.startsWith(delivered)) {
            throw new Error('Responses text snapshot mismatch');
        }
        const suffix = text.slice(delivered.length);
        if (!suffix) return;
        if (this.deliveredText.has(key) && this.lastTextKey !== key) {
            throw new Error('Responses text snapshot mismatch: cannot append to an earlier content part');
        }
        const resolvedIndex = outputIndex ?? (itemId ? this.textItemIndices.get(itemId) : undefined);
        this.checkTextPosition(resolvedIndex, contentIndex);
        this.deliveredText.set(key, text);
        this.lastTextKey = key;
        this.reportOutputText(suffix, resolvedIndex);
    }

    private checkTextPosition(outputIndex?: number, contentIndex = 0): void {
        if (outputIndex === undefined) return;
        const previous = this.lastTextPosition;
        if (previous && (outputIndex < previous[0] || (outputIndex === previous[0] && contentIndex < previous[1]))) {
            throw new Error('Responses text snapshot mismatch: out-of-order content');
        }
        this.lastTextPosition = [outputIndex, contentIndex];
    }

    private reconcileMessage(
        item: { id?: string; content?: Array<{ type: string; text?: string }> },
        outputIndex?: number
    ): void {
        for (const [contentIndex, part] of (item.content ?? []).entries()) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
                this.reconcileText(part.text, item.id, outputIndex, contentIndex);
            }
        }
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
                content?: Array<{ type: string; text?: string }>;
            }>;
        },
        finishReason: OpenAIResponsesFinishReason = null,
        suppressPendingTools = false
    ): void {
        this.streamEndTime = Date.now();
        this.finishReason = finishReason;

        if (response.usage) {
            this.finalUsage = response.usage as GenericUsageData;
        }

        const output = response.output;
        if (Array.isArray(output) && !suppressPendingTools) {
            const indexedOutput = output.map((item, position) => ({
                item,
                outputIndex:
                    item.type === 'message' && item.id ? (this.textItemIndices.get(item.id) ?? position) : position
            }));
            const messageIndices = new Set<number>();
            for (const { outputIndex, item } of indexedOutput) {
                if (item.type === 'message') {
                    if (messageIndices.has(outputIndex)) {
                        throw new Error('Responses text identity mismatch: duplicate terminal message index');
                    }
                    messageIndices.add(outputIndex);
                    this.textKey(item.id, outputIndex, 0);
                }
            }
            this.state.beginCompletedPhase(output);
            for (const { outputIndex, item } of indexedOutput) {
                if (item.type === 'message') {
                    this.reconcileMessage(item, outputIndex);
                }
                if (item.type === 'function_call' && (item.id || item.call_id) && item.name) {
                    const callId = item.call_id || item.id!;
                    const idx = this.state.getCompletedPhaseToolCallIndex(
                        item.id,
                        item.call_id,
                        item.name,
                        item.arguments,
                        outputIndex
                    );
                    if (idx === undefined || this.state.isToolCallCompleted(idx)) {
                        continue;
                    }

                    this.reportToolCallFromArguments(
                        callId,
                        item.name,
                        item.arguments ?? this.state.getToolCallBuffer(idx)?.args ?? '{}',
                        idx
                    );
                }
                if (item.type === 'web_search_call' && item.id) {
                    this.reportWebSearchCall(item as unknown as Record<string, unknown>, 'completed');
                }
            }
        }

        if (finishReason === null && !suppressPendingTools) {
            this.flushPendingToolCalls();
        }

        this.hasFinalizedResponse = true;
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
        if (this.token.isCancellationRequested || this.streamError) {
            return;
        }
        let input: object;
        try {
            input = JSON.parse(args || '{}');
        } catch (error) {
            Logger.warn(`Failed to parse tool call arguments: ${args}`, error);
            return;
        }
        this.state.setToolCallBuffer(idx, { id: callId, name, args });
        this.streamReporter.reportToolCall(callId, name, input, {
            countArgs: !this.state.wasToolCallDeltaCounted(idx)
        });
        this.state.markToolCallCompleted(idx);
    }

    private flushPendingToolCalls(): void {
        for (const [idx, buffer] of this.state.getPendingToolCalls()) {
            if (buffer.name && buffer.args) {
                this.reportToolCallFromArguments(buffer.id, buffer.name, buffer.args, idx);
            }
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
