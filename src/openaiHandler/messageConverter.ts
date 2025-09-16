import * as vscode from 'vscode';
import { ChatMessage, ChatMessageContent, Tool } from './types';
import { Logger } from '../utils';

/**
 * 消息转换器类
 * 负责VS Code消息和API消息格式之间的转换
 * 
 * 特殊处理说明：
 * - cache_control 内容：完全忽略，不输出任何内容
 *   这是 Anthropic Claude 特有的缓存优化功能，对 OpenAI 兼容 API 无意义
 *   在转换过程中直接跳过，确保不影响正常的消息处理流程
 */
export class MessageConverter {
    /**
     * 转换消息格式
     */
    convertMessagesToOpenAI(messages: readonly vscode.LanguageModelChatMessage[], modelCapabilities?: { imageInput?: boolean }): ChatMessage[] {
        const result: ChatMessage[] = [];
        const pendingToolCalls = new Set<string>(); // 跟踪未响应的工具调用

        for (const msg of messages) {
            // 正确映射角色类型 - 明确处理所有已知角色
            let role: 'system' | 'user' | 'assistant';
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                role = 'user';
            } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                role = 'assistant';
            } else if (msg.role === 3) { // LanguageModelChatMessageRole.System (提议的API)
                role = 'system';
            } else {
                // 处理未知角色 - 记录警告并默认为user
                Logger.warn(`遇到未知的消息角色: ${msg.role}，默认设置为user角色`);
                role = 'user';
            }

            const converted: ChatMessage = { role };

            // 处理工具响应消息（优先处理）
            if (msg.role === vscode.LanguageModelChatMessageRole.User && Array.isArray(msg.content)) {
                let hasToolResults = false;

                for (const part of msg.content) {
                    if (part instanceof vscode.LanguageModelToolResultPart) {
                        let toolContent = '';
                        if (typeof part.content === 'string') {
                            toolContent = part.content;
                        } else if (Array.isArray(part.content)) {
                            toolContent = part.content
                                .map((resultPart) => {
                                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                                        return resultPart.value;
                                    } else if (resultPart instanceof vscode.LanguageModelDataPart) {
                                        // 处理工具结果中的数据部分
                                        if (resultPart.mimeType === 'cache_control') {
                                            // cache_control 处理策略：直接忽略，不输出任何内容
                                            // 这是 Anthropic Claude 特有的缓存控制功能，对 OpenAI 兼容 API 无意义
                                            // 继续处理下一个部分，不添加任何内容到结果中
                                            return '';
                                        }
                                        // 检查是否为图像数据
                                        if (this.isImageMimeType(resultPart.mimeType)) {
                                            return `[图片: ${resultPart.mimeType}, ${resultPart.data.length} bytes - 工具结果中的图片已转换为描述]`;
                                        }
                                        return `[Data: ${resultPart.mimeType}, ${resultPart.data.length} bytes]`;
                                    } else if ((resultPart as unknown)?.constructor?.name === 'LanguageModelPromptTsxPart') {
                                        // 处理TSX部分
                                        return `[TSX Content: ${JSON.stringify(resultPart)}]`;
                                    }
                                    return JSON.stringify(resultPart);
                                })
                                .join('\n');
                        } else {
                            toolContent = JSON.stringify(part.content);
                        }

                        result.push({
                            role: 'tool',
                            tool_call_id: part.callId,
                            content: toolContent
                        });
                        pendingToolCalls.delete(part.callId); // 标记为已响应
                        hasToolResults = true;
                    }
                }

                // 如果有工具结果，只处理工具结果，跳过其他内容
                if (hasToolResults) {
                    continue;
                }
            }

            // 处理常规消息内容
            if (msg.content) {
                if (typeof msg.content === 'string') {
                    converted.content = msg.content;
                } else if (Array.isArray(msg.content)) {
                    // 分类收集各种内容部分
                    const textParts: vscode.LanguageModelTextPart[] = [];
                    const imageParts: vscode.LanguageModelDataPart[] = [];
                    const dataParts: vscode.LanguageModelDataPart[] = [];
                    const thinkingParts: unknown[] = []; // LanguageModelThinkingPart

                    // 分类收集各种内容部分
                    for (const part of msg.content) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            textParts.push(part);
                        } else if (
                            part instanceof vscode.LanguageModelDataPart &&
                            this.isImageMimeType(part.mimeType)
                        ) {
                            imageParts.push(part);
                        } else if (
                            part instanceof vscode.LanguageModelDataPart &&
                            part.mimeType === 'cache_control'
                        ) {
                            // cache_control 处理策略：直接忽略，不输出任何内容
                            // 原因说明：
                            // 1. cache_control 是 Anthropic Claude 特有的缓存优化功能
                            // 2. 主要用于指示模型哪些内容可以被缓存以提高响应速度和降低成本
                            // 3. 直接跳过处理，不在转换结果中包含任何相关内容
                            Logger.trace(`直接忽略cache_control内容: ${part.data.length} bytes`);
                            continue;
                        } else if (part instanceof vscode.LanguageModelDataPart) {
                            dataParts.push(part);
                        } else if (part.constructor.name === 'LanguageModelThinkingPart') {
                            thinkingParts.push(part);
                        } else {
                            // 处理未知类型的内容部分
                            Logger.trace(`遇到未知的内容部分类型: ${part.constructor.name}`);
                        }
                    }

                    if (imageParts.length > 0 || dataParts.length > 0 || thinkingParts.length > 0) {
                        // 多模态消息：包含图片、数据或thinking（忽略cache_control）
                        const contentArray: ChatMessageContent[] = [];

                        // 添加文本内容
                        if (textParts.length > 0) {
                            contentArray.push({
                                type: 'text',
                                text: textParts.map(part => part.value).join('\n')
                            });
                        }

                        // 添加图片内容（根据模型能力决定）
                        if (imageParts.length > 0) {
                            const supportsImageInput = modelCapabilities?.imageInput !== false;

                            if (supportsImageInput) {
                                // 模型支持图像输入，添加图片内容
                                for (const imagePart of imageParts) {
                                    const dataUrl = this.createDataUrl(imagePart);
                                    contentArray.push({
                                        type: 'image_url',
                                        image_url: {
                                            url: dataUrl
                                        }
                                    });
                                }
                                Logger.debug(`已添加 ${imageParts.length} 个图片到支持图像的模型`);
                            } else {
                                // 模型不支持图像输入，将图片转换为文本描述
                                for (const imagePart of imageParts) {
                                    const imageDescription = `[图片: ${imagePart.mimeType}, ${imagePart.data.length} bytes - 模型不支持图片输入，已转换为文本描述]`;
                                    contentArray.push({
                                        type: 'text',
                                        text: imageDescription
                                    });
                                }
                                Logger.warn(`模型不支持图像输入，已将 ${imageParts.length} 个图片转换为文本描述`);
                            }
                        }

                        // 处理数据部分（将非图片数据转换为文本描述）
                        for (const dataPart of dataParts) {
                            const dataDescription = `[Data: ${dataPart.mimeType}, ${dataPart.data.length} bytes]`;
                            contentArray.push({
                                type: 'text',
                                text: dataDescription
                            });
                        }

                        // 处理thinking部分（将thinking内容包含在消息中）
                        for (const thinkingPart of thinkingParts) {
                            const part = thinkingPart as { value?: string };
                            if (part.value) {
                                Logger.trace(`处理Thinking内容: ${part.value.substring(0, 100)}...`);
                                // 将thinking作为内部思考过程，不直接发送给API
                                // 可以选择记录日志或在特定情况下包含
                            }
                        }

                        converted.content = contentArray;
                    } else if (textParts.length > 0) {
                        // 纯文本消息
                        converted.content = textParts.map(part => part.value).join('\n');
                    }
                }
            }

            // 特殊处理：system 消息必须是字符串格式（特别是为了 MoonshotAI 兼容性）
            if (role === 'system') {
                if (Array.isArray(converted.content)) {
                    // 将多模态 system 消息转换为纯文本
                    const textContent = converted.content
                        .map(item => {
                            if (item.type === 'text') {
                                return item.text;
                            } else if (item.type === 'image_url') {
                                return '[图片内容]';
                            } else {
                                return '[非文本内容]';
                            }
                        })
                        .join('\n');
                    converted.content = textContent;
                    Logger.debug(`System消息转换为纯文本格式: ${textContent.substring(0, 100)}...`);
                } else if (!converted.content) {
                    // 确保 system 消息有内容
                    converted.content = '';
                    Logger.warn('System消息没有内容，设置为空字符串');
                }
            }

            // 处理助手消息中的工具调用
            if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && Array.isArray(msg.content)) {
                const toolCalls = [];
                let textContent = '';

                for (const part of msg.content) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        textContent += part.value;
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        const toolCall = {
                            id: part.callId,
                            type: 'function' as const,
                            function: {
                                name: part.name,
                                arguments: JSON.stringify(part.input)
                            }
                        };
                        toolCalls.push(toolCall);
                        pendingToolCalls.add(part.callId); // 记录未响应的工具调用
                    }
                }

                if (toolCalls.length > 0) {
                    converted.tool_calls = toolCalls;
                }
                if (textContent) {
                    converted.content = textContent;
                }
            }

            // 只添加有有效内容的消息
            if (converted.content || converted.tool_calls || converted.role === 'system') {
                result.push(converted);
            }
        }

        // 检查是否有未响应的工具调用
        if (pendingToolCalls.size > 0) {
            Logger.warn(`警告: 检测到 ${pendingToolCalls.size} 个未响应的工具调用: ${Array.from(pendingToolCalls).join(', ')}`);

            // 移除包含未响应工具调用的助手消息，防止API错误
            for (let i = result.length - 1; i >= 0; i--) {
                const msg = result[i];
                if (msg.role === 'assistant' && msg.tool_calls) {
                    const hasUnresponded = msg.tool_calls.some(tc => pendingToolCalls.has(tc.id));
                    if (hasUnresponded) {
                        Logger.warn(`移除包含未响应工具调用的助手消息: ${msg.tool_calls.map(tc => tc.id).join(', ')}`);
                        result.splice(i, 1);
                    }
                }
            }
        }

        // 输出转换结果的详细统计
        const stats = this.getConversionStats(result);
        Logger.debug(`📊 消息转换完成: ${stats.summary}`);
        Logger.trace(`📈 详细统计:\n${JSON.stringify(stats.details, null, 2)}`);

        return result;
    }

    /**
     * 转换工具格式 - 增强的工具转换，确保参数格式正确
     */
    convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): Tool[] {
        Logger.debug(`🔧 开始转换 ${tools.length} 个工具定义`);

        const result = tools.map((tool, index) => {
            const paramCount = tool.inputSchema && typeof tool.inputSchema === 'object' && tool.inputSchema !== null
                ? Object.keys((tool.inputSchema as Record<string, unknown>).properties || {}).length
                : 0;

            Logger.trace(`🔧 工具 ${index}: ${tool.name}, 参数数量: ${paramCount}, 描述长度: ${(tool.description || '').length}`);

            return this.convertSingleTool(tool);
        });

        Logger.debug(`✅ 工具转换完成，共 ${result.length} 个工具`);
        return result;
    }

    /**
     * 转换单个工具
     */
    private convertSingleTool(tool: vscode.LanguageModelChatTool): Tool {
        const functionDef: Tool = {
            type: 'function' as const,
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
    }

    /**
     * 检查是否为图片MIME类型
     */
    private isImageMimeType(mimeType: string): boolean {
        return (
            mimeType.startsWith('image/') &&
            ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)
        );
    }

    /**
     * 创建图片的data URL
     */
    private createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        const base64Data = Buffer.from(dataPart.data).toString('base64');
        return `data:${dataPart.mimeType};base64,${base64Data}`;
    }

    /**
     * 获取转换结果的详细统计信息
     */
    private getConversionStats(messages: ChatMessage[]): {
        summary: string;
        details: {
            totalMessages: number;
            roleDistribution: Record<string, number>;
            contentLengths: { role: string; length: number; type: string }[];
            toolCallsCount: number;
            toolResultsCount: number;
            multiModalCount: number;
        };
    } {
        const roleDistribution: Record<string, number> = {};
        const contentLengths: { role: string; length: number; type: string }[] = [];
        let toolCallsCount = 0;
        let toolResultsCount = 0;
        let multiModalCount = 0;

        for (const msg of messages) {
            // 统计角色分布
            roleDistribution[msg.role] = (roleDistribution[msg.role] || 0) + 1;

            // 统计内容长度
            if (msg.content) {
                if (typeof msg.content === 'string') {
                    contentLengths.push({
                        role: msg.role,
                        length: msg.content.length,
                        type: 'text'
                    });
                } else if (Array.isArray(msg.content)) {
                    multiModalCount++;
                    const totalLength = msg.content.reduce((sum, item) => {
                        if (item.type === 'text' && item.text) {
                            return sum + item.text.length;
                        }
                        return sum;
                    }, 0);
                    contentLengths.push({
                        role: msg.role,
                        length: totalLength,
                        type: `multimodal(${msg.content.length}parts)`
                    });
                }
            }

            // 统计工具调用
            if (msg.tool_calls) {
                toolCallsCount += msg.tool_calls.length;
            }

            // 统计工具结果
            if (msg.role === 'tool') {
                toolResultsCount++;
            }
        }

        const totalLength = contentLengths.reduce((sum, item) => sum + item.length, 0);
        const summary = `${messages.length}条消息, ${totalLength}字符, ${toolCallsCount}个工具调用, ${toolResultsCount}个工具结果`;

        return {
            summary,
            details: {
                totalMessages: messages.length,
                roleDistribution,
                contentLengths,
                toolCallsCount,
                toolResultsCount,
                multiModalCount
            }
        };
    }
}
