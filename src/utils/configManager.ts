/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置和提供商配置
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ConfigProvider, UserConfigOverrides, ProviderConfig, ModelConfig, ModelOverride } from '../types/sharedTypes';
import { configProviders } from '../providers/config';
import { CommitFormat, CommitLanguage, CommitModelSelection } from '../commit/types';
import { t } from './l10n';
import { createProxiedFetch, redactProxyUrl, redactHeaders, sanitizeConfigForLogging } from './proxyAgent';

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
 * Xiaomi MiMo 配置
 */
export interface XiaomimimoConfig {
    /** Token Plan 接入点 */
    endpoint: 'cn' | 'sgp' | 'ams';
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
        proxy?: string;
        model: string;
        maxTokens: number;
        extraBody?: Record<string, unknown>;
    };
}
export type FIMCompletionConfig = Omit<NESCompletionConfig, 'manualOnly'>;

/**
 * 请求重试配置
 */
export interface RequestRetryConfig {
    maxAttempts: number;
}

/**
 * Commit 配置
 */
export interface CommitConfig {
    language: CommitLanguage;
    format: CommitFormat;
    customInstructions: string;
    sensitiveFiles: string[];
    model?: CommitModelSelection;
}

/**
 * GCMP配置接口
 */
export interface GCMPConfig {
    /** 最大输出token数量 */
    maxTokens: number;
    /** 请求失败重试配置 */
    retry: RequestRetryConfig;
    /** 智谱AI配置 */
    zhipu: ZhipuConfig;
    /** MiniMax配置 */
    minimax: MiniMaxConfig;
    /** Xiaomi MiMo配置 */
    xiaomimimo: XiaomimimoConfig;
    /** FIM补全配置 */
    fimCompletion: FIMCompletionConfig;
    /** NES补全配置 */
    nesCompletion: NESCompletionConfig;
    /** Commit 模块配置 */
    commit: CommitConfig;
    /** 全局代理服务器地址 */
    proxy?: string;
    /** 提供商配置覆盖 */
    providerOverrides: UserConfigOverrides;
}

interface ProxyFetchOptions {
    modelConfig?: Pick<ModelConfig, 'proxy' | 'provider'>;
    providerKey?: string;
    proxyUrl?: string;
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
                Logger.info('GCMP config updated, cache cleared');
            }
        });

        Logger.debug('Config manager initialized');
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
            maxTokens: this.validateMaxTokens(config.get<number>('maxTokens', 32000)),
            retry: {
                maxAttempts: this.validateRetryMaxAttempts(config.get<number>('retry.maxAttempts', 3))
            },
            zhipu: {
                search: {
                    enableMCP: config.get<boolean>('zhipu.search.enableMCP', true) // 默认启用MCP模式（Coding Plan专属）
                },
                endpoint: config.get<ZhipuConfig['endpoint']>('zhipu.endpoint', 'open.bigmodel.cn')
            },
            minimax: {
                endpoint: config.get<MiniMaxConfig['endpoint']>('minimax.endpoint', 'minimaxi.com')
            },
            xiaomimimo: {
                endpoint: config.get<XiaomimimoConfig['endpoint']>('xiaomimimo.endpoint', 'cn')
            },
            fimCompletion: {
                enabled: config.get<boolean>('fimCompletion.enabled', false),
                debounceMs: this.validateNESDebounceMs(config.get<number>('fimCompletion.debounceMs', 500)),
                timeoutMs: this.validateNESTimeoutMs(config.get<number>('fimCompletion.timeoutMs', 5000)),
                modelConfig: {
                    provider: config.get<string>('fimCompletion.modelConfig.provider', ''),
                    baseUrl: config.get<string>('fimCompletion.modelConfig.baseUrl', ''),
                    proxy: config.get<string>('fimCompletion.modelConfig.proxy'),
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
                    proxy: config.get<string>('nesCompletion.modelConfig.proxy'),
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
                sensitiveFiles: (config.get<string[]>('commit.sensitiveFiles') ?? [])
                    .map(item => item.trim())
                    .filter(Boolean),
                model: config.get<CommitModelSelection>('commit.model')
            },
            proxy: config.get<string>('proxy') || undefined,
            providerOverrides: config.get<UserConfigOverrides>('providerOverrides', {})
        };

        Logger.debug('Config loaded', sanitizeConfigForLogging(this.cache));
        return this.cache;
    }

    /**
     * 获取最大token数量
     */
    static getMaxTokens(): number {
        return this.getConfig().maxTokens;
    }

    /**
     * 获取请求重试配置
     */
    static getRetryConfig(): RequestRetryConfig {
        return this.getConfig().retry;
    }

    /**
     * 获取最大重试次数
     */
    static getRetryMaxAttempts(): number {
        return this.getRetryConfig().maxAttempts;
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
     * 获取 MiniMax Token Plan 接入点配置
     * @returns 'minimaxi.com' 或 'minimax.io'，默认 'minimaxi.com'
     */
    static getMinimaxEndpoint(): 'minimaxi.com' | 'minimax.io' {
        return this.getConfig().minimax.endpoint;
    }

    /**
     * 获取 Xiaomi MiMo Token Plan 接入点配置
     * @returns 'cn' | 'sgp' | 'ams'，默认 'cn'
     */
    static getXiaomimimoEndpoint(): XiaomimimoConfig['endpoint'] {
        return this.getConfig().xiaomimimo.endpoint;
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
            Logger.warn(`Invalid maxTokens value: ${value}; using default 32000`);
            return 32000;
        }
        return Math.floor(value);
    }

    /**
     * 验证最大重试次数
     */
    private static validateRetryMaxAttempts(value: number): number {
        if (isNaN(value) || value < 1 || value > 5) {
            Logger.warn(`Invalid retry.maxAttempts value: ${value}; using default 3`);
            return 3;
        }
        return Math.floor(value);
    }

    /**
     * 验证防抖延迟时间
     */
    private static validateNESDebounceMs(value: number): number {
        if (isNaN(value) || value < 50 || value > 2000) {
            Logger.warn(`Invalid debounceMs value: ${value}; using default 500`);
            return 500;
        }
        return Math.floor(value);
    }

    /**
     * 验证超时时间
     */
    private static validateNESTimeoutMs(value: number): number {
        if (isNaN(value) || value < 1000 || value > 30000) {
            Logger.warn(`Invalid timeoutMs value: ${value}; using default 5000`);
            return 5000;
        }
        return Math.floor(value);
    }

    /**
     * 验证NES补全的maxTokens参数
     */
    private static validateNESMaxTokens(value: number): number {
        if (isNaN(value) || value < 50 || value > 16000) {
            Logger.warn(`Invalid NES maxTokens value: ${value}; using default 200`);
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

        Logger.debug(`Applying config overrides for provider ${providerKey}`);

        // 创建配置的深拷贝
        const config: ProviderConfig = JSON.parse(JSON.stringify(originalConfig));

        const applyModelOverride = (target: ModelConfig, modelOverride: ModelOverride): void => {
            if (modelOverride.name !== undefined) {
                target.name = modelOverride.name;
                Logger.debug(`  Model ${modelOverride.id}: override name = ${modelOverride.name}`);
            }
            if (modelOverride.tooltip !== undefined) {
                target.tooltip = modelOverride.tooltip;
                Logger.debug(`  Model ${modelOverride.id}: override tooltip = ${modelOverride.tooltip}`);
            }
            if (modelOverride.model !== undefined) {
                target.model = modelOverride.model;
                Logger.debug(`  Model ${modelOverride.id}: override model = ${modelOverride.model}`);
            }
            if (modelOverride.maxInputTokens !== undefined) {
                target.maxInputTokens = modelOverride.maxInputTokens;
                Logger.debug(`  Model ${modelOverride.id}: override maxInputTokens = ${modelOverride.maxInputTokens}`);
            }
            if (modelOverride.maxOutputTokens !== undefined) {
                target.maxOutputTokens = modelOverride.maxOutputTokens;
                Logger.debug(
                    `  Model ${modelOverride.id}: override maxOutputTokens = ${modelOverride.maxOutputTokens}`
                );
            }
            if (modelOverride.sdkMode !== undefined) {
                target.sdkMode = modelOverride.sdkMode;
                Logger.debug(`  Model ${modelOverride.id}: override sdkMode = ${modelOverride.sdkMode}`);
            }
            if (modelOverride.baseUrl !== undefined) {
                target.baseUrl = modelOverride.baseUrl;
                Logger.debug(`  Model ${modelOverride.id}: override baseUrl = ${modelOverride.baseUrl}`);
            }
            if (modelOverride.useInstructions !== undefined) {
                target.useInstructions = modelOverride.useInstructions;
                Logger.debug(
                    `  Model ${modelOverride.id}: override useInstructions = ${modelOverride.useInstructions}`
                );
            }
            if (modelOverride.webSearchTool !== undefined) {
                target.webSearchTool = modelOverride.webSearchTool;
                Logger.debug(`  Model ${modelOverride.id}: override webSearchTool = ${modelOverride.webSearchTool}`);
            }
            if (modelOverride.family !== undefined) {
                target.family = modelOverride.family;
                Logger.debug(`  Model ${modelOverride.id}: override family = ${modelOverride.family}`);
            }
            if (modelOverride.thinking !== undefined) {
                target.thinking = [...modelOverride.thinking];
                Logger.debug(
                    `  Model ${modelOverride.id}: override thinking = ${JSON.stringify(modelOverride.thinking)}`
                );
            }
            if (modelOverride.thinkingFormat !== undefined) {
                target.thinkingFormat = modelOverride.thinkingFormat;
                Logger.debug(`  Model ${modelOverride.id}: override thinkingFormat = ${modelOverride.thinkingFormat}`);
            }
            if (modelOverride.reasoningEffort !== undefined) {
                target.reasoningEffort = [...modelOverride.reasoningEffort];
                Logger.debug(
                    `  Model ${modelOverride.id}: override reasoningEffort = ${JSON.stringify(modelOverride.reasoningEffort)}`
                );
            }
            if (modelOverride.contextSize !== undefined) {
                target.contextSize = [...modelOverride.contextSize];
                Logger.debug(
                    `  模型 ${modelOverride.id}: 覆盖 contextSize = ${JSON.stringify(modelOverride.contextSize)}`
                );
            }
            if (modelOverride.serviceTier !== undefined) {
                target.serviceTier = [...modelOverride.serviceTier];
                Logger.debug(
                    `  Model ${modelOverride.id}: override serviceTier = ${JSON.stringify(modelOverride.serviceTier)}`
                );
            }
            if (modelOverride.capabilities) {
                target.capabilities = {
                    ...target.capabilities,
                    ...modelOverride.capabilities
                };
                Logger.debug(
                    `  Model ${modelOverride.id}: merge capabilities = ${JSON.stringify(target.capabilities)}`
                );
            }
            if (modelOverride.customHeader) {
                target.customHeader = { ...target.customHeader, ...modelOverride.customHeader };
                Logger.debug(
                    `  Model ${modelOverride.id}: merge customHeader = ${JSON.stringify(redactHeaders(target.customHeader))}`
                );
            }
            if (modelOverride.extraBody) {
                target.extraBody = { ...target.extraBody, ...modelOverride.extraBody };
                Logger.debug(`  Model ${modelOverride.id}: merge extraBody = ${JSON.stringify(target.extraBody)}`);
            }
            if (modelOverride.proxy !== undefined) {
                target.proxy = modelOverride.proxy;
                Logger.debug(
                    `  Model ${modelOverride.id}: override proxy = ${redactProxyUrl(modelOverride.proxy) || '(cleared)'}`
                );
            }
        };

        // 应用提供商级别的覆盖
        if (override.baseUrl) {
            config.baseUrl = override.baseUrl;
            Logger.debug(`  Override baseUrl: ${override.baseUrl}`);
        }
        if (override.proxy !== undefined) {
            config.proxy = override.proxy;
            Logger.debug(`  Override proxy: ${redactProxyUrl(override.proxy) || '(cleared)'}`);
        }
        if (override.customHeader) {
            config.customHeader = { ...config.customHeader, ...override.customHeader };
            Logger.debug(`  Override provider customHeader = ${JSON.stringify(redactHeaders(config.customHeader))}`);
        }

        // 应用模型级别的覆盖
        if (override.models && override.models.length > 0) {
            for (const modelOverride of override.models) {
                const existingModelIndex = config.models.findIndex(m => m.id === modelOverride.id);
                if (existingModelIndex >= 0) {
                    // 覆盖现有模型
                    const existingModel = config.models[existingModelIndex];
                    applyModelOverride(existingModel, modelOverride);
                } else {
                    // 添加新模型
                    const newModel: ModelConfig = {
                        id: modelOverride.id,
                        name: modelOverride.name || modelOverride.id,
                        tooltip:
                            modelOverride.tooltip || t('Custom model: {0}', '用户自定义模型: {0}', modelOverride.id),
                        maxInputTokens: modelOverride.maxInputTokens || 128000,
                        maxOutputTokens: modelOverride.maxOutputTokens || 8192,
                        capabilities: {
                            toolCalling: modelOverride.capabilities?.toolCalling ?? false,
                            imageInput: modelOverride.capabilities?.imageInput ?? false
                        }
                    };
                    applyModelOverride(newModel, modelOverride);
                    config.models.push(newModel);
                    Logger.info(`  Added new model: ${modelOverride.id}`);
                }
            }
        }

        // 将提供商级别的 proxy 合并到所有模型中（模型级别 proxy 优先）
        if (override.proxy !== undefined) {
            for (const model of config.models) {
                if (model.proxy === undefined) {
                    model.proxy = override.proxy;
                }
            }
            Logger.debug(`  Provider ${providerKey}: merged provider-level proxy into all models`);
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
            Logger.debug(`  Provider ${providerKey}: merged provider-level customHeader into all models`);
        }

        return config;
    }

    /**
     * 获取全局代理设置
     */
    static getProxy(): string | undefined {
        return this.getConfig().proxy;
    }

    /**
     * 解析模型请求应使用的代理地址
     * 优先级：model.proxy > providerOverrides.{provider}.proxy > provider config.proxy > gcmp.proxy > VS Code http.proxy > 环境变量
     */
    static resolveProxyForModel(
        modelConfig?: Pick<ModelConfig, 'proxy' | 'provider'>,
        providerKey?: string
    ): string | undefined {
        // 1. 模型级别
        if (modelConfig?.proxy !== undefined) {
            if (modelConfig.proxy) {
                Logger.debug(`[Proxy] Using model-level proxy: ${redactProxyUrl(modelConfig.proxy)}`);
            }
            return modelConfig.proxy || undefined;
        }

        // 2. providerOverrides 级别
        // 兼容模型（providerKey === 'compatible'）时，优先使用 modelConfig.provider 指定的 provider
        const effectiveProviderKey = providerKey === 'compatible' ? modelConfig?.provider : providerKey;

        if (effectiveProviderKey) {
            const overrides = this.getProviderOverrides();
            const providerOverride = overrides[effectiveProviderKey];
            if (providerOverride?.proxy !== undefined) {
                if (providerOverride.proxy) {
                    Logger.debug(`[Proxy] Using provider-level proxy: ${redactProxyUrl(providerOverride.proxy)}`);
                }
                return providerOverride.proxy || undefined;
            }

            // 3. providerConfig 级别
            const originalProviderConfig =
                effectiveProviderKey in configProviders ?
                    configProviders[effectiveProviderKey as keyof typeof configProviders]
                :   undefined;
            if (originalProviderConfig?.proxy) {
                Logger.debug(`[Proxy] Using provider config proxy: ${redactProxyUrl(originalProviderConfig.proxy)}`);
                return originalProviderConfig.proxy;
            }
        }

        // 4. 全局设置
        const globalProxy = this.getProxy();
        if (globalProxy) {
            Logger.debug(`[Proxy] Using global proxy: ${redactProxyUrl(globalProxy)}`);
            return globalProxy;
        }

        // 5. VS Code 代理设置
        // proxySupport 可选值：'off'（禁用）| 'on'（强制）| 'override'（默认，仅对 VS Code 托管的请求生效）
        // 对扩展自身发起的 fetch，'override' 和 'on' 均应启用代理
        const httpConfig = vscode.workspace.getConfiguration('http');
        const proxySupport = httpConfig.get<string>('proxySupport');
        const vscodeProxy = httpConfig.get<string>('proxy');
        if (proxySupport !== 'off' && vscodeProxy) {
            Logger.debug(`[Proxy] Using VS Code proxy: ${redactProxyUrl(vscodeProxy)}`);
            return vscodeProxy;
        }

        // 6. 环境变量 fallback
        const envProxy =
            process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
        if (envProxy) {
            Logger.debug(`[Proxy] Using environment proxy: ${redactProxyUrl(envProxy)}`);
            return envProxy;
        }

        return undefined;
    }

    /**
     * 创建已按模型/提供商配置解析代理的 fetch 实现
     */
    static createProxyAwareFetch(options: ProxyFetchOptions = {}): typeof fetch {
        const hasExplicitProxyUrl = Object.prototype.hasOwnProperty.call(options, 'proxyUrl');
        const proxyUrl =
            hasExplicitProxyUrl ?
                options.proxyUrl
            :   this.resolveProxyForModel(options.modelConfig, options.providerKey);
        return createProxiedFetch(proxyUrl);
    }

    /**
     * 使用已解析代理的 fetch 发起请求
     */
    static fetchWithProxy(
        input: string | URL | Request,
        init?: RequestInit,
        options: ProxyFetchOptions = {}
    ): Promise<Response> {
        return this.createProxyAwareFetch(options)(input, init);
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
        Logger.trace('Config manager disposed');
    }
}
