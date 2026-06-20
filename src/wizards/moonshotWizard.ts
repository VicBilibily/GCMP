/*---------------------------------------------------------------------------------------------
 *  MoonshotAI 配置向导
 *  提供交互式向导来配置 Moonshot 密钥和 Kimi For Coding 专用密钥
 *--------------------------------------------------------------------------------------------*/

// cSpell:ignore kimi
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';
import { StatusBarManager } from '../status';
import { BaseWizard } from './baseWizard';

export class MoonshotWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'moonshot';
    private static readonly KIMI_KEY = 'kimi';

    /**
     * 启动 MoonshotAI 配置向导
     * 允许用户选择配置哪种密钥类型
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set Moonshot API key', '$(key) 设置 Moonshot API 密钥'),
                        detail: t(
                            'Used to call paid Kimi-K2 models on the Moonshot AI platform',
                            '用于 Moonshot AI 开放平台调用 Kimi-K2 系列付费模型的 API 密钥'
                        ),
                        value: 'moonshot'
                    },
                    {
                        label: t('$(key) Set Kimi For Coding API key', '$(key) 设置 Kimi For Coding 专用密钥'),
                        detail: t(
                            'Used for Kimi membership benefits tailored to coding scenarios',
                            '用于 Kimi 会员计划中面向代码开发场景提供的增值会员权益的专用密钥'
                        ),
                        value: 'kimi'
                    },
                    {
                        label: t('$(check-all) Set both keys', '$(check-all) 同时设置两种密钥'),
                        detail: t(
                            'Configure the Moonshot API key and Kimi For Coding API key in order',
                            '按顺序配置 Moonshot API 密钥和 Kimi For Coding 专用密钥'
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
                Logger.debug('User cancelled MoonshotAI config wizard');
                return;
            }

            if (choice.value === 'moonshot' || choice.value === 'both') {
                await this.setMoonshotApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'kimi' || choice.value === 'both') {
                await this.setKimiApiKey(displayName, codingKeyTemplate);
            }
        } catch (error) {
            Logger.error(
                `MoonshotAI config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }

    /**
     * 设置 Moonshot API 密钥
     */
    static async setMoonshotApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: t(
                'Enter the API key for {0} (leave empty to clear)',
                '请输入 {0} 的 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} API key', '设置 {0} API Key', displayName),
            placeHolder: apiKeyTemplate,
            successMessage: t('{0} API key set', '{0} API Key 已设置', displayName),
            clearMessage: t('{0} API key cleared', '{0} API Key 已清除', displayName),
            loggerName: displayName
        });
        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('moonshot');
    }

    /**
     * 设置 Kimi For Coding 专用密钥
     */
    static async setKimiApiKey(_displayName: string, codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.KIMI_KEY,
            prompt: t(
                'Enter the Kimi For Coding API key (leave empty to clear)',
                '请输入 Kimi For Coding 专用 API Key(留空可清除)'
            ),
            title: t('Set Kimi For Coding API key', '设置 Kimi For Coding 专用 API Key'),
            placeHolder: codingKeyTemplate,
            successMessage: t('Kimi For Coding API key set', 'Kimi For Coding 专用 API Key 已设置'),
            clearMessage: t('Kimi For Coding API key cleared', 'Kimi For Coding 专用 API Key 已清除'),
            loggerName: 'Kimi For Coding'
        });
        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('kimi');
    }
}
