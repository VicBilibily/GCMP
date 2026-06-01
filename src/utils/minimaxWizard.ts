/*---------------------------------------------------------------------------------------------
 *  MiniMax 配置向导
 *  提供交互式向导来配置普通密钥和 Token Plan 专用密钥，支持接入点（站点）选择
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';
import { StatusBarManager } from '../status';
import { MiniMaxConfig } from './configManager';
import { t } from './l10n';

export class MiniMaxWizard {
    private static readonly PROVIDER_KEY = 'minimax';
    private static readonly TOKEN_PLAN_KEY = 'minimax-token';

    /**
     * 启动 MiniMax 配置向导
     * 允许用户选择配置哪种密钥类型
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            // 获取当前接入站点
            const currentEndpoint = ConfigManager.getMinimaxEndpoint();
            const endpointLabel =
                currentEndpoint === 'minimax.io' ?
                    t('Global site (minimax.io)', '国际站 (minimax.io)')
                :   t('China site (minimaxi.com)', '国内站 (minimaxi.com)');

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set standard API key', '$(key) 设置普通 API 密钥'),
                        detail: t(
                            'Used for standard pay-as-you-go models such as MiniMax-M2',
                            '用于 MiniMax-M2 等标准按量计费模型'
                        ),
                        value: 'normal'
                    },
                    {
                        label: t('$(key) Set Token Plan API key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t('Used for MiniMax-M2 (Token Plan) models', '用于 MiniMax-M2 (Token Plan) 模型'),
                        value: 'coding'
                    },
                    {
                        label: t('$(check-all) Set both keys', '$(check-all) 同时设置两种密钥'),
                        detail: t(
                            'Configure the standard key and Token Plan key in order',
                            '按顺序配置普通密钥和 Token Plan 密钥'
                        ),
                        value: 'both'
                    },
                    {
                        label: t('$(globe) Set Token Plan endpoint', '$(globe) 设置 Token Plan 接入点'),
                        description: t('Current: {0}', '当前：{0}', endpointLabel),
                        detail: t(
                            'Set the endpoint for Token Plan: China site (minimaxi.com) or global site (minimax.io)',
                            '设置 Token Plan 接入的站点：国内站 (minimaxi.com) 或国际站 (minimax.io)'
                        ),
                        value: 'endpoint'
                    }
                ],
                {
                    title: t('{0} key configuration', '{0} 密钥配置', displayName),
                    placeHolder: t('Select what to configure', '请选择要配置的项目')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled MiniMax config wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'coding' || choice.value === 'both') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }

            if (choice.value === 'endpoint') {
                await this.setCodingPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(
                `MiniMax config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    /**
     * 设置普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the standard API key for {0} (leave empty to clear)',
                '请输入 {0} 的普通 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} standard API key', '设置 {0} 普通 API Key', displayName),
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        // 用户取消了输入
        if (result === undefined) {
            return;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} standard API key cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(
                    t('{0} standard API key cleared', '{0} 普通 API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} standard API key set`);
                vscode.window.showInformationMessage(
                    t('{0} standard API key set', '{0} 普通 API Key 已设置', displayName)
                );
            }
        } catch (error) {
            Logger.error(
                `Standard API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
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
     * 设置 Token Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Token Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan API key', '设置 {0} Token Plan 专用 API Key', displayName),
            placeHolder: codingKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        // 用户取消了输入
        if (result === undefined) {
            return;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} Token Plan API key cleared`);
                await ApiKeyManager.deleteApiKey(this.TOKEN_PLAN_KEY);
                vscode.window.showInformationMessage(
                    t('{0} Token Plan API key cleared', '{0} Token Plan 专用 API Key 已清除', displayName)
                );
            } else {
                await ApiKeyManager.setApiKey(this.TOKEN_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Token Plan API key set`);
                vscode.window.showInformationMessage(
                    t('{0} Token Plan API key set', '{0} Token Plan 专用 API Key 已设置', displayName)
                );

                // API Key 设置后，自动进行接入点选择
                await this.setCodingPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(
                `Token Plan API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            vscode.window.showErrorMessage(
                t(
                    'Failed to save the API key: {0}',
                    '设置失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
        }

        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('minimax');
    }

    /**
     * 选择 Token Plan 接入点（国内/国际站）
     */
    static async setCodingPlanEndpoint(displayName: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(home) China site (minimaxi.com)', '$(home) 国内站 (minimaxi.com)'),
                        value: 'minimaxi.com' as const
                    },
                    {
                        label: t('$(globe) Global site (minimax.io)', '$(globe) 国际站 (minimax.io)'),
                        value: 'minimax.io' as const
                    }
                ],
                {
                    title: t('{0} (Token Plan) endpoint selection', '{0} (Token Plan) 接入点选择', displayName),
                    placeHolder: t('Select an endpoint', '请选择接入点'),
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`User cancelled ${displayName} Token Plan endpoint selection`);
                return;
            }

            // 保存用户的站点选择
            await this.saveCodingPlanSite(choice.value);

            const siteLabel = choice.value === 'minimax.io' ? t('Global site', '国际站') : t('China site', '国内站');
            Logger.info(`${displayName} Token Plan endpoint set to: ${siteLabel}`);
            vscode.window.showInformationMessage(
                t('{0} Token Plan endpoint set to: {1}', '{0} Token Plan 接入点已设置为: {1}', displayName, siteLabel)
            );
        } catch (error) {
            Logger.error(
                `Failed to set Token Plan endpoint: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    /**
     * 保存 Token Plan 接入点配置
     */
    static async saveCodingPlanSite(site: MiniMaxConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.minimax');

            // 保存到 gcmp.minimax.endpoint 配置
            await config.update('endpoint', site, vscode.ConfigurationTarget.Global);
            Logger.info(`Saved Token Plan endpoint: ${site}`);
        } catch (error) {
            Logger.error(
                `Failed to save Token Plan endpoint: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            throw error;
        }
    }
}
