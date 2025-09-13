import * as vscode from 'vscode';
import OpenAI from 'openai';

import { Logger } from '../utils';
import { ConfigManager } from '../utils/configManager';
import { MessageConverter } from './messageConverter';
import { ErrorHandler } from './errors';

/**
 * OpenAI SDK API处理器
 * 使用官方 SDK 的标准流式接口
 */
export class OpenAIHandler {
    private openaiClient: OpenAI | null = null;
    private messageConverter: MessageConverter;
    private errorHandler: ErrorHandler;

    constructor(
        private provider: string,
        private displayName: string,
        private baseURL?: string
    ) {
        this.messageConverter = new MessageConverter();
        this.errorHandler = new ErrorHandler(this.provider, this.displayName);
    }

    /**
     * 处理OpenAI SDK请求 - 使用官方流式接口
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        Logger.info(`${model.name} 开始处理 ${this.displayName} OpenAI 请求`);

        try {
            // 传递模型的自定义headers到客户端
            const client = await this.getOpenAIClient(model.customHeaders);

            Logger.info(`${model.name} 发送 ${messages.length} 条消息，使用 ${this.displayName}`);

            const createParams: OpenAI.Chat.ChatCompletionCreateParams = {
                model: model.id,
                messages: this.messageConverter.convertMessagesToOpenAI(messages),
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                stream: true,
                stream_options: { include_usage: true }, // 启用流式响应中的usage信息
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // 添加工具支持（如果有）
            if (options.tools && options.tools.length > 0 && model.capabilities?.toolCalling) {
                if (options.tools.length > 128) {
                    throw new Error('请求不能有超过 128 个工具');
                }
                createParams.tools = this.messageConverter.convertToolsToOpenAI([...options.tools]);
                createParams.tool_choice = 'auto';
            }

            Logger.debug(`${model.name} 发送 ${this.displayName} OpenAI API 请求`);

            // 使用官方 SDK 的 stream() 方法
            const runner = client.chat.completions.stream(createParams);

            let hasReceivedContent = false;
            let streamError: Error | null = null;

            // 监听内容块事件 - 用于流式文本输出
            runner.on('content', (contentDelta) => {
                if (contentDelta) {
                    progress.report(new vscode.LanguageModelTextPart(contentDelta));
                    hasReceivedContent = true;
                }
            });
            // 监听消息事件 - 仅处理工具调用，不处理文本内容
            runner.on('message', (message) => {
                try {
                    // 处理工具调用
                    if ('tool_calls' in message && message.tool_calls) {
                        for (const toolCall of message.tool_calls) {
                            if (toolCall.type === 'function') {
                                const toolCallId = toolCall.id;
                                const toolName = toolCall.function.name;
                                const toolArgs = toolCall.function.arguments;

                                try {
                                    const parsedArgs = typeof toolArgs === 'string' ? JSON.parse(toolArgs) : toolArgs;
                                    progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, parsedArgs));
                                    hasReceivedContent = true;
                                } catch (error) {
                                    Logger.error(`${model.name} 无法解析工具调用参数: ${toolName}`, error);
                                    // 使用空对象作为后备
                                    progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, {}));
                                    hasReceivedContent = true;
                                }
                            }
                        }
                    }
                } catch (error) {
                    Logger.error(`${model.name} 处理消息事件时出错:`, error);
                }
            });

            // 监听错误事件
            runner.on('error', (error) => {
                Logger.error(`${model.name} ${this.displayName} 流处理错误`, error);
                // 保存错误，稍后在await时处理
                streamError = error instanceof Error ? error : new Error(String(error));
                runner.abort(); // 停止流处理
            });

            // 监听取消事件
            const cancelHandler = () => {
                if (token.isCancellationRequested) {
                    Logger.warn(`${model.name} 用户取消了请求`);
                    runner.abort();
                    return true;
                }
                return false;
            };

            // 定期检查取消状态
            const cancelInterval = setInterval(cancelHandler, 100);

            try {
                // 等待流处理完成并获取最终的completion信息
                const finalMessage = await runner.finalChatCompletion();

                // 检查是否有流处理错误
                if (streamError) {
                    throw streamError;
                }

                Logger.debug(`${model.name} ${this.displayName} 流处理完成`);

                // 输出token使用情况（仅在调试模式下详细记录）
                if (finalMessage.usage) {
                    const usage = finalMessage.usage;
                    Logger.info(`${model.name} Token使用: ${usage.prompt_tokens}+${usage.completion_tokens}=${usage.total_tokens}`);
                } else {
                    Logger.debug(`${model.name} 未收到token使用信息`);
                }

                if (!hasReceivedContent) {
                    const errorMessage = `${model.name} 没有接收到任何内容`;
                    Logger.warn(errorMessage);
                    throw new Error(errorMessage);
                }

                Logger.debug(`${model.name} ${this.displayName} API请求完成`);
            } finally {
                clearInterval(cancelInterval);
            }

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`${model.name} ${this.displayName} API请求失败: ${errorMessage}`);

            // 直接抛出错误，让VS Code的重试机制处理
            throw error;
        }
    }

    /**
     * 获取或创建OpenAI客户端
     */
    private async getOpenAIClient(customHeaders?: Record<string, string>): Promise<OpenAI> {
        if (this.openaiClient) {
            return this.openaiClient;
        }

        try {
            const { ApiKeyManager } = await import('../utils/apiKeyManager');
            const apiKey = await ApiKeyManager.getApiKey(this.provider);
            if (!apiKey) {
                throw new Error(`请先设置 ${this.displayName} API密钥`);
            }

            // 从VS Code扩展API获取版本号
            const extension = vscode.extensions.getExtension('vicanent.gcmp');
            const version = extension?.packageJSON?.version || '1.0.0';

            const headers: Record<string, string> = {
                'User-Agent': `GCMP/${version}`
            };

            // 添加自定义headers
            if (customHeaders) {
                Object.assign(headers, customHeaders);
            }

            this.openaiClient = new OpenAI({
                apiKey: apiKey,
                baseURL: this.baseURL,
                defaultHeaders: headers
            });

            Logger.debug(`${this.displayName} OpenAI 客户端初始化成功`);
            return this.openaiClient;
        } catch (error) {
            Logger.error(`${this.displayName} OpenAI 客户端初始化失败`, error);
            throw error;
        }
    }
}
