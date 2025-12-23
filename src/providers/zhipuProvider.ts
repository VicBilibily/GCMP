/*---------------------------------------------------------------------------------------------
 *  智谱AI 专用 Provider
 *  继承 GenericModelProvider，添加配置向导功能和状态栏更新
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatProvider,
    LanguageModelChatMessage,
    LanguageModelChatInformation,
    ProvideLanguageModelChatResponseOptions,
    Progress,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ZhipuWizard } from '../utils/zhipuWizard';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status/statusBarManager';

/**
 * 智谱AI 专用模型提供商类
 * 继承 GenericModelProvider，添加配置向导功能
 */
export class ZhipuProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 Zhipu 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: ZhipuProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);
        // 创建提供商实例
        const provider = new ZhipuProvider(context, providerKey, providerConfig);
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

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`启动 ${providerConfig.displayName} 配置向导`);
            await ZhipuWizard.startWizard(providerConfig.displayName, providerConfig.apiKeyTemplate);
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 获取 Zhipu 状态栏实例（用于 delayedUpdate 调用）
     */
    static getZhipuStatusBar() {
        return StatusBarManager.zhipu;
    }

    /**
     * 覆盖 provideChatResponse 以在请求完成后更新状态栏
     */
    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            // 调用父类的实现
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // 请求完成后，延时更新智谱AI状态栏使用量
            StatusBarManager.zhipu?.delayedUpdate();
        }
    }
}
