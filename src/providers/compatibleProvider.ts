/*---------------------------------------------------------------------------------------------
 *  独立兼容供应商
 *  继承 GenericModelProvider，重写必要方法以支持完全用户配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { CompatibleModelManager } from '../utils/compatibleModelManager';
import { GenericModelProvider } from './genericModelProvider';

/**
 * 独立兼容模型供应商类
 * 继承 GenericModelProvider，重写模型配置获取方法
 */
export class CompatibleProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'compatible';
    private modelsChangeListener?: vscode.Disposable;

    constructor() {
        // 创建一个虚拟的 ProviderConfig，实际模型配置从 CompatibleModelManager 获取
        const virtualConfig: ProviderConfig = {
            displayName: 'Compatible',
            baseUrl: 'https://api.openai.com/v1', // 默认值，实际使用时会覆盖
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            models: [] // 空模型列表，实际从 CompatibleModelManager 获取
        };
        super(CompatibleProvider.PROVIDER_KEY, virtualConfig);

        this.getProviderConfig(); // 初始化配置缓存
        // 监听 CompatibleModelManager 的变更事件
        this.modelsChangeListener = CompatibleModelManager.onDidChangeModels(() => {
            this.getProviderConfig(); // 刷新配置缓存
            this._onDidChangeLanguageModelChatInformation.fire();
        });
    }

    override dispose(): void {
        this.modelsChangeListener?.dispose();
        super.dispose();
    }

    /**
     * 重写：获取动态的供应商配置
     * 从 CompatibleModelManager 获取用户配置的模型
     */
    getProviderConfig(): ProviderConfig {
        try {
            const models = CompatibleModelManager.getModels();
            // 将 CompatibleModelManager 的模型转换为 ModelConfig 格式
            const modelConfigs: ModelConfig[] = models.map(model => ({
                id: model.id,
                name: model.name,
                provider: model.provider,
                tooltip: model.tooltip || `自定义模型: ${model.name}`,
                maxInputTokens: model.maxInputTokens,
                maxOutputTokens: model.maxOutputTokens,
                sdkMode: model.sdkMode,
                capabilities: model.capabilities,
                ...(model.baseUrl && { baseUrl: model.baseUrl }),
                ...(model.model && { model: model.model }),
                ...(model.customHeader && { customHeader: model.customHeader }),
                ...(model.extraBody && { extraBody: model.extraBody })
            }));

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
     * 检查所有模型涉及的供应商的 API Key
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
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

            // 获取所有模型涉及的供应商（去重）
            const providers = new Set<string>();
            for (const model of currentConfig.models) {
                if (model.provider) {
                    providers.add(model.provider);
                }
            }
            // 检查每个供应商的 API Key
            for (const provider of providers) {
                if (!options.silent) {
                    // 非静默模式下，使用 ensureApiKey 逐一确认和设置
                    const hasValidKey = await ApiKeyManager.ensureApiKey(provider, provider, false);
                    if (!hasValidKey) {
                        Logger.warn(`Compatible Provider 用户未设置供应商 "${provider}" 的 API 密钥`);
                        return [];
                    }
                }
            }

            // 将最新配置中的模型转换为 VS Code 所需的格式
            const modelInfos = currentConfig.models.map(model => {
                const info = this.modelConfigToInfo(model);
                const sdkModeDisplay = model.sdkMode === 'anthropic' ? 'Anthropic' : 'OpenAI';
                return { ...info, detail: `${sdkModeDisplay} Compatible` };
            });
            Logger.debug(`Compatible Provider 提供了 ${modelInfos.length} 个模型信息`);
            return modelInfos;
        } catch (error) {
            Logger.error('获取 Compatible Provider 模型信息失败:', error);
            return [];
        }
    }

    /**
     * 重写：提供语言模型聊天响应
     * 使用最新的动态配置处理请求
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
            const sdkName = sdkMode === 'anthropic' ? 'Anthropic SDK' : 'OpenAI SDK';

            Logger.info(`Compatible Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

            try {
                if (sdkMode === 'anthropic') {
                    await this.anthropicHandler.handleRequest(model, modelConfig, messages, options, progress, token);
                } else {
                    await this.openaiHandler.handleRequest(model, modelConfig, messages, options, progress, token);
                }
            } catch (error) {
                const errorMessage = `错误: ${error instanceof Error ? error.message : '未知错误'}`;
                Logger.error(errorMessage);
                throw error;
            } finally {
                Logger.info(`✅ Compatible Provider: ${model.name} 请求已完成`);
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
     * 静态工厂方法 - 创建并激活供应商
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: CompatibleProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('Compatible Provider 已激活!');
        // 创建供应商实例
        const provider = new CompatibleProvider();
        // 注册语言模型聊天供应商
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('gcmp.compatible', provider);
        // 注册命令
        const commandDisposables = this.registerCommands(context);
        const disposables = [providerDisposable, ...commandDisposables];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
}
