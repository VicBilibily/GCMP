/*---------------------------------------------------------------------------------------------
 *  OpenAI SDK 处理器
 *  使用 OpenAI SDK 实现流式聊天完成
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ModelConfig } from '../types/sharedTypes';

/**
 * 扩展Delta类型以支持reasoning_content字段
 */
interface ExtendedDelta extends OpenAI.Chat.ChatCompletionChunk.Choice.Delta {
    reasoning_content?: string;
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
        private displayName: string,
        private baseURL?: string
    ) {
        // provider、displayName 和 baseURL 由调用方传入
    }

    /**
     * 创建新的 OpenAI 客户端
     */
    private async createOpenAIClient(modelConfig?: ModelConfig): Promise<OpenAI> {
        const currentApiKey = await ApiKeyManager.getApiKey(this.provider);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }
        // 优先使用模型特定的baseUrl，如果没有则使用供应商级别的baseUrl
        const baseURL = modelConfig?.baseUrl || this.baseURL;
        const client = new OpenAI({
            apiKey: currentApiKey,
            baseURL: baseURL,
            fetch: this.createCustomFetch() // 使用自定义 fetch 解决 SSE 格式问题
        });
        Logger.debug(`${this.displayName} OpenAI SDK 客户端已创建，使用baseURL: ${baseURL}`);
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
            return this.preprocessSSEResponse(response);
        };
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    private preprocessSSEResponse(response: Response): Response {
        const contentType = response.headers.get('Content-Type');
        // 如果返回 application/json，直接抛出错误（心流AI存在此类返回）
        if (contentType && contentType.includes('application/json')) {
            return new Response(
                new ReadableStream({
                    async start(controller) {
                        const json = await response.text();
                        controller.error(new Error(json));
                    }
                }),
                {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                }
            );
        }
        // 只处理 SSE 响应，其他类型直接返回原始 response
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            return response;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const transformedStream = new ReadableStream({
            async start(controller) {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            controller.close();
                            break;
                        }
                        // 解码 chunk
                        let chunk = decoder.decode(value, { stream: true });
                        // 修复 SSE 格式：确保 "data:" 后面有空格
                        // 处理 "data:{json}" -> "data: {json}"
                        chunk = chunk.replace(/^data:([^\s])/gm, 'data: $1');
                        Logger.trace(`接收到 SSE chunk: ${chunk.length} 字符，chunk=${chunk}`);

                        // 判断并处理 chunk 中所有的 data: {json} 对象，兼容部分模型使用旧格式把内容放在 choice.message
                        try {
                            const dataRegex = /^data: (.*)$/gm;
                            let transformed = chunk;
                            const matches = Array.from(chunk.matchAll(dataRegex));
                            for (const m of matches) {
                                const jsonStr = m[1];
                                try {
                                    const obj = JSON.parse(jsonStr);
                                    // 转换旧格式: 如果 choice 中含有 message 而无 delta，则将 message 转为 delta
                                    if (obj && Array.isArray(obj.choices)) {
                                        for (const ch of obj.choices) {
                                            if (ch && ch.message && (!ch.delta || Object.keys(ch.delta).length === 0)) {
                                                ch.delta = ch.message;
                                                delete ch.message;
                                            }
                                        }
                                    }

                                    // 仍然保留对仅有 finish_reason 且无 delta 的过滤
                                    const choice = obj.choices?.[0];
                                    if (
                                        choice?.finish_reason &&
                                        (!choice.delta || Object.keys(choice.delta).length === 0)
                                    ) {
                                        Logger.trace('preprocessSSEResponse 跳过仅有 finish_reason 且无 delta 的无效 chunk');
                                        // 从 transformed 中移除该 data 行
                                        transformed = transformed.replace(m[0], '');
                                        continue;
                                    }

                                    // 将可能被修改的对象重新序列化回 chunk
                                    const newJson = JSON.stringify(obj);
                                    transformed = transformed.replace(m[0], `data: ${newJson}`);
                                } catch {
                                    // 单个 data JSON 解析失败，不影响整个 chunk
                                    continue;
                                }
                            }
                            chunk = transformed;
                        } catch {
                            // 解析失败不影响正常流
                        }

                        // 重新编码并传递有效内容
                        controller.enqueue(encoder.encode(chunk));
                    }
                } catch (error) {
                    controller.error(error);
                } finally {
                    reader.releaseLock();
                }
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
        token: vscode.CancellationToken
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
                messages: this.convertMessagesToOpenAI(messages, model.capabilities || undefined),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true },
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };
            // #region 调试：检查输入消息中的图像内容
            // let totalImageParts = 0;
            // let totalDataParts = 0;
            // let cacheControlParts = 0;
            // messages.forEach((msg, index) => {
            //     const dataParts = msg.content.filter(part => part instanceof vscode.LanguageModelDataPart);
            //     const imageParts = dataParts.filter(part => {
            //         const dataPart = part as vscode.LanguageModelDataPart;
            //         return this.isImageMimeType(dataPart.mimeType);
            //     });
            //     const cacheControls = dataParts.filter(part => {
            //         const dataPart = part as vscode.LanguageModelDataPart;
            //         return dataPart.mimeType === 'cache_control';
            //     });

            //     totalDataParts += dataParts.length;
            //     totalImageParts += imageParts.length;
            //     cacheControlParts += cacheControls.length;

            //     if (dataParts.length > 0) {
            //         Logger.debug(`📷 消息 ${index}: 发现 ${dataParts.length} 个数据部分，其中 ${imageParts.length} 个图像，${cacheControls.length} 个缓存标识`);
            //         dataParts.forEach((part, partIndex) => {
            //             const dataPart = part as vscode.LanguageModelDataPart;
            //             const isImage = this.isImageMimeType(dataPart.mimeType);
            //             const isCache = dataPart.mimeType === 'cache_control';
            //             const icon = isImage ? '🖼️' : isCache ? '📄' : '📄';
            //             Logger.trace(`${icon} 数据部分 ${partIndex}: MIME=${dataPart.mimeType}, 大小=${dataPart.data.length}字节, 类型=${isImage ? '图像' : isCache ? '缓存' : '其他'}`);
            //         });
            //     }
            // });
            // if (totalDataParts > 0) {
            //     const effectiveDataParts = totalDataParts - cacheControlParts;
            //     Logger.debug(`📊 数据统计: 总共 ${totalDataParts} 个数据部分（${effectiveDataParts} 个有效数据 + ${cacheControlParts} 个缓存标识），其中 ${totalImageParts} 个图像，模型图像能力: ${model.capabilities?.imageInput}`);
            // }
            // #endregion

            // 添加工具支持（如果有）
            if (options.tools && options.tools.length > 0 && model.capabilities?.toolCalling) {
                createParams.tools = this.convertToolsToOpenAI([...options.tools]);
                createParams.tool_choice = 'auto';
                Logger.trace(`${model.name} 添加了 ${options.tools.length} 个工具`);
            }

            // #region 调试：检查输入消息中的工具调用
            // // 输出转换后的消息统计信息
            // const openaiMessages = createParams.messages;
            // const totalContentLength = openaiMessages.reduce((sum, msg) => {
            //     if (typeof msg.content === 'string') {
            //         return sum + msg.content.length;
            //     } else if (Array.isArray(msg.content)) {
            //         return sum + msg.content.reduce((contentSum, item) => {
            //             return contentSum + (('text' in item && item.text) ? item.text.length : 0);
            //         }, 0);
            //     }
            //     return sum;
            // }, 0);
            // const totalToolCalls = openaiMessages.reduce((sum, msg) => {
            //     return sum + (('tool_calls' in msg && msg.tool_calls) ? msg.tool_calls.length : 0);
            // }, 0);
            // Logger.debug(`📊 ${model.name} 消息统计: ${openaiMessages.length}条消息, ${totalContentLength}字符, ${totalToolCalls}个工具调用`);

            // // 详细消息调试信息
            // openaiMessages.forEach((msg, index) => {
            //     const contentInfo = typeof msg.content === 'string'
            //         ? `text(${msg.content.length}chars)`
            //         : Array.isArray(msg.content)
            //             ? `multimodal(${msg.content.length}parts)`
            //             : 'no_content';
            //     const toolCallsInfo = ('tool_calls' in msg && msg.tool_calls) ? msg.tool_calls.length : 0;
            //     const toolCallId = ('tool_call_id' in msg && msg.tool_call_id) ? msg.tool_call_id : 'none';
            //     Logger.trace(`💬 消息 ${index}: role=${msg.role}, content=${contentInfo}, tool_calls=${toolCallsInfo}, tool_call_id=${toolCallId}`);
            //     if ('tool_calls' in msg && msg.tool_calls) {
            //         msg.tool_calls.forEach(tc => {
            //             if (tc.type === 'function' && tc.function) {
            //                 const argsLength = tc.function.arguments ? tc.function.arguments.length : 0;
            //                 Logger.trace(`🔧 工具调用: ${tc.id} -> ${tc.function.name}(${argsLength}chars)`);
            //             }
            //         });
            //     }
            // });
            // #endregion
            Logger.info(`🚀 ${model.name} 发送 ${this.displayName} 请求`);

            let hasReceivedContent = false;
            // 当前正在输出的思维链 ID（可重复开始/结束）
            // 当不为 null 时表示有一个未结束的思维链，遇到第一个可见 content delta 时需要先用相同 id 发送一个空 value 来结束该思维链
            let currentThinkingId: string | null = null;
            // 使用 OpenAI SDK 的事件驱动流式方法，利用内置工具调用处理
            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null; // 用于捕获流错误

            try {
                const stream = client.chat.completions.stream(createParams, { signal: abortController.signal });
                // 利用 SDK 内置的事件系统处理工具调用和内容
                stream
                    .on('content', (delta: string, _snapshot: string) => {
                        // 检查取消请求
                        if (token.isCancellationRequested) {
                            Logger.warn(`${model.name} 用户取消了请求`);
                            throw new vscode.CancellationError();
                        }
                        // 输出 trace 日志：记录增量长度和片段预览，便于排查偶发没有完整chunk的问题
                        try {
                            Logger.trace(`${model.name} 收到 content 增量: ${delta ? delta.length : 0} 字符, preview=${delta}`);
                        } catch {
                            // 日志不应中断流处理
                        }
                        // 判断 delta 是否包含可见字符（去除所有空白、不可见空格后长度 > 0）
                        const deltaVisible = typeof delta === 'string' && delta.replace(/[\s\uFEFF\xA0]+/g, '').length > 0;
                        if (deltaVisible && currentThinkingId) {
                            // 在输出第一个可见 content 前，显式结束当前思维链：使用相同的 thinking id 发送一个空 value
                            try {
                                Logger.trace(`${model.name} 在输出content前结束当前思维链 id=${currentThinkingId}`);
                                progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingId));
                            } catch (e) {
                                // 报告失败不应该中断主流
                                Logger.trace(`${model.name} 发送 thinking done(id=${currentThinkingId}) 失败: ${String(e)}`);
                            }
                            currentThinkingId = null;
                        }

                        // 直接输出常规内容
                        progress.report(new vscode.LanguageModelTextPart(delta));
                        hasReceivedContent = true;
                    })
                    .on(
                        'tool_calls.function.arguments.done',
                        (event: { name: string; index: number; arguments: string; parsed_arguments: unknown }) => {
                            // SDK 自动累积完成后触发的完整工具调用事件
                            if (token.isCancellationRequested) {
                                return;
                            }
                            // 基于事件索引和名称生成去重标识
                            const eventKey = `tool_call_${event.name}_${event.index}_${event.arguments.length}`;
                            if (this.currentRequestProcessedEvents.has(eventKey)) {
                                Logger.trace(`跳过重复的工具调用事件: ${event.name} (索引: ${event.index})`);
                                return;
                            }
                            this.currentRequestProcessedEvents.add(eventKey);
                            // 使用 SDK 解析的参数（优先）或解析 arguments 字符串
                            const parsedArgs = event.parsed_arguments || JSON.parse(event.arguments || '{}');
                            // SDK 会自动生成唯一的工具调用ID，这里使用简单的索引标识
                            const toolCallId = `tool_call_${event.index}_${Date.now()}`;
                            Logger.debug(`✅ SDK工具调用完成: ${event.name} (索引: ${event.index})`);
                            progress.report(new vscode.LanguageModelToolCallPart(toolCallId, event.name, parsedArgs));
                            hasReceivedContent = true;
                        }
                    )
                    .on(
                        'tool_calls.function.arguments.delta',
                        (event: { name: string; index: number; arguments_delta: string }) => {
                            // 工具调用参数增量事件（用于调试）
                            Logger.trace(
                                `🔧 工具调用参数增量: ${event.name} (索引: ${event.index}) - ${event.arguments_delta}`
                            );
                        }
                    )
                    .on('chunk', (chunk: OpenAI.Chat.Completions.ChatCompletionChunk, _snapshot: unknown) => {
                        // 处理token使用统计（始终输出Info日志）
                        if (chunk.usage) {
                            const usage = chunk.usage;
                            Logger.info(
                                `📊 ${model.name} Token使用: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`
                            );
                        }

                        // 处理思考内容（reasoning_content）和兼容旧格式：有些模型把最终结果放在 choice.message
                        // 思维链是可重入的：遇到时输出；在后续第一次可见 content 输出前，需要结束当前思维链（done）
                        if (chunk.choices && chunk.choices[0]) {
                            const choice = chunk.choices[0] as any;
                            const delta = choice.delta as ExtendedDelta | undefined;
                            const message = choice.message as any | undefined;

                            // 兼容：优先使用 delta 中的 reasoning_content，否则尝试从 message 中读取
                            const reasoningContent = delta?.reasoning_content ?? message?.reasoning_content;
                            if (reasoningContent) {
                                try {
                                    Logger.trace(`🧠 接收到思考内容: ${reasoningContent.length}字符`);
                                    // 如果当前没有 active id，则生成一个用于本次思维链
                                    if (!currentThinkingId) {
                                        currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                                    }
                                    progress.report(new vscode.LanguageModelThinkingPart(reasoningContent, currentThinkingId));
                                    // 标记已接收内容
                                    hasReceivedContent = true;
                                } catch (e) {
                                    Logger.trace(`${model.name} report 思维链失败: ${String(e)}`);
                                }
                            }

                            // 另外兼容：如果服务端把最终文本放在 message.content（旧/混合格式），当作 content 增量处理
                            const messageContent = message?.content;
                            if (typeof messageContent === 'string' && messageContent.replace(/[\s\uFEFF\xA0]+/g, '').length > 0) {
                                // 遇到可见 content 前，如果有未结束的 thinking，则先结束之
                                if (currentThinkingId) {
                                    try {
                                        Logger.trace(`${model.name} 在输出message.content前结束当前思维链 id=${currentThinkingId}`);
                                        progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingId));
                                    } catch (e) {
                                        Logger.trace(`${model.name} 发送 thinking done(id=${currentThinkingId}) 失败: ${String(e)}`);
                                    }
                                    currentThinkingId = null;
                                }
                                // 然后报告文本内容
                                try {
                                    progress.report(new vscode.LanguageModelTextPart(messageContent));
                                    hasReceivedContent = true;
                                } catch (e) {
                                    Logger.trace(`${model.name} report message content 失败: ${String(e)}`);
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
                // 检查是否有流错误
                if (streamError) {
                    throw streamError;
                }
                Logger.debug(`${model.name} ${this.displayName} SDK流处理完成`);
            } catch (streamError) {
                // 改进错误处理，区分取消和其他错误
                if (streamError instanceof vscode.CancellationError) {
                    Logger.info(`${model.name} 请求被用户取消`);
                    throw streamError;
                } else {
                    Logger.error(`${model.name} SDK流处理错误: ${streamError}`);
                    throw streamError;
                }
            } finally {
                cancellationListener.dispose();
            }
            if (!hasReceivedContent) {
                Logger.warn(`${model.name} 没有接收到任何内容`);
            }
            Logger.debug(`✅ ${model.name} ${this.displayName} 请求完成`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`${model.name} ${this.displayName} 请求失败: ${errorMessage}`);

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
     */
    private convertMessagesToOpenAI(
        messages: readonly vscode.LanguageModelChatMessage[],
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];
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
     * 转换单个消息 - 参照 OpenAI SDK 官方模式
     */
    private convertSingleMessage(
        message: vscode.LanguageModelChatMessage,
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[] | null {
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
        capabilities?: { toolCalling?: boolean | number; imageInput?: boolean }
    ): OpenAI.Chat.ChatCompletionMessageParam[] {
        const results: OpenAI.Chat.ChatCompletionMessageParam[] = [];
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
    ): OpenAI.Chat.ChatCompletionUserMessageParam | null {
        const textParts = message.content.filter(
            part => part instanceof vscode.LanguageModelTextPart
        ) as vscode.LanguageModelTextPart[];
        const imageParts: vscode.LanguageModelDataPart[] = [];
        // 收集图片（如果支持）
        if (capabilities?.imageInput === true) {
            Logger.debug('🖼️ 模型支持图像输入，开始收集图像部分');
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelDataPart) {
                    Logger.debug(`📷 发现数据部分: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    if (this.isImageMimeType(part.mimeType)) {
                        imageParts.push(part);
                        Logger.debug(`✅ 添加图像: MIME=${part.mimeType}, 大小=${part.data.length}字节`);
                    } else {
                        // 分类处理不同类型的数据
                        if (part.mimeType === 'cache_control') {
                            Logger.trace('⚠️ 忽略Claude缓存标识: cache_control');
                        } else if (part.mimeType.startsWith('image/')) {
                            Logger.warn(`❌ 不支持的图像MIME类型: ${part.mimeType}`);
                        } else {
                            Logger.trace(`📄 跳过非图像数据: ${part.mimeType}`);
                        }
                    }
                } else {
                    Logger.trace(`📝 非数据部分: ${part.constructor.name}`);
                }
            }
            // 特别提示：如果没有找到图像但有非cache_control的数据部分
            const allDataParts = message.content.filter(part => part instanceof vscode.LanguageModelDataPart);
            const nonCacheDataParts = allDataParts.filter(part => {
                const dataPart = part as vscode.LanguageModelDataPart;
                return dataPart.mimeType !== 'cache_control';
            });
            if (nonCacheDataParts.length > 0 && imageParts.length === 0) {
                Logger.warn(
                    `⚠️ 发现 ${nonCacheDataParts.length} 个非cache_control数据部分但没有有效图像，请检查图像附件格式`
                );
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
        message: vscode.LanguageModelChatMessage
    ): OpenAI.Chat.ChatCompletionAssistantMessageParam | null {
        const textContent = this.extractTextContent(message.content);
        const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];

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
                // Logger.debug(`添加工具调用: ${part.name} (ID: ${part.callId})`);
            }
        }

        // 如果没有内容和工具调用，返回 null
        if (!textContent && toolCalls.length === 0) {
            return null;
        }

        const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            content: textContent || null
        };
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
     */
    private convertToolsToOpenAI(tools: vscode.LanguageModelChatTool[]): OpenAI.Chat.ChatCompletionTool[] {
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
            Logger.trace(`📄 非图像数据类型: ${mimeType}`);
        }
        return isImageCategory && isSupported;
    } /**
     * 创建图片的data URL
     */
    private createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
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
}
