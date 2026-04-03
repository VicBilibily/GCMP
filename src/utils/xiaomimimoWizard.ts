/*---------------------------------------------------------------------------------------------
 *  Xiaomi MiMo 配置向导
 *  提供交互式向导来配置普通密钥和 Token Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager, XiaomimimoConfig } from './configManager';

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
                cn: '中国接入点 (cn)',
                sgp: '新加坡接入点 (sgp)',
                ams: '欧洲接入点 (ams)'
            };

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 设置 API 密钥',
                        detail: `用于 ${displayName} 等标准按量计费模型`,
                        value: 'normal'
                    },
                    {
                        label: '$(key) 设置 Token Plan 专用密钥',
                        detail: `用于 ${displayName} Token Plan 模型`,
                        value: 'tokenPlan'
                    },
                    {
                        label: '$(globe) 设置 Token Plan 接入点',
                        description: `当前：${endpointLabels[currentEndpoint]}`,
                        detail: '设置 Xiaomi MiMo Token Plan 接入点：中国 (cn)、新加坡 (sgp) 、欧洲 (ams)',
                        value: 'endpoint'
                    },
                    {
                        label: '$(check-all) 同时设置两种密钥',
                        detail: '按顺序配置普通密钥与 Token Plan 专用密钥',
                        value: 'both'
                    }
                ],
                { title: `${displayName} 密钥配置`, placeHolder: '请选择要配置的项目' }
            );

            if (!choice) {
                Logger.debug('用户取消了 Xiaomi MiMo 配置向导');
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
            Logger.error(`Xiaomi MiMo 配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Xiaomi MiMo 普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 API Key（留空可清除）`,
            title: `设置 ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
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
            Logger.error(`Xiaomi MiMo API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Xiaomi MiMo Token Plan 专用密钥
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 Token Plan 专用 API Key（留空可清除）`,
            title: `设置 ${displayName} Token Plan 专用 API Key`,
            placeHolder: tokenKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Token Plan 专用 API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.TOKEN_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Token Plan 专用 API Key 已清除`);
            } else {
                await ApiKeyManager.setApiKey(this.TOKEN_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Token Plan 专用 API Key 已设置`);
                vscode.window.showInformationMessage(`${displayName} Token Plan 专用 API Key 已设置`);
            }
        } catch (error) {
            Logger.error(
                `Xiaomi MiMo Token Plan API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`
            );
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
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
                        label: '$(home) 中国接入点 (cn)',
                        value: 'cn' as const
                    },
                    {
                        label: '$(location) 新加坡接入点 (sgp)',
                        value: 'sgp' as const
                    },
                    {
                        label: '$(globe) 欧洲接入点 (ams)',
                        value: 'ams' as const
                    }
                ],
                {
                    title: `${displayName} Token Plan 接入点选择`,
                    placeHolder: '请选择接入点',
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`用户取消了 ${displayName} Token Plan 接入点选择`);
                return;
            }

            await this.saveTokenPlanEndpoint(choice.value);

            const endpointLabels: Record<string, string> = {
                cn: '中国接入点',
                sgp: '新加坡接入点',
                ams: '欧洲接入点'
            };
            Logger.info(`${displayName} Token Plan 接入点已设置为: ${endpointLabels[choice.value]}`);
            vscode.window.showInformationMessage(
                `${displayName} Token Plan 接入点已设置为: ${endpointLabels[choice.value]}`
            );
        } catch (error) {
            Logger.error(`Token Plan 接入点设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 保存 Token Plan 接入点配置
     */
    static async saveTokenPlanEndpoint(endpoint: XiaomimimoConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.xiaomimimo');
            await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
            Logger.info(`已保存 Token Plan 接入点: ${endpoint}`);
        } catch (error) {
            Logger.error(`保存 Token Plan 接入点失败: ${error instanceof Error ? error.message : '未知错误'}`);
            throw error;
        }
    }
}
