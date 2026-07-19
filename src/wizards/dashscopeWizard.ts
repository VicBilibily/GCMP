/*---------------------------------------------------------------------------------------------
 *  Dashscope (阿里云百炼) 配置向导
 *  提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
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
                        label: t('$(check-all) Configure all items in sequence', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the standard key, Coding Plan dedicated key, and Token Plan dedicated keys in order',
                            '按顺序配置普通密钥、Coding Plan 专用密钥与 Token Plan 专用密钥'
                        ),
                        value: 'all'
                    }
                ],
                {
                    title: t('{0} Key Configuration', '{0} 密钥配置', displayName),
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
}
