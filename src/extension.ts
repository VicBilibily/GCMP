import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { IFlowProvider } from './providers/iflowProvider';
import { ModelScopeProvider } from './providers/modelscopeProvider';
import { Logger } from './utils/logger';
import { ApiKeyManager, ConfigManager } from './utils';
import { registerAllTools } from './tools';
import { registerInlineCompletionProvider } from './inlineCompletion/inlineCompletionProvider';
import { toggleEnabled } from './inlineCompletion/configuration';
import { StatusBarManager } from './inlineCompletion/statusBarManager';

/**
 * 全局变量 - 存储已注册的供应商实例，用于配置变更时的重新注册
 */
let registeredProviders: Record<string, GenericModelProvider | IFlowProvider | ModelScopeProvider> = {};
let registeredDisposables: vscode.Disposable[] = [];

/**
 * 激活供应商 - 基于配置文件动态注册（并行优化版本）
 */
async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const startTime = Date.now();
    const configProvider = ConfigManager.getConfigProvider();

    if (!configProvider) {
        Logger.warn('未找到供应商配置，跳过供应商注册');
        return;
    }

    Logger.info(`⏱️ 开始并行注册 ${Object.keys(configProvider).length} 个供应商...`);

    // 并行注册所有供应商以提升性能
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`正在注册供应商: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

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

            const providerTime = Date.now() - providerStartTime;
            Logger.info(`✅ ${providerConfig.displayName} 供应商注册成功 (耗时: ${providerTime}ms)`);

            return { providerKey, provider, disposables };
        } catch (error) {
            Logger.error(`❌ 注册供应商 ${providerKey} 失败:`, error);
            return null;
        }
    });

    // 等待所有供应商注册完成
    const results = await Promise.all(registrationPromises);

    // 收集成功注册的供应商
    for (const result of results) {
        if (result) {
            registeredProviders[result.providerKey] = result.provider;
            registeredDisposables.push(...result.disposables);
        }
    }

    const totalTime = Date.now() - startTime;
    const successCount = results.filter(r => r !== null).length;
    Logger.info(`⏱️ 供应商注册完成: ${successCount}/${Object.keys(configProvider).length} 个成功 (总耗时: ${totalTime}ms)`);
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
    const activationStartTime = Date.now();

    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器

        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.info(`🔧 GCMP 扩展模式: ${isDevelopment ? 'Development' : 'Production'}`);
        // 检查和提示VS Code的日志级别设置
        if (isDevelopment) {
            Logger.checkAndPromptLogLevel();
        }

        Logger.info('⏱️ 开始激活 GCMP 扩展...');

        // 步骤1: 初始化API密钥管理器
        let stepStartTime = Date.now();
        ApiKeyManager.initialize(context);
        Logger.trace(`⏱️ API密钥管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤2: 初始化配置管理器
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);
        Logger.trace(`⏱️ 配置管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤3: 激活供应商（并行优化）
        stepStartTime = Date.now();
        await activateProviders(context);
        Logger.trace(`⏱️ 模型提供者注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤4: 注册工具
        stepStartTime = Date.now();
        registerAllTools(context);
        Logger.trace(`⏱️ 工具注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤5: 注册内联代码补全功能
        stepStartTime = Date.now();
        registerInlineCompletionProvider(context);
        Logger.trace(`⏱️ 内联代码补全功能注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤6: 初始化状态栏管理器
        stepStartTime = Date.now();
        const statusBarManager = StatusBarManager.getInstance();
        const configListener = statusBarManager.registerConfigChangeListener();
        context.subscriptions.push(statusBarManager, configListener);
        Logger.trace(`⏱️ 状态栏管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 注册内联补全切换命令
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.inlineCompletion.toggle', toggleEnabled),
            vscode.commands.registerCommand('gcmp.toggleInlineCompletion', () => {
                statusBarManager.toggleStatus();
            })
        );

        // 监听配置变更，特别是 editToolMode
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
        });
        context.subscriptions.push(configChangeDisposable);

        const totalActivationTime = Date.now() - activationStartTime;
        Logger.info(`✅ GCMP 扩展激活完成 (总耗时: ${totalActivationTime}ms)`);
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
        StatusBarManager.getInstance()?.dispose(); // 清理状态栏管理器
        Logger.info('GCMP 扩展停用完成');
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
