/*---------------------------------------------------------------------------------------------
 *  智谱AI配置向导
 *  提供交互式向导来配置API密钥和MCP搜索服务
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ConfigManager } from '../utils/config/configManager';
import { t } from '../utils/runtime/l10n';

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
            const mcpStatusText = currentMCPStatus ? t('Enabled', '已启用') : t('Disabled', '已禁用');

            // 获取当前接入站点
            const currentEndpoint = ConfigManager.getZhipuEndpoint();
            const endpointLabel =
                currentEndpoint === 'api.z.ai' ?
                    t('Global (api.z.ai)', '国际站 (api.z.ai)')
                :   t('China (open.bigmodel.cn)', '国内站 (open.bigmodel.cn)');

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Update {0} API Key', '$(key) 修改 {0} API Key', displayName),
                        detail: t('Set or remove the {0} API Key', '设置或删除 {0} API Key', displayName),
                        action: 'updateApiKey'
                    },
                    {
                        label: t('$(plug) Configure MCP search mode', '$(plug) 启用 MCP 搜索模式'),
                        description: t('Current: {0}', '当前：{0}', mcpStatusText),
                        detail: t(
                            'Use the search quota included in the Coding Plan: Lite (100 trial searches) / Pro (1,000 searches) / Max (4,000 searches)',
                            '使用 Coding Plan 套餐内的搜索次数，Lite(100次体验)/Pro(1千次搜索)/Max(4千次搜索)'
                        ),
                        action: 'toggleMCP'
                    },
                    {
                        label: t('$(globe) Set endpoint', '$(globe) 设置接入点'),
                        description: t('Current: {0}', '当前：{0}', endpointLabel),
                        detail: t(
                            'Set the Zhipu AI endpoint: China (open.bigmodel.cn) or Global (api.z.ai)',
                            '设置智谱AI接入站点：国内站 (open.bigmodel.cn) 或国际站 (api.z.ai)'
                        ),
                        action: 'endpoint'
                    }
                ],
                {
                    title: t('{0} Settings Menu', '{0} 配置菜单', displayName),
                    placeHolder: t('Select an action to perform', '选择要执行的操作')
                }
            );

            if (!choice) {
                Logger.debug('User cancelled the Zhipu AI setup wizard');
                return;
            }

            if (choice.action === 'updateApiKey') {
                // 检查是否已有 API Key
                const hasApiKey = await ApiKeyManager.hasValidApiKey(this.PROVIDER_KEY);
                if (!hasApiKey) {
                    // 没有 API Key，先设置 API Key
                    Logger.debug('Detected missing API key, starting API key setup flow');
                    const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                    if (!apiKeySet) {
                        // 用户取消了 API Key 设置
                        Logger.debug('User cancelled API key setup');
                        return;
                    }
                    Logger.debug('API key configured successfully, continuing to MCP search configuration');

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
            Logger.error(`Zhipu AI setup wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 显示设置 API Key 步骤
     * 允许用户输入空值来清除 API Key
     */
    private static async showSetApiKeyStep(displayName: string, apiKeyTemplate: string): Promise<boolean> {
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

        // 用户取消了输入
        if (result === undefined) {
            return false;
        }

        try {
            // 允许空值，用于清除 API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} API key cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API key configured`);
            }
            return true;
        } catch (error) {
            Logger.error(`API key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
                    label: t('$(x) Do not enable MCP search mode', '$(x) 不启用 MCP 搜索模式'),
                    detail: t(
                        'Use the Web Search API pay-as-you-go interface when the included quota is exhausted or advanced search is needed.',
                        '使用 Web Search API 按量计费接口，套餐次数用完或需要高级搜索功能时使用'
                    ),
                    action: 'disableMCP'
                },
                {
                    label: t('$(check) Enable MCP search mode', '$(check) 启用 MCP 搜索模式'),
                    detail: t(
                        'Use the search quota included in the Coding Plan: Lite (100 trial searches) / Pro (1,000 searches) / Max (4,000 searches)',
                        '使用 Coding Plan 套餐内的搜索次数，Lite(100次体验)/Pro(1千次搜索)/Max(4千次搜索)'
                    ),
                    action: 'enableMCP'
                }
            ],
            {
                title: t('{0} MCP Search Communication Mode', '{0} MCP 搜索服务配置通讯模式设置', displayName),
                placeHolder: t(
                    'Choose whether to enable MCP communication for search',
                    '选择是否启用搜索服务 MCP 通讯模式'
                )
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
    private static async setMCPConfig(enable: boolean): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp');
            await config.update('zhipu.search.enableMCP', enable, vscode.ConfigurationTarget.Global);
            Logger.info(`Zhipu MCP search service ${enable ? 'enabled' : 'disabled'}`);
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

    /**
     * 设置接入点
     */
    static async setEndpoint(displayName: string): Promise<void> {
        const currentEndpoint = ConfigManager.getZhipuEndpoint();
        const endpointLabel =
            currentEndpoint === 'api.z.ai' ?
                t('Global (api.z.ai)', '国际站 (api.z.ai)')
            :   t('China (open.bigmodel.cn)', '国内站 (open.bigmodel.cn)');

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: t('$(home) China (open.bigmodel.cn)', '$(home) 国内站 (open.bigmodel.cn)'),
                    detail: t('Recommended for faster access in mainland China', '推荐，国内访问速度更快'),
                    value: 'open.bigmodel.cn'
                },
                {
                    label: t('$(globe) Global (api.z.ai)', '$(globe) 国际站 (api.z.ai)'),
                    detail: t(
                        'Use for overseas users or when mainland access is restricted',
                        '海外用户或国内站访问受限时使用'
                    ),
                    value: 'api.z.ai'
                }
            ],
            {
                title: t('{0} Endpoint Selection', '{0} 接入站点选择', displayName),
                placeHolder: t('Current: {0}', '当前：{0}', endpointLabel)
            }
        );

        if (!choice) {
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('gcmp.zhipu');
            await config.update('endpoint', choice.value, vscode.ConfigurationTarget.Global);
            Logger.info(`Zhipu AI endpoint set to ${choice.value}`);
            vscode.window.showInformationMessage(
                t(
                    'Zhipu AI endpoint set to {0}',
                    '智谱AI接入站点已设置为 {0}',
                    choice.value === 'api.z.ai' ? t('Global', '国际站') : t('China', '国内站')
                )
            );
        } catch (error) {
            const errorMessage = t(
                'Failed to set endpoint: {0}',
                '设置接入点失败: {0}',
                error instanceof Error ? error.message : 'Unknown error'
            );
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
