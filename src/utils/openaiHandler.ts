/*---------------------------------------------------------------------------------------------
 *  OpenAI 兼容 API 处理器
 *  自实现 HTTP 请求和 SSE 流式解析，支持魔改接口格式
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { IncomingMessage, ClientRequest } from 'http';
import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * SSE 事件接口
 */
interface SSEEvent {
    id?: string;
    event?: string;
    data?: string;
}

/**
 * OpenAI 兼容 API 消息接口
 */
interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | ContentPart[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

/**
 * 内容部分接口
 */
interface ContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
    };
}

/**
 * 工具调用接口
 */
interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/**
 * 工具定义接口
 */
interface Tool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
    };
}

/**
 * 聊天完成请求参数接口
 */
interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    stream: boolean;
    stream_options?: { include_usage: boolean };
    temperature?: number;
    top_p?: number;
    tools?: Tool[];
    tool_choice?: string;
}

/**
 * 流式响应数据接口
 */
interface StreamDelta {
    role?: string;
    content?: string;
    tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: {
            name?: string;
            arguments?: string;
        };
    }[];
}

/**
 * 使用量统计接口
 */
interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/**
 * 工具调用累积器
 */
interface ToolCallAccumulator {
    [index: number]: {
        id: string;
        name: string;
        arguments: string;
    };
}

/**
 * OpenAI 兼容 API 处理器
 * 自实现 HTTP 请求和 SSE 流式解析，支持魔改接口格式和工具调用
 */
export class OpenAIHandler {
    private readonly userAgent: string;
    private readonly defaultTimeout = 60000;
    private cachedApiKeys = new Map<string, string>();

    // 当前请求处理状态
    private currentRequestId = 0;
    private currentAbortController: AbortController | null = null;

    constructor(
        private provider: string,
        private displayName: string,
        private baseURL?: string
    ) {
        this.userAgent = VersionManager.getUserAgent('OpenAIHandler');
    }

    /**
     * 处理聊天完成请求 - 使用自实现的流式 SSE 解析
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        Logger.debug(`${model.name} 开始处理 ${this.displayName} 请求`);

        // 终止之前的请求
        if (this.currentAbortController) {
            Logger.info(`${model.name} 终止之前的请求`);
            this.currentAbortController.abort();
        }

        // 创建新的 AbortController
        this.currentAbortController = new AbortController();
        this.currentRequestId++;

        try {
            const apiKey = await ApiKeyManager.getApiKey(this.provider);
            if (!apiKey) {
                throw new Error(`缺少 ${this.displayName} API密钥`);
            }

            Logger.debug(`${model.name} 发送 ${messages.length} 条消息，使用 ${this.displayName}`);

            // 构建请求参数
            const requestParams: ChatCompletionRequest = {
                model: model.id,
                messages: this.convertMessagesToOpenAI(messages, model.capabilities || undefined),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true },
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // 添加工具支持（如果有）
            if (options.tools && options.tools.length > 0 && model.capabilities?.toolCalling) {
                requestParams.tools = this.convertToolsToOpenAI([...options.tools]);
                requestParams.tool_choice = 'auto';
                Logger.trace(`${model.name} 添加了 ${options.tools.length} 个工具`);
            }

            // 输出转换后的消息统计信息
            const openaiMessages = requestParams.messages;
            const totalContentLength = openaiMessages.reduce((sum, msg) => {
                if (typeof msg.content === 'string') {
                    return sum + msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    return sum + msg.content.reduce((contentSum, item) => {
                        return contentSum + (item.text ? item.text.length : 0);
                    }, 0);
                }
                return sum;
            }, 0);
            const totalToolCalls = openaiMessages.reduce((sum, msg) => {
                return sum + (msg.tool_calls ? msg.tool_calls.length : 0);
            }, 0);
            Logger.info(`📊 ${model.name} 消息统计: ${openaiMessages.length}条消息, ${totalContentLength}字符, ${totalToolCalls}个工具调用`);

            // 详细消息调试信息
            openaiMessages.forEach((msg, index) => {
                const contentInfo = typeof msg.content === 'string'
                    ? `text(${msg.content.length}chars)`
                    : Array.isArray(msg.content)
                        ? `multimodal(${msg.content.length}parts)`
                        : 'no_content';
                const toolCallsInfo = msg.tool_calls ? msg.tool_calls.length : 0;
                const toolCallId = msg.tool_call_id ? msg.tool_call_id : 'none';
                Logger.trace(`💬 消息 ${index}: role=${msg.role}, content=${contentInfo}, tool_calls=${toolCallsInfo}, tool_call_id=${toolCallId}`);
                if (msg.tool_calls) {
                    msg.tool_calls.forEach(tc => {
                        const argsLength = tc.function.arguments ? tc.function.arguments.length : 0;
                        Logger.trace(`🔧 工具调用: ${tc.id} -> ${tc.function.name}(${argsLength}chars)`);
                    });
                }
            });

            Logger.info(`🚀 ${model.name} 发送 ${this.displayName} 请求`);

            // 执行流式请求
            await this.executeStreamRequest(requestParams, apiKey, progress, token, model.name);

            Logger.debug(`✅ ${model.name} ${this.displayName} 请求完成`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`${model.name} ${this.displayName} 请求失败: ${errorMessage}`);

            // 改进的错误处理
            if (error instanceof vscode.CancellationError) {
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                Logger.debug(`LanguageModelError详情: code=${error.code}, cause=${error.cause}`);
                throw error;
            } else {
                throw error;
            }
        } finally {
            // 清理当前请求
            this.currentAbortController = null;
        }
    }

    /**
     * 执行流式请求
     */
    private async executeStreamRequest(
        requestParams: ChatCompletionRequest,
        apiKey: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        modelName: string
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${this.baseURL}/chat/completions`);
            const requestData = JSON.stringify(requestParams);

            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const requestOptions = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestData),
                    'Authorization': `Bearer ${apiKey}`,
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'User-Agent': this.userAgent
                }
            };

            let hasReceivedContent = false;
            let buffer = '';
            const toolCallAccumulators: ToolCallAccumulator = {};

            // 设置超时
            const timeout = setTimeout(() => {
                request.destroy();
                reject(new Error('请求超时'));
            }, this.defaultTimeout);

            // 取消请求监听
            const cancellationListener = token.onCancellationRequested(() => {
                clearTimeout(timeout);
                request.destroy();
                reject(new vscode.CancellationError());
            });

            // 监听请求抢占
            const abortListener = () => {
                clearTimeout(timeout);
                cancellationListener.dispose();
                request.destroy();
                reject(new Error('请求被新请求抢占'));
            };

            if (this.currentAbortController) {
                this.currentAbortController.signal.addEventListener('abort', abortListener);
            }

            const request: ClientRequest = httpModule.request(requestOptions, (response: IncomingMessage) => {
                if (response.statusCode !== 200) {
                    clearTimeout(timeout);
                    cancellationListener.dispose();

                    let errorData = '';
                    response.on('data', (chunk) => {
                        errorData += chunk.toString();
                    });

                    response.on('end', () => {
                        Logger.error(`HTTP错误 ${response.statusCode}: ${errorData}`);
                        reject(new Error(`HTTP ${response.statusCode}: ${errorData}`));
                    });
                    return;
                }

                response.on('data', (chunk: Buffer) => {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    try {
                        buffer += chunk.toString();
                        const events = this.parseSSEEvents(buffer);

                        for (const event of events) {
                            if (event.data && event.data !== '[DONE]') {
                                this.processStreamChunk(event.data, progress, toolCallAccumulators, modelName);
                                hasReceivedContent = true;
                            }
                        }

                        // 简单清理：保留最后一个不完整的事件
                        const lastEventIndex = buffer.lastIndexOf('\n\n');
                        if (lastEventIndex !== -1) {
                            buffer = buffer.substring(lastEventIndex + 2);
                        }
                    } catch (error) {
                        Logger.error(`处理流数据错误: ${error}`);
                    }
                });

                response.on('end', () => {
                    clearTimeout(timeout);
                    cancellationListener.dispose();
                    if (this.currentAbortController) {
                        this.currentAbortController.signal.removeEventListener('abort', abortListener);
                    }

                    // 处理未完成的工具调用
                    this.finalizeToolCalls(toolCallAccumulators, progress);

                    if (!hasReceivedContent) {
                        Logger.warn(`${modelName} 没有接收到任何内容`);
                    }
                    resolve();
                });

                response.on('error', (error: Error) => {
                    clearTimeout(timeout);
                    cancellationListener.dispose();
                    if (this.currentAbortController) {
                        this.currentAbortController.signal.removeEventListener('abort', abortListener);
                    }
                    Logger.error(`响应错误: ${error}`);
                    reject(error);
                });
            });

            request.on('error', (error: Error) => {
                clearTimeout(timeout);
                cancellationListener.dispose();
                if (this.currentAbortController) {
                    this.currentAbortController.signal.removeEventListener('abort', abortListener);
                }
                Logger.error(`请求错误: ${error}`);
                reject(error);
            });

            request.write(requestData);
            request.end();
        });
    }

    /**
     * 解析 SSE 事件
     */
    private parseSSEEvents(data: string): SSEEvent[] {
        const events: SSEEvent[] = [];
        const lines = data.split('\n');
        let currentEvent: SSEEvent = {};

        for (const line of lines) {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith(':')) {
                continue; // 跳过注释
            }

            if (trimmedLine === '') {
                if (Object.keys(currentEvent).length > 0) {
                    events.push({ ...currentEvent });
                    currentEvent = {};
                }
                continue;
            }

            const colonIndex = trimmedLine.indexOf(':');
            if (colonIndex === -1) {
                continue;
            }

            const field = trimmedLine.substring(0, colonIndex).trim();
            let value = trimmedLine.substring(colonIndex + 1).trim();

            // 修复部分模型输出 "data:" 后不带空格的问题
            // 处理 "data:{json}" -> "data: {json}"
            if (field === 'data' && value.startsWith('{')) {
                // 这是修复后的数据，直接使用
            }

            switch (field) {
                case 'id':
                    currentEvent.id = value;
                    break;
                case 'event':
                    currentEvent.event = value;
                    break;
                case 'data':
                    currentEvent.data = currentEvent.data ? currentEvent.data + '\n' + value : value;
                    break;
            }
        }

        if (Object.keys(currentEvent).length > 0) {
            events.push({ ...currentEvent });
        }

        return events;
    }

    /**
     * 处理流式数据块
     */
    private processStreamChunk(
        data: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        toolCallAccumulators: ToolCallAccumulator,
        modelName: string
    ): void {
        try {
            const chunk = JSON.parse(data);

            // 处理使用量统计
            if (chunk.usage) {
                const usage: Usage = chunk.usage;
                Logger.info(`📊 ${modelName} Token使用: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`);
                return;
            }

            if (!chunk.choices || chunk.choices.length === 0) {
                Logger.trace(`${modelName} 收到无choices的数据块`);
                return;
            }

            const choice = chunk.choices[0];
            const delta: StreamDelta = choice.delta || {};

            // 处理文本内容
            if (delta.content) {
                progress.report(new vscode.LanguageModelTextPart(delta.content));
            }

            // 处理工具调用
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                    this.processToolCallDelta(toolCall, toolCallAccumulators, progress);
                }
            }

            // 处理结束原因
            if (choice.finish_reason) {
                Logger.debug(`${modelName} 流式响应结束: ${choice.finish_reason}`);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            const dataPreview = data.length > 200 ? `${data.substring(0, 200)}...` : data;

            Logger.error(`${modelName} 解析流式响应失败: ${errorMessage}`);
            Logger.trace(`${modelName} 失败数据: "${dataPreview}"`);

            // 尝试分析错误类型
            if (error instanceof SyntaxError && error.message.includes('Unterminated string')) {
                Logger.debug(`${modelName} JSON字符串截断错误，可能是网络数据包分片导致`);
            } else if (error instanceof SyntaxError && error.message.includes('Unexpected end')) {
                Logger.debug(`${modelName} JSON意外结束，可能是数据不完整`);
            }

            // 不抛出错误，继续处理其他数据块
        }
    }

    /**
     * 处理工具调用增量
     */
    private processToolCallDelta(
        toolCall: any,
        toolCallAccumulators: ToolCallAccumulator,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        const index = toolCall.index;

        if (!toolCallAccumulators[index]) {
            toolCallAccumulators[index] = {
                id: toolCall.id || `tool_call_${index}_${Date.now()}`,
                name: '',
                arguments: ''
            };
            Logger.debug(`🆕 初始化工具调用索引 [${index}]: ID=${toolCall.id || '自动生成'}`);
        }

        const accumulator = toolCallAccumulators[index];

        // 更新工具调用信息
        if (toolCall.id && toolCall.id !== accumulator.id) {
            Logger.debug(`🆔 更新工具ID [${index}]: ${accumulator.id} -> ${toolCall.id}`);
            accumulator.id = toolCall.id;
        }

        if (toolCall.function) {
            if (toolCall.function.name) {
                if (!accumulator.name) {
                    accumulator.name = toolCall.function.name;
                    Logger.debug(`🎯 设置工具名称 [${index}]: ${toolCall.function.name}`);
                } else if (accumulator.name !== toolCall.function.name) {
                    Logger.warn(`⚠️ 工具名称不一致 [${index}]: ${accumulator.name} != ${toolCall.function.name}`);
                }
            }
            if (toolCall.function.arguments) {
                const prevLength = accumulator.arguments.length;
                const newArguments = toolCall.function.arguments;

                // 检测并处理重复内容
                if (newArguments && accumulator.arguments) {
                    // 检查新内容是否与已有内容的结尾重复
                    let actualNewContent = newArguments;
                    const existingContent = accumulator.arguments;

                    // 寻找最长的重叠部分
                    for (let overlapLen = Math.min(newArguments.length, existingContent.length); overlapLen > 0; overlapLen--) {
                        const existingSuffix = existingContent.slice(-overlapLen);
                        const newPrefix = newArguments.slice(0, overlapLen);

                        if (existingSuffix === newPrefix) {
                            // 找到重叠，只添加非重叠部分
                            actualNewContent = newArguments.slice(overlapLen);
                            if (overlapLen > 0) {
                                Logger.debug(`🔄 检测到重复内容 [${index}]: 重叠${overlapLen}字符，跳过重复部分`);
                            }
                            break;
                        }
                    }

                    accumulator.arguments += actualNewContent;
                    Logger.trace(`🔧 工具参数增量 [${index}]: +${actualNewContent.length}字符 (原始${newArguments.length}字符) (${prevLength}->${accumulator.arguments.length})`);
                } else {
                    accumulator.arguments += newArguments;
                    Logger.trace(`🔧 工具参数增量 [${index}]: +${newArguments.length}字符 (${prevLength}->${accumulator.arguments.length})`);
                }
            }
        }

        // 输出当前状态
        Logger.trace(`🔧 工具调用状态 [${index}]: name="${accumulator.name}", args_len=${accumulator.arguments.length}, delta="${toolCall.function?.arguments || ''}"`);
    }

    /**
     * 完成工具调用处理
     */
    private finalizeToolCalls(
        toolCallAccumulators: ToolCallAccumulator,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>
    ): void {
        const processedCalls: string[] = [];
        const failedCalls: string[] = [];
        const recoveredCalls: string[] = [];
        let hasProcessed = false;

        for (const [index, accumulator] of Object.entries(toolCallAccumulators)) {
            Logger.debug(`🔍 检查工具调用 [${index}]: name="${accumulator.name}", id="${accumulator.id}", args_len=${accumulator.arguments?.length || 0}`);

            // 检查工具名称是否存在
            if (!accumulator.name || accumulator.name.trim() === '') {
                failedCalls.push(`unknown(incomplete, args_length=${accumulator.arguments?.length || 0})`);
                Logger.warn(`⚠️ 工具调用 [${index}] 缺少名称: ID=${accumulator.id}`);
                continue;
            }

            // 检查参数是否存在
            if (!accumulator.arguments || accumulator.arguments.trim() === '') {
                // 尝试使用空对象作为后备
                try {
                    progress.report(new vscode.LanguageModelToolCallPart(
                        accumulator.id,
                        accumulator.name,
                        {}
                    ));
                    recoveredCalls.push(`${accumulator.name}(${accumulator.id}, 空参数)`);
                    hasProcessed = true;
                    Logger.info(`🔄 工具调用恢复 [${index}]: ${accumulator.name} 使用空参数`);
                } catch (error) {
                    failedCalls.push(`${accumulator.name}(incomplete, args_length=0)`);
                    Logger.error(`工具调用恢复失败 [${index}]: ${accumulator.name}`, error instanceof Error ? error : undefined);
                }
                continue;
            }

            // 尝试解析参数
            try {
                let parsedArgs;
                const trimmedArgs = accumulator.arguments.trim();

                // 检查JSON的完整性
                if (!trimmedArgs.startsWith('{') || !trimmedArgs.endsWith('}')) {
                    Logger.warn(`⚠️ 工具调用 [${index}] JSON不完整: "${trimmedArgs.substring(0, 50)}${trimmedArgs.length > 50 ? '...' : ''}"`);

                    // 尝试修复JSON
                    let fixedArgs = trimmedArgs;
                    if (!fixedArgs.startsWith('{')) {
                        fixedArgs = '{' + fixedArgs;
                    }
                    if (!fixedArgs.endsWith('}')) {
                        fixedArgs = fixedArgs + '}';
                    }

                    try {
                        parsedArgs = JSON.parse(fixedArgs);
                        Logger.info(`🔧 JSON修复成功 [${index}]: ${accumulator.name}`);
                    } catch (fixError) {
                        // 修复失败，使用空对象
                        parsedArgs = {};
                        Logger.warn(`🔄 JSON修复失败，使用空对象 [${index}]: ${accumulator.name}`);
                    }
                } else {
                    parsedArgs = JSON.parse(trimmedArgs);
                }

                progress.report(
                    new vscode.LanguageModelToolCallPart(accumulator.id, accumulator.name, parsedArgs)
                );

                if (trimmedArgs !== accumulator.arguments.trim() || Object.keys(parsedArgs).length === 0) {
                    recoveredCalls.push(`${accumulator.name}(${accumulator.id})`);
                } else {
                    processedCalls.push(`${accumulator.name}(${accumulator.id})`);
                }
                hasProcessed = true;
                Logger.debug(`✅ 工具调用完成 [${index}]: ${accumulator.name} (ID: ${accumulator.id})`);

            } catch (error) {
                failedCalls.push(`${accumulator.name}(${accumulator.id})`);
                const errorMsg = error instanceof Error ? error.message : '未知错误';
                Logger.error(`工具调用参数解析失败 [${index}]: ${errorMsg}`);
                Logger.trace(`失败参数内容: "${accumulator.arguments}"`);

                // 最后的后备方案：使用空对象
                try {
                    progress.report(new vscode.LanguageModelToolCallPart(
                        accumulator.id,
                        accumulator.name,
                        {}
                    ));
                    recoveredCalls.push(`${accumulator.name}(${accumulator.id}, fallback)`);
                    hasProcessed = true;
                    Logger.info(`🔄 工具调用后备恢复 [${index}]: ${accumulator.name}`);
                } catch (fallbackError) {
                    Logger.error(`工具调用后备恢复也失败 [${index}]: ${accumulator.name}`, fallbackError instanceof Error ? fallbackError : undefined);
                }
            }
        }

        // 统计信息
        if (processedCalls.length > 0) {
            Logger.info(`✅ 成功处理工具调用: ${processedCalls.join(', ')}`);
        }
        if (recoveredCalls.length > 0) {
            Logger.info(`🔄 恢复处理工具调用: ${recoveredCalls.join(', ')}`);
        }
        if (failedCalls.length > 0) {
            Logger.warn(`❌ 工具调用处理失败: ${failedCalls.join(', ')}`);
        }

        if (!hasProcessed && Object.keys(toolCallAccumulators).length > 0) {
            Logger.warn(`⚠️ 所有工具调用都处理失败，总数: ${Object.keys(toolCallAccumulators).length}`);
        }
    }

    /**
     * 转换消息到 OpenAI 格式
     */
    private convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): ChatMessage[] {
        const result: ChatMessage[] = [];
        for (const message of messages) {
            const convertedMessage = this.convertSingleMessage(message, capabilities);
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
     * 转换单个消息
     */
    private convertSingleMessage(
        message: vscode.LanguageModelChatMessage,
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): ChatMessage | ChatMessage[] | null {
        switch (message.role) {
            case vscode.LanguageModelChatMessageRole.System:
                return this.convertSystemMessage(message);
            case vscode.LanguageModelChatMessageRole.User:
                return this.convertUserMessage(message, capabilities);
            case vscode.LanguageModelChatMessageRole.Assistant:
                return this.convertAssistantMessage(message);
            default:
                Logger.warn(`未知的消息角色: ${message.role}`);
                return null;
        }
    }

    /**
     * 转换系统消息
     */
    private convertSystemMessage(message: vscode.LanguageModelChatMessage): ChatMessage | null {
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
     * 转换用户消息
     */
    private convertUserMessage(
        message: vscode.LanguageModelChatMessage,
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): ChatMessage[] {
        const results: ChatMessage[] = [];

        // 处理文本和图片内容
        const userMessage = this.convertUserContentMessage(message, capabilities);
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
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): ChatMessage | null {
        const textParts = message.content.filter(
            (part) => part instanceof vscode.LanguageModelTextPart
        ) as vscode.LanguageModelTextPart[];

        const imageParts: vscode.LanguageModelDataPart[] = [];

        // 收集图片和其他数据部分（如果支持）
        if (capabilities?.imageInput === true) {
            Logger.debug('🖼️ 模型支持图像输入，开始收集图像部分');
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelDataPart) {
                    Logger.debug(`📷 发现数据部分: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    if (this.isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                        Logger.debug(`✅ 添加图像: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    } else if (part.mimeType === 'cache_control') {
                        // cache_control 处理策略：直接忽略，不输出任何内容
                        // 这是 Anthropic Claude 特有的缓存优化功能，对 OpenAI 兼容 API 无意义
                        Logger.trace('⚠️ 忽略Claude缓存标识: cache_control');
                    } else if (part.mimeType.startsWith('image/')) {
                        Logger.warn(`❌ 不支持的图像 MIME 类型: ${part.mimeType}`);
                    } else {
                        Logger.trace(`📄 跳过非图像数据: ${part.mimeType}`);
                    }
                } else {
                    Logger.trace(`📝 非数据部分: ${part.constructor.name}`);
                }
            }

            // 特别提示：如果没有找到图像但有非 cache_control 的数据部分
            const allDataParts = message.content.filter(part => part instanceof vscode.LanguageModelDataPart);
            const nonCacheDataParts = allDataParts.filter(part => {
                const dataPart = part as vscode.LanguageModelDataPart;
                return dataPart.mimeType !== 'cache_control';
            });
            if (nonCacheDataParts.length > 0 && imageParts.length === 0) {
                Logger.warn(`⚠️ 发现 ${nonCacheDataParts.length} 个非 cache_control 数据部分但没有有效图像，请检查图像附件格式`);
            }
        }

        // 如果没有文本和图片内容，返回 null
        if (textParts.length === 0 && imageParts.length === 0) {
            return null;
        }

        if (imageParts.length > 0) {
            // 多模态消息：文本 + 图片
            Logger.debug(`🖼️ 构建多模态消息: ${textParts.length}个文本部分 + ${imageParts.length}个图像部分`);
            const contentArray: ContentPart[] = [];

            if (textParts.length > 0) {
                const textContent = textParts.map(part => part.value).join('\n');
                contentArray.push({
                    type: 'text',
                    text: textContent
                });
            }

            for (const imagePart of imageParts) {
                const dataUrl = this.createDataUrl(imagePart);
                contentArray.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
                Logger.trace(`📷 添加图像 URL: MIME=${imagePart.mimeType}, Base64 长度=${dataUrl.length}字符`);
            }

            Logger.debug(`✅ 多模态消息构建完成: ${contentArray.length}个内容部分`);

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
     * 转换工具结果消息
     */
    private convertToolResultMessages(message: vscode.LanguageModelChatMessage): ChatMessage[] {
        const toolMessages: ChatMessage[] = [];

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
                const toolContent = this.convertToolResultContent(part.content);
                const toolMessage: ChatMessage = {
                    role: 'tool',
                    content: toolContent,
                    tool_call_id: part.callId
                };
                toolMessages.push(toolMessage);
                Logger.debug(`添加工具结果: callId=${part.callId}, 内容长度=${toolContent.length}`);
            }
        }

        return toolMessages;
    }

    /**
     * 转换助手消息
     */
    private convertAssistantMessage(message: vscode.LanguageModelChatMessage): ChatMessage | null {
        const textContent = this.extractTextContent(message.content);
        const toolCalls: ToolCall[] = [];

        // 处理工具调用
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

                Logger.debug(`添加工具调用: ${part.name} (ID: ${part.callId})`);
            }
        }

        // 如果没有内容和工具调用，返回 null
        if (!textContent && toolCalls.length === 0) {
            return null;
        }

        const assistantMessage: ChatMessage = {
            role: 'assistant',
            content: textContent || undefined
        };

        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls;
            Logger.debug(`Assistant消息包含 ${toolCalls.length} 个工具调用`);
        }

        return assistantMessage;
    }

    /**
     * 提取文本内容
     */
    private extractTextContent(content: readonly (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelToolResultPart)[]): string | null {
        const textParts = content
            .filter((part) => part instanceof vscode.LanguageModelTextPart)
            .map((part) => (part as vscode.LanguageModelTextPart).value);
        return textParts.length > 0 ? textParts.join('\n') : null;
    }

    /**
     * 转换工具结果内容
     */
    private convertToolResultContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map((resultPart) => {
                    if (resultPart instanceof vscode.LanguageModelTextPart) {
                        return resultPart.value;
                    }
                    return JSON.stringify(resultPart);
                })
                .join('\n');
        }

        return JSON.stringify(content);
    }

    /**
     * 工具转换
     */
    private convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): Tool[] {
        return tools.map((tool) => {
            const functionDef: Tool = {
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
                    // 默认schema
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
        // 标准化 MIME 类型
        const normalizedMime = mimeType.toLowerCase().trim();
        // 支持的图像类型
        const supportedTypes = [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/bmp',
            'image/svg+xml'
        ];

        const isImageCategory = normalizedMime.startsWith('image/');
        const isSupported = supportedTypes.includes(normalizedMime);

        // 调试日志
        if (isImageCategory && !isSupported) {
            Logger.warn(`🚫 图像类型未在支持列表中: ${mimeType}，支持的类型: ${supportedTypes.join(', ')}`);
        } else if (!isImageCategory && normalizedMime !== 'cache_control') {
            // 对于 cache_control（Claude 缓存标识）不记录调试信息，对其他非图像类型记录 trace 级别日志
            Logger.trace(`📄 非图像数据类型: ${mimeType}`);
        }

        return isImageCategory && isSupported;
    }

    /**
     * 创建图片的data URL
     */
    private createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        try {
            const base64Data = Buffer.from(dataPart.data).toString('base64');
            const dataUrl = `data:${dataPart.mimeType};base64,${base64Data}`;
            Logger.debug(`🔗 创建图像DataURL: MIME=${dataPart.mimeType}, 原始大小=${dataPart.data.length}字节, Base64大小=${base64Data.length}字符`);
            return dataUrl;
        } catch (error) {
            Logger.error(`❌ 创建图像DataURL失败: ${error}`);
            throw error;
        }
    }

    /**
     * 重置客户端
     */
    resetClient(): void {
        this.cachedApiKeys.clear();
        Logger.trace(`${this.displayName} Handler 已重置`);
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.resetClient();
        Logger.trace(`${this.displayName} OpenAIHandler 已清理`);
    }
}