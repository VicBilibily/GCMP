/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置和提供商配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ConfigProvider, UserConfigOverrides, ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { configProviders } from '../providers/config';
import { CommitFormat, CommitLanguage, CommitModelSelection } from '../commit/types';

/**
 * 智谱AI搜索配置
 */
export interface ZhipuSearchConfig {
    /** 是否启用SSE通讯模式（仅Pro+套餐支持） */
    enableMCP: boolean;
}

/**
 * 智谱AI统一配置
 */
export interface ZhipuConfig {
    /** 搜索功能配置 */
    search: ZhipuSearchConfig;
    /** 接入站点 */
    endpoint: 'open.bigmodel.cn' | 'api.z.ai';
}

/**
 * MiniMax 配置
 */
export interface MiniMaxConfig {
    /** Coding Plan 接入点 */
    endpoint: 'minimaxi.com' | 'minimax.io';
}

/**
 * NES 补全配置
 */
export interface NESCompletionConfig {
    enabled: boolean;
    debounceMs: number;
    timeoutMs: number; // 请求超时时间
    manualOnly: boolean; // 仅手动触发模式
    modelConfig: {
        provider: string;
        baseUrl: string;
        model: string;
        maxTokens: number;
        extraBody?: Record<string, unknown>;
    };
}
export type FIMCompletionConfig = Omit<NESCompletionConfig, 'manualOnly'>;

/**
 * Commit 配置
 */
export interface CommitConfig {
    language: CommitLanguage;
    format: CommitFormat;
    customInstructions: string;
    model?: CommitModelSelection;
}

/**
 * GCMP配置接口
 */
export interface GCMPConfig {
    /** 最大输出token数量 */
    maxTokens: number;
    /** 自动为模型ID添加提供商前缀 */
    autoPrefixModelId: boolean;
    /** 智谱AI配置 */
    zhipu: ZhipuConfig;
    /** MiniMax配置 */
    minimax: MiniMaxConfig;
    /** FIM补全配置 */
    fimCompletion: FIMCompletionConfig;
    /** NES补全配置 */
    nesCompletion: NESCompletionConfig;
    /** Commit 模块配置 */
    commit: CommitConfig;
    /** 提供商配置覆盖 */
    providerOverrides: UserConfigOverrides;
}

/**
 * 配置管理器类
 * 负责读取和管理 VS Code 设置中的 GCMP 配置以及package.json中的提供商配置
 */
export class ConfigManager {
    private static readonly CONFIG_SECTION = 'gcmp';
    private static cache: GCMPConfig | null = null;
    private static configListener: vscode.Disposable | null = null;

    /**
     * 初始化配置管理器
     * 设置配置变更监听器
     */
    static initialize(): vscode.Disposable {
        // 清理之前的监听器
        if (this.configListener) {
            this.configListener.dispose();
        }

        // 设置配置变更监听器
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(this.CONFIG_SECTION)) {
                this.cache = null; // 清除缓存，强制重新读取
                Logger.info('GCMP配置已更新，缓存已清除');
            }
        });

        Logger.debug('配置管理器已初始化');
        return this.configListener;
    }

    /**
     * 获取当前配置
     * 使用缓存机制提高性能
     */
    static getConfig(): GCMPConfig {
        if (this.cache) {
            return this.cache;
        }

        const config = vscode.workspace.getConfiguration(this.CONFIG_SECTION);

        this.cache = {
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 256000)),
            autoPrefixModelId: config.get<boolean>('autoPrefixModelId', false),
            zhipu: {
                search: {
                    enableMCP: config.get<boolean>('zhipu.search.enableMCP', true) // 默认启用MCP模式（Coding Plan专属）
                },
                endpoint: config.get<ZhipuConfig['endpoint']>('zhipu.endpoint', 'open.bigmodel.cn')
            },
            minimax: {
                endpoint: config.get<MiniMaxConfig['endpoint']>('minimax.endpoint', 'minimaxi.com')
            },
            fimCompletion: {
                enabled: config.get<boolean>('fimCompletion.enabled', false),
                debounceMs: this.validateNESDebounceMs(config.get<number>('fimCompletion.debounceMs', 500)),
                timeoutMs: this.validateNESTimeoutMs(config.get<number>('fimCompletion.timeoutMs', 5000)),
                modelConfig: {
                    provider: config.get<string>('fimCompletion.modelConfig.provider', ''),
                    baseUrl: config.get<string>('fimCompletion.modelConfig.baseUrl', ''),
                    model: config.get<string>('fimCompletion.modelConfig.model', ''),
                    maxTokens: this.validateNESMaxTokens(
                        config.get<number>('fimCompletion.modelConfig.maxTokens', 200)
                    ),
                    extraBody: config.get('fimCompletion.modelConfig.extraBody')
                }
            },
            nesCompletion: {
                enabled: config.get<boolean>('nesCompletion.enabled', false),
                debounceMs: this.validateNESDebounceMs(config.get<number>('nesCompletion.debounceMs', 500)),
                timeoutMs: this.validateNESTimeoutMs(config.get<number>('nesCompletion.timeoutMs', 5000)),
                manualOnly: config.get<boolean>('nesCompletion.manualOnly', false),
                modelConfig: {
                    provider: config.get<string>('nesCompletion.modelConfig.provider', ''),
                    baseUrl: config.get<string>('nesCompletion.modelConfig.baseUrl', ''),
                    model: config.get<string>('nesCompletion.modelConfig.model', ''),
                    maxTokens: this.validateNESMaxTokens(
                        config.get<number>('nesCompletion.modelConfig.maxTokens', 200)
                    ),
                    extraBody: config.get('nesCompletion.modelConfig.extraBody')
                }
            },
            commit: {
                // VS Code 会自动应用 package.json configuration contribution 的 default。
                language: (config.get<CommitLanguage>('commit.language') ?? 'chinese') as CommitLanguage,
                format: (config.get<CommitFormat>('commit.format') ?? 'auto') as CommitFormat,
                customInstructions: config.get<string>('commit.customInstructions') ?? '',
                model: config.get<CommitModelSelection>('commit.model')
            },
            providerOverrides: config.get<UserConfigOverrides>('providerOverrides', {})
        };

        Logger.debug('配置已加载', this.cache);
        return this.cache;
    }

    /**
     * 获取最大token数量
     */
    static getMaxTokens(): number {
        return this.getConfig().maxTokens;
    }
    /**
     * 获取是否为模型ID自动添加提供商前缀的配置
     */
    static getAutoPrefixModelId(): boolean {
        return this.getConfig().autoPrefixModelId;
    }
    /**
     * 获取智谱AI搜索配置
     */
    static getZhipuSearchConfig(): ZhipuSearchConfig {
        return this.getConfig().zhipu.search;
    }

    /**
     * 获取智谱AI统一配置
     */
    static getZhipuConfig(): ZhipuConfig {
        return this.getConfig().zhipu;
    }

    /**
     * 获取智谱AI接入点配置
     * @returns 'open.bigmodel.cn' 或 'api.z.ai'，默认 'open.bigmodel.cn'
     */
    static getZhipuEndpoint(): 'open.bigmodel.cn' | 'api.z.ai' {
        return this.getConfig().zhipu.endpoint;
    }

    /**
     * 获取 MiniMax Coding Plan 接入点配置
     * @returns 'minimaxi.com' 或 'minimax.io'，默认 'minimaxi.com'
     */
    static getMinimaxEndpoint(): 'minimaxi.com' | 'minimax.io' {
        return this.getConfig().minimax.endpoint;
    }

    /**
     * 获取FIM补全配置
     */
    static getFIMConfig(): FIMCompletionConfig {
        return this.getConfig().fimCompletion;
    }

    /**
     * 获取NES补全配置
     */
    static getNESConfig(): NESCompletionConfig {
        return this.getConfig().nesCompletion;
    }

    /**
     * 获取 Commit 配置对象
     */
    static getCommitConfig(): CommitConfig {
        return this.getConfig().commit;
    }

    /**
     * 获取适合模型的最大token数量
     * 考虑模型限制和用户配置
     */
    static getMaxTokensForModel(modelMaxTokens: number): number {
        const configMaxTokens = this.getMaxTokens();
        return Math.min(modelMaxTokens, configMaxTokens);
    }

    /**
     * 验证最大token数量
     */
    private static validateMaxTokens(value: number): number {
        if (isNaN(value) || value < 32 || value > 256000) {
            Logger.warn(`无效的maxTokens值: ${value}，使用默认值16000`);
            return 16000;
        }
        return Math.floor(value);
    }

    /**
     * 验证防抖延迟时间
     */
    private static validateNESDebounceMs(value: number): number {
        if (isNaN(value) || value < 50 || value > 2000) {
            Logger.warn(`无效的debounceMs值: ${value}，使用默认值500`);
            return 500;
        }
        return Math.floor(value);
    }

    /**
     * 验证超时时间
     */
    private static validateNESTimeoutMs(value: number): number {
        if (isNaN(value) || value < 1000 || value > 30000) {
            Logger.warn(`无效的timeoutMs值: ${value}，使用默认值5000`);
            return 5000;
        }
        return Math.floor(value);
    }

    /**
     * 验证NES补全的maxTokens参数
     */
    private static validateNESMaxTokens(value: number): number {
        if (isNaN(value) || value < 50 || value > 16000) {
            Logger.warn(`无效的NES maxTokens值: ${value}，使用默认值200`);
            return 200;
        }
        return Math.floor(value);
    }

    /**
     * 获取提供商配置（新模式：直接 import configProviders）
     */
    static getConfigProvider(): ConfigProvider {
        return configProviders;
    }

    /**
     * 获取配置覆盖设置
     */
    static getProviderOverrides(): UserConfigOverrides {
        return this.getConfig().providerOverrides;
    }

    /**
     * 应用配置覆盖到原始提供商配置
     */
    static applyProviderOverrides(providerKey: string, originalConfig: ProviderConfig): ProviderConfig {
        const overrides = this.getProviderOverrides();
        const override = overrides[providerKey];

        if (!override) {
            return originalConfig;
        }

        Logger.debug(`🔧 应用提供商 ${providerKey} 的配置覆盖`);

        // 创建配置的深拷贝
        const config: ProviderConfig = JSON.parse(JSON.stringify(originalConfig));

        // 应用提供商级别的覆盖
        if (override.baseUrl) {
            config.baseUrl = override.baseUrl;
            Logger.debug(`  覆盖 baseUrl: ${override.baseUrl}`);
        }

        // 应用模型级别的覆盖
        if (override.models && override.models.length > 0) {
            for (const modelOverride of override.models) {
                const existingModelIndex = config.models.findIndex(m => m.id === modelOverride.id);
                if (existingModelIndex >= 0) {
                    // 覆盖现有模型
                    const existingModel = config.models[existingModelIndex];
                    if (modelOverride.model !== undefined) {
                        existingModel.model = modelOverride.model;
                        Logger.debug(`  模型 ${modelOverride.id}: 覆盖 model = ${modelOverride.model}`);
                    }
                    if (modelOverride.maxInputTokens !== undefined) {
                        existingModel.maxInputTokens = modelOverride.maxInputTokens;
                        Logger.debug(
                            `  模型 ${modelOverride.id}: 覆盖 maxInputTokens = ${modelOverride.maxInputTokens}`
                        );
                    }
                    if (modelOverride.maxOutputTokens !== undefined) {
                        existingModel.maxOutputTokens = modelOverride.maxOutputTokens;
                        Logger.debug(
                            `  模型 ${modelOverride.id}: 覆盖 maxOutputTokens = ${modelOverride.maxOutputTokens}`
                        );
                    }
                    // 覆盖 sdkMode
                    if (modelOverride.sdkMode !== undefined) {
                        existingModel.sdkMode = modelOverride.sdkMode;
                        Logger.debug(`  模型 ${modelOverride.id}: 覆盖 sdkMode = ${modelOverride.sdkMode}`);
                    }
                    if (modelOverride.baseUrl !== undefined) {
                        existingModel.baseUrl = modelOverride.baseUrl;
                        Logger.debug(`  模型 ${modelOverride.id}: 覆盖 baseUrl = ${modelOverride.baseUrl}`);
                    }
                    if (modelOverride.webSearchTool !== undefined) {
                        existingModel.webSearchTool = modelOverride.webSearchTool;
                        Logger.debug(`  模型 ${modelOverride.id}: 覆盖 webSearchTool = ${modelOverride.webSearchTool}`);
                    }
                    // 合并 capabilities
                    if (modelOverride.capabilities) {
                        existingModel.capabilities = {
                            ...existingModel.capabilities,
                            ...modelOverride.capabilities
                        };
                        Logger.debug(
                            `  模型 ${modelOverride.id}: 合并 capabilities = ${JSON.stringify(existingModel.capabilities)}`
                        );
                    }
                    // 合并 customHeader（模型级别优先于提供商级别）
                    if (modelOverride.customHeader) {
                        existingModel.customHeader = { ...existingModel.customHeader, ...modelOverride.customHeader };
                        Logger.debug(
                            `  模型 ${modelOverride.id}: 合并 customHeader = ${JSON.stringify(existingModel.customHeader)}`
                        );
                    }
                    // 合并 extraBody
                    if (modelOverride.extraBody) {
                        existingModel.extraBody = { ...existingModel.extraBody, ...modelOverride.extraBody };
                        Logger.debug(
                            `  模型 ${modelOverride.id}: 合并 extraBody = ${JSON.stringify(existingModel.extraBody)}`
                        );
                    }
                } else {
                    const fullConfig = modelOverride as ModelConfig;
                    // 添加新模型
                    const newModel: ModelConfig = {
                        id: modelOverride.id,
                        name: fullConfig?.name || modelOverride.id, // 默认使用ID作为名称
                        tooltip: fullConfig?.tooltip || `用户自定义模型: ${modelOverride.id}`,
                        maxInputTokens: modelOverride.maxInputTokens || 128000,
                        maxOutputTokens: modelOverride.maxOutputTokens || 8192,
                        capabilities: {
                            toolCalling: modelOverride.capabilities?.toolCalling ?? false,
                            imageInput: modelOverride.capabilities?.imageInput ?? false
                        },
                        ...(modelOverride.model && { model: modelOverride.model }),
                        ...(modelOverride.sdkMode && { sdkMode: modelOverride.sdkMode }),
                        ...(modelOverride.baseUrl && { baseUrl: modelOverride.baseUrl }),
                        ...(modelOverride.webSearchTool !== undefined && {
                            webSearchTool: modelOverride.webSearchTool
                        }),
                        ...(modelOverride.customHeader && { customHeader: modelOverride.customHeader }),
                        ...(modelOverride.extraBody && { extraBody: modelOverride.extraBody })
                    };
                    config.models.push(newModel);
                    Logger.info(`  添加新模型: ${modelOverride.id}`);
                }
            }
        }

        // 将提供商级别的 customHeader 合并到所有模型中（模型级别 customHeader 优先）
        if (override.customHeader) {
            for (const model of config.models) {
                if (model.customHeader) {
                    // 如果模型已有 customHeader，提供商级别的作为默认值合并
                    model.customHeader = { ...override.customHeader, ...model.customHeader };
                } else {
                    // 如果模型没有 customHeader，直接使用提供商级别的
                    model.customHeader = { ...override.customHeader };
                }
            }
            Logger.debug(`  提供商 ${providerKey}: 将提供商级别 customHeader 合并到所有模型中`);
        }

        return config;
    }

    /**
     * 清理资源
     */
    static dispose(): void {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this.cache = null;
        Logger.trace('配置管理器已清理');
    }
}
