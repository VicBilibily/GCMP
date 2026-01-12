/*---------------------------------------------------------------------------------------------
 *  CLI 配置向导
 *  提供统一的交互式向导来配置 CLI 认证
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { CliAuthFactory } from './auth/cliAuthFactory';

interface CliCredentialStatus {
    hasCredentials: boolean;
    expiresAt?: number;
    isExpired?: boolean;
}

export class CliWizard {
    /**
     * 启动 CLI 配置向导
     * @param provider 提供商标识（如 'iflow', 'qwen' 等）
     * @param displayName 显示名称
     */
    static async startWizard(provider: string, displayName: string): Promise<void> {
        try {
            // 检查 CLI 凭证状态（是否存在、是否过期）
            const credentialStatus = await this.getCredentialStatus(provider);
            // 获取 CLI 显示名称
            const cliName = this.getCliName(provider);
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(sign-in) 登录 CLI',
                        description: this.formatCredentialStatus(credentialStatus),
                        detail: `通过 ${cliName} 进行 OAuth 认证登录`,
                        action: 'login'
                    },
                    {
                        label: '$(refresh) 刷新认证状态',
                        detail: `重新从 ${cliName} 加载认证凭证`,
                        action: 'refresh'
                    }
                ],
                {
                    title: `${displayName} 配置菜单`,
                    placeHolder: '选择要执行的操作'
                }
            );

            if (!choice) {
                Logger.debug('用户取消了 CLI 配置向导');
                return;
            }

            switch (choice.action) {
                case 'login':
                    await this.handleLogin(provider, displayName, provider);
                    break;
                case 'refresh':
                    await this.refreshAuth(provider, displayName);
                    break;
            }
        } catch (error) {
            Logger.error(`CLI 配置向导出错: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 获取 CLI 凭证状态（是否存在、是否过期）
     */
    private static async getCredentialStatus(providerKey: string): Promise<CliCredentialStatus> {
        const credentials = await CliAuthFactory.loadCredentials(providerKey);
        if (!credentials) {
            return { hasCredentials: false };
        }

        const expiresAt = credentials.expiry_date;
        if (!expiresAt || Number.isNaN(expiresAt)) {
            return { hasCredentials: true };
        }

        return { hasCredentials: true, expiresAt, isExpired: expiresAt <= Date.now() };
    }

    private static formatCredentialStatus(status: CliCredentialStatus): string {
        if (!status.hasCredentials) {
            return '未登录';
        }
        if (status.expiresAt === undefined) {
            return '已登录（有效期未知）';
        }
        return status.isExpired ? '已登录（已过期）' : '已登录';
    }

    /**
     * 获取 CLI 命令名称
     */
    private static getCliName(providerKey: string): string {
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const cliType = supportedCliTypes.find(cli => cli.id === providerKey);
        return cliType?.name || providerKey;
    }

    /**
     * 处理登录流程
     */
    private static async handleLogin(providerKey: string, displayName: string, cliCommand: string): Promise<void> {
        const status = await this.getCredentialStatus(providerKey);
        // 凭证已过期：无需二次确认，直接进入下一步提示
        if (status.hasCredentials && !status.isExpired) {
            const result = await vscode.window.showInformationMessage(
                `✅ ${displayName} 已登录\n是否要重新登录？`,
                '重新登录',
                '取消'
            );
            if (result !== '重新登录') {
                return;
            }
        }

        // 检查 CLI 是否已安装
        const isInstalled = await CliAuthFactory.isCliInstalled(providerKey);
        if (!isInstalled) {
            await vscode.window.showWarningMessage(`未检测到 ${cliCommand}，请先安装该 CLI 工具`, '确定');
            return;
        }

        const tipInfo = status.hasCredentials
            ? '在终端对话输入 /auth 后，选择 OAuth 认证重新登陆。'
            : '首次运行选择 OAuth 认证，然后完成浏览器中的登录流程。';
        // 提示用户在终端中运行 CLI 命令
        const result = await vscode.window.showInformationMessage(
            `请在终端中运行以下命令进行登录：\n\n${cliCommand}\n\n${tipInfo}`,
            { modal: true },
            '打开终端'
        );
        if (result === '打开终端') {
            // 打开集成终端
            const terminal = vscode.window.createTerminal(cliCommand);
            terminal.sendText(cliCommand);
            terminal.show();
        }
    }

    /**
     * 刷新认证状态
     */
    private static async refreshAuth(providerKey: string, displayName: string): Promise<void> {
        try {
            // 使用 ApiKeyManager 的强制刷新方法
            const success = await ApiKeyManager.forceRefreshCliAuth(providerKey, displayName);
            if (success) {
                const apiKey = await ApiKeyManager.getApiKey(providerKey);
                Logger.info(`[CliWizard] 已成功刷新 ${displayName} CLI 认证凭证`);
                if (apiKey) {
                    Logger.info(`[CliWizard] 使用的 API Key: ${apiKey.substring(0, 10)}...`);
                }
                await vscode.window.showInformationMessage(`已成功从 ${displayName} CLI 刷新认证凭证`, { modal: true });
            } else {
                const result = await vscode.window.showWarningMessage(
                    `无法从 ${displayName} CLI 获取认证凭证，请先登录或重新授权`,
                    { modal: true },
                    '打开终端'
                );
                if (result === '打开终端') {
                    // 打开集成终端
                    const terminal = vscode.window.createTerminal(providerKey);
                    terminal.sendText(providerKey);
                    terminal.show();
                }
            }
        } catch (error) {
            Logger.error('[CliWizard] 刷新认证失败:', error);
            await vscode.window.showErrorMessage(
                `刷新认证失败: ${error instanceof Error ? error.message : '未知错误'}`
            );
        }
    }
}
