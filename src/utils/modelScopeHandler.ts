/*---------------------------------------------------------------------------------------------
 *  ModelScope 魔搭社区 OpenAI 兼容 API 处理器
 *  不使用 SDK，直接实现原生 OpenAI 协议通讯，支持流式响应
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyManager, ConfigManager, Logger, VersionManager } from '../utils';

/**
 * OpenAI 兼容的消息格式
 */
interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | Array<{
        type: 'text' | 'image_url';
        text?: string;
        image_url?: { url: string };
    }>;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
}

/**
 * OpenAI 兼容的工具定义
 */
interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

/**
 * OpenAI 兼容的请求参数
 */
interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream: boolean;
    stream_options?: { include_usage: boolean };
    tools?: OpenAITool[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
}

/**
 * 错误类型枚举
 */
enum ErrorType {
    NETWORK_ERROR = 'network_error',
    TIMEOUT_ERROR = 'timeout_error',
    API_ERROR = 'api_error',
    PARSING_ERROR = 'parsing_error',
    QUOTA_ERROR = 'quota_error',
    AUTH_ERROR = 'auth_error',
    RATE_LIMIT_ERROR = 'rate_limit_error',
    MODEL_ERROR = 'model_error',
    UNKNOWN_ERROR = 'unknown_error'
}

/**
 * 重试配置
 */
interface RetryConfig {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    backoffMultiplier: number;
    retryableErrors: ErrorType[];
}

/**
 * 自定义错误类
 */
class ModelScopeError extends Error {
    constructor(
        public readonly type: ErrorType,
        message: string,
        public readonly statusCode?: number,
        public readonly retryable = false
    ) {
        super(message);
        this.name = 'ModelScopeError';
    }
}

/**
 * 响应验证结果
 */
interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * 类型安全检查器
 */
class TypeValidator {
    static isString(value: unknown): value is string {
        return typeof value === 'string';
    }

    static isNumber(value: unknown): value is number {
        return typeof value === 'number' && !isNaN(value);
    }

    static isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    static isArray(value: unknown): value is unknown[] {
        return Array.isArray(value);
    }

    static hasProperty<T extends Record<string, unknown>>(
        obj: T,
        key: string
    ): boolean {
        return Object.prototype.hasOwnProperty.call(obj, key);
    }
}

/**
 * 性能指标接口
 */
interface RequestMetrics {
    startTime: number;
    endTime?: number;
    duration?: number;
    tokensUsed?: {
        prompt: number;
        completion: number;
        total: number;
    };
    bytesTransferred?: number;
    retryCount: number;
}

/**
 * SSE 数据块接口
 */
interface SSEChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: 'function';
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

/**
 * ModelScope OpenAI Handler
 * 实现原生 OpenAI 协议通讯，不使用 SDK
 */
export class ModelScopeHandler {
    private readonly baseURL: string;
    private readonly provider: string;
    private readonly displayName: string;

    // 流式响应去重跟踪器（基于请求级别）
    private currentRequestProcessedEvents = new Set<string>();
    // 工具调用去重跟踪器
    private reportedToolCalls = new Set<string>();

    // 重试配置
    private readonly retryConfig: RetryConfig = {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 10000,
        backoffMultiplier: 2,
        retryableErrors: [
            ErrorType.NETWORK_ERROR,
            ErrorType.TIMEOUT_ERROR,
            ErrorType.RATE_LIMIT_ERROR
        ]
    };

    // 请求超时配置
    private readonly timeoutMs = 60000; // 60秒

    // SSE 处理配置
    private readonly sseConfig = {
        maxBufferSize: 1024 * 1024, // 1MB 缓冲区上限
        maxLineLength: 65536, // 64KB 单行上限
        backpressureThreshold: 100, // 背压阈值（每秒处理的事件数）
        connectionRetryDelay: 1000, // 连接重试延迟
        heartbeatInterval: 30000 // 心跳间隔
    };

    constructor(
        provider: string,
        displayName: string,
        baseURL: string
    ) {
        this.provider = provider;
        this.displayName = displayName;
        this.baseURL = baseURL;
    }

    /**
     * 处理聊天完成请求 - 使用原生 fetch 实现流式接口
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // 重置请求级别的事件去重跟踪器
        this.currentRequestProcessedEvents.clear();
        this.reportedToolCalls.clear();

        // 初始化性能指标
        const metrics: RequestMetrics = {
            startTime: Date.now(),
            retryCount: 0
        };

        // 创建 AbortController 用于取消请求
        const abortController = new AbortController();

        // 监听取消令牌
        const cancellationListener = token.onCancellationRequested(() => {
            Logger.trace(`${this.displayName} 请求被取消`);
            abortController.abort();
        });

        try {
            // 获取 API 密钥
            const apiKey = await ApiKeyManager.getApiKey(this.provider);
            if (!apiKey) {
                throw new ModelScopeError(
                    ErrorType.AUTH_ERROR,
                    `缺少 ${this.displayName} API密钥`
                );
            }

            // 验证输入参数
            this.validateRequest(model, messages, options);

            // 构建请求参数
            const requestParams: OpenAIRequest = {
                model: model.id,
                messages: this.convertMessagesToOpenAI(messages, {
                    toolCalling: typeof model.capabilities?.toolCalling === 'boolean' ? model.capabilities.toolCalling : false,
                    imageInput: typeof model.capabilities?.imageInput === 'boolean' ? model.capabilities.imageInput : false
                }),
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

            Logger.trace(`${this.displayName} 请求参数:`, {
                model: requestParams.model,
                messageCount: requestParams.messages.length,
                hasTools: !!requestParams.tools,
                maxTokens: requestParams.max_tokens
            });

            // 使用重试机制发送请求
            await this.executeWithRetry(
                () => this.sendAndProcessRequest(requestParams, apiKey, progress, abortController, metrics),
                metrics
            );

        } catch (error) {
            metrics.endTime = Date.now();
            metrics.duration = metrics.endTime - metrics.startTime;
            this.logMetrics(metrics, false);
            this.handleError(error);
        } finally {
            cancellationListener.dispose();
        }
    }

    /**
     * 验证请求参数
     */
    private validateRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions
    ): void {
        if (!model?.id) {
            throw new ModelScopeError(ErrorType.API_ERROR, '模型ID不能为空');
        }

        if (!messages || messages.length === 0) {
            throw new ModelScopeError(ErrorType.API_ERROR, '消息列表不能为空');
        }

        // 检查消息长度限制
        const totalMessageLength = messages.reduce((sum, msg) => {
            const content = typeof msg.content === 'string' ? msg.content :
                Array.isArray(msg.content) ? msg.content.map(p =>
                    p instanceof vscode.LanguageModelTextPart ? p.value : ''
                ).join('') : '';
            return sum + content.length;
        }, 0);

        if (totalMessageLength > 100000) { // 大约100k字符限制
            Logger.warn(`消息长度过长: ${totalMessageLength} 字符，可能影响性能`);
        }
    }

    /**
     * 带重试机制执行操作
     */
    private async executeWithRetry<T>(
        operation: () => Promise<T>,
        metrics: RequestMetrics
    ): Promise<T> {
        let lastError: Error;

        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                metrics.retryCount = attempt;
                return await operation();
            } catch (error) {
                lastError = error as Error;

                // 检查是否应该重试
                if (!this.shouldRetry(error as Error, attempt)) {
                    throw error;
                }

                // 计算重试延迟
                const delay = Math.min(
                    this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
                    this.retryConfig.maxDelay
                );

                Logger.warn(`${this.displayName} 请求失败，${delay}ms后重试 (${attempt + 1}/${this.retryConfig.maxRetries})`, error);

                // 等待重试
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError!;
    }

    /**
     * 判断是否应该重试
     */
    private shouldRetry(error: Error, attempt: number): boolean {
        if (attempt >= this.retryConfig.maxRetries) {
            return false;
        }

        if (error instanceof ModelScopeError) {
            return this.retryConfig.retryableErrors.includes(error.type) && error.retryable;
        }

        // 网络错误通常可以重试
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            return true;
        }

        return false;
    }

    /**
     * 发送请求并处理响应
     */
    private async sendAndProcessRequest(
        params: OpenAIRequest,
        apiKey: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        abortController: AbortController,
        metrics: RequestMetrics
    ): Promise<void> {
        const response = await this.sendStreamRequest(params, apiKey, abortController);
        await this.processStreamResponse(response, progress, abortController, metrics);

        metrics.endTime = Date.now();
        metrics.duration = metrics.endTime - metrics.startTime;
        this.logMetrics(metrics, true);
    }

    /**
     * 发送流式请求
     */
    private async sendStreamRequest(
        params: OpenAIRequest,
        apiKey: string,
        abortController: AbortController
    ): Promise<Response> {
        const userAgent = VersionManager.getUserAgent('Extension');

        try {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                    'User-Agent': userAgent,
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache'
                },
                body: JSON.stringify(params),
                signal: abortController.signal,
                // 添加超时处理
                ...(this.timeoutMs > 0 && {
                    // 注意：fetch timeout 需要通过 AbortController 实现
                })
            });

            if (!response.ok) {
                await this.handleHttpError(response);
            }

            return response;
        } catch (error) {
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    throw new ModelScopeError(
                        ErrorType.NETWORK_ERROR,
                        '请求被取消',
                        undefined,
                        false
                    );
                }

                if (error.message.includes('fetch')) {
                    throw new ModelScopeError(
                        ErrorType.NETWORK_ERROR,
                        `网络请求失败: ${error.message}`,
                        undefined,
                        true
                    );
                }
            }

            throw error;
        }
    }

    /**
     * 处理HTTP错误响应
     */
    private async handleHttpError(response: Response): Promise<never> {
        let errorData: { error?: { message?: string; code?: string }; message?: string } | undefined;
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

        try {
            const text = await response.text();
            try {
                errorData = JSON.parse(text);
                errorMessage = errorData?.error?.message || errorData?.message || errorMessage;
            } catch {
                errorMessage = text || errorMessage;
            }
        } catch {
            // 无法读取响应体
        }

        // 根据状态码分类错误
        let errorType: ErrorType;
        let retryable = false;

        switch (response.status) {
            case 400:
                errorType = ErrorType.API_ERROR;
                break;
            case 401:
                errorType = ErrorType.AUTH_ERROR;
                break;
            case 403:
                errorType = ErrorType.AUTH_ERROR;
                break;
            case 404:
                errorType = ErrorType.MODEL_ERROR;
                break;
            case 429:
                errorType = ErrorType.RATE_LIMIT_ERROR;
                retryable = true;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                errorType = ErrorType.NETWORK_ERROR;
                retryable = true;
                break;
            default:
                errorType = ErrorType.UNKNOWN_ERROR;
                retryable = response.status >= 500;
        }

        // 检查特定的错误代码
        if (errorData?.error?.code === 'insufficient_quota') {
            errorType = ErrorType.QUOTA_ERROR;
        }

        throw new ModelScopeError(
            errorType,
            errorMessage,
            response.status,
            retryable
        );
    }

    /**
     * 处理流式响应
     */
    private async processStreamResponse(
        response: Response,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        abortController: AbortController,
        metrics: RequestMetrics
    ): Promise<void> {
        if (!response.body) {
            throw new ModelScopeError(
                ErrorType.API_ERROR,
                '响应体为空'
            );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let bytesReceived = 0;
        let lastEventTime = Date.now();

        // 工具调用状态跟踪
        const toolCallsMap = new Map<number, {
            id?: string;
            name?: string;
            arguments: string;
        }>();

        // 超时处理
        const timeoutId = setTimeout(() => {
            Logger.warn(`${this.displayName} 流式响应超时`);
            abortController.abort();
        }, this.timeoutMs);

        // 心跳检测
        const heartbeatId = setInterval(() => {
            const now = Date.now();
            if (now - lastEventTime > this.sseConfig.heartbeatInterval) {
                Logger.warn(`${this.displayName} 流式响应心跳超时`);
                abortController.abort();
            }
        }, this.sseConfig.heartbeatInterval / 2);

        try {
            while (!abortController.signal.aborted) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                // 更新字节计数和最后事件时间
                bytesReceived += value.byteLength;
                metrics.bytesTransferred = bytesReceived;
                lastEventTime = Date.now();

                // 检查缓冲区大小
                if (buffer.length > this.sseConfig.maxBufferSize) {
                    Logger.warn(`${this.displayName} SSE缓冲区过大，清空重新开始`);
                    buffer = '';
                }

                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // 优化的行分割处理
                const lines = this.splitSSELines(buffer);
                buffer = lines.remainder;


                for (const line of lines.complete) {
                    if (abortController.signal.aborted) {
                        return;
                    }

                    await this.processSSELine(line, progress, toolCallsMap, metrics);
                }
            }

            // 处理剩余缓冲区内容
            if (buffer.trim()) {
                await this.processSSELine(buffer, progress, toolCallsMap, metrics);
            }

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.trace(`${this.displayName} 流式响应被取消`);
                return; // 正常取消，不抛出错误
            }

            throw new ModelScopeError(
                ErrorType.PARSING_ERROR,
                `流式响应处理失败: ${error instanceof Error ? error.message : String(error)}`,
                undefined,
                false
            );
        } finally {
            clearTimeout(timeoutId);
            clearInterval(heartbeatId);
            reader.releaseLock();
        }
    }

    /**
     * 优化的SSE行分割处理
     */
    private splitSSELines(buffer: string): { complete: string[]; remainder: string } {
        const lines = buffer.split('\n');
        const remainder = lines.pop() || '';

        // 过滤空行和过长的行
        const complete = lines.filter(line => {
            if (line.length > this.sseConfig.maxLineLength) {
                Logger.warn(`${this.displayName} SSE行过长，跳过: ${line.length} 字符`);
                return false;
            }
            return true;
        });

        return { complete, remainder };
    }

    /**
     * 处理单行 SSE 数据
     */
    private async processSSELine(
        line: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        toolCallsMap: Map<number, { id?: string; name?: string; arguments: string }>,
        metrics: RequestMetrics
    ): Promise<void> {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine === 'data: [DONE]') {
            return;
        }

        // 处理不同的 SSE 事件类型
        let dataLine = trimmedLine;

        if (trimmedLine.startsWith('event:')) {
            const eventType = trimmedLine.substring(6).trim();
            Logger.trace(`${this.displayName} SSE事件类型: ${eventType}`);
            return; // 事件类型行，记录但不处理
        } else if (trimmedLine.startsWith('data:')) {
            dataLine = trimmedLine.substring(5).trim();
        } else if (trimmedLine.startsWith('data: ')) {
            dataLine = trimmedLine.substring(6).trim();
        } else if (trimmedLine.startsWith('id:')) {
            // 事件ID，可用于去重和重连
            const eventId = trimmedLine.substring(3).trim();
            this.currentRequestProcessedEvents.add(eventId);
            return;
        } else if (trimmedLine.startsWith('retry:')) {
            // 重连时间提示
            const retryMs = parseInt(trimmedLine.substring(6).trim(), 10);
            if (!isNaN(retryMs)) {
                Logger.trace(`${this.displayName} SSE服务器建议重连时间: ${retryMs}ms`);
            }
            return;
        } else if (trimmedLine === '') {
            // 空行作为事件分隔符
            return;
        } else {
            return; // 跳过不识别的行
        }

        if (!dataLine || dataLine === '[DONE]') {
            return;
        }

        try {
            // 尝试解析JSON
            if (this.isValidJSON(dataLine)) {
                const chunk: SSEChunk = JSON.parse(dataLine);
                await this.processChunk(chunk, progress, toolCallsMap, metrics);
            } else {
                // 处理非JSON数据（某些服务可能发送纯文本）
                if (dataLine && dataLine !== '[DONE]') {
                    Logger.trace(`${this.displayName} 收到非JSON SSE数据: ${dataLine}`);
                }
            }
        } catch (error) {
            Logger.warn(`解析 SSE 数据失败: ${dataLine.substring(0, 200)}...`, error);
            // 尝试错误恢复
            await this.handleSSEParseError(dataLine, error as Error, progress);
        }
    }

    /**
     * 验证SSE数据块格式
     */
    private validateSSEChunk(data: unknown): ValidationResult {
        const result: ValidationResult = {
            isValid: true,
            errors: [],
            warnings: []
        };

        if (!TypeValidator.isObject(data)) {
            result.isValid = false;
            result.errors.push('数据块必须是对象');
            return result;
        }

        // 验证基本字段
        if (TypeValidator.hasProperty(data, 'id') && !TypeValidator.isString(data.id)) {
            result.warnings.push('id 字段应该是字符串');
        }

        if (TypeValidator.hasProperty(data, 'object') && !TypeValidator.isString(data.object)) {
            result.warnings.push('object 字段应该是字符串');
        }

        if (TypeValidator.hasProperty(data, 'created') && !TypeValidator.isNumber(data.created)) {
            result.warnings.push('created 字段应该是数字');
        }

        if (TypeValidator.hasProperty(data, 'model') && !TypeValidator.isString(data.model)) {
            result.warnings.push('model 字段应该是字符串');
        }

        // 验证 choices 数组
        if (TypeValidator.hasProperty(data, 'choices')) {
            if (!TypeValidator.isArray(data.choices)) {
                result.isValid = false;
                result.errors.push('choices 必须是数组');
            } else if (data.choices.length === 0) {
                result.warnings.push('choices 数组为空');
            } else {
                // 验证第一个 choice
                const choice = data.choices[0];
                if (!TypeValidator.isObject(choice)) {
                    result.errors.push('choice 必须是对象');
                    result.isValid = false;
                } else {
                    // 验证 delta
                    if (TypeValidator.hasProperty(choice, 'delta') && !TypeValidator.isObject(choice.delta)) {
                        result.warnings.push('delta 应该是对象');
                    }
                }
            }
        }

        // 验证 usage
        if (TypeValidator.hasProperty(data, 'usage')) {
            if (!TypeValidator.isObject(data.usage)) {
                result.warnings.push('usage 应该是对象');
            } else {
                const usage = data.usage;
                if (TypeValidator.hasProperty(usage, 'prompt_tokens') && !TypeValidator.isNumber(usage.prompt_tokens)) {
                    result.warnings.push('prompt_tokens 应该是数字');
                }
                if (TypeValidator.hasProperty(usage, 'completion_tokens') && !TypeValidator.isNumber(usage.completion_tokens)) {
                    result.warnings.push('completion_tokens 应该是数字');
                }
                if (TypeValidator.hasProperty(usage, 'total_tokens') && !TypeValidator.isNumber(usage.total_tokens)) {
                    result.warnings.push('total_tokens 应该是数字');
                }
            }
        }

        return result;
    }

    /**
     * 处理单个数据块
     */
    private async processChunk(
        chunk: SSEChunk,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        toolCallsMap: Map<number, { id?: string; name?: string; arguments: string }>,
        metrics: RequestMetrics
    ): Promise<void> {
        // 验证数据块格式
        const validation = this.validateSSEChunk(chunk);
        if (!validation.isValid) {
            Logger.warn(`${this.displayName} 数据块验证失败:`, validation.errors);
            return;
        }

        if (validation.warnings.length > 0) {
            Logger.trace(`${this.displayName} 数据块验证警告:`, validation.warnings);
        }

        // 更新使用量统计
        if (chunk.usage) {
            metrics.tokensUsed = {
                prompt: chunk.usage.prompt_tokens,
                completion: chunk.usage.completion_tokens,
                total: chunk.usage.total_tokens
            };
        }

        if (!chunk.choices || chunk.choices.length === 0) {
            return;
        }

        const choice = chunk.choices[0];
        const delta = choice.delta;

        // 处理文本内容
        if (delta.content) {
            if (TypeValidator.isString(delta.content)) {
                progress.report(new vscode.LanguageModelTextPart(delta.content));
            } else {
                Logger.warn(`${this.displayName} 非法的内容类型:`, typeof delta.content);
            }
        }

        // 处理工具调用
        if (delta.tool_calls) {
            if (TypeValidator.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                    if (this.validateToolCallDelta(toolCall)) {
                        await this.processToolCall(toolCall, progress, toolCallsMap);
                    }
                }
            } else {
                Logger.warn(`${this.displayName} tool_calls 应该是数组`);
            }
        }

        // 处理完成状态
        if (choice.finish_reason) {
            if (TypeValidator.isString(choice.finish_reason)) {
                await this.handleFinishReason(choice.finish_reason, progress, toolCallsMap);
            } else {
                Logger.warn(`${this.displayName} finish_reason 应该是字符串`);
            }
        }
    }

    /**
     * 处理工具调用
     */
    private async processToolCall(
        toolCall: { index: number; id?: string; function?: { name?: string; arguments?: string } },
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        toolCallsMap: Map<number, { id?: string; name?: string; arguments: string }>
    ): Promise<void> {
        const index = toolCall.index;

        if (!toolCallsMap.has(index)) {
            toolCallsMap.set(index, {
                id: toolCall.id,
                name: toolCall.function?.name,
                arguments: ''
            });
        }

        const callInfo = toolCallsMap.get(index)!;

        // 更新工具调用信息
        if (toolCall.id) {
            callInfo.id = toolCall.id;
        }
        if (toolCall.function?.name) {
            callInfo.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
            callInfo.arguments += toolCall.function.arguments;
        }

        // 检查是否可以立即报告工具调用（完整的工具调用信息）
        if (this.isToolCallComplete(callInfo)) {
            // 使用工具ID作为唯一标识符，避免重复报告同一个ID的工具调用
            const toolCallKey = callInfo.id!;

            Logger.trace(`工具调用完整: ${callInfo.name}, ID: ${callInfo.id}, 参数长度: ${callInfo.arguments.length}`);

            // 检查是否已经报告过这个工具调用
            if (!this.reportedToolCalls.has(toolCallKey)) {
                try {
                    await this.reportToolCall(callInfo, progress, toolCallKey);
                } catch (error) {
                    Logger.warn(`报告工具调用失败: ${callInfo.name}`, error);
                }
            } else {
                Logger.trace(`工具调用已报告，跳过: ${callInfo.name} (${callInfo.id})`);
            }
        }
    }

    /**
     * 验证工具调用delta格式
     */
    private validateToolCallDelta(toolCall: unknown): toolCall is {
        index: number;
        id?: string;
        type?: 'function';
        function?: {
            name?: string;
            arguments?: string;
        };
    } {
        if (!TypeValidator.isObject(toolCall)) {
            Logger.warn(`${this.displayName} 工具调用delta必须是对象`);
            return false;
        }

        if (!TypeValidator.hasProperty(toolCall, 'index') || !TypeValidator.isNumber(toolCall.index)) {
            Logger.warn(`${this.displayName} 工具调用delta缺少有效的index`);
            return false;
        }

        if (toolCall.index < 0 || toolCall.index > 100) {
            Logger.warn(`${this.displayName} 工具调用index超出范围: ${toolCall.index}`);
            return false;
        }

        if (TypeValidator.hasProperty(toolCall, 'id') && !TypeValidator.isString(toolCall.id)) {
            Logger.warn(`${this.displayName} 工具调用id必须是字符串`);
            return false;
        }

        if (TypeValidator.hasProperty(toolCall, 'type') && toolCall.type !== 'function') {
            Logger.warn(`${this.displayName} 不支持的工具调用类型: ${toolCall.type}`);
            return false;
        }

        if (TypeValidator.hasProperty(toolCall, 'function')) {
            if (!TypeValidator.isObject(toolCall.function)) {
                Logger.warn(`${this.displayName} function必须是对象`);
                return false;
            }

            const func = toolCall.function;
            if (TypeValidator.hasProperty(func, 'name') && !TypeValidator.isString(func.name)) {
                Logger.warn(`${this.displayName} function.name必须是字符串`);
                return false;
            }

            if (TypeValidator.hasProperty(func, 'arguments') && !TypeValidator.isString(func.arguments)) {
                Logger.warn(`${this.displayName} function.arguments必须是字符串`);
                return false;
            }
        }

        return true;
    }

    /**
     * 检查工具调用是否完整
     */
    private isToolCallComplete(callInfo: { id?: string; name?: string; arguments: string }): boolean {
        if (!callInfo.id || !callInfo.name || !callInfo.arguments) {
            return false;
        }

        // 验证工具名称格式
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(callInfo.name)) {
            Logger.warn(`非法工具名称: ${callInfo.name}`);
            return false;
        }

        // 简化的JSON验证——只检查是否是有效JSON
        try {
            const trimmed = callInfo.arguments.trim();

            // 只做基本的JSON解析检查
            const args = JSON.parse(trimmed);
            if (typeof args !== 'object' || args === null) {
                Logger.warn(`工具参数必须是对象: ${callInfo.name}`);
                return false;
            }

            return true;
        } catch {
            // 参数还未解析完成
            return false;
        }
    }

    /**
     * 报告工具调用
     */
    private async reportToolCall(
        callInfo: { id?: string; name?: string; arguments: string },
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        toolCallKey: string
    ): Promise<void> {
        if (!callInfo.id || !callInfo.name) {
            throw new Error('工具调用信息不完整');
        }

        const args = JSON.parse(callInfo.arguments);

        // 验证参数大小
        const argsStr = JSON.stringify(args);
        if (argsStr.length > 32768) { // 32KB 限制
            Logger.warn(`工具参数过大: ${callInfo.name}, ${argsStr.length} 字符`);
        }

        // 创建工具调用对象
        const toolCallPart = new vscode.LanguageModelToolCallPart(
            callInfo.id,
            callInfo.name,
            args
        );

        // 报告工具调用
        progress.report(toolCallPart);
        this.reportedToolCalls.add(toolCallKey);

        Logger.trace(`报告工具调用: ${callInfo.name} (${callInfo.id})`, {
            argumentsLength: argsStr.length,
            argumentsKeys: Object.keys(args)
        });
    }

    /**
     * 处理完成原因
     */
    private async handleFinishReason(
        finishReason: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        toolCallsMap: Map<number, { id?: string; name?: string; arguments: string }>
    ): Promise<void> {
        if (finishReason === 'tool_calls' && toolCallsMap.size > 0) {
            // 检查是否有未报告的工具调用（兜底处理）
            const unreportedCalls = Array.from(toolCallsMap.values())
                .filter(callInfo => this.isToolCallComplete(callInfo))
                .filter(callInfo => {
                    const toolCallKey = callInfo.id!;
                    return !this.reportedToolCalls.has(toolCallKey);
                });

            if (unreportedCalls.length > 0) {
                Logger.trace(`兜底处理 ${unreportedCalls.length} 个未报告的工具调用`);

                for (const callInfo of unreportedCalls) {
                    const toolCallKey = callInfo.id!;
                    try {
                        await this.reportToolCall(callInfo, progress, toolCallKey);
                    } catch (error) {
                        Logger.warn(`兜底报告工具调用失败: ${callInfo.name}`, error);
                    }
                }
            }
        }

        Logger.trace(`请求完成，原因: ${finishReason}`);
    }

    /**
     * 清理文本内容
     */
    private sanitizeTextContent(content: string): string {
        if (!content || typeof content !== 'string') {
            return '空消息';
        }

        // 移除控制字符
        // eslint-disable-next-line no-control-regex
        const cleaned = content.replace(/[\x00-\x1F\x7F]/g, '');

        // 限制长度
        if (cleaned.length > 100000) {
            Logger.warn(`消息内容过长，截断为 ${100000} 字符`);
            return cleaned.substring(0, 100000) + '...[truncated]';
        }

        return cleaned;
    }

    /**
     * 转换消息部分
     */
    private convertMessageParts(
        parts: readonly vscode.LanguageModelInputPart[],
        capabilities?: { toolCalling?: boolean; imageInput?: boolean }
    ): Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }> {
        const convertedParts: Array<{
            type: 'text' | 'image_url';
            text?: string;
            image_url?: { url: string };
        }> = [];

        for (const part of parts) {
            if (part instanceof vscode.LanguageModelTextPart) {
                const text = this.sanitizeTextContent(part.value);
                if (text) {
                    convertedParts.push({
                        type: 'text',
                        text
                    });
                }
            } else if (part instanceof vscode.LanguageModelDataPart && capabilities?.imageInput) {
                // 处理图像数据（如果支持）
                try {
                    const base64Data = Buffer.from(part.data).toString('base64');

                    // 验证图像大小
                    if (base64Data.length > 20 * 1024 * 1024) { // 20MB
                        Logger.warn('图像数据过大，跳过');
                        continue;
                    }

                    convertedParts.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${part.mimeType};base64,${base64Data}`
                        }
                    });
                } catch (error) {
                    Logger.warn('图像数据处理失败', error);
                }
            }
        }

        return convertedParts;
    }

    /**
     * 验证是否为有效的JSON字符串
     */
    private isValidJSON(str: string): boolean {
        if (!str || str.trim() === '' || str === '[DONE]') {
            return false;
        }

        try {
            JSON.parse(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 处理SSE解析错误
     */
    private async handleSSEParseError(
        dataLine: string,
        error: Error,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>
    ): Promise<void> {
        // 尝试修复常见的JSON错误
        const fixedData = this.tryFixJSON(dataLine);
        if (fixedData) {
            try {
                JSON.parse(fixedData); // 验证修复后的JSON是否有效
                Logger.trace(`${this.displayName} JSON修复成功`);
                // TODO: 这里可以重新处理修复后的数据
                return;
            } catch {
                // 修复失败，继续处理下一步
            }
        }

        // 如果是常见的错误模式，可以尝试生成错误信息
        if (dataLine.includes('error') || dataLine.includes('Error')) {
            progress.report(new vscode.LanguageModelTextPart(
                `\n[${this.displayName} 错误]: 数据解析失败\n`
            ));
        }
    }

    /**
     * 尝试修复常见的JSON错误
     */
    private tryFixJSON(data: string): string | null {
        // 移除常见的前缀和后缀
        let fixed = data.trim();

        // 移除BOM
        if (fixed.charCodeAt(0) === 0xFEFF) {
            fixed = fixed.slice(1);
        }

        // 尝试修复未闭合的括号
        const openBraces = (fixed.match(/{/g) || []).length;
        const closeBraces = (fixed.match(/}/g) || []).length;

        if (openBraces > closeBraces) {
            fixed += '}'.repeat(openBraces - closeBraces);
        }

        // 验证修复结果
        try {
            JSON.parse(fixed);
            return fixed;
        } catch {
            return null;
        }
    }

    /**
     * 记录性能指标
     */
    private logMetrics(metrics: RequestMetrics, success: boolean): void {
        const logData = {
            provider: this.displayName,
            duration: metrics.duration,
            retryCount: metrics.retryCount,
            success,
            tokensUsed: metrics.tokensUsed,
            bytesTransferred: metrics.bytesTransferred
        };

        if (success) {
            Logger.trace(`${this.displayName} 请求成功:`, logData);
        } else {
            Logger.warn(`${this.displayName} 请求失败:`, logData);
        }

        // 性能监控警告
        if (metrics.duration && metrics.duration > 30000) {
            Logger.warn(`${this.displayName} 请求耗时过长: ${metrics.duration}ms`);
        }

        if (metrics.retryCount > 0) {
            Logger.warn(`${this.displayName} 请求重试 ${metrics.retryCount} 次`);
        }
    }

    /**
     * 转换 VS Code 消息为 OpenAI 格式
     */
    private convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        capabilities?: { toolCalling?: boolean; imageInput?: boolean }
    ): OpenAIMessage[] {
        return messages.map(msg => {
            // 正确转换角色枚举为字符串
            let role: 'system' | 'user' | 'assistant' | 'tool';
            switch (msg.role) {
                case vscode.LanguageModelChatMessageRole.System:
                    role = 'system';
                    break;
                case vscode.LanguageModelChatMessageRole.User:
                    role = 'user';
                    break;
                case vscode.LanguageModelChatMessageRole.Assistant:
                    role = 'assistant';
                    break;
                default:
                    role = 'user'; // 默认为 user
                    break;
            }

            const openaiMsg: OpenAIMessage = {
                role: role,
                content: ''
            };

            // 处理消息内容
            if (typeof msg.content === 'string') {
                openaiMsg.content = this.sanitizeTextContent(msg.content);
            } else if (Array.isArray(msg.content)) {
                // 处理多模态内容
                const parts = this.convertMessageParts(msg.content, capabilities);
                openaiMsg.content = parts.length > 0 ? parts : '空消息';
            } else {
                openaiMsg.content = '空消息';
            }

            return openaiMsg;
        });
    }

    /**
     * 转换 VS Code 工具为 OpenAI 格式
     */
    private convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAITool[] {
        return tools
            .filter(tool => this.validateTool(tool))
            .map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || `Execute ${tool.name} function`,
                    parameters: this.sanitizeToolSchema(tool.inputSchema as Record<string, unknown>)
                }
            }));
    }

    /**
     * 验证工具定义
     */
    private validateTool(tool: vscode.LanguageModelChatTool): boolean {
        if (!tool.name || typeof tool.name !== 'string') {
            Logger.warn('工具名称不能为空');
            return false;
        }

        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(tool.name)) {
            Logger.warn(`非法工具名称: ${tool.name}`);
            return false;
        }

        if (tool.name.length > 64) {
            Logger.warn(`工具名称过长: ${tool.name}`);
            return false;
        }

        return true;
    }

    /**
     * 清理工具架构
     */
    private sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
        // 确保架构有基本的结构
        if (!schema || typeof schema !== 'object') {
            return {
                type: 'object',
                properties: {},
                required: []
            };
        }

        // 确保有 type 字段
        if (!schema.type) {
            schema.type = 'object';
        }

        // 确保有 properties 字段
        if (!schema.properties) {
            schema.properties = {};
        }

        return schema;
    }

    /**
     * 处理错误
     */
    private handleError(error: unknown): never {
        const err = error as { code?: string };
        if (err?.code === 'insufficient_quota') {
            Logger.warn('配额不足，请检查API余额');
        } else if (err?.code === 'invalid_api_key') {
            Logger.warn('API密钥无效，请检查密钥设置');
        } else if (err?.code === 'rate_limit_exceeded') {
            Logger.warn('请求频率过高，请稍后重试');
        } else if (err?.code === 'model_not_found') {
            Logger.warn('模型未找到或不可用');
        } else {
            Logger.error(`${this.displayName} 请求失败:`, error);
        }

        throw error;
    }
}