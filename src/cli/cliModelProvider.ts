/*---------------------------------------------------------------------------------------------
 *  CLI 认证专用 Provider
 *  继承 GenericModelProvider，支持 CLI 认证模式
 *  支持 iflow、qwen-code 等 CLI 认证提供商
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';
import { GenericModelProvider } from '../providers/genericModelProvider';
import { CliWizard } from './cliWizard';
import { CliAuthFactory } from './auth/cliAuthFactory';

/**
 * CLI 认证专用模型提供商类
 * 继承 GenericModelProvider，支持 CLI 认证模式
 * 适用于所有使用 CLI 认证的提供商（iflow、qwen-code 等）
 */
export class CliModelProvider extends GenericModelProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 重写模型信息提供方法
     * 当没有 API 密钥时，启动配置向导而不是要求输入 API 密钥
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        // 检查是否有有效的 API 密钥
        const hasApiKey = await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false);
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            try {
                const credentials = await CliAuthFactory.ensureAuthenticated(this.providerKey);
                if (credentials) {
                    if (this.providerKey === 'iflow') {
                        const apiKey = await CliAuthFactory.getInstance(this.providerKey)?.getApiKey();
                        if (apiKey) {
                            await ApiKeyManager.setApiKey(this.providerKey, apiKey);
                        } else {
                            // 获取不到 API key，打开向导重新登录
                            Logger.warn(`[CliModelProvider] 无法从 ${this.providerKey} CLI 获取 API key，启动配置向导`);
                            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
                            return [];
                        }
                    } else {
                        await ApiKeyManager.setApiKey(this.providerKey, credentials.access_token);
                    }
                    Logger.info(`[CliModelProvider] 已从 ${this.providerKey} CLI 加载认证凭证`);
                } else {
                    await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
                    // 无法获取凭证，返回空列表
                    Logger.warn(`[CliModelProvider] 无法从 ${this.providerKey} CLI 加载认证凭证`);
                    return [];
                }
            } catch (error) {
                Logger.warn(`[CliModelProvider] 从 ${this.providerKey} CLI 加载认证凭证失败:`, error);
                return [];
            }
        }
        // 调用父类方法返回模型列表
        return super.provideLanguageModelChatInformation(options, token);
    }

    /**
     * 静态工厂方法 - 创建并激活 CLI 认证提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: CliModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} CLI 认证模型扩展已激活!`);
        // 创建提供商实例
        const provider = new CliModelProvider(context, providerKey, providerConfig);
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
            await CliModelProvider.startConfigWizard(providerKey, providerConfig.displayName);
            // 配置变更后清除缓存
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // 触发模型信息变更事件
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 根据提供商启动对应的配置向导
     * @param providerKey 提供商标识
     * @param displayName 显示名称
     */
    private static async startConfigWizard(providerKey: string, displayName: string): Promise<void> {
        // 获取支持的 CLI 类型列表
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const supportedCliIds = supportedCliTypes.map(cli => cli.id);
        // 检查是否是支持的 CLI 类型
        if (!supportedCliIds.includes(providerKey)) {
            Logger.warn(`[CliProvider] 未知的 CLI 认证提供商: ${providerKey}`);
            vscode.window.showWarningMessage(`未知的提供商: ${providerKey}`);
            return;
        }
        // 使用统一的 CLI 向导
        await CliWizard.startWizard(providerKey, displayName);
    }
}
