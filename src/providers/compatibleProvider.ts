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
import { Logger, ApiKeyManager, CompatibleModelManager } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status';
import { KnownProviders } from '../utils';
import { configProviders } from './config';

/**
 * 独立兼容模型提供商类
 * 继承 GenericModelProvider，重写模型配置获取方法
 */
export class CompatibleProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'compatible';
    private modelsChangeListener?: vscode.Disposable;

    constructor(context: vscode.ExtensionContext) {
        // 创建一个虚拟的 ProviderConfig，实际模型配置从 CompatibleModelManager 获取
        const virtualConfig: ProviderConfig = {
            displayName: 'Compatible',
            baseUrl: 'https://api.openai.com/v1', // 默认值，实际使用时会覆盖
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            models: [] // 空模型列表，实际从 CompatibleModelManager 获取
        };
        super(context, CompatibleProvider.PROVIDER_KEY, virtualConfig);

        this.getProviderConfig(); // 初始化配置缓存
        // 监听 CompatibleModelManager 的变更事件
        this.modelsChangeListener = CompatibleModelManager.onDidChangeModels(() => {
            Logger.debug('[compatible] Received model change event, refreshing config and cache');
            this.getProviderConfig(); // 刷新配置缓存
            // 清除模型缓存
            this.modelInfoCache
                ?.invalidateCache(CompatibleProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[compatible] Cache invalidation failed:', err));
            this._onDidChangeLanguageModelChatInformation.fire();
            Logger.debug('[compatible] Language model info change event fired');
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
                    ...(model.endpoint && { endpoint: model.endpoint }),
                    ...(model.modelsEndpoint && { modelsEndpoint: model.modelsEndpoint }),
                    ...(model.model && { model: model.model }),
                    ...(customHeader && { customHeader: customHeader }),
                    ...(model.extraBody && { extraBody: model.extraBody }),
                    ...(model.proxy !== undefined && { proxy: model.proxy }),
                    ...(model.useInstructions !== undefined && { useInstructions: model.useInstructions }),
                    ...(model.webSearchTool !== undefined && { webSearchTool: model.webSearchTool }),
                    ...(model.family && { family: model.family }),
                    ...(model.thinking && { thinking: model.thinking }),
                    ...(model.thinkingFormat && { thinkingFormat: model.thinkingFormat }),
                    ...(model.reasoningFormat && { reasoningFormat: model.reasoningFormat }),
                    ...(model.reasoningEffort && { reasoningEffort: model.reasoningEffort }),
                    ...(model.contextSize && { contextSize: model.contextSize })
                };
            });

            Logger.debug(`Compatible Provider loaded ${modelConfigs.length} user-configured models`);

            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1', // 默认值，模型级别的配置会覆盖
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: modelConfigs
            };
        } catch (error) {
            Logger.error('Failed to get Compatible Provider config:', error);
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
            const cachedModels = await this.modelInfoCache?.getCachedModels(
                CompatibleProvider.PROVIDER_KEY,
                apiKeyHash
            );
            if (options.silent && cachedModels) {
                Logger.trace(`✓ Compatible Provider cache hit: ${cachedModels.length} models`);

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
                            Logger.debug('Auto-triggered model setup failed or cancelled by user');
                        }
                    });
                }
                return [];
            } else if (options.silent === false) {
                await CompatibleModelManager.configureModelOrUpdateAPIKey();
            }

            // 将最新配置中的模型转换为 VS Code 所需的格式
            const modelInfos = currentConfig.models.map(model => {
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

            Logger.debug(`Compatible Provider returned ${modelInfos.length} model info entries`); // Update cache asynchronously in the background
            this.updateModelCacheAsync(apiKeyHash);

            return modelInfos;
        } catch (error) {
            Logger.error('Failed to get Compatible Provider model info:', error);
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
                Logger.trace(
                    '[compatible] Background cache update failed:',
                    err instanceof Error ? err.message : String(err)
                );
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
        try {
            // 获取最新的动态配置
            const currentConfig = this.providerConfig;

            // 查找对应的模型配置
            // 查找对应的模型配置
            const modelConfig = this.findModelConfigById(model);
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
                throw new Error(`API key for model ${modelConfig.name} is not configured`);
            }

            // 根据模型的 sdkMode 选择使用的 handler
            const sdkMode = modelConfig.sdkMode || 'openai';
            const sdkName = this.getSdkDisplayName(sdkMode);
            Logger.info(`Compatible Provider started handling request (${sdkName}): ${modelConfig.name}`);

            // 计算输入 token 数量并更新状态栏
            const { totalInputTokens, maxInputTokens } = await this.updateContextUsageStatusBar(
                model,
                messages,
                modelConfig,
                options
            );

            // === Token 统计: 记录预估 token ===
            let requestId = '';
            const sessionId = this.getSessionIdFromMessages(messages, sdkMode);
            try {
                const usagesManager = TokenUsagesManager.instance;

                // 获取实际提供商的 key 和显示名称
                const actualProviderKey = modelConfig.provider || this.providerKey;
                const actualDisplayName =
                    modelConfig.provider ?
                        this.getProviderDisplayName(modelConfig.provider)
                    :   currentConfig.displayName;

                requestId = await usagesManager.recordEstimatedTokens({
                    providerKey: actualProviderKey,
                    displayName: actualDisplayName,
                    modelId: model.id,
                    modelName: model.name,
                    estimatedInputTokens: totalInputTokens,
                    maxInputTokens,
                    sessionId,
                    ...this.getEstimatedRequestMetadata(options)
                });
            } catch (err) {
                Logger.warn('Failed to record estimated tokens:', err);
            }

            try {
                await this.executeModelRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    requestId,
                    sessionId,
                    token,
                    modelConfig.provider || this.providerKey
                );
            } catch (error) {
                const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                Logger.error(errorMessage);
                this.reportRequestFailure(requestId, sessionId);
                throw error;
            } finally {
                Logger.info(`✅ Compatible Provider: ${model.name} request completed`);
                try {
                    // 延时更新状态栏以反映最新余额
                    StatusBarManager.compatible?.delayedUpdate(modelConfig.provider!, 2000);
                } catch (err) {
                    Logger.warn('Failed to update status bar:', err);
                }
            }
        } catch (error) {
            Logger.error('Compatible Provider request processing failed:', error);
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
                    Logger.error('Failed to manage Compatible models:', error);
                    vscode.window.showErrorMessage(
                        `管理模型失败: ${error instanceof Error ? error.message : '未知错误'}`
                    );
                }
            })
        );
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.debug('Compatible Provider commands registered');
        return disposables;
    }

    /**
     * 静态工厂方法 - 创建并激活提供商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: CompatibleProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('Compatible Provider activated!');
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
