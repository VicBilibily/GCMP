/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置和提供商配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ConfigProvider, UserConfigOverrides, ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { configProviders } from '../providers/config';

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
}

/**
 * GCMP配置接口
 */
export interface GCMPConfig {
    /** 温度参数，控制输出随机性 (0.0-2.0) */
    temperature: number;
    /** Top-p参数，控制输出多样性 (0.0-1.0) */
    topP: number;
    /** 最大输出token数量 */
    maxTokens: number;
    /** 是否记住上次选择的模型 */
    rememberLastModel: boolean;
    /** 智谱AI配置 */
    zhipu: ZhipuConfig;
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
    // 配置已迁移至 src/providers/config，不再需要 packageJsonCache

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
            temperature: this.validateTemperature(config.get<number>('temperature', 0.1)),
            topP: this.validateTopP(config.get<number>('topP', 1.0)),
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 8192)),
            rememberLastModel: config.get<boolean>('rememberLastModel', true),
            zhipu: {
                search: {
                    enableMCP: config.get<boolean>('zhipu.search.enableMCP', true) // 默认启用SSE模式（仅Pro+套餐支持）
                }
            },
            providerOverrides: config.get<UserConfigOverrides>('providerOverrides', {})
        };

        Logger.debug('配置已加载', this.cache);
        return this.cache;
    }

    /**
     * 获取温度参数
     */
    static getTemperature(): number {
        return this.getConfig().temperature;
    }

    /**
     * 获取Top-p参数
     */
    static getTopP(): number {
        return this.getConfig().topP;
    }

    /**
     * 获取最大token数量
     */
    static getMaxTokens(): number {
        return this.getConfig().maxTokens;
    }

    /**
     * 获取是否记住上次选择的模型
     */
    static getRememberLastModel(): boolean {
        return this.getConfig().rememberLastModel;
    }

    /**
     * 获取智谱AI搜索配置
     */
    static getZhipuSearchConfig(): ZhipuSearchConfig {
        return this.getConfig().zhipu.search;
    } /**
     * 获取智谱AI统一配置
     */
    static getZhipuConfig(): ZhipuConfig {
        return this.getConfig().zhipu;
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
     * 验证温度参数
     */
    private static validateTemperature(value: number): number {
        if (isNaN(value) || value < 0 || value > 2) {
            Logger.warn(`无效的temperature值: ${value}，使用默认值0.1`);
            return 0.1;
        }
        return value;
    }

    /**
     * 验证Top-p参数
     */
    private static validateTopP(value: number): number {
        if (isNaN(value) || value < 0 || value > 1) {
            Logger.warn(`无效的topP值: ${value}，使用默认值1.0`);
            return 1.0;
        }
        return value;
    }

    /**
     * 验证最大token数量
     */
    private static validateMaxTokens(value: number): number {
        if (isNaN(value) || value < 32 || value > 32768) {
            Logger.warn(`无效的maxTokens值: ${value}，使用默认值8192`);
            return 8192;
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

        Logger.info(`🔧 应用提供商 ${providerKey} 的配置覆盖`);

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
     * 获取动态的 kiloCode 头部配置
     * 由于已调整为使用专用 coding API 接口，不再需要模拟工具
     */
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
