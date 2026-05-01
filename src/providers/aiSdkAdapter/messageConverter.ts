/*---------------------------------------------------------------------------------------------
 *  消息转换器
 *  将 VS Code LanguageModelChatMessage 转换为 AI SDK 格式
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CoreMessage, TextPart, ImagePart, ToolCallPart, ToolResultPart } from 'ai';
import { Logger } from '../../utils/logger';
import { decodeStatefulMarker } from '../../handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../../handlers/types';

/**
 * AI SDK 未导出的 ReasoningPart，本地补定义
 */
interface ReasoningPart {
    type: 'reasoning';
    text: string;
    signature?: string;
}

/**
 * AI SDK 未导出的 RedactedReasoningPart，本地补定义
 */
interface RedactedReasoningPart {
    type: 'redacted-reasoning';
    data: string;
}

/**
 * 用户消息内容部件
 */
type UserContentPart = TextPart | ImagePart;

/**
 * 助手消息内容部件
 */
type AssistantContentPart = TextPart | ReasoningPart | RedactedReasoningPart | ToolCallPart;

/**
 * 工具调用信息（提取自 ToolCallPart，用于跨消息关联）
 */
interface ToolCallInfo {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
}

/**
 * 工具结果信息（提取自 ToolResultPart，用于跨消息关联）
 */
interface ToolResultInfo {
    toolCallId: string;
    toolName: string;
    result: unknown;
}

/**
 * 消息内容转换结果
 */
interface ConvertedContent {
    userContent: UserContentPart[];
    assistantContent: AssistantContentPart[];
    toolCalls: ToolCallInfo[];
    toolResults: ToolResultInfo[];
}

/**
 * VS Code 消息角色枚举
 * LanguageModelChatMessageRole: User = 1, Assistant = 2, System = 3
 */
const VSCODE_ROLE = {
    USER: 1,
    ASSISTANT: 2,
    SYSTEM: 3
} as const;

/**
 * 转换 VS Code 消息数组为 AI SDK 格式
 */
export function convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): CoreMessage[] {
    const toolNameByCallId = new Map<string, string>();
    return messages.flatMap(msg => convertMessage(msg, toolNameByCallId));
}

/**
 * 转换 VS Code 角色枚举为 AI SDK 字符串格式
 */
function convertRole(role: number): 'user' | 'assistant' | 'system' {
    switch (role) {
        case VSCODE_ROLE.USER:
            return 'user';
        case VSCODE_ROLE.ASSISTANT:
            return 'assistant';
        case VSCODE_ROLE.SYSTEM:
            return 'system';
        default:
            // 未知角色默认为 user
            return 'user';
    }
}

/**
 * 转换单条消息
 * 根据角色分别构建 user（含 tool-result）/ assistant（含 tool-call） / system 消息，
 * 并通过 toolNameByCallId 在多轮对话中跨消息关联工具调用名称。
 */
function convertMessage(msg: vscode.LanguageModelChatMessage, toolNameByCallId: Map<string, string>): CoreMessage[] {
    const content = convertMessageContent(msg, toolNameByCallId);
    const role = convertRole(msg.role);

    if (role === 'assistant') {
        for (const toolCall of content.toolCalls) {
            toolNameByCallId.set(toolCall.toolCallId, toolCall.toolName);
        }

        if (content.assistantContent.length === 0) {
            return [];
        }

        if (content.assistantContent.length === 1 && content.assistantContent[0].type === 'text') {
            return [
                {
                    role,
                    content: content.assistantContent[0].text
                }
            ];
        }

        return [
            {
                role,
                content: content.assistantContent
            }
        ];
    }

    if (role === 'user') {
        const converted: CoreMessage[] = [];

        if (content.userContent.length > 0) {
            if (content.userContent.length === 1 && content.userContent[0].type === 'text') {
                converted.push({ role, content: content.userContent[0].text });
            } else {
                converted.push({ role, content: content.userContent });
            }
        }

        if (content.toolResults.length > 0) {
            converted.push({
                role: 'tool',
                content: content.toolResults.map(toolResult => ({
                    type: 'tool-result' as const,
                    toolCallId: toolResult.toolCallId,
                    toolName: toolResult.toolName,
                    result: toolResult.result
                }))
            });
        }

        return converted;
    }

    // system 消息只支持纯文本
    const textPart = content.userContent.find(p => p.type === 'text');
    if (!textPart) {
        return [];
    }

    return [
        {
            role,
            content: textPart.text
        }
    ];
}

/**
 * 解析消息内容为统一结构，兼容字符串、单 Part、数组三种输入形态
 */
function convertMessageContent(
    msg: vscode.LanguageModelChatMessage,
    toolNameByCallId: Map<string, string>
): ConvertedContent {
    // 情况 1: 字符串内容
    if (typeof msg.content === 'string') {
        const text = String(msg.content).trim();
        return {
            userContent: text ? [{ type: 'text', text }] : [],
            assistantContent: text ? [{ type: 'text', text }] : [],
            toolCalls: [],
            toolResults: []
        };
    }

    // 情况 2: 单个文本部分
    if (msg.content instanceof vscode.LanguageModelTextPart) {
        const text = msg.content.value.trim();
        return {
            userContent: text ? [{ type: 'text', text }] : [],
            assistantContent: text ? [{ type: 'text', text }] : [],
            toolCalls: [],
            toolResults: []
        };
    }

    // 情况 3: 数组内容（多模态）
    if (Array.isArray(msg.content)) {
        return convertContentArray(msg.content, toolNameByCallId);
    }

    // 默认：转为字符串
    const text = String(msg.content).trim();
    return {
        userContent: text ? [{ type: 'text', text }] : [],
        assistantContent: text ? [{ type: 'text', text }] : [],
        toolCalls: [],
        toolResults: []
    };
}

/**
 * 遍历 Part 数组，将 TextPart / ThinkingPart / ToolCallPart / ToolResultPart / DataPart（图片）
 * 分类归集为 userContent、assistantContent、toolCalls、toolResults
 */
function convertContentArray(
    parts: readonly (
        | vscode.LanguageModelTextPart
        | vscode.LanguageModelToolCallPart
        | vscode.LanguageModelToolResultPart
        | vscode.LanguageModelThinkingPart
        | vscode.LanguageModelDataPart
    )[],
    toolNameByCallId: Map<string, string>
): ConvertedContent {
    const textParts: string[] = [];
    const imageParts: ImagePart[] = [];
    const reasoningParts: ReasoningPart[] = [];
    const redactedReasoningParts: RedactedReasoningPart[] = [];
    const toolCalls: ToolCallInfo[] = [];
    const toolResults: ToolResultInfo[] = [];

    for (const part of parts) {
        if (part instanceof vscode.LanguageModelTextPart) {
            textParts.push(part.value);
        } else if (part instanceof vscode.LanguageModelThinkingPart) {
            const thinkingText = normalizeThinkingValue(part.value);
            const metadata = isThinkingMetadata(part.metadata) ? part.metadata : undefined;
            const signature = typeof metadata?.signature === 'string' ? metadata.signature : undefined;
            const redactedData = typeof metadata?.redactedData === 'string' ? metadata.redactedData : undefined;

            if (thinkingText.length > 0 || signature) {
                reasoningParts.push({
                    type: 'reasoning',
                    text: thinkingText,
                    ...(signature ? { signature } : {})
                });
            }

            if (redactedData) {
                redactedReasoningParts.push({
                    type: 'redacted-reasoning',
                    data: redactedData
                });
            }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
                toolCallId: part.callId,
                toolName: part.name,
                args: toToolArgs(part.input)
            });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            toolResults.push({
                toolCallId: part.callId,
                toolName: resolveToolName(part.callId),
                result: collectToolResultValue(part)
            });
        } else if (part instanceof vscode.LanguageModelDataPart) {
            // 处理图片附件（image/* mimeType）
            if (part.mimeType.startsWith('image/')) {
                imageParts.push({
                    type: 'image',
                    image: part.data,
                    mimeType: part.mimeType
                });
            }
            // 非 image/* 和 StatefulMarker 的 DataPart 暂不处理
        }
    }

    if (reasoningParts.length === 0) {
        const markerThinking = getThinkingFromStatefulMarker(parts);
        if (markerThinking?.completeThinking) {
            reasoningParts.push({
                type: 'reasoning',
                text: markerThinking.completeThinking,
                ...(markerThinking.completeSignature ? { signature: markerThinking.completeSignature } : {})
            });
            Logger.trace(
                `[MessageConverter] Restored reasoning from stateful marker (${markerThinking.completeThinking.length} chars)`
            );
        }
    }

    const text = textParts.join('\n').trim();
    const assistantContent: AssistantContentPart[] = [];

    if (text) {
        assistantContent.push({ type: 'text', text });
    }

    assistantContent.push(...reasoningParts);
    assistantContent.push(...redactedReasoningParts);
    assistantContent.push(...toolCalls.map(toolCall => ({ type: 'tool-call' as const, ...toolCall })));

    const userContent: UserContentPart[] = [];

    if (text) {
        userContent.push({ type: 'text', text });
    }

    for (const img of imageParts) {
        userContent.push(img);
    }

    return {
        userContent,
        assistantContent,
        toolCalls,
        toolResults
    };

    function resolveToolName(callId: string): string {
        const toolCall = toolCalls.find(item => item.toolCallId === callId);
        if (toolCall) {
            return toolCall.toolName;
        }

        const toolName = toolNameByCallId.get(callId);
        if (toolName) {
            return toolName;
        }

        Logger.warn(`[MessageConverter] Tool result missing matching tool call name for callId: ${callId}`);
        return 'unknown';
    }
}

/** 将 ThinkingPart 的 string | string[] 值统一为单字符串 */
function normalizeThinkingValue(value: string | string[]): string {
    return Array.isArray(value) ? value.join('') : value;
}

/** 判断 metadata 是否为可索引对象（用于提取 signature / redactedData） */
function isThinkingMetadata(metadata: unknown): metadata is Record<string, unknown> {
    return metadata !== null && typeof metadata === 'object';
}

/** 从 StatefulMarker DataPart 中恢复跨流片段的完整 thinking 和签名 */
function getThinkingFromStatefulMarker(
    parts: readonly (
        | vscode.LanguageModelTextPart
        | vscode.LanguageModelToolCallPart
        | vscode.LanguageModelToolResultPart
        | vscode.LanguageModelThinkingPart
        | vscode.LanguageModelDataPart
    )[]
): { completeThinking?: string; completeSignature?: string } | undefined {
    for (const part of parts) {
        if (
            part instanceof vscode.LanguageModelDataPart &&
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker?.completeThinking) {
                return {
                    completeThinking: marker.completeThinking,
                    completeSignature: marker.completeSignature
                };
            }
        }
    }

    return undefined;
}

/** 将工具调用的 input 安全转为 Record<string, unknown>，非对象降级为空对象 */
function toToolArgs(input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** 提取 ToolResultPart 的内容，优先解析 JSON，降级为 { output: text } */
function collectToolResultValue(part: vscode.LanguageModelToolResultPart): unknown {
    if (!part.content || part.content.length === 0) {
        return {};
    }

    if (part.content.length === 1) {
        const first = part.content[0];
        if (first instanceof vscode.LanguageModelTextPart) {
            return parseToolResultText(first.value);
        }
        if (first instanceof vscode.LanguageModelPromptTsxPart) {
            return first.value;
        }
        if (!(first instanceof vscode.LanguageModelDataPart) && first && typeof first === 'object') {
            return first;
        }
    }

    const text = collectToolResultText(part);
    return parseToolResultText(text);
}

/** 将 ToolResultPart 中混合类型的 content 拼接为纯文本 */
function collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
    if (!part.content || part.content.length === 0) {
        return '';
    }

    const texts: string[] = [];
    for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
            texts.push(item.value);
        } else if (item instanceof vscode.LanguageModelPromptTsxPart) {
            try {
                texts.push(JSON.stringify(item.value));
            } catch {
                texts.push(String(item.value));
            }
        } else if (item instanceof vscode.LanguageModelDataPart) {
            texts.push(`[Data:${item.mimeType}]`);
        } else if (item && typeof item === 'object') {
            try {
                texts.push(JSON.stringify(item));
            } catch {
                texts.push(String(item));
            }
        }
    }

    return texts.join('\n');
}

/** 尝试 JSON.parse 文本，失败则包装为 { output: text } */
function parseToolResultText(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) {
        return {};
    }

    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return { output: trimmed };
    }
}
