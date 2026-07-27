import * as vscode from 'vscode';
import OpenAI from 'openai';

import type { ModelConfig } from '../../types/sharedTypes';
import { Logger } from '../../utils/runtime/logger';
import { sanitizeToolSchema } from '../../utils/text/schemaSanitizer';
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
            const role = this.mapRole(message.role);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: Array<{ id: string; name: string; args: string }> = [];
            const toolResults: Array<{ callId: string; content: string }> = [];
            const thinkingParts: string[] = [];
            const encryptedReasonings: Array<{ encryptedContent: string; reasoningId?: string }> = [];

            for (const [partIndex, part] of message.content.entries()) {
                if (part instanceof vscode.LanguageModelTextPart) {
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
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    const metadata = (part as unknown as { metadata?: OpenAIResponsesThinkingMetadata }).metadata;
                    if (metadata?.redactedData) {
                        encryptedReasonings.push({
                            encryptedContent: metadata.redactedData,
                            reasoningId: metadata.reasoningId
                        });
                    } else {
                        const content = Array.isArray(part.value) ? part.value.join('') : part.value;
                        thinkingParts.push(content);
                    }
                }
            }

            const joinedText = textParts.join('').trim();
            const joinedThinking = thinkingParts.join('').trim();

            if (role === 'assistant') {
                for (const { encryptedContent, reasoningId } of encryptedReasonings) {
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
