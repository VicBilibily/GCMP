/*---------------------------------------------------------------------------------------------
 *  心流AI 专用 Provider
 *  继承 GenericModelProvider，实现请求节流控制，只允许同时存在一个请求
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
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';
import { GenericModelProvider } from './genericModelProvider';

/**
 * 心流AI 专用模型供应商类
 * 继承 GenericModelProvider，实现请求节流控制，确保同时只允许一个请求
 */
export class IFlowProvider extends GenericModelProvider implements LanguageModelChatProvider {
    // 请求节流控制 - 只允许同时存在一个请求
    private currentRequestController: AbortController | null = null;
    private requestCounter = 0;

    constructor(providerKey: string, providerConfig: ProviderConfig) {
        super(providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活心流AI供应商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: IFlowProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);

        // 创建供应商实例
        const provider = new IFlowProvider(providerKey, providerConfig);

        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
        });

        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));

        return { provider, disposables };
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 查找对应的模型配置
        const modelConfig = this.getProviderConfig().models.find(m => m.id === model.id);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // 确保有API密钥
        await ApiKeyManager.ensureApiKey(this.providerKey, this.getProviderConfig().displayName);

        Logger.info(`${this.getProviderConfig().displayName} Provider 开始处理请求: ${modelConfig.name}`);

        // 节流控制：开始新请求前中断当前请求
        const requestId = this.startNewRequest();
        const requestController = this.currentRequestController!;

        // 创建组合的CancellationToken
        const combinedToken = this.createCombinedCancellationToken(token, requestController);

        Logger.info(`🔄 ${this.getProviderConfig().displayName}: 开始新请求 #${requestId}`);

        try {
            // 调用父类的处理方法，但使用组合的token
            await this.handleRequestWithToken(model, modelConfig, messages, options, progress, combinedToken);
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        } finally {
            // 请求完成后清理
            this.finishRequest(requestId);
        }
    }

    /**
     * 包装父类的请求处理方法，使其可以使用自定义的token
     */
    private async handleRequestWithToken(
        model: LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly LanguageModelChatMessage[],
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // 直接调用父类的 openaiHandler
        await this.openaiHandler.handleRequest(model, modelConfig, messages, options, progress, token);
    }

    /**
     * 开始新请求前中断当前请求
     */
    private startNewRequest(): number {
        // 如果有正在进行的请求，先中断它
        if (this.currentRequestController && !this.currentRequestController.signal.aborted) {
            Logger.info(`❌ ${this.getProviderConfig().displayName}: 检测到新请求，中断当前正在进行的请求`);
            this.currentRequestController.abort();
        }

        // 创建新的AbortController
        this.currentRequestController = new AbortController();
        const requestId = ++this.requestCounter;

        return requestId;
    }

    /**
     * 请求完成时清理资源
     */
    private finishRequest(requestId: number): void {
        if (this.currentRequestController && this.requestCounter === requestId) {
            this.currentRequestController = null;
            Logger.info(`✅ ${this.getProviderConfig().displayName}: 请求 #${requestId} 已完成`);
        }
    }

    /**
     * 创建组合的CancellationToken
     */
    private createCombinedCancellationToken(
        originalToken: CancellationToken,
        abortController: AbortController
    ): CancellationToken {
        const combinedToken = new vscode.CancellationTokenSource();

        const originalListener = originalToken.onCancellationRequested(() => {
            combinedToken.cancel();
        });

        const abortListener = () => {
            combinedToken.cancel();
        };
        abortController.signal.addEventListener('abort', abortListener);

        combinedToken.token.onCancellationRequested(() => {
            originalListener.dispose();
            abortController.signal.removeEventListener('abort', abortListener);
        });

        return combinedToken.token;
    }

    /**
     * 清理资源
     */
    dispose(): void {
        if (this.currentRequestController && !this.currentRequestController.signal.aborted) {
            Logger.info(`🧹 ${this.getProviderConfig().displayName}: 扩展销毁，中断正在进行的请求`);
            this.currentRequestController.abort();
            this.currentRequestController = null;
        }
        // 调用父类的 dispose 方法
        super.dispose();
    }
}