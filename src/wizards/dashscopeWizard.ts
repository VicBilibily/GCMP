/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 配置向导
 *  提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { t } from '../utils/l10n';

export class DashscopeWizard {
    private static readonly PROVIDER_KEY = 'dashscope';
    private static readonly CODING_PLAN_KEY = 'dashscope-coding';
    private static readonly TOKEN_PLAN_KEY = 'dashscope-token';

    /**
     * 启动 Dashscope 配置向导
     */
    static async startWizard(
        displayName: string,
        apiKeyTemplate: string,
        codingKeyTemplate?: string,
        tokenKeyTemplate?: string
    ): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set API key', '$(key) 设置 API 密钥'),
                        detail: t(
                            'For standard pay-as-you-go models such as {0}',
                            '用于 {0} 等标准按量计费模型',
                            displayName
                        ),
                        value: 'normal'
                    },
                    {
                        label: t('$(key) Set Coding Plan dedicated key', '$(key) 设置 Coding Plan 专用密钥'),
                        detail: t('For {0} Coding Plan models', '用于 {0} Coding Plan 模型', displayName),
                        value: 'coding'
                    },
                    {
                        label: t('$(key) Set Token Plan dedicated key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t('For {0} Token Plan models', '用于 {0} Token Plan 模型', displayName),
                        value: 'tokenPlan'
                    },
                    {
                        label: t('$(check-all) Configure all items in sequence', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the standard key, Coding Plan dedicated key, and Token Plan dedicated key in order',
                            '按顺序配置普通密钥、Coding Plan 专用密钥与 Token Plan 专用密钥'
                        ),
                        value: 'all'
                    }
                ],
                {
                    title: t('{0} Key Configuration', '{0} 密钥配置', displayName),
                    placeHolder: t('Choose what to configure', '请选择要配置的项目')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled the DashScope setup wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'all') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }

            if (choice.value === 'tokenPlan' || choice.value === 'all') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || codingKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`DashScope setup wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 设置 Dashscope 普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the API key for {0} (leave empty to clear)',
                '请输入 {0} 的 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} API Key', '设置 {0} API Key', displayName),
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} API key cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(t('{0} API Key cleared', '{0} API Key 已清除', displayName));
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API key configured`);
                vscode.window.showInformationMessage(t('{0} API Key configured', '{0} API Key 已设置', displayName));
            }
        } catch (error) {
            const errorText = t(
                'Setup failed: {0}',
                '设置失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
            Logger.error(
                `DashScope API key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(errorText);
        }
    }

    /**
     * 设置 Dashscope Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Coding Plan dedicated API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Coding Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Coding Plan dedicated API Key', '设置 {0} Coding Plan 专用 API Key', displayName),
            placeHolder: codingKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan dedicated API key cleared`);
                await ApiKeyManager.deleteApiKey(this.CODING_PLAN_KEY);
                vscode.window.showInformationMessage(
                    t('{0} Coding Plan dedicated API Key cleared', '{0} Coding Plan 专用 API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.CODING_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan dedicated API key configured`);
                vscode.window.showInformationMessage(
                    t(
                        '{0} Coding Plan dedicated API Key configured',
                        '{0} Coding Plan 专用 API Key 已设置',
                        displayName
                    )
                );
            }
        } catch (error) {
            const errorText = t(
                'Setup failed: {0}',
                '设置失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
            Logger.error(
                `DashScope Coding Plan API key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(errorText);
        }
    }

    /**
     * 设置 Dashscope Token Plan 专用密钥
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Token Plan dedicated API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan dedicated API Key', '设置 {0} Token Plan 专用 API Key', displayName),
            placeHolder: tokenKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Token Plan dedicated API key cleared`);
                await ApiKeyManager.deleteApiKey(this.TOKEN_PLAN_KEY);
                vscode.window.showInformationMessage(
                    t('{0} Token Plan dedicated API Key cleared', '{0} Token Plan 专用 API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.TOKEN_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Token Plan dedicated API key configured`);
                vscode.window.showInformationMessage(
                    t('{0} Token Plan dedicated API Key configured', '{0} Token Plan 专用 API Key 已设置', displayName)
                );
            }
        } catch (error) {
            const errorText = t(
                'Setup failed: {0}',
                '设置失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
            Logger.error(
                `DashScope Token Plan API key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(errorText);
        }
    }
}
