/*---------------------------------------------------------------------------------------------
 *  Volcengine (火山方舟) 配置向导
 *  提供交互式向导来配置 Coding Plan 密钥和 Agent Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { t } from '../utils/l10n';

export class VolcengineWizard {
    private static readonly PROVIDER_KEY = 'volcengine';
    private static readonly AGENT_PLAN_KEY = 'volcengine-agent';

    /**
     * 启动火山方舟配置向导
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, tokenKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set Coding Plan API key', '$(key) 设置 Coding Plan API 密钥'),
                        detail: t(
                            'Used for {0} Coding Plan models or pay-as-you-go models',
                            '用于 {0} Coding Plan 模型 或 按量计费 模型',
                            displayName
                        ),
                        value: 'coding'
                    },
                    {
                        label: t('$(key) Set Agent Plan API key', '$(key) 设置 Agent Plan 专用密钥'),
                        detail: t(
                            'Used for {0} Agent Plan models (dedicated API key)',
                            '用于 {0} Agent Plan 模型（专属API Key）',
                            displayName
                        ),
                        value: 'agentPlan'
                    },
                    {
                        label: t('$(check-all) Configure all items', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the Coding Plan key and Agent Plan key in order',
                            '按顺序配置 Coding Plan 密钥与 Agent Plan 专用密钥'
                        ),
                        value: 'all'
                    }
                ],
                {
                    title: t('{0} key configuration', '{0} 密钥配置', displayName),
                    placeHolder: t('Select what to configure', '请选择要配置的项目')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled Volcengine config wizard');
                return;
            }

            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'agentPlan' || choice.value === 'all') {
                await this.setAgentPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(
                `Volcengine config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    /**
     * 设置 Coding Plan API 密钥
     */
    static async setCodingPlanApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Coding Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Coding Plan API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Coding Plan API key', '设置 {0} Coding Plan API Key', displayName),
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan API key cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(
                    t('{0} Coding Plan API key cleared', '{0} Coding Plan API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan API key set`);
                vscode.window.showInformationMessage(
                    t('{0} Coding Plan API key set', '{0} Coding Plan API Key 已设置', displayName)
                );
            }
        } catch (error) {
            Logger.error(
                `Volcengine Coding Plan API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            vscode.window.showErrorMessage(
                t(
                    'Failed to save the API key: {0}',
                    '设置失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
        }
    }

    /**
     * 设置 Agent Plan 专用密钥
     */
    static async setAgentPlanApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Agent Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Agent Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Agent Plan API key', '设置 {0} Agent Plan 专用 API Key', displayName),
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Agent Plan API key cleared`);
                await ApiKeyManager.deleteApiKey(this.AGENT_PLAN_KEY);
                vscode.window.showInformationMessage(
                    t('{0} Agent Plan API key cleared', '{0} Agent Plan 专用 API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.AGENT_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Agent Plan API key set`);
                vscode.window.showInformationMessage(
                    t('{0} Agent Plan API key set', '{0} Agent Plan 专用 API Key 已设置', displayName)
                );
            }
        } catch (error) {
            Logger.error(
                `Volcengine Agent Plan API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            vscode.window.showErrorMessage(
                t(
                    'Failed to save the API key: {0}',
                    '设置失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
        }
    }
}
