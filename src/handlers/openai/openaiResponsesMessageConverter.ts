import * as vscode from 'vscode';
import OpenAI from 'openai';

import type { ModelConfig } from '../../types/sharedTypes';
import { Logger } from '../../utils/runtime/logger';
import { sanitizeToolSchema } from '../../utils/text/schemaSanitizer';
import { decodeStatefulMarker } from '../statefulMarker';
import { CustomDataPartMimeTypes, GCMP_SYSTEM_MESSAGE_NAME } from '../types';
import type { OpenAIHandler } from '../openaiHandler';
import {
    isEncryptedReasoningOriginMatch,
    isResponsesReasoningId,
    shouldReplayEncryptedReasoning,
    shouldReplayPlainThinking
} from './encryptedReasoning';
import { OpenAIResponsesCallIdResolver } from './openaiResponsesCallIdResolver';

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseInputMessageItem = OpenAI.Responses.ResponseInputMessageItem;
type ResponseInputText = OpenAI.Responses.ResponseInputText;
type ResponseInputImage = OpenAI.Responses.ResponseInputImage;
type ResponseReasoningItem = OpenAI.Responses.ResponseReasoningItem;
type ResponseFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;
type ResponseFunctionToolCallOutputItem = OpenAI.Responses.ResponseFunctionToolCallOutputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;

interface OpenAIResponsesThinkingMetadata {
    redactedData?: string;
    reasoningId?: string;
    provider?: string;
    modelId?: string;
}

interface EncryptedReasoningItem {
    encryptedContent: string;
    reasoningId?: string;
    provider?: string;
    modelId?: string;
}

interface RequestOrigin {
    provider: string;
    modelId: string;
}

function isDataPart(part: unknown): part is vscode.LanguageModelDataPart {
    return typeof part === 'object' && part !== null && 'mimeType' in part && 'data' in part;
}

function isTextPart(part: unknown): part is vscode.LanguageModelTextPart {
    return typeof part === 'object' && part !== null && 'value' in part && !('mimeType' in part);
}

function isToolCallPart(part: unknown): part is vscode.LanguageModelToolCallPart {
    return typeof part === 'object' && part !== null && 'callId' in part && 'name' in part && 'input' in part;
}

function isToolResultPart(part: unknown): part is vscode.LanguageModelToolResultPart {
    return typeof part === 'object' && part !== null && 'callId' in part && 'content' in part;
}

export class OpenAIResponsesMessageConverter {
    constructor(
        private readonly handler: OpenAIHandler,
        private readonly displayName: string
    ) {}

    convertMessagesToOpenAIResponses(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig: ModelConfig | undefined,
        requestOrigin: RequestOrigin
    ): { systemMessage: string; messages: ResponseInputItem[] } {
        const out: ResponseInputItem[] = [];
        let systemMessage = '';
        const callIdResolver = new OpenAIResponsesCallIdResolver();
        // 历史密文回放：有密文就回传（不限 GPT）；extraBody.include 接管为关闭时不回传。
        // 未传 modelConfig 时保持既有回放行为（内部调用/测试缺省路径）。
        const replayEncryptedReasoning =
            modelConfig === undefined || shouldReplayEncryptedReasoning(modelConfig.extraBody);
        // GPT 端点的历史 reasoning 只能走密文/原样回放，不能回传明文摘要。
        // 明文通道仅在本条消息没有发出密文项时启用，避免把 DeepSeek 等无密文历史误关掉。
        const replayPlainThinking = shouldReplayPlainThinking({
            requestModel: modelConfig?.model || modelConfig?.id || '',
            extraBody: modelConfig?.extraBody
        });
        const currentOrigin = requestOrigin;

        for (const [messageIndex, message] of messages.entries()) {
            let role = this.mapRole(message.role);
            // GCMP 构造的系统提示词用 name=GCMP_SYSTEM_MESSAGE_NAME 标记，转为 Responses instructions
            if (role === 'user' && message.name === GCMP_SYSTEM_MESSAGE_NAME) {
                role = 'system';
            }
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: Array<{ id: string; name: string; args: string }> = [];
            const toolResults: Array<{ callId: string; content: string }> = [];
            const thinkingParts: string[] = [];
            const encryptedReasonings: EncryptedReasoningItem[] = [];
            const markerReasonings = this.getEncryptedReasoningFromMarker(message.content);
            const markerReasoning = markerReasonings[0];

            for (const [partIndex, part] of message.content.entries()) {
                if (part instanceof vscode.LanguageModelThinkingPart) {
                    const metadata = (part as { metadata?: OpenAIResponsesThinkingMetadata }).metadata;
                    // 密文仅在回放启用时收集；回放关闭（如 include 被接管为 null）时
                    // 密文丢弃，但可见摘要正文仍按普通思考文本保留——正文为空则整个 reasoning 块不再传递
                    if (metadata?.redactedData && replayEncryptedReasoning) {
                        encryptedReasonings.push({
                            encryptedContent: metadata.redactedData,
                            reasoningId: metadata.reasoningId,
                            provider: metadata.provider ?? markerReasoning?.provider,
                            modelId: metadata.modelId ?? markerReasoning?.modelId
                        });
                    } else {
                        const content = Array.isArray(part.value) ? part.value.join('') : part.value;
                        if (content.trim()) {
                            thinkingParts.push(content);
                        }
                    }
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (isDataPart(part) && this.handler.isImageMimeType(part.mimeType)) {
                    if (modelConfig?.capabilities?.imageInput === true) {
                        imageParts.push(part);
                    } else {
                        textParts.push('[Image]');
                    }
                } else if (isToolCallPart(part)) {
                    let args = '{}';
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = '{}';
                    }
                    const id = callIdResolver.resolveToolCallId({
                        callId: part.callId,
                        messageIndex,
                        partIndex,
                        name: part.name,
                        argumentsJson: args
                    });
                    toolCalls.push({ id, name: part.name, args });
                } else if (isToolResultPart(part)) {
                    const callId = callIdResolver.resolveToolResultCallId({ callId: part.callId });
                    const content = this.collectToolResultText(part);
                    if (callId) {
                        toolResults.push({ callId, content });
                    }
                }
            }

            const joinedText = textParts.join('').trim();
            const joinedThinking = thinkingParts.join('').trim();

            if (role === 'assistant') {
                let emittedEncrypted = false;
                if (replayEncryptedReasoning) {
                    // 密文通道：回传密文 reasoning 项；可见 ThinkingPart 为展示用摘要，模型不消费，不回传
                    // ThinkingPart 可能被 VS Code 部分或全部剥离：与 StatefulMarker 合并并去重恢复
                    const mergedEncryptedReasonings = this.mergeEncryptedReasonings(
                        encryptedReasonings,
                        markerReasonings
                    ).filter(item => isEncryptedReasoningOriginMatch(item, currentOrigin));
                    for (const { encryptedContent, reasoningId } of mergedEncryptedReasonings) {
                        const reasoningItem: Record<string, unknown> = {
                            type: 'reasoning' as const,
                            summary: [],
                            encrypted_content: encryptedContent
                        };
                        if (isResponsesReasoningId(reasoningId)) {
                            reasoningItem.id = reasoningId;
                        }
                        out.push(reasoningItem as unknown as ResponseReasoningItem);
                        emittedEncrypted = true;
                    }
                }
                if (!emittedEncrypted && replayPlainThinking) {
                    // 明文通道（DeepSeek 等无密文端点）：思维链文本以明文 reasoning 项回传，
                    // 端点将明文 content 归并到相邻 assistant 消息
                    const markerThinking = (this.getCompleteThinkingFromMarker(message.content) ?? '').trim();
                    // 可见 ThinkingPart 内容优先；被完全剥离时回退 marker 持久化文本
                    const plainThinking = joinedThinking || markerThinking;
                    if (plainThinking) {
                        out.push({
                            type: 'reasoning' as const,
                            summary: [],
                            content: [{ type: 'reasoning_text' as const, text: plainThinking }]
                        } as unknown as ResponseReasoningItem);
                    }
                }

                if (joinedText) {
                    out.push({
                        type: 'message' as const,
                        role: 'assistant' as const,
                        status: 'completed' as const,
                        content: [{ type: 'output_text' as const, text: joinedText }]
                    } as unknown as ResponseInputMessageItem);
                }

                for (const toolCall of toolCalls) {
                    if (!toolCall.name || toolCall.name.trim() === '') {
                        Logger.warn(`${this.displayName} Responses API: skipping tool call with empty name`);
                        continue;
                    }
                    out.push({
                        type: 'function_call' as const,
                        call_id: toolCall.id,
                        name: toolCall.name,
                        arguments: toolCall.args,
                        status: 'completed' as const
                    } as unknown as ResponseFunctionToolCall);
                }
            }

            for (const toolResult of toolResults) {
                if (!toolResult.callId) {
                    continue;
                }
                out.push({
                    type: 'function_call_output' as const,
                    call_id: toolResult.callId,
                    output: toolResult.content || '',
                    status: 'completed' as const
                } as unknown as ResponseFunctionToolCallOutputItem);
            }

            if (role === 'user') {
                const contentArray: Array<ResponseInputText | ResponseInputImage> = [];
                if (joinedText) {
                    contentArray.push({ type: 'input_text' as const, text: joinedText });
                }
                for (const imagePart of imageParts) {
                    contentArray.push({
                        type: 'input_image' as const,
                        image_url: this.handler.createDataUrl(imagePart),
                        detail: 'auto' as const
                    });
                }
                if (contentArray.length > 0) {
                    out.push({
                        type: 'message' as const,
                        role: 'user' as const,
                        status: 'completed' as const,
                        content: contentArray
                    } as unknown as ResponseInputMessageItem);
                }
            }

            if (role === 'system' && joinedText) {
                systemMessage = joinedText;
            }
        }

        return { systemMessage, messages: out };
    }

    /**
     * 从消息内容的 StatefulMarker 中提取加密推理项（openai-responses 格式）。
     * 仅当 marker 由 openai-responses 模式产生时才返回，避免跨模式误用。
     */
    private getEncryptedReasoningFromMarker(
        content: vscode.LanguageModelChatMessage['content']
    ): EncryptedReasoningItem[] {
        for (const part of content) {
            if (
                isDataPart(part) &&
                part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                part.data instanceof Uint8Array
            ) {
                const marker = decodeStatefulMarker(part.data)?.marker;
                if (marker?.sdkMode === 'openai-responses' && marker.encryptedReasoning?.length) {
                    return marker.encryptedReasoning.map(item => ({
                        ...item,
                        provider: marker.provider,
                        modelId: marker.modelId
                    }));
                }
            }
        }
        return [];
    }

    /**
     * 从 StatefulMarker 读取完整思考摘要文本（completeThinking）。
     * 用于加密回放关闭场景：密文不再回传时，可见 ThinkingPart 若已被 VS Code 剥离，
     * 回退到 marker 中持久化的摘要文本，避免思考上下文整体丢失。
     */
    private getCompleteThinkingFromMarker(content: vscode.LanguageModelChatMessage['content']): string | undefined {
        for (const part of content) {
            if (
                isDataPart(part) &&
                part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                part.data instanceof Uint8Array
            ) {
                const marker = decodeStatefulMarker(part.data)?.marker;
                if (marker?.sdkMode === 'openai-responses' && marker.completeThinking?.trim()) {
                    return marker.completeThinking;
                }
            }
        }
        return undefined;
    }

    /**
     * 合并 ThinkingPart 与 StatefulMarker 中的加密推理项，处理 VS Code 历史序列化导致的“部分剥离”场景。
     *
     * 去重规则：
     * - 优先按 reasoningId 去重（若存在）
     * - 同时按 encryptedContent 去重，避免同一 item 在 ThinkingPart / marker 间重复
     */
    private mergeEncryptedReasonings(
        extracted: EncryptedReasoningItem[],
        restored: EncryptedReasoningItem[]
    ): EncryptedReasoningItem[] {
        if (restored.length === 0) {
            return extracted;
        }

        const merged: EncryptedReasoningItem[] = [];
        const extractedIndicesById = new Map<string, number>();
        const extractedIndicesByContent = new Map<string, number>();
        const usedExtractedIndices = new Set<number>();
        const seenIds = new Set<string>();
        const seenContents = new Set<string>();

        for (const [index, item] of extracted.entries()) {
            const originKey = this.getEncryptedReasoningOriginKey(item);
            if (item.reasoningId) {
                extractedIndicesById.set(`${originKey}:${item.reasoningId}`, index);
            }
            extractedIndicesByContent.set(`${originKey}:${item.encryptedContent}`, index);
        }

        const pushMergedItem = (item: EncryptedReasoningItem) => {
            const originKey = this.getEncryptedReasoningOriginKey(item);
            const idKey = item.reasoningId ? `${originKey}:${item.reasoningId}` : undefined;
            const contentKey = `${originKey}:${item.encryptedContent}`;
            if ((idKey && seenIds.has(idKey)) || seenContents.has(contentKey)) {
                return;
            }

            merged.push(item);
            if (idKey) {
                seenIds.add(idKey);
            }
            seenContents.add(contentKey);
        };

        for (const item of restored) {
            const originKey = this.getEncryptedReasoningOriginKey(item);
            const matchedExtractedIndex =
                (item.reasoningId ? extractedIndicesById.get(`${originKey}:${item.reasoningId}`) : undefined) ??
                extractedIndicesByContent.get(`${originKey}:${item.encryptedContent}`);

            if (matchedExtractedIndex !== undefined) {
                usedExtractedIndices.add(matchedExtractedIndex);
                pushMergedItem(extracted[matchedExtractedIndex]);
                continue;
            }

            pushMergedItem(item);
        }

        for (const [index, item] of extracted.entries()) {
            if (usedExtractedIndices.has(index)) {
                continue;
            }
            pushMergedItem(item);
        }

        return merged;
    }

    private getEncryptedReasoningOriginKey(item: EncryptedReasoningItem): string {
        return item.provider ?? '';
    }

    convertToolsToResponses(tools: readonly vscode.LanguageModelChatTool[]): FunctionTool[] {
        return tools.map(tool => {
            const functionTool: FunctionTool = {
                type: 'function',
                name: tool.name,
                description: tool.description || null,
                parameters: null,
                strict: false
            };

            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    functionTool.parameters = sanitizeToolSchema(tool.inputSchema as Record<string, unknown>);
                } else {
                    functionTool.parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                functionTool.parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return functionTool;
        });
    }

    filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        const coreParams = new Set(['model', 'input', 'stream', 'tools']);
        const filtered: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(extraBody)) {
            if (!coreParams.has(key)) {
                filtered[key] = value == null ? undefined : value;
            }
        }

        return filtered;
    }

    private mapRole(role: number): 'user' | 'assistant' | 'system' {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.User:
                return 'user';
            case vscode.LanguageModelChatMessageRole.Assistant:
                return 'assistant';
            case vscode.LanguageModelChatMessageRole.System:
                return 'system';
            default:
                return 'user';
        }
    }

    private collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
        if (!part.content || part.content.length === 0) {
            return '';
        }

        const texts: string[] = [];
        for (const item of part.content) {
            if (isTextPart(item)) {
                texts.push(item.value);
            } else if (isDataPart(item) && this.handler.isImageMimeType(item.mimeType)) {
                texts.push('[Image]');
            }
        }
        return texts.join('\n');
    }
}
