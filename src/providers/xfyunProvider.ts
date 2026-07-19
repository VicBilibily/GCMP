/*---------------------------------------------------------------------------------------------
 *  Astron (讯飞星辰) 专用 Provider
 *  继承 GenericModelProvider，支持 Coding Plan / Token Plan 两类 API Key
 *  Coding Plan：https://maas-coding-api.cn-huabei-1.xf-yun.com/v2
 *  Token Plan：https://maas-token-api.cn-huabei-1.xf-yun.com/v2
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatProvider,
    LanguageModelChatInformation,
    PrepareLanguageModelChatModelOptions,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/runtime/logger';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { GenericModelProvider } from './genericModelProvider';
import { XfyunWizard } from '../wizards/xfyunWizard';

/**
 * Astron (讯飞星辰) 专用模型提供商类
 * 继承 GenericModelProvider，添加配置向导和多密钥管理功能
 */
export class XfyunProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * 静态工厂方法 - 创建并激活 Xfyun 提供商
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: XfyunProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} dedicated model extension activated`);
        // 创建提供商实例
        const provider = new XfyunProvider(context, providerKey, providerConfig);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`gcmp.${providerKey}`, provider);

        // 注册配置向导命令
        const configWizardCommand = vscode.commands.registerCommand(`gcmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} setup wizard`);
            await XfyunWizard.startWizard(
                providerConfig.displayName,
                providerConfig.codingKeyTemplate || providerConfig.apiKeyTemplate,
                providerConfig.tokenKeyTemplate || providerConfig.apiKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // 注册设置 Coding Plan 专用 API Key 命令
        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await XfyunWizard.setCodingPlanApiKey(
                    providerConfig.displayName,
                    providerConfig.codingKeyTemplate || providerConfig.apiKeyTemplate
                );
                await provider.modelInfoCache?.invalidateCache(providerKey);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        // 注册设置 Token Plan 专用 API Key 命令
        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `gcmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await XfyunWizard.setTokenPlanApiKey(
                    providerConfig.displayName,
                    providerConfig.tokenKeyTemplate || providerConfig.apiKeyTemplate
                );
                await provider.modelInfoCache?.invalidateCache(providerKey);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const disposables = [
            providerDisposable,
            configWizardCommand,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand
        ];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * 重写 provideLanguageModelChatInformation，按密钥可用性过滤模型。
     * 无密钥时静默模式返回空列表，非静默模式弹出向导引导配置。
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            return [];
        }

        const hasCodingKey = await ApiKeyManager.hasValidApiKey('xfyun-coding');
        const hasTokenKey = await ApiKeyManager.hasValidApiKey('xfyun-token');
        const hasAnyKey = hasCodingKey || hasTokenKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(
                `${this.providerConfig.displayName}: no keys detected in silent mode, returning empty model list`
            );
            return [];
        }

        if (!options.silent) {
            await XfyunWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate || this.providerConfig.apiKeyTemplate,
                this.providerConfig.tokenKeyTemplate || this.providerConfig.apiKeyTemplate
            );

            const codingKeyValid = await ApiKeyManager.hasValidApiKey('xfyun-coding');
            const tokenKeyValid = await ApiKeyManager.hasValidApiKey('xfyun-token');
            if (!codingKeyValid && !tokenKeyValid) {
                Logger.warn(
                    `${this.providerConfig.displayName}: user did not configure any keys, returning empty model list`
                );
                return [];
            }
        }

        // 根据已配置的 API Key 过滤模型
        const filteredModels = await this.filterModelsByAvailableKeys(this.providerConfig.models);
        Logger.trace(
            `${this.providerConfig.displayName}: ${filteredModels.length}/${this.providerConfig.models.length} models available after key filtering`
        );
        return filteredModels.map(model => this.modelConfigToInfo(model));
    }
}
