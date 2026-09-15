/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 配置向导
 *  提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { ConfigManager, type DashscopeConfig } from '../utils/config/configManager';
import { t } from '../utils/runtime/l10n';
import { BaseWizard } from './baseWizard';

export class DashscopeWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'dashscope';
    private static readonly CODING_PLAN_KEY = 'dashscope-coding';
    private static readonly TOKEN_PLAN_KEY = 'dashscope-token';
    private static readonly PERSONAL_TOKEN_PLAN_KEY = 'dashscope-token-personal';

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
            const endpointLabel = DashscopeWizard.getEndpointLabel(ConfigManager.getDashscopeEndpoint());

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
                        label: t('$(key) Set Token Plan (Team) dedicated key', '$(key) 设置 Token Plan 团队版专用密钥'),
                        detail: t('For {0} Token Plan (Team) models', '用于 {0} Token Plan 团队版模型', displayName),
                        value: 'tokenPlan'
                    },
                    {
                        label: t(
                            '$(key) Set Token Plan (Personal) dedicated key',
                            '$(key) 设置 Token Plan 个人版专用密钥'
                        ),
                        detail: t(
                            'For {0} Token Plan (Personal) models',
                            '用于 {0} Token Plan 个人版模型',
                            displayName
                        ),
                        value: 'personalTokenPlan'
                    },
                    {
                        label: t('$(globe) Set endpoint', '$(globe) 设置接入点'),
                        description: t('Current: {0}', '当前：{0}', endpointLabel),
                        detail: t(
                            'Switch between the China site (cn-beijing) and the International site (ap-southeast-1) for all models',
                            '在所有模型间切换国内站 (cn-beijing) 与国际站 (ap-southeast-1)'
                        ),
                        value: 'endpoint'
                    },
                    {
                        label: t('$(check-all) Configure all items in sequence', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the standard key, dedicated plan keys, and endpoint in order',
                            '按顺序配置普通密钥、各套餐专用密钥与接入点'
                        ),
                        value: 'all'
                    }
                ],
                {
                    title: t('{0} Settings Menu', '{0} 配置菜单', displayName),
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

            if (choice.value === 'personalTokenPlan' || choice.value === 'all') {
                await this.setPersonalTokenPlanApiKey(
                    displayName,
                    tokenKeyTemplate || codingKeyTemplate || apiKeyTemplate
                );
            }

            if (choice.value === 'endpoint' || choice.value === 'all') {
                await this.setEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`DashScope setup wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 设置 Dashscope 普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: t(
                'Enter the API key for {0} (leave empty to clear)',
                '请输入 {0} 的 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} API Key', '设置 {0} API Key', displayName),
            placeHolder: apiKeyTemplate,
            successMessage: t('{0} API Key configured', '{0} API Key 已设置', displayName),
            clearMessage: t('{0} API Key cleared', '{0} API Key 已清除', displayName),
            loggerName: displayName
        });
    }

    /**
     * 设置 Dashscope Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_PLAN_KEY,
            prompt: t(
                'Enter the Coding Plan dedicated API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Coding Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Coding Plan dedicated API Key', '设置 {0} Coding Plan 专用 API Key', displayName),
            placeHolder: codingKeyTemplate,
            successMessage: t(
                '{0} Coding Plan dedicated API Key configured',
                '{0} Coding Plan 专用 API Key 已设置',
                displayName
            ),
            clearMessage: t(
                '{0} Coding Plan dedicated API Key cleared',
                '{0} Coding Plan 专用 API Key 已清除',
                displayName
            ),
            loggerName: displayName
        });
    }

    /**
     * 设置 Dashscope Token Plan 团队版专用密钥
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_PLAN_KEY,
            prompt: t(
                'Enter the Token Plan (Team) dedicated API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 团队版专用 API Key（留空可清除）',
                displayName
            ),
            title: t(
                'Set {0} Token Plan (Team) dedicated API Key',
                '设置 {0} Token Plan 团队版专用 API Key',
                displayName
            ),
            placeHolder: tokenKeyTemplate,
            successMessage: t(
                '{0} Token Plan (Team) dedicated API Key configured',
                '{0} Token Plan 团队版专用 API Key 已设置',
                displayName
            ),
            clearMessage: t(
                '{0} Token Plan (Team) dedicated API Key cleared',
                '{0} Token Plan 团队版专用 API Key 已清除',
                displayName
            ),
            loggerName: displayName
        });
    }

    /**
     * 设置 Dashscope Token Plan 个人版专用密钥
     */
    static async setPersonalTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PERSONAL_TOKEN_PLAN_KEY,
            prompt: t(
                'Enter the Token Plan (Personal) dedicated API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 个人版专用 API Key（留空可清除）',
                displayName
            ),
            title: t(
                'Set {0} Token Plan (Personal) dedicated API Key',
                '设置 {0} Token Plan 个人版专用 API Key',
                displayName
            ),
            placeHolder: tokenKeyTemplate,
            successMessage: t(
                '{0} Token Plan (Personal) dedicated API Key configured',
                '{0} Token Plan 个人版专用 API Key 已设置',
                displayName
            ),
            clearMessage: t(
                '{0} Token Plan (Personal) dedicated API Key cleared',
                '{0} Token Plan 个人版专用 API Key 已清除',
                displayName
            ),
            loggerName: displayName
        });
    }

    /**
     * 接入点显示名称
     */
    private static getEndpointLabel(endpoint: DashscopeConfig['endpoint']): string {
        return endpoint === 'ap-southeast-1' ?
                t('International (ap-southeast-1)', '国际站 (ap-southeast-1)')
            :   t('China (cn-beijing)', '国内站 (cn-beijing)');
    }

    /**
     * 设置接入点（国内站 / 国际站）
     */
    static async setEndpoint(displayName: string): Promise<void> {
        const currentEndpoint = ConfigManager.getDashscopeEndpoint();

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: t('$(home) China (cn-beijing)', '$(home) 国内站 (cn-beijing)'),
                    detail: t(
                        'Recommended for faster access in mainland China\ndashscope.aliyuncs.com / coding.dashscope.aliyuncs.com / token-plan.cn-beijing.maas.aliyuncs.com',
                        '推荐，国内访问速度更快\ndashscope.aliyuncs.com / coding.dashscope.aliyuncs.com / token-plan.cn-beijing.maas.aliyuncs.com'
                    ),
                    value: 'cn-beijing' as const
                },
                {
                    label: t('$(globe) International (ap-southeast-1)', '$(globe) 国际站 (ap-southeast-1)'),
                    detail: t(
                        'Use for overseas users or when mainland access is restricted\ndashscope-intl.aliyuncs.com / coding-intl.dashscope.aliyuncs.com / token-plan.ap-southeast-1.maas.aliyuncs.com',
                        '海外用户或国内站访问受限时使用\ndashscope-intl.aliyuncs.com / coding-intl.dashscope.aliyuncs.com / token-plan.ap-southeast-1.maas.aliyuncs.com'
                    ),
                    value: 'ap-southeast-1' as const
                }
            ],
            {
                title: t('{0} Endpoint Selection', '{0} 接入站点选择', displayName),
                placeHolder: t('Current: {0}', '当前：{0}', this.getEndpointLabel(currentEndpoint))
            }
        );

        if (!choice) {
            Logger.debug(`User cancelled ${displayName} endpoint selection`);
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('gcmp.dashscope');
            await config.update('endpoint', choice.value, vscode.ConfigurationTarget.Global);
            Logger.info(`DashScope endpoint set to ${choice.value}`);
            vscode.window.showInformationMessage(
                t(
                    'DashScope endpoint set to {0}',
                    '阿里云百炼接入站点已设置为 {0}',
                    this.getEndpointLabel(choice.value)
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
}
