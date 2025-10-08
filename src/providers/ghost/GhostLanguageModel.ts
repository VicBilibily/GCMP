/*---------------------------------------------------------------------------------------------
 *  Ghost Language Model - 使用 VS Code Language Model API
 *  支持 GitHub Copilot 和其他语言模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../../utils/logger';
import type { ApiUsage, StreamChunk } from './types';

/**
 * Ghost AI 模型（使用 VS Code Language Model API）
 */
export class GhostLanguageModel {
    public loaded = false;
    private modelFamily = 'gpt-4o';
    private modelVendor = 'copilot';

    constructor() {
        void this.initialize();
    }

    /**
     * 初始化模型
     */
    private async initialize(): Promise<void> {
        try {
            // 检查是否有可用的模型
            const models = await vscode.lm.selectChatModels({
                vendor: this.modelVendor,
                family: this.modelFamily
            });

            if (models.length === 0) {
                Logger.warn('Ghost: 没有找到可用的语言模型');
                this.loaded = false;
                return;
            }

            this.loaded = true;
            Logger.info(`Ghost Language Model 初始化成功 (${this.modelVendor}/${this.modelFamily})`);
        } catch (error) {
            Logger.error('Ghost Language Model 初始化失败:', error);
            this.loaded = false;
        }
    }

    /**
     * 重新加载模型
     */
    public async reload(): Promise<void> {
        this.loaded = false;
        await this.initialize();
    }

    /**
     * 设置模型配置
     */
    public setModelConfig(vendor: string, family: string): void {
        this.modelVendor = vendor;
        this.modelFamily = family;
    }

    /**
     * 获取模型名称
     */
    public getModelName(): string {
        return `${this.modelVendor}/${this.modelFamily}`;
    }

    /**
     * 检查是否有有效凭证
     */
    public hasValidCredentials(): boolean {
        return this.loaded;
    }

    /**
     * 生成代码补全
     */
    public async generateCompletion(
        systemPrompt: string,
        userPrompt: string,
        onChunk?: (chunk: StreamChunk) => void,
        token?: vscode.CancellationToken
    ): Promise<{ text: string; usage: ApiUsage }> {
        if (!this.loaded) {
            throw new Error('Ghost Language Model 未初始化');
        }

        let fullText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        try {
            // 选择模型
            const models = await vscode.lm.selectChatModels({
                vendor: this.modelVendor,
                family: this.modelFamily
            });

            if (models.length === 0) {
                throw new Error('没有找到可用的语言模型');
            }

            const model = models[0];

            // 构建消息
            const messages = [
                vscode.LanguageModelChatMessage.User(systemPrompt),
                vscode.LanguageModelChatMessage.User(userPrompt)
            ];

            // 发送请求
            const response = await model.sendRequest(
                messages,
                {
                    justification: 'Ghost AI code completion'
                },
                token
            );

            // 处理流式响应
            for await (const fragment of response.text) {
                if (token?.isCancellationRequested) {
                    break;
                }

                fullText += fragment;
                onChunk?.({
                    type: 'text',
                    text: fragment
                });
            }

            // 注意：VS Code Language Model API 不提供详细的 token 使用信息
            // 我们只能估算
            inputTokens = this.estimateTokens(systemPrompt + userPrompt);
            outputTokens = this.estimateTokens(fullText);

            // GitHub Copilot 对扩展是免费的，成本为 0
            const cost = 0;

            const usage: ApiUsage = {
                inputTokens,
                outputTokens,
                cost
            };

            onChunk?.({
                type: 'usage',
                usage
            });

            return { text: fullText, usage };
        } catch (error) {
            if (error instanceof vscode.LanguageModelError) {
                Logger.error('语言模型错误:', {
                    message: error.message,
                    code: error.code,
                    cause: error.cause
                });

                // 处理特定错误
                if (error.code === vscode.LanguageModelError.NotFound.name) {
                    throw new Error('找不到指定的语言模型');
                } else if (error.code === vscode.LanguageModelError.NoPermissions.name) {
                    throw new Error('没有使用语言模型的权限，请在设置中启用');
                } else if (error.code === vscode.LanguageModelError.Blocked.name) {
                    throw new Error('请求被阻止（可能因为内容不当）');
                }
            }

            Logger.error('生成代码补全失败:', error);
            throw error;
        }
    }

    /**
     * 估算 token 数量（粗略估计）
     * 英文：约 4 个字符 = 1 token
     * 中文：约 1.5 个字符 = 1 token
     */
    private estimateTokens(text: string): number {
        // 简单的估算：平均每 3 个字符算作 1 个 token
        return Math.ceil(text.length / 3);
    }
}
