import * as vscode from 'vscode';
import { InlineCompletionShim } from './copilot/inlineCompletionShim';
import { Logger } from './utils/runtime/logger';
import { StatusLogger } from './utils/runtime/statusLogger';
import { CompletionLogger } from './utils/runtime/completionLogger';
import { ApiKeyManager } from './utils/config/apiKeyManager';
import { ConfigManager } from './utils/config/configManager';
import { JsonSchemaProvider } from './utils/config/jsonSchemaProvider';
import { closeProxyAgents } from './utils/net/proxyAgent';
import { registerHarRecorderCommand } from './utils/net/harRecorder';
import { RemoteMetadataService } from './utils/metadata/remoteMetadataService';
import { RemoteModelsService } from './utils/metadata/remoteModelsService';
import { registerCliAuthCommands } from './cli/cliAuthCommands';
import { CliAuthFactory } from './cli/auth/cliAuthFactory';
import { registerConfigSetCommands } from './ui/configSetManager';
import { ConfigSetStore } from './utils/config/configSetStore';
import { GistSyncService } from './sync/gistSyncService';
import { TokenUsagesManager } from './usages/usagesManager';
import { registerUsageRefreshHandlers } from './usages/usageActivation';
import { registerTokenUsageCommands } from './ui/usagesView';
import { CompatibleModelManager } from './utils/config/compatibleModelManager';
import { LeaderElectionService, StatusBarManager } from './status';
import { InterInstanceBus } from './interInstance';
import { registerInterInstanceHandlers } from './interInstance/activation';
import { registerConfigSetProviderChangeHandlers } from './utils/config/configSetCommands';
import { RateLimiter } from './rateLimit/rateLimiter';
import { registerAllTools } from './tools';
import { registerCommitCommands, registerGitAvailability } from './commit';
import { activateCompatibleProvider, activateProviders } from './providers';
import {
    clearRegisteredProviders,
    notifyRegisteredProvidersChanged,
    registeredProviders
} from './utils/config/providerRegistry';
import { t } from './utils/runtime/l10n';
import { activateCopilotChatInBackground } from './utils/runtime/copilotChatActivation';
import { runStartupUtilityModelWizardIfNeeded } from './wizards/startupUtilityModelWizard';
import { registerVisionModelCommand } from './wizards/visionWizard';
import { registerAuxiliaryModelSettingsCommands } from './ui/auxiliaryModelSettings';

// 内联补全提供商实例（使用轻量级 Shim，延迟加载真正的补全引擎）
let inlineCompletionProvider: InlineCompletionShim | undefined;

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

        // 步骤0.1: 初始化跨实例总线（Leader/Follower IPC + 轮询回退）
        stepStartTime = Date.now();
        await InterInstanceBus.initialize(context);
        Logger.trace(`Inter-instance bus initialized (${Date.now() - stepStartTime}ms)`);

        // 订阅 Leader 卸任通知：主实例关闭前会广播此事件，Follower 收到后立即开始竞选
        LeaderElectionService.subscribeToLeaderResigning();

        registerInterInstanceHandlers(context);

        // 初始化跨实例限流器（Leader 权威桶 + Follower IPC 回执 + 本地降级）
        stepStartTime = Date.now();
        RateLimiter.initialize(context);
        Logger.trace(`Rate limiter initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤0.2: 初始化 CLI 认证跨实例刷新协调
        stepStartTime = Date.now();
        CliAuthFactory.initialize(context);
        Logger.trace(`CLI auth coordinator initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤1: 初始化API密钥管理器
        stepStartTime = Date.now();
        ApiKeyManager.initialize(context);
        Logger.trace(`API key manager initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤2: 初始化配置管理器
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize(context);
        context.subscriptions.push(configDisposable);
        Logger.trace(`Configuration manager initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.0: 初始化远程元数据服务（同步段仅读缓存，随后每 15 分钟定时刷新）
        stepStartTime = Date.now();
        await RemoteMetadataService.initialize(context);
        Logger.trace(`Remote metadata service initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.0.1: 初始化模型清单远程更新服务（同步段仅读缓存，随后每 15 分钟定时刷新）
        stepStartTime = Date.now();
        await RemoteModelsService.initialize(context);
        Logger.trace(`Remote models service initialized (${Date.now() - stepStartTime}ms)`);
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
        registerUsageRefreshHandlers(context);

        // 步骤3: 激活提供商（并行优化）
        stepStartTime = Date.now();
        await activateProviders(context);
        Logger.trace(`Model providers registered (${Date.now() - stepStartTime}ms)`);
        RemoteModelsService.startAfterProvidersRegistered();
        // 步骤3.1: 激活兼容提供商
        stepStartTime = Date.now();
        await activateCompatibleProvider(context);
        Logger.trace(`Compatible provider registered (${Date.now() - stepStartTime}ms)`);

        registerConfigSetProviderChangeHandlers(context);

        notifyRegisteredProvidersChanged();
        context.subscriptions.push(activateCopilotChatInBackground(notifyRegisteredProvidersChanged));

        // 配置集存储需早于状态栏初始化，避免 tooltip 首次渲染时访问未初始化上下文
        ConfigSetStore.initialize(context);

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
        registerTokenUsageCommands(context);
        Logger.trace(`Token usage details command registered (${Date.now() - stepStartTime}ms)`);

        // 步骤7: 注册 CLI 认证命令
        stepStartTime = Date.now();
        registerCliAuthCommands(context);
        Logger.trace(`CLI authentication commands registered (${Date.now() - stepStartTime}ms)`);

        registerConfigSetCommands(context);
        Logger.trace('Config set manager registered');

        // 步骤8: 初始化 GitHub Gist 同步服务（供配置集同步共用认证/加密基础设施）
        stepStartTime = Date.now();
        GistSyncService.initialize(context);
        Logger.trace(`GitHub Gist sync service initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤8.1: 注册 HAR 记录文件定位命令（仅供 tooltip 内部快捷入口调用，不作为命令面板入口）
        // 在系统文件管理器中显示最新 HAR 文件；当当前 HAR 文件尚未落盘时，回退到目录中最近的 .har 文件；都没有则打开 HAR 目录
        registerHarRecorderCommand(context);

        // 步骤9: 注册模型设置向导命令
        stepStartTime = Date.now();
        registerAuxiliaryModelSettingsCommands(context);
        registerVisionModelCommand(context);
        Logger.trace(`Model settings wizard registered (${Date.now() - stepStartTime}ms)`);

        // 步骤10: 注册 Commit 消息生成命令
        stepStartTime = Date.now();
        registerCommitCommands(context);
        Logger.trace(`Commit message commands registered (${Date.now() - stepStartTime}ms)`);

        // 步骤11: 检查 Git 可用性（不阻塞扩展激活）
        stepStartTime = Date.now();
        registerGitAvailability(context);
        Logger.trace(`Git availability check scheduled (${Date.now() - stepStartTime}ms)`);

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
    // 必须执行的清理（尾部统计落盘与 Logger 句柄）独立成段，
    // 避免前面任意一步抛错时被整体跳过
    const disposeEssentials = async (): Promise<void> => {
        try {
            // 清理 Token 用量管理器：必须 await，确保写队列中最后一批统计落盘，
            // 否则窗口关闭/扩展升级时会丢失尾部请求统计
            await TokenUsagesManager.instance.dispose();
            Logger.trace('Token usage manager disposed');
        } catch (error) {
            Logger.warn('Failed to dispose token usage manager:', error);
        }
        try {
            StatusLogger.dispose(); // 清理状态日志管理器
            CompletionLogger.dispose(); // 清理内联补全日志管理器
            Logger.dispose(); // 在扩展销毁时才 dispose Logger
        } catch (error) {
            console.warn('Failed to dispose loggers during deactivation:', error);
        }
    };

    try {
        Logger.info('Starting GCMP extension deactivation...');

        // 清理所有状态栏
        StatusBarManager.disposeAll();
        Logger.trace('All status bars disposed');

        // 先停止主实例竞选服务：Leader 会在此步骤广播 leaderResigning 并清除 globalState。
        // InterInstanceBus 必须在它之后 dispose，否则 IPC Server 已关闭，leaderResigning 无法发出。
        await LeaderElectionService.stop();
        Logger.trace('Leader election service stopped');

        // 再停止跨实例总线
        await InterInstanceBus.dispose();
        Logger.trace('Inter-instance bus disposed');

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

        clearRegisteredProviders();
        Logger.trace('All registered providers cleared');

        // 清理兼容模型管理器
        CompatibleModelManager.dispose();
        Logger.trace('Compatible model manager disposed');

        await ConfigManager.dispose(); // 清理配置管理器，并等待 HAR 尾部记录完成落盘

        // 关闭所有 ProxyAgent 连接池和 fetch 缓存
        await closeProxyAgents();
        Logger.trace('Proxy agents disposed');

        Logger.info('GCMP extension deactivated successfully');
    } catch (error) {
        Logger.error('Error during GCMP extension deactivation:', error);
    } finally {
        await disposeEssentials();
    }
}
