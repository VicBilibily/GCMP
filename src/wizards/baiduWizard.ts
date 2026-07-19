/*-----------------------------------------------------------------
 * 百度千帆配置向导
 * 提供交互式向导来配置普通密钥和 Coding Plan 专用密钥
 *--------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import { StatusBarManager } from '../status';
import { BaseWizard } from './baseWizard';
export class BaiduWizard extends BaseWizard {
    private static readonly PROVIDER_KEY = 'baidu';
    private static readonly CODING_PLAN_KEY = 'baidu-coding';
    private static readonly TOKEN_KEY = 'baidu-token';
    private static readonly TOKEN_ENTERPRISE_KEY = 'baidu-token-enterprise';
    /**
     * 启动百度千帆配置向导
     * 允许用户选择配置哪种密钥类型
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
                        label: t('$(key) Set Token Plan API key', '$(key) 设置 Token Plan 专用密钥'),
                        detail: t(
                            'Used for Token Plan models (GLM-5.2, DeepSeek-V4, etc.)',
                            '用于 Token Plan 套餐模型（GLM-5.2、DeepSeek-V4 等）'
                        ),
                        value: 'token'
                    },
                    {
                        label: t('$(key) Set Token Plan Enterprise API key', '$(key) 设置 Token Plan 企业专用密钥'),
                        detail: t(
                            'Used for Token Plan Enterprise models (team subscription)',
                            '用于 Token Plan 企业套餐模型（团队订阅）'
                        ),
                        value: 'token-enterprise'
                    },
                    {
                        label: t('$(check-all) Set multiple keys', '$(check-all) 同时设置多种密钥'),
                        detail: t('Configure multiple key types in order', '按顺序配置多种密钥'),
                        value: 'multiple'
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
            if (choice.value === 'normal') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            } else if (choice.value === 'coding') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            } else if (choice.value === 'token') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
            } else if (choice.value === 'token-enterprise') {
                await this.setTokenEnterpriseApiKey(displayName, apiKeyTemplate);
            } else if (choice.value === 'multiple') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
                await this.setTokenEnterpriseApiKey(displayName, apiKeyTemplate);
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
    /**
     * 设置 Token Plan 专用密钥（个人）
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_KEY,
            prompt: t(
                'Enter the Token Plan API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan API key', '设置 {0} Token Plan 专用 API Key', displayName),
            placeHolder: tokenKeyTemplate,
            successMessage: t('{0} Token Plan API key set', '{0} Token Plan 专用 API Key 已设置', displayName),
            clearMessage: t('{0} Token Plan API key cleared', '{0} Token Plan 专用 API Key 已清除', displayName),
            loggerName: displayName
        });
        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('baidu');
    }
    /**
     * 设置 Token Plan 企业专用密钥
     */
    static async setTokenEnterpriseApiKey(displayName: string, tokenEnterpriseKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_ENTERPRISE_KEY,
            prompt: t(
                'Enter the Token Plan Enterprise API key for {0} (leave empty to clear)',
                '请输入 {0} 的 Token Plan 企业专用 API Key（留空可清除）',
                displayName
            ),
            title: t('Set {0} Token Plan Enterprise API key', '设置 {0} Token Plan 企业专用 API Key', displayName),
            placeHolder: tokenEnterpriseKeyTemplate,
            successMessage: t(
                '{0} Token Plan Enterprise API key set',
                '{0} Token Plan 企业专用 API Key 已设置',
                displayName
            ),
            clearMessage: t(
                '{0} Token Plan Enterprise API key cleared',
                '{0} Token Plan 企业专用 API Key 已清除',
                displayName
            ),
            loggerName: displayName
        });
        // 检查并显示状态栏
        await StatusBarManager.checkAndShowStatus('baidu');
    }
}
