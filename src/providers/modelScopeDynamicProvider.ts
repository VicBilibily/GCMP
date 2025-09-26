/*---------------------------------------------------------------------------------------------
 *  ModelScope 魔搭社区 动态模型提供商
 *  使用组合模式，集成现有的OpenAIHandler作为统一处理器并添加动态模型获取
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ModelScopeApiClient, ApiKeyManager, OpenAIHandler } from '../utils';

/**
 * ModelScope 动态模型供应商类
 * 使用OpenAIHandler作为统一处理器，支持从 API 动态获取模型列表
 */
export class ModelScopeDynamicProvider {
    private static readonly PROVIDER_KEY = 'modelscope';
    private static readonly DISPLAY_NAME = 'ModelScope.cn';
    private static readonly BASE_URL = 'https://api-inference.modelscope.cn/v1';

    private openaiHandler: OpenAIHandler;
    private lastModelFetchTime = 0;
    private cachedModels: ModelConfig[] = []; // 添加模型缓存
    private readonly MODEL_REFRESH_INTERVAL = 30 * 60 * 1000; // 30分钟刷新一次模型列表

    constructor() {
        // 创建 OpenAI Handler 作为统一处理器
        this.openaiHandler = new OpenAIHandler(
            ModelScopeDynamicProvider.PROVIDER_KEY,
            ModelScopeDynamicProvider.DISPLAY_NAME,
            ModelScopeDynamicProvider.BASE_URL
        );
    }

    /**
     * 静态工厂方法 - 创建并激活提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): ModelScopeDynamicProvider {
        const provider = new ModelScopeDynamicProvider();

        // 注册语言模型聊天提供商
        const registration = vscode.lm.registerLanguageModelChatProvider(
            `gcmp.${ModelScopeDynamicProvider.PROVIDER_KEY}`,
            provider
        );

        context.subscriptions.push(registration);

        // 注册 API 密钥设置命令
        const setApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${ModelScopeDynamicProvider.PROVIDER_KEY}.setApiKey`,
            async () => {
                await ApiKeyManager.promptAndSetApiKey(
                    ModelScopeDynamicProvider.PROVIDER_KEY,
                    ModelScopeDynamicProvider.DISPLAY_NAME,
                    'ms-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
                );
            }
        );
        context.subscriptions.push(setApiKeyCommand);

        // 注册模型刷新命令
        const refreshModelsCommand = vscode.commands.registerCommand(
            `gcmp.${ModelScopeDynamicProvider.PROVIDER_KEY}.refreshModels`,
            async () => {
                await provider.refreshModels();
                vscode.window.showInformationMessage('ModelScope 模型列表已刷新');
            }
        );
        context.subscriptions.push(refreshModelsCommand);

        Logger.info(`${ModelScopeDynamicProvider.DISPLAY_NAME} 动态提供商已激活`);

        return provider;
    }

    /**
     * 获取当前有效的模型列表（动态获取）
     */
    private async getEffectiveModels(): Promise<ModelConfig[]> {
        const now = Date.now();

        // 检查是否需要刷新模型列表
        if (now - this.lastModelFetchTime > this.MODEL_REFRESH_INTERVAL || this.cachedModels.length === 0) {
            try {
                Logger.info('开始获取 ModelScope 动态模型列表...');
                const dynamicModels = await ModelScopeApiClient.fetchModels();

                if (dynamicModels.length > 0) {
                    this.lastModelFetchTime = now;
                    this.cachedModels = dynamicModels; // 缓存模型列表
                    Logger.info(`成功获取 ${dynamicModels.length} 个 ModelScope 动态模型`);
                    return dynamicModels;
                }
            } catch (error) {
                Logger.warn('获取 ModelScope 动态模型失败:', error);
            }
        }

        // 如果未到刷新时间且有缓存，返回缓存的模型
        if (this.cachedModels.length > 0) {
            Logger.info(`使用缓存的 ModelScope 模型列表，共 ${this.cachedModels.length} 个模型`);
            return this.cachedModels;
        }

        // 如果没有缓存且动态获取失败，使用硬编码的默认模型
        Logger.warn('无法获取 ModelScope 模型');
        return [];
    }

    /**
     * 实现 LanguageModelChatProvider 接口 - 提供模型信息
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
            Logger.info(`ModelScope provideLanguageModelChatInformation 被调用，silent: ${options.silent}`);

            // 检查是否有API密钥
            const hasApiKey = await ApiKeyManager.hasValidApiKey(ModelScopeDynamicProvider.PROVIDER_KEY);
            Logger.info(`ModelScope API密钥检查结果: ${hasApiKey}`);

            if (!hasApiKey) {
                // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
                if (options.silent) {
                    Logger.info('ModelScope 静默模式下无API密钥，返回空列表');
                    return [];
                }
                // 非静默模式下，直接触发API密钥设置
                await vscode.commands.executeCommand(`gcmp.${ModelScopeDynamicProvider.PROVIDER_KEY}.setApiKey`);
                // 重新检查API密钥
                const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(ModelScopeDynamicProvider.PROVIDER_KEY);
                if (!hasApiKeyAfterSet) {
                    // 如果用户取消设置或设置失败，返回空列表
                    Logger.info('ModelScope 用户取消设置API密钥，返回空列表');
                    return [];
                }
            }

            // 获取动态模型列表
            const models = await this.getEffectiveModels();
            Logger.info(`ModelScope 获取到动态模型，数量: ${models.length}`);

            // 将配置中的模型转换为VS Code所需的格式
            const modelInfos = models.map(model => this.modelConfigToInfo(model));
            Logger.info(`ModelScope 返回模型信息数量: ${modelInfos.length}`);
            return modelInfos;

        } catch (error) {
            Logger.error('ModelScope 提供模型信息失败:', error);
            return [];
        }
    }

    /**
     * 实现 LanguageModelChatProvider 接口 - 处理聊天请求
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<vscode.LanguageModelChatMessage>,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            // 确保有API密钥（最后的保险检查）
            await ApiKeyManager.ensureApiKey(
                ModelScopeDynamicProvider.PROVIDER_KEY,
                ModelScopeDynamicProvider.DISPLAY_NAME
            );

            Logger.info(`${ModelScopeDynamicProvider.DISPLAY_NAME} Provider 开始处理请求: ${model.name}`);

            // 直接使用 OpenAIHandler 处理请求
            await this.openaiHandler.handleRequest(model, messages, options, progress, token);

        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            // 直接抛出错误，让VS Code处理重试
            throw error;
        }
    }

    /**
     * 实现 LanguageModelChatProvider 接口 - 提供 Token 计数
     */
    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatMessage,
        token: CancellationToken
    ): Promise<number> {
        // 简单的字符数估算（作为降级方案）
        const content = typeof text === 'string' ? text :
            Array.isArray(text.content) ?
                text.content.map(part =>
                    part instanceof vscode.LanguageModelTextPart ? part.value : ''
                ).join('') :
                text.content as string;

        // 粗略估算：平均每个 token 约 3-4 个字符
        return Math.ceil(content.length / 3.5);
    }

    /**
     * 将ModelConfig转换为LanguageModelChatInformation
     */
    private modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        const info: LanguageModelChatInformation = {
            id: model.id,
            name: model.name,
            tooltip: model.tooltip,
            family: 'claude', // 高效编辑工具 GHC 用 claude 判断
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            capabilities: model.capabilities
        };

        return info;
    }

    /**
     * 手动刷新模型列表
     */
    async refreshModels(): Promise<void> {
        try {
            Logger.info('手动刷新 ModelScope 模型列表...');

            // 清除所有缓存
            ModelScopeApiClient.clearCache();
            this.lastModelFetchTime = 0;
            this.cachedModels = []; // 清除本地缓存

            // 重新获取模型列表
            const models = await this.getEffectiveModels();
            Logger.info(`刷新完成，获取到 ${models.length} 个 ModelScope 模型`);

        } catch (error) {
            Logger.error('刷新 ModelScope 模型列表失败:', error);
            throw error;
        }
    }

    /**
     * 清理资源
     */
    dispose(): void {
        this.openaiHandler.dispose();
        Logger.trace(`${ModelScopeDynamicProvider.DISPLAY_NAME} Provider 已清理`);
    }
}