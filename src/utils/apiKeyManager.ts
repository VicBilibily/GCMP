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
    private static builtinProviders: Set<string> | null = null;

    /**
     * 初始化API密钥管理器
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * 获取内置供应商列表
     */
    private static async getBuiltinProviders(): Promise<Set<string>> {
        if (this.builtinProviders !== null) {
            return this.builtinProviders;
        }
        try {
            const { configProviders } = await import('../providers/config/index.js');
            this.builtinProviders = new Set(Object.keys(configProviders));
        } catch (error) {
            Logger.warn('无法获取内置供应商列表:', error);
            this.builtinProviders = new Set();
        }
        return this.builtinProviders;
    }

    /**
     * 获取供应商的密钥存储键名
     * 对于内置供应商，使用其原始键名
     * 对于自定义供应商，使用 provider 作为键名
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
     * 内置供应商：直接使用供应商名称作为键名
     * 自定义供应商：使用 provider 作为键名
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
     * @param vendor 供应商标识
     * @param displayName 显示名称
     * @param throwError 是否在检查失败时抛出错误，默认为 true
     * @returns 检查是否成功
     */
    static async ensureApiKey(vendor: string, displayName: string, throwError = true): Promise<boolean> {
        if (await this.hasValidApiKey(vendor)) {
            return true;
        }

        // 检查是否为内置供应商
        const builtinProviders = await this.getBuiltinProviders();
        if (builtinProviders.has(vendor)) {
            // 内置供应商：触发对应的设置命令，让Provider处理具体配置
            const commandId = `gcmp.${vendor}.setApiKey`;
            await vscode.commands.executeCommand(commandId);
        } else {
            // 自定义供应商：直接提示输入API密钥
            await this.promptAndSetApiKey(vendor, vendor, 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
        }

        // 验证设置后是否有效
        const isValid = await this.hasValidApiKey(vendor);
        if (!isValid && throwError) {
            throw new Error(`需要 API密钥 才能使用 ${displayName} 模型`);
        }
        return isValid;
    }

    /**
     * 处理 customHeader 中的 API 密钥替换
     * 将 ${APIKEY} 替换为实际的 API 密钥（不区分大小写）
     */
    static processCustomHeader(
        customHeader: Record<string, string> | undefined,
        apiKey: string
    ): Record<string, string> {
        if (!customHeader) {
            return {};
        }

        const processedHeader: Record<string, string> = {};
        for (const [key, value] of Object.entries(customHeader)) {
            // 不区分大小写地替换 ${APIKEY} 为实际的 API 密钥
            const processedValue = value.replace(/\$\{\s*APIKEY\s*\}/gi, apiKey);
            processedHeader[key] = processedValue;
        }
        return processedHeader;
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
