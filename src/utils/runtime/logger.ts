/*---------------------------------------------------------------------------------------------
 *  日志管理器
 *  将日志输出到VS Code的输出窗口
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { t } from './l10n';

/**
 * 日志管理器类 - 直接使用VS Code的LogLevel和LogOutputChannel
 */
export class Logger {
    private static outputChannel: vscode.LogOutputChannel;

    /**
     * 初始化日志管理器
     */
    static initialize(channelName = 'GCMP'): void {
        // 使用LogOutputChannel (VS Code 1.74+)，支持原生的日志级别和格式化
        this.outputChannel = vscode.window.createOutputChannel(channelName, { log: true });
    }

    /**
     * 检查和提示VS Code日志级别设置
     */
    static checkAndPromptLogLevel(): void {
        if (!this.outputChannel) {
            return;
        }

        const channelLevel = this.outputChannel.logLevel;
        const envLevel = vscode.env.logLevel;

        Logger.info('VS Code log level status:');
        Logger.info(`  - Output channel level: ${vscode.LogLevel[channelLevel]} (${channelLevel})`);
        Logger.info(`  - Editor environment level: ${vscode.LogLevel[envLevel]} (${envLevel})`);

        // 如果日志级别高于Debug，提示用户
        if (channelLevel > vscode.LogLevel.Debug) {
            Logger.warn(
                `Current VS Code log level is ${vscode.LogLevel[channelLevel]}; detailed debug information may not be shown`
            );
            Logger.info('To view detailed debug logs, run "Developer: Set Log Level" and choose "Debug"');

            const setLogLevelAction = t('Set log level', '设置日志级别');
            const ignoreAction = t('Ignore', '忽略');

            // 显示通知
            vscode.window
                .showInformationMessage(
                    t(
                        'GCMP: Current VS Code log level is {0}',
                        'GCMP: 当前VS Code日志级别为 {0}',
                        vscode.LogLevel[channelLevel]
                    ),
                    setLogLevelAction,
                    ignoreAction
                )
                .then(selection => {
                    if (selection === setLogLevelAction) {
                        vscode.commands.executeCommand('workbench.action.setLogLevel');
                    }
                });
        } else {
            Logger.info(
                `VS Code log level is set to ${vscode.LogLevel[channelLevel]}; detailed debug logs are available`
            );
        }
    }

    /**
     * Trace级别日志 (VS Code LogLevel.Trace = 1)
     */
    static trace(message: string, ...args: unknown[]): void {
        if (this.outputChannel) {
            this.outputChannel.trace(message, ...args);
        }
    }

    /**
     * Debug级别日志 (VS Code LogLevel.Debug = 2)
     */
    static debug(message: string, ...args: unknown[]): void {
        if (this.outputChannel) {
            this.outputChannel.debug(message, ...args);
        }
    }

    /**
     * Info级别日志 (VS Code LogLevel.Info = 3)
     */
    static info(message: string, ...args: unknown[]): void {
        if (this.outputChannel) {
            this.outputChannel.info(message, ...args);
        }
    }

    /**
     * Warning级别日志 (VS Code LogLevel.Warning = 4)
     */
    static warn(message: string, ...args: unknown[]): void {
        if (this.outputChannel) {
            this.outputChannel.warn(message, ...args);
        }
    }

    /**
     * Error级别日志 (VS Code LogLevel.Error = 5)
     */
    static error(message: string | Error, ...args: unknown[]): void {
        if (this.outputChannel) {
            this.outputChannel.error(message, ...args);
        }
    }

    /**
     * 销毁日志管理器
     */
    static dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
    }
}
