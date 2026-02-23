/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 配置向导
 *  提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';

export class DashscopeWizard {
    private static readonly PROVIDER_KEY = 'dashscope';
    private static readonly CODING_PLAN_KEY = 'dashscope-coding';

    /**
     * 启动 Dashscope 配置向导
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 设置 API 密钥',
                        detail: `用于 ${displayName} 等标准按量计费模型`,
                        value: 'normal'
                    },
                    {
                        label: '$(key) 设置 Coding Plan 专用密钥',
                        detail: `用于 ${displayName} Coding Plan 模型`,
                        value: 'coding'
                    },
                    {
                        label: '$(check-all) 同时设置两种密钥',
                        detail: '按顺序配置普通密钥与 Coding Plan 专用密钥',
                        value: 'both'
                    }
                ],
                { title: `${displayName} 密钥配置`, placeHolder: '请选择要配置的项目' }
            );

            if (!choice) {
                Logger.debug('用户取消了 Dashscope 配置向导');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'coding' || choice.value === 'both') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Dashscope 配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Dashscope 普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 API Key（留空可清除）`,
            title: `设置 ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            validateInput: (_value: string) => null
        });

        if (result === undefined) {
            return;
        }

        try {
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
            Logger.error(`Dashscope API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Dashscope Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 Coding Plan 专用 API Key（留空可清除）`,
            title: `设置 ${displayName} Coding Plan 专用 API Key`,
            placeHolder: codingKeyTemplate,
            password: true,
            validateInput: (_value: string) => null
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan 专用 API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.CODING_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Coding Plan 专用 API Key 已清除`);
            } else {
                await ApiKeyManager.setApiKey(this.CODING_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan 专用 API Key 已设置`);
                vscode.window.showInformationMessage(`${displayName} Coding Plan 专用 API Key 已设置`);
            }
        } catch (error) {
            Logger.error(
                `Dashscope Coding Plan API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`
            );
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }
}
