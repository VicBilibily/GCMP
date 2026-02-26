/*---------------------------------------------------------------------------------------------
 *  MiniMax 配置向导
 *  提供交互式向导来配置普通密钥和 Coding Plan 专用密钥，支持接入点（站点）选择
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';
import { StatusBarManager } from '../status';
import { MiniMaxConfig } from './configManager';

export class MiniMaxWizard {
    private static readonly PROVIDER_KEY = 'minimax';
    private static readonly CODING_PLAN_KEY = 'minimax-coding';

    /**
     * 启动 MiniMax 配置向导
     * 允许用户选择配置哪种密钥类型
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            // 获取当前接入站点
            const currentEndpoint = ConfigManager.getMinimaxEndpoint();
            const endpointLabel = currentEndpoint === 'minimax.io' ? '国际站 (minimax.io)' : '国内站 (minimaxi.com)';

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) 设置普通 API 密钥',
                        detail: '用于 MiniMax-M2 等标准按量计费模型',
                        value: 'normal'
                    },
                    {
                        label: '$(key) 设置 Coding Plan 专用密钥',
                        detail: '用于 MiniMax-M2 (Coding Plan) 模型',
                        value: 'coding'
                    },
                    {
                        label: '$(check-all) 同时设置两种密钥',
                        detail: '按顺序配置普通密钥和 Coding Plan 密钥',
                        value: 'both'
                    },
                    {
                        label: '$(globe) 设置 Coding Plan 接入点',
                        description: `当前：${endpointLabel}`,
                        detail: '设置 Coding Plan 编程套餐接入的站点：国内站 (minimaxi.com) 或国际站 (minimax.io)',
                        value: 'endpoint'
                    }
                ],
                { title: `${displayName} 密钥配置`, placeHolder: '请选择要配置的项目' }
            );

            if (!choice) {
                Logger.debug('用户取消了 MiniMax 配置向导');
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
            Logger.error(`MiniMax 配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的普通 API Key（留空可清除）`,
            title: `设置 ${displayName} 普通 API Key`,
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
                Logger.info(`${displayName} 普通 API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} 普通 API Key 已清除`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} 普通 API Key 已设置`);
                vscode.window.showInformationMessage(`${displayName} 普通 API Key 已设置`);
            }
        } catch (error) {
            Logger.error(`普通 API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 设置 Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `请输入 ${displayName} 的 Coding Plan 专用 API Key（留空可清除）`,
            title: `设置 ${displayName} Coding Plan 专用 API Key`,
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
                Logger.info(`${displayName} Coding Plan 专用 API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.CODING_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Coding Plan 专用 API Key 已清除`);
            } else {
                await ApiKeyManager.setApiKey(this.CODING_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan 专用 API Key 已设置`);
                vscode.window.showInformationMessage(`${displayName} Coding Plan 专用 API Key 已设置`);

                // API Key 设置后，自动进行接入点选择
                await this.setCodingPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`Coding Plan API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }

        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('minimax');
    }

    /**
     * 选择 Coding Plan 接入点（国内/国际站）
     */
    static async setCodingPlanEndpoint(displayName: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(home) 国内站 (minimaxi.com)',
                        value: 'minimaxi.com' as const
                    },
                    {
                        label: '$(globe) 国际站 (minimax.io)',
                        value: 'minimax.io' as const
                    }
                ],
                {
                    title: `${displayName} (Coding Plan) 接入点选择`,
                    placeHolder: '请选择接入点',
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`用户取消了 ${displayName} Coding Plan 接入点选择`);
                return;
            }

            // 保存用户的站点选择
            await this.saveCodingPlanSite(choice.value);

            const siteLabel = choice.value === 'minimax.io' ? '国际站' : '国内站';
            Logger.info(`${displayName} Coding Plan 接入点已设置为: ${siteLabel}`);
            vscode.window.showInformationMessage(`${displayName} Coding Plan 接入点已设置为: ${siteLabel}`);
        } catch (error) {
            Logger.error(`Coding Plan 接入点设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 保存 Coding Plan 接入点配置
     */
    static async saveCodingPlanSite(site: MiniMaxConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.minimax');

            // 保存到 gcmp.minimax.endpoint 配置
            await config.update('endpoint', site, vscode.ConfigurationTarget.Global);
            Logger.info(`已保存 Coding Plan 接入点: ${site}`);
        } catch (error) {
            Logger.error(`保存 Coding Plan 接入点失败: ${error instanceof Error ? error.message : '未知错误'}`);
            throw error;
        }
    }
}
