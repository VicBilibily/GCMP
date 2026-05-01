/*---------------------------------------------------------------------------------------------
 *  响应流转换器
 *  将 AI SDK 流转换为 VS Code LanguageModelResponsePart 流
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { StreamTextResult } from 'ai';
import type { AiSdkToolSet } from './toolConverter';
import { Logger } from '../../utils/logger';

interface ConvertStreamOptions {
    requestId?: string;
}

/** 生成唯一 thinking chain ID，用于关联同一思维链的多个 ThinkingPart */
function createThinkingId(): string {
    return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 构建带 requestId 的日志前缀，便于追踪单次请求的完整流生命周期 */
function createStreamLogPrefix(requestId?: string): string {
    return requestId ? `[StreamConverter][${requestId}]` : '[StreamConverter]';
}

/** 安全序列化任意值为 JSON 字符串，失败降级为 String() */
function toJsonLog(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** 将工具调用参数安全转为 object，满足 LanguageModelToolCallPart 构造函数要求 */
function toToolInputObject(args: unknown): object {
    return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

/**
 * 将 AI SDK fullStream 转换为 VS Code LanguageModelResponsePart 异步生成器
 *
 * 处理流式 reasoning / text-delta / tool-call / error 等 chunk 类型，
 * 维护 thinking chain 状态并在适当时机关闭，最终等待流完成并输出延迟工具调用。
 */
export async function* convertStream<TOOLS extends AiSdkToolSet>(
    stream: StreamTextResult<TOOLS, unknown>,
    token: vscode.CancellationToken,
    options?: ConvertStreamOptions
): AsyncGenerator<vscode.LanguageModelResponsePart> {
    const logPrefix = createStreamLogPrefix(options?.requestId);

    try {
        const seenToolCallIds = new Set<string>();
        let currentThinkingId: string | undefined;
        let pendingThinkingSignature: string | undefined;
        const chunkCounts = {
            reasoning: 0,
            reasoningSignature: 0,
            redactedReasoning: 0,
            textDelta: 0,
            toolCall: 0,
            error: 0,
            ignored: 0,
            reasoningChars: 0,
            textChars: 0,
            replayedToolCalls: 0
        };

        Logger.trace(`${logPrefix} Starting stream conversion`);

        const closeThinkingChain = (reason: string): vscode.LanguageModelThinkingPart | undefined => {
            if (!currentThinkingId && !pendingThinkingSignature) {
                return undefined;
            }

            const thinkingId = currentThinkingId;
            const metadata = pendingThinkingSignature ? { signature: pendingThinkingSignature } : undefined;
            const part = new vscode.LanguageModelThinkingPart('', currentThinkingId, metadata);
            currentThinkingId = undefined;
            pendingThinkingSignature = undefined;
            Logger.trace(
                `${logPrefix} Closed thinking chain: ${toJsonLog({
                    reason,
                    thinkingId,
                    hasSignature: Boolean(metadata?.signature)
                })}`
            );
            return part;
        };

        for await (const chunk of stream.fullStream) {
            if (token.isCancellationRequested) {
                const closingPart = closeThinkingChain('cancellation');
                if (closingPart) {
                    yield closingPart as unknown as vscode.LanguageModelResponsePart;
                }
                Logger.info(`${logPrefix} Request cancelled`);
                return;
            }

            switch (chunk.type) {
                case 'reasoning': {
                    chunkCounts.reasoning += 1;
                    chunkCounts.reasoningChars += chunk.textDelta.length;
                    currentThinkingId ??= createThinkingId();
                    Logger.trace(
                        `${logPrefix} Received reasoning chunk: ${toJsonLog({
                            chars: chunk.textDelta.length,
                            thinkingId: currentThinkingId
                        })}`
                    );
                    yield new vscode.LanguageModelThinkingPart(
                        chunk.textDelta,
                        currentThinkingId
                    ) as unknown as vscode.LanguageModelResponsePart;
                    break;
                }

                case 'reasoning-signature': {
                    chunkCounts.reasoningSignature += 1;
                    pendingThinkingSignature = chunk.signature;
                    Logger.trace(`${logPrefix} Received reasoning signature chunk`);
                    break;
                }

                case 'redacted-reasoning': {
                    chunkCounts.redactedReasoning += 1;
                    currentThinkingId ??= createThinkingId();
                    Logger.trace(
                        `${logPrefix} Received redacted reasoning chunk: ${toJsonLog({
                            thinkingId: currentThinkingId,
                            hasPendingSignature: Boolean(pendingThinkingSignature)
                        })}`
                    );
                    yield new vscode.LanguageModelThinkingPart('', currentThinkingId, {
                        redactedData: chunk.data,
                        ...(pendingThinkingSignature ? { signature: pendingThinkingSignature } : {})
                    }) as unknown as vscode.LanguageModelResponsePart;
                    pendingThinkingSignature = undefined;
                    break;
                }

                case 'text-delta': {
                    chunkCounts.textDelta += 1;
                    chunkCounts.textChars += chunk.textDelta.length;
                    const closingPart = closeThinkingChain('text-delta');
                    if (closingPart) {
                        yield closingPart as unknown as vscode.LanguageModelResponsePart;
                    }
                    Logger.trace(
                        `${logPrefix} Received text delta chunk: ${toJsonLog({
                            chars: chunk.textDelta.length
                        })}`
                    );
                    yield new vscode.LanguageModelTextPart(chunk.textDelta);
                    break;
                }

                case 'tool-call': {
                    chunkCounts.toolCall += 1;
                    const closingPart = closeThinkingChain('tool-call');
                    if (closingPart) {
                        yield closingPart as unknown as vscode.LanguageModelResponsePart;
                    }
                    seenToolCallIds.add(chunk.toolCallId);
                    Logger.trace(
                        `${logPrefix} Received tool call chunk: ${toJsonLog({
                            toolCallId: chunk.toolCallId,
                            toolName: chunk.toolName
                        })}`
                    );
                    yield new vscode.LanguageModelToolCallPart(
                        chunk.toolCallId,
                        chunk.toolName,
                        toToolInputObject(chunk.args)
                    );
                    break;
                }

                case 'error': {
                    chunkCounts.error += 1;
                    const errorDetail = chunk.error;
                    Logger.error(`${logPrefix} Stream error chunk: ${toJsonLog(errorDetail)}`);
                    throw errorDetail instanceof Error
                        ? errorDetail
                        : new Error(typeof errorDetail === 'string' ? errorDetail : JSON.stringify(errorDetail));
                }

                default:
                    chunkCounts.ignored += 1;
                    Logger.trace(`${logPrefix} Ignored stream chunk type: ${chunk.type}`);
                    break;
            }
        }

        const closingPart = closeThinkingChain('stream-end');
        if (closingPart) {
            yield closingPart as unknown as vscode.LanguageModelResponsePart;
        }

        // 2. 等待流完成并检查错误
        // stream.finish_reason 可能包含错误信息
        const finishReason = await stream.finishReason;
        if (finishReason === 'error') {
            Logger.error(`${logPrefix} Stream finished with error reason`);
            throw new Error('API 返回错误响应，请检查 API Key 和模型配置');
        }

        // 3. 处理工具调用（如果有）
        const toolCalls = await stream.toolCalls;

        if (toolCalls && toolCalls.length > 0) {
            for (const toolCall of toolCalls) {
                // 检查是否取消
                if (token.isCancellationRequested) {
                    return;
                }

                if (seenToolCallIds.has(toolCall.toolCallId)) {
                    chunkCounts.replayedToolCalls += 1;
                    continue;
                }

                // 生成工具调用响应部分
                Logger.trace(
                    `${logPrefix} Emitting deferred tool call: ${toJsonLog({
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName
                    })}`
                );
                yield new vscode.LanguageModelToolCallPart(
                    toolCall.toolCallId,
                    toolCall.toolName,
                    toToolInputObject(toolCall.args)
                );
            }
        }

        Logger.trace(
            `${logPrefix} Stream conversion summary: ${toJsonLog({
                finishReason,
                chunkCounts,
                streamedToolCalls: seenToolCallIds.size,
                resolvedToolCalls: toolCalls?.length ?? 0
            })}`
        );
    } catch (error) {
        // 详细记录错误信息
        Logger.error(`${logPrefix} Stream conversion error:`, error);

        // 尝试提取更详细的错误信息
        if (error instanceof Error) {
            Logger.error(`${logPrefix} Error message: ${error.message}`);
            Logger.error(`${logPrefix} Error stack: ${error.stack}`);

            // 检查是否是 API 错误（通常包含响应信息）
            const errorObj = error as unknown as Record<string, unknown>;
            if (errorObj.response) {
                Logger.error(`${logPrefix} API response: ${JSON.stringify(errorObj.response)}`);
            }
            if (errorObj.statusCode) {
                Logger.error(`${logPrefix} Status code: ${errorObj.statusCode}`);
            }
            if (errorObj.body) {
                Logger.error(`${logPrefix} Response body: ${JSON.stringify(errorObj.body)}`);
            }
        }

        throw error;
    }
}
