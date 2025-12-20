/*---------------------------------------------------------------------------------------------
 *  Anthropic 消息转换器
 *
 *  主要功能:
 *  - VS Code API消息格式转换为 Anthropic API格式
 *  - 支持文本、图像、工具调用和工具结果
 *  - 支持思考内容（thinking）转换，保持多轮对话思维链连续性
 *  - 支持缓存控制和流式响应处理
 *  - 完整的错误处理和类型安全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type {
    ContentBlockParam,
    ThinkingBlockParam,
    RedactedThinkingBlockParam,
    MessageParam,
    TextBlockParam,
    ImageBlockParam
} from '@anthropic-ai/sdk/resources';
import { ModelConfig } from '../types/sharedTypes';
import { Logger } from './logger';

// 自定义数据部分MIME类型
const CustomDataPartMimeTypes = {
    CacheControl: 'cache_control'
} as const;

// 辅助函数 - 过滤undefined值
function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

/**
 * 检查内容块是否支持缓存控制
 */
function contentBlockSupportsCacheControl(block: ContentBlockParam): boolean {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/**
 * 将 VS Code API 消息内容转换为 Anthropic 格式
 * 支持 thinking 内容块以保持多轮对话中思维链的连续性（MiniMax 要求）
 */
function apiContentToAnthropicContent(
    content: vscode.LanguageModelChatMessage['content'],
    includeThinking = false
): ContentBlockParam[] {
    const convertedContent: ContentBlockParam[] = [];

    for (const part of content) {
        // 思考内容（thinking）- 用于保持多轮对话思维链连续性
        if (includeThinking && part instanceof vscode.LanguageModelThinkingPart) {
            // 检查是否有 metadata（包含 signature 等信息）
            const metadata = part.metadata as
                | { signature?: string; data?: string; _completeThinking?: string }
                | undefined;

            // 如果是加密的思考内容（redacted_thinking）
            if (metadata?.data) {
                convertedContent.push({
                    type: 'redacted_thinking',
                    data: metadata.data
                } as RedactedThinkingBlockParam);
            } else {
                // 普通思考内容
                // 优先使用 _completeThinking（完整思考内容），否则使用 value
                const thinkingText =
                    metadata?._completeThinking || (Array.isArray(part.value) ? part.value.join('') : part.value);
                // 只有当思考内容非空时才添加
                if (thinkingText) {
                    const thinkingBlock = {
                        type: 'thinking',
                        thinking: thinkingText
                    } as ThinkingBlockParam;
                    // 如果有签名，添加到块中
                    if (metadata?.signature) {
                        thinkingBlock.signature = metadata.signature;
                    }
                    convertedContent.push(thinkingBlock);
                }
            }
        }
        // 工具调用
        else if (part instanceof vscode.LanguageModelToolCallPart) {
            convertedContent.push({
                type: 'tool_use',
                id: part.callId,
                input: part.input,
                name: part.name
            });
        }
        // 缓存控制标记
        else if ('data' in part && 'mimeType' in part) {
            const dataPart = part as { data: unknown; mimeType: string };
            if (dataPart.mimeType === CustomDataPartMimeTypes.CacheControl) {
                const previousBlock = convertedContent.at(-1);
                if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
                    (previousBlock as ContentBlockParam & { cache_control?: { type: string } }).cache_control = {
                        type: 'ephemeral'
                    };
                } else {
                    // 空字符串无效，使用空格
                    convertedContent.push({
                        type: 'text',
                        text: ' ',
                        cache_control: { type: 'ephemeral' }
                    } as ContentBlockParam);
                }
            }
            // 图像数据
            else if (dataPart.mimeType.startsWith('image/')) {
                convertedContent.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        data: Buffer.from(dataPart.data as Uint8Array).toString('base64'),
                        media_type: dataPart.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
                    }
                });
            }
        }
        // 工具结果
        else if (part instanceof vscode.LanguageModelToolResultPart) {
            convertedContent.push({
                type: 'tool_result',
                tool_use_id: part.callId,
                content: part.content
                    .map((p): TextBlockParam | ImageBlockParam | undefined => {
                        if (p instanceof vscode.LanguageModelTextPart) {
                            return { type: 'text', text: p.value };
                        }
                        // 处理其他类型的内容（如图像等）
                        return undefined;
                    })
                    .filter(isDefined)
            });
        }
        // 文本内容
        else if (part instanceof vscode.LanguageModelTextPart) {
            // Anthropic 在空字符串时会报错，跳过空文本部分
            if (part.value === '') {
                continue;
            }
            convertedContent.push({
                type: 'text',
                text: part.value
            });
        }
    }

    return convertedContent;
}

/**
 * 将 VS Code API 消息转换为 Anthropic 格式
 */
export function apiMessageToAnthropicMessage(
    model: ModelConfig,
    messages: readonly vscode.LanguageModelChatMessage[]
): {
    messages: MessageParam[];
    system: TextBlockParam;
} {
    const unmergedMessages: MessageParam[] = [];
    const systemMessage: TextBlockParam = {
        type: 'text',
        text: ''
    };

    for (const message of messages) {
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            unmergedMessages.push({
                role: 'assistant',
                content: apiContentToAnthropicContent(message.content, model.includeThinking)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.User) {
            unmergedMessages.push({
                role: 'user',
                content: apiContentToAnthropicContent(message.content)
            });
        } else if (message.role === vscode.LanguageModelChatMessageRole.System) {
            systemMessage.text += message.content
                .map(p => {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        return p.value;
                    } else if (
                        'data' in p &&
                        'mimeType' in p &&
                        p.mimeType === CustomDataPartMimeTypes.CacheControl &&
                        (p.data as Uint8Array).toString() === 'ephemeral'
                    ) {
                        (systemMessage as TextBlockParam & { cache_control?: { type: string } }).cache_control = {
                            type: 'ephemeral'
                        };
                    }
                    return '';
                })
                .join('');
        }
    }

    // 合并连续的相同角色消息
    const mergedMessages: MessageParam[] = [];
    for (const message of unmergedMessages) {
        if (mergedMessages.length === 0 || mergedMessages[mergedMessages.length - 1].role !== message.role) {
            mergedMessages.push(message);
        } else {
            const prevMessage = mergedMessages[mergedMessages.length - 1];
            if (Array.isArray(prevMessage.content) && Array.isArray(message.content)) {
                (prevMessage.content as ContentBlockParam[]).push(...(message.content as ContentBlockParam[]));
            }
        }
    }

    // 如果 includeThinking=true，检查并确保 assistant 消息包含 thinking 块
    if (model.includeThinking) {
        for (const message of mergedMessages) {
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                const hasThinkingBlock = message.content.some(
                    block => block.type === 'thinking' || block.type === 'redacted_thinking'
                );
                if (!hasThinkingBlock) {
                    // 在 assistant 消息开头添加默认 thinking 块
                    message.content.unshift({
                        type: 'thinking',
                        thinking: '...'
                    } as ThinkingBlockParam);
                    Logger.warn('Assistant message missing thinking block, added default one');
                }
            }
        }
    }

    return { messages: mergedMessages, system: systemMessage };
}

/**
 * 转换工具定义为 Anthropic 格式
 */
export function convertToAnthropicTools(tools: readonly vscode.LanguageModelChatTool[]): Anthropic.Messages.Tool[] {
    return tools.map(tool => {
        const inputSchema = tool.inputSchema as Anthropic.Messages.Tool.InputSchema | undefined;

        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description || '',
                input_schema: {
                    type: 'object' as const,
                    properties: {},
                    required: []
                }
            };
        }

        return {
            name: tool.name,
            description: tool.description || '',
            input_schema: {
                type: 'object' as const,
                properties: inputSchema.properties ?? {},
                required: inputSchema.required ?? [],
                ...(inputSchema.additionalProperties !== undefined && {
                    additionalProperties: inputSchema.additionalProperties
                })
            }
        };
    });
}
