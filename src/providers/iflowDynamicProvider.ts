/*---------------------------------------------------------------------------------------------
 *  心流AI 动态模型提供商
 *  使用组合模式，集成 GenericModelProvider 的功能并添加动态模型获取
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, IFlowApiClient, ApiKeyManager } from '../utils';
import { GenericModelProvider } from './genericModelProvider';

/**
 * 心流AI 动态模型供应商类
 * 使用组合模式集成 GenericModelProvider 功能，支持从 API 动态获取模型列表
 */
export class IFlowDynamicProvider {
    private readonly genericProvider: GenericModelProvider;
    private readonly originalProviderConfig: ProviderConfig;
    private dynamicModels: ModelConfig[] = [];
    private lastModelFetch = 0;
    private readonly MODEL_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

    constructor(providerKey: string, staticProviderConfig: ProviderConfig) {
        this.originalProviderConfig = staticProviderConfig;
        // 创建内部的通用提供商实例
        this.genericProvider = new GenericModelProvider(providerKey, staticProviderConfig);
        Logger.trace(`动态提供商已初始化: ${staticProviderConfig.displayName}`);
    }

    /**
     * 静态工厂方法 - 创建并激活 心流AI 动态供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        staticProviderConfig: ProviderConfig
    ): IFlowDynamicProvider {
        Logger.trace(`${staticProviderConfig.displayName} 动态模型扩展已激活!`);

        // 创建供应商实例
        const provider = new IFlowDynamicProvider(providerKey, staticProviderConfig);

        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        context.subscriptions.push(providerDisposable);

        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                staticProviderConfig.displayName,
                staticProviderConfig.apiKeyTemplate
            );
        });
        context.subscriptions.push(setApiKeyCommand);

        // 注册刷新模型列表命令
        const refreshModelsCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.refreshModels`, async () => {
            await provider.refreshModels();
            vscode.window.showInformationMessage('心流AI 模型列表已刷新');
        });
        context.subscriptions.push(refreshModelsCommand);

        return provider;
    }

    /**
     * 获取当前有效的模型列表（动态 + 静态）
     */
    private async getEffectiveModels(): Promise<ModelConfig[]> {
        // 检查是否需要刷新动态模型
        const now = Date.now();
        if (now - this.lastModelFetch > this.MODEL_CACHE_DURATION) {
            try {
                this.dynamicModels = await IFlowApiClient.fetchModels();
                this.lastModelFetch = now;
                Logger.info(`已更新 心流AI 动态模型列表，共 ${this.dynamicModels.length} 个模型`);
            } catch (error) {
                Logger.warn('获取 心流AI 动态模型失败，使用静态模型列表:', error);
                // 如果动态获取失败但有缓存，继续使用缓存
                if (this.dynamicModels.length === 0) {
                    this.dynamicModels = this.originalProviderConfig.models;
                }
            }
        }

        // 合并动态模型和静态模型，优先使用动态模型
        const allModels = [...this.dynamicModels];

        // 添加静态模型中没有在动态模型列表中的模型
        for (const staticModel of this.originalProviderConfig.models) {
            const isDuplicate = allModels.some(dynamicModel => dynamicModel.id === staticModel.id);
            if (!isDuplicate) {
                allModels.push(staticModel);
            }
        }

        return allModels;
    }

    /**
     * 创建带有动态模型的临时提供商配置
     */
    private async createDynamicProviderConfig(): Promise<ProviderConfig> {
        const effectiveModels = await this.getEffectiveModels();
        return {
            ...this.originalProviderConfig,
            models: effectiveModels
        };
    }

    /**
     * 实现 LanguageModelChatProvider 接口 - 提供模型信息
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
            // 更新内部提供商的配置为动态配置
            const dynamicConfig = await this.createDynamicProviderConfig();
            const originalConfig = this.genericProvider.getProviderConfig();

            this.genericProvider.updateProviderConfig(dynamicConfig);

            // 委托给内部提供商
            const result = await this.genericProvider.provideLanguageModelChatInformation(options, _token);

            // 恢复原始配置
            this.genericProvider.updateProviderConfig(originalConfig);

            return result;
        } catch (error) {
            Logger.error('获取 心流AI 模型列表失败:', error);
            // 降级到使用静态配置
            return await this.genericProvider.provideLanguageModelChatInformation(options, _token);
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
        const originalConfig = this.genericProvider.getProviderConfig();
        try {
            // 更新内部提供商的配置为动态配置
            const dynamicConfig = await this.createDynamicProviderConfig();
            this.genericProvider.updateProviderConfig(dynamicConfig);

            // 委托给内部提供商
            await this.genericProvider.provideLanguageModelChatResponse(model, messages, options, progress, token);

            // 恢复原始配置
            this.genericProvider.updateProviderConfig(originalConfig);
        } catch (error) {
            // 确保恢复原始配置
            this.genericProvider.updateProviderConfig(originalConfig);
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
        // 直接委托给内部提供商
        return await this.genericProvider.provideTokenCount(model, text, token);
    }

    /**
     * 手动刷新模型列表
     */
    async refreshModels(): Promise<void> {
        Logger.info('手动刷新 心流AI 模型列表...');
        this.lastModelFetch = 0; // 重置缓存时间
        IFlowApiClient.clearCache(); // 清除 API 客户端缓存
        await this.getEffectiveModels(); // 重新获取模型
        Logger.info('心流AI 模型列表刷新完成');
    }
}
