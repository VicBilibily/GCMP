/*---------------------------------------------------------------------------------------------
 *  腾讯云配置向导
 *  提供交互式向导来配置付费模型、Coding Plan、Token Plan 和 DeepSeek 专用密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';

export class TencentWizard {
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
                        label: '$(key) 设置付费模型 API 密钥',
                        detail: '用于腾讯混元与腾讯云第三方大模型按量计费模型',
                        value: 'normal'
                    },
                    {
                        label: '$(key) 设置 Coding Plan 专用密钥',
                        detail: '用于腾讯云 Coding Plan 模型',
                        value: 'coding'
                    },
                    {
                        label: '$(key) 设置 Token Plan 专用密钥',
                        detail: '用于腾讯云 Token Plan 模型',
                        value: 'tokenPlan'
                    },
                    {
                        label: '$(key) 设置 DeepSeek 专用密钥',
                        detail: '用于腾讯云知识引擎原子能力 DeepSeek 模型',
                        value: 'deepseek'
                    },
                    {
                        label: '$(key) 设置 TokenHub 计费密钥',
                        detail: '用于腾讯云 TokenHub 按量付费模型',
                        value: 'tokenhub'
                    },
                    {
                        label: '$(check-all) 依次配置全部项目',
                        detail: '按顺序配置付费密钥、Coding Plan 密钥、Token Plan 密钥、DeepSeek 密钥和 TokenHub 密钥',
                        value: 'all'
                    }
                ],
                { title: `${displayName} 配置向导`, placeHolder: '请选择要配置的项目' }
            );
            if (!choice) {
                Logger.debug('用户取消了腾讯云配置向导');
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
            Logger.error(`腾讯云配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    static async setApiKey(apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: '请输入 腾讯云大模型 API Key（留空可清除）',
            title: '设置 腾讯云大模型 API Key',
            placeHolder: apiKeyTemplate,
            successMessage: '腾讯云大模型 API Key 已设置',
            clearMessage: '腾讯云大模型 API Key 已清除'
        });
    }

    static async setCodingPlanApiKey(codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_PLAN_KEY,
            prompt: '请输入 腾讯云 Coding Plan 专用 API Key（留空可清除）',
            title: '设置 腾讯云 Coding Plan 专用 API Key',
            placeHolder: codingKeyTemplate,
            successMessage: '腾讯云 Coding Plan 专用 API Key 已设置',
            clearMessage: '腾讯云 Coding Plan 专用 API Key 已清除'
        });
    }

    static async setTokenPlanApiKey(tokenPlanKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_PLAN_KEY,
            prompt: '请输入 腾讯云 Token Plan 专用 API Key（留空可清除）',
            title: '设置 腾讯云 Token Plan 专用 API Key',
            placeHolder: tokenPlanKeyTemplate,
            successMessage: '腾讯云 Token Plan 专用 API Key 已设置',
            clearMessage: '腾讯云 Token Plan 专用 API Key 已清除'
        });
    }

    static async setDeepSeekApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.DEEPSEEK_KEY,
            prompt: '请输入 腾讯云 DeepSeek 专用 API Key（留空可清除）',
            title: '设置 腾讯云 DeepSeek 专用 API Key',
            placeHolder: apiKeyTemplate,
            successMessage: '腾讯云 DeepSeek 专用 API Key 已设置',
            clearMessage: '腾讯云 DeepSeek 专用 API Key 已清除'
        });
    }

    static async setTokenHubApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKENHUB_KEY,
            prompt: '请输入 腾讯云 TokenHub API Key（留空可清除）',
            title: '设置 腾讯云 TokenHub API Key',
            placeHolder: apiKeyTemplate,
            successMessage: '腾讯云 TokenHub API Key 已设置',
            clearMessage: '腾讯云 TokenHub API Key 已清除'
        });
    }

    private static async promptForApiKey(options: {
        providerKey: string;
        prompt: string;
        title: string;
        placeHolder?: string;
        successMessage: string;
        clearMessage: string;
    }): Promise<boolean> {
        const result = await vscode.window.showInputBox({
            prompt: options.prompt,
            title: options.title,
            placeHolder: options.placeHolder,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return false;
        }

        try {
            if (result.trim() === '') {
                await ApiKeyManager.deleteApiKey(options.providerKey);
                vscode.window.showInformationMessage(options.clearMessage);
                return false;
            }

            await ApiKeyManager.setApiKey(options.providerKey, result.trim());
            vscode.window.showInformationMessage(options.successMessage);
            return true;
        } catch (error) {
            Logger.error(`腾讯云 API Key 操作失败: ${error instanceof Error ? error.message : '未知错误'}`);
            vscode.window.showErrorMessage(`设置失败: ${error instanceof Error ? error.message : '未知错误'}`);
            return false;
        }
    }
}
