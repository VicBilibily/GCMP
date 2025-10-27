/*---------------------------------------------------------------------------------------------
 *  Anthropic 消息转换器
 *
 *  主要功能:
 *  - VS Code API消息格式转换为 Anthropic API格式
 *  - 支持文本、图像、工具调用和工具结果
 *  - 支持缓存控制和流式响应处理
 *  - 完整的错误处理和类型安全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlockParam, MessageParam, TextBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources';
import { Logger } from './logger';

// 自定义数据部分MIME类型
const CustomDataPartMimeTypes = {
    CacheControl: 'application/vnd.vscode.copilot.cache-control'
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
 */
function apiContentToAnthropicContent(content: vscode.LanguageModelChatMessage['content']): ContentBlockParam[] {
    const convertedContent: ContentBlockParam[] = [];

    for (const part of content) {
        // 工具调用
        if (part instanceof vscode.LanguageModelToolCallPart) {
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
export function apiMessageToAnthropicMessage(messages: readonly vscode.LanguageModelChatMessage[]): {
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
                content: apiContentToAnthropicContent(message.content)
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

    return { messages: mergedMessages, system: systemMessage };
}

/**
 * 处理 Anthropic 流式响应
 * 参照官方文档：https://docs.anthropic.com/en/api/messages-streaming
 */
export async function handleAnthropicStream(
    stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken
): Promise<{ usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
    let pendingToolCall:
        | {
            toolId?: string;
            name?: string;
            jsonInput?: string;
        }
        | undefined;

    let currentThinkingBlockId: string | undefined;

    let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

    Logger.debug('开始处理 Anthropic 流式响应');

    try {
        for await (const chunk of stream) {
            if (token.isCancellationRequested) {
                Logger.debug('流处理被取消');
                break;
            }

            // 处理不同的事件类型
            switch (chunk.type) {
                case 'message_start':
                    // 消息开始 - 收集初始使用统计
                    usage = {
                        inputTokens:
                            (chunk.message.usage.input_tokens ?? 0) +
                            (chunk.message.usage.cache_creation_input_tokens ?? 0) +
                            (chunk.message.usage.cache_read_input_tokens ?? 0),
                        outputTokens: 1,
                        totalTokens: -1
                    };
                    Logger.trace(`消息流开始 - 初始输入tokens: ${usage.inputTokens}`);
                    break;

                case 'content_block_start':
                    // 内容块开始
                    if (chunk.content_block.type === 'tool_use') {
                        pendingToolCall = {
                            toolId: chunk.content_block.id,
                            name: chunk.content_block.name,
                            jsonInput: ''
                        };
                        Logger.trace(`工具调用开始: ${chunk.content_block.name}`);
                    } else if (chunk.content_block.type === 'thinking') {
                        // 标记思考块开始
                        currentThinkingBlockId = chunk.index.toString();
                        Logger.trace('思考块开始 (流式输出)');
                    } else if (chunk.content_block.type === 'text') {
                        Logger.trace('文本块开始');
                    }
                    break;

                case 'content_block_delta':
                    // 内容块增量更新
                    if (chunk.delta.type === 'text_delta') {
                        // 文本内容增量
                        progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
                    } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                        // 工具调用参数增量
                        pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;
                    } else if (chunk.delta.type === 'thinking_delta') {
                        // 思考内容增量 - 流式输出
                        progress.report(new vscode.LanguageModelThinkingPart(chunk.delta.thinking));
                    }
                    break;

                case 'content_block_stop':
                    // 内容块停止
                    if (pendingToolCall) {
                        try {
                            const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
                            progress.report(
                                new vscode.LanguageModelToolCallPart(
                                    pendingToolCall.toolId!,
                                    pendingToolCall.name!,
                                    parsedJson
                                )
                            );
                            Logger.debug(`工具调用完成: ${pendingToolCall.name}`);
                        } catch (e) {
                            Logger.error(`解析工具调用 JSON 失败 (${pendingToolCall.name}):`, e);
                        }
                        pendingToolCall = undefined;
                    } else if (currentThinkingBlockId !== undefined) {
                        // 思考块结束 - 发送空的 ThinkingPart 作为结束标记
                        progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingBlockId));
                        Logger.debug(`思考块完成 (id: ${currentThinkingBlockId})`);
                        currentThinkingBlockId = undefined;
                    }
                    break;

                case 'message_delta':
                    // 消息增量 - 更新使用统计
                    if (usage && chunk.usage) {
                        // 更新输入 tokens（如果有更新）
                        if (chunk.usage.input_tokens !== undefined && chunk.usage.input_tokens !== null) {
                            usage.inputTokens = chunk.usage.input_tokens +
                                (chunk.usage.cache_creation_input_tokens ?? 0) +
                                (chunk.usage.cache_read_input_tokens ?? 0);
                        }
                        // 更新输出 tokens（如果有更新）
                        if (chunk.usage.output_tokens !== undefined && chunk.usage.output_tokens !== null) {
                            usage.outputTokens = chunk.usage.output_tokens;
                        }
                        // 重新计算总数
                        usage.totalTokens = usage.inputTokens + usage.outputTokens;

                        Logger.trace(`Token使用更新 - 输入: ${usage.inputTokens}, 输出: ${usage.outputTokens}, 总计: ${usage.totalTokens}`);
                    }
                    // 记录停止原因
                    if (chunk.delta.stop_reason) {
                        Logger.trace(`消息停止原因: ${chunk.delta.stop_reason}`);
                    }
                    break;

                case 'message_stop':
                    // 消息停止
                    Logger.trace('消息流完成');
                    break;

                default:
                    // 未知事件类型 - 根据官方建议优雅处理
                    // 可能包括 ping 事件或未来的新事件类型
                    Logger.trace('收到其他事件类型');
                    break;
            }
        }
    } catch (error) {
        Logger.error('处理 Anthropic 流时出错:', error);
        throw error;
    }

    if (usage) {
        Logger.debug(`流处理完成 - 最终使用统计: 输入=${usage.inputTokens}, 输出=${usage.outputTokens}, 总计=${usage.totalTokens}`);
    } else {
        Logger.warn('流处理完成但未获取到使用统计信息');
    }

    return { usage };
}

/**
 * 转换工具定义为 Anthropic 格式
 */
export function convertToAnthropicTools(tools: readonly vscode.LanguageModelChatTool[]): Anthropic.Messages.Tool[] {
    return tools.map(tool => {
        const inputSchema = tool.inputSchema as
            | {
                type?: string;
                properties?: Record<string, unknown>;
                required?: string[];
                additionalProperties?: boolean;
            }
            | undefined;

        if (!inputSchema) {
            return {
                name: tool.name,
                description: tool.description || '',
                input_schema: {
                    type: 'object',
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
