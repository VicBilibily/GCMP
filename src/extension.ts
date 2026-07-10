import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { ZhipuProvider } from './providers/zhipuProvider';
import { MoonshotProvider } from './providers/moonshotProvider';
import { CliModelProvider } from './cli/cliModelProvider';
import { CodexModelProvider } from './providers/codexModelProvider';
import { MiniMaxProvider } from './providers/minimaxProvider';
import { DashscopeProvider } from './providers/dashscopeProvider';
import { TencentProvider } from './providers/tencentProvider';
import { XiaomimimoProvider } from './providers/xiaomimimoProvider';
import { BaiduProvider } from './providers/baiduProvider';
import { VolcengineProvider } from './providers/volcengineProvider';
import { StepFunProvider } from './providers/stepfunProvider';
import { XfyunProvider } from './providers/xfyunProvider';
import { CompatibleProvider } from './providers/compatibleProvider';
import { InlineCompletionShim } from './copilot/inlineCompletionShim';
import { Logger, StatusLogger, CompletionLogger, TokenCounter } from './utils';
import { ApiKeyManager, ConfigManager, JsonSchemaProvider } from './utils';
import { closeProxyAgents } from './utils/proxyAgent';
import { registerCliAuthCommands } from './cli/cliAuthCommands';
import { SyncManager } from './sync/syncManager';
import { TokenUsagesManager } from './usages/usagesManager';
import { TokenUsagesView } from './ui/usagesView';
import { CompatibleModelManager } from './utils/compatibleModelManager';
import { LeaderElectionService, StatusBarManager } from './status';
import { registerAllTools } from './tools';
import { CliAuthFactory } from './cli/auth/cliAuthFactory';
import { registerCommitCommands, checkGitAvailability } from './commit';
import { clearRegisteredProviders, registerProvider, registeredProviders } from './utils/providerRegistry';
import { t } from './utils/l10n';
import { runStartupUtilityModelWizardIfNeeded } from './wizards/startupUtilityModelWizard';

/**
 * 全局变量 - 存储已注册的提供商实例，用于扩展卸载时的清理
 */
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
        Logger.warn('Provider configuration not found. Skipping provider registration.');
        return;
    }

    // 设置扩展路径（用于 tokenizer 初始化）
    TokenCounter.setExtensionPath(context.extensionPath);

    Logger.debug(`Starting parallel registration for ${Object.keys(configProvider).length} providers...`);

    // CLI 认证提供商列表（从 CliAuthFactory 获取）
    const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
    const cliAuthProviders = supportedCliTypes.map(cli => cli.id);

    // 并行注册所有提供商以提升性能
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`Registering provider: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

            let provider:
                | GenericModelProvider
                | ZhipuProvider
                | MoonshotProvider
                | CliModelProvider
                | CodexModelProvider
                | MiniMaxProvider
                | DashscopeProvider
                | TencentProvider
                | XiaomimimoProvider
                | BaiduProvider
                | VolcengineProvider
                | XfyunProvider;
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
            } else if (providerKey === 'minimax') {
                // 对 minimax 使用专门的 provider（多密钥管理和配置向导）
                const result = MiniMaxProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'dashscope') {
                // 对 dashscope 使用专门的 provider（多密钥管理和配置向导）
                const result = DashscopeProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'tencent') {
                // 对 tencent 使用专门的 provider（四类密钥和协议切换）
                const result = TencentProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'xiaomimimo') {
                // 对 xiaomimimo 使用专门的 provider（多密钥管理和配置向导）
                const result = XiaomimimoProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'baidu') {
                // 对百度千帆使用专门的 provider（多密钥管理和配置向导）
                const result = BaiduProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'volcengine') {
                // 对火山方舟使用专门的 provider（Coding Plan / Agent Plan 多密钥管理和配置向导）
                const result = VolcengineProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'stepfun') {
                // 对阶跃星辰 StepFun 使用专门的 provider（配置向导功能）
                const result = StepFunProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'xfyun') {
                // 对讯飞星辰 iFLYTEK 使用专门的 provider（按量计费 / Coding Plan / Token Plan 三密钥管理）
                const result = XfyunProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'codex') {
                const result = CodexModelProvider.createAndActivate(context, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (cliAuthProviders.includes(providerKey)) {
                // 对 CLI 认证提供商使用通用的 CLI provider
                const result = CliModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else {
                // 其他提供商使用通用 provider（支持基于 sdkMode 的自动选择）
                const result = GenericModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            }

            const providerTime = Date.now() - providerStartTime;
            Logger.debug(`Provider registered successfully: ${providerConfig.displayName} (${providerTime}ms)`);
            return { providerKey, provider, disposables };
        } catch (error) {
            Logger.error(`Failed to register provider ${providerKey}:`, error);
            return null;
        }
    });

    // 等待所有提供商注册完成
    const results = await Promise.all(registrationPromises);

    // 收集成功注册的提供商
    for (const result of results) {
        if (result) {
            registerProvider(result.providerKey, result.provider);
            registeredDisposables.push(...result.disposables);
        }
    }

    const totalTime = Date.now() - startTime;
    const successCount = results.filter(r => r !== null).length;
    Logger.debug(
        `Provider registration completed: ${successCount}/${Object.keys(configProvider).length} succeeded (${totalTime}ms)`
    );
}

/**
 * 激活兼容提供商
 */
async function activateCompatibleProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('Registering compatible provider...');
        const providerStartTime = Date.now();

        // 创建并激活兼容提供商
        const result = CompatibleProvider.createAndActivate(context);
        const provider = result.provider;
        const disposables = result.disposables;

        // 存储注册的提供商和 disposables
        registerProvider('compatible', provider);
        registeredDisposables.push(...disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.debug(`Compatible provider registered successfully (${providerTime}ms)`);
    } catch (error) {
        Logger.error('Failed to register compatible provider:', error);
    }
}

/**
 * 激活内联补全提供商（轻量级 Shim，延迟加载真正的补全引擎）
 */
async function activateInlineCompletionProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('Registering inline completion provider (shim mode)...');
        const providerStartTime = Date.now();

        // 创建并激活轻量级 Shim（不包含 @vscode/chat-lib 依赖）
        const result = InlineCompletionShim.createAndActivate(context);
        inlineCompletionProvider = result.provider;
        registeredDisposables.push(...result.disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.debug(`Inline completion provider registered successfully in shim mode (${providerTime}ms)`);
    } catch (error) {
        Logger.error('Failed to register inline completion provider:', error);
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
        Logger.debug(`GCMP extension mode: ${isDevelopment ? 'Development' : 'Production'}`);
        // 检查和提示VS Code的日志级别设置
        if (isDevelopment) {
            Logger.checkAndPromptLogLevel();
        }

        Logger.debug('Starting GCMP extension activation...');

        // 步骤0: 初始化主实例竞选服务
        let stepStartTime = Date.now();
        LeaderElectionService.initialize(context);
        Logger.trace(`Leader election service initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤1: 初始化API密钥管理器
        stepStartTime = Date.now();
        ApiKeyManager.initialize(context);
        Logger.trace(`API key manager initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤2: 初始化配置管理器
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);
        Logger.trace(`Configuration manager initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.1: 初始化 JSON Schema 提供者
        stepStartTime = Date.now();
        JsonSchemaProvider.initialize();
        context.subscriptions.push({ dispose: () => JsonSchemaProvider.dispose() });
        Logger.trace(`JSON schema provider initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.2: 初始化兼容模型管理器
        stepStartTime = Date.now();
        CompatibleModelManager.initialize();
        Logger.trace(`Compatible model manager initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.3: 初始化Token统计管理器
        stepStartTime = Date.now();
        await TokenUsagesManager.instance.initialize(context);
        Logger.trace(`Token usage manager initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤3: 激活提供商（并行优化）
        stepStartTime = Date.now();
        await activateProviders(context);
        Logger.trace(`Model providers registered (${Date.now() - stepStartTime}ms)`);
        // 步骤3.1: 激活兼容提供商
        stepStartTime = Date.now();
        await activateCompatibleProvider(context);
        Logger.trace(`Compatible provider registered (${Date.now() - stepStartTime}ms)`);

        // 步骤3.2: 初始化所有状态栏（包含创建和注册）
        stepStartTime = Date.now();
        await StatusBarManager.initializeAll(context);
        Logger.trace(`All status bars initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤4: 注册工具
        stepStartTime = Date.now();
        registerAllTools(context);
        Logger.trace(`Tools registered (${Date.now() - stepStartTime}ms)`);

        // 步骤5: 注册内联补全提供商（轻量级 Shim，延迟加载真正的补全引擎）
        stepStartTime = Date.now();
        await activateInlineCompletionProvider(context);
        Logger.trace(`NES inline completion provider registered (${Date.now() - stepStartTime}ms)`);

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
        Logger.trace(`Token usage details command registered (${Date.now() - stepStartTime}ms)`);

        // 步骤7: 注册 CLI 认证命令
        stepStartTime = Date.now();
        registerCliAuthCommands(context);
        Logger.trace(`CLI authentication commands registered (${Date.now() - stepStartTime}ms)`);

        // 步骤8: 初始化与注册 GitHub Gist 同步命令（统一入口）
        stepStartTime = Date.now();
        SyncManager.initialize(context);
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.sync.configure', () => SyncManager.configure())
        );
        Logger.trace(`GitHub Gist sync commands registered (${Date.now() - stepStartTime}ms)`);

        // 步骤9: 注册模型设置向导命令
        stepStartTime = Date.now();
        const { selectVisionModel } = await import('./wizards/visionWizard');
        const { AuxiliaryModelSettingsPanel } = await import('./ui/auxiliaryModelSettings');
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.modelSettings.wizard', () =>
                AuxiliaryModelSettingsPanel.createAndShow(context)
            )
        );
        context.subscriptions.push(
            vscode.commands.registerCommand('gcmp.vision.selectModel', () => selectVisionModel())
        );
        Logger.trace(`Model settings wizard registered (${Date.now() - stepStartTime}ms)`);

        // 步骤10: 注册 Commit 消息生成命令
        stepStartTime = Date.now();
        const commitDisposables = registerCommitCommands(context);
        commitDisposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.trace(`Commit message commands registered (${Date.now() - stepStartTime}ms)`);

        // 步骤11: 检查 Git 可用性（不阻塞扩展激活）
        // 默认设置为不可用，检查完成后更新
        vscode.commands.executeCommand('setContext', 'gcmp.gitAvailable', false);
        const gitDisposable = checkGitAvailability();
        context.subscriptions.push(gitDisposable);

        // 步骤12: 启动后提示 utility 模型配置（VS Code 1.128+）
        stepStartTime = Date.now();
        void runStartupUtilityModelWizardIfNeeded();
        Logger.trace(`Utility model setup guidance scheduled (${Date.now() - stepStartTime}ms)`);

        const totalActivationTime = Date.now() - activationStartTime;
        Logger.info(`GCMP extension activated successfully (${totalActivationTime}ms)`);
    } catch (error) {
        const errorMessage = `GCMP extension activation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        Logger.error(errorMessage, error instanceof Error ? error : undefined);

        // 尝试显示用户友好的错误消息
        vscode.window.showErrorMessage(
            t(
                'GCMP failed to start. Check the output window for details.',
                'GCMP 扩展启动失败。请检查输出窗口获取详细信息。'
            )
        );
        // 重新抛出错误，让VS Code知道扩展启动失败
        throw error;
    }
}

// This method is called when your extension is deactivated
export async function deactivate() {
    try {
        Logger.info('Starting GCMP extension deactivation...');

        // 清理所有状态栏
        StatusBarManager.disposeAll();
        Logger.trace('All status bars disposed');

        // 停止主实例竞选服务
        await LeaderElectionService.stop();
        Logger.trace('Leader election service stopped');

        // 清理所有已注册提供商的资源
        for (const [providerKey, provider] of Object.entries(registeredProviders)) {
            try {
                if (typeof provider.dispose === 'function') {
                    provider.dispose();
                    Logger.trace(`Disposed resources for provider ${providerKey}`);
                }
            } catch (error) {
                Logger.warn(`Failed to dispose resources for provider ${providerKey}:`, error);
            }
        }

        // 清理内联补全提供商
        if (inlineCompletionProvider) {
            inlineCompletionProvider.dispose();
            Logger.trace('Inline completion provider disposed');
        }

        // 清理所有已注册的 disposables
        for (const disposable of registeredDisposables) {
            try {
                disposable.dispose();
            } catch (error) {
                Logger.warn('Failed to dispose registered disposable:', error);
            }
        }
        registeredDisposables.length = 0; // 清空数组
        Logger.trace('All registered disposables disposed');

        clearRegisteredProviders();
        Logger.trace('All registered providers cleared');

        // 清理兼容模型管理器
        CompatibleModelManager.dispose();
        Logger.trace('Compatible model manager disposed');

        ConfigManager.dispose(); // 清理配置管理器

        // 关闭所有 ProxyAgent 连接池和 fetch 缓存
        await closeProxyAgents();
        Logger.trace('Proxy agents disposed');

        // 清理 Token 用量管理器
        TokenUsagesManager.instance.dispose().catch(error => {
            Logger.warn('Failed to dispose token usage manager:', error);
        });
        Logger.trace('Token usage manager dispose requested');

        Logger.info('GCMP extension deactivated successfully');
        StatusLogger.dispose(); // 清理状态日志管理器
        CompletionLogger.dispose(); // 清理内联补全日志管理器
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('Error during GCMP extension deactivation:', error);
    }
}
