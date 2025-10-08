/*---------------------------------------------------------------------------------------------
 *  Ghost Model - AI 模型调用
 *  使用 OpenAI SDK 调用智谱 AI 编程套餐
 *--------------------------------------------------------------------------------------------*/

import OpenAI from 'openai';
import { ApiKeyManager } from '../../utils';
import { Logger } from '../../utils/logger';
import type { ApiUsage, StreamChunk } from './types';

/**
 * Ghost AI 模型
 */
export class GhostModel {
    private client: OpenAI | null = null;
    private modelId = 'glm-4.5-air';
    public loaded = false;

    constructor() {
        void this.initialize();
    }

    /**
     * 初始化模型
     */
    private async initialize(): Promise<void> {
        try {
            const apiKey = await ApiKeyManager.getApiKey('zhipu');
            if (!apiKey) {
                Logger.warn('Ghost: 未设置智谱 AI API 密钥');
                return;
            }

            this.client = new OpenAI({
                apiKey,
                baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4'
            });

            this.loaded = true;
            Logger.info('Ghost Model 初始化成功');
        } catch (error) {
            Logger.error('Ghost Model 初始化失败:', error);
            this.loaded = false;
        }
    }

    /**
     * 重新加载模型
     */
    public async reload(): Promise<void> {
        this.client = null;
        this.loaded = false;
        await this.initialize();
    }

    /**
     * 设置模型 ID
     */
    public setModelId(modelId: string): void {
        this.modelId = modelId;
    }

    /**
     * 获取模型名称
     */
    public getModelName(): string {
        return this.modelId;
    }

    /**
     * 检查是否有有效凭证
     */
    public hasValidCredentials(): boolean {
        return this.loaded && this.client !== null;
    }

    /**
     * 生成代码补全
     */
    public async generateCompletion(
        systemPrompt: string,
        userPrompt: string,
        onChunk?: (chunk: StreamChunk) => void
    ): Promise<{ text: string; usage: ApiUsage }> {
        if (!this.client || !this.loaded) {
            throw new Error('Ghost Model 未初始化');
        }

        let fullText = '';
        let inputTokens = 0;
        let outputTokens = 0;

        try {
            const body: OpenAI.ChatCompletionCreateParamsStreaming = {
                model: this.modelId,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                stream: true,
                temperature: 0.1
            };
            (body as unknown as { thinking: { type: 'disabled' } }).thinking = { type: 'disabled' };
            const stream = await this.client.chat.completions.create(body);

            for await (const chunk of stream) {
                const delta = chunk.choices[0]?.delta;

                if (delta?.content) {
                    fullText += delta.content;
                    onChunk?.({
                        type: 'text',
                        text: delta.content
                    });
                }

                // 处理使用信息
                if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens || 0;
                    outputTokens = chunk.usage.completion_tokens || 0;
                }
            }

            // 计算成本（智谱编程套餐价格）
            const cost = (inputTokens * 0.0001 + outputTokens * 0.0001) / 1000;

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
            Logger.error('生成代码补全失败:', error);
            throw error;
        }
    }
}
