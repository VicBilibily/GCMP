/*---------------------------------------------------------------------------------------------
 *  消息转换器
 *  负责VS Code消息和OpenAI消息格式之间的转换
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';

/**
 * 消息转换器类
 */
export class MessageConverter {
    /**
     * 完整的消息转换 - 支持文本、图片和工具调用
     */
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[]
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

        for (const message of messages) {
            if (message.role === vscode.LanguageModelChatMessageRole.User) {
                // 检查是否有多模态内容（文本+图片）
                const textParts = message.content.filter(part => part instanceof vscode.LanguageModelTextPart);
                const imageParts: vscode.LanguageModelDataPart[] = [];

                // 安全地收集图片部分
                for (const part of message.content) {
                    if (part instanceof vscode.LanguageModelDataPart && this.isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                    }
                }

                if (imageParts.length > 0) {
                    // 多模态消息：包含图片
                    const contentArray: (
                        | OpenAI.Chat.ChatCompletionContentPartText
                        | OpenAI.Chat.ChatCompletionContentPartImage
                    )[] = [];

                    // 添加文本内容
                    if (textParts.length > 0) {
                        contentArray.push({
                            type: 'text',
                            text: textParts.map(part => (part as vscode.LanguageModelTextPart).value).join('\n')
                        });
                    }

                    // 添加图片内容
                    for (const imagePart of imageParts) {
                        const dataUrl = this.createDataUrl(imagePart);
                        contentArray.push({
                            type: 'image_url',
                            image_url: {
                                url: dataUrl
                            }
                        });
                    }

                    result.push({
                        role: 'user',
                        content: contentArray
                    });
                } else if (textParts.length > 0) {
                    // 纯文本消息
                    result.push({
                        role: 'user',
                        content: textParts.map(part => (part as vscode.LanguageModelTextPart).value).join('\n')
                    });
                }

                // 处理工具结果消息 - 这是防止无限重复的关键
                for (const part of message.content) {
                    if (part instanceof vscode.LanguageModelToolResultPart) {
                        let toolContent = '';
                        if (typeof part.content === 'string') {
                            toolContent = part.content;
                        } else if (Array.isArray(part.content)) {
                            toolContent = part.content
                                .map(resultPart => {
                                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                                        return resultPart.value;
                                    }
                                    return JSON.stringify(resultPart);
                                })
                                .join('\n');
                        } else {
                            toolContent = JSON.stringify(part.content);
                        }

                        result.push({
                            role: 'tool',
                            content: toolContent,
                            tool_call_id: part.callId
                        });
                    }
                }
            } else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
                // 助手消息 - 处理文本和工具调用
                const textParts = message.content
                    .filter(part => part instanceof vscode.LanguageModelTextPart)
                    .map(part => (part as vscode.LanguageModelTextPart).value);

                const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
                for (const part of message.content) {
                    if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push({
                            id: part.callId,
                            type: 'function',
                            function: {
                                name: part.name,
                                arguments: JSON.stringify(part.input)
                            }
                        });
                    }
                }

                const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
                    role: 'assistant',
                    content: textParts.length > 0 ? textParts.join('\n') : null
                };

                if (toolCalls.length > 0) {
                    assistantMessage.tool_calls = toolCalls;
                }

                // 只有有内容或工具调用时才添加消息
                if (assistantMessage.content || toolCalls.length > 0) {
                    result.push(assistantMessage);
                }
            } else if (message.role === vscode.LanguageModelChatMessageRole.System) {
                // 系统消息
                const textParts = message.content
                    .filter(part => part instanceof vscode.LanguageModelTextPart)
                    .map(part => (part as vscode.LanguageModelTextPart).value);

                if (textParts.length > 0) {
                    result.push({
                        role: 'system',
                        content: textParts.join('\n')
                    });
                }
            }
        }

        return result;
    }

    /**
     * 增强的工具转换 - 确保参数格式正确
     */
    convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[] {
        return tools.map(tool => {
            const functionDef: OpenAI.Chat.ChatCompletionTool = {
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || ''
                }
            };

            // 处理参数schema
            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    functionDef.function.parameters = tool.inputSchema as Record<string, unknown>;
                } else {
                    // 如果不是对象，提供默认schema
                    functionDef.function.parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                // 默认schema
                functionDef.function.parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return functionDef;
        });
    }

    /**
     * 检查是否为图片MIME类型
     */
    private isImageMimeType(mimeType: string): boolean {
        return (
            mimeType.startsWith('image/') && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)
        );
    }

    /**
     * 创建图片的data URL
     */
    private createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        const base64Data = Buffer.from(dataPart.data).toString('base64');
        return `data:${dataPart.mimeType};base64,${base64Data}`;
    }
}
