import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { ZhipuProvider } from './providers/zhipuProvider';
import { KimiProvider } from './providers/kimiProvider';
import { IFlowProvider } from './providers/iflowProvider';
import { ModelScopeProvider } from './providers/modelscopeProvider';
import { StreamLakeProvider } from './providers/streamlakeProvider';
import { MiniMaxProvider } from './providers/minimaxProvider';
import { CompatibleProvider } from './providers/compatibleProvider';
import { InlineCompletionProvider } from './providers/copilot/completionProvider';
import { NESProvider } from './providers/copilot/nesProvider';
import { Logger } from './utils/logger';
import { StatusLogger } from './utils/statusLogger';
import { ApiKeyManager, ConfigManager, JsonSchemaProvider } from './utils';
import { CompatibleModelManager } from './utils/compatibleModelManager';
import { LeaderElectionService, StatusBarManager } from './status';
import { registerAllTools } from './tools';

/**
 * 全局变量 - 存储已注册的提供商实例，用于扩展卸载时的清理
 */
const registeredProviders: Record<
    string,
    | GenericModelProvider
    | ZhipuProvider
    | KimiProvider
    | IFlowProvider
    | ModelScopeProvider
    | StreamLakeProvider
    | MiniMaxProvider
    | CompatibleProvider
> = {};
const registeredDisposables: vscode.Disposable[] = [];

// 内联补全提供商实例
let inlineCompletionProvider: InlineCompletionProvider | undefined;

// NES 提供商实例
let nesProvider: NESProvider | undefined;

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

    Logger.info(`⏱️ 开始并行注册 ${Object.keys(configProvider).length} 个提供商...`);

    // 并行注册所有提供商以提升性能
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`正在注册提供商: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

            let provider:
                | GenericModelProvider
                | ZhipuProvider
                | KimiProvider
                | IFlowProvider
                | ModelScopeProvider
                | StreamLakeProvider
                | MiniMaxProvider;
            let disposables: vscode.Disposable[];

            if (providerKey === 'zhipu') {
                // 对 zhipu 使用专门的 provider（配置向导功能）
                const result = ZhipuProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'kimi') {
                // 对 kimi 使用专门的 provider（使用量统计和状态栏管理）
                const result = KimiProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'iflow') {
                // 对 iflow 使用专门的 provider
                const result = IFlowProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'minimax') {
                // 对 minimax 使用专门的 provider（多密钥管理和配置向导）
                const result = MiniMaxProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'modelscope' || providerKey === 'tbox') {
                // 对 modelscope 和 tbox 使用专门的 provider（自定义流处理）
                const result = ModelScopeProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'streamlake') {
                // 对 streamlake 使用专门的 provider（模型覆盖检查）
                const result = StreamLakeProvider.createAndActivate(context, providerKey, providerConfig);
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
 * 激活内联补全提供商
 * 支持多个 FIM API 提供商切换
 *
 * 临时禁用：为了进行 NES 对接实验
 */
async function activateInlineCompletionProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('正在注册内联补全提供商...');
        const providerStartTime = Date.now();

        // 创建并激活内联补全提供商
        const result = InlineCompletionProvider.createAndActivate(context);
        inlineCompletionProvider = result.provider;
        registeredDisposables.push(...result.disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.info(`✅ 内联补全提供商注册成功 (耗时: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ 注册内联补全提供商失败:', error);
    }
}

/**
 * 激活 NES 提供商
 * 用于 Next Edit Suggest 的对接实验
 */
async function activateNESProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('正在注册 NES 提供商...');
        const providerStartTime = Date.now();

        // 创建并激活 NES 提供商
        const result = NESProvider.createAndActivate(context);
        nesProvider = result.provider;
        registeredDisposables.push(...result.disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.info(`✅ NES 提供商注册成功 (耗时: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ 注册 NES 提供商失败:', error);
    }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    const activationStartTime = Date.now();

    try {
        Logger.initialize('GitHub Copilot Models Provider (GCMP)'); // 初始化日志管理器
        StatusLogger.initialize('GitHub Copilot Models Provider Status'); // 初始化高频状态日志管理器

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

        // // 步骤5: 注册内联补全提供商（临时禁用）
        // stepStartTime = Date.now();
        // await activateInlineCompletionProvider(context);
        // Logger.trace(`⏱️ 内联补全提供商注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

        // 步骤5.1: 激活 NES 提供商（实验）
        stepStartTime = Date.now();
        await activateNESProvider(context);
        Logger.trace(`⏱️ NES 提供商注册完成 (耗时: ${Date.now() - stepStartTime}ms)`);

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

        // 清理 NES 提供商
        if (nesProvider) {
            nesProvider.dispose();
            Logger.trace('已清理 NES 提供商');
        }

        ConfigManager.dispose(); // 清理配置管理器
        Logger.info('GCMP 扩展停用完成');
        StatusLogger.dispose(); // 清理状态日志管理器
        Logger.dispose(); // 在扩展销毁时才 dispose Logger
    } catch (error) {
        Logger.error('GCMP 扩展停用时出错:', error);
    }
}
