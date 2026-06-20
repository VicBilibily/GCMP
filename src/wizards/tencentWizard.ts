/*---------------------------------------------------------------------------------------------
 *  腾讯云配置向导
 *  提供交互式向导来配置付费模型、Coding Plan、Token Plan 和 DeepSeek 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';
import { BaseWizard } from './baseWizard';

export class TencentWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'tencent';
    private static readonly CODING_PLAN_KEY = 'tencent-coding';
    private static readonly TOKEN_PLAN_KEY = 'tencent-token';
    private static readonly DEEPSEEK_KEY = 'tencent-deepseek';
    private static readonly TOKENHUB_KEY = 'tencent-tokenhub';

    static async startWizard(
        displayName: string,
        apiKeyTemplate: string,
        codingKeyTemplate?: string,
        tokenPlanKeyTemplate?: string
    ): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set pay-as-you-go model API key', '$(key) 设置付费模型 API 密钥'),
                        detail: t(
                            'Used for Tencent Hunyuan and third-party pay-as-you-go models on Tencent Cloud',
                            '用于腾讯混元与腾讯云第三方大模型按量计费模型'
                        ),
                        value: 'normal'
                    },
                    {
                        label: t('$(key) Set Coding Plan API key', '$(key) 设置 Coding Plan 专用密钥'),
                        detail: t('Used for Tencent Cloud Coding Plan models', '用于腾讯云 Coding Plan 模型'),
                        value: 'coding'
                    },
                    {
                        label: t('$(key) Set Token Plan API key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t('Used for Tencent Cloud Token Plan models', '用于腾讯云 Token Plan 模型'),
                        value: 'tokenPlan'
                    },
                    {
                        label: t('$(key) Set DeepSeek API key', '$(key) 设置 DeepSeek 专用密钥'),
                        detail: t(
                            'Used for DeepSeek models in Tencent Cloud knowledge engine atomic capabilities',
                            '用于腾讯云知识引擎原子能力 DeepSeek 模型'
                        ),
                        value: 'deepseek'
                    },
                    {
                        label: t('$(key) Set TokenHub billing key', '$(key) 设置 TokenHub 计费密钥'),
                        detail: t(
                            'Used for Tencent Cloud TokenHub pay-as-you-go models',
                            '用于腾讯云 TokenHub 按量付费模型'
                        ),
                        value: 'tokenhub'
                    },
                    {
                        label: t('$(check-all) Configure all items', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the pay-as-you-go, Coding Plan, Token Plan, DeepSeek, and TokenHub keys in order',
                            '按顺序配置付费密钥、Coding Plan 密钥、Token Plan 密钥、DeepSeek 密钥和 TokenHub 密钥'
                        ),
                        value: 'all'
                    }
                ],
                {
                    title: t('{0} configuration wizard', '{0} 配置向导', displayName),
                    placeHolder: t('Select what to configure', '请选择要配置的项目')
                }
            );
            if (!choice) {
                Logger.debug('User cancelled Tencent Cloud config wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'all') {
                await this.setApiKey(apiKeyTemplate);
            }
            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(codingKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'tokenPlan' || choice.value === 'all') {
                await this.setTokenPlanApiKey(tokenPlanKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'deepseek' || choice.value === 'all') {
                await this.setDeepSeekApiKey(apiKeyTemplate);
            }
            if (choice.value === 'tokenhub' || choice.value === 'all') {
                await this.setTokenHubApiKey(apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(
                `Tencent Cloud config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    static async setApiKey(apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: t(
                'Enter the Tencent Cloud model API key (leave empty to clear)',
                '请输入 腾讯云大模型 API Key（留空可清除）'
            ),
            title: t('Set Tencent Cloud model API key', '设置 腾讯云大模型 API Key'),
            placeHolder: apiKeyTemplate,
            successMessage: t('Tencent Cloud model API key set', '腾讯云大模型 API Key 已设置'),
            clearMessage: t('Tencent Cloud model API key cleared', '腾讯云大模型 API Key 已清除')
        });
    }

    static async setCodingPlanApiKey(codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_PLAN_KEY,
            prompt: t(
                'Enter the Tencent Cloud Coding Plan API key (leave empty to clear)',
                '请输入 腾讯云 Coding Plan 专用 API Key（留空可清除）'
            ),
            title: t('Set Tencent Cloud Coding Plan API key', '设置 腾讯云 Coding Plan 专用 API Key'),
            placeHolder: codingKeyTemplate,
            successMessage: t('Tencent Cloud Coding Plan API key set', '腾讯云 Coding Plan 专用 API Key 已设置'),
            clearMessage: t('Tencent Cloud Coding Plan API key cleared', '腾讯云 Coding Plan 专用 API Key 已清除')
        });
    }

    static async setTokenPlanApiKey(tokenPlanKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_PLAN_KEY,
            prompt: t(
                'Enter the Tencent Cloud Token Plan API key (leave empty to clear)',
                '请输入 腾讯云 Token Plan 专用 API Key（留空可清除）'
            ),
            title: t('Set Tencent Cloud Token Plan API key', '设置 腾讯云 Token Plan 专用 API Key'),
            placeHolder: tokenPlanKeyTemplate,
            successMessage: t('Tencent Cloud Token Plan API key set', '腾讯云 Token Plan 专用 API Key 已设置'),
            clearMessage: t('Tencent Cloud Token Plan API key cleared', '腾讯云 Token Plan 专用 API Key 已清除')
        });
    }

    static async setDeepSeekApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.DEEPSEEK_KEY,
            prompt: t(
                'Enter the Tencent Cloud DeepSeek API key (leave empty to clear)',
                '请输入 腾讯云 DeepSeek 专用 API Key（留空可清除）'
            ),
            title: t('Set Tencent Cloud DeepSeek API key', '设置 腾讯云 DeepSeek 专用 API Key'),
            placeHolder: apiKeyTemplate,
            successMessage: t('Tencent Cloud DeepSeek API key set', '腾讯云 DeepSeek 专用 API Key 已设置'),
            clearMessage: t('Tencent Cloud DeepSeek API key cleared', '腾讯云 DeepSeek 专用 API Key 已清除')
        });
    }

    static async setTokenHubApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKENHUB_KEY,
            prompt: t(
                'Enter the Tencent Cloud TokenHub API key (leave empty to clear)',
                '请输入 腾讯云 TokenHub API Key（留空可清除）'
            ),
            title: t('Set Tencent Cloud TokenHub API key', '设置 腾讯云 TokenHub API Key'),
            placeHolder: apiKeyTemplate,
            successMessage: t('Tencent Cloud TokenHub API key set', '腾讯云 TokenHub API Key 已设置'),
            clearMessage: t('Tencent Cloud TokenHub API key cleared', '腾讯云 TokenHub API Key 已清除')
        });
    }
}
