/*---------------------------------------------------------------------------------------------
 *  阶跃星辰 StepFun 配置向导
 *  提供交互式向导来配置 API 密钥和 MCP 搜索服务
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/configManager';
import { t } from '../utils/l10n';
import { BaseWizard } from './baseWizard';

export class StepFunWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'stepfun';

    /**
     * 启动配置向导
     * 直接进入设置菜单，无需先检测 API Key
     */
    static async startWizard(displayName: string, apiKeyTemplate: string): Promise<void> {
        try {
            // 获取当前 MCP 状态
            const currentMCPStatus = ConfigManager.getStepFunSearchConfig().enableMCP;
            const mcpStatusText = currentMCPStatus ? t('Enabled', '已启用') : t('Disabled', '已禁用');

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Update {0} API Key', '$(key) 修改 {0} API Key', displayName),
                        detail: t('Set or remove the {0} API Key', '设置或删除 {0} API Key', displayName),
                        action: 'updateApiKey'
                    },
                    {
                        label: t('$(plug) Configure MCP search mode', '$(plug) 配置 MCP 搜索模式'),
                        description: t('Current: {0}', '当前：{0}', mcpStatusText),
                        detail: t(
                            'Use the web search MCP included with Step Plan, or switch to standard billing (¥0.04/request)',
                            '使用 Step Plan 套餐内的 MCP 联网搜索，或切换到标准计费模式（¥0.04/次）'
                        ),
                        action: 'toggleMCP'
                    }
                ],
                {
                    title: t('{0} Settings Menu', '{0} 配置菜单', displayName),
                    placeHolder: t('Select an action to perform', '选择要执行的操作')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled the StepFun setup wizard');
                return;
            }

            if (choice.action === 'updateApiKey') {
                await this.promptForApiKey({
                    providerKey: this.PROVIDER_KEY,
                    prompt: t(
                        'Enter the API key for {0} (leave empty to clear)',
                        '请输入 {0} 的 API Key（留空可清除）',
                        displayName
                    ),
                    title: t('Set {0} API Key', '设置 {0} API Key', displayName),
                    placeHolder: apiKeyTemplate,
                    successMessage: t('{0} API key configured', '{0} API Key 已设置', displayName),
                    clearMessage: t('{0} API key cleared', '{0} API Key 已清除', displayName),
                    loggerName: displayName
                });
            } else if (choice.action === 'toggleMCP') {
                await this.showMCPConfigStep(displayName);
            }
        } catch (error) {
            Logger.error(`StepFun setup wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 显示 MCP 搜索配置步骤
     */
    private static async showMCPConfigStep(displayName: string): Promise<void> {
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: t('$(x) Do not enable MCP search mode', '$(x) 不启用 MCP 搜索模式'),
                    detail: t(
                        'Use the pay-as-you-go billing interface (¥0.04/request)',
                        '使用按量计费接口（¥0.04/次）'
                    ),
                    action: 'disableMCP'
                },
                {
                    label: t('$(check) Enable MCP search mode', '$(check) 启用 MCP 搜索模式'),
                    detail: t('Use the MCP search included in the Step Plan', '使用 Step Plan 套餐内的 MCP 联网搜索'),
                    action: 'enableMCP'
                }
            ],
            {
                title: t('{0} MCP Search Service Configuration', '{0} MCP 搜索服务配置', displayName),
                placeHolder: t('Choose whether to enable MCP search', '选择是否启用 MCP 搜索')
            }
        );

        if (!choice) {
            return;
        }

        try {
            if (choice.action === 'enableMCP') {
                await this.setMCPConfig(true, displayName);
            } else {
                await this.setMCPConfig(false, displayName);
            }
        } catch (error) {
            const errorText = t(
                'Failed to configure MCP: {0}',
                'MCP 配置失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
            Logger.error(errorText);
            vscode.window.showErrorMessage(errorText);
        }
    }

    /**
     * 设置 MCP 配置
     */
    private static async setMCPConfig(enable: boolean, _displayName: string): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            await config.update('stepfun.search.enableMCP', enable, vscode.ConfigurationTarget.Global);
            Logger.info(`StepFun MCP search ${enable ? 'enabled' : 'disabled'}`);
            vscode.window.showInformationMessage(
                enable ?
                    t(
                        'StepFun MCP search mode enabled. Please ensure you have an active Step Plan subscription.',
                        '阶跃星辰 MCP 搜索模式已启用。请确保已订阅 Step Plan 套餐。'
                    )
                :   t(
                        'StepFun MCP search mode disabled, switched to standard billing (¥0.04/request).',
                        '阶跃星辰 MCP 搜索模式已禁用，已切换到标准计费（¥0.04/次）。'
                    )
            );
        } catch (error) {
            const errorMessage = t(
                'Failed to set MCP configuration: {0}',
                '设置 MCP 配置失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
            Logger.error(errorMessage);
            throw error;
        }
    }
}
