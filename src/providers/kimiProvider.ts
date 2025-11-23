/*---------------------------------------------------------------------------------------------
 *  Kimi 专用 Provider
 *  为 Kimi 提供商提供专业编程模型支持和使用量统计
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
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager } from '../utils';
import { KimiStatusBarManager } from '../utils/kimiStatusBarManager';

/**
 * Kimi 专用模型提供商类
 * 继承 GenericModelProvider，添加使用量统计和状态栏管理功能
 */
export class KimiProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 Kimi 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: KimiProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);
        // 创建提供商实例
        const provider = new KimiProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
            // API 密钥变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
            // 检查并显示状态栏
            await KimiStatusBarManager.checkAndShowStatus();
        });

        // 注册刷新使用量命令
        const refreshKimiUsageCommand = vscode.commands.registerCommand('gcmp.kimi.refreshUsage', async () => {
            await KimiStatusBarManager.performRefresh();
        });

        // 初始化 Kimi 状态管理器
        KimiStatusBarManager.initialize(context).catch((error: unknown) => {
            Logger.error('初始化 Kimi 状态栏失败', error);
        });

        const disposables = [providerDisposable, setApiKeyCommand, refreshKimiUsageCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 重写：提供语言模型聊天响应 - 添加请求后的使用量更新
     * 在处理完请求后，延时更新状态栏使用量信息
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        try {
            // 调用父类的实现处理请求
            await super.provideLanguageModelChatResponse(model, messages, options, progress, _token);
        } catch (error) {
            const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        } finally {
            // 请求完成后，延时更新状态栏使用量信息
            KimiStatusBarManager.delayedUpdate();
        }
    }
}
