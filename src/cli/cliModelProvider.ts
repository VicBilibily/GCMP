/*---------------------------------------------------------------------------------------------
 *  CLI 认证专用 Provider
 *  继承 GenericModelProvider，支持 CLI 认证模式
 *  支持 codex、grok 等 CLI 认证提供商
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatMessage,
    LanguageModelChatInformation,
    ProvideLanguageModelChatResponseOptions,
    Progress,
    CancellationToken,
    PrepareLanguageModelChatModelOptions
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';
import { GenericModelProvider } from '../providers/genericModelProvider';
import { CliWizard } from '../wizards/cliWizard';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { StatusBarManager } from '../status';
import { t } from '../utils/l10n';

/**
 * CLI 认证专用模型提供商类
 * 继承 GenericModelProvider，支持 CLI 认证模式
 * 适用于所有使用 CLI 认证的提供商（codex、grok 等）
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
        options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (options.configuration) {
            // 如果请求中包含 configuration，不返回模型列表
            return [];
        }

        // 检查是否有有效的 API 密钥
        let hasApiKey: boolean;
        if (options.silent) {
            // 基于文件 mtime 的缓存检查：先快速判定凭证是否有变化
            // loadCredentials() 内部通过 fs.statSync + mtime 比对做缓存，
            // 文件未变 → 直接返回内存缓存（<1ms）；跨终端更新 → 自动检测并重新加载
            const credentials = await CliAuthFactory.loadCredentials(this.providerKey);
            if (credentials?.access_token) {
                // 委托各 CLI 子类判断过期（Codex=1h, Grok=5min）
                if (!CliAuthFactory.isCredentialExpired(this.providerKey, credentials)) {
                    await ApiKeyManager.setApiKey(this.providerKey, credentials.access_token);
                    return super.provideLanguageModelChatInformation(options, token);
                }
                Logger.trace(`[CliModelProvider] ${this.providerKey} token expired, trying refresh`);
            }

            hasApiKey = await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false);
        } else {
            // 非静默模式下，直接触发用户交互确保有密钥
            await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
            hasApiKey = await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false);
            options.silent = true; // 后续调用调整为静默模式
        }
        if (!hasApiKey) {
            // 如果是静默模式（如扩展启动时），不触发用户交互，直接返回空列表
            if (options.silent) {
                return [];
            }
            try {
                const credentials = await CliAuthFactory.ensureAuthenticated(this.providerKey);
                if (credentials) {
                    await ApiKeyManager.setApiKey(this.providerKey, credentials.access_token);
                    Logger.info(`[CliModelProvider] Loaded credentials from ${this.providerKey} CLI`);
                } else {
                    await vscode.commands.executeCommand(`gcmp.${this.providerKey}.configWizard`);
                    // 无法获取凭证，返回空列表
                    Logger.warn(`[CliModelProvider] Unable to load credentials from ${this.providerKey} CLI`);
                    return [];
                }
            } catch (error) {
                Logger.warn(`[CliModelProvider] Failed to load credentials from ${this.providerKey} CLI:`, error);
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
        Logger.trace(`${providerConfig.displayName} CLI-authenticated model provider activated`);
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
    protected static async startConfigWizard(providerKey: string, displayName: string): Promise<void> {
        // 获取支持的 CLI 类型列表
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const supportedCliIds = supportedCliTypes.map(cli => cli.id);
        // 检查是否是支持的 CLI 类型
        if (!supportedCliIds.includes(providerKey)) {
            Logger.warn(`[CliProvider] Unknown CLI-authenticated provider: ${providerKey}`);
            vscode.window.showWarningMessage(t('Unknown provider: {0}', '未知的提供商: {0}', providerKey));
            return;
        }
        // 使用统一的 CLI 向导
        await CliWizard.startWizard(providerKey, displayName);
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
            // 请求完成后，延时更新状态栏使用量
            StatusBarManager.getStatusBar(this.providerKey)?.delayedUpdate(200);
        }
    }
}
