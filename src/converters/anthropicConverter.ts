/*---------------------------------------------------------------------------------------------
 *  通用Anthropic消息转换器
 *  参照Microsoft vscode-copilot-chat的BYOK实现
 *  
 *  主要功能:
 *  - VS Code API消息格式转换为Anthropic API格式
 *  - 支持文本、图像、工具调用和工具结果
 *  - 支持缓存控制和流式响应处理
 *  - 完整的错误处理和类型安全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Raw } from '@vscode/prompt-tsx';
import Anthropic from '@anthropic-ai/sdk';
import { ContentBlockParam, MessageParam, TextBlockParam, ImageBlockParam, ThinkingBlockParam, RedactedThinkingBlockParam } from '@anthropic-ai/sdk/resources';
import { 
    LanguageModelDataPart, 
    LanguageModelChatMessageRole,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResultPart2
} from '../types/vscodeTypes';

// 自定义数据部分MIME类型 - 参照官方实现
const CustomDataPartMimeTypes = {
    CacheControl: 'application/vnd.vscode.copilot.cache-control',
    ThinkingData: 'application/vnd.vscode.copilot.thinking-data',
    StatefulMarker: 'application/vnd.vscode.copilot.stateful-marker'
} as const;

// 辅助函数 - 过滤undefined值
function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

/**
 * 检查是否为图像数据部分
 */
// function isImageDataPart(part: unknown): part is LanguageModelDataPart {
//     if (part instanceof LanguageModelDataPart && isChatImageMimeType(part.mimeType)) {
//         return true;
//     }
//     return false;
// }

// function isChatImageMimeType(mimeType: string): mimeType is ChatImageMimeType {
//     switch (mimeType) {
//         case ChatImageMimeType.JPEG:
//         case ChatImageMimeType.PNG:
//         case ChatImageMimeType.GIF:
//         case ChatImageMimeType.WEBP:
//         case ChatImageMimeType.BMP:
//             return true;
//         default:
//             return false;
//     }
// }

/**
 * 检查内容块是否支持缓存控制
 */
function contentBlockSupportsCacheControl(block: ContentBlockParam): block is Exclude<ContentBlockParam, ThinkingBlockParam | RedactedThinkingBlockParam> {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

/**
 * 将VS Code API消息内容转换为Anthropic格式
 * 参照Microsoft官方apiContentToAnthropicContent实现
 */
function apiContentToAnthropicContent(
    content: (LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart)[]
): ContentBlockParam[] {
    const convertedContent: ContentBlockParam[] = [];
    
    for (const part of content) {
        if (part instanceof LanguageModelToolCallPart) {
            convertedContent.push({
                type: 'tool_use',
                id: part.callId,
                input: part.input,
                name: part.name,
            });
        } else if (part instanceof LanguageModelDataPart && part.mimeType === CustomDataPartMimeTypes.CacheControl && part.data.toString() === 'ephemeral') {
            const previousBlock = convertedContent.at(-1);
            if (previousBlock && contentBlockSupportsCacheControl(previousBlock)) {
                previousBlock.cache_control = { type: 'ephemeral' };
            } else {
                // 空字符串无效
                convertedContent.push({
                    type: 'text',
                    text: ' ',
                    cache_control: { type: 'ephemeral' }
                });
            }
        } else if (part instanceof LanguageModelDataPart) {
            convertedContent.push({
                type: 'image',
                source: {
                    type: 'base64',
                    data: Buffer.from(part.data).toString('base64'),
                    media_type: part.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp"
                }
            });
        } else if (part instanceof LanguageModelToolResultPart || part instanceof LanguageModelToolResultPart2) {
            convertedContent.push({
                type: 'tool_result',
                tool_use_id: part.callId,
                content: part.content.map((p): TextBlockParam | ImageBlockParam | undefined => {
                    if (p instanceof LanguageModelTextPart) {
                        return { type: 'text', text: p.value };
                    } else if (p instanceof LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.CacheControl && p.data.toString() === 'ephemeral') {
                        // 空字符串无效
                        return { type: 'text', text: ' ', cache_control: { type: 'ephemeral' } };
                    } else if (p instanceof LanguageModelDataPart) {
                        return { type: 'image', source: { type: 'base64', media_type: p.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: Buffer.from(p.data).toString('base64') } };
                    }
                    return undefined;
                }).filter(isDefined)
            });
        } else {
            // Anthropic在空字符串时会报错，跳过空文本部分
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
 * 将VS Code API消息转换为Anthropic格式
 */
export function apiMessageToAnthropicMessage(
    messages: vscode.LanguageModelChatMessage[]
): { messages: MessageParam[]; system: TextBlockParam } {
    const unmergedMessages: MessageParam[] = [];
    const systemMessage: TextBlockParam = {
        type: 'text',
        text: ''
    };
    
    for (const message of messages) {
        if (message.role === LanguageModelChatMessageRole.Assistant) {
            unmergedMessages.push({
                role: 'assistant',
                content: apiContentToAnthropicContent(message.content),
            });
        } else if (message.role === LanguageModelChatMessageRole.User) {
            unmergedMessages.push({
                role: 'user',
                content: apiContentToAnthropicContent(message.content),
            });
        } else {
            systemMessage.text += message.content.map(p => {
                // 参照官方注释：由于某种原因instanceof不工作
                if (p instanceof LanguageModelTextPart) {
                    return p.value;
                } else if (p instanceof LanguageModelDataPart && p.mimeType === CustomDataPartMimeTypes.CacheControl && p.data.toString() === 'ephemeral') {
                    systemMessage.cache_control = { type: 'ephemeral' };
                }
                return '';
            }).join('');
        }
    }
    
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
    
    return { messages: mergedMessages, system: systemMessage };
}

/**
 * 处理Anthropic流式响应
 */
export async function handleAnthropicStream(
    stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
): Promise<{ usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    let pendingToolCall: {
        toolId?: string;
        name?: string;
        jsonInput?: string;
    } | undefined;
    
    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;
    
    try {
        for await (const chunk of stream) {
            if (token.isCancellationRequested) {
                break;
            }
            
            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
            }
            else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'thinking') {
                // Thinking块开始 - 可能需要特殊处理
            }
            else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'thinking_delta') {
                // 处理thinking内容的增量更新 - 注意：可能需要特殊处理
                // thinking内容通常不会在progress中报告，因为它是内部推理过程
            }
            else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
                pendingToolCall = {
                    toolId: chunk.content_block.id,
                    name: chunk.content_block.name,
                    jsonInput: ''
                };
            }
            else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;
                
                // 尝试解析部分JSON，只有完整时才报告
                if (pendingToolCall.jsonInput) {
                    try {
                        const parsedJson = JSON.parse(pendingToolCall.jsonInput);
                        progress.report(
                            new vscode.LanguageModelToolCallPart(
                                pendingToolCall.toolId!,
                                pendingToolCall.name!,
                                parsedJson
                            )
                        );
                        pendingToolCall = undefined;
                    } catch {
                        // JSON不完整，继续累积
                        continue;
                    }
                }
            }
            else if (chunk.type === 'content_block_stop' && pendingToolCall) {
                try {
                    const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
                    progress.report(
                        new vscode.LanguageModelToolCallPart(
                            pendingToolCall.toolId!,
                            pendingToolCall.name!,
                            parsedJson
                        )
                    );
                } catch (e) {
                    console.error('Failed to parse tool call JSON:', e);
                }
                pendingToolCall = undefined;
            }
            else if (chunk.type === 'message_start') {
                usage = {
                    inputTokens: chunk.message.usage.input_tokens + 
                               (chunk.message.usage.cache_creation_input_tokens ?? 0) + 
                               (chunk.message.usage.cache_read_input_tokens ?? 0),
                    outputTokens: 1,
                    totalTokens: -1
                };
            }
            else if (chunk.type === 'message_delta' && usage && chunk.usage?.output_tokens) {
                usage.outputTokens = chunk.usage.output_tokens;
                usage.totalTokens = usage.inputTokens + chunk.usage.output_tokens;
            }
        }
    } catch (error) {
        console.error('Error processing Anthropic stream:', error);
        throw error;
    }
    
    return { usage };
}

/**
 * 转换工具定义为Anthropic格式
 */
export function convertToAnthropicTools(tools: vscode.LanguageModelChatTool[]): Anthropic.Messages.Tool[] {
    return tools.map((tool) => {
        const inputSchema = tool.inputSchema as { 
            type?: string;
            properties?: Record<string, unknown>; 
            required?: string[];
            additionalProperties?: boolean;
        } | undefined;
        
        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description,
                input_schema: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            };
        }

        return {
            name: tool.name,
            description: tool.description,
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

/**
 * 日志记录用的消息转换
 * 参照Microsoft官方anthropicMessagesToRawMessagesForLogging实现
 */
export function anthropicMessagesToRawMessagesForLogging(
    messages: MessageParam[], 
    system: TextBlockParam
): Raw.ChatMessage[] {
    // 先进行完整转换，然后为日志记录进行清理
    const fullMessages = anthropicMessagesToRawMessages(messages, system);

    // 将大容量内容替换为占位符
    return fullMessages.map(message => {
        const content = message.content.map(part => {
            if (part.type === Raw.ChatCompletionContentPartKind.Image) {
                // 为日志记录将实际图像URL替换为占位符
                return {
                    ...part,
                    imageUrl: { url: '(image)' }
                };
            }
            return part;
        });

        if (message.role === Raw.ChatRole.Tool) {
            // 为日志记录将工具结果内容替换为占位符
            return {
                ...message,
                content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: '(tool result)' }]
            };
        }

        return {
            ...message,
            content
        };
    });
}

/**
 * 完整保真度的Anthropic MessageParam[] + system转换为Raw.ChatMessage[]
 * 参照Microsoft官方anthropicMessagesToRawMessages实现
 * 与日志记录版本相比，此版本保留工具结果内容和图像数据（尽可能作为数据URL）
 */
export function anthropicMessagesToRawMessages(
    messages: MessageParam[], 
    system: TextBlockParam
): Raw.ChatMessage[] {
    const rawMessages: Raw.ChatMessage[] = [];

    if (system) {
        const systemContent: Raw.ChatCompletionContentPart[] = [];
        if (system.text) {
            systemContent.push({ type: Raw.ChatCompletionContentPartKind.Text, text: system.text });
        }
        if ('cache_control' in system && system.cache_control) {
            systemContent.push({ type: Raw.ChatCompletionContentPartKind.CacheBreakpoint, cacheType: system.cache_control.type });
        }
        if (systemContent.length) {
            rawMessages.push({ role: Raw.ChatRole.System, content: systemContent });
        }
    }

    for (const message of messages) {
        const content: Raw.ChatCompletionContentPart[] = [];
        let toolCalls: Raw.ChatMessageToolCall[] | undefined;
        let toolCallId: string | undefined;

        const toRawImage = (img: ImageBlockParam): Raw.ChatCompletionContentPartImage | undefined => {
            if (img.source.type === 'base64') {
                return { type: Raw.ChatCompletionContentPartKind.Image, imageUrl: { url: `data:${img.source.media_type};base64,${img.source.data}` } };
            } else if (img.source.type === 'url') {
                return { type: Raw.ChatCompletionContentPartKind.Image, imageUrl: { url: img.source.url } };
            }
            return undefined;
        };

        const pushImage = (img: ImageBlockParam) => {
            const imagePart = toRawImage(img);
            if (imagePart) {
                content.push(imagePart);
            }
        };

        const pushCache = (block?: ContentBlockParam) => {
            if (block && contentBlockSupportsCacheControl(block) && 'cache_control' in block && block.cache_control) {
                content.push({ type: Raw.ChatCompletionContentPartKind.CacheBreakpoint, cacheType: block.cache_control.type });
            }
        };

        if (Array.isArray(message.content)) {
            for (const block of message.content) {
                if (block.type === 'text') {
                    content.push({ type: Raw.ChatCompletionContentPartKind.Text, text: block.text });
                    pushCache(block);
                } else if (block.type === 'image') {
                    pushImage(block);
                    pushCache(block);
                } else if (block.type === 'tool_use') {
                    // tool_use出现在assistant消息中；表示为assistant消息上的toolCalls
                    toolCalls ??= [];
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
                    });
                    // 没有内容部分，工具调用是分离的
                    pushCache(block);
                } else if (block.type === 'tool_result') {
                    // tool_result出现在用户角色中；我们稍后将使用此toolCallId和内容发出Raw.Tool消息
                    toolCallId = block.tool_use_id;
                    // 将工具结果内容转换为原始部分
                    const toolContent: Raw.ChatCompletionContentPart[] = [];
                    if (typeof block.content === 'string') {
                        toolContent.push({ type: Raw.ChatCompletionContentPartKind.Text, text: block.content });
                    } else {
                        for (const c of block.content ?? []) {
                            if (c.type === 'text') {
                                toolContent.push({ type: Raw.ChatCompletionContentPartKind.Text, text: c.text });
                            } else if (c.type === 'image') {
                                const imagePart = toRawImage(c);
                                if (imagePart) {
                                    toolContent.push(imagePart);
                                }
                            }
                        }
                    }
                    // 现在发出工具结果消息并继续到下一个消息
                    rawMessages.push({ 
                        role: Raw.ChatRole.Tool, 
                        content: toolContent.length ? toolContent : [{ type: Raw.ChatCompletionContentPartKind.Text, text: '' }], 
                        toolCallId 
                    });
                    toolCallId = undefined;
                } else {
                    // thinking或不支持的类型被忽略
                }
            }
        } else if (typeof message.content === 'string') {
            content.push({ type: Raw.ChatCompletionContentPartKind.Text, text: message.content });
        }

        if (message.role === 'assistant') {
            const msg: Raw.AssistantChatMessage = { role: Raw.ChatRole.Assistant, content };
            if (toolCalls && toolCalls.length > 0) {
                msg.toolCalls = toolCalls;
            }
            rawMessages.push(msg);
        } else if (message.role === 'user') {
            // 注意：tool_result之前已处理；这里如果有标准用户内容就推送
            if (content.length) {
                rawMessages.push({ role: Raw.ChatRole.User, content });
            }
        }
    }

    return rawMessages;
}

/**
 * 验证Anthropic消息格式的完整性
 */
export function validateAnthropicMessages(
    messages: MessageParam[], 
    system?: TextBlockParam
): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // 验证系统消息
    if (system && (!system.text || system.text.trim() === '')) {
        errors.push('System message cannot be empty');
    }
    
    // 验证消息数组
    if (!messages || messages.length === 0) {
        errors.push('Messages array cannot be empty');
    }
    
    // 验证消息格式
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        
        if (!message.role || (message.role !== 'user' && message.role !== 'assistant')) {
            errors.push(`Message ${i}: Invalid role '${message.role}'`);
        }
        
        if (!message.content || (Array.isArray(message.content) && message.content.length === 0)) {
            errors.push(`Message ${i}: Content cannot be empty`);
        }
        
        // 检查消息交替模式（user/assistant）
        if (i > 0) {
            const prevRole = messages[i - 1].role;
            if (message.role === prevRole) {
                // 注意：Anthropic允许连续相同角色的消息，会自动合并
            }
        }
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}
