/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用 Claude SDK 的智谱AI模型请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, convertToAnthropicTools } from './anthropicConverter';
import { ApiKeyManager } from './apiKeyManager';
import { Logger } from './logger';
import { ConfigManager } from './configManager';
import { VersionManager } from './versionManager';
import type { ModelConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';

/**
 * Anthropic 兼容处理器类
 * 接收完整的提供商配置，使用 Anthropic SDK 处理流式聊天完成
 */
export class AnthropicHandler {
    constructor(
        public readonly provider: string,
        public readonly displayName: string,
        private readonly baseURL?: string
    ) {
        // provider、displayName 和 baseURL 由调用方传入
    }

    /**
     * 创建 Anthropic 客户端
     * 每次都创建新的客户端实例，与 OpenAIHandler 保持一致
     */
    private async createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }

        // 使用模型配置的 baseUrl 或提供商默认的 baseURL
        const baseUrl = modelConfig?.baseUrl || this.baseURL;
        Logger.debug(`[${this.displayName}] 创建新的 Anthropic 客户端 (baseUrl: ${baseUrl})`);

        // 构建默认头部，包含提供商级别和模型级别的 customHeader
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent(this.provider)
        };

        // 处理模型级别的 customHeader
        const processedCustomHeader = ApiKeyManager.processCustomHeader(modelConfig?.customHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.debug(`${this.displayName} 应用自定义头部: ${JSON.stringify(modelConfig!.customHeader)}`);
        }

        const client = new Anthropic({
            apiKey: currentApiKey,
            baseURL: baseUrl,
            defaultHeaders: defaultHeaders
        });

        Logger.info(`${this.displayName} Anthropic 兼容客户端已创建`);
        return client;
    }

    /**
     * 处理 Anthropic SDK 请求
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
            const client = await this.createAnthropicClient(modelConfig);
            const { messages: anthropicMessages, system } = apiMessageToAnthropicMessage(messages);

            // 准备工具定义
            const tools: Anthropic.Messages.Tool[] = options.tools ? convertToAnthropicTools([...options.tools]) : [];

            // 使用模型配置中的 model 字段，如果没有则使用 model.id
            const modelId = modelConfig.model || model.id;

            const createParams: Anthropic.MessageCreateParamsStreaming = {
                model: modelId,
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                messages: anthropicMessages,
                stream: true,
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // 合并extraBody参数（如果有）
            if (modelConfig.extraBody) {
                // 过滤掉不可修改的核心参数
                const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
                Object.assign(createParams, filteredExtraBody);
                if (Object.keys(filteredExtraBody).length > 0) {
                    Logger.trace(`${model.name} 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`);
                }
            }

            // 添加系统消息（如果有）
            if (system.text) {
                createParams.system = [system];
            }

            // 添加工具（如果有）
            if (tools.length > 0) {
                createParams.tools = tools;
            }

            Logger.debug(
                `[${model.name}] 发送 Anthropic API 请求，包含 ${anthropicMessages.length} 条消息，使用模型: ${modelId}`
            );

            const stream = await client.messages.create(createParams);

            // 使用完整的流处理函数
            const result = await this.handleAnthropicStream(stream, progress, token);
            Logger.info(`[${model.name}] Anthropic 请求完成`, result.usage);
        } catch (error) {
            Logger.error(`[${model.name}] Anthropic SDK error:`, error);

            // 提供详细的错误信息
            let errorMessage = `[${model.name}] Anthropic API调用失败`;
            if (error instanceof Error) {
                if (error.message.includes('401')) {
                    errorMessage += ': API密钥无效，请检查配置';
                } else if (error.message.includes('429')) {
                    errorMessage += ': 请求频率限制，请稍后重试';
                } else if (error.message.includes('500')) {
                    errorMessage += ': 服务器错误，请稍后重试';
                } else {
                    errorMessage += `: ${error.message}`;
                }
            }

            progress.report(new vscode.LanguageModelTextPart(errorMessage));
            throw error;
        }
    }

    /**
     * 处理 Anthropic 流式响应
     * 参照官方文档：https://docs.anthropic.com/en/api/messages-streaming
     */
    private async handleAnthropicStream(
        stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken
    ): Promise<{ usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }> {
        let pendingToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        let currentThinkingBlockId: string | undefined;
        let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

        Logger.debug('开始处理 Anthropic 流式响应');

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    Logger.debug('流处理被取消');
                    break;
                }

                // 处理不同的事件类型
                switch (chunk.type) {
                    case 'message_start':
                        // 消息开始 - 收集初始使用统计
                        usage = {
                            inputTokens:
                                (chunk.message.usage.input_tokens ?? 0) +
                                (chunk.message.usage.cache_creation_input_tokens ?? 0) +
                                (chunk.message.usage.cache_read_input_tokens ?? 0),
                            outputTokens: 1,
                            totalTokens: -1
                        };
                        Logger.trace(`消息流开始 - 初始输入tokens: ${usage.inputTokens}`);
                        break;

                    case 'content_block_start':
                        // 内容块开始
                        if (chunk.content_block.type === 'tool_use') {
                            pendingToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: ''
                            };
                            Logger.trace(`工具调用开始: ${chunk.content_block.name}`);
                        } else if (chunk.content_block.type === 'thinking') {
                            // 标记思考块开始
                            currentThinkingBlockId = chunk.index.toString();
                            Logger.trace('思考块开始 (流式输出)');
                        } else if (chunk.content_block.type === 'text') {
                            Logger.trace('文本块开始');
                        }
                        break;

                    case 'content_block_delta':
                        // 内容块增量更新
                        if (chunk.delta.type === 'text_delta') {
                            // 文本内容增量
                            progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
                        } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                            // 工具调用参数增量
                            pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;
                        } else if (chunk.delta.type === 'thinking_delta') {
                            // 思考内容增量 - 流式输出
                            progress.report(new vscode.LanguageModelThinkingPart(chunk.delta.thinking));
                        }
                        break;

                    case 'content_block_stop':
                        // 内容块停止
                        if (pendingToolCall) {
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
                                progress.report(
                                    new vscode.LanguageModelToolCallPart(
                                        pendingToolCall.toolId!,
                                        pendingToolCall.name!,
                                        parsedJson
                                    )
                                );
                                Logger.debug(`工具调用完成: ${pendingToolCall.name}`);
                            } catch (e) {
                                Logger.error(`解析工具调用 JSON 失败 (${pendingToolCall.name}):`, e);
                            }
                            pendingToolCall = undefined;
                        } else if (currentThinkingBlockId !== undefined) {
                            // 思考块结束 - 发送空的 ThinkingPart 作为结束标记
                            progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingBlockId));
                            Logger.debug(`思考块完成 (id: ${currentThinkingBlockId})`);
                            currentThinkingBlockId = undefined;
                        }
                        break;

                    case 'message_delta':
                        // 消息增量 - 更新使用统计
                        if (usage && chunk.usage) {
                            // 更新输入 tokens（如果有更新）
                            if (chunk.usage.input_tokens !== undefined && chunk.usage.input_tokens !== null) {
                                usage.inputTokens =
                                    chunk.usage.input_tokens +
                                    (chunk.usage.cache_creation_input_tokens ?? 0) +
                                    (chunk.usage.cache_read_input_tokens ?? 0);
                            }
                            // 更新输出 tokens（如果有更新）
                            if (chunk.usage.output_tokens !== undefined && chunk.usage.output_tokens !== null) {
                                usage.outputTokens = chunk.usage.output_tokens;
                            }
                            // 重新计算总数
                            usage.totalTokens = usage.inputTokens + usage.outputTokens;

                            Logger.trace(
                                `Token使用更新 - 输入: ${usage.inputTokens}, 输出: ${usage.outputTokens}, 总计: ${usage.totalTokens}`
                            );
                        }
                        // 记录停止原因
                        if (chunk.delta.stop_reason) {
                            Logger.trace(`消息停止原因: ${chunk.delta.stop_reason}`);
                        }
                        break;

                    case 'message_stop':
                        // 消息停止
                        Logger.trace('消息流完成');
                        break;

                    default:
                        // 未知事件类型 - 根据官方建议优雅处理
                        // 可能包括 ping 事件或未来的新事件类型
                        Logger.trace('收到其他事件类型');
                        break;
                }
            }
        } catch (error) {
            Logger.error('处理 Anthropic 流时出错:', error);
            throw error;
        }

        if (usage) {
            Logger.debug(
                `流处理完成 - 最终使用统计: 输入=${usage.inputTokens}, 输出=${usage.outputTokens}, 总计=${usage.totalTokens}`
            );
        } else {
            Logger.warn('流处理完成但未获取到使用统计信息');
        }

        return { usage };
    }
}
