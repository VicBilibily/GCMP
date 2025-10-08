/*---------------------------------------------------------------------------------------------
 *  OpenAI格式适配器 - 支持OpenAI兼容的API
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI from 'openai';
import { CompletionContext, CompletionResponse, InlineCompletionConfig, ICompletionProvider } from './types';
import { ContextBuilder } from './contextBuilder';
import { ApiKeyManager, Logger } from '../../utils';

/**
 * OpenAI格式补全适配器
 * 支持所有OpenAI兼容的API（智谱、百度、阿里等）
 */
export class OpenAIStyleCompletionProvider implements ICompletionProvider {
    constructor(
        private readonly providerId: string,
        private readonly baseURL: string,
        private readonly defaultModel: string
    ) { }

    /**
     * 请求补全
     */
    async requestCompletion(
        context: CompletionContext,
        config: InlineCompletionConfig,
        token: vscode.CancellationToken
    ): Promise<CompletionResponse | null> {
        try {
            const apiKey = await ApiKeyManager.getApiKey(this.providerId);
            if (!apiKey) {
                return null;
            }

            // 构建提示词
            const prompt = ContextBuilder.buildPrompt(context, { maxCompletionLength: config.maxCompletionLength });

            // 创建OpenAI客户端
            const client = new OpenAI({
                apiKey: apiKey,
                baseURL: this.baseURL
            });

            // 检查取消
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            // 调用API
            const response = await client.chat.completions.create({
                model: config.model || this.defaultModel,
                messages: [
                    {
                        role: 'system',
                        content: '你是一个专业的代码补全助手，专注于根据上下文生成准确、简洁的代码补全建议。'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: config.maxCompletionLength,
                temperature: config.temperature,
                stream: false
            });

            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const completionText = response.choices[0]?.message?.content || '';

            if (!completionText) {
                return null;
            }

            return {
                text: completionText
            };
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                throw error;
            }
            Logger.error(`${this.providerId} 补全请求失败:`, error instanceof Error ? error : undefined);
            return null;
        }
    }

    /**
     * 获取提供商ID
     */
    getProviderId(): string {
        return this.providerId;
    }

    /**
     * 获取支持的模型列表
     */
    getSupportedModels(): string[] {
        // 子类应该覆盖此方法
        return [this.defaultModel];
    }
}

/**
 * 智谱AI补全提供者
 */
export class ZhipuCompletionProvider extends OpenAIStyleCompletionProvider {
    constructor() {
        super(
            'zhipu',
            'https://open.bigmodel.cn/api/paas/v4',
            'glm-4-flash'
        );
    }

    getSupportedModels(): string[] {
        return ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4'];
    }
}

/**
 * 百度文心补全提供者
 */
export class BaiduCompletionProvider extends OpenAIStyleCompletionProvider {
    constructor() {
        super(
            'baidu',
            'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop',
            'ERNIE-4.0-8K'
        );
    }

    getSupportedModels(): string[] {
        return ['ERNIE-4.0-8K', 'ERNIE-3.5-8K', 'ERNIE-Speed-8K'];
    }
}

/**
 * 阿里通义补全提供者
 */
export class DashscopeCompletionProvider extends OpenAIStyleCompletionProvider {
    constructor() {
        super(
            'dashscope',
            'https://dashscope.aliyuncs.com/compatible-mode/v1',
            'qwen-turbo'
        );
    }

    getSupportedModels(): string[] {
        return ['qwen-turbo', 'qwen-plus', 'qwen-max'];
    }
}

/**
 * DeepSeek补全提供者
 */
export class DeepSeekCompletionProvider extends OpenAIStyleCompletionProvider {
    constructor() {
        super(
            'deepseek',
            'https://api.deepseek.com/v1',
            'deepseek-chat'
        );
    }

    getSupportedModels(): string[] {
        return ['deepseek-chat', 'deepseek-coder'];
    }
}
