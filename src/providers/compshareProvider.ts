/*---------------------------------------------------------------------------------------------
 *  Compshare(优云计算) 专用 Provider
 *  基于 GenericModelProvider，为 Compshare 提供商提供配置支持
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';

/**
 * Compshare 专用模型提供商类
 * 继承 GenericModelProvider，提供 Compshare API 配置支持
 */
export class CompshareProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 Compshare 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: CompshareProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 模型扩展已激活!`);
        // 创建提供商实例
        const provider = new CompshareProvider(context, providerKey, providerConfig);
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
        });

        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 重写 provideLanguageModelChatResponse 以支持请求后状态栏更新
     */
    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // 请求完成后延时更新状态栏使用量
            Logger.debug(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
        }
    }
}
