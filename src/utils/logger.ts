/*---------------------------------------------------------------------------------------------
 *  日志管理器
 *  将日志输出到VS Code的输出窗口
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

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

        Logger.info('📊 VS Code日志级别状态:');
        Logger.info(`  - 输出通道级别: ${vscode.LogLevel[channelLevel]} (${channelLevel})`);
        Logger.info(`  - 编辑器环境级别: ${vscode.LogLevel[envLevel]} (${envLevel})`);

        // 如果日志级别高于Debug，提示用户
        if (channelLevel > vscode.LogLevel.Debug) {
            Logger.warn(`⚠️ 当前VS Code日志级别为 ${vscode.LogLevel[channelLevel]}，可能不会显示详细调试信息`);
            Logger.info('💡 如需查看详细调试日志，请执行命令: "Developer: Set Log Level" → 选择 "Debug"');

            // 显示通知
            vscode.window.showInformationMessage(
                `GCMP: 当前VS Code日志级别为 ${vscode.LogLevel[channelLevel]}`,
                '设置日志级别',
                '忽略'
            ).then(selection => {
                if (selection === '设置日志级别') {
                    vscode.commands.executeCommand('workbench.action.setLogLevel');
                }
            });
        } else {
            Logger.info(`✅ VS Code日志级别已设置为 ${vscode.LogLevel[channelLevel]}，可以查看详细调试信息`);
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
            // 对于错误级别，显示输出窗口
            this.outputChannel.show(true);
        }
    }

    /**
     * 显示输出窗口
     */
    static show(): void {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }

    /**
     * 清空日志
     */
    static clear(): void {
        if (this.outputChannel) {
            this.outputChannel.clear();
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
