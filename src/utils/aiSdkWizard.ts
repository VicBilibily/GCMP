/*---------------------------------------------------------------------------------------------
 *  AI SDK Provider 配置向导
 *  提供交互式向导来配置 models.dev 支持的提供商
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ModelsDevService } from '../providers/aiSdkAdapter/modelsDevService';
import { SUPPORTED_NPM_PACKAGES } from '../providers/aiSdkProvider';

/**
 * AI SDK Provider 配置向导
 */
export class AiSdkWizard {
    /**
     * 启动配置向导
     */
    static async startWizard(provider?: { refreshModels: () => Promise<void> }): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 设置 API 密钥',
                        detail: '选择一个 provider 并配置 API Key',
                        value: 'apikey'
                    },
                    {
                        label: '$(book) 查看支持的服务商',
                        detail: '查看 models.dev 支持的所有模型提供商',
                        value: 'view'
                    },
                    {
                        label: '$(info) 查看帮助文档',
                        detail: '了解如何配置和使用 AI SDK Provider',
                        value: 'help'
                    }
                ],
                { title: 'AI SDK Provider 配置向导', placeHolder: '请选择要执行的操作' }
            );

            if (!choice) {
                Logger.debug('AI SDK config wizard was cancelled by the user');
                return;
            }

            switch (choice.value) {
                case 'apikey':
                    await this.selectAndSetApiKey(provider);
                    break;
                case 'view':
                    await this.viewProviders();
                    break;
                case 'help':
                    await this.showHelp();
                    break;
            }
        } catch (error) {
            Logger.error(`AI SDK config wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 选择 Provider 并设置 API 密钥
     */
    private static async selectAndSetApiKey(provider?: { refreshModels: () => Promise<void> }): Promise<void> {
        // 从 models.dev 获取所有 provider，只保留白名单中的 npm 包
        const allProviders = await ModelsDevService.getAllProviders();
        const providers = allProviders.filter(p => !!p.npm && SUPPORTED_NPM_PACKAGES.has(p.npm));

        if (providers.length === 0) {
            vscode.window.showErrorMessage('无法获取 provider 列表，请检查网络连接');
            return;
        }

        // 让用户选择一个 provider
        const selectedProvider = await vscode.window.showQuickPick(
            providers.map(p => ({
                label: p.name || p.id,
                description: p.id,
                detail: p.npm ? `SDK: ${p.npm}` : '',
                providerId: p.id
            })),
            {
                title: '选择要配置的 Provider',
                placeHolder: '请选择一个模型提供商'
            }
        );

        if (!selectedProvider) {
            Logger.debug('Provider selection was cancelled by the user');
            return;
        }

        // 设置选中的 provider 的 API Key
        await this.setApiKey(selectedProvider.providerId, provider);
    }

    /**
     * 设置 API 密钥（通用方法）
     */
    private static async setApiKey(
        providerId: string,
        provider?: { refreshModels: () => Promise<void> }
    ): Promise<void> {
        // 从 models.dev 获取 provider 信息
        const providerInfo = await ModelsDevService.getProviderInfo(providerId);
        const storageKey = `ai-sdk:${providerId}`;
        const providerName = providerInfo?.name || providerId;

        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${providerName} 的 API Key（留空可清除）`,
            title: `设置 ${providerName} API Key`,
            placeHolder: 'xxxxx',
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            // 用户取消
            return;
        }

        if (result.trim() === '') {
            // 清除密钥
            await ApiKeyManager.setApiKey(storageKey, '');
            vscode.window.showInformationMessage(`已清除 ${providerName} API 密钥`);
        } else {
            // 设置密钥
            await ApiKeyManager.setApiKey(storageKey, result.trim());
            vscode.window.showInformationMessage(`${providerName} API 密钥已保存`);
        }

        // 刷新模型列表
        if (provider) {
            await provider.refreshModels();
            vscode.window.showInformationMessage('模型列表已刷新，请在模型选择器中查看');
        } else {
            vscode.window.showInformationMessage('请重新加载窗口以加载模型列表');
        }
    }

    /**
     * 查看支持的提供商
     */
    private static async viewProviders(): Promise<void> {
        const message = `AI SDK Provider 支持以下模型提供商：

详细信息请访问: https://models.dev

所有支持的提供商将从 models.dev 动态获取。`;

        await vscode.window.showInformationMessage(message, { modal: true });
    }

    /**
     * 显示帮助文档
     */
    private static async showHelp(): Promise<void> {
        const message = `AI SDK Provider 使用说明：

1. 配置 API 密钥：
   - 点击"设置 API 密钥"
   - 输入您的 API Key

2. 选择模型：
   - 在 Copilot Chat 中选择"AI SDK Provider"
   - 选择您想使用的模型

3. 使用工具调用：
   - 自动支持 function calling
   - 完整的 JSON Schema 支持

更多文档请访问: https://github.com/your-repo/gcmp`;

        await vscode.window.showInformationMessage(message, { modal: true });
    }
}
