/*-----------------------------------------------------------------
 * 百度千帆配置向导
 * 提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';
import { StatusBarManager } from '../status';
import { BaseWizard } from './baseWizard';
export class BaiduWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'baidu';
    private static readonly CODING_PLAN_KEY = 'baidu-coding';
    /**
     * 启动百度千帆配置向导
     * 允许用户选择配置哪种密钥类型
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: t('$(key) Set standard API key', '$(key) 设置普通 API 密钥'),
                        detail: t(
                            'Used for pay-as-you-go models (ERNIE-5.0, GLM-5, etc.)',
                            '用于按量计费模型（ERNIE-5.0、GLM-5 等）'
                        ),
                        value: 'normal'
                    },
                    {
                        label: t('$(key) Set Coding Plan API key', '$(key) 设置 Coding Plan 专用密钥'),
                        detail: t('Used for Coding Plan models', '用于 Coding Plan 编程套餐模型'),
                        value: 'coding'
                    },
                    {
                        label: t('$(check-all) Set both keys', '$(check-all) 同时设置两种密钥'),
                        detail: t(
                            'Configure the standard key and Coding Plan key in order',
                            '按顺序配置普通密钥和 Coding Plan 密钥'
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
                Logger.debug('User cancelled Baidu Qianfan config wizard');
                return;
            }
            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }
            if (choice.value === 'coding' || choice.value === 'both') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(
                `Baidu Qianfan config wizard failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
        }
    }
    /**
     * 设置普通 API 密钥
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: t(
                'Enter the standard API key for {0} (leave empty to clear)',
                '请输入 {0} 的普通 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} standard API key', '设置 {0} 普通 API Key', displayName),
            placeHolder: apiKeyTemplate,
            successMessage: t('{0} standard API key set', '{0} 普通 API Key 已设置', displayName),
            clearMessage: t('{0} standard API key cleared', '{0} 普通 API Key 已清除', displayName),
            loggerName: displayName
        });
    }
    /**
     * 设置 Coding Plan 专用密钥
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_PLAN_KEY,
            prompt: t(
                'Enter the Coding Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Coding Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Coding Plan API key', '设置 {0} Coding Plan 专用 API Key', displayName),
            placeHolder: codingKeyTemplate,
            successMessage: t('{0} Coding Plan API key set', '{0} Coding Plan 专用 API Key 已设置', displayName),
            clearMessage: t('{0} Coding Plan API key cleared', '{0} Coding Plan 专用 API Key 已清除', displayName),
            loggerName: displayName
        });
        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('baidu');
    }
}
