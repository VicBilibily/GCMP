/*---------------------------------------------------------------------------------------------
 *  API密钥安全存储管理器
 *  使用 VS Code SecretStorage 安全管理 API密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyValidation } from '../types/sharedTypes';
import { Logger } from './logger';

/**
 * API密钥安全存储管理器
 * 支持多供应商模式
 */
export class ApiKeyManager {
    private static context: vscode.ExtensionContext;

    /**
     * 初始化API密钥管理器
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * 获取供应商的密钥存储键名
     */
    private static getSecretKey(vendor: string): string {
        return `${vendor}.apiKey`;
    }

    /**
     * 检查是否有API密钥
     */
    static async hasValidApiKey(vendor: string): Promise<boolean> {
        const secretKey = this.getSecretKey(vendor);
        const apiKey = await this.context.secrets.get(secretKey);
        return apiKey !== undefined && apiKey.trim().length > 0;
    }

    /**
     * 获取API密钥
     */
    static async getApiKey(vendor: string): Promise<string | undefined> {
        const secretKey = this.getSecretKey(vendor);
        return await this.context.secrets.get(secretKey);
    }

    /**
     * 验证API密钥
     */
    static validateApiKey(apiKey: string, _vendor: string): ApiKeyValidation {
        // 空值允许，用于清空密钥
        if (!apiKey || apiKey.trim().length === 0) {
            return { isValid: true, isEmpty: true };
        }

        // 不验证具体格式，只要不为空即为有效
        return { isValid: true };
    }

    /**
     * 设置API密钥到安全存储
     */
    static async setApiKey(vendor: string, apiKey: string): Promise<void> {
        const secretKey = this.getSecretKey(vendor);
        await this.context.secrets.store(secretKey, apiKey);
    }

    /**
     * 删除API密钥
     */
    static async deleteApiKey(vendor: string): Promise<void> {
        const secretKey = this.getSecretKey(vendor);
        await this.context.secrets.delete(secretKey);
    }

    /**
     * 确保有API密钥，如果没有则提示用户输入
     */
    static async ensureApiKey(vendor: string, displayName: string): Promise<void> {
        if (await this.hasValidApiKey(vendor)) {
            return;
        }

        // 直接触发对应的设置命令，让Provider处理具体配置
        const commandId = `gcmp.${vendor}.setApiKey`;
        await vscode.commands.executeCommand(commandId);

        // 验证设置后是否有效
        if (!(await this.hasValidApiKey(vendor))) {
            throw new Error(`需要 API密钥 才能使用 ${displayName} 模型`);
        }
    }

    /**
     * 通用API密钥输入和设置逻辑
     */
    static async promptAndSetApiKey(vendor: string, displayName: string, placeHolder: string): Promise<void> {
        const apiKey = await vscode.window.showInputBox({
            prompt: `请输入您的 ${displayName} API密钥（留空则清除密钥）`,
            password: true,
            placeHolder: placeHolder
        });

        if (apiKey !== undefined) {
            const validation = this.validateApiKey(apiKey, vendor);
            if (validation.isEmpty) {
                await this.deleteApiKey(vendor);
                vscode.window.showInformationMessage(`已清除 ${displayName} API密钥`);
            } else {
                await this.setApiKey(vendor, apiKey.trim());
                vscode.window.showInformationMessage(`已设置 ${displayName} API密钥`);
            }

            // API密钥更改后，相关组件会通过ConfigManager的配置监听器自动更新
            Logger.debug(`API密钥已更新: ${vendor}`);
        }
    }
}
