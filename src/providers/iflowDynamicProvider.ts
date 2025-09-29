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
 *
 * ✨ 新增功能：请求中断管理
 * - 确保同时只允许一个请求在执行
 * - 新请求进入时自动中断之前未完成的请求
 * - 提供详细的日志记录帮助调试
 */
export class IFlowDynamicProvider {
    private readonly genericProvider: GenericModelProvider;
    private readonly originalProviderConfig: ProviderConfig;
    private dynamicModels: ModelConfig[] = [];
    private lastModelFetch = 0;
    private readonly MODEL_CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

    // 请求中断管理
    private currentRequestController: AbortController | null = null;
    private requestCounter = 0; // 用于生成唯一的请求ID

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
        // 开始新请求，这会自动中断之前的请求
        const requestId = this.startNewRequest();
        const requestController = this.currentRequestController!; // 此时一定存在

        const originalConfig = this.genericProvider.getProviderConfig();
        try {
            // 创建组合的CancellationToken
            const combinedToken = this.createCombinedCancellationToken(token, requestController);

            // 检查是否在开始前就被中断了
            if (combinedToken.isCancellationRequested) {
                Logger.info(`⚠️ 心流AI: 请求 #${requestId} 在开始前就被取消`);
                throw new vscode.CancellationError();
            }

            // 更新内部提供商的配置为动态配置
            const dynamicConfig = await this.createDynamicProviderConfig();
            this.genericProvider.updateProviderConfig(dynamicConfig);

            // 委托给内部提供商，使用组合的token
            await this.genericProvider.provideLanguageModelChatResponse(model, messages, options, progress, combinedToken);

            // 恢复原始配置
            this.genericProvider.updateProviderConfig(originalConfig);

            // 标记请求完成
            this.finishRequest(requestId);
        } catch (error) {
            // 确保恢复原始配置
            this.genericProvider.updateProviderConfig(originalConfig);

            // 标记请求完成（无论成功还是失败）
            this.finishRequest(requestId);

            // 如果是因为内部中断导致的取消，提供更友好的错误信息
            if (error instanceof vscode.CancellationError && requestController.signal.aborted && !token.isCancellationRequested) {
                Logger.info(`❌ 心流AI: 请求 #${requestId} 被新请求中断`);
            }

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
     * 开始新请求前中断当前请求
     * @returns 新请求的ID
     */
    private startNewRequest(): number {
        // 如果有正在进行的请求，先中断它
        if (this.currentRequestController && !this.currentRequestController.signal.aborted) {
            Logger.info('❌ 心流AI: 检测到新请求，中断当前正在进行的请求');
            this.currentRequestController.abort();
        }

        // 创建新的AbortController
        this.currentRequestController = new AbortController();
        const requestId = ++this.requestCounter;

        Logger.info(`🚀 心流AI: 开始新请求 #${requestId}`);
        return requestId;
    }

    /**
     * 请求完成时清理资源
     * @param requestId 请求ID
     */
    private finishRequest(requestId: number): void {
        // 只有当前请求完成时才清理（避免被后续请求误清理）
        if (this.currentRequestController && this.requestCounter === requestId) {
            this.currentRequestController = null;
            Logger.info(`✅ 心流AI: 请求 #${requestId} 已完成`);
        }
    }

    /**
     * 创建组合的CancellationToken，结合用户取消和内部中断
     * @param originalToken 原始的CancellationToken
     * @param abortController 内部的AbortController
     * @returns 新的CancellationToken
     */
    private createCombinedCancellationToken(
        originalToken: CancellationToken,
        abortController: AbortController
    ): CancellationToken {
        const combinedToken = new vscode.CancellationTokenSource();

        // 监听原始token的取消
        const originalListener = originalToken.onCancellationRequested(() => {
            combinedToken.cancel();
        });

        // 监听AbortController的取消
        const abortListener = () => {
            combinedToken.cancel();
        };
        abortController.signal.addEventListener('abort', abortListener);

        // 清理监听器
        combinedToken.token.onCancellationRequested(() => {
            originalListener.dispose();
            abortController.signal.removeEventListener('abort', abortListener);
        });

        return combinedToken.token;
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

    /**
     * 清理资源，中断任何正在进行的请求
     * 当扩展被销毁时应该调用此方法
     */
    dispose(): void {
        if (this.currentRequestController && !this.currentRequestController.signal.aborted) {
            Logger.info('🧹 心流AI: 扩展销毁，中断正在进行的请求');
            this.currentRequestController.abort();
            this.currentRequestController = null;
        }
    }
}
