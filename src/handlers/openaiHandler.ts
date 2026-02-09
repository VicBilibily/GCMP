/*---------------------------------------------------------------------------------------------
 *  OpenAI SDK 处理器
 *  使用 OpenAI SDK 实现流式聊天完成
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger, VersionManager, isIFlowGatewayURL, applyIFlowGatewayHeaders } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { StreamReporter } from './streamReporter';

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

    constructor(
        private provider: string,
        private providerConfig?: ProviderConfig
    ) {
        // provider 和 providerConfig 由调用方传入
        // displayName 和 baseURL 从 providerConfig 获取
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

        // 构建默认头部，包含自定义头部
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent('OpenAI')
        };

        // 注入 iFlow 网关签名头
        if (baseURL && isIFlowGatewayURL(baseURL)) {
            await applyIFlowGatewayHeaders(defaultHeaders, currentApiKey, providerKey);
        }

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
            Logger.debug(`${this.displayName} 应用自定义头部: ${JSON.stringify(mergedCustomHeader)}`);
        }

        let customFetch: typeof fetch | undefined = undefined; // 使用默认 fetch 实现
        customFetch = this.createCustomFetch(); // 使用自定义 fetch 解决 SSE 格式问题
        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            defaultHeaders: defaultHeaders,
            fetch: customFetch
        });
        Logger.trace(`${this.displayName} OpenAI SDK 客户端已创建，使用baseURL: ${baseURL}`);
        return client;
    }

    /**
     * 创建自定义 fetch 函数来处理非标准 SSE 格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    private createCustomFetch(): typeof fetch {
        return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
            // 调用原始 fetch
            const response = await fetch(url, init);
            // 当前插件的所有调用都是流请求，直接预处理所有响应
            // preprocessSSEResponse 现在是异步的，可能会抛出错误以便上层捕获
            return await this.preprocessSSEResponse(response);
        };
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    private async preprocessSSEResponse(response: Response): Promise<Response> {
        const contentType = response.headers.get('Content-Type');

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
        // 只处理 SSE 响应，其他类型直接返回原始 response
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            return response;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();

        // 行缓冲区：用于累积不完整的 SSE 行
        let lineBuffer = '';

        const transformedStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            // 流结束时，处理缓冲区剩余的内容
                            if (lineBuffer.trim().length > 0) {
                                Logger.trace(`流结束，处理缓冲区剩余内容: ${lineBuffer.length} 字符`);
                                // 修复格式并输出剩余内容
                                const remaining = lineBuffer.replace(/^data:([^\s])/gm, 'data: $1');
                                controller.enqueue(encoder.encode(remaining));
                            }
                            controller.close();
                            break;
                        }

                        // 解码 chunk
                        const chunk = decoder.decode(value, { stream: true });
                        // 将新内容追加到缓冲区
                        lineBuffer += chunk;

                        // 按行分割，保留最后一行（可能不完整）
                        const lines = lineBuffer.split(/\n/);
                        // 保留最后一个元素（可能是不完整的行）
                        const lastLine = lines.pop() || '';
                        lineBuffer = lastLine;

                        // 处理完整的行
                        if (lines.length > 0) {
                            let processedChunk = lines.join('\n') + '\n';

                            // 修复 SSE 格式：确保 "data:" 后面有空格
                            // 处理 "data:{json}" -> "data: {json}"
                            processedChunk = processedChunk.replace(/^data:([^\s])/gm, 'data: $1');

                            // Logger.trace(`接收到 SSE chunk: ${chunk.length} 字符，完整行数: ${lines.length}`);

                            // 判断并处理 chunk 中所有的 data: {json} 对象，兼容部分模型使用旧格式把内容放在 choice.message
                            try {
                                const dataRegex = /^data: (.*)$/gm;
                                let transformed = processedChunk;
                                const matches = Array.from(processedChunk.matchAll(dataRegex));

                                for (const m of matches) {
                                    const jsonStr = m[1];
                                    // 跳过 SSE 结束标记 [DONE]
                                    if (jsonStr === '[DONE]') {
                                        continue;
                                    }
                                    try {
                                        const obj = JSON.parse(jsonStr);
                                        let objModified = false;

                                        //#region OpenAI Chat Completion 兼容性处理
                                        // 转换旧格式: 如果 choice 中含有 message 而无 delta，则将 message 转为 delta
                                        if (obj && Array.isArray(obj.choices)) {
                                            for (const ch of obj.choices) {
                                                if (
                                                    ch &&
                                                    ch.message &&
                                                    (!ch.delta || Object.keys(ch.delta).length === 0)
                                                ) {
                                                    ch.delta = ch.message;
                                                    delete ch.message;
                                                    objModified = true;
                                                }
                                            }
                                        }

                                        // 处理 choices，确保每个 choice 都有正确的结构
                                        if (obj.choices && obj.choices.length > 0) {
                                            // 倒序处理choices，避免索引变化影响后续处理
                                            for (
                                                let choiceIndex = obj.choices.length - 1;
                                                choiceIndex >= 0;
                                                choiceIndex--
                                            ) {
                                                const choice = obj.choices[choiceIndex];
                                                if (choice?.finish_reason) {
                                                    if (!choice.delta || Object.keys(choice.delta).length === 0) {
                                                        Logger.trace(
                                                            `preprocessSSEResponse 仅有 finish_reason (choice ${choiceIndex})，为 delta 添加空 content`
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
                                                    } // 避免移除有效的空 delta
                                                    Logger.trace(
                                                        `preprocessSSEResponse 移除无效的 delta (choice ${choiceIndex})`
                                                    );
                                                    // 直接从数组中移除无效choice
                                                    obj.choices.splice(choiceIndex, 1);
                                                    objModified = true;
                                                }
                                            }

                                            // 修复 choice index，部分模型会返回错误的 index，造成 OpenAI SDK 解析失败
                                            if (obj.choices.length == 1) {
                                                // 将 choice 的 index 改为 0
                                                for (const choice of obj.choices) {
                                                    // 部分模型返回index不存在或index值不为0
                                                    if (choice.index == null || choice.index !== 0) {
                                                        choice.index = 0;
                                                        objModified = true;
                                                    }
                                                }
                                            }
                                        }
                                        //#endregion

                                        //#region OpenAI Response 事件兼容性处理
                                        if (obj.type === 'response.created' && obj.response?.object === 'response') {
                                            // 修复 response.created 事件中的 response 对象结构
                                            if (!Array.isArray(obj.response.output)) {
                                                // 火山引擎的 Response 并没有返回 output 字段，强制设置为空数组
                                                obj.response.output = [];
                                                objModified = true;
                                            }
                                        } else if (
                                            obj.type === 'response.output_item.added' &&
                                            obj.item?.type === 'message' &&
                                            !Array.isArray(obj.item.content)
                                        ) {
                                            // 火山引擎的 Response output_item.added 事件中，message content 可能为null，强制设置为空数组
                                            obj.item.content = [];
                                            objModified = true;
                                        } else if (
                                            obj.type === 'response.content_part.added' &&
                                            obj.output_index == null
                                        ) {
                                            // 火山引擎的 Response content_part.added 事件缺少 output_index 字段，强制设置为0
                                            obj.output_index = 0;
                                            objModified = true;
                                        }
                                        //#endregion

                                        if (objModified) {
                                            // 只有在对象被修改时才重新序列化
                                            const newJson = JSON.stringify(obj);
                                            transformed = transformed.replace(m[0], `data: ${newJson}`);
                                        }
                                    } catch (parseError) {
                                        // 单个 data JSON 解析失败，不影响整个 chunk
                                        Logger.trace(`JSON 解析失败: ${parseError}`);
                                        continue;
                                    }
                                }
                                processedChunk = transformed;
                            } catch (error) {
                                // 解析失败不影响正常流
                                Logger.trace(`处理 SSE 行失败: ${error}`);
                            }

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
     * 处理聊天完成请求 - 使用 OpenAI SDK 流式接口
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        Logger.debug(`${model.name} 开始处理 ${this.displayName} 请求`);
        // 清理当前请求的事件去重跟踪器
        this.currentRequestProcessedEvents.clear();
        try {
            const client = await this.createOpenAIClient(modelConfig);
            Logger.debug(`${model.name} 发送 ${messages.length} 条消息，使用 ${this.displayName}`);
            // 优先使用模型特定的请求模型名称，如果没有则使用模型ID
            const requestModel = modelConfig.model || model.id;
            const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
                model: requestModel,
                // capabilities 已包含在 modelConfig 中，优先以配置为准做消息转换
                messages: this.convertMessagesToOpenAI(messages, modelConfig),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true },
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // 添加工具支持（如果有）
            if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
                createParams.tools = this.convertToolsToOpenAI([...options.tools]);
                Logger.trace(`${model.name} 添加了 ${options.tools.length} 个工具`);
            }

            // 合并extraBody参数（如果有）
            if (modelConfig.extraBody) {
                // 过滤掉不可修改的核心参数
                const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
                Object.assign(createParams, filteredExtraBody);
                if (Object.keys(filteredExtraBody).length > 0) {
                    Logger.trace(`${model.name} 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`);
                }
            }

            Logger.info(`🚀 ${model.name} 发送 ${this.displayName} 请求`);

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'openai',
                progress
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
                const stream = client.chat.completions.stream(createParams, { signal: abortController.signal });
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

                // 计算并记录输出速度
                const usageData = finalUsage as OpenAI.Completions.CompletionUsage | undefined;
                if (usageData && streamStartTime && streamEndTime) {
                    const duration = streamEndTime - streamStartTime;
                    const outputTokens = usageData.completion_tokens ?? 0;
                    const speed = duration > 0 ? ((outputTokens / duration) * 1000).toFixed(1) : 'N/A';
                    Logger.info(
                        `📊 ${model.name} OpenAI 请求完成, 输出=${outputTokens} tokens, 耗时=${duration}ms, 速度=${speed} tokens/s`,
                        usageData
                    );
                } else {
                    Logger.info(`📊 ${model.name} OpenAI 请求完成`, finalUsage);
                }

                if (requestId) {
                    // === Token 统计: 更新实际 token ===
                    try {
                        const usagesManager = TokenUsagesManager.instance;
                        // 直接传递原始 usage 对象，包含流时间信息
                        await usagesManager.updateActualTokens({
                            requestId,
                            rawUsage: finalUsage || {},
                            status: 'completed',
                            streamStartTime,
                            streamEndTime
                        });
                    } catch (err) {
                        Logger.warn('更新Token统计失败:', err);
                    }
                }

                Logger.debug(`${model.name} ${this.displayName} SDK流处理完成`);
            } catch (streamError) {
                if (
                    token.isCancellationRequested ||
                    streamError instanceof vscode.CancellationError ||
                    streamError instanceof OpenAI.APIUserAbortError ||
                    (streamError instanceof Error && streamError.name === 'AbortError')
                ) {
                    Logger.info(`${model.name} 请求被用户取消`);
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} SDK流处理错误: ${streamError}`);
                    throw streamError;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} 请求完成`);
        } catch (error) {
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
                    const errorMessage = error.cause.message || '未知错误';
                    Logger.error(`${model.name} ${this.displayName} 请求失败: ${errorMessage}`);
                    throw error.cause;
                } else {
                    let errorMessage = error.message || '未知错误';

                    // 尝试从 OpenAI SDK 的 APIError 中提取详细的错误信息
                    // APIError 对象有一个 error 属性，其中包含了原始的 API 错误响应
                    const apiError = error as APIErrorWithError;
                    if (apiError.error && typeof apiError.error === 'object') {
                        const errorDetail = apiError.error as APIErrorDetail;
                        if (errorDetail.message && typeof errorDetail.message === 'string') {
                            errorMessage = errorDetail.message;
                            Logger.debug(`${model.name} 从 APIError.error 中提取到详细错误信息: ${errorMessage}`);
                        }
                    }

                    // 尝试从 error.cause 中提取详细的错误信息
                    // APIConnectionError 可能会在 cause 中包含原始错误
                    if (error.cause instanceof Error) {
                        const causeMessage = error.cause.message || '';
                        if (causeMessage && causeMessage !== errorMessage) {
                            errorMessage = causeMessage;
                            Logger.debug(`${model.name} 从 error.cause 中提取到详细错误信息: ${errorMessage}`);
                            throw error.cause;
                        }
                    }

                    Logger.error(`${model.name} ${this.displayName} 请求失败: ${errorMessage}`);

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
                Logger.debug(`LanguageModelError详情: code=${error.code}, cause=${error.cause}`);
                // 根据官方示例的错误处理模式，使用字符串比较
                if (error.code === 'blocked') {
                    Logger.warn('请求被阻止，可能包含不当内容');
                } else if (error.code === 'noPermissions') {
                    Logger.warn('权限不足，请检查API密钥和模型访问权限');
                } else if (error.code === 'notFound') {
                    Logger.warn('模型未找到或不可用');
                } else if (error.code === 'quotaExceeded') {
                    Logger.warn('配额已用完，请检查API使用限制');
                } else if (error.code === 'unknown') {
                    Logger.warn('未知的语言模型错误');
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
                Logger.warn(`未知的消息角色: ${message.role}`);
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
            // Logger.debug('🖼️ 模型支持图像输入，开始收集图像部分');
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelDataPart) {
                    // Logger.debug(`📷 发现数据部分: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    if (this.isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                        Logger.debug(`✅ 添加图像: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    } else {
                        // // 分类处理不同类型的数据
                        // if (part.mimeType === 'cache_control') {
                        //     Logger.trace('⚠️ 忽略Claude缓存标识: cache_control');
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
            Logger.debug(`🖼️ 构建多模态消息: ${textParts.length}个文本部分 + ${imageParts.length}个图像部分`);
            const contentArray: OpenAI.Chat.ChatCompletionContentPart[] = [];
            if (textParts.length > 0) {
                const textContent = textParts.map(part => part.value).join('\n');
                contentArray.push({
                    type: 'text',
                    text: textContent
                });
                Logger.trace(`📝 添加文本内容: ${textContent.length}字符`);
            }
            for (const imagePart of imageParts) {
                const dataUrl = this.createDataUrl(imagePart);
                contentArray.push({
                    type: 'image_url',
                    image_url: { url: dataUrl }
                });
                Logger.trace(`📷 添加图像URL: MIME=${imagePart.mimeType}, Base64长度=${dataUrl.length}字符`);
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
     * 转换工具结果消息 - 使用 OpenAI SDK 标准类型
     */
    private convertToolResultMessages(
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionToolMessageParam[] {
        const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolResultPart) {
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
        _modelConfig?: ModelConfig
    ): OpenAI.Chat.ChatCompletionAssistantMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
        let thinkingContent: string | null = null;

        // 处理工具调用和思考内容
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
                // Logger.debug(`添加工具调用: ${part.name} (ID: ${part.callId})`);
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
                Logger.trace(`提取到思考内容: ${thinkingContent.length} 字符`);
                break; // 只取第一个思考内容部分
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
            Logger.trace(`添加 reasoning_content: ${thinkingContent.length} 字符`);
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
            Logger.warn(`🚫 图像类型未在支持列表中: ${mimeType}，支持的类型: ${supportedTypes.join(', ')}`);
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
                `🔗 创建图像DataURL: MIME=${dataPart.mimeType}, 原始大小=${dataPart.data.length}字节, Base64大小=${base64Data.length}字符`
            );
            return dataUrl;
        } catch (error) {
            Logger.error(`❌ 创建图像DataURL失败: ${error}`);
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
