/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用 Claude SDK 的智谱AI模型请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, handleAnthropicStream, convertToAnthropicTools } from './anthropicConverter';
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
            const result = await handleAnthropicStream(stream, progress, token);
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
}
