/*---------------------------------------------------------------------------------------------
 *  CLI 认证命令注册
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { t } from '../utils/l10n';

/**
 * 注册 CLI 认证命令
 */
export function registerCliAuthCommands(context: vscode.ExtensionContext): void {
    const cliAuthCommand = vscode.commands.registerCommand('gcmp.cli.auth', async () => {
        const cliTypes = CliAuthFactory.getSupportedCliTypes();

        const selected = await vscode.window.showQuickPick(
            cliTypes.map(cli => ({
                label: cli.name,
                cliType: cli.id
            })),
            {
                placeHolder: t('Select the CLI tool to authenticate', '选择要认证的 CLI 工具')
            }
        );
        if (selected) {
            const credentials = await CliAuthFactory.ensureAuthenticated(selected.cliType);
            if (credentials) {
                vscode.window.showInformationMessage(
                    t('{0} authenticated successfully.', '{0} 认证成功。', selected.label)
                );
            } else {
                vscode.window.showErrorMessage(
                    t(
                        '{0} authentication failed. Run the CLI sign-in flow first.',
                        '{0} 认证失败，请先运行 CLI 登录。',
                        selected.label
                    )
                );
            }
        }
    });

    context.subscriptions.push(cliAuthCommand);
}
