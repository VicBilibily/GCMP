import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { MessageConverter } from './messageConverter';
import { ToolCallProcessor } from './toolCallProcessor';
import {
    ChatCompletionRequest,
    StreamResponse
} from './types';

/**
 * HTTP API处理器
 * 使用原生 HTTP 请求实现流式聊天完成
 */
export class OpenAIHandler {
    private apiKey: string | null = null;
    private messageConverter: MessageConverter;

    constructor(
        private provider: string,
        private displayName: string,
        private baseURL?: string
    ) {
        this.messageConverter = new MessageConverter();
    }

    /**
     * 处理聊天完成请求 - 使用原生 HTTP 流式接口
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        Logger.info(`${model.name} 开始处理 ${this.displayName} HTTP 请求`);
        Logger.debug(`${model.name} 初始取消状态: ${token.isCancellationRequested}`);

        // 早期取消检查
        if (token.isCancellationRequested) {
            Logger.warn(`${model.name} 请求在开始前就被取消`);
            throw new Error('用户取消了请求');
        }

        try {
            // 获取 API 密钥
            await this.ensureApiKey();

            // 检查取消状态
            if (token.isCancellationRequested) {
                Logger.warn(`${model.name} 请求在获取API密钥后被取消`);
                throw new Error('用户取消了请求');
            }

            Logger.info(`${model.name} 发送 ${messages.length} 条消息，使用 ${this.displayName}`);

            const requestBody: ChatCompletionRequest = {
                model: model.id,
                messages: this.messageConverter.convertMessagesToOpenAI(messages, model.capabilities),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true },
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // 检查取消状态（消息转换后）
            if (token.isCancellationRequested) {
                Logger.warn(`${model.name} 请求在消息转换后被取消`);
                throw new Error('用户取消了请求');
            }

            // 检查是否有缓存控制提示，为未来的OpenAI缓存功能做准备
            const hasCacheControl = messages.some(msg =>
                Array.isArray(msg.content) &&
                msg.content.some(part =>
                    part instanceof vscode.LanguageModelDataPart &&
                    part.mimeType === 'cache_control'
                )
            );

            if (hasCacheControl) {
                Logger.debug(`${model.name} 检测到缓存控制指令，为未来OpenAI缓存功能预留`);
                // 未来可能的缓存参数：
                // requestBody.cache = { type: 'conversation', ttl: 3600 };
            }

            // 调试：输出转换后的消息详细信息
            const totalContentLength = requestBody.messages.reduce((sum, msg) => {
                if (typeof msg.content === 'string') {
                    return sum + msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    return sum + msg.content.reduce((contentSum, item) => {
                        return contentSum + (item.text ? item.text.length : 0);
                    }, 0);
                }
                return sum;
            }, 0);

            const totalToolCalls = requestBody.messages.reduce((sum, msg) => {
                return sum + (msg.tool_calls ? msg.tool_calls.length : 0);
            }, 0);

            Logger.info(`📊 ${model.name} 消息统计: ${requestBody.messages.length}条消息, ${totalContentLength}字符, ${totalToolCalls}个工具调用`);

            requestBody.messages.forEach((msg, index) => {
                const contentInfo = typeof msg.content === 'string'
                    ? `text(${msg.content.length}chars)`
                    : Array.isArray(msg.content)
                        ? `multimodal(${msg.content.length}parts)`
                        : 'no_content';

                Logger.debug(`💬 消息 ${index}: role=${msg.role}, content=${contentInfo}, tool_calls=${msg.tool_calls?.length || 0}, tool_call_id=${msg.tool_call_id || 'none'}`);

                if (msg.tool_calls) {
                    msg.tool_calls.forEach(tc => {
                        const argsLength = tc.function.arguments ? tc.function.arguments.length : 0;
                        Logger.debug(`  🔧 工具调用: ${tc.id} -> ${tc.function.name}(${argsLength}chars)`);
                    });
                }
            });

            // 添加工具支持（如果有）
            if (options.tools && options.tools.length > 0 && model.capabilities?.toolCalling) {
                if (options.tools.length > 128) {
                    throw new Error('请求不能有超过 128 个工具');
                }
                requestBody.tools = this.messageConverter.convertToolsToOpenAI([...options.tools]);
                requestBody.tool_choice = 'auto';
            }

            // 检查取消状态（工具配置后）
            if (token.isCancellationRequested) {
                Logger.warn(`${model.name} 请求在工具配置后被取消`);
                throw new Error('用户取消了请求');
            }

            Logger.info(`🚀 ${model.name} 发送 ${this.displayName} HTTP API 请求`);

            // 设置取消监听器，在请求开始前就监听
            const globalCancelListener = token.onCancellationRequested(() => {
                Logger.warn(`${model.name} 全局取消监听器触发`);
                // 立即抛出错误，中断整个请求流程
                const error = new Error('用户取消了请求');
                Logger.error(`${model.name} 全局取消监听器触发，中断请求`);
                throw error;
            });

            try {
                // 发送流式请求
                await this.sendStreamRequest(requestBody, model, progress, token);
                globalCancelListener.dispose();
            } catch (error) {
                globalCancelListener.dispose();
                throw error;
            }

            Logger.info(`✅ ${model.name} ${this.displayName} HTTP API请求完成`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`${model.name} ${this.displayName} HTTP API请求失败: ${errorMessage}`);
            throw error;
        }
    }

    /**
     * 确保 API 密钥已获取
     */
    private async ensureApiKey(): Promise<void> {
        if (this.apiKey) {
            return;
        }

        try {
            const apiKey = await ApiKeyManager.getApiKey(this.provider);
            this.apiKey = apiKey || null;
            if (!this.apiKey) {
                throw new Error(`请先设置 ${this.displayName} API密钥`);
            }
        } catch (error) {
            Logger.error(`${this.displayName} API密钥获取失败`, error);
            throw error;
        }
    }

    /**
     * 发送流式请求
     */
    private async sendStreamRequest(
        requestBody: ChatCompletionRequest,
        model: vscode.LanguageModelChatInformation,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        Logger.debug(`${model.name} sendStreamRequest 开始，取消状态: ${token.isCancellationRequested}`);

        // 创建取消 Promise，可以立即响应取消事件
        const cancelPromise = new Promise<never>((_, reject) => {
            const cancelListener = token.onCancellationRequested(() => {
                Logger.warn(`${model.name} sendStreamRequest 立即响应取消事件，当前状态: ${token.isCancellationRequested}`);
                cancelListener.dispose();
                reject(new Error('用户取消了请求'));
            });

            // 立即检查一次取消状态
            if (token.isCancellationRequested) {
                Logger.warn(`${model.name} sendStreamRequest 在创建时就检测到取消状态`);
                cancelListener.dispose();
                reject(new Error('用户取消了请求'));
            }
        });

        // 创建实际的请求 Promise
        const requestPromise = new Promise<void>((resolve, reject) => {
            // 检查取消状态
            if (token.isCancellationRequested) {
                Logger.warn(`${model.name} 请求在发送前就被取消`);
                reject(new Error('用户取消了请求'));
                return;
            }

            const url = new URL(`${this.baseURL}/chat/completions`);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            // 从VS Code扩展API获取版本号
            const extension = vscode.extensions.getExtension('vicanent.gcmp');
            const version = extension?.packageJSON?.version || '1.0.0';

            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                'User-Agent': `GCMP/${version}`,
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache'
            };

            // 添加自定义headers
            if (model.customHeaders) {
                Object.assign(headers, model.customHeaders);
            }

            const postData = JSON.stringify(requestBody);
            Logger.debug(`${model.name} 发送请求到: ${url.href}`);
            Logger.trace(`${model.name} 请求头:`, headers);
            Logger.trace(`${model.name} 请求体大小: ${postData.length} 字节`);
            // Logger.trace(`${model.name} 请求体内容: ${postData.substring(0, 1000)}${postData.length > 1000 ? '...' : ''}`);

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    ...headers,
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 30000 // 30秒超时
            };

            let req: http.ClientRequest | null = null;
            let res: http.IncomingMessage | null = null;
            let cancelListener: vscode.Disposable | null = null;
            let isRequestCompleted = false;

            // 清理函数
            const cleanup = () => {
                if (cancelListener) {
                    cancelListener.dispose();
                    cancelListener = null;
                }
                if (res) {
                    res.destroy();
                    res = null;
                }
                if (req) {
                    req.destroy();
                    req = null;
                }
                isRequestCompleted = true;
            };

            // 处理取消逻辑
            const handleCancellation = () => {
                if (isRequestCompleted) {
                    return;
                }
                Logger.warn(`${model.name} 用户取消了请求`);
                cleanup();
                reject(new Error('用户取消了请求'));
            };

            // 立即监听取消事件
            cancelListener = token.onCancellationRequested(() => {
                Logger.warn(`${model.name} HTTP请求收到取消事件`);
                handleCancellation();
            });

            req = httpModule.request(options, (response) => {
                res = response;
                Logger.trace(`${model.name} HTTP响应状态: ${response.statusCode}, 头部:`, response.headers);

                // 再次检查取消状态
                if (token.isCancellationRequested) {
                    handleCancellation();
                    return;
                }

                if (response.statusCode !== 200) {
                    let errorData = '';
                    response.on('data', chunk => {
                        if (token.isCancellationRequested) {
                            handleCancellation();
                            return;
                        }
                        errorData += chunk;
                    });
                    response.on('end', () => {
                        if (isRequestCompleted) {
                            return;
                        }
                        Logger.error(`${model.name} HTTP错误响应: ${errorData}`);
                        cleanup();
                        try {
                            const errorObj = JSON.parse(errorData);
                            reject(new Error(errorObj.error?.message || `HTTP ${response.statusCode}`));
                        } catch {
                            reject(new Error(`HTTP ${response.statusCode}: ${errorData}`));
                        }
                    });
                    return;
                }

                this.handleStreamResponse(response, model, progress, token, () => {
                    if (!isRequestCompleted) {
                        cleanup();
                        resolve();
                    }
                }, (error) => {
                    if (!isRequestCompleted) {
                        cleanup();
                        reject(error);
                    }
                });
            });

            req.on('error', (error) => {
                if (isRequestCompleted) {
                    return;
                }
                Logger.error(`${model.name} HTTP请求错误`, error);
                cleanup();
                reject(error);
            });

            req.on('timeout', () => {
                if (isRequestCompleted) {
                    return;
                }
                Logger.error(`${model.name} HTTP请求超时`);
                cleanup();
                reject(new Error('请求超时'));
            });

            // 设置请求超时
            req.setTimeout(30000); // 30秒超时

            // 再次检查取消状态（在写入数据前）
            if (token.isCancellationRequested) {
                handleCancellation();
                return;
            }

            req.write(postData);
            req.end();
        });

        // 使用 Promise.race 确保取消事件能立即生效
        return Promise.race([requestPromise, cancelPromise]);
    }

    /**
     * 处理流式响应
     */
    private handleStreamResponse(
        res: http.IncomingMessage,
        model: vscode.LanguageModelChatInformation,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        resolve: () => void,
        reject: (error: Error) => void
    ): void {
        Logger.debug(`${model.name} handleStreamResponse 开始，取消状态: ${token.isCancellationRequested}`);

        // 如果在开始时就已经被取消，立即返回
        if (token.isCancellationRequested) {
            Logger.warn(`${model.name} handleStreamResponse 在开始时就检测到取消状态`);
            reject(new Error('用户取消了请求'));
            return;
        }

        let buffer = '';
        let hasReceivedContent = false;
        let isResponseCompleted = false;
        const toolCallProcessor = new ToolCallProcessor(model.name);        // 清理函数
        const baseCleanup = () => {
            if (isResponseCompleted) {
                return;
            }
            isResponseCompleted = true;
            res.destroy();
        };

        // 处理取消逻辑
        const handleCancellation = () => {
            if (isResponseCompleted) {
                return;
            }
            Logger.warn(`${model.name} 用户在流式响应过程中取消了请求`);
            cleanup();
            reject(new Error('用户取消了请求'));
        };

        // 监听取消事件 - 立即响应
        const cancelListener = token.onCancellationRequested(() => {
            Logger.warn(`${model.name} handleStreamResponse 收到取消事件通知，当前状态: isResponseCompleted=${isResponseCompleted}`);
            handleCancellation();
        });

        // 定期检查取消状态（每50ms检查一次，更频繁）
        const cancelCheckInterval = setInterval(() => {
            if (token.isCancellationRequested && !isResponseCompleted) {
                Logger.warn(`${model.name} handleStreamResponse 定期检查发现取消请求，当前状态: ${token.isCancellationRequested}`);
                clearInterval(cancelCheckInterval);
                handleCancellation();
            }
        }, 50);

        // 增强的清理函数
        const cleanup = () => {
            clearInterval(cancelCheckInterval);
            baseCleanup();
        };

        res.on('data', (chunk: Buffer) => {
            if (token.isCancellationRequested || isResponseCompleted) {
                handleCancellation();
                return;
            }

            const chunkStr = chunk.toString();
            Logger.debug(`${model.name} 接收到数据块: ${chunkStr.length} 字节`);
            // Logger.trace(`${model.name} 原始数据: ${chunkStr.substring(0, 500)}${chunkStr.length > 500 ? '...' : ''}`);

            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            Logger.debug(`${model.name} 处理 ${lines.length} 行数据`);

            for (const line of lines) {
                // 在处理每一行前检查取消状态
                if (token.isCancellationRequested || isResponseCompleted) {
                    handleCancellation();
                    return;
                }

                Logger.trace(`${model.name} 处理行: "${line}"`);
                if (line.startsWith('data:')) {
                    const data = line.slice(5).trim(); // 修复：slice(5)而不是slice(6)，iFlow输出不含空格分割正文
                    Logger.trace(`${model.name} 提取的数据: "${data}"`);
                    if (data === '[DONE]') {
                        Logger.debug(`${model.name} 接收到流结束标记 [DONE]，已接收内容: ${hasReceivedContent}`);
                        if (!hasReceivedContent) {
                            cleanup();
                            cancelListener.dispose();
                            reject(new Error(`${model.name} 没有接收到任何内容`));
                            return;
                        }
                        cleanup();
                        cancelListener.dispose();
                        resolve();
                        return;
                    }

                    try {
                        // Logger.trace(`${model.name} 准备解析JSON数据: "${data.substring(0, 100)}..."`);
                        const parsed: StreamResponse = JSON.parse(data);
                        Logger.trace(`${model.name} JSON解析成功`);

                        Logger.debug(`${model.name} 接收到数据块:`, {
                            hasChoices: !!(parsed.choices && parsed.choices.length > 0),
                            choicesCount: parsed.choices?.length || 0,
                            hasUsage: !!parsed.usage
                            // rawData: data.substring(0, 200) + (data.length > 200 ? '...' : '')
                        });

                        // 在处理数据块前再次检查取消状态
                        if (token.isCancellationRequested || isResponseCompleted) {
                            handleCancellation();
                            return;
                        }

                        // Logger.trace(`${model.name} 准备调用processStreamChunk`);
                        const hasContent = this.processStreamChunk(parsed, model, progress, toolCallProcessor, token);
                        // Logger.trace(`${model.name} processStreamChunk调用完成，返回: ${hasContent}`);

                        // 更新内容接收状态 - 包括usage chunk也算作有效处理
                        if (hasContent) {
                            hasReceivedContent = true;
                            Logger.trace(`${model.name} 标记为已接收内容，hasContent=${hasContent}`);
                        } else {
                            Logger.trace(`${model.name} 未标记为已接收内容，hasContent=${hasContent}，数据="${data.substring(0, 100)}..."`);
                        }
                    } catch (error) {
                        Logger.error(`${model.name} 解析流式响应失败: 数据="${data.substring(0, 100)}..."，错误: ${error instanceof Error ? error.message : '未知错误'}`);
                        Logger.error(`${model.name} 完整数据: "${data}"`);
                        // 不抛出错误，继续处理其他数据块
                    }
                }
            }
        });

        res.on('end', () => {
            if (isResponseCompleted) {
                return;
            }

            // 处理剩余的工具调用
            if (toolCallProcessor.hasPendingToolCalls()) {
                Logger.debug(`${model.name} 流结束时处理剩余的工具调用: ${toolCallProcessor.getPendingCount()} 个`);
                // 在处理工具调用前检查取消状态
                if (token.isCancellationRequested) {
                    handleCancellation();
                    return;
                }
                const toolCallsProcessed = toolCallProcessor.processBufferedToolCalls(progress, token);
                if (toolCallsProcessed) {
                    hasReceivedContent = true; // 工具调用也算有效内容
                }
            }

            Logger.debug(`${model.name} 流式响应结束，是否接收到内容: ${hasReceivedContent}`);
            cleanup();
            cancelListener.dispose();

            if (!hasReceivedContent) {
                reject(new Error(`${model.name} 没有接收到任何内容`));
            } else {
                resolve();
            }
        });

        res.on('error', (error) => {
            if (isResponseCompleted) {
                return;
            }
            Logger.error(`${model.name} 流式响应错误`, error);
            cleanup();
            cancelListener.dispose();
            reject(error);
        });
    }

    /**
     * 处理流式响应块 - 增强版本，正确处理包含usage信息的最终chunk
     */
    private processStreamChunk(
        chunk: StreamResponse,
        model: vscode.LanguageModelChatInformation,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        toolCallProcessor: ToolCallProcessor,
        token: vscode.CancellationToken
    ): boolean {
        let hasContent = false;
        Logger.trace(`${model.name} processStreamChunk开始处理: choices=${chunk.choices?.length || 0}, usage=${!!chunk.usage}`);

        // 检查取消状态
        if (token.isCancellationRequested) {
            Logger.debug(`${model.name} 在处理数据块时检测到取消请求`);
            return false;
        }

        // 检查是否是包含usage信息的最终chunk
        if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
            // 输出usage信息
            const usage = chunk.usage;
            Logger.info(`${model.name} Token使用: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`);
            // 这是最终的usage chunk，返回true表示已处理，但不报告内容
            return true;
        }

        // 处理正常的choices
        for (const choice of chunk.choices || []) {
            // 在处理每个choice前检查取消状态
            if (token.isCancellationRequested) {
                Logger.debug(`${model.name} 在处理choice时检测到取消请求`);
                return hasContent;
            }

            const delta = choice.delta;

            if (!delta) {
                Logger.trace(`${model.name} choice没有delta字段`);
                continue;
            }

            Logger.trace(`${model.name} 处理delta: ${JSON.stringify(delta)}`);

            // 处理文本内容 - 包括空字符串（某些模型会发送空内容作为占位符）
            if (delta.content !== undefined && typeof delta.content === 'string') {
                if (delta.content.length > 0) {
                    Logger.debug(`${model.name} 接收到文本内容: ${delta.content.length} 字符 - "${delta.content.substring(0, 50)}"`);

                    // 在报告进度前检查取消状态
                    if (token.isCancellationRequested) {
                        Logger.debug(`${model.name} 在报告文本内容时检测到取消请求`);
                        return hasContent;
                    }

                    progress.report(new vscode.LanguageModelTextPart(delta.content));
                    hasContent = true;
                } else {
                    Logger.trace(`${model.name} 接收到空文本内容（占位符）`);
                    hasContent = true; // 即使是空字符串也算有效响应
                }
            } else if (delta.content !== undefined) {
                Logger.debug(`${model.name} 接收到非字符串内容类型: ${typeof delta.content}, 内容: ${JSON.stringify(delta.content)}`);
            } else {
                Logger.trace(`${model.name} delta中没有content字段`);
            }

            // 处理工具调用 - 累积分块数据
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                Logger.debug(`${model.name} 接收到工具调用数据: ${delta.tool_calls.length} 个调用`);
                for (const toolCall of delta.tool_calls) {
                    // 在处理每个工具调用前检查取消状态
                    if (token.isCancellationRequested) {
                        Logger.debug(`${model.name} 在处理工具调用时检测到取消请求`);
                        return hasContent;
                    }
                    toolCallProcessor.processToolCallChunk(toolCall);
                }
                hasContent = true; // 工具调用数据也算有效内容
            }

            // 检查流是否结束 - 关键的完成处理
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
                Logger.debug(`${model.name} 流已结束，原因: ${choice.finish_reason}`);

                // 如果是工具调用结束，处理缓存中的工具调用
                if (choice.finish_reason === 'tool_calls') {
                    // 在处理工具调用前检查取消状态
                    if (token.isCancellationRequested) {
                        Logger.debug(`${model.name} 在处理缓存工具调用时检测到取消请求`);
                        return hasContent;
                    }

                    const toolCallsProcessed = toolCallProcessor.processBufferedToolCalls(progress, token);
                    hasContent = toolCallsProcessed || hasContent;
                    // 确保工具调用结束时总是标记为有内容
                    if (toolCallProcessor.hasPendingToolCalls() || toolCallsProcessed) {
                        hasContent = true;
                    }
                }
            }
        }

        // 输出usage信息（如果在正常choices中）
        if (chunk.usage) {
            const usage = chunk.usage;
            Logger.info(`${model.name} Token使用: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`);
        }

        Logger.trace(`${model.name} processStreamChunk返回: hasContent=${hasContent}, choices=${chunk.choices?.length || 0}, usage=${!!chunk.usage}`);
        return hasContent;
    }
}
