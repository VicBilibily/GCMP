// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ZhipuChatModelProvider } from './providers/zhipuProvider';
import { IFlowChatModelProvider } from './providers/iflowProvider';
import { MoonshotChatModelProvider } from './providers/moonshotProvider';
import { BaseModelProvider } from './providers/baseProvider';
import { Logger, LogLevel } from './utils/logger';
import { ApiKeyManager, ConfigManager } from './utils';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器
        // 根据是否为调试模式设置日志级别
        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.setLevel(isDevelopment ? LogLevel.DEBUG : LogLevel.INFO);

        Logger.info('开始激活 GCMP 扩展...');

        ApiKeyManager.initialize(context); // 初始化API密钥管理器

        // 初始化配置管理器并注册到context
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);

        // 激活各个模型提供者
        Logger.info('正在注册模型提供者...');
        BaseModelProvider.activate(context, ZhipuChatModelProvider); // 智谱AI
        BaseModelProvider.activate(context, MoonshotChatModelProvider); // MoonshotAI
        BaseModelProvider.activate(context, IFlowChatModelProvider); // 心流AI

        Logger.info('GCMP 扩展激活完成');

    } catch (error) {
        const errorMessage = `GCMP 扩展激活失败: ${error instanceof Error ? error.message : '未知错误'}`;
        Logger.error(errorMessage, error instanceof Error ? error : undefined);

        // 尝试显示用户友好的错误消息
        vscode.window.showErrorMessage('GCMP 扩展启动失败。请检查输出窗口获取详细信息。');

        // 重新抛出错误，让VS Code知道扩展启动失败
        throw error;
    }
}

// This method is called when your extension is deactivated
export function deactivate() {
    try {
        Logger.info('开始停用 GCMP 扩展...');
        ConfigManager.dispose(); // 清理配置管理器
        Logger.info('GCMP 扩展停用完成');
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        console.error('GCMP 扩展停用时出错:', error);
    }
}
