/*---------------------------------------------------------------------------------------------
 *  CLI 配置向导
 *  提供统一的交互式向导来配置 CLI 认证
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { t } from '../utils/l10n';

interface CliCredentialStatus {
    hasCredentials: boolean;
    expiresAt?: number;
    isExpired?: boolean;
}

export class CliWizard {
    /**
     * 启动 CLI 配置向导
     * @param provider 提供商标识（如 'qwen', 'gemini', 'codex' 等）
     * @param displayName 显示名称
     */
    static async startWizard(provider: string, displayName: string): Promise<void> {
        try {
            // 检查 CLI 凭证状态（是否存在、是否过期）
            const credentialStatus = await this.getCredentialStatus(provider);
            // 获取 CLI 显示名称
            const cliName = this.getCliName(provider);

            const items: Array<vscode.QuickPickItem & { action: string }> = [
                {
                    label: t('$(sign-in) Sign in to CLI', '$(sign-in) 登录 CLI'),
                    description: this.formatCredentialStatus(credentialStatus),
                    detail: t('Sign in with OAuth through {0}', '通过 {0} 进行 OAuth 认证登录', cliName),
                    action: 'login'
                },
                {
                    label: t('$(refresh) Refresh authentication', '$(refresh) 刷新认证状态'),
                    detail: t('Reload credentials from {0}', '重新从 {0} 加载认证凭证', cliName),
                    action: 'refresh'
                }
            ];
            if (credentialStatus.hasCredentials) {
                items.push({
                    label: t('$(trash) Remove OAuth credentials', '$(trash) 移除 OAuth 认证凭证'),
                    detail: t(
                        'Open the credential file location and delete the credential manually',
                        '打开凭证文件所在位置，手动删除凭证'
                    ),
                    action: 'remove'
                });
            }

            // Codex 提供商支持手动刷新模型列表
            if (provider === 'codex') {
                items.push({
                    label: t('$(sync) Refresh model list', '$(sync) 刷新模型列表'),
                    detail: t('Re-fetch available models from the Codex API', '从 Codex API 重新获取可用模型列表'),
                    action: 'refreshModels'
                });
            }

            const choice = await vscode.window.showQuickPick(items, {
                title: t('{0} Configuration', '{0} 配置菜单', displayName),
                placeHolder: t('Choose an action to run', '选择要执行的操作')
            });
            if (!choice) {
                Logger.debug('User cancelled CLI configuration wizard');
                return;
            }

            switch (choice.action) {
                case 'login':
                    await this.handleLogin(provider, displayName, provider);
                    break;
                case 'refresh':
                    await this.refreshAuth(provider, displayName);
                    break;
                case 'remove':
                    await this.handleRemoveCredential(provider, displayName);
                    break;
                case 'refreshModels':
                    await vscode.commands.executeCommand('gcmp.codex.refreshModels');
                    break;
            }
        } catch (error) {
            Logger.error(
                `CLI configuration wizard failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
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
            return t('Not signed in', '未登录');
        }
        if (status.expiresAt === undefined) {
            return t('Signed in (expiration unknown)', '已登录（有效期未知）');
        }
        return status.isExpired ? t('Signed in (expired)', '已登录（已过期）') : t('Signed in', '已登录');
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
            const reloginLabel = t('Sign in again', '重新登录');
            const cancelLabel = t('Cancel', '取消');
            const result = await vscode.window.showInformationMessage(
                t('✅ {0} is already signed in.\nSign in again?', '✅ {0} 已登录\n是否要重新登录？', displayName),
                reloginLabel,
                cancelLabel
            );
            if (result !== reloginLabel) {
                return;
            }
        }

        // 检查 CLI 是否已安装
        const isInstalled = await CliAuthFactory.isCliInstalled(providerKey);
        if (!isInstalled) {
            await vscode.window.showWarningMessage(
                t(
                    '{0} was not detected. Please install this CLI first.',
                    '未检测到 {0}，请先安装该 CLI 工具。',
                    cliCommand
                )
            );
            return;
        }

        const tipInfo =
            status.hasCredentials ?
                t(
                    'In the terminal session, enter /auth and choose OAuth authentication to sign in again.',
                    '在终端对话输入 /auth 后，选择 OAuth 认证重新登录。'
                )
            :   t(
                    'On the first run, choose OAuth authentication and complete the browser sign-in flow.',
                    '首次运行请选择 OAuth 认证，然后完成浏览器中的登录流程。'
                );
        // 提示用户在终端中运行 CLI 命令
        const openTerminalLabel = t('Open Terminal', '打开终端');
        const result = await vscode.window.showInformationMessage(
            t(
                'Run the following command in a terminal to sign in:\n\n{0}\n\n{1}',
                '请在终端中运行以下命令进行登录：\n\n{0}\n\n{1}',
                cliCommand,
                tipInfo
            ),
            { modal: true },
            openTerminalLabel
        );
        if (result === openTerminalLabel) {
            // 打开集成终端
            const terminal = vscode.window.createTerminal(cliCommand);
            terminal.sendText(cliCommand);
            terminal.show();
        }
    }

    /**
     * 处理移除凭证：打开凭证文件所在目录，提示用户手动删除
     */
    private static async handleRemoveCredential(providerKey: string, displayName: string): Promise<void> {
        const credentialPath = CliAuthFactory.getCredentialPath(providerKey);
        if (!credentialPath) {
            await vscode.window.showErrorMessage(
                t('Failed to resolve the credential file path for {0}.', '无法获取 {0} 的凭证文件路径。', displayName)
            );
            return;
        }

        const fileName = path.basename(credentialPath);
        const openFolderLabel = t('Open Folder', '打开文件夹');
        const result = await vscode.window.showWarningMessage(
            t(
                'The credential directory will be opened in the file explorer:\n\n{0}\n\nDelete the credential file manually ({1}) to remove OAuth authentication.',
                '即将在资源管理器中打开凭证文件所在目录：\n\n{0}\n\n请手动删除凭证文件（{1}）以移除 OAuth 认证。',
                credentialPath,
                fileName
            ),
            { modal: true },
            openFolderLabel
        );
        if (result === openFolderLabel) {
            try {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(credentialPath));
            } catch {
                await vscode.window.showErrorMessage(
                    t('Failed to open the credential directory.', '无法打开凭证文件所在目录。')
                );
            }
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
                Logger.info(`[CliWizard] Refreshed ${displayName} CLI credentials successfully`);
                if (apiKey) {
                    Logger.info(`[CliWizard] Using API key: ${apiKey.substring(0, 10)}...`);
                }
                await vscode.window.showInformationMessage(
                    t(
                        'Successfully refreshed credentials from the {0} CLI.',
                        '已成功从 {0} CLI 刷新认证凭证。',
                        displayName
                    ),
                    { modal: true }
                );
            } else {
                const openTerminalLabel = t('Open Terminal', '打开终端');
                const result = await vscode.window.showWarningMessage(
                    t(
                        'Failed to load credentials from the {0} CLI. Sign in or reauthorize first.',
                        '无法从 {0} CLI 获取认证凭证，请先登录或重新授权。',
                        displayName
                    ),
                    { modal: true },
                    openTerminalLabel
                );
                if (result === openTerminalLabel) {
                    // 打开集成终端
                    const terminal = vscode.window.createTerminal(providerKey);
                    terminal.sendText(providerKey);
                    terminal.show();
                }
            }
        } catch (error) {
            Logger.error('[CliWizard] Failed to refresh auth:', error);
            await vscode.window.showErrorMessage(
                t(
                    'Failed to refresh authentication: {0}',
                    '刷新认证失败: {0}',
                    error instanceof Error ? error.message : t('Unknown error', '未知错误')
                )
            );
        }
    }
}
