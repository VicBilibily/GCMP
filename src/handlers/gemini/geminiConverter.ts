/*---------------------------------------------------------------------------------------------
 *  Gemini 消息转换器
 *
 *  主要功能:
 *  - VS Code API 消息格式转换为 Gemini GenerateContentRequest 的 contents / systemInstruction
 *  - 思维链（thinking）以 thought: true 的 text part 传入 model 内容，保持多轮思维链连续性
 *  - 工具调用转换为 functionCall，工具结果转换为 functionResponse（名称经 callId 关联解析）
 *  - 图像转换为 inlineData（base64）
 *  - 连续的相同角色内容自动合并，满足 Gemini 角色交替要求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { sanitizeToolSchema } from '../../utils/text/schemaSanitizer';
import { Logger } from '../../utils/runtime/logger';
import { decodeStatefulMarker } from '../statefulMarker';
import { ModelConfig } from '../../types/sharedTypes';
import { CustomDataPartMimeTypes, GCMP_SYSTEM_MESSAGE_NAME } from '../types';
import { GeminiContent, GeminiPart, GeminiTool } from './geminiTypes';

/**
 * 类型守卫 - 检查对象是否有 mimeType 和 data 属性
 */
function isDataPart(part: unknown): part is vscode.LanguageModelDataPart2 {
    return typeof part === 'object' && part !== null && 'mimeType' in part && 'data' in part;
}

/**
 * 思考部分的元数据接口
 */
interface ThinkingPartMetadata {
    signature?: string;
    data?: string;
    _completeThinking?: string;
    provider?: string;
    modelId?: string;
}

function getThinkingMetadata(part: vscode.LanguageModelThinkingPart): ThinkingPartMetadata {
    return (part as unknown as { metadata?: ThinkingPartMetadata }).metadata ?? {};
}

function getCompleteThinkingFromStatefulMarker(content: vscode.LanguageModelChatMessage['content']): string | undefined {
    for (const part of content) {
        if (
            isDataPart(part) &&
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker?.completeThinking) {
                return marker.completeThinking;
            }
        }
    }
    return undefined;
}

/**
 * 从 StatefulMarker 提取 functionCall 的 thoughtSignature。
 * Google 要求签名随原 functionCall part 原样回传，否则多轮工具调用可能 400。
 * key 为 functionCall.id（优先）或函数名（id 缺省时）。
 */
function getToolCallSignaturesFromStatefulMarker(
    content: vscode.LanguageModelChatMessage['content']
): Record<string, string> | undefined {
    for (const part of content) {
        if (
            isDataPart(part) &&
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker?.toolCallSignatures && Object.keys(marker.toolCallSignatures).length > 0) {
                return marker.toolCallSignatures;
            }
        }
    }
    return undefined;
}

/**
 * 提取思考文本：优先 metadata._completeThinking，其次 part.value
 */
function resolveThinkingText(part: vscode.LanguageModelThinkingPart): string {
    const metadata = getThinkingMetadata(part);
    let thinking = metadata?._completeThinking || '';
    if (typeof part.value === 'string' && part.value.trim() !== '') {
        if (part.value.length > thinking.length) {
            thinking = part.value;
        }
    } else if (Array.isArray(part.value) && part.value.length > 0) {
        const partStr = part.value.join('');
        if (partStr.length > thinking.length) {
            thinking = partStr;
        }
    }
    return thinking;
}

export interface GeminiConvertedMessages {
    contents: GeminiContent[];
    systemInstruction?: GeminiContent;
}

/**
 * 将 VS Code API 消息转换为 Gemini contents / systemInstruction
 */
export function convertMessagesToGemini(
    modelConfig: ModelConfig,
    messages: readonly vscode.LanguageModelChatMessage[]
): GeminiConvertedMessages {
    // 模型能力：不支持 imageInput 时，必须忽略所有 image/* 数据块。
    const allowImages = modelConfig.capabilities?.imageInput === true;

    // 第一遍：建立 callId -> 工具名 映射，供 functionResponse 解析名称
    const toolNameByCallId = new Map<string, string>();
    for (const message of messages) {
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                toolNameByCallId.set(part.callId, part.name);
            }
        }
    }

    const contents: GeminiContent[] = [];
    const systemParts: GeminiPart[] = [];

    const pushContent = (role: 'user' | 'model', parts: GeminiPart[]) => {
        if (parts.length === 0) {
            return;
        }
        const last = contents[contents.length - 1];
        if (last && last.role === role) {
            last.parts!.push(...parts);
        } else {
            contents.push({ role, parts });
        }
    };

    for (const message of messages) {
        // GCMP 构造的系统提示词用 name=GCMP_SYSTEM_MESSAGE_NAME 标记，转为 systemInstruction
        if (message.role === vscode.LanguageModelChatMessageRole.User && message.name === GCMP_SYSTEM_MESSAGE_NAME) {
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart && part.value) {
                    systemParts.push({ text: part.value });
                }
            }
            continue;
        }

        if (message.role === vscode.LanguageModelChatMessageRole.System) {
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart && part.value) {
                    systemParts.push({ text: part.value });
                }
            }
            continue;
        }

        const role: 'user' | 'model' =
            message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';

        const parts: GeminiPart[] = [];
        const markerThinking = getCompleteThinkingFromStatefulMarker(message.content);
        const toolCallSignatures = getToolCallSignaturesFromStatefulMarker(message.content);
        let sawThinking = false;

        for (const part of message.content) {
            // 思考内容 - Gemini 原生支持 thought part，用于保持多轮思维链连续性
            if (part instanceof vscode.LanguageModelThinkingPart) {
                if (getThinkingMetadata(part).data) {
                    // 加密思考（redacted_thinking）Gemini 不支持，跳过
                    continue;
                }
                const thinking = resolveThinkingText(part);
                if (thinking) {
                    const metadata = getThinkingMetadata(part);
                    parts.push({
                        text: thinking,
                        thought: true,
                        ...(metadata.signature ? { thoughtSignature: metadata.signature } : {})
                    });
                    sawThinking = true;
                }
            }
            // 工具调用（id 与 functionResponse 配对；thoughtSignature 随原 part 回传，Google 要求）
            else if (part instanceof vscode.LanguageModelToolCallPart) {
                // 签名按 functionCall.id 键控优先、函数名兜底：
                // 同名并行调用只有带签名的 part 有签名，按名查会给所有同名调用都加上
                const signature = toolCallSignatures?.[part.callId] ?? toolCallSignatures?.[part.name];
                parts.push({
                    functionCall: {
                        name: part.name,
                        args: (part.input ?? {}) as Record<string, unknown>,
                        id: part.callId
                    },
                    ...(signature ? { thoughtSignature: signature } : {})
                });
            }
            // 工具结果
            else if (
                part instanceof vscode.LanguageModelToolResultPart ||
                (part as unknown as { callId?: string }).callId !== undefined
            ) {
                const toolPart = part as unknown as {
                    callId: string;
                    content: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[];
                };
                const name = toolNameByCallId.get(toolPart.callId) ?? 'unknown_tool';
                const textChunks: string[] = [];
                for (const p of toolPart.content) {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        textChunks.push(p.value);
                    } else if (isDataPart(p) && p.mimeType.startsWith('image/')) {
                        if (!allowImages) {
                            textChunks.push('[Image]');
                        }
                        // 工具结果中的图像 Gemini functionResponse 不便携带，忽略
                    }
                }
                parts.push({
                    functionResponse: {
                        name,
                        // id 与 functionCall.id 配对（上游调用 id 经累积器透传为 callId）
                        id: toolPart.callId,
                        response: {
                            name,
                            content: textChunks.join('\n')
                        }
                    }
                });
            }
            // 图像数据
            else if (isDataPart(part) && part.mimeType.startsWith('image/')) {
                if (part.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
                    continue;
                }
                if (allowImages) {
                    parts.push({
                        inlineData: {
                            mimeType: part.mimeType,
                            data: Buffer.from(part.data as Uint8Array).toString('base64')
                        }
                    });
                } else {
                    parts.push({ text: '[Image]' });
                }
            }
            // 文本内容
            else if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value === '') {
                    continue;
                }
                parts.push({ text: part.value });
            }
        }

        // assistant 消息：如果 VS Code 剥离了 ThinkingPart，从 StatefulMarker 恢复思维链
        if (role === 'model' && !sawThinking && markerThinking) {
            parts.unshift({ text: markerThinking, thought: true });
        }

        pushContent(role, parts);
    }

    // Gemini 要求 contents 以 user 角色开头，否则前置一个占位 user 消息
    if (contents.length > 0 && contents[0].role === 'model') {
        contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
    }

    const result: GeminiConvertedMessages = { contents };
    if (systemParts.length > 0) {
        result.systemInstruction = { role: 'system', parts: systemParts };
    }
    return result;
}

/**
 * 将 VS Code 工具定义转换为 Gemini functionDeclarations
 */
export function convertToolsToGemini(tools: readonly vscode.LanguageModelChatTool[]): GeminiTool[] {
    const declarations = tools.map(tool => {
        const inputSchema = tool.inputSchema as
            | { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
            | undefined;

        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description || '',
                parameters: {
                    type: 'object' as const,
                    properties: {},
                    required: []
                }
            };
        }

        const sanitized = sanitizeToolSchema(inputSchema);
        return {
            name: tool.name,
            description: tool.description || '',
            parameters: {
                type: 'object' as const,
                properties: sanitized.properties ?? {},
                required: sanitized.required ?? [],
                ...(sanitized.additionalProperties !== undefined && {
                    additionalProperties: sanitized.additionalProperties
                })
            }
        };
    });

    if (declarations.length === 0) {
        Logger.trace('convertToolsToGemini: no tools to convert');
        return [];
    }

    return [{ functionDeclarations: declarations }];
}
