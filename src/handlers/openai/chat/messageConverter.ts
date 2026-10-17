import * as vscode from 'vscode';
import OpenAI from 'openai';
import type { ModelConfig } from '../../../types/sharedTypes';
import { Logger } from '../../../utils/runtime/logger';
import { sanitizeToolSchema } from '../../../utils/text/schemaSanitizer';
import { decodeStatefulMarker } from '../../stateful/statefulMarker';
import { shouldInjectReasoningPlaceholder } from '../../reasoningPlaceholder';
import { GCMP_SYSTEM_MESSAGE_NAME, isStatefulMarkerMimeType } from '../../types';
import type { OpenAIProviderContext } from '../shared/providerContext';
import { isImageMimeType, createDataUrl } from '../shared/images';

/**
 * 扩展助手消息类型，支持 reasoning_content 字段
 */
interface ExtendedAssistantMessageParam extends OpenAI.Chat.ChatCompletionAssistantMessageParam {
    reasoning_content?: string;
}

/**
 * 从消息内容的 StatefulMarker 中提取 completeThinking
 */
function getMarkerReasoningState(content: vscode.LanguageModelChatMessage['content']): {
    completeThinking?: string;
    hasToolCalls?: boolean;
} {
    for (const part of content) {
        if (
            part instanceof vscode.LanguageModelDataPart &&
            isStatefulMarkerMimeType(part.mimeType) &&
            part.data instanceof Uint8Array
        ) {
            const marker = decodeStatefulMarker(part.data)?.marker;
            if (marker) {
                return {
                    completeThinking: marker.completeThinking,
                    hasToolCalls: marker.hasToolCalls
                };
            }
        }
    }
    return {};
}

export class OpenAIChatMessageConverter {
    constructor(private readonly providerInstance: Pick<OpenAIProviderContext, 'provider'>) {}

    private get provider(): string {
        return this.providerInstance.provider;
    }

    /**
     * 参照官方实现的消息转换 - 使用 OpenAI SDK 标准模式
     * 支持文本、图片和工具调用
     * 公共方法，可被其他 Provider 复用
     */
    convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        for (const message of messages) {
            const convertedMessage = this.convertSingleMessage(message, modelConfig);
            if (convertedMessage) {
                if (Array.isArray(convertedMessage)) {
                    result.push(...convertedMessage);
                } else {
                    result.push(convertedMessage);
                }
            }
        }
        return result;
    }

    /**
     * 转换单个消息 - 参照 OpenAI SDK 官方模式
     */
    public convertSingleMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[] | null {
        switch (message.role) {
            case vscode.LanguageModelChatMessageRole.System:
                return this.convertSystemMessage(message);
            case vscode.LanguageModelChatMessageRole.User:
                // GCMP 构造的系统提示词用 name=GCMP_SYSTEM_MESSAGE_NAME 标记，转为 OpenAI system 消息
                if (message.name === GCMP_SYSTEM_MESSAGE_NAME) {
                    return this.convertSystemMessage(message);
                }
                return this.convertUserMessage(message, modelConfig);
            case vscode.LanguageModelChatMessageRole.Assistant:
                return this.convertAssistantMessage(message, modelConfig);
            default:
                Logger.warn(`Unknown message role: ${message.role}`);
                return null;
        }
    }

    /**
     * 转换系统消息 - 参照官方 ChatCompletionSystemMessageParam
     */
    private convertSystemMessage(
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionSystemMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        if (!textContent) {
            return null;
        }
        return {
            role: 'system',
            content: textContent
        };
    }

    /**
     * 转换用户消息 - 支持多模态和工具结果
     */
    private convertUserMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const results: OpenAI.Chat.ChatCompletionMessageParam[] = [];
        // 处理文本和图片内容
        const userMessage = this.convertUserContentMessage(message, modelConfig);
        if (userMessage) {
            results.push(userMessage);
        }
        // 处理工具结果
        const toolMessages = this.convertToolResultMessages(message);
        results.push(...toolMessages);
        return results;
    }

    /**
     * 转换用户内容消息（文本+图片）
     */
    private convertUserContentMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionUserMessageParam | null {
        const textParts = message.content.filter(
            part => part instanceof vscode.LanguageModelTextPart
        ) as vscode.LanguageModelTextPart[];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        // 收集图片（如果支持）
        if (modelConfig?.capabilities?.imageInput === true) {
            // Logger.debug('Model supports image input, collecting image parts');
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelDataPart) {
                    // Logger.debug(`📷 发现数据部分: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    if (isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                        Logger.debug(`✅ Added image: MIME=${part.mimeType}, size=${part.data.length} bytes`);
                    } else {
                        // // 分类处理不同类型的数据
                        // if (part.mimeType === 'cache_control') {
                        //     Logger.trace('Ignoring Claude cache marker: cache_control');
                        // } else if (part.mimeType.startsWith('image/')) {
                        //     Logger.warn(`❌ 不支持的图像MIME类型: ${part.mimeType}`);
                        // } else {
                        //     Logger.trace(`📄 跳过非图像数据: ${part.mimeType}`);
                        // }
                    }
                } else {
                    // Logger.trace(`📝 非数据部分: ${part.constructor.name}`);
                }
            }
        }
        // 如果没有文本和图片内容，返回 null
        if (textParts.length === 0 && imageParts.length === 0) {
            return null;
        }
        if (imageParts.length > 0) {
            // 多模态消息：文本 + 图片
            Logger.debug(
                `🖼️ Building multimodal message: ${textParts.length} text parts + ${imageParts.length} image parts`
            );
            const contentArray: OpenAI.Chat.ChatCompletionContentPart[] = [];
            if (textParts.length > 0) {
                const textContent = textParts.map(part => part.value).join('\n');
                contentArray.push({
                    type: 'text',
                    text: textContent
                });
                Logger.trace(`📝 Added text content: ${textContent.length} chars`);
            }
            for (const imagePart of imageParts) {
                const dataUrl = createDataUrl(imagePart);
                contentArray.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
                Logger.trace(`📷 Added image URL: MIME=${imagePart.mimeType}, base64Length=${dataUrl.length} chars`);
            }
            Logger.debug(`✅ Multimodal message built: ${contentArray.length} content parts`);
            return { role: 'user', content: contentArray };
        } else {
            // 纯文本消息
            return {
                role: 'user',
                content: textParts.map(part => part.value).join('\n')
            };
        }
    }

    /**
     * 转换工具结果消息 - 使用 OpenAI SDK 标准类型
     */
    private convertToolResultMessages(
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionToolMessageParam[] {
        const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];
        const seenCallIds = new Set<string>();

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
                if (seenCallIds.has(part.callId)) {
                    Logger.warn(`Skipping duplicate tool_result callId: ${part.callId}`);
                    continue;
                }
                seenCallIds.add(part.callId);
                const toolContent = this.convertToolResultContent(part.content);
                // 使用 OpenAI SDK 标准的 ChatCompletionToolMessageParam 类型
                const toolMessage: OpenAI.Chat.ChatCompletionToolMessageParam = {
                    role: 'tool',
                    content: toolContent,
                    tool_call_id: part.callId
                };
                toolMessages.push(toolMessage);
                // Logger.debug(`添加工具结果: callId=${part.callId}, 内容长度=${toolContent.length}`);
            }
        }

        return toolMessages;
    }

    /**
     * 转换助手消息 - 处理文本和工具调用
     */
    private convertAssistantMessage(
        message: vscode.LanguageModelChatMessage,
        modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionAssistantMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        let thinkingContent: string | null = null;

        // 处理工具调用和思考内容（去重：同一 callId 只保留第一个）
        const seenCallIds = new Set<string>();
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                if (seenCallIds.has(part.callId)) {
                    Logger.warn(`Skipping duplicate tool_call_id: ${part.callId} (${part.name})`);
                    continue;
                }
                seenCallIds.add(part.callId);
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

        // 从消息中提取思考内容（若存在），用于兼容部分网关/模型的上下文传递。
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelThinkingPart) {
                // 处理思考内容，可能是字符串或字符串数组
                if (Array.isArray(part.value)) {
                    thinkingContent = part.value.join('');
                } else {
                    thinkingContent = part.value;
                }
                Logger.trace(`Extracted thinking content: ${thinkingContent.length} chars`);
                break; // 只取第一个思考内容部分
            }
        }

        // 如果 ThinkingPart 被 VS Code 剥离，则从 StatefulMarker 恢复 reasoning_content（对所有模型生效，
        // 服务端对与自身无关的 reasoning 会智能忽略）
        if (!thinkingContent) {
            const markerReasoning = getMarkerReasoningState(message.content);
            if (markerReasoning.completeThinking) {
                thinkingContent = markerReasoning.completeThinking;
                Logger.trace(`Restored reasoning_content from StatefulMarker: ${thinkingContent.length} chars`);
            } else if (shouldInjectReasoningPlaceholder({ providerKey: this.provider, modelConfig })) {
                thinkingContent = ' '; // 保底占位，避免兼容接口因为字段缺失直接报错
                Logger.trace('StatefulMarker thinking not found, using placeholder to fill reasoning_content');
            }
        }

        // 如果没有文本内容、思考内容和工具调用，返回 null
        if (!textContent && !thinkingContent && toolCalls.length === 0) {
            return null;
        }

        // 创建扩展的助手消息，支持 reasoning_content 字段
        const assistantMessage: ExtendedAssistantMessageParam = {
            role: 'assistant',
            content: textContent || null // 只包含普通文本内容，不包含思考内容
        };

        // 如果有思考内容，添加到 reasoning_content 字段
        if (thinkingContent) {
            assistantMessage.reasoning_content = thinkingContent;
            Logger.trace(`Added reasoning_content: ${thinkingContent.length} chars`);
        }

        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
            // Logger.debug(`Assistant消息包含 ${toolCalls.length} 个工具调用`);
        }

        return assistantMessage;
    }

    /**
     * 提取文本内容
     */
    private extractTextContent(
        content: readonly (
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelDataPart
            | vscode.LanguageModelToolCallPart
            | vscode.LanguageModelToolResultPart
            | vscode.LanguageModelThinkingPart
        )[]
    ): string | null {
        const textParts = content
            .filter(part => part instanceof vscode.LanguageModelTextPart)
            .map(part => (part as vscode.LanguageModelTextPart).value);
        return textParts.length > 0 ? textParts.join('\n') : null;
    }

    /**
     * 转换工具结果内容
     *
     * 仅保留有意义的语义内容：文本取 value，图片用 [Image] 占位符。
     * 其他所有 DataPart（cache_control / stateful_marker / thinking / context_management / usage
     * 等扩展内部元数据）一律跳过，不序列化，避免污染请求体和模型上下文。
     */
    private convertToolResultContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }
        if (content instanceof vscode.LanguageModelTextPart) {
            return content.value;
        }
        if (content instanceof vscode.LanguageModelDataPart) {
            // 图片用占位符，其他 DataPart 全部跳过
            return isImageMimeType(content.mimeType) ? '[Image]' : '';
        }
        if (Array.isArray(content)) {
            return content
                .flatMap(resultPart => {
                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                        return [resultPart.value];
                    }
                    if (resultPart instanceof vscode.LanguageModelDataPart && isImageMimeType(resultPart.mimeType)) {
                        return ['[Image]'];
                    }
                    // 其他 DataPart（扩展内部元数据）和其他非文本 part 统一跳过
                    return [];
                })
                .join('\n');
        }
        // 兜底：未知结构不序列化，返回空字符串
        return '';
    }

    /**
     * 工具转换 - 确保参数格式正确
     * 公共方法，可被其他 Provider 复用
     */
    public convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[] {
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
                    functionDef.function.parameters = sanitizeToolSchema(tool.inputSchema as Record<string, unknown>);
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
}
