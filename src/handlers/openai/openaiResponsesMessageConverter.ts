import * as vscode from 'vscode';
import OpenAI from 'openai';

import type { ModelConfig } from '../../types/sharedTypes';
import { Logger } from '../../utils/runtime/logger';
import { sanitizeToolSchema } from '../../utils/text/schemaSanitizer';
import { decodeStatefulMarker } from '../statefulMarker';
import { CustomDataPartMimeTypes, GCMP_SYSTEM_MESSAGE_NAME } from '../types';
import type { OpenAIHandler } from '../openaiHandler';
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
}

interface EncryptedReasoningItem {
    encryptedContent: string;
    reasoningId?: string;
}

export class OpenAIResponsesMessageConverter {
    constructor(
        private readonly handler: OpenAIHandler,
        private readonly displayName: string
    ) {}

    convertMessagesToOpenAIResponses(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): { systemMessage: string; messages: ResponseInputItem[] } {
        const out: ResponseInputItem[] = [];
        let systemMessage = '';
        const callIdResolver = new OpenAIResponsesCallIdResolver();

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

            for (const [partIndex, part] of message.content.entries()) {
                if (part instanceof vscode.LanguageModelThinkingPart) {
                    const metadata = (part as { metadata?: OpenAIResponsesThinkingMetadata }).metadata;
                    if (metadata?.redactedData) {
                        encryptedReasonings.push({
                            encryptedContent: metadata.redactedData,
                            reasoningId: metadata.reasoningId
                        });
                    } else {
                        const content = Array.isArray(part.value) ? part.value.join('') : part.value;
                        if (content.trim()) {
                            thinkingParts.push(content);
                        }
                    }
                } else if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (
                    part instanceof vscode.LanguageModelDataPart &&
                    this.handler.isImageMimeType(part.mimeType)
                ) {
                    if (modelConfig?.capabilities?.imageInput === true) {
                        imageParts.push(part);
                    } else {
                        textParts.push('[Image]');
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
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
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
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
                // ThinkingPart 可能被 VS Code 部分或全部剥离：与 StatefulMarker 合并并去重恢复
                const mergedEncryptedReasonings = this.mergeEncryptedReasonings(
                    encryptedReasonings,
                    this.getEncryptedReasoningFromMarker(message.content)
                );
                for (const { encryptedContent, reasoningId } of mergedEncryptedReasonings) {
                    const reasoningItem: Record<string, unknown> = {
                        type: 'reasoning' as const,
                        summary: [],
                        encrypted_content: encryptedContent
                    };
                    if (reasoningId) {
                        reasoningItem.id = reasoningId;
                    }
                    out.push(reasoningItem as unknown as ResponseReasoningItem);
                }

                const assistantText = joinedText || joinedThinking;
                if (assistantText) {
                    out.push({
                        type: 'message' as const,
                        role: 'assistant' as const,
                        status: 'completed' as const,
                        content: [{ type: 'output_text' as const, text: assistantText }]
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

        const lastItem = out.at(-1);
        if (lastItem && typeof lastItem === 'object' && 'type' in lastItem) {
            const item = lastItem as unknown as Record<string, unknown>;
            if (item.type === 'message' && item.role === 'user') {
                item.status = 'incomplete';
                Logger.trace(`${this.displayName} Responses API: set the last user message status to incomplete`);
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
                part instanceof vscode.LanguageModelDataPart &&
                part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                part.data instanceof Uint8Array
            ) {
                const marker = decodeStatefulMarker(part.data)?.marker;
                if (marker?.sdkMode === 'openai-responses' && marker.encryptedReasoning?.length) {
                    return marker.encryptedReasoning;
                }
            }
        }
        return [];
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
            if (item.reasoningId) {
                extractedIndicesById.set(item.reasoningId, index);
            }
            extractedIndicesByContent.set(item.encryptedContent, index);
        }

        const pushMergedItem = (item: EncryptedReasoningItem) => {
            if ((item.reasoningId && seenIds.has(item.reasoningId)) || seenContents.has(item.encryptedContent)) {
                return;
            }

            merged.push(item);
            if (item.reasoningId) {
                seenIds.add(item.reasoningId);
            }
            seenContents.add(item.encryptedContent);
        };

        for (const item of restored) {
            const matchedExtractedIndex =
                (item.reasoningId ? extractedIndicesById.get(item.reasoningId) : undefined) ??
                extractedIndicesByContent.get(item.encryptedContent);

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
            if (item instanceof vscode.LanguageModelTextPart) {
                texts.push(item.value);
            } else if (item instanceof vscode.LanguageModelDataPart && this.handler.isImageMimeType(item.mimeType)) {
                texts.push('[Image]');
            }
        }
        return texts.join('\n');
    }
}
