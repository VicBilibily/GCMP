import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { ZhipuProvider } from './providers/zhipuProvider';
import { MoonshotProvider } from './providers/moonshotProvider';
import { CliModelProvider } from './cli/cliModelProvider';
import { MiniMaxProvider } from './providers/minimaxProvider';
import { CompatibleProvider } from './providers/compatibleProvider';
import { InlineCompletionShim } from './copilot/inlineCompletionShim';
import { Logger, StatusLogger, CompletionLogger, TokenCounter } from './utils';
import { ApiKeyManager, ConfigManager, JsonSchemaProvider } from './utils';
import { registerCliAuthCommands } from './cli/cliAuthCommands';
import { TokenUsagesManager } from './usages/usagesManager';
import { TokenUsagesView } from './ui/usagesView';
import { CompatibleModelManager } from './utils/compatibleModelManager';
import { LeaderElectionService, StatusBarManager } from './status';
import { registerAllTools } from './tools';
import { CliAuthFactory } from './cli/auth/cliAuthFactory';
import { registerCommitCommands } from './commit';

/**
 * 全局变量 - 存储已注册的提供商实例，用于扩展卸载时的清理
 */
const registeredProviders: Record<
    string,
    GenericModelProvider | ZhipuProvider | MoonshotProvider | CliModelProvider | MiniMaxProvider | CompatibleProvider
> = {};
const registeredDisposables: vscode.Disposable[] = [];

// 内联补全提供商实例（使用轻量级 Shim，延迟加载真正的补全引擎）
let inlineCompletionProvider: InlineCompletionShim | undefined;

/**
 * 激活提供商 - 基于配置文件动态注册（并行优化版本）
 */
async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const startTime = Date.now();
    const configProvider = ConfigManager.getConfigProvider();

    if (!configProvider) {
        Logger.warn('未找到提供商配置，跳过提供商注册');
        return;
    }

    // 设置扩展路径（用于 tokenizer 初始化）
    TokenCounter.setExtensionPath(context.extensionPath);

    Logger.info(`⏱️ 开始并行注册 ${Object.keys(configProvider).length} 个提供商...`);

    // CLI 认证提供商列表（从 CliAuthFactory 获取）
    const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
    const cliAuthProviders = supportedCliTypes.map(cli => cli.id);

    // 并行注册所有提供商以提升性能
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`正在注册提供商: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

            let provider: GenericModelProvider | ZhipuProvider | MoonshotProvider | CliModelProvider | MiniMaxProvider;
            let disposables: vscode.Disposable[];

            if (providerKey === 'zhipu') {
                // 对 zhipu 使用专门的 provider（配置向导功能）
                const result = ZhipuProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'moonshot') {
                // 对 moonshot 使用专门的 provider（多密钥管理和配置向导）
                const result = MoonshotProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (cliAuthProviders.includes(providerKey)) {
                // 对 CLI 认证提供商使用通用的 CLI provider
                const result = CliModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'minimax') {
                // 对 minimax 使用专门的 provider（多密钥管理和配置向导）
                const result = MiniMaxProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else {
                // 其他提供商使用通用 provider（支持基于 sdkMode 的自动选择）
                const result = GenericModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            }

            const providerTime = Date.now() - providerStartTime;
            Logger.info(`✅ ${providerConfig.displayName} 提供商注册成功 (耗时: ${providerTime}ms)`);
            return { providerKey, provider, disposables };
        } catch (error) {
            Logger.error(`❌ 注册提供商 ${providerKey} 失败:`, error);
            return null;
        }
    });

    // 等待所有提供商注册完成
    const results = await Promise.all(registrationPromises);

    // 收集成功注册的提供商
    for (const result of results) {
        if (result) {
            registeredProviders[result.providerKey] = result.provider;
            registeredDisposables.push(...result.disposables);
        }
    }

    const totalTime = Date.now() - startTime;
    const successCount = results.filter(r => r !== null).length;
    Logger.info(
        `⏱️ 提供商注册完成: ${successCount}/${Object.keys(configProvider).length} 个成功 (总耗时: ${totalTime}ms)`
    );
}

/**
 * 激活兼容提供商
 */
async function activateCompatibleProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('正在注册兼容提供商...');
        const providerStartTime = Date.now();

        // 创建并激活兼容提供商
        const result = CompatibleProvider.createAndActivate(context);
        const provider = result.provider;
        const disposables = result.disposables;

        // 存储注册的提供商和 disposables
        registeredProviders['compatible'] = provider;
        registeredDisposables.push(...disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.info(`✅ Compatible Provider 提供商注册成功 (耗时: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ 注册兼容提供商失败:', error);
    }
}

/**
 * 激活内联补全提供商（轻量级 Shim，延迟加载真正的补全引擎）
 */
async function activateInlineCompletionProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('正在注册内联补全提供商 (Shim 模式)...');
        const providerStartTime = Date.now();

        // 创建并激活轻量级 Shim（不包含 @vscode/chat-lib 依赖）
        const result = InlineCompletionShim.createAndActivate(context);
        inlineCompletionProvider = result.provider;
        registeredDisposables.push(...result.disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.info(`✅ 内联补全提供商注册成功 - Shim 模式 (耗时: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ 注册内联补全提供商失败:', error);
    }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // 将单例实例存储到 globalThis，供 copilot.bundle.js 中的模块使用
    globalThis.__gcmp_singletons = {
        CompletionLogger,
        ApiKeyManager,
        StatusBarManager,
        ConfigManager
    };

    const activationStartTime = Date.now();

    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器
        StatusLogger.initialize('GitHub Copilot Models Provider Status'); // 初始化高频状态日志管理器
        CompletionLogger.initialize('GitHub Copilot Inline Completion via GCMP'); // 初始化高频内联补全日志管理器

        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.info(`🔧 GCMP 扩展模式: ${isDevelopment ? 'Development' : 'Production'}`);
        // 检查和提示VS Code的日志级别设置
        if (isDevelopment) {
            Logger.checkAndPromptLogLevel();
        }

        Logger.info('⏱️ 开始激活 GCMP 扩展...');

        // 步骤0: 初始化主实例竞选服务
        let stepStartTime = Date.now();
        LeaderElectionService.initialize(context);
        Logger.trace(`⏱️ 主实例竞选服务初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤1: 初始化API密钥管理器
        stepStartTime = Date.now();
        ApiKeyManager.initialize(context);
        Logger.trace(`⏱️ API密钥管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤2: 初始化配置管理器
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);
        Logger.trace(`⏱️ 配置管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);
        // 步骤2.1: 初始化 JSON Schema 提供者
        stepStartTime = Date.now();
        JsonSchemaProvider.initialize();
        context.subscriptions.push({ dispose: () => JsonSchemaProvider.dispose() });
        Logger.trace(`⏱️ JSON Schema 提供者初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);
        // 步骤2.2: 初始化兼容模型管理器
        stepStartTime = Date.now();
        CompatibleModelManager.initialize();
        Logger.trace(`⏱️ 兼容模型管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);
        // 步骤2.3: 初始化Token统计管理器
        stepStartTime = Date.now();
        await TokenUsagesManager.instance.initialize(context);
        Logger.trace(`⏱️ Token统计管理器初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤3: 激活提供商（并行优化）
        stepStartTime = Date.now();
        await activateProviders(context);
        Logger.trace(`⏱️ 模型提供者注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);
        // 步骤3.1: 激活兼容提供商
        stepStartTime = Date.now();
        await activateCompatibleProvider(context);
        Logger.trace(`⏱️ 兼容提供商注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤3.2: 初始化所有状态栏（包含创建和注册）
        stepStartTime = Date.now();
        await StatusBarManager.initializeAll(context);
        Logger.trace(`⏱️ 所有状态栏初始化完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤4: 注册工具
        stepStartTime = Date.now();
        registerAllTools(context);
        Logger.trace(`⏱️ 工具注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤5: 注册内联补全提供商（轻量级 Shim，延迟加载真正的补全引擎）
        stepStartTime = Date.now();
        await activateInlineCompletionProvider(context);
        Logger.trace(`⏱️ NES 内联补全提供商注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤6: 注册Token用量统计命令
        stepStartTime = Date.now();
        // 查看今日用量统计详情命令（单例模式，同一窗口只允许打开一个统计页面）
        let tokenUsagesView: TokenUsagesView | undefined;
        const viewStatsCommand = vscode.commands.registerCommand('gcmp.tokenUsage.showDetails', () => {
            if (!tokenUsagesView) {
                tokenUsagesView = new TokenUsagesView(context);
            }
            tokenUsagesView.show();
        });
        context.subscriptions.push(
            viewStatsCommand,
            // 确保在扩展停用时清理视图实例
            new vscode.Disposable(() => {
                tokenUsagesView?.dispose();
                tokenUsagesView = undefined;
            })
        );
        Logger.trace(`⏱️ 查看Token消耗统计命令注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤7: 注册 CLI 认证命令
        stepStartTime = Date.now();
        registerCliAuthCommands(context);
        Logger.trace(`⏱️ CLI 认证命令注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤8: 注册 Commit 消息生成命令
        stepStartTime = Date.now();
        registerCommitCommands(context);
        Logger.trace(`⏱️ Commit 消息生成命令注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

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

        // 清理所有状态栏
        StatusBarManager.disposeAll();
        Logger.trace('已清理所有状态栏');

        // 停止主实例竞选服务
        LeaderElectionService.stop();
        Logger.trace('已停止主实例竞选服务');

        // 清理所有已注册提供商的资源
        for (const [providerKey, provider] of Object.entries(registeredProviders)) {
            try {
                if (typeof provider.dispose === 'function') {
                    provider.dispose();
                    Logger.trace(`已清理提供商 ${providerKey} 的资源`);
                }
            } catch (error) {
                Logger.warn(`清理提供商 ${providerKey} 资源时出错:`, error);
            }
        }

        // 清理内联补全提供商
        if (inlineCompletionProvider) {
            inlineCompletionProvider.dispose();
            Logger.trace('已清理内联补全提供商');
        }

        ConfigManager.dispose(); // 清理配置管理器

        // 清理 Token 用量管理器
        TokenUsagesManager.instance.dispose().catch(error => {
            Logger.warn('清理 Token 用量管理器失败:', error);
        });
        Logger.trace('已清理 Token 用量管理器');

        Logger.info('GCMP 扩展停用完成');
        StatusLogger.dispose(); // 清理状态日志管理器
        CompletionLogger.dispose(); // 清理内联补全日志管理器
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
