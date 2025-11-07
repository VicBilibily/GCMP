/*---------------------------------------------------------------------------------------------
 *  智谱AI 专用 Provider
 *  继承 GenericModelProvider，添加配置向导功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LanguageModelChatProvider } from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ZhipuWizard } from '../utils/zhipuWizard';
import { GenericModelProvider } from './genericModelProvider';

/**
 * 智谱AI 专用模型提供商类
 * 继承 GenericModelProvider，添加配置向导功能
 */
export class ZhipuProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(providerKey: string, providerConfig: ProviderConfig) {
        super(providerKey, providerConfig);
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
        const provider = new ZhipuProvider(providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);
        // 注册设置API密钥命令
        const setApiKeyCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
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
}
