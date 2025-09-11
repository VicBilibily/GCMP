/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用Claude SDK的智谱AI模型请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, handleAnthropicStream, convertToAnthropicTools } from '../converters/anthropicConverter';
import { ModelHandler, SDKType } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';

/**
 * 通用Anthropic兼容处理器类
 * 接收完整的供应商配置，不依赖模型metadata
 */
export class AnthropicHandler implements ModelHandler {
    readonly sdkType = SDKType.ANTHROPIC;
    
    private clients = new Map<string, Anthropic>();
    private cachedApiKeys = new Map<string, string>();
    
    constructor(
        public readonly provider: string,
        private readonly baseURL: string
    ) {
        // provider 和 baseURL 由调用方传入
    }
    
    /**
     * 获取或创建Anthropic客户端
     * 使用构造时传入的配置
     */
    private async getAnthropicClient(): Promise<Anthropic> {
        const currentApiKey = await ApiKeyManager.getApiKey(this.provider);
        
        if (!currentApiKey) {
            throw new Error(`缺少${this.provider}API密钥`);
        }
        
        const clientKey = `${this.provider}_${this.baseURL}`;
        const cachedKey = this.cachedApiKeys.get(clientKey);
        
        // 如果API密钥变更了，重置客户端
        if (!this.clients.has(clientKey) || cachedKey !== currentApiKey) {
            const client = new Anthropic({
                apiKey: currentApiKey,
                baseURL: this.baseURL
            });
            
            this.clients.set(clientKey, client);
            this.cachedApiKeys.set(clientKey, currentApiKey);
            Logger.info(`${this.provider} Anthropic兼容客户端已重新创建（API密钥更新）`);
        }
        
        return this.clients.get(clientKey)!;
    }
    
    /**
     * 重置客户端
     */
    resetClient(): void {
        this.clients.clear();
        this.cachedApiKeys.clear();
        Logger.debug('Anthropic兼容客户端已重置');
    }
    
    /**
     * 处理Anthropic SDK请求
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        try {
            const client = await this.getAnthropicClient();
            const { messages: anthropicMessages, system } = apiMessageToAnthropicMessage(messages as vscode.LanguageModelChatMessage[]);
            
            // 准备工具定义
            const tools: Anthropic.Messages.Tool[] = options.tools ? convertToAnthropicTools([...options.tools]) : [];
            
            const createParams: Anthropic.MessageCreateParamsStreaming = {
                model: model.id,
                max_tokens: model.maxOutputTokens,
                messages: anthropicMessages,
                stream: true
            };
            
            // 添加系统消息（如果有）
            if (system.text) {
                createParams.system = [system];
            }
            
            // 添加工具（如果有）
            if (tools.length > 0) {
                createParams.tools = tools;
            }
            
            Logger.debug(`[${model.name}] 发送 Anthropic API 请求，包含 ${anthropicMessages.length} 条消息`);
            const stream = await client.messages.create(createParams);
            
            // 使用完整的流处理函数
            const result = await handleAnthropicStream(stream, progress, token);
            Logger.debug(`[${model.name}] Anthropic 请求完成`, result.usage);
            
        } catch (error) {
            console.error(`[${model.name}] Anthropic SDK error:`, error);
            
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
        }
    }
    
    /**
     * 清理资源
     */
    dispose(): void {
        this.resetClient();
        Logger.debug('AnthropicHandler 已清理');
    }
}