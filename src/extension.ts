import * as vscode from 'vscode';
import { Logger } from './utils/runtime/logger';
import { StatusLogger } from './utils/runtime/statusLogger';
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
import { ApiKeyFailoverManager } from './utils/config/failover/apiKeyFailoverManager';
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

// 注入仅限同一扩展宿主内的白名单实例，不发布全局服务对象。

/** 允许消费补全服务的扩展 ID 白名单 */
const COMPLETION_SERVICES_CONSUMERS: ReadonlySet<string> = new Set(['vicanent.gcmp-fim-nes']);

/** 补全服务最小能力集（与 gcmp-fim-nes 的 GcmpCompletionServices 结构一致；补全日志通道已由其自建） */
interface CompletionServices {
    ApiKeyManager: { getApiKey(provider: string): Promise<string | undefined> };
    ConfigManager: {
        fetchWithProxy(
            input: string | URL | Request,
            init?: RequestInit,
            options?: {
                modelConfig?: { id?: string; model?: string; proxy?: string; provider?: string };
                providerKey?: string;
                proxyUrl?: string;
                skipHar?: boolean;
            }
        ): Promise<Response>;
    };
    closeProxyAgents(): Promise<void>;
    getAvailableProviders(): { providerIds: string[]; enumDescriptions: string[] };
}

/** 白名单子扩展需在 activate() exports 上暴露的注入入口 */
interface CompletionConsumerExports {
    acceptCompletionServices?(services: CompletionServices): void;
}

/** 主扩展 exports：子扩展就绪通知与注入验证，两者均不返回任何敏感数据 */
interface GcmpExports {
    notifyConsumerReady(consumerId: string): void;
    verifyCompletionServices(candidate: object): boolean;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext): Promise<GcmpExports> {
    // 补全服务最小能力集（bind 到类以保持静态方法的 this 语义）
    const completionServices: CompletionServices = {
        ApiKeyManager: { getApiKey: ApiKeyManager.getApiKey.bind(ApiKeyManager) },
        ConfigManager: {
            fetchWithProxy: ConfigManager.fetchWithProxy.bind(ConfigManager)
        },
        closeProxyAgents,
        getAvailableProviders: JsonSchemaProvider.getAllAvailableProviders.bind(JsonSchemaProvider)
    };

    // 白名单检测并注入；正常时序（extensionDependencies 先主后子）下子扩展此时未激活，
    // 注入由其 activate 完成后的就绪通知触发，此处兜底覆盖子扩展已先激活的场景
    const injectCompletionServices = (consumerId: string): void => {
        if (!COMPLETION_SERVICES_CONSUMERS.has(consumerId)) {
            Logger.warn(`Completion services injection rejected unknown consumer: ${consumerId}`);
            return;
        }
        const consumer = vscode.extensions.getExtension<CompletionConsumerExports>(consumerId);
        if (!consumer) {
            Logger.trace(`Completion consumer ${consumerId} is not installed`);
            return;
        }
        if (!consumer.isActive) {
            Logger.trace(`Completion consumer ${consumerId} is not active yet; waiting for readiness notification`);
            return;
        }
        try {
            consumer.exports?.acceptCompletionServices?.(completionServices);
            Logger.trace(`Completion services injected into ${consumerId}`);
        } catch (error) {
            Logger.warn(`Failed to inject completion services into ${consumerId}:`, error);
        }
    };

    const activationStartTime = Date.now();

    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器
        StatusLogger.initialize('GitHub Copilot Models Provider Status'); // 初始化高频状态日志管理器
        // FIM/NES 补全日志通道已随拆分迁移至 gcmp-fim-nes 扩展自建

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
        LeaderElectionService.registerCommands(context);
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
        ApiKeyManager.setApiKeyConsumerRefresher(
            provider => StatusBarManager.getStatusBar(provider)?.checkAndShowStatus() ?? Promise.resolve()
        );
        Logger.trace(`API key manager initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤2: 初始化配置管理器
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize(context);
        context.subscriptions.push(configDisposable);
        Logger.trace(`Configuration manager initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.0: 初始化远程元数据服务（同步段仅读缓存，随后每 3 分钟定时刷新并合并 npm latest 版本）
        stepStartTime = Date.now();
        await RemoteMetadataService.initialize(context);
        Logger.trace(`Remote metadata service initialized (${Date.now() - stepStartTime}ms)`);
        // 步骤2.0.1: 初始化模型清单远程更新服务（同步段仅读缓存，随后每 5 分钟定时刷新）
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
        void ApiKeyFailoverManager.becomeBalanceAuthority(LeaderElectionService.getOwnedAuthorityTerm());

        // 步骤3.2: 初始化所有状态栏（包含创建和注册）
        stepStartTime = Date.now();
        await StatusBarManager.initializeAll(context);
        Logger.trace(`All status bars initialized (${Date.now() - stepStartTime}ms)`);

        // 步骤4: 注册工具
        stepStartTime = Date.now();
        registerAllTools(context);
        Logger.trace(`Tools registered (${Date.now() - stepStartTime}ms)`);

        // 步骤6: 注册Token用量统计命令（步骤5 的内联补全已拆分至独立扩展 gcmp-fim-nes）
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

        // 主动注入兜底（覆盖子扩展已先激活的场景；正常时序由子扩展就绪通知触发）
        for (const consumerId of COMPLETION_SERVICES_CONSUMERS) {
            injectCompletionServices(consumerId);
        }

        // 子扩展就绪通知触发注入；verifyCompletionServices 供其校验注入来源为本扩展
        return {
            notifyConsumerReady: consumerId => injectCompletionServices(consumerId),
            verifyCompletionServices: candidate => candidate === completionServices
        };
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
            Logger.dispose(); // 在扩展销毁时才 dispose Logger
        } catch (error) {
            console.warn('Failed to dispose loggers during deactivation:', error);
        }
    };

    try {
        Logger.info('Starting GCMP extension deactivation...');

        ApiKeyManager.setApiKeyConsumerRefresher(undefined);

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
