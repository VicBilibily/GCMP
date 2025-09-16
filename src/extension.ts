// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { Logger } from './utils/logger';
import { ApiKeyManager, ConfigManager } from './utils';
import { registerAllTools } from './tools';
import { ApplyDiffCommands } from './tools/apply-diff-commands';
import { registerApplyDiffV2Demo, registerCreateTestDiff } from './tools/apply-diff-v2-demo';
import { registerDiagnosticCommands } from './tools/diagnostic';
import { registerEmptyLineTestCommand } from './tools/empty-line-test';
import { registerChatIntegrationTestCommands } from './tools/chat-integration-test';
import { registerChatIntegrationVerificationCommands } from './tools/chat-verification';
import { registerEditTrackingDebugCommands } from './tools/edit-tracking-debug';
import { registerChatResponseCommands } from './chat/chat-response-integrator';

/**
 * 激活供应商 - 基于配置文件动态注册
 */
function activateProviders(context: vscode.ExtensionContext): void {
    const configProvider = ConfigManager.getConfigProvider();
    const kiloCodeHeaders = ConfigManager.getKiloCodeHeaders();

    if (!configProvider) {
        Logger.warn('未找到供应商配置，跳过供应商注册');
        return;
    }

    // 遍历配置中的每个供应商
    for (const [providerKey, providerConfig] of Object.entries(configProvider)) {
        try {
            Logger.info(`正在注册供应商: ${providerConfig.displayName} (${providerKey})`);

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
export function activate(context: vscode.ExtensionContext) {
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

        // 激活供应商
        Logger.info('正在注册模型提供者...');
        activateProviders(context);

        // 注册工具
        Logger.info('正在注册工具...');
        registerAllTools(context);

        // 注册Apply Diff命令
        Logger.info('正在注册Apply Diff命令...');
        const applyDiffCommands = new ApplyDiffCommands();
        applyDiffCommands.registerCommands(context);

        // 注册Apply Diff V2演示命令
        Logger.info('正在注册Apply Diff V2演示命令...');
        registerApplyDiffV2Demo(context);
        registerCreateTestDiff(context);

        // 注册诊断命令
        Logger.info('正在注册诊断命令...');
        registerDiagnosticCommands(context);

        // 注册空行测试命令
        Logger.info('正在注册空行测试命令...');
        registerEmptyLineTestCommand(context);

        // 注册聊天集成测试命令
        Logger.info('正在注册聊天集成测试命令...');
        registerChatIntegrationTestCommands(context);

        // 注册聊天集成验证命令
        Logger.info('正在注册聊天集成验证命令...');
        registerChatIntegrationVerificationCommands(context);

        // 注册聊天响应命令
        Logger.info('正在注册聊天响应命令...');
        registerChatResponseCommands(context);

        // 注册编辑跟踪调试命令
        Logger.info('正在注册编辑跟踪调试命令...');
        registerEditTrackingDebugCommands(context);

        Logger.info('✅ GCMP 扩展激活完成 - 聊天响应文件修改跟踪已启用');
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
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
