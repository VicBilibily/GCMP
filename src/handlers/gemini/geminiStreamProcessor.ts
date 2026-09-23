/*---------------------------------------------------------------------------------------------
 *  Gemini 流式响应处理器
 *
 *  Gemini 的 :streamGenerateContent?alt=sse 返回 SSE 帧，data 为 GenerateContentResponse：
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"..."}]}}], ...}
 *   data: {"candidates":[{"content":{"role":"model","parts":[{"text":"...","thought":true}]}}], ...}
 *   data: {"candidates":[{"finishReason":"STOP"}], "usageMetadata": {...}}
 *
 *  与 OpenAI 的差异：
 *  - 无 [DONE] 标记，流结束即完
 *  - thinking 内容以 thought: true 的 text part 内联返回
 *  - 工具调用以完整 functionCall part 返回（无增量参数分片）
 *  - usage 只在最后一个 chunk（或含 usageMetadata 的 chunk）出现
 *
 *  本文件不依赖 vscode（通过 sink 接口与 StreamReporter 解耦），可在纯 Node 单元测试中直接使用。
 *--------------------------------------------------------------------------------------------*/

import { GeminiGenerateContentResponse, GeminiUsageMetadata } from './geminiTypes';

/**
 * 流事件接收接口（StreamReporter 结构兼容）
 */
export interface GeminiStreamSink {
    bufferThinking(text: string): void;
    reportText(text: string): void;
    accumulateToolCall(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined,
        choiceIndex?: number
    ): void;
    flushToolCalls(choiceIndex?: number): void;
    discardToolCalls(choiceIndex?: number): void;
    setResponseId(id: string): void;
    heartbeat(): void;
    markStreamStarted(time: number): void;
    /** 思维链签名（可选，StreamReporter.bufferSignature 兼容） */
    bufferSignature?(content: string): void;
    /** functionCall part 签名（可选，StreamReporter.bufferToolCallSignature 兼容；key 优先 functionCall.id） */
    bufferToolCallSignature?(key: string, signature: string): void;
}

/** 取消检查（避免直接依赖 vscode.CancellationToken） */
export type GeminiCancellationCheck = () => boolean;

/**
 * 跨 chunk 的流状态
 * Gemini 的 functionCall 以完整 part 返回（无增量分片），并行调用表现为多个
 * functionCall part（同帧或跨帧）。每个 functionCall 需要本响应内唯一索引，
 * 否则累积器会把多个调用的参数拼接到同一 buffer 导致 JSON 无效或调用被丢弃。
 */
export interface GeminiStreamState {
    /** 每个 candidate 已分配的 functionCall 索引计数 */
    functionCallCounts: Map<number, number>;
}

export function createGeminiStreamState(): GeminiStreamState {
    return { functionCallCounts: new Map() };
}

export class GeminiStreamCancelledError extends Error {
    constructor() {
        super('Gemini stream cancelled');
        this.name = 'GeminiStreamCancelledError';
    }
}

export interface GeminiChunkResult {
    /** 本 chunk 是否包含可计数的流内容（首个有效 chunk 用于固定首流时间） */
    hasContent: boolean;
    usage?: GeminiUsageMetadata;
}

/** 判定 finishReason 是否需要丢弃未完成的工具调用 */
const DISCARD_FINISH_REASONS = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

/**
 * 处理单个 GenerateContentResponse chunk，把内容事件分发给 sink。
 * state 跨 chunk 共享（由 processGeminiStream / processGeminiJsonResponse 创建），
 * 为并行 functionCall 分配唯一索引。
 */
export function handleGeminiChunk(
    chunk: GeminiGenerateContentResponse,
    sink: GeminiStreamSink,
    state: GeminiStreamState = createGeminiStreamState()
): GeminiChunkResult {
    const result: GeminiChunkResult = { hasContent: false };

    if (!chunk || typeof chunk !== 'object') {
        return result;
    }

    if (chunk.error) {
        throw new Error(chunk.error.message || 'Gemini stream error');
    }

    if (typeof chunk.responseId === 'string' && chunk.responseId) {
        sink.setResponseId(chunk.responseId);
    }

    if (chunk.usageMetadata) {
        result.usage = chunk.usageMetadata;
    }

    for (const candidate of chunk.candidates || []) {
        const choiceIndex = candidate.index ?? 0;

        for (const part of candidate.content?.parts || []) {
            // 工具调用：Gemini 返回完整 functionCall，一次性累积
            if (part.functionCall?.name) {
                const functionCall = part.functionCall;

                // functionCall part 上的思维链签名必须随原 part 原样回传（Google 要求），
                // 单独缓冲，不混入思考签名缓冲。
                // 按 functionCall.id 键控（优先于函数名）：同名并行调用只有带签名的
                // 那个 part 需要回传签名，按名键控会给所有同名调用都加上签名。
                if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
                    sink.bufferToolCallSignature?.(functionCall.id ?? functionCall.name, part.thoughtSignature);
                }

                // 并行调用：每个 functionCall part 分配本响应内唯一索引，
                // 不能用 choiceIndex（并行调用同 candidate 会得到相同索引）
                const callIndex = state.functionCallCounts.get(choiceIndex) ?? 0;
                state.functionCallCounts.set(choiceIndex, callIndex + 1);
                sink.accumulateToolCall(
                    callIndex,
                    functionCall.id,
                    functionCall.name,
                    JSON.stringify(functionCall.args ?? {}),
                    choiceIndex
                );
                result.hasContent = true;
                continue;
            }

            // 思维链签名：可能独立成 part，也可能与 text 同 part 携带；只取签名，不跳过文本
            if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
                sink.bufferSignature?.(part.thoughtSignature);
            }

            // 思维链内容
            if (part.thought && typeof part.text === 'string' && part.text.length > 0) {
                sink.bufferThinking(part.text);
                result.hasContent = true;
                continue;
            }

            // 普通文本
            if (!part.thought && typeof part.text === 'string' && part.text.length > 0) {
                sink.reportText(part.text);
                result.hasContent = true;
                continue;
            }
        }

        // finishReason 处理：flush / discard 工具调用
        if (candidate.finishReason) {
            if (DISCARD_FINISH_REASONS.has(candidate.finishReason)) {
                sink.discardToolCalls(choiceIndex);
            } else {
                sink.flushToolCalls(choiceIndex);
            }
        } else if (result.hasContent) {
            // Gemini 无 content_block_stop 语义，工具调用到达即 flush，避免滞留
            sink.flushToolCalls(choiceIndex);
        }
    }

    return result;
}

export interface GeminiStreamResult {
    usage?: GeminiUsageMetadata;
    /** 首个有效 chunk 到达时间（ms），未收到内容时为 undefined */
    streamStartTime?: number;
    chunkCount: number;
}

/**
 * 处理 SSE 流（alt=sse）。
 * 返回聚合的 usage 与首流时间。
 */
export async function processGeminiStream(
    body: ReadableStream<Uint8Array>,
    sink: GeminiStreamSink,
    isCancelled: GeminiCancellationCheck
): Promise<GeminiStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = createGeminiStreamState();
    let buffer = '';
    let chunkCount = 0;
    let finalUsage: GeminiUsageMetadata | undefined;
    let streamStartTime: number | undefined;

    try {
        while (true) {
            if (isCancelled()) {
                throw new GeminiStreamCancelledError();
            }

            const { done, value } = await reader.read();
            if (isCancelled()) {
                throw new GeminiStreamCancelledError();
            }
            if (done) {
                break;
            }

            sink.heartbeat();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) {
                    continue;
                }

                const data = trimmed.substring(5).trim();
                if (!data) {
                    continue;
                }

                let chunk: GeminiGenerateContentResponse;
                try {
                    chunk = JSON.parse(data) as GeminiGenerateContentResponse;
                } catch {
                    // 非 JSON 行（心跳/注释），忽略
                    continue;
                }

                const chunkResult = handleGeminiChunk(chunk, sink, state);
                chunkCount++;

                if (chunkResult.hasContent && streamStartTime === undefined) {
                    streamStartTime = Date.now();
                    sink.markStreamStarted(streamStartTime);
                }

                if (chunkResult.usage) {
                    finalUsage = chunkResult.usage;
                }
            }
        }

        // 处理缓冲区中剩余的最后一行（部分服务器不发送末尾换行）
        const tail = buffer.trim();
        if (tail.startsWith('data:')) {
            const data = tail.substring(5).trim();
            if (data) {
                try {
                    const chunk = JSON.parse(data) as GeminiGenerateContentResponse;
                    const chunkResult = handleGeminiChunk(chunk, sink, state);
                    chunkCount++;
                    if (chunkResult.hasContent && streamStartTime === undefined) {
                        streamStartTime = Date.now();
                        sink.markStreamStarted(streamStartTime);
                    }
                    if (chunkResult.usage) {
                        finalUsage = chunkResult.usage;
                    }
                } catch {
                    // 忽略不完整的尾部帧
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    if (isCancelled()) {
        throw new GeminiStreamCancelledError();
    }

    return { usage: finalUsage, streamStartTime, chunkCount };
}

/**
 * 处理非流式 JSON 响应（部分网关忽略 alt=sse 直接返回完整 JSON）
 */
export function processGeminiJsonResponse(bodyText: string, sink: GeminiStreamSink): GeminiStreamResult {
    const parsed = JSON.parse(bodyText) as GeminiGenerateContentResponse;
    const chunkResult = handleGeminiChunk(parsed, sink, createGeminiStreamState());
    const streamStartTime = chunkResult.hasContent ? Date.now() : undefined;
    if (streamStartTime !== undefined) {
        sink.markStreamStarted(streamStartTime);
    }
    return { usage: chunkResult.usage, streamStartTime, chunkCount: 1 };
}
