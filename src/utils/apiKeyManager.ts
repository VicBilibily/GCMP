/*---------------------------------------------------------------------------------------------
 *  API密钥安全存储管理器
 *  使用 VS Code SecretStorage 安全管理 API密钥
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyValidation } from '../types/sharedTypes';
import { Logger } from './logger';
import { StatusBarManager } from '../status';
import { configProviders } from '../providers/config';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';

/**
 * API密钥安全存储管理器
 * 支持多提供商模式
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
     * 获取内置提供商列表
     */
    private static async getBuiltinProviders(): Promise<Set<string>> {
        if (this.builtinProviders !== null) {
            return this.builtinProviders;
        }
        try {
            this.builtinProviders = new Set(Object.keys(configProviders));
        } catch (error) {
            Logger.warn('无法获取内置提供商列表:', error);
            this.builtinProviders = new Set();
        }
        return this.builtinProviders;
    }

    /**
     * 获取提供商的密钥存储键名
     * 对于内置提供商，使用其原始键名
     * 对于自定义提供商，使用 provider 作为键名
     */
    private static getSecretKey(provider: string): string {
        return `${provider}.apiKey`;
    }

    /**
     * 检查是否有API密钥
     */
    static async hasValidApiKey(provider: string): Promise<boolean> {
        const secretKey = this.getSecretKey(provider);
        const apiKey = await this.context.secrets.get(secretKey);
        return apiKey !== undefined && apiKey.trim().length > 0;
    }

    /**
     * 获取API密钥
     * 内置提供商：直接使用提供商名称作为键名
     * 自定义提供商：使用 provider 作为键名
     */
    static async getApiKey(provider: string): Promise<string | undefined> {
        const secretKey = this.getSecretKey(provider);
        return await this.context.secrets.get(secretKey);
    }

    /**
     * 验证API密钥
     */
    static validateApiKey(apiKey: string, _provider: string): ApiKeyValidation {
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
    static async setApiKey(provider: string, apiKey: string): Promise<void> {
        const secretKey = this.getSecretKey(provider);
        await this.context.secrets.store(secretKey, apiKey);
    }

    /**
     * 删除API密钥
     */
    static async deleteApiKey(provider: string): Promise<void> {
        const secretKey = this.getSecretKey(provider);
        await this.context.secrets.delete(secretKey);
    }

    /**
     * 确保有API密钥，如果没有则提示用户输入
     * @param provider 提供商标识
     * @param displayName 显示名称
     * @param throwError 是否在检查失败时抛出错误，默认为 true
     * @returns 检查是否成功
     */
    static async ensureApiKey(provider: string, displayName: string, throwError = true): Promise<boolean> {
        // 对于 CLI 认证提供商，需要特殊处理
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const cliAuthProviders = supportedCliTypes.map(cli => cli.id);
        if (cliAuthProviders.includes(provider)) {
            // CLI 提供商，从 CLI 加载
            return await this.handleCliAuth(provider, displayName);
        }

        // 对于非 CLI 认证提供商，使用原有逻辑
        if (await this.hasValidApiKey(provider)) {
            return true;
        }

        // 检查是否为内置提供商
        const builtinProviders = await this.getBuiltinProviders();
        if (builtinProviders.has(provider)) {
            // 内置提供商：触发对应的设置命令，让Provider处理具体配置
            const commandId = `gcmp.${provider}.setApiKey`;
            await vscode.commands.executeCommand(commandId);
        } else {
            // 自定义提供商：直接提示输入API密钥
            await this.promptAndSetApiKey(provider, provider, 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
        }

        // 验证设置后是否有效
        const isValid = await this.hasValidApiKey(provider);
        if (!isValid && throwError) {
            throw new Error(`需要 API密钥 才能使用 ${displayName} 模型`);
        }
        return isValid;
    }

    /**
     * 强制刷新 CLI 认证凭证
     * @param provider 提供商标识
     * @param displayName 显示名称
     * @returns 刷新是否成功
     */
    static async forceRefreshCliAuth(provider: string, displayName: string): Promise<boolean> {
        // 检查是否为 CLI 认证提供商
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const cliAuthProviders = supportedCliTypes.map(cli => cli.id);
        if (!cliAuthProviders.includes(provider)) {
            Logger.warn(`[ApiKeyManager] ${provider} 不是 CLI 认证提供商`);
            return false;
        }

        const apiKey = await CliAuthFactory.getInstance(provider)?.getApiKey(true);
        if (apiKey) {
            Logger.info(`[ApiKeyManager] 已强制刷新 ${displayName} CLI 认证`);
            return true;
        }
        Logger.warn(`[ApiKeyManager] 无法从 ${displayName} CLI 加载认证凭证`);
        return false;
    }

    /**
     * 处理 CLI 认证
     * @param provider 提供商标识
     * @param displayName 显示名称
     * @param throwError 是否在检查失败时抛出错误
     * @returns 认证是否成功
     */
    private static async handleCliAuth(provider: string, displayName: string): Promise<boolean> {
        const credentials = await CliAuthFactory.ensureAuthenticated(provider);
        if (credentials) {
            const apiKey = await CliAuthFactory.getInstance(provider)?.getApiKey();
            if (!apiKey) {
                Logger.warn(`[ApiKeyManager] ${displayName} CLI 加载认证凭证失败`);
                return false;
            }
            // Cli 访问密钥验证通过后保存到密钥存储
            await this.setApiKey(provider, apiKey);
            Logger.info(`[ApiKeyManager] 已从 ${displayName} CLI 加载认证凭证`);
            return true;
        }
        return false;
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
    static async promptAndSetApiKey(provider: string, displayName: string, placeHolder: string): Promise<void> {
        const apiKey = await vscode.window.showInputBox({
            prompt: `请输入您的 ${displayName} API密钥（留空则清除密钥）`,
            password: true,
            placeHolder: placeHolder
        });
        if (apiKey !== undefined) {
            const validation = this.validateApiKey(apiKey, provider);
            if (validation.isEmpty) {
                await this.deleteApiKey(provider);
                vscode.window.showInformationMessage(`已清除 ${displayName} API密钥`);
            } else {
                await this.setApiKey(provider, apiKey.trim());
                vscode.window.showInformationMessage(`已设置 ${displayName} API密钥`);
            }
            // API密钥更改后，相关组件会通过ConfigManager的配置监听器自动更新
            Logger.debug(`API密钥已更新: ${provider}`);

            // API密钥 设置后，更新状态栏
            if (provider === 'deepseek' || provider === 'moonshot') {
                try {
                    StatusBarManager.checkAndShowStatus(provider);
                } catch (error) {
                    Logger.warn('更新状态栏失败:', provider, error);
                }
            }
        }
    }
}
