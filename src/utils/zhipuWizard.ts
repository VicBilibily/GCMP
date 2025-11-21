/*---------------------------------------------------------------------------------------------
 *  智谱AI配置向导
 *  提供交互式向导来配置API密钥和MCP搜索服务
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';

export class ZhipuWizard {
    private static readonly PROVIDER_KEY = 'zhipu';

    /**
     * 启动配置向导
     */
    static async startWizard(displayName: string, apiKeyTemplate: string): Promise<void> {
        try {
            // 第一步：检查 API Key
            const hasApiKey = await ApiKeyManager.hasValidApiKey(this.PROVIDER_KEY);
            if (!hasApiKey) {
                // 没有 API Key，先设置 API Key
                Logger.debug('检测到未设置 API Key，启动 API Key 设置流程');
                const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                if (!apiKeySet) {
                    // 用户取消了 API Key 设置
                    Logger.debug('用户取消了 API Key 设置');
                    return;
                }
                Logger.debug('API Key 设置成功，进入 MCP 搜索配置');

                // 第二步：配置 MCP 搜索服务
                await this.showMCPConfigStep(displayName);
            } else {
                // 已经有 API Key，直接进入操作菜单
                await this.showOperationMenu(displayName, apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 显示设置 API Key 步骤
     * 允许用户输入空值来清除 API Key
     */
    private static async showSetApiKeyStep(displayName: string, apiKeyTemplate: string): Promise<boolean> {
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
            return false;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} API Key 已清除`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API Key 已设置`);
            }
            return true;
        } catch (error) {
            Logger.error(`API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            return false;
        }
    }

    /**
     * 显示 MCP 搜索配置步骤
     */
    private static async showMCPConfigStep(displayName: string): Promise<void> {
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(x) 不启用 MCP 搜索模式',
                    detail: '使用 Web Search API 按量计费接口，套餐次数用完或需要高级搜索功能时使用',
                    action: 'disableMCP'
                },
                {
                    label: '$(check) 启用 MCP 搜索模式',
                    detail: '使用 Coding Plan 套餐内的搜索次数，Lite(100次体验)/Pro(1千次搜索)/Max(4千次搜索)',
                    action: 'enableMCP'
                }
            ],
            {
                title: `${displayName} MCP 搜索服务配置通讯模式设置`,
                placeHolder: '选择是否启用搜索服务 MCP 通讯模式'
            }
        );

        if (!choice) {
            return;
        }

        try {
            if (choice.action === 'enableMCP') {
                await this.setMCPConfig(true);
            } else {
                await this.setMCPConfig(false);
            }
        } catch (error) {
            Logger.error(`MCP 配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`MCP 配置失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 显示操作菜单
     */
    private static async showOperationMenu(displayName: string, apiKeyTemplate: string): Promise<void> {
        while (true) {
            // 获取当前 MCP 状态
            const currentMCPStatus = ConfigManager.getZhipuSearchConfig().enableMCP;
            const mcpStatusText = currentMCPStatus ? '已启用' : '已禁用';

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `$(key) 修改 ${displayName} API Key`,
                        detail: `设置或删除 ${displayName} API Key`,
                        action: 'updateApiKey'
                    },
                    {
                        label: '$(plug) 启用 MCP 搜索模式',
                        detail: `当前: ${mcpStatusText}`,
                        action: 'toggleMCP'
                    }
                ],
                {
                    title: `${displayName} 配置菜单`,
                    placeHolder: '选择要执行的操作'
                }
            );
            if (!choice) {
                break;
            }
            if (choice.action === 'updateApiKey') {
                const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                if (!apiKeySet) {
                    continue;
                }
            } else if (choice.action === 'toggleMCP') {
                await this.showMCPConfigStep(displayName);
            }
        }
    }

    /**
     * 设置 MCP 配置
     */
    private static async setMCPConfig(enable: boolean): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            await config.update('zhipu.search.enableMCP', enable, vscode.ConfigurationTarget.Global);
            Logger.info(`Zhipu MCP 搜索服务已${enable ? '启用' : '禁用'}`);
        } catch (error) {
            const errorMessage = `设置 MCP 配置失败: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            throw error;
        }
    }

    /**
     * 获取当前 MCP 状态
     */
    static getMCPStatus(): boolean {
        return ConfigManager.getZhipuSearchConfig().enableMCP;
    }
}
