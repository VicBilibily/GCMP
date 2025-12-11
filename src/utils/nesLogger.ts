/*---------------------------------------------------------------------------------------------
 *  高频状态日志管理器
 *  专用于 primaryInstanceManager 等
 *  高频状态刷新模块的日志输出，与主日志通道分离
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 高频状态日志管理器类
 * 用于记录 NES (Next Edit Suggestions) 高频操作的日志
 */
export class NESLogger {
    private static outputChannel: vscode.LogOutputChannel;

    /**
     * 初始化高频状态日志管理器
     */
    static initialize(channelName = 'GCMP-NES'): void {
        // 使用LogOutputChannel (VS Code 1.74+)，支持原生的日志级别和格式化
        this.outputChannel = vscode.window.createOutputChannel(channelName, { log: true });
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
