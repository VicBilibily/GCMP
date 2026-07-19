/*---------------------------------------------------------------------------------------------
 *  Astron (讯飞星辰) 配置向导
 *  提供交互式向导来配置 Coding Plan 和 Token Plan 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import { BaseWizard } from './baseWizard';

export class XfyunWizard extends BaseWizard {
    private static readonly CODING_KEY = 'xfyun-coding';
    private static readonly TOKEN_KEY = 'xfyun-token';

    /**
     * 启动 Astron 配置向导
     */
    static async startWizard(displayName: string, codingKeyTemplate: string, tokenKeyTemplate: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set Coding Plan dedicated key', '$(key) 设置 Coding Plan 专用密钥'),
                        detail: t(
                            'For {0} Coding Plan subscription models',
                            '用于 {0} Coding Plan 编程套餐模型',
                            displayName
                        ),
                        value: 'coding'
                    },
                    {
                        label: t('$(key) Set Token Plan dedicated key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t('For {0} Token Plan team models', '用于 {0} Token Plan 团队版模型', displayName),
                        value: 'token'
                    },
                    {
                        label: t('$(check-all) Configure all items in sequence', '$(check-all) 依次配置全部项目'),
                        detail: t(
                            'Configure the Coding Plan and Token Plan dedicated keys in order',
                            '按顺序配置 Coding Plan 与 Token Plan 专用密钥'
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
                Logger.debug('User cancelled the Astron setup wizard');
                return;
            }

            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate);
            }

            if (choice.value === 'token' || choice.value === 'all') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Astron setup wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * 设置 Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_KEY,
            prompt: t(
                'Enter the Coding Plan API key for {0} (leave empty to clear)',
                '请输入 {0} Coding Plan API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Coding Plan API Key', '设置 {0} Coding Plan API Key', displayName),
            placeHolder: codingKeyTemplate,
            successMessage: t('{0} Coding Plan API key configured', '{0} Coding Plan API Key 已设置', displayName),
            clearMessage: t('{0} Coding Plan API key cleared', '{0} Coding Plan API Key 已清除', displayName),
            loggerName: `${displayName} Coding Plan`
        });
    }

    /**
     * 设置 Token Plan 专用密钥
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_KEY,
            prompt: t(
                'Enter the Token Plan API key for {0} (leave empty to clear)',
                '请输入 {0} Token Plan API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan API Key', '设置 {0} Token Plan API Key', displayName),
            placeHolder: tokenKeyTemplate,
            successMessage: t('{0} Token Plan API key configured', '{0} Token Plan API Key 已设置', displayName),
            clearMessage: t('{0} Token Plan API key cleared', '{0} Token Plan API Key 已清除', displayName),
            loggerName: `${displayName} Token Plan`
        });
    }
}
