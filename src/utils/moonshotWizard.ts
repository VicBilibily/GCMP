/*---------------------------------------------------------------------------------------------
 *  MoonshotAI 配置向导
 *  提供交互式向导来配置 Moonshot 密钥和 Kimi For Coding 专用密钥
 *--------------------------------------------------------------------------------------------*/

// cSpell:ignore kimi
import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { StatusBarManager } from '../status';

export class MoonshotWizard {
    private static readonly PROVIDER_KEY = 'moonshot';
    private static readonly KIMI_KEY = 'kimi';

    /**
     * 启动 MoonshotAI 配置向导
     * 允许用户选择配置哪种密钥类型
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 设置 Moonshot API 密钥',
                        detail: '用于 Moonshot AI 开放平台调用 Kimi-K2 系列等模型的 API 密钥',
                        value: 'moonshot'
                    },
                    {
                        label: '$(key) 设置 Kimi For Coding 专用密钥',
                        detail: '用于 Kimi 会员计划中面向代码开发场景提供的增值会员权益的专用密钥',
                        value: 'kimi'
                    },
                    {
                        label: '$(check-all) 同时设置两种密钥',
                        detail: '按顺序配置 Moonshot API 密钥和 Kimi For Coding 专用密钥',
                        value: 'both'
                    }
                ],
                { title: `${displayName} 密钥配置`, placeHolder: '请选择要配置的项目' }
            );

            if (!choice) {
                Logger.debug('用户取消了 MoonshotAI 配置向导');
                return;
            }

            if (choice.value === 'moonshot' || choice.value === 'both') {
                await this.setMoonshotApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'kimi' || choice.value === 'both') {
                await this.setKimiApiKey(displayName, codingKeyTemplate);
            }
        } catch (error) {
            Logger.error(`MoonshotAI 配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Moonshot API 密钥
     */
    static async setMoonshotApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 API Key（留空可清除）`,
            title: `设置 ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            validateInput: (value: string) => {
                // 允许空值，用于清除 API Key
                if (!value || value.trim() === '') {
                    return null;
                }
                return null;
            }
        });

        // 用户取消了输入
        if (result === undefined) {
            return;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} API Key 已清除`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API Key 已设置`);
                vscode.window.showInformationMessage(`${displayName} API Key 已设置`);
            }
        } catch (error) {
            Logger.error(`Moonshot API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }

        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('moonshot');
    }

    /**
     * 设置 Kimi For Coding 专用密钥
     */
    static async setKimiApiKey(_displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: '请输入 Kimi For Coding 专用 API Key(留空可清除)',
            title: '设置 Kimi For Coding 专用 API Key',
            placeHolder: codingKeyTemplate,
            password: true,
            validateInput: (value: string) => {
                // 允许空值，用于清除 API Key
                if (!value || value.trim() === '') {
                    return null;
                }
                return null;
            }
        });

        // 用户取消了输入
        if (result === undefined) {
            return;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info('Kimi For Coding 专用 API Key 已清除');
                await ApiKeyManager.deleteApiKey(this.KIMI_KEY);
                vscode.window.showInformationMessage('Kimi For Coding 专用 API Key 已清除');
            } else {
                await ApiKeyManager.setApiKey(this.KIMI_KEY, result.trim());
                Logger.info('Kimi For Coding 专用 API Key 已设置');
                vscode.window.showInformationMessage('Kimi For Coding 专用 API Key 已设置');
            }
        } catch (error) {
            Logger.error(`Kimi For Coding API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }

        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('kimi');
    }
}
