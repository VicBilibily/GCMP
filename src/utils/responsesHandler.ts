/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API 处理器
 *  使用 OpenAI SDK 的 responses.create() 方法处理新一代 Responses API
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger, VersionManager } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ModelConfig } from '../types/sharedTypes';
import { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses.js';

/**
 * 图像数据格式（用于处理不同来源的图像输入）
 */
interface ImagePartData {
    uri?: vscode.Uri;
    mimeType?: string;
    data?: Uint8Array;
}

/**
 * Responses API 输入消息类型
 * 注意：Responses API 要求 content 必须是字符串，不支持数组格式
 */
interface InputMessage {
    role: 'user' | 'assistant';
    content: string;
}

/**
 * Responses API 输出项类型
 */
interface OutputItem {
    type: 'message' | 'function_call' | 'reasoning' | 'web_search_call' | 'file_search_call';
    id?: string;
    status?: 'in_progress' | 'completed' | 'incomplete';
    role?: string;
    content?: OutputContent[];
    name?: string;
    call_id?: string;
    arguments?: string;
}

/**
 * 输出内容类型
 */
interface OutputContent {
    type: 'output_text';
    text: string;
    annotations?: Annotation[];
}

/**
 * 注释类型
 */
interface Annotation {
    type: 'url_citation' | 'file_citation' | 'file_path';
    title?: string;
    url?: string;
    filename?: string;
    file_id?: string;
    start_index?: number;
    end_index?: number;
    index?: number;
}

/**
 * 推理摘要项类型
 */
interface ReasoningSummaryItem {
    type: 'summary_text';
    text: string;
}

/**
 * 使用统计类型
 */
interface UsageInfo {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
    };
}

/**
 * Responses API 处理器
 * 使用 OpenAI SDK 的 responses.create() 实现新一代 Responses API 支持
 */
export class ResponsesHandler {
    constructor(
        private provider: string,
        private displayName: string,
        private baseURL?: string
    ) {
        // provider、displayName 和 baseURL 由调用方传入
    }

    /**
     * 创建 OpenAI 客户端
     * 复用 OpenAIHandler 的逻辑，保持一致性
     */
    private async createClient(modelConfig?: ModelConfig): Promise<OpenAI> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }

        // 优先使用模型特定的baseUrl，如果没有则使用提供商级别的baseUrl
        let baseURL = modelConfig?.baseUrl || this.baseURL;

        // 针对智谱AI国际站进行 baseURL 覆盖设置
        if (providerKey === 'zhipu') {
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (baseURL && endpoint === 'api.z.ai') {
                baseURL = baseURL.replace('open.bigmodel.cn', 'api.z.ai');
            }
        }

        // 构建默认头部
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent('OpenAI-Responses')
        };

        // 处理模型级别的 customHeader
        const processedCustomHeader = ApiKeyManager.processCustomHeader(modelConfig?.customHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.debug(
                `${this.displayName} (Responses API) 应用自定义头部: ${JSON.stringify(modelConfig!.customHeader)}`
            );
        }

        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            defaultHeaders: defaultHeaders
        });

        Logger.debug(`${this.displayName} Responses API 客户端已创建，使用baseURL: ${baseURL}`);
        return client;
    }

    /**
     * 转换 VSCode 消息格式到 Responses API 的 input 格式
     * Responses API 支持简单字符串或消息数组
     * 注意：图像输入支持已实现但暂时禁用（暂时找不到支持图片消息处理的接口）
     */
    private convertMessagesToInput(messages: readonly vscode.LanguageModelChatMessage[]): string | InputMessage[] {
        // 如果只有一条用户消息且是纯文本，返回简单字符串
        if (messages.length === 1) {
            const msg = messages[0];
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                const textParts = msg.content.filter(part => part instanceof vscode.LanguageModelTextPart);
                if (textParts.length === msg.content.length && textParts.length === 1) {
                    return (textParts[0] as vscode.LanguageModelTextPart).value;
                }
            }
        }

        // 第一步：识别消息中的工具调用和结果，建立映射关系
        interface ToolCallInfo {
            messageIndex: number;
            callId: string;
            name: string;
            input: Record<string, unknown>;
        }
        interface ToolResultInfo {
            messageIndex: number;
            callId: string;
            content: string;
        }

        const toolCalls = new Map<string, ToolCallInfo>();
        const toolResults = new Map<string, ToolResultInfo>();

        // 扫描所有消息，收集工具调用和结果
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            for (const part of msg.content) {
                // 检测工具调用
                if (part instanceof vscode.LanguageModelToolCallPart) {
                    const callId = `call_${i}_${part.name}`;
                    toolCalls.set(callId, {
                        messageIndex: i,
                        callId: callId,
                        name: part.name,
                        input: part.input as Record<string, unknown>
                    });
                }

                // 检测工具结果
                const unknownPart = part as unknown as Record<string, unknown>;
                if (unknownPart.callId && Array.isArray(unknownPart.content)) {
                    const callId = unknownPart.callId as string;
                    const contentParts: string[] = [];
                    for (const contentItem of unknownPart.content as unknown[]) {
                        const item = contentItem as Record<string, unknown>;
                        if (item.value && typeof item.value === 'string') {
                            contentParts.push(item.value);
                        }
                    }
                    toolResults.set(callId, {
                        messageIndex: i,
                        callId: callId,
                        content: contentParts.join('\n\n')
                    });
                }
            }
        }

        // 第二步：转换消息，跳过只包含工具调用的 assistant 消息
        const convertedMessages: InputMessage[] = [];

        for (let index = 0; index < messages.length; index++) {
            const msg = messages[index];

            // 检查这个消息是否只包含工具调用
            const hasToolCall = msg.content.some(
                part => part instanceof vscode.LanguageModelToolCallPart
            );
            const hasOnlyToolCall =
                hasToolCall &&
                msg.content.every(
                    part =>
                        part instanceof vscode.LanguageModelToolCallPart ||
                        (part as unknown as Record<string, unknown>).mimeType === 'cache_control'
                );

            // 如果是只包含工具调用的 assistant 消息，跳过它
            if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && hasOnlyToolCall) {
                Logger.debug(
                    `${this.displayName} 跳过只包含工具调用的 assistant 消息 #${index + 1}（这是 API 生成的，不应发回）`
                );
                continue;
            }

            // 确定角色
            let role: 'user' | 'assistant';
            if (msg.role === vscode.LanguageModelChatMessageRole.User) {
                role = 'user';
            } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                role = 'assistant';
            } else {
                // Tool 角色的消息转换为 user 角色
                Logger.debug(
                    `${this.displayName} 将 Tool 角色消息转换为 user 角色 (消息 #${index + 1})`
                );
                role = 'user';
            }

            // 收集文本内容
            const textParts: string[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    textParts.push(`[思考: ${part.value}]`);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    // 如果到这里说明不是只包含工具调用的消息，添加工具调用描述
                    textParts.push(`[工具调用: ${part.name}(${JSON.stringify(part.input)})]`);
                } else {
                    // 处理工具结果
                    const unknownPart = part as unknown as Record<string, unknown>;

                    if (unknownPart.callId && Array.isArray(unknownPart.content)) {
                        const callId = unknownPart.callId as string;

                        // 查找对应的工具调用
                        const toolCall = toolCalls.get(callId);
                        if (toolCall) {
                            // 添加工具调用上下文
                            textParts.push(
                                `Tool call: ${toolCall.name}(${JSON.stringify(toolCall.input)})\nTool result:`
                            );
                        }

                        // 提取工具结果
                        for (const contentItem of unknownPart.content as unknown[]) {
                            const item = contentItem as Record<string, unknown>;
                            if (item.value && typeof item.value === 'string') {
                                textParts.push(item.value);
                            }
                        }
                    } else if (unknownPart.value && typeof unknownPart.value === 'string') {
                        textParts.push(unknownPart.value);
                    } else if (unknownPart.content && typeof unknownPart.content === 'string') {
                        textParts.push(unknownPart.content);
                    }
                }
            }

            // 合并内容
            const content = textParts.join('\n\n');
            const finalContent = content.trim() || '[空消息]';

            convertedMessages.push({
                role: role,
                content: finalContent
            });
        }

        Logger.debug(
            `${this.displayName} 消息转换完成: 原始 ${messages.length} 条 -> 转换后 ${convertedMessages.length} 条`
        );
        return convertedMessages;
    }

    /**
     * 构建 Responses API 请求参数
     */
    private buildRequestParams(
        input: string | InputMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        modelConfig: ModelConfig,
        modelId: string
    ): ResponseCreateParamsStreaming {
        const params: Partial<ResponseCreateParamsStreaming> & {
            model: string;
            input: string | Array<{ role: 'user' | 'assistant'; content: string }>;
            stream: true;
        } = {
            model: modelId,
            input: input,
            stream: true,
            temperature: ConfigManager.getTemperature(),
            top_p: ConfigManager.getTopP(),
            max_output_tokens: ConfigManager.getMaxTokensForModel(modelConfig.maxOutputTokens)
        };

        // 添加工具支持
        if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
            // Logger.trace(
            //     `${this.displayName} Responses API 原始工具列表:`,
            //     JSON.stringify(options.tools.map(t => ({ name: t.name, description: t.description })))
            // );
            params.tools = this.convertToolsToResponsesAPI([...options.tools]);
            params.tool_choice = 'auto';
            Logger.trace(`${this.displayName} Responses API 添加了 ${options.tools.length} 个工具`);
            // Logger.trace(`${this.displayName} Responses API 转换后的工具:`, JSON.stringify(params.tools));
        }

        // 合并 extraBody 参数（如果有）
        if (modelConfig.extraBody) {
            // 过滤核心参数
            const filteredExtraBody: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(modelConfig.extraBody)) {
                if (!['model', 'input', 'stream', 'messages'].includes(key)) {
                    filteredExtraBody[key] = value;
                }
            }
            Object.assign(params, filteredExtraBody);
            if (Object.keys(filteredExtraBody).length > 0) {
                Logger.trace(
                    `${this.displayName} Responses API 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`
                );
            }
        }

        // 应用 responsesConfig（如果有）
        if (modelConfig.responsesConfig) {
            const config = modelConfig.responsesConfig;
            if (config.truncation) {
                params.truncation = config.truncation;
            }
            if (config.store !== undefined) {
                params.store = config.store;
            }
        }

        return params;
    }

    /**
     * 转换 VSCode 工具定义到 Responses API 格式
     * Responses API 工具格式与 Chat Completions 不同，需要顶层 name 字段
     */
    private convertToolsToResponsesAPI(tools: vscode.LanguageModelChatTool[]): Array<{
        name: string;
        type: 'function';
        description?: string;
        parameters: Record<string, unknown> | null;
        strict: boolean | null;
    }> {
        return tools.map(tool => {
            // 验证工具名称
            if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
                Logger.error(`${this.displayName} 工具缺少有效的 name 字段:`, tool);
                throw new Error('工具必须有有效的 name 字段');
            }

            // 处理参数schema
            let parameters: Record<string, unknown> | null = null;
            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    parameters = tool.inputSchema as Record<string, unknown>;
                } else {
                    // 如果不是对象，提供默认schema
                    parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                // 默认schema
                parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return {
                name: tool.name,
                type: 'function' as const,
                description: tool.description || '',
                parameters: parameters,
                strict: null
            };
        });
    }

    /**
     * 处理流式响应
     * 使用 SDK 的 for await 迭代器处理事件流
     */
    private async handleStreamingResponse(
        stream: AsyncIterable<unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        modelConfig: ModelConfig
    ): Promise<{ usage?: UsageInfo; outputItems: OutputItem[] }> {
        let usage: UsageInfo | undefined = undefined;
        let currentReasoningId: string | null = null;
        const outputItems: OutputItem[] = [];

        try {
            let eventCount = 0;
            // SDK 提供的 for await 迭代器，已处理 SSE 解析
            for await (const event of stream) {
                eventCount++;
                // 检查取消请求
                if (token.isCancellationRequested) {
                    Logger.info(`${this.displayName} Responses API 请求已取消`);
                    break;
                }

                // 处理不同类型的事件（使用类型保护）
                const eventObj = event as Record<string, unknown>;
                const eventType = eventObj.type as string;

                switch (eventType) {
                    case 'response.created':
                    case 'response.in_progress':
                    case 'response.content_part.added':
                    case 'response.output_text.done':
                    case 'response.content_part.done':
                    case 'response.output_item.done':
                        // 静默处理这些流式事件
                        break;

                    case 'response.output_item.added': {
                        // 记录输出项
                        const addedItem = eventObj.item as OutputItem;
                        if (addedItem) {
                            outputItems.push(addedItem);
                            if (addedItem.type === 'reasoning') {
                                currentReasoningId = addedItem.id || null;
                            }
                        }
                        break;
                    }

                    case 'response.output_text.delta': {
                        // 报告文本增量 - 这是主要的内容流
                        const delta = eventObj.delta as string;
                        if (delta) {
                            progress.report(new vscode.LanguageModelTextPart(delta));
                        }
                        break;
                    }

                    // 工具调用参数的流式更新 - 静默处理，不需要日志
                    case 'response.function_call_arguments.delta':
                    case 'response.function_call_arguments.done':
                        break;

                    case 'response.completed': {
                        // 响应完成，处理最终的工具调用、annotations等
                        const completedResponse = eventObj.response as Record<string, unknown>;
                        Logger.info(`${this.displayName} Responses API 响应完成: ${completedResponse?.id}`);
                        usage = completedResponse?.usage as UsageInfo;

                        // 处理完成的输出项
                        const output = completedResponse?.output as OutputItem[];
                        if (output && output.length > 0) {
                            this.handleCompletedItems(output, progress, modelConfig);
                        }

                        // 处理推理内容
                        const reasoning = completedResponse?.reasoning as Record<string, unknown>;
                        const summary = reasoning?.summary as ReasoningSummaryItem[];
                        if (summary) {
                            this.handleReasoningSummary(summary, progress, currentReasoningId);
                        }
                        break;
                    }

                    case 'response.failed':
                    case 'response.cancelled': {
                        Logger.warn(`${this.displayName} Responses API 响应失败或取消: ${eventType}`);
                        const error = eventObj.error;
                        if (error) {
                            throw new Error(`Responses API 错误: ${JSON.stringify(error)}`);
                        }
                        break;
                    }

                    default:
                        Logger.debug(`${this.displayName} Responses API 未知事件类型: ${eventType}`, eventObj);
                        break;
                }
            }

            Logger.info(`${this.displayName} Responses API 流处理完成，共处理 ${eventCount} 个事件`);
        } catch (error) {
            Logger.error(`${this.displayName} Responses API 流处理错误:`, error);
            throw error;
        }

        return { usage, outputItems };
    }

    /**
     * 处理完成的输出项（工具调用、annotations等）
     */
    private handleCompletedItems(
        outputItems: OutputItem[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        _modelConfig: ModelConfig
    ): void {
        for (const item of outputItems) {
            if (item.type === 'function_call' && item.status === 'completed') {
                // 处理函数调用
                try {
                    Logger.debug(`${this.displayName} 工具调用详情:`, {
                        name: item.name,
                        call_id: item.call_id,
                        arguments: item.arguments
                    });
                    const args = JSON.parse(item.arguments!);
                    progress.report(new vscode.LanguageModelToolCallPart(item.call_id!, item.name!, args));
                    Logger.debug(`${this.displayName} 报告工具调用: ${item.name}`);
                } catch (error) {
                    Logger.error(`${this.displayName} 解析工具调用参数失败:`, error);
                }
            } else if (item.type === 'message') {
                // 处理消息中的 annotations
                for (const content of item.content || []) {
                    if (content.annotations && content.annotations.length > 0) {
                        this.handleAnnotations(content.annotations, progress);
                    }
                }
            }
        }
    }

    /**
     * 处理推理摘要
     */
    private handleReasoningSummary(
        summary: ReasoningSummaryItem[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        reasoningId: string | null
    ): void {
        for (const summaryItem of summary) {
            if (summaryItem.type === 'summary_text' && summaryItem.text) {
                progress.report(new vscode.LanguageModelThinkingPart(summaryItem.text, reasoningId || 'reasoning'));
                Logger.debug(`${this.displayName} 报告推理内容`);
            }
        }
    }

    /**
     * 处理 Annotations（文件引用、URL引用）
     */
    private handleAnnotations(
        annotations: Annotation[],
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>
    ): void {
        for (const annotation of annotations) {
            if (annotation.type === 'url_citation') {
                // URL 引用：添加为 markdown 链接
                const citation = `\n[${annotation.title}](${annotation.url})`;
                progress.report(new vscode.LanguageModelTextPart(citation));
                Logger.debug(`${this.displayName} 报告 URL 引用: ${annotation.url}`);
            } else if (annotation.type === 'file_citation') {
                // 文件引用
                const citation = `\n[引用: ${annotation.filename || annotation.file_id}]`;
                progress.report(new vscode.LanguageModelTextPart(citation));
                Logger.debug(`${this.displayName} 报告文件引用: ${annotation.filename}`);
            } else if (annotation.type === 'file_path') {
                // 文件路径
                const citation = `\n[文件: ${annotation.file_id}]`;
                progress.report(new vscode.LanguageModelTextPart(citation));
                Logger.debug(`${this.displayName} 报告文件路径`);
            }
        }
    }

    /**
     * 主请求处理方法
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken
    ): Promise<void> {
        try {
            // 创建客户端
            const client = await this.createClient(modelConfig);

            // 转换消息格式
            const input = this.convertMessagesToInput(messages);
            Logger.debug(
                `${this.displayName} Responses API 输入类型: ${typeof input === 'string' ? 'string' : 'array'}`
            );

            // 构建请求参数
            const modelId = modelConfig.model || model.id;
            const params = this.buildRequestParams(input, options, modelConfig, modelId);

            Logger.info(
                `${this.displayName} 发送 Responses API 请求，使用模型: ${modelId}, 消息数: ${Array.isArray(input) ? input.length : 1}`
            );

            // 调用 Responses API
            const stream = await client.responses.create(params);

            // 处理流式响应
            const result = await this.handleStreamingResponse(stream, progress, token, modelConfig);

            Logger.info(`${this.displayName} Responses API 请求完成`, result.usage);
        } catch (error) {
            Logger.error(`${this.displayName} Responses API 错误:`, error);

            // 提供详细的错误信息
            let errorMessage = `[${model.name}] Responses API 调用失败`;
            if (error instanceof Error) {
                if (error.message.includes('401')) {
                    errorMessage += ': API密钥无效，请检查配置';
                } else if (error.message.includes('429')) {
                    errorMessage += ': 请求频率限制，请稍后重试';
                } else if (
                    error.message.includes('500') ||
                    error.message.includes('502') ||
                    error.message.includes('503')
                ) {
                    errorMessage += ': 服务器错误，请稍后重试';
                } else {
                    errorMessage += `: ${error.message}`;
                }
            }

            throw new Error(errorMessage);
        }
    }
}
