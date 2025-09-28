/*---------------------------------------------------------------------------------------------
 *  通用Provider类
 *  基于配置文件动态创建供应商实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    Progress,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { createByEncoderName, TikTokenizer } from '@microsoft/tiktokenizer';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger, OpenAIHandler } from '../utils';

/**
 * 通用模型供应商类
 * 基于配置文件动态创建供应商实现
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    private readonly openaiHandler: OpenAIHandler;
    private readonly providerKey: string;
    private providerConfig: ProviderConfig; // 移除 readonly 以支持动态配置
    private o200kTokenizerPromise?: Promise<TikTokenizer>;

    constructor(
        providerKey: string,
        providerConfig: ProviderConfig
    ) {
        this.providerKey = providerKey;
        this.providerConfig = providerConfig;

        // 创建OpenAI SDK处理器
        this.openaiHandler = new OpenAIHandler(
            providerKey,
            providerConfig.displayName,
            providerConfig.baseUrl
        );

        // 初始化 o200k_base tokenizer
        this.o200kTokenizerPromise = createByEncoderName('o200k_base');
    }

    /**
     * 静态工厂方法 - 根据配置创建并激活供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): GenericModelProvider {
        Logger.trace(`${providerConfig.displayName} 模型扩展已激活!`);

        // 创建供应商实例
        const provider = new GenericModelProvider(providerKey, providerConfig);

        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(
            `gcmp.${providerKey}`,
            provider
        );
        context.subscriptions.push(providerDisposable);

        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setApiKey`,
            async () => {
                await ApiKeyManager.promptAndSetApiKey(
                    providerKey,
                    providerConfig.displayName,
                    providerConfig.apiKeyTemplate
                );
            }
        );
        context.subscriptions.push(setApiKeyCommand);

        return provider;
    }

    /**
     * 将ModelConfig转换为LanguageModelChatInformation
     */
    private modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        const info: LanguageModelChatInformation = {
            id: model.id,
            name: model.name,
            tooltip: model.tooltip,
            // family: 'claude', // 高效编辑工具 GHC 用 claude 判断
            family: `gpt-${model.id}`, // 批量编辑工具 GHC 用 gpt 判断
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            capabilities: model.capabilities
        };

        return info;
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // 检查是否有API密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            // 非静默模式下，直接触发API密钥设置
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.setApiKey`);
            // 重新检查API密钥
            const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerKey);
            if (!hasApiKeyAfterSet) {
                // 如果用户取消设置或设置失败，返回空列表
                return [];
            }
        }

        // 将配置中的模型转换为VS Code所需的格式
        return this.providerConfig.models.map(model => this.modelConfigToInfo(model));
    }

    /**
     * 更新模型配置（用于动态模型支持）
     */
    updateProviderConfig(newConfig: ProviderConfig): void {
        this.providerConfig = newConfig;
    }

    /**
     * 获取当前模型配置
     */
    getProviderConfig(): ProviderConfig {
        return this.providerConfig;
    }
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.providerConfig.models.find(m => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 确保有API密钥（最后的保险检查）
        await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName);

        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求: ${modelConfig.name}`);

        try {
            await this.openaiHandler.handleRequest(model, messages, options, progress, token);
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            // 直接抛出错误，让VS Code处理重试
            throw error;
        }
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatMessage,
        _token: CancellationToken
    ): Promise<number> {
        Logger.info(`🔢 provideTokenCount 被调用 - 模型: ${model.id}, 输入类型: ${typeof text}`);
        try {
            const tokenizer = await this.o200kTokenizerPromise;
            if (!tokenizer) {
                throw new Error('Tokenizer 初始化失败');
            }

            if (typeof text === 'string') {
                return tokenizer.encode(text).length;
            } else {
                let fullText = '';
                if (Array.isArray(text.content)) {
                    for (const part of text.content) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            fullText += part.value;
                        } else if (part instanceof vscode.LanguageModelDataPart) {
                            fullText += '[data]';
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            fullText += `[toolcall:${part.name}]`;
                        } else if (part instanceof vscode.LanguageModelToolResultPart) {
                            fullText += `[toolresult:${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}]`;
                        }
                    }
                }
                return tokenizer.encode(fullText).length;
            }
        } catch (error) {
            Logger.warn(`Tokenizer 计数失败，回退到估算方式: ${error}`);
            // Fallback 到原有估算方式
            if (typeof text === 'string') {
                // 对于纯文本，使用改进的估算算法
                // 考虑中英文混合的情况
                const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
                const englishWords = (text.match(/\b\w+\b/g) || []).length;
                const symbols = text.length - chineseChars - englishWords;

                // 中文字符约1.5个token，英文单词约1个token，符号约0.5个token
                return Math.ceil(chineseChars * 1.5 + englishWords + symbols * 0.5);
            } else {
                // 对于复杂消息，分别计算各部分的token
                let totalTokens = 0;

                if (Array.isArray(text.content)) {
                    for (const part of text.content) {
                        if (part instanceof vscode.LanguageModelTextPart) {
                            const partTokens = await this.provideTokenCount(model, part.value, _token);
                            totalTokens += partTokens;
                        } else if (part instanceof vscode.LanguageModelDataPart) {
                            // 图片或数据部分根据类型估算token
                            if (part.mimeType.startsWith('image/')) {
                                totalTokens += 170; // 图片大约170个token
                            } else {
                                totalTokens += Math.ceil(part.data.length / 10); // 其他数据估算
                            }
                        } else if (part instanceof vscode.LanguageModelToolCallPart) {
                            // 工具调用的token计算
                            const toolCallText = `${part.name}(${JSON.stringify(part.input)})`;
                            const toolTokens = await this.provideTokenCount(model, toolCallText, _token);
                            totalTokens += toolTokens;
                        } else if (part instanceof vscode.LanguageModelToolResultPart) {
                            // 工具结果的token计算
                            const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                            const resultTokens = await this.provideTokenCount(model, resultText, _token);
                            totalTokens += resultTokens;
                        }
                    }
                }

                // 添加角色和结构的固定开销
                totalTokens += 4; // 角色和结构开销

                return totalTokens;
            }
        }
    }
}
