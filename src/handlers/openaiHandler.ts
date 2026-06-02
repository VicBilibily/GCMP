/*---------------------------------------------------------------------------------------------
 *  OpenAI SDK 处理器
 *  使用 OpenAI SDK 实现流式聊天完成
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger, VersionManager, sanitizeToolSchemaForTarget, createOpenCodeHeaders } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { t } from '../utils/l10n';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelChatResponseOptions, ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { StreamReporter } from './streamReporter';
import { getReasoningReplayPolicy, shouldInjectReasoningPlaceholder } from './reasoningReplayPolicy';
import { decodeStatefulMarker } from './statefulMarker';
import { CustomDataPartMimeTypes } from './types';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type { CommitChatModelOptions } from '../commit';

/**
 * 扩展Delta类型以支持reasoning_content字段
 */
export interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
}

/**
 * 扩展Choice类型以支持兼容旧格式的message字段
 */
interface ExtendedChoice extends OpenAI.Chat.Completions.ChatCompletionChunk.Choice {
    message?: {
        content?: string;
        reasoning_content?: string;
    };
}

interface ParsedSSEChoice {
    message?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    finish_reason?: unknown;
    index?: number | null;
}

interface ParsedSSEResponsePayload {
    object?: string;
    output?: unknown[];
}

interface ParsedSSEItemPayload {
    type?: string;
    content?: unknown[];
}

interface ParsedSSEChunk {
    choices?: ParsedSSEChoice[];
    type?: string;
    response?: ParsedSSEResponsePayload;
    item?: ParsedSSEItemPayload;
    output_index?: number | null;
}

function normalizeResponsesOutput(response?: ParsedSSEResponsePayload): boolean {
    if (!response) {
        return false;
    }

    let modified = false;
    if (!Array.isArray(response.output)) {
        response.output = [];
        modified = true;
    }

    for (const outputItem of response.output) {
        if (!outputItem || typeof outputItem !== 'object') {
            continue;
        }

        const item = outputItem as ParsedSSEItemPayload;
        if (item.type === 'message' && !Array.isArray(item.content)) {
            item.content = [];
            modified = true;
        }
    }

    return modified;
}

/**
 * 扩展助手消息类型，支持 reasoning_content 字段
 */
interface ExtendedAssistantMessageParam extends OpenAI.Chat.ChatCompletionAssistantMessageParam {
    reasoning_content?: string;
}

/**
 * OpenAI API 错误详情类型
 */
interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

/**
 * OpenAI APIError 类型（包含 error 属性）
 */
interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
    status?: number;
    headers?: Headers;
}

/**
 * OpenAI SDK 处理器
 * 使用 OpenAI SDK 实现流式聊天完成，支持工具调用
 */
export class OpenAIHandler {
    // SDK事件去重跟踪器（基于请求级别）
    private currentRequestProcessedEvents = new Set<string>();

    constructor(private providerInstance: GenericModelProvider) {
        // providerInstance 提供动态获取 providerConfig 和 providerKey 的能力
    }
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }
    private get baseURL(): string | undefined {
        return this.providerConfig?.baseUrl;
    }

    /**
     * 创建新的 OpenAI 客户端
     */
    async createOpenAIClient(modelConfig?: ModelConfig): Promise<OpenAI> {
        // 优先级：model.provider -> this.provider
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', this.displayName));
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

        // 构建默认头部，包含自定义头部
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent('OpenAI')
        };

        // 合并提供商级别和模型级别的 customHeader
        // 模型级别的 customHeader 会覆盖提供商级别的同名头部
        const mergedCustomHeader = {
            ...this.providerConfig?.customHeader,
            ...modelConfig?.customHeader
        };

        // 处理合并后的 customHeader
        const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.debug(`${this.displayName} applying custom headers: ${JSON.stringify(mergedCustomHeader)}`);
        }

        let customFetch: typeof fetch | undefined = undefined; // 使用默认 fetch 实现
        customFetch = this.createCustomFetch(modelConfig, baseURL); // 使用自定义 fetch 解决 SSE 格式问题
        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            defaultHeaders: defaultHeaders,
            fetch: customFetch
        });
        Logger.trace(`${this.displayName} OpenAI SDK client created with baseURL: ${baseURL}`);
        return client;
    }

    /**
     * 创建自定义 fetch 函数来处理非标准 SSE 格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     * 若 modelConfig.endpoint 已设置，则将 SDK 内部构造的请求 URL 替换为自定义端点
     */
    private createCustomFetch(modelConfig?: ModelConfig, resolvedBaseURL?: string): typeof fetch {
        return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            let requestUrl: string | URL | Request = url;
            // 若配置了自定义 endpoint，则覆盖 SDK 内部构造的请求 URL
            if (modelConfig?.endpoint) {
                const customEndpoint = modelConfig.endpoint;
                if (customEndpoint.startsWith('http://') || customEndpoint.startsWith('https://')) {
                    // 完整 URL，直接使用
                    requestUrl = customEndpoint;
                } else {
                    // 相对路径，拼接到 baseURL
                    const base = (resolvedBaseURL || '').replace(/\/$/, '');
                    requestUrl = `${base}${customEndpoint.startsWith('/') ? customEndpoint : `/${customEndpoint}`}`;
                }
                Logger.debug(`Custom endpoint: ${String(url)} -> ${String(requestUrl)}`);
            }
            // 调用原始 fetch
            const response = await fetch(requestUrl, init);
            // 当前插件的所有调用都是流请求，直接预处理所有响应
            // preprocessSSEResponse 现在是异步的，可能会抛出错误以便上层捕获
            return await this.preprocessSSEResponse(response);
        };
    }

    /**
     * 兼容部分网关在 JSON 字符串字面量中直接输出控制字符，导致 OpenAI SDK 的 SSE JSON.parse 提前失败。
     * 仅在字符串上下文中转义 U+0000-U+001F，不改动正常 JSON 结构。
     */
    private escapeControlCharsInJsonString(input: string): { text: string; changed: boolean } {
        let changed = false;
        let inString = false;
        let isEscaped = false;
        let output = '';

        for (const char of input) {
            if (!inString) {
                if (char === '"') {
                    inString = true;
                }
                output += char;
                continue;
            }

            if (isEscaped) {
                output += char;
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                output += char;
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
                output += char;
                continue;
            }

            const code = char.charCodeAt(0);
            if (code <= 0x1f) {
                changed = true;
                switch (char) {
                    case '\b':
                        output += '\\b';
                        break;
                    case '\f':
                        output += '\\f';
                        break;
                    case '\n':
                        output += '\\n';
                        break;
                    case '\r':
                        output += '\\r';
                        break;
                    case '\t':
                        output += '\\t';
                        break;
                    default:
                        output += `\\u${code.toString(16).padStart(4, '0')}`;
                        break;
                }
                continue;
            }

            output += char;
        }

        return { text: output, changed };
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    private async preprocessSSEResponse(response: Response): Promise<Response> {
        let contentType = response.headers.get('Content-Type');

        // 对于非 200 状态码的响应，尝试读取错误信息
        if (!response.ok && response.status >= 400) {
            const text = await response.text();
            let errorMessage = text || `HTTP ${response.status} ${response.statusText}`;

            // 尝试解析 JSON 格式的错误
            if (text && text.trim().startsWith('{')) {
                try {
                    const errorJson = JSON.parse(text);
                    if (errorJson.error) {
                        if (typeof errorJson.error === 'string') {
                            errorMessage = errorJson.error;
                        } else if (errorJson.error.message) {
                            errorMessage = errorJson.error.message;
                        }
                    }
                } catch {
                    // 如果解析失败，使用原始文本
                }
            }

            // 抛出包含详细错误信息的 Error
            const error = new Error(errorMessage);
            (error as APIErrorWithError).status = response.status;
            (error as APIErrorWithError).headers = response.headers;
            throw error;
        }

        // 如果返回 application/json，读取 body 并直接抛出 Error，让上层 chat 接收到异常
        if (contentType && contentType.includes('application/json')) {
            const text = await response.text();
            // 直接抛出 Error（上层会捕获并显示），不要自己吞掉或构造假 Response
            // 尝试解析错误消息，提取有用的信息
            let errorMessage = text || `HTTP ${response.status} ${response.statusText}`;
            try {
                const errorJson = JSON.parse(text);
                if (errorJson.error) {
                    if (typeof errorJson.error === 'string') {
                        errorMessage = errorJson.error;
                    } else if (errorJson.error.message) {
                        errorMessage = errorJson.error.message;
                    }
                }
            } catch {
                // 如果解析失败，使用原始文本
            }
            throw new Error(errorMessage);
        }
        if (response?.url?.endsWith('/responses') && !contentType && response.body) {
            // 兼容 /responses 端点缺少 Content-Type 的情况。
            // 整体流程：
            // 1. 只读取少量前缀字节进行类型探测，避免像 response.text() 那样一次性吞掉整条流。
            // 2. 若前缀像 JSON（常见于直接返回 {"error": ...}），则把剩余 body 继续读完，尽量拿到完整错误信息后抛出。
            // 3. 若前缀像 SSE（data:/event:/id:/retry:/: 注释），则把已读前缀缓存回放到新流，再继续读取剩余内容，保持后续仍是流式处理。
            // 4. 若前缀不是标准 SSE 字段而是裸 JSON，则直接视为异常响应并抛出，不兼容非标准 SSE。
            // 5. 若探测阶段连接已结束且内容仍无法判定，则保留原样返回，由后续通用分支决定如何处理。
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const bufferedChunks: Uint8Array[] = [];
            let bufferedLength = 0;
            let sniffedText = '';
            let streamEndedDuringProbe = false;

            const looksLikeSSEPrefix = (text: string): boolean => {
                const trimmed = text.trimStart();
                return /^(data|event|id|retry):|^:/.test(trimmed);
            };

            try {
                while (bufferedLength < 512) {
                    const { done, value } = await reader.read();
                    if (done) {
                        streamEndedDuringProbe = true;
                        break;
                    }
                    if (!value || value.length === 0) {
                        continue;
                    }
                    bufferedChunks.push(value);
                    bufferedLength += value.length;
                    sniffedText += decoder.decode(value, { stream: true });

                    const trimmed = sniffedText.trimStart();
                    if (trimmed.startsWith('{') || looksLikeSSEPrefix(trimmed)) {
                        break;
                    }
                }
                sniffedText += decoder.decode();
            } finally {
                reader.releaseLock();
            }

            const trimmedText = sniffedText.trimStart();
            if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
                if (!streamEndedDuringProbe) {
                    const remainingReader = response.body.getReader();
                    try {
                        while (true) {
                            const { done, value } = await remainingReader.read();
                            if (done) {
                                break;
                            }
                            if (!value || value.length === 0) {
                                continue;
                            }
                            bufferedChunks.push(value);
                            sniffedText += decoder.decode(value, { stream: true });
                        }
                        sniffedText += decoder.decode();
                    } finally {
                        remainingReader.releaseLock();
                    }
                }

                throw new Error(sniffedText || `HTTP ${response.status} ${response.statusText}`);
            }

            const clonedHeaders = new Headers(response.headers);
            if (looksLikeSSEPrefix(trimmedText)) {
                clonedHeaders.set('Content-Type', 'text/event-stream');
                contentType = 'text/event-stream';
            }

            const remainingReader = response.body.getReader();
            const prependBufferedStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of bufferedChunks) {
                        controller.enqueue(chunk);
                    }
                },
                async pull(controller) {
                    try {
                        while (true) {
                            const { done, value } = await remainingReader.read();
                            if (done) {
                                controller.close();
                                break;
                            }
                            if (value) {
                                controller.enqueue(value);
                                break;
                            }
                        }
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel() {
                    remainingReader.releaseLock();
                }
            });

            response = new Response(prependBufferedStream, {
                status: response.status,
                statusText: response.statusText,
                headers: clonedHeaders
            });
        }
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            // 只处理 SSE 响应，其他类型直接返回原始 response
            return response;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const displayName = this.displayName;
        const escapeControlCharsInJsonString = this.escapeControlCharsInJsonString.bind(this);
        const processSSELine = (line: string): string => {
            const trimmedLine = line.trimStart();
            if (
                !trimmedLine.startsWith('data:') &&
                !trimmedLine.startsWith('event:') &&
                !trimmedLine.startsWith('id:') &&
                !trimmedLine.startsWith('retry:') &&
                !trimmedLine.startsWith(':') &&
                (trimmedLine.startsWith('{') || trimmedLine.startsWith('['))
            ) {
                const malformedSSEError = new Error(trimmedLine);
                malformedSSEError.name = 'SSEFatalError';
                throw malformedSSEError;
            }

            const normalizedLine = line.replace(/^data:([^\s])/g, 'data: $1');
            if (!normalizedLine.startsWith('data:')) {
                return normalizedLine;
            }

            const dataMatch = normalizedLine.match(/^data:\s?(.*)$/);
            if (!dataMatch) {
                return normalizedLine;
            }

            const jsonStr = dataMatch[1];
            if (!jsonStr || jsonStr === '[DONE]') {
                return normalizedLine;
            }

            let candidateJson = jsonStr;
            try {
                let obj: ParsedSSEChunk;
                try {
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                } catch (parseError) {
                    const escaped = escapeControlCharsInJsonString(candidateJson);
                    if (!escaped.changed) {
                        throw parseError;
                    }
                    candidateJson = escaped.text;
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                    Logger.debug(
                        `${displayName} SSE event contained unescaped control characters; auto-fixed and continued parsing`
                    );
                }

                if (obj.type === 'codex.rate_limits') {
                    const rateLimits = (
                        obj as ParsedSSEChunk & {
                            rate_limits?: { allowed?: boolean; limit_reached?: boolean };
                        }
                    ).rate_limits;
                    const rateLimitError = new Error(
                        rateLimits?.allowed === false || rateLimits?.limit_reached === true ?
                            '429 Rate limit exceeded'
                        :   'Unexpected codex.rate_limits event returned instead of chat content'
                    );
                    rateLimitError.name = 'SSEFatalError';
                    throw rateLimitError;
                }

                let objModified = false;

                //#region OpenAI Chat Completion 兼容性处理
                if (obj && Array.isArray(obj.choices)) {
                    for (const ch of obj.choices) {
                        if (ch && ch.message && (!ch.delta || Object.keys(ch.delta).length === 0)) {
                            ch.delta = ch.message;
                            delete ch.message;
                            objModified = true;
                        }
                    }
                }

                if (obj.choices && obj.choices.length > 0) {
                    for (let choiceIndex = obj.choices.length - 1; choiceIndex >= 0; choiceIndex--) {
                        const choice = obj.choices[choiceIndex];
                        if (choice?.finish_reason) {
                            if (!choice.delta || Object.keys(choice.delta).length === 0) {
                                Logger.trace(
                                    `preprocessSSEResponse received finish_reason only (choice ${choiceIndex}); added empty content to delta`
                                );
                                choice.delta = { role: 'assistant', content: '' };
                                objModified = true;
                            }
                            if (!choice.delta.role) {
                                choice.delta.role = 'assistant';
                                objModified = true;
                            }
                        }
                        if (choice?.delta && Object.keys(choice.delta).length === 0) {
                            if (choice?.finish_reason) {
                                continue;
                            }
                            Logger.trace(`preprocessSSEResponse removed invalid delta (choice ${choiceIndex})`);
                            obj.choices.splice(choiceIndex, 1);
                            objModified = true;
                        }
                    }

                    if (obj.choices.length === 1) {
                        for (const choice of obj.choices) {
                            if (choice.index == null || choice.index !== 0) {
                                choice.index = 0;
                                objModified = true;
                            }
                        }
                    }
                }
                //#endregion

                //#region OpenAI Response 事件兼容性处理
                if (
                    (obj.type === 'response.created' ||
                        obj.type === 'response.completed' ||
                        obj.type === 'response.failed' ||
                        obj.type === 'response.incomplete') &&
                    obj.response?.object === 'response'
                ) {
                    if (normalizeResponsesOutput(obj.response)) {
                        objModified = true;
                    }
                } else if (
                    (obj.type === 'response.output_item.added' || obj.type === 'response.output_item.done') &&
                    obj.item?.type === 'message' &&
                    !Array.isArray(obj.item.content)
                ) {
                    obj.item.content = [];
                    objModified = true;
                } else if (obj.type === 'response.content_part.added' && obj.output_index == null) {
                    obj.output_index = 0;
                    objModified = true;
                }
                //#endregion

                if (objModified || candidateJson !== jsonStr) {
                    return `data: ${JSON.stringify(obj)}`;
                }

                return normalizedLine;
            } catch (parseError) {
                if (parseError instanceof Error && parseError.name === 'SSEFatalError') {
                    throw parseError;
                }
                Logger.trace(`JSON parsing failed: ${parseError}`);
                return normalizedLine;
            }
        };

        // 行缓冲区：用于累积不完整的 SSE 行
        let lineBuffer = '';
        let malformedJsonStreamBuffer = '';
        let isMalformedJsonStream = false;

        const transformedStream = new ReadableStream({
            start: async controller => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (isMalformedJsonStream) {
                                throw new Error(malformedJsonStreamBuffer.trim() || lineBuffer.trim());
                            }
                            // 流结束时，处理缓冲区剩余的内容
                            if (lineBuffer.trim().length > 0) {
                                Logger.trace(
                                    `Stream ended, processing remaining buffered content: ${lineBuffer.length} chars`
                                );
                                const remaining = processSSELine(lineBuffer);
                                controller.enqueue(encoder.encode(remaining));
                            }
                            controller.close();
                            break;
                        }

                        // 解码 chunk
                        const chunk = decoder.decode(value, { stream: true });

                        if (isMalformedJsonStream) {
                            malformedJsonStreamBuffer += chunk;
                            continue;
                        }

                        // 将新内容追加到缓冲区
                        lineBuffer += chunk;

                        const trimmedBuffer = lineBuffer.trimStart();
                        if (
                            trimmedBuffer.length > 0 &&
                            !trimmedBuffer.startsWith('data:') &&
                            !trimmedBuffer.startsWith('event:') &&
                            !trimmedBuffer.startsWith('id:') &&
                            !trimmedBuffer.startsWith('retry:') &&
                            !trimmedBuffer.startsWith(':') &&
                            (trimmedBuffer.startsWith('{') || trimmedBuffer.startsWith('['))
                        ) {
                            isMalformedJsonStream = true;
                            malformedJsonStreamBuffer = lineBuffer;
                            lineBuffer = '';
                            continue;
                        }

                        // 按行分割，保留最后一行（可能不完整）
                        const lines = lineBuffer.split(/\n/);
                        // 保留最后一个元素（可能是不完整的行）
                        const lastLine = lines.pop() || '';
                        lineBuffer = lastLine;

                        // 处理完整的行
                        if (lines.length > 0) {
                            const processedChunk = `${lines.map(processSSELine).join('\n')}\n`;

                            // Logger.trace(`预处理后的 SSE chunk: ${processedChunk.length} 字符`);
                            // 重新编码并传递有效内容
                            controller.enqueue(encoder.encode(processedChunk));
                        }
                    }
                } catch (error) {
                    // 确保错误能够被正确传播
                    controller.error(error);
                } finally {
                    reader.releaseLock();
                }
            },
            cancel() {
                // 当流被取消时，确保释放 reader
                reader.releaseLock();
            }
        });

        return new Response(transformedStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }

    /**
     * 构建聊天完成请求参数（共享方法，供 openai-sse 等自定义处理器复用）
     */
    buildChatCompletionParams(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions
    ): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
        const requestModel = modelConfig.model || modelConfig.id;
        const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: requestModel,
            messages: this.convertMessagesToOpenAI(messages, modelConfig),
            max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
            stream: true,
            stream_options: { include_usage: true }
        };

        // 添加工具支持（如果有）
        if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
            createParams.tools = this.convertToolsToOpenAI([...options.tools]);
        }

        // 合并 extraBody 参数（如果有），过滤掉不可修改的核心参数
        if (modelConfig.extraBody) {
            const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
            Object.assign(createParams, filteredExtraBody);
        }

        // 根据模型配置设置思考模式和推理长度
        const settings = options.modelConfiguration as ModelChatResponseOptions;
        const customParams = createParams as unknown as {
            enable_thinking?: boolean;
            thinking?: { type: 'enabled' | 'disabled' };
            reasoning_effort?: string;
        };
        const thinkingFormat = modelConfig.thinkingFormat ?? 'boolean';
        if (settings) {
            if (settings.thinking && (!thinkingFormat || thinkingFormat === 'boolean' || thinkingFormat === 'object')) {
                if (settings.thinking === 'enabled') {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = { type: 'enabled' };
                    } else {
                        customParams.enable_thinking = true;
                    }
                } else if (settings.thinking === 'disabled') {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = { type: 'disabled' };
                    } else {
                        customParams.enable_thinking = false;
                    }
                } else {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = undefined;
                    } else {
                        customParams.enable_thinking = undefined;
                    }
                }
            }
            if (settings.reasoningEffort) {
                if (settings.reasoningEffort === 'none') {
                    customParams.reasoning_effort = undefined;
                    if (modelConfig.thinkingFormat === 'object' || modelConfig.thinkingFormat === 'object-none') {
                        customParams.thinking = { type: 'disabled' };
                    }
                } else {
                    customParams.reasoning_effort = settings.reasoningEffort;
                    if (modelConfig.thinkingFormat === 'object' && settings.reasoningEffort !== 'minimal') {
                        customParams.thinking = { type: 'enabled' };
                    }
                }
            }
        }
        // 如果处于提交模式，模型支持思考的，不使用思考模式
        const modelOpts = options.modelOptions as CommitChatModelOptions;
        if (modelOpts?.commit) {
            if (thinkingFormat === 'object' || thinkingFormat === 'object-none') {
                customParams.thinking = { type: 'disabled' };
                customParams.reasoning_effort = undefined;
            } else {
                if (customParams.enable_thinking) {
                    customParams.enable_thinking = false;
                }
            }
            if (customParams.thinking === undefined && customParams.reasoning_effort) {
                let effort: 'none' | 'minimal' | undefined;
                if (modelConfig.reasoningEffort?.includes('none')) {
                    effort = 'none';
                } else if (modelConfig.reasoningEffort?.includes('minimal')) {
                    effort = 'minimal';
                }
                if (effort && modelConfig.reasoningEffort?.indexOf(effort) === 0) {
                    customParams.enable_thinking = undefined;
                    customParams.reasoning_effort = effort;
                }
            }
        }

        return createParams;
    }

    /**
     * 处理聊天完成请求 - 使用 OpenAI SDK 流式接口
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        Logger.debug(`${model.name} starting ${this.displayName} request handling`);
        // 清理当前请求的事件去重跟踪器
        this.currentRequestProcessedEvents.clear();

        try {
            const client = await this.createOpenAIClient(modelConfig);
            Logger.debug(`${model.name} sending ${messages.length} messages using ${this.displayName}`);

            const createParams = this.buildChatCompletionParams(model, modelConfig, messages, options);

            Logger.info(`🚀 ${model.name} Sending ${this.displayName} request`);

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress,
                sessionId
            });

            // 使用 OpenAI SDK 的事件驱动流式方法，利用内置工具调用处理
            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null; // 用于捕获流错误
            // 保存最后一个 chunk 的 usage 信息（若有），部分提供商会在每个 chunk 返回 usage
            let finalUsage: OpenAI.Completions.CompletionUsage | undefined = undefined;
            // 记录流处理的开始和结束时间
            let streamStartTime: number | undefined = undefined;
            let streamEndTime: number | undefined = undefined;

            try {
                // opencode 专有：传递请求级跟踪标识头
                const streamOptions: Record<string, unknown> = { signal: abortController.signal };
                if (this.provider === 'opencode') {
                    streamOptions.headers = createOpenCodeHeaders(requestId, sessionId);
                }

                const stream = client.chat.completions.stream(createParams, streamOptions);
                // 利用 SDK 内置的事件系统处理工具调用和内容
                stream
                    .on('chunk', (chunk, _snapshot: unknown) => {
                        // 记录首个 chunk 的时间作为流开始时间
                        if (streamStartTime === undefined) {
                            streamStartTime = Date.now();
                        }

                        // 处理token使用统计：仅保存到 finalUsage，最后再统一输出
                        if (chunk.usage) {
                            // 直接保存 SDK 返回的 usage 对象（类型为 CompletionUsage）
                            finalUsage = chunk.usage;
                        }

                        // 处理思考内容（reasoning_content）和兼容旧格式：有些模型把最终结果放在 choice.message
                        // 思维链是可重入的：遇到时输出；在后续第一次可见 content 输出前，需要结束当前思维链（done）
                        if (chunk.choices && chunk.choices.length > 0) {
                            // 遍历所有choices，处理每个choice的reasoning_content和message.content
                            for (const choice of chunk.choices) {
                                const extendedChoice = choice as ExtendedChoice;
                                const delta = extendedChoice.delta as ExtendedDelta | undefined;
                                const message = extendedChoice.message;

                                // 处理工具调用 - 支持分块数据的累积处理
                                if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                    for (const toolCall of delta.tool_calls) {
                                        const toolIndex = toolCall.index ?? 0;
                                        reporter.accumulateToolCall(
                                            toolIndex,
                                            toolCall.id,
                                            toolCall.function?.name,
                                            toolCall.function?.arguments
                                        );
                                    }
                                }

                                // 兼容：优先使用 delta 中的 reasoning_content，否则尝试从 message 中读取
                                const reasoningContent = delta?.reasoning_content ?? message?.reasoning_content;
                                if (reasoningContent) {
                                    reporter.bufferThinking(reasoningContent);
                                }

                                // 检查同一个 chunk 中是否有 delta.content（文本内容）
                                const deltaContent = delta?.content;
                                if (deltaContent && typeof deltaContent === 'string') {
                                    reporter.reportText(deltaContent);
                                }

                                // 另外兼容：如果服务端把最终文本放在 message.content（旧/混合格式），当作 content 增量处理
                                const messageContent = message?.content;
                                if (typeof messageContent === 'string' && messageContent.length > 0) {
                                    reporter.reportText(messageContent);
                                }
                            }
                        }
                    })
                    .on('error', (error: Error) => {
                        // 保存错误，并中止请求
                        streamError = error;
                        abortController.abort();
                    });
                // 等待流处理完成
                await stream.done();

                // 记录流结束时间
                streamEndTime = Date.now();

                // 流结束，输出所有剩余内容
                reporter.flushAll(null);

                // 检查是否有流错误
                if (streamError) {
                    throw streamError;
                }

                reporter.reportUsage(finalUsage);

                // 计算并记录输出速度
                const usageData = finalUsage as OpenAI.Completions.CompletionUsage | undefined;
                if (usageData && streamStartTime && streamEndTime) {
                    const duration = streamEndTime - streamStartTime;
                    const outputTokens = usageData.completion_tokens ?? 0;
                    const speed = duration > 0 ? ((outputTokens / duration) * 1000).toFixed(1) : 'N/A';
                    Logger.info(
                        `📊 ${model.name} OpenAI request completed, output=${outputTokens} tokens, duration=${duration}ms, speed=${speed} tokens/s`,
                        usageData
                    );
                } else {
                    Logger.info(`📊 ${model.name} OpenAI request completed`, finalUsage);
                }

                if (requestId) {
                    // === Token 统计: 更新实际 token ===
                    try {
                        const usagesManager = TokenUsagesManager.instance;
                        // 直接传递原始 usage 对象，包含流时间信息
                        await usagesManager.updateActualTokens({
                            requestId,
                            sessionId,
                            rawUsage: finalUsage || {},
                            status: 'completed',
                            streamStartTime,
                            streamEndTime
                        });
                    } catch (err) {
                        Logger.warn('Failed to update token stats:', err);
                    }
                }

                Logger.debug(`${model.name} ${this.displayName} SDK stream completed`);
            } catch (streamError) {
                if (
                    token.isCancellationRequested ||
                    streamError instanceof vscode.CancellationError ||
                    streamError instanceof OpenAI.APIUserAbortError ||
                    (streamError instanceof Error && streamError.name === 'AbortError')
                ) {
                    Logger.info(`${model.name} request was cancelled by the user`);
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} SDK stream processing error: ${streamError}`);
                    throw streamError;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} request completed`);
        } catch (error) {
            // === Token 统计: 更新失败状态 ===
            if (
                token.isCancellationRequested ||
                error instanceof vscode.CancellationError ||
                error instanceof OpenAI.APIUserAbortError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                throw new vscode.CancellationError();
            }

            if (error instanceof Error) {
                if (error.cause instanceof Error) {
                    const errorMessage = error.cause.message || t('Unknown error', '未知错误');
                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);
                    throw error.cause;
                } else {
                    let errorMessage = error.message || t('Unknown error', '未知错误');

                    // 尝试从 OpenAI SDK 的 APIError 中提取详细的错误信息
                    // APIError 对象有一个 error 属性，其中包含了原始的 API 错误响应
                    const apiError = error as APIErrorWithError;
                    if (apiError.error && typeof apiError.error === 'object') {
                        const errorDetail = apiError.error as APIErrorDetail;
                        if (errorDetail.message && typeof errorDetail.message === 'string') {
                            errorMessage = errorDetail.message;
                            Logger.debug(
                                `${model.name} Extracted detailed error message from APIError.error: ${errorMessage}`
                            );
                        }
                    }

                    // 尝试从 error.cause 中提取详细的错误信息
                    // APIConnectionError 可能会在 cause 中包含原始错误
                    if (error.cause instanceof Error) {
                        const causeMessage = error.cause.message || '';
                        if (causeMessage && causeMessage !== errorMessage) {
                            errorMessage = causeMessage;
                            Logger.debug(
                                `${model.name} Extracted detailed error message from error.cause: ${errorMessage}`
                            );
                            throw error.cause;
                        }
                    }

                    Logger.error(`${model.name} ${this.displayName} request failed: ${errorMessage}`);

                    // 检查是否为statusCode错误，如果是则确保同步抛出
                    if (
                        errorMessage.includes('502') ||
                        errorMessage.includes('Bad Gateway') ||
                        errorMessage.includes('500') ||
                        errorMessage.includes('Internal Server Error') ||
                        errorMessage.includes('503') ||
                        errorMessage.includes('Service Unavailable') ||
                        errorMessage.includes('504') ||
                        errorMessage.includes('Gateway Timeout')
                    ) {
                        // 对于服务器错误，直接抛出原始错误以终止对话
                        throw new vscode.LanguageModelError(errorMessage);
                    }

                    // 对于普通错误，也需要重新抛出
                    throw error;
                }
            }

            // 改进的错误处理，参照官方示例
            if (error instanceof vscode.CancellationError) {
                // 取消错误不需要额外处理，直接重新抛出
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                Logger.debug(`LanguageModelError details: code=${error.code}, cause=${error.cause}`);
                // 根据官方示例的错误处理模式，使用字符串比较
                if (error.code === 'blocked') {
                    Logger.warn('Request blocked, may contain inappropriate content');
                } else if (error.code === 'noPermissions') {
                    Logger.warn('Insufficient permissions, please check API key and model access');
                } else if (error.code === 'notFound') {
                    Logger.warn('Model not found or unavailable');
                } else if (error.code === 'quotaExceeded') {
                    Logger.warn('Quota exceeded, please check API usage limits');
                } else if (error.code === 'unknown') {
                    Logger.warn('Unknown language model error');
                }
                throw error;
            } else {
                // 其他错误类型
                throw error;
            }
        }
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
                    if (this.isImageMimeType(part.mimeType)) {
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
                const dataUrl = this.createDataUrl(imagePart);
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
        const reasoningReplayPolicy = getReasoningReplayPolicy({
            providerKey: this.provider,
            modelConfig: modelConfig
        });

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

        // 如果 ThinkingPart 被 VS Code 剥离，则从 StatefulMarker 恢复兼容模型所需的 reasoning_content
        if (!thinkingContent && reasoningReplayPolicy.restoreFromStatefulMarker) {
            const markerReasoning = getMarkerReasoningState(message.content);
            if (markerReasoning.completeThinking) {
                thinkingContent = markerReasoning.completeThinking;
                Logger.trace(`Restored reasoning_content from StatefulMarker: ${thinkingContent.length} chars`);
            } else if (
                shouldInjectReasoningPlaceholder(
                    reasoningReplayPolicy,
                    toolCalls.length > 0,
                    markerReasoning.hasToolCalls
                )
            ) {
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
     */
    private convertToolResultContent(content: unknown): string {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map(resultPart => {
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
                    functionDef.function.parameters = sanitizeToolSchemaForTarget(
                        tool.inputSchema as Record<string, unknown>,
                        'openai'
                    );
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
    public isImageMimeType(mimeType: string): boolean {
        // 标准化MIME类型
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
            Logger.warn(
                `🚫 Image type is not in the supported list: ${mimeType}, supported types: ${supportedTypes.join(', ')}`
            );
        } else if (!isImageCategory && normalizedMime !== 'cache_control') {
            // 对于cache_control（Claude缓存标识）不记录调试信息，对其他非图像类型记录trace级别日志
            // Logger.trace(`📄 非图像数据类型: ${mimeType}`);
        }
        return isImageCategory && isSupported;
    }

    /**
     * 创建图片的data URL
     */
    public createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
        try {
            const base64Data = Buffer.from(dataPart.data).toString('base64');
            const dataUrl = `data:${dataPart.mimeType};base64,${base64Data}`;
            Logger.debug(
                `🔗 Created image DataURL: MIME=${dataPart.mimeType}, originalSize=${dataPart.data.length} bytes, base64Size=${base64Data.length} chars`
            );
            return dataUrl;
        } catch (error) {
            Logger.error(`❌ Failed to create image DataURL: ${error}`);
            throw error;
        }
    }

    /**
     * 过滤extraBody中不可修改的核心参数
     * @param extraBody 原始extraBody参数
     * @returns 过滤后的参数，移除了不可修改的核心参数
     */
    public static filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        const coreParams = new Set([
            'model', // 模型名称
            'messages', // 消息数组
            'stream', // 流式开关
            'stream_options', // 流式选项
            'tools' // 工具定义
        ]);

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(extraBody)) {
            if (!coreParams.has(key)) {
                filtered[key] = value;
                if (value == null) {
                    filtered[key] = undefined;
                }
            }
        }

        return filtered;
    }
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
            part.mimeType === CustomDataPartMimeTypes.StatefulMarker &&
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
