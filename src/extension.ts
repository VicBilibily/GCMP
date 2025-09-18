// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { Logger } from './utils/logger';
import { ApiKeyManager, ConfigManager, KiloCodeVersionManager } from './utils';
import { registerAllTools } from './tools';

/**
 * 激活供应商 - 基于配置文件动态注册
 */
async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const configProvider = ConfigManager.getConfigProvider();

    // 更新 Kilo Code 版本缓存
    await KiloCodeVersionManager.updateVersionCache();

    // 获取动态的 kiloCode 头部配置
    const kiloCodeHeaders = await ConfigManager.getDynamicKiloCodeHeaders();

    if (!configProvider) {
        Logger.warn('未找到供应商配置，跳过供应商注册');
        return;
    }

    // 遍历配置中的每个供应商
    for (const [providerKey, providerConfig] of Object.entries(configProvider)) {
        try {
            Logger.trace(`正在注册供应商: ${providerConfig.displayName} (${providerKey})`);

            // 使用通用供应商创建实例
            GenericModelProvider.createAndActivate(
                context,
                providerKey,
                providerConfig,
                kiloCodeHeaders
            );

            Logger.info(`${providerConfig.displayName} 供应商注册成功`);
        } catch (error) {
            Logger.error(`注册供应商 ${providerKey} 失败:`, error);
        }
    }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器

        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.info(`🔧 GCMP 扩展模式: ${isDevelopment ? 'Development' : 'Production'}`);
        // 检查和提示VS Code的日志级别设置
        if (isDevelopment) { Logger.checkAndPromptLogLevel(); }

        Logger.info('开始激活 GCMP 扩展...');

        ApiKeyManager.initialize(context); // 初始化API密钥管理器

        // 初始化配置管理器并注册到context
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);

        // 初始化版本管理器
        KiloCodeVersionManager.initialize(context);

        // 激活供应商
        Logger.trace('正在注册模型提供者...');
        await activateProviders(context);

        // 注册工具
        Logger.trace('正在注册工具...');
        registerAllTools(context);

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
        KiloCodeVersionManager.dispose(); // 清理版本管理器
        Logger.info('GCMP 扩展停用完成');
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
