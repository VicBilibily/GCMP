/*---------------------------------------------------------------------------------------------
 *  日志管理器
 *  将日志输出到VS Code的输出窗口
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 日志级别
 */
export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3
}

/**
 * 日志管理器类
 */
export class Logger {
    private static outputChannel: vscode.OutputChannel;
    private static currentLevel: LogLevel = LogLevel.INFO;

    /**
     * 初始化日志管理器
     */
    static initialize(channelName = 'GCMP'): void {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    /**
     * 设置日志级别
     */
    static setLevel(level: LogLevel): void {
        this.currentLevel = level;
    }

    /**
     * 格式化时间戳
     */
    private static getTimestamp(): string {
        const now = new Date();
        return now.toLocaleTimeString('zh-CN', { 
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            fractionalSecondDigits: 3
        });
    }

    /**
     * 输出日志
     */
    private static log(level: LogLevel, levelName: string, message: string, ...args: unknown[]): void {
        if (level < this.currentLevel || !this.outputChannel) {
            return;
        }

        const timestamp = this.getTimestamp();
        const formattedMessage = args.length > 0 
            ? `${message} ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ')}`
            : message;

        const logEntry = `[${timestamp}] [${levelName}] ${formattedMessage}`;
        
        // 输出到 VS Code 输出窗口
        this.outputChannel.appendLine(logEntry);
        
        // 同时输出到控制台
        console.log(logEntry);
        
        // 对于错误级别，同时显示输出窗口
        if (level === LogLevel.ERROR) {
            this.outputChannel.show(true);
        }
    }

    /**
     * Debug级别日志
     */
    static debug(message: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, 'DEBUG', message, ...args);
    }

    /**
     * Info级别日志
     */
    static info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, 'INFO', message, ...args);
    }

    /**
     * Warning级别日志
     */
    static warn(message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARN, 'WARN', message, ...args);
    }

    /**
     * Error级别日志
     */
    static error(message: string, ...args: unknown[]): void {
        this.log(LogLevel.ERROR, 'ERROR', message, ...args);
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