/*---------------------------------------------------------------------------------------------
 *  Xiaomi MiMo 配置向导
 *  提供交互式向导来配置普通密钥和 Token Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager, XiaomimimoConfig } from './configManager';
import { t } from './l10n';

export class XiaomimimoWizard {
    private static readonly PROVIDER_KEY = 'xiaomimimo';
    private static readonly TOKEN_PLAN_KEY = 'xiaomimimo-token';

    /**
     * 启动 Xiaomi MiMo 配置向导
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, tokenKeyTemplate?: string): Promise<void> {
        try {
            const currentEndpoint = ConfigManager.getXiaomimimoEndpoint();
            const endpointLabels: Record<string, string> = {
                cn: t('China endpoint (cn)', '中国接入点 (cn)'),
                sgp: t('Singapore endpoint (sgp)', '新加坡接入点 (sgp)'),
                ams: t('Europe endpoint (ams)', '欧洲接入点 (ams)')
            };

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set API key', '$(key) 设置 API 密钥'),
                        detail: t(
                            'Used for standard pay-as-you-go models such as {0}',
                            '用于 {0} 等标准按量计费模型',
                            displayName
                        ),
                        value: 'normal'
                    },
                    {
                        label: t('$(key) Set Token Plan API key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t('Used for {0} Token Plan models', '用于 {0} Token Plan 模型', displayName),
                        value: 'tokenPlan'
                    },
                    {
                        label: t('$(globe) Set Token Plan endpoint', '$(globe) 设置 Token Plan 接入点'),
                        description: t('Current: {0}', '当前：{0}', endpointLabels[currentEndpoint]),
                        detail: t(
                            'Set Xiaomi MiMo Token Plan endpoint: China (cn), Singapore (sgp), Europe (ams)',
                            '设置 Xiaomi MiMo Token Plan 接入点：中国 (cn)、新加坡 (sgp) 、欧洲 (ams)'
                        ),
                        value: 'endpoint'
                    },
                    {
                        label: t('$(check-all) Set both keys', '$(check-all) 同时设置两种密钥'),
                        detail: t(
                            'Configure the standard key and Token Plan key in order',
                            '按顺序配置普通密钥与 Token Plan 专用密钥'
                        ),
                        value: 'both'
                    }
                ],
                {
                    title: t('{0} key configuration', '{0} 密钥配置', displayName),
                    placeHolder: t('Select what to configure', '请选择要配置的项目')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled Xiaomi MiMo config wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }
            if (choice.value === 'tokenPlan' || choice.value === 'both') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'endpoint') {
                await this.setTokenPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(
                `Xiaomi MiMo config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    /**
     * 设置 Xiaomi MiMo 普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the API key for {0} (leave empty to clear)',
                '请输入 {0} 的 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} API key', '设置 {0} API Key', displayName),
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
                vscode.window.showInformationMessage(t('{0} API key cleared', '{0} API Key 已清除', displayName));
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API key set`);
                vscode.window.showInformationMessage(t('{0} API key set', '{0} API Key 已设置', displayName));
            }
        } catch (error) {
            Logger.error(
                `Xiaomi MiMo API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
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
     * 设置 Xiaomi MiMo Token Plan 专用密钥
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: t(
                'Enter the Token Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan API key', '设置 {0} Token Plan 专用 API Key', displayName),
            placeHolder: tokenKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
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
            }
        } catch (error) {
            Logger.error(
                `Xiaomi MiMo Token Plan API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
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
     * 选择 Token Plan 接入点
     */
    static async setTokenPlanEndpoint(displayName: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(home) China endpoint (cn)', '$(home) 中国接入点 (cn)'),
                        value: 'cn' as const
                    },
                    {
                        label: t('$(location) Singapore endpoint (sgp)', '$(location) 新加坡接入点 (sgp)'),
                        value: 'sgp' as const
                    },
                    {
                        label: t('$(globe) Europe endpoint (ams)', '$(globe) 欧洲接入点 (ams)'),
                        value: 'ams' as const
                    }
                ],
                {
                    title: t('{0} Token Plan endpoint selection', '{0} Token Plan 接入点选择', displayName),
                    placeHolder: t('Select an endpoint', '请选择接入点'),
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`User cancelled ${displayName} Token Plan endpoint selection`);
                return;
            }

            await this.saveTokenPlanEndpoint(choice.value);

            const endpointLabels: Record<string, string> = {
                cn: t('China endpoint', '中国接入点'),
                sgp: t('Singapore endpoint', '新加坡接入点'),
                ams: t('Europe endpoint', '欧洲接入点')
            };
            Logger.info(`${displayName} Token Plan endpoint set to: ${endpointLabels[choice.value]}`);
            vscode.window.showInformationMessage(
                t(
                    '{0} Token Plan endpoint set to: {1}',
                    '{0} Token Plan 接入点已设置为: {1}',
                    displayName,
                    endpointLabels[choice.value]
                )
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
    static async saveTokenPlanEndpoint(endpoint: XiaomimimoConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.xiaomimimo');
            await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
            Logger.info(`Saved Token Plan endpoint: ${endpoint}`);
        } catch (error) {
            Logger.error(
                `Failed to save Token Plan endpoint: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            throw error;
        }
    }
}
