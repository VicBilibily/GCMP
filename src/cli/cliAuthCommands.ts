/*---------------------------------------------------------------------------------------------
 *  CLI 认证命令注册
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CliAuthFactory } from './auth/cliAuthFactory';

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
                placeHolder: '选择要认证的 CLI 工具'
            }
        );
        if (selected) {
            const credentials = await CliAuthFactory.ensureAuthenticated(selected.cliType);
            if (credentials) {
                vscode.window.showInformationMessage(`${selected.label} 认证成功！`);
            } else {
                vscode.window.showErrorMessage(`${selected.label} 认证失败，请先运行 CLI 登录`);
            }
        }
    });

    context.subscriptions.push(cliAuthCommand);
}
