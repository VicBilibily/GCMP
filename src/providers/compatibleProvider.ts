/*---------------------------------------------------------------------------------------------
 *  独立兼容提供商
 *  继承 GenericModelProvider，重写必要方法以支持完全用户配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig, ModelOverride } from '../types/sharedTypes';
import { Logger, ApiKeyManager, CompatibleModelManager, RetryManager, ConfigManager } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status';
import { KnownProviders } from '../utils';
import { configProviders } from './config';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';
import { GeminiHandler } from '../handlers/geminiHandler';

/**
 * 独立兼容模型提供商类
 * 继承 GenericModelProvider，重写模型配置获取方法
 */
export class CompatibleProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'compatible';
    private modelsChangeListener?: vscode.Disposable;
    private retryManager: RetryManager;
    protected readonly openaiResponsesHandler: OpenAIResponsesHandler;
    protected readonly geminiHandler: GeminiHandler;

    constructor(context: vscode.ExtensionContext) {
        // 创建一个虚拟的 ProviderConfig，实际模型配置从 CompatibleModelManager 获取
        const virtualConfig: ProviderConfig = {
            displayName: 'Compatible',
            baseUrl: 'https://api.openai.com/v1', // 默认值，实际使用时会覆盖
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            models: [] // 空模型列表，实际从 CompatibleModelManager 获取
        };
        super(context, CompatibleProvider.PROVIDER_KEY, virtualConfig);

        // 为 Compatible 配置特定的重试参数
        this.retryManager = new RetryManager({
            maxAttempts: 3,
            initialDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
            jitterEnabled: true
        });

        this.openaiResponsesHandler = new OpenAIResponsesHandler(this.providerConfig.displayName, this.openaiHandler);

        this.geminiHandler = new GeminiHandler(this.providerConfig.displayName, this.providerConfig);

        this.getProviderConfig(); // 初始化配置缓存
        // 监听 CompatibleModelManager 的变更事件
        this.modelsChangeListener = CompatibleModelManager.onDidChangeModels(() => {
            Logger.debug('[compatible] 接收到模型变化事件，刷新配置和缓存');
            this.getProviderConfig(); // 刷新配置缓存
            // 清除模型缓存
            this.modelInfoCache
                ?.invalidateCache(CompatibleProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[compatible] 清除缓存失败:', err));
            this._onDidChangeLanguageModelChatInformation.fire();
            Logger.debug('[compatible] 已触发语言模型信息变化事件');
        });
    }

    override dispose(): void {
        this.modelsChangeListener?.dispose();
        super.dispose();
    }

    /**
     * 重写：获取动态的提供商配置
     * 从 CompatibleModelManager 获取用户配置的模型
     */
    getProviderConfig(): ProviderConfig {
        try {
            const models = CompatibleModelManager.getModels();
            // 将 CompatibleModelManager 的模型转换为 ModelConfig 格式
            const modelConfigs: ModelConfig[] = models.map(model => {
                let customHeader = model.customHeader;
                if (model.provider) {
                    const provider = KnownProviders[model.provider];
                    if (provider?.customHeader) {
                        const existingHeaders = model.customHeader || {};
                        customHeader = { ...existingHeaders, ...provider.customHeader };
                    }

                    let knownOverride: Omit<ModelOverride, 'id'> | undefined;
                    if (model.sdkMode === 'anthropic' && provider?.anthropic) {
                        knownOverride = provider.anthropic;
                    } else if (model.sdkMode !== 'anthropic' && provider?.openai) {
                        knownOverride = provider.openai.extraBody;
                    }

                    if (knownOverride) {
                        const extraBody = knownOverride.extraBody || {};
                        const modelBody = model.extraBody || {};
                        model.extraBody = { ...extraBody, ...modelBody };
                    }
                }
                return {
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    tooltip: model.tooltip || `${model.name} (${model.sdkMode})`,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    sdkMode: model.sdkMode,
                    capabilities: model.capabilities,
                    ...(model.baseUrl && { baseUrl: model.baseUrl }),
                    ...(model.model && { model: model.model }),
                    ...(customHeader && { customHeader: customHeader }),
                    ...(model.extraBody && { extraBody: model.extraBody }),
                    ...(model.outputThinking !== undefined && { outputThinking: model.outputThinking }),
                    ...(model.includeThinking !== undefined && { includeThinking: model.includeThinking }),
                    ...(model.useInstructions !== undefined && { useInstructions: model.useInstructions })
                };
            });

            Logger.debug(`Compatible Provider 加载了 ${modelConfigs.length} 个用户配置的模型`);

            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1', // 默认值，模型级别的配置会覆盖
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: modelConfigs
            };
        } catch (error) {
            Logger.error('获取 Compatible Provider 配置失败:', error);
            // 返回基础配置作为后备
            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: []
            };
        }
        return this.cachedProviderConfig;
    }

    /**
     * 重写：提供语言模型聊天信息
     * 直接获取最新的动态配置，不依赖构造时的配置
     * 检查所有模型涉及的提供商的 API Key
     * 集成模型缓存机制以提高性能
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
            // 获取 API 密钥的哈希值用于缓存验证
            const apiKeyHash = await this.getApiKeyHash();

            // 快速路径：检查缓存
            let cachedModels = await this.modelInfoCache?.getCachedModels(CompatibleProvider.PROVIDER_KEY, apiKeyHash);
            if (cachedModels) {
                Logger.trace(`✓ Compatible Provider 缓存命中: ${cachedModels.length} 个模型`);

                // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能时）
                const rememberLastModel = ConfigManager.getRememberLastModel();
                if (rememberLastModel) {
                    const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(CompatibleProvider.PROVIDER_KEY);
                    if (lastSelectedId) {
                        cachedModels = cachedModels.map(model => ({
                            ...model,
                            isDefault: model.id === lastSelectedId
                        }));
                    }
                }

                // 后台异步更新缓存
                this.updateModelCacheAsync(apiKeyHash);
                return cachedModels;
            }

            // 获取最新的动态配置
            const currentConfig = this.providerConfig;
            // 如果没有模型，直接返回空列表
            if (currentConfig.models.length === 0) {
                // 异步触发新增模型流程，但不阻塞配置获取
                if (!options.silent) {
                    setImmediate(async () => {
                        try {
                            await CompatibleModelManager.configureModelOrUpdateAPIKey();
                        } catch {
                            Logger.debug('自动触发新增模型失败或被用户取消');
                        }
                    });
                }
                return [];
            }

            // 获取所有模型涉及的提供商（去重）
            const providers = new Set<string>();
            for (const model of currentConfig.models) {
                if (model.provider) {
                    providers.add(model.provider);
                }
            }
            // 检查每个提供商的 API Key
            for (const provider of providers) {
                if (!options.silent) {
                    // 非静默模式下，使用 ensureApiKey 逐一确认和设置
                    const hasValidKey = await ApiKeyManager.ensureApiKey(provider, provider, false);
                    if (!hasValidKey) {
                        Logger.warn(`Compatible Provider 用户未设置提供商 "${provider}" 的 API 密钥`);
                        return [];
                    }
                }
            }

            // 将最新配置中的模型转换为 VS Code 所需的格式
            let modelInfos = currentConfig.models.map(model => {
                const info = this.modelConfigToInfo(model);
                const sdkModeDisplay = CompatibleModelManager.getSdkModeLabel(model.sdkMode);

                if (model.provider) {
                    const knownProvider = KnownProviders[model.provider];
                    if (knownProvider?.displayName) {
                        return { ...info, detail: knownProvider.displayName };
                    }
                    const provider = configProviders[model.provider as keyof typeof configProviders];
                    if (provider?.displayName) {
                        return { ...info, detail: provider.displayName };
                    }
                }

                return { ...info, detail: `${sdkModeDisplay} Compatible` };
            });

            // 读取用户上次选择的模型并标记为默认（仅当启用记忆功能时）
            const rememberLastModel = ConfigManager.getRememberLastModel();
            if (rememberLastModel) {
                const lastSelectedId = this.modelInfoCache?.getLastSelectedModel(CompatibleProvider.PROVIDER_KEY);
                if (lastSelectedId) {
                    modelInfos = modelInfos.map(model => ({
                        ...model,
                        isDefault: model.id === lastSelectedId
                    }));
                }
            }

            Logger.debug(`Compatible Provider 提供了 ${modelInfos.length} 个模型信息`); // 后台异步更新缓存
            this.updateModelCacheAsync(apiKeyHash);

            return modelInfos;
        } catch (error) {
            Logger.error('获取 Compatible Provider 模型信息失败:', error);
            return [];
        }
    }

    /**
     * 重写：异步更新模型缓存
     * 需要正确设置 detail 字段以显示 SDK 模式
     */
    protected override updateModelCacheAsync(apiKeyHash: string): void {
        (async () => {
            try {
                const currentConfig = this.providerConfig;

                const models = currentConfig.models.map(model => {
                    const info = this.modelConfigToInfo(model);
                    const sdkModeDisplay = CompatibleModelManager.getSdkModeLabel(model.sdkMode);

                    if (model.provider) {
                        const knownProvider = KnownProviders[model.provider];
                        if (knownProvider?.displayName) {
                            return { ...info, detail: knownProvider.displayName };
                        }
                        const provider = configProviders[model.provider as keyof typeof configProviders];
                        if (provider?.displayName) {
                            return { ...info, detail: provider.displayName };
                        }
                    }

                    return { ...info, detail: `${sdkModeDisplay} Compatible` };
                });

                await this.modelInfoCache?.cacheModels(CompatibleProvider.PROVIDER_KEY, models, apiKeyHash);
            } catch (err) {
                Logger.trace('[compatible] 后台缓存更新失败:', err instanceof Error ? err.message : String(err));
            }
        })();
    }

    /**
     * 获取提供商的显示名称
     * @param providerKey 提供商的 key
     * @returns 提供商的显示名称，如果找不到则返回 providerKey
     */
    private getProviderDisplayName(providerKey: string): string {
        // 先从 KnownProviders 查找
        const knownProvider = KnownProviders[providerKey];
        if (knownProvider?.displayName) {
            return knownProvider.displayName;
        }

        // 再从 configProviders 查找
        const provider = configProviders[providerKey as keyof typeof configProviders];
        if (provider?.displayName) {
            return provider.displayName;
        }

        // 找不到则返回 key 本身
        return providerKey;
    }

    /**
     * 重写：提供语言模型聊天响应
     * 使用最新的动态配置处理请求，并添加失败重试机制
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // 保存用户选择的模型及其提供商（仅当启用记忆功能时）
        const rememberLastModel = ConfigManager.getRememberLastModel();
        if (rememberLastModel) {
            this.modelInfoCache
                ?.saveLastSelectedModel(CompatibleProvider.PROVIDER_KEY, model.id)
                .catch(err => Logger.warn('[compatible] 保存模型选择失败:', err));
        }

        try {
            // 获取最新的动态配置
            const currentConfig = this.providerConfig;

            // 查找对应的模型配置
            const modelConfig = currentConfig.models.find(m => m.id === model.id);
            if (!modelConfig) {
                const errorMessage = `Compatible Provider 未找到模型: ${model.id}`;
                Logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            // 检查 API 密钥（使用 throwError: false 允许静默失败）
            const hasValidKey = await ApiKeyManager.ensureApiKey(
                modelConfig.provider!,
                currentConfig.displayName,
                false
            );
            if (!hasValidKey) {
                throw new Error(`模型 ${modelConfig.name} 的 API 密钥尚未设置`);
            }

            // 根据模型的 sdkMode 选择使用的 handler
            const sdkMode = modelConfig.sdkMode || 'openai';
            let sdkName = 'OpenAI SDK';
            if (sdkMode === 'anthropic') {
                sdkName = 'Anthropic SDK';
            } else if (sdkMode === 'openai-sse') {
                sdkName = 'OpenAI SSE';
            } else if (sdkMode === 'openai-responses') {
                sdkName = 'OpenAI Responses API';
            } else if (sdkMode === 'gemini-sse') {
                sdkName = 'Gemini HTTP';
            }

            Logger.info(`Compatible Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

            // 计算输入 token 数量并更新状态栏
            const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

            // === Token 统计: 记录预估 token ===
            let requestId: string | null = null;
            try {
                const usagesManager = TokenUsagesManager.instance;

                // 获取实际提供商的 key 和显示名称
                const actualProviderKey = modelConfig.provider || this.providerKey;
                const actualDisplayName = modelConfig.provider
                    ? this.getProviderDisplayName(modelConfig.provider)
                    : currentConfig.displayName;

                requestId = await usagesManager.recordEstimatedTokens({
                    providerKey: actualProviderKey,
                    displayName: actualDisplayName,
                    modelId: model.id,
                    modelName: model.name,
                    estimatedInputTokens: totalInputTokens
                });
            } catch (err) {
                Logger.warn('记录预估Token失败:', err);
            }

            try {
                // 使用重试机制执行请求
                await this.retryManager.executeWithRetry(
                    async () => {
                        if (sdkMode === 'anthropic') {
                            await this.anthropicHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token,
                                requestId
                            );
                        } else if (sdkMode === 'gemini-sse') {
                            await this.geminiHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token,
                                requestId
                            );
                        } else if (sdkMode === 'openai-sse') {
                            // OpenAI 模式：使用自定义 SSE 流处理
                            await this.openaiCustomHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token,
                                requestId
                            );
                        } else if (sdkMode === 'openai-responses') {
                            // OpenAI Responses API 模式：使用 Responses API
                            await this.openaiResponsesHandler.handleResponsesRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token,
                                requestId
                            );
                        } else {
                            await this.openaiHandler.handleRequest(
                                model,
                                modelConfig,
                                messages,
                                options,
                                progress,
                                token,
                                requestId
                            );
                        }
                    },
                    error => RetryManager.isRateLimitError(error),
                    this.providerConfig.displayName
                );
            } catch (error) {
                const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
                Logger.error(errorMessage);

                // === Token 统计: 更新失败状态 ===
                if (requestId) {
                    try {
                        const usagesManager = TokenUsagesManager.instance;
                        await usagesManager.updateActualTokens({
                            requestId,
                            status: 'failed'
                        });
                    } catch (err) {
                        Logger.warn('更新Token统计失败:', err);
                    }
                }

                throw error;
            } finally {
                Logger.info(`✅ Compatible Provider: ${model.name} 请求已完成`);
                // 延时更新状态栏以反映最新余额
                StatusBarManager.compatible?.delayedUpdate(modelConfig.provider!, 2000);
            }
        } catch (error) {
            Logger.error('Compatible Provider 处理请求失败:', error);
            throw error;
        }
    }

    /**
     * 注册命令
     */
    private static registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];
        // 注册 manageModels 命令
        disposables.push(
            vscode.commands.registerCommand('gcmp.compatible.manageModels', async () => {
                try {
                    await CompatibleModelManager.configureModelOrUpdateAPIKey();
                } catch (error) {
                    Logger.error('管理 Compatible 模型失败:', error);
                    vscode.window.showErrorMessage(
                        `管理模型失败: ${error instanceof Error ? error.message : '未知错误'}`
                    );
                }
            })
        );
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.debug('Compatible Provider 命令已注册');
        return disposables;
    }

    /**
     * 静态工厂方法 - 创建并激活提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: CompatibleProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('Compatible Provider 已激活!');
        // 创建提供商实例
        const provider = new CompatibleProvider(context);
        // 注册语言模型聊天提供商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.compatible', provider);
        // 注册命令
        const commandDisposables = this.registerCommands(context);
        const disposables = [providerDisposable, ...commandDisposables];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
}
