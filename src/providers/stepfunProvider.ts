/*---------------------------------------------------------------------------------------------
 *  阶跃星辰 StepFun 专用 Provider
 *  继承 GenericModelProvider，添加配置向导功能
 *  全量模型采用 Anthropic SDK 协议，通过 baseUrl 区分 PayGo 和 Step Plan
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatProvider,
    LanguageModelChatInformation,
    PrepareLanguageModelChatModelOptions,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { StepFunWizard } from '../utils/stepfunWizard';
import { GenericModelProvider } from './genericModelProvider';

/**
 * 阶跃星辰 StepFun 专用模型提供商类
 * 继承 GenericModelProvider，添加配置向导功能
 */
export class StepFunProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 StepFun 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: StepFunProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);
        // 创建提供商实例
        const provider = new StepFunProvider(context, providerKey, providerConfig);
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
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await StepFunWizard.startWizard(providerConfig.displayName, providerConfig.apiKeyTemplate);
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 临时重写 provideLanguageModelChatInformation 以支持非静默模式触发向导
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        if (!options.silent) {
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
            return super.provideLanguageModelChatInformation({ silent: true }, _token);
        }
        return super.provideLanguageModelChatInformation(options, _token);
    }
}
