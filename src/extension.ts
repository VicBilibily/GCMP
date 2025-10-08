import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { IFlowProvider } from './providers/iflowProvider';
import { ModelScopeProvider } from './providers/modelscopeProvider';
import { ZhipuInlineCompletionProvider } from './providers/zhipuInlineCompletionProvider';
import { InlineCompletionFactory } from './providers/inlineCompletionFactory';
import { Logger } from './utils/logger';
import { ApiKeyManager, ConfigManager } from './utils';
import { registerAllTools } from './tools';

/**
 * 全局变量 - 存储已注册的供应商实例，用于配置变更时的重新注册
 */
let registeredProviders: Record<string, GenericModelProvider | IFlowProvider | ModelScopeProvider> = {};
let registeredDisposables: vscode.Disposable[] = [];
// 单独跟踪内联补全提供者的 disposable，便于动态注册/注销
let inlineCompletionDisposable: vscode.Disposable | null = null;

/**
 * 激活供应商 - 基于配置文件动态注册
 */
async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const configProvider = ConfigManager.getConfigProvider();

    if (!configProvider) {
        Logger.warn('未找到供应商配置，跳过供应商注册');
        return;
    }

    // 遍历配置中的每个供应商
    for (const [providerKey, providerConfig] of Object.entries(configProvider)) {
        try {
            Logger.trace(`正在注册供应商: ${providerConfig.displayName} (${providerKey})`);

            let provider: GenericModelProvider | IFlowProvider | ModelScopeProvider;
            let disposables: vscode.Disposable[];

            // 对 iflow 使用专门的 provider
            if (providerKey === 'iflow') {
                const result = IFlowProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'modelscope') {
                // 对 modelscope 使用专门的 provider（自定义流处理）
                const result = ModelScopeProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else {
                // 其他供应商使用通用 provider
                const result = GenericModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            }

            registeredProviders[providerKey] = provider;
            registeredDisposables.push(...disposables);

            Logger.info(`${providerConfig.displayName} 供应商注册成功`);
        } catch (error) {
            Logger.error(`注册供应商 ${providerKey} 失败:`, error);
        }
    }
}

/**
 * 重新注册所有供应商 - 用于配置变更后的刷新
 */
async function reRegisterProviders(context: vscode.ExtensionContext): Promise<void> {
    Logger.info('开始重新注册所有供应商...');

    // 清理现有的 disposables
    registeredDisposables.forEach(disposable => disposable.dispose());
    registeredDisposables = [];
    registeredProviders = {};

    // 重新激活供应商
    await activateProviders(context);

    Logger.info('供应商重新注册完成');
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器

        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.info(`🔧 GCMP 扩展模式: ${isDevelopment ? 'Development' : 'Production'}`);
        // 检查和提示VS Code的日志级别设置
        if (isDevelopment) {
            Logger.checkAndPromptLogLevel();
        }

        Logger.info('开始激活 GCMP 扩展...');

        ApiKeyManager.initialize(context); // 初始化API密钥管理器

        // 初始化配置管理器并注册到context
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);

        // 激活供应商
        Logger.trace('正在注册模型提供者...');
        await activateProviders(context);

        // 注册工具
        Logger.trace('正在注册工具...');
        registerAllTools(context);

        // 注册智谱AI内联代码补全提供者（可动态开关）
        Logger.trace('准备注册智谱AI内联代码补全提供者（按配置）...');
        const initInlineProvider = () => {
            // 先清理已有的
            if (inlineCompletionDisposable) {
                try {
                    inlineCompletionDisposable.dispose();
                } catch {
                    /* ignore */
                }
                inlineCompletionDisposable = null;
            }
            const enabled = vscode.workspace.getConfiguration('gcmp').get<boolean>('inlineCompletion.enabled', false);
            if (enabled) {
                // 使用新的通用内联补全工厂
                inlineCompletionDisposable = InlineCompletionFactory.createAndActivate(context);
                // 如果新的工厂失败，回退到旧的智谱实现
                if (!inlineCompletionDisposable) {
                    Logger.warn('通用内联补全创建失败，回退到智谱AI实现');
                    inlineCompletionDisposable = ZhipuInlineCompletionProvider.createAndActivate(context);
                }
                if (inlineCompletionDisposable) {
                    context.subscriptions.push(inlineCompletionDisposable);
                }
            }
        };
        initInlineProvider();

        // 状态栏控件：内联补全开关与设置快捷入口
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        const updateStatusBar = () => {
            const enabled = vscode.workspace.getConfiguration('gcmp').get<boolean>('inlineCompletion.enabled', false);
            statusBarItem.text = enabled ? '$(keybindings-sort) GCMP' : '$(keyboard) GCMP';
            statusBarItem.tooltip = enabled ? '智谱AI 内联建议：已启用' : '智谱AI 内联建议：已禁用';
            statusBarItem.command = 'gcmp.inlineCompletion.toggle';
            // 当禁用时使用灰色 logo，启用时恢复默认颜色（由主题决定）
            statusBarItem.color = enabled ? undefined : '#888888';
            statusBarItem.show();
        };
        updateStatusBar();
        context.subscriptions.push(statusBarItem);
        // 命令：切换内联补全
        const toggleCmd = vscode.commands.registerCommand('gcmp.inlineCompletion.toggle', async () => {
            const config = vscode.workspace.getConfiguration('gcmp');
            const current = config.get<boolean>('inlineCompletion.enabled', false);
            await config.update('inlineCompletion.enabled', !current, vscode.ConfigurationTarget.Global);
            updateStatusBar();
        });
        context.subscriptions.push(toggleCmd);

        // 监听配置变更，特别是 editToolMode 和 inlineCompletion.enabled
        const configChangeDisposable = vscode.workspace.onDidChangeConfiguration(async event => {
            if (event.affectsConfiguration('gcmp.editToolMode')) {
                Logger.info('检测到 editToolMode 配置变更，正在重新注册所有供应商...');
                try {
                    // 重新注册所有供应商以应用新的配置
                    await reRegisterProviders(context);
                    Logger.info('供应商重新注册成功');

                    // 显示成功通知
                    vscode.window.showInformationMessage('编辑工具模式已更新，所有模型提供商已刷新。');
                } catch (error) {
                    Logger.error('重新注册供应商失败:', error);
                    vscode.window.showErrorMessage('编辑工具模式更新失败，请重新加载窗口。');
                }
            }

            // 动态处理内联补全开关
            if (event.affectsConfiguration('gcmp.inlineCompletion.enabled')) {
                Logger.info('检测到 inlineCompletion.enabled 配置变更');
                try {
                    initInlineProvider();
                } catch (error) {
                    Logger.error('更新内联补全提供者失败:', error);
                }
            }
        });
        context.subscriptions.push(configChangeDisposable);

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

        // 清理所有已注册供应商的资源
        for (const [providerKey, provider] of Object.entries(registeredProviders)) {
            try {
                if (typeof provider.dispose === 'function') {
                    provider.dispose();
                    Logger.trace(`已清理供应商 ${providerKey} 的资源`);
                }
            } catch (error) {
                Logger.warn(`清理供应商 ${providerKey} 资源时出错:`, error);
            }
        }

        ConfigManager.dispose(); // 清理配置管理器
        Logger.info('GCMP 扩展停用完成');
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
