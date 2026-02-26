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
     * 直接进入设置菜单，无需先检测 API Key
     */
    static async startWizard(displayName: string, apiKeyTemplate: string): Promise<void> {
        try {
            // 获取当前 MCP 状态
            const currentMCPStatus = ConfigManager.getZhipuSearchConfig().enableMCP;
            const mcpStatusText = currentMCPStatus ? '已启用' : '已禁用';

            // 获取当前接入站点
            const currentEndpoint = ConfigManager.getZhipuEndpoint();
            const endpointLabel = currentEndpoint === 'api.z.ai' ? '国际站 (api.z.ai)' : '国内站 (open.bigmodel.cn)';

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `$(key) 修改 ${displayName} API Key`,
                        detail: `设置或删除 ${displayName} API Key`,
                        action: 'updateApiKey'
                    },
                    {
                        label: '$(plug) 启用 MCP 搜索模式',
                        description: `当前：${mcpStatusText}`,
                        detail: '使用 Coding Plan 套餐内的搜索次数，Lite(100次体验)/Pro(1千次搜索)/Max(4千次搜索)',
                        action: 'toggleMCP'
                    },
                    {
                        label: '$(globe) 设置接入点',
                        description: `当前：${endpointLabel}`,
                        detail: '设置智谱AI接入站点：国内站 (open.bigmodel.cn) 或国际站 (api.z.ai)',
                        action: 'endpoint'
                    }
                ],
                {
                    title: `${displayName} 配置菜单`,
                    placeHolder: '选择要执行的操作'
                }
            );

            if (!choice) {
                Logger.debug('用户取消了智谱AI配置向导');
                return;
            }

            if (choice.action === 'updateApiKey') {
                // 检查是否已有 API Key
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

                    // 配置 MCP 搜索服务
                    await this.showMCPConfigStep(displayName);
                } else {
                    // 已经有 API Key，重新设置 API Key
                    const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                    if (!apiKeySet) {
                        return;
                    }
                }
            } else if (choice.action === 'toggleMCP') {
                await this.showMCPConfigStep(displayName);
            } else if (choice.action === 'endpoint') {
                await this.setEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`智谱AI配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
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
            ignoreFocusOut: true
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
     * 设置接入点
     */
    static async setEndpoint(displayName: string): Promise<void> {
        const currentEndpoint = ConfigManager.getZhipuEndpoint();
        const endpointLabel = currentEndpoint === 'api.z.ai' ? '国际站 (api.z.ai)' : '国内站 (open.bigmodel.cn)';

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(home) 国内站 (open.bigmodel.cn)',
                    detail: '推荐，国内访问速度更快',
                    value: 'open.bigmodel.cn'
                },
                {
                    label: '$(globe) 国际站 (api.z.ai)',
                    detail: '海外用户或国内站访问受限时使用',
                    value: 'api.z.ai'
                }
            ],
            {
                title: `${displayName} 接入站点选择`,
                placeHolder: `当前：${endpointLabel}`
            }
        );

        if (!choice) {
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('gcmp.zhipu');
            await config.update('endpoint', choice.value, vscode.ConfigurationTarget.Global);
            Logger.info(`智谱AI接入站点已设置为 ${choice.value}`);
            vscode.window.showInformationMessage(
                `智谱AI接入站点已设置为 ${choice.value === 'api.z.ai' ? '国际站' : '国内站'}`
            );
        } catch (error) {
            const errorMessage = `设置接入点失败: ${error instanceof Error ? error.message : '未知错误'}`;
            Logger.error(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    /**
     * 获取当前 MCP 状态
     */
    static getMCPStatus(): boolean {
        return ConfigManager.getZhipuSearchConfig().enableMCP;
    }
}
