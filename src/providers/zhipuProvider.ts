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
    PrepareLanguageModelChatModelOptions,
    Progress,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ZhipuWizard } from '../utils/zhipuWizard';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status/statusBarManager';
import { RetryableError } from '../utils';

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
            const modelConfig = this.findModelConfigById(model);
            if (modelConfig?.sdkMode === 'anthropic') {
                const systemMessage = messages.find(msg => msg.role === vscode.LanguageModelChatMessageRole.System);
                if (systemMessage && Array.isArray(systemMessage.content)) {
                    const systemPrompt = systemMessage.content.find(
                        msgPart => msgPart instanceof vscode.LanguageModelTextPart
                    );
                    if (systemPrompt?.value) {
                        const promptText = systemPrompt.value;
                        const applyPatch = "You are Claude Code, Anthropic's official CLI for Claude.\n\n";
                        systemPrompt.value = applyPatch + promptText;
                    }
                }
            }

            // 调用父类的实现
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // 请求完成后，延时更新智谱AI状态栏使用量
            StatusBarManager.zhipu?.delayedUpdate();
        }
    }

    static isServerError(error: RetryableError, deep = 0): boolean {
        // 智谱的服务器错误通常表示服务器过载，也可以重试
        if (error.message && typeof error.message === 'string' && error.code) {
            // 智谱特有的需要重试的服务器错误码
            if (
                error.code === '500' ||
                (typeof error.code === 'string' &&
                    error.code.length === 4 && // 4位错误码，类似于 1234、1305 等，表示服务器过载或临时通讯错误
                    (error.code.startsWith('12') || error.code.startsWith('13')))
            ) {
                return true;
            }
        }
        // 检查是否有嵌套的 error 对象
        if (deep <= 3 && 'error' in error && typeof error.error === 'object' && error.error !== null) {
            return this.isServerError(error.error as RetryableError, deep + 1);
        }
        return false;
    }
    protected override shouldRetryRequest(error: RetryableError): boolean {
        if (super.shouldRetryRequest(error)) {
            Logger.debug(`[${this.providerConfig.displayName}] 请求失败，符合请求频率限制重试条件，准备重试...`);
            return true;
        }
        if (ZhipuProvider.isServerError(error)) {
            Logger.debug(`[${this.providerConfig.displayName}] 请求失败，符合服务器端错误重试条件，准备重试...`);
            return true;
        }
        return false;
    }
}
