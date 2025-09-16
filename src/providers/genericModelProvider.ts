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
import { ProviderConfig, ModelConfig, KiloCodeHeaders } from '../types/sharedTypes';
import { ApiKeyManager, Logger, ConfigManager, MultiModalDetector } from '../utils';
import { OpenAIHandler } from '../openaiHandler/openaiHandler';

/**
 * 通用模型供应商类
 * 基于配置文件动态创建供应商实现，支持kiloCode头部注入
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    private readonly openaiHandler: OpenAIHandler;
    private readonly providerKey: string;
    private readonly providerConfig: ProviderConfig;
    private readonly kiloCodeHeaders?: KiloCodeHeaders;

    constructor(
        providerKey: string,
        providerConfig: ProviderConfig,
        kiloCodeHeaders?: KiloCodeHeaders
    ) {
        this.providerKey = providerKey;
        this.providerConfig = providerConfig;
        this.kiloCodeHeaders = kiloCodeHeaders;

        // 创建OpenAI SDK处理器
        this.openaiHandler = new OpenAIHandler(
            providerKey,
            providerConfig.displayName,
            providerConfig.baseUrl
        );
    }

    /**
     * 静态工厂方法 - 根据配置创建并激活供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig,
        kiloCodeHeaders?: KiloCodeHeaders
    ): GenericModelProvider {
        Logger.info(`${providerConfig.displayName} 模型扩展已激活!`);

        // 创建供应商实例
        const provider = new GenericModelProvider(providerKey, providerConfig, kiloCodeHeaders);

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
            name: `[GCMP] ${model.name}`,
            tooltip: model.tooltip,
            family: 'claude', // 高效编辑工具 GHC 用 claude 判断
            maxInputTokens: ConfigManager.getReducedInputTokenLimit(model.maxInputTokens),
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            capabilities: model.capabilities
        };

        // 如果模型启用了kiloCode且有配置的headers，添加自定义头部
        if (model.kiloCode && this.kiloCodeHeaders) {
            // 使用类型断言来添加customHeaders属性
            (info as LanguageModelChatInformation & { customHeaders?: Record<string, string> }).customHeaders = this.kiloCodeHeaders;
        }

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
     * 根据消息内容选择实际使用的模型
     * 为自动模式模型提供智能选择功能
     */
    private selectActualModel(modelConfig: ModelConfig, messages: readonly LanguageModelChatMessage[]): ModelConfig {
        // 检查是否为自动模式模型
        if (!this.isAutoModeModel(modelConfig)) {
            return modelConfig;
        }

        // 检测消息中是否包含多模态数据
        const detectionResult = MultiModalDetector.detectInMessages(messages);

        Logger.trace(`自动模式检测结果: ${JSON.stringify(detectionResult)}`);

        // 根据模型配置和检测结果选择合适的模型
        const selectedModel = this.getTargetModelForAutoMode(modelConfig, detectionResult.hasImages || detectionResult.hasMultiModal);

        if (selectedModel) {
            Logger.info(`自动模式: 由 ${modelConfig.name} 定向到 ${selectedModel.name} (检测到${detectionResult.hasImages ? '图片' : '多模态'}数据: ${detectionResult.hasImages})`);
            return selectedModel;
        }

        Logger.warn(`自动模式: 无法为 ${modelConfig.name} 找到合适的目标模型，继续使用原模型`);
        return modelConfig;
    }

    /**
     * 检查是否为自动模式模型
     * 通过配置文件中的 autoModel 字段判断
     */
    private isAutoModeModel(modelConfig: ModelConfig): boolean {
        return modelConfig.autoModel !== undefined;
    }

    /**
     * 根据自动模式模型配置和是否包含多模态数据，获取目标模型
     */
    private getTargetModelForAutoMode(autoModelConfig: ModelConfig, hasMultiModal: boolean): ModelConfig | null {
        if (!autoModelConfig.autoModel) {
            Logger.warn(`模型 ${autoModelConfig.id} 缺少 autoModel 配置`);
            return null;
        }

        const targetId = hasMultiModal ? autoModelConfig.autoModel.vision : autoModelConfig.autoModel.default;
        const targetModel = this.providerConfig.models.find(m => m.id === targetId);

        if (!targetModel) {
            Logger.warn(`自动模式: 未找到目标模型 ${targetId}`);
            return null;
        }

        Logger.debug(`自动模式: ${autoModelConfig.id} -> ${targetId} (多模态: ${hasMultiModal})`);
        return targetModel;
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        let modelConfig = this.providerConfig.models.find(m => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 检查是否为自动模式模型，需要根据消息内容选择实际模型
        const actualModel = this.selectActualModel(modelConfig, messages);
        if (actualModel.id !== modelConfig.id) {
            modelConfig = actualModel;
            // 更新model信息以反映实际使用的模型
            model = {
                ...model,
                id: actualModel.id,
                name: `[GCMP] ${actualModel.name}`,
                tooltip: actualModel.tooltip,
                maxInputTokens: ConfigManager.getReducedInputTokenLimit(actualModel.maxInputTokens),
                maxOutputTokens: actualModel.maxOutputTokens,
                capabilities: actualModel.capabilities
            };
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
        _model: LanguageModelChatInformation,
        text: string | LanguageModelChatMessage,
        _token: CancellationToken
    ): Promise<number> {
        // 增强的Token计数实现
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
                        const partTokens = await this.provideTokenCount(_model, part.value, _token);
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
                        const toolTokens = await this.provideTokenCount(_model, toolCallText, _token);
                        totalTokens += toolTokens;
                    } else if (part instanceof vscode.LanguageModelToolResultPart) {
                        // 工具结果的token计算
                        const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                        const resultTokens = await this.provideTokenCount(_model, resultText, _token);
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
