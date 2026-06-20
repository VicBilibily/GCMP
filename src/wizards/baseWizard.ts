/*---------------------------------------------------------------------------------------------
 *  配置向导基类
 *  提供统一的 API Key 输入、保存、清除逻辑，供各专用 Wizard 继承复用
 *  参考：TencentWizard.promptForApiKey（原已抽取的样本）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { t } from '../utils/l10n';

/**
 * API Key 输入提示的选项
 */
export interface ApiKeyPromptOptions {
    /** 密钥存储用的 provider key */
    providerKey: string;
    /** InputBox 的 prompt 文本 */
    prompt: string;
    /** InputBox 的 title */
    title: string;
    /** InputBox 的占位符（可选） */
    placeHolder?: string;
    /** 设置成功时显示的消息 */
    successMessage: string;
    /** 清除成功时显示的消息 */
    clearMessage: string;
    /** 日志中用于标识的名称（可选，默认用 providerKey） */
    loggerName?: string;
}

/**
 * 配置向导基类
 * 各专用 Wizard 继承本类，通过 promptForApiKey 统一处理 API Key 的输入、保存与清除
 */
export abstract class BaseWizard {
    /**
     * 弹出 InputBox 让用户输入 API Key，并保存或清除
     * @param options 输入提示选项
     * @returns true 表示已设置新值；false 表示用户取消或清除了密钥
     */
    protected static async promptForApiKey(options: ApiKeyPromptOptions): Promise<boolean> {
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

        const logName = options.loggerName || options.providerKey;

        try {
            if (result.trim() === '') {
                Logger.info(`${logName} API key cleared`);
                await ApiKeyManager.deleteApiKey(options.providerKey);
                vscode.window.showInformationMessage(options.clearMessage);
                return false;
            }

            await ApiKeyManager.setApiKey(options.providerKey, result.trim());
            Logger.info(`${logName} API key set`);
            vscode.window.showInformationMessage(options.successMessage);
            return true;
        } catch (error) {
            Logger.error(
                `${logName} API key operation failed: ${error instanceof Error ? error.message : t('Unknown error', '未知错误')}`
            );
            vscode.window.showErrorMessage(
                t(
                    'Failed to save the API key: {0}',
                    '设置失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
            return false;
        }
    }
}
