/*---------------------------------------------------------------------------------------------
 *  配置管理器
 *  用于管理GCMP扩展的全局配置设置和提供商配置
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import {
    ConfigProvider,
    ModelTokenPricingInput,
    UserConfigOverrides,
    ProviderConfig,
    ProviderRetryOverride,
    ModelConfig,
    ModelOverride
} from '../types/sharedTypes';
import { collectInvalidTierCrons, normalizeTokenPricing } from './pricingTierResolver';
import { configProviders } from '../providers/config';
import { CommitFormat, CommitLanguage, ModelSelection } from '../commit/types';
import { InterInstanceBus } from '../interInstance';
import { t } from './l10n';
import {
    createProxiedFetch,
    NO_PROXY_SENTINEL,
    isNoProxyValue,
    redactProxyUrl,
    redactHeaders,
    sanitizeConfigForLogging
} from './proxyAgent';
import { HarRecorder } from './harRecorder';

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
 * 阶跃星辰 StepFun 搜索配置
 */
export interface StepFunSearchConfig {
    /** 是否启用 MCP 模式（Step Plan 套餐专属） */
    enableMCP: boolean;
}

/**
 * 阶跃星辰 StepFun 统一配置
 */
export interface StepFunConfig {
    /** 搜索功能配置 */
    search: StepFunSearchConfig;
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
    enabled: boolean;
    maxAttempts: number;
}

/**
 * 内置重试延迟默认值。
 * 与 RetryManager.DEFAULT_RETRY_CONFIG 的 initialDelayMs / maxDelayMs 保持一致，
 * 在 provider override 未显式设置延迟时作为回退基准。
 */
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 15000;

/**
 * Commit 配置
 */
export interface CommitConfig {
    language: CommitLanguage;
    format: CommitFormat;
    customInstructions: string;
    sensitiveFiles: string[];
    model?: ModelSelection;
}

/**
 * 视觉分析配置
 */
export interface VisionConfig {
    /** 委派模型配置 */
    model: ModelSelection;
}

/**
 * 调试配置
 */
export interface DebugConfig {
    /** 是否将所有 HTTP 请求记录为 HAR 文件 */
    captureHar: boolean;
    /** 保留的 HAR 文件数量（默认 7，0 表示仅禁用按数量清理，2 小时硬删除仍生效） */
    harRetentionCount: number;
}

/**
 * GCMP配置接口
 */
export interface GCMPConfig {
    /** 调试配置 */
    debug: DebugConfig;
    /** 请求失败重试配置 */
    retry: RequestRetryConfig;
    /** 智谱AI配置 */
    zhipu: ZhipuConfig;
    /** 阶跃星辰 StepFun 配置 */
    stepfun: StepFunConfig;
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
    /** 视觉分析配置 */
    vision: VisionConfig;
}

interface ProxyFetchOptions {
    modelConfig?: Pick<ModelConfig, 'proxy' | 'provider'>;
    providerKey?: string;
    proxyUrl?: string;
    /** 跳过 HAR 记录。FIM/NES 补全等高频请求应设为 true */
    skipHar?: boolean;
}

/**
 * 配置管理器类
 * 负责读取和管理 VS Code 设置中的 GCMP 配置以及package.json中的提供商配置
 */
export class ConfigManager {
    private static readonly CONFIG_SECTION = 'gcmp';
    private static cache: GCMPConfig | null = null;
    private static configListener: vscode.Disposable | null = null;
    private static context: vscode.ExtensionContext | null = null;
    private static extensionVersion: string | null = null;

    /**
     * 解析 provider 代理查找键。
     * 顺序：精确 providerKey -> 所属根 providerKey（如 minimax-token -> minimax）-> compatible（仅非内置 provider）
     */
    private static getProxyLookupKeys(providerKey?: string): string[] {
        if (!providerKey) {
            return [];
        }

        const lookupKeys = new Set<string>([providerKey]);

        // 内置 provider：直接返回自身
        if (providerKey in configProviders) {
            Logger.debug(
                `[Config] getProxyLookupKeys("${providerKey}"): built-in provider, returning [${providerKey}]`
            );
            return Array.from(lookupKeys);
        }

        // 非内置：查找是否属于内置 provider 的子 provider（如 dashscope-coding → dashscope）
        for (const [rootProviderKey, providerConfig] of Object.entries(configProviders)) {
            if (providerConfig.models.some(model => model.provider === providerKey)) {
                lookupKeys.add(rootProviderKey);
                Logger.debug(
                    `[Config] getProxyLookupKeys("${providerKey}"): found sub-provider of "${rootProviderKey}", returning [${Array.from(lookupKeys).join(', ')}]`
                );
                return Array.from(lookupKeys);
            }
        }

        // 非内置子 provider（已知/自定义）回退到 compatible 作为全局默认
        if (providerKey !== 'compatible') {
            lookupKeys.add('compatible');
            Logger.debug(
                `[Config] getProxyLookupKeys("${providerKey}"): unknown provider, falling back to compatible, returning [${Array.from(lookupKeys).join(', ')}]`
            );
        } else {
            Logger.debug(
                `[Config] getProxyLookupKeys("${providerKey}"): compatible provider, returning [${providerKey}]`
            );
        }

        return Array.from(lookupKeys);
    }

    /**
     * 初始化配置管理器
     * 设置配置变更监听器
     */
    static initialize(context: vscode.ExtensionContext): vscode.Disposable {
        this.context = context;
        this.extensionVersion = this.readExtensionVersion(context.extensionPath);

        // 清理之前的监听器
        if (this.configListener) {
            this.configListener.dispose();
        }

        // 设置配置变更监听器
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(this.CONFIG_SECTION)) {
                this.cache = null; // 清除缓存，强制重新读取
                Logger.info('GCMP config updated, cache cleared');

                // 广播配置变更事件到其他 VS Code 实例
                InterInstanceBus.publish({
                    type: 'configChanged',
                    payload: {
                        changedKeys: [] // 精确键列表可通过 event 推断，但 VS Code 未暴露具体键，留空表示整体刷新
                    }
                });

                // 根据新的调试配置更新 HAR 记录器
                this.updateHarRecorder();
            }
        });

        // 首次启动时根据当前配置初始化 HAR 记录器
        this.updateHarRecorder();

        Logger.debug('Config manager initialized');
        return this.configListener;
    }

    private static readExtensionVersion(extensionPath: string): string | null {
        try {
            const packageJsonPath = path.join(extensionPath, 'package.json');
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
            return packageJson.version ?? null;
        } catch (error) {
            Logger.warn('[ConfigManager] Failed to read extension version from package.json', error);
            return null;
        }
    }

    private static updateHarRecorder(): void {
        if (!this.context) {
            return;
        }

        const config = this.getConfig();
        HarRecorder.getInstance().initialize({
            enabled: config.debug.captureHar,
            extensionVersion: this.extensionVersion ?? 'unknown',
            defaultStoragePath: this.context.globalStorageUri.fsPath,
            retentionCount: config.debug.harRetentionCount
        });
    }

    /**
     * 清除配置缓存
     * 用于跨实例配置变更时强制重新读取
     */
    static clearCache(): void {
        this.cache = null;
    }

    /**
     * 处理来自其他 VS Code 实例的配置变更
     */
    static handleExternalConfigChange(): void {
        this.clearCache();
        this.updateHarRecorder();
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

        const providerOverrides = config.get<UserConfigOverrides>('providerOverrides') ?? {};

        this.cache = {
            debug: {
                captureHar: config.get<boolean>('debug.captureHar', false),
                harRetentionCount: this.validateHarRetentionCount(config.get<number>('debug.harRetentionCount', 7))
            },
            retry: {
                enabled: config.get<boolean>('retry.enabled', true),
                maxAttempts: this.validateRetryMaxAttempts(config.get<number>('retry.maxAttempts', 3))
            },
            zhipu: {
                search: {
                    enableMCP: config.get<boolean>('zhipu.search.enableMCP', true) // 默认启用MCP模式（Coding Plan专属）
                },
                endpoint: config.get<ZhipuConfig['endpoint']>('zhipu.endpoint', 'open.bigmodel.cn')
            },
            stepfun: {
                search: {
                    enableMCP: config.get<boolean>('stepfun.search.enableMCP', true) // 默认启用MCP模式（Step Plan专属）
                }
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
                model: config.get<ModelSelection>('commit.model')
            },
            vision: {
                model: {
                    provider: config.get<string>('vision.model.provider', ''),
                    model: config.get<string>('vision.model.model', '')
                }
            },
            proxy: config.get<string>('proxy') || undefined,
            // VS Code configuration objects may carry proxy getters for nested paths.
            // Deep-clone here so flat keys like "retry.xfyun-coding" remain plain own-properties
            // and later property reads do not accidentally trigger dotted-path resolution.
            providerOverrides: JSON.parse(JSON.stringify(providerOverrides)) as UserConfigOverrides
        };

        Logger.debug('Config loaded', sanitizeConfigForLogging(this.cache));
        return this.cache;
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
     * 获取重试是否启用
     */
    static getRetryEnabled(): boolean {
        return this.getRetryConfig().enabled;
    }

    /**
     * 获取用户是否显式设置了全局 retry.enabled。
     * 未显式设置时返回 undefined，此时 provider 级合并应继续允许 preset 生效。
     */
    private static getExplicitRetryEnabledSetting(
        config = vscode.workspace.getConfiguration(this.CONFIG_SECTION)
    ): boolean | undefined {
        const inspected = config.inspect<boolean>('retry.enabled');
        const hasExplicitValue =
            inspected?.workspaceFolderLanguageValue !== undefined ||
            inspected?.workspaceLanguageValue !== undefined ||
            inspected?.globalLanguageValue !== undefined ||
            inspected?.workspaceFolderValue !== undefined ||
            inspected?.workspaceValue !== undefined ||
            inspected?.globalValue !== undefined;

        return hasExplicitValue ? config.get<boolean>('retry.enabled', true) : undefined;
    }

    /**
     * 获取指定提供商的重试配置。
     *
     * 合并规则：
     *   enabled：override → explicit global → preset → global default
     *     仅当用户显式设置 gcmp.retry.enabled 时，才让全局值优先于 config 预置；
     *     若全局未显式设置，则继续允许 preset 决定该 provider 的默认行为。
     *
     *   maxAttempts：
     *     - 若 override 显式指定，直接使用（支持 -1/0/正整数）
     *     - 否则取 global 与 preset 的最大值（确保预置的更高重试次数不被全局上限压低）
     *     - 特殊值 -1（无限）优先于任何正整数；preset=0 不会压低全局次数
     *
     *   initialDelayMs / maxDelayMs：override → preset → 内置默认值（两层，全局配置无此字段）
     *
     * 特殊语义：
     * - override.maxAttempts = -1：无限重试
     * - override.maxAttempts =  0：禁止重试（等价于 enabled=false）
     * - preset.maxAttempts   = -1：将该 provider 预置为无限重试
     * - preset.maxAttempts   =  0：不会压低全局 maxAttempts；如需强制禁用应使用 override
     * - enabled = false：按 enabled 字段的合并优先级生效
     *
     * 与全局设置不同，预置/override 路径的 maxAttempts 不受 1-10 上限约束，
     * 允许任意正整数或 -1，以支持自建网关或特定提供商需要更长退避的场景。
     */
    static getProviderRetryConfig(providerKey: string): RequestRetryConfig & {
        initialDelayMs: number;
        maxDelayMs: number;
    } {
        const globalRetry = this.getRetryConfig();
        const explicitGlobalRetryEnabled = this.getExplicitRetryEnabledSetting();
        // 复用 proxy 的子 provider → 根 provider 解析逻辑（如 xfyun-coding → xfyun）
        const lookupKeys = this.getProxyLookupKeys(providerKey);

        Logger.debug(
            `[Config/Retry] getProviderRetryConfig("${providerKey}"): lookupKeys=${JSON.stringify(lookupKeys)}, global={maxAttempts:${globalRetry.maxAttempts},enabled:${globalRetry.enabled},explicitEnabled:${explicitGlobalRetryEnabled === undefined ? 'default' : explicitGlobalRetryEnabled}}`
        );

        // preset：按优先级从 configProviders 中查找（子 provider 回退到根 provider）
        // 查找顺序：configProviders[key]["retry.{providerKey}"] → configProviders[key].retry → 下一个 key
        let preset: ProviderRetryOverride | undefined;
        for (const key of lookupKeys) {
            const config = configProviders[key as keyof typeof configProviders];
            if (config) {
                // 优先查找子 provider 级别的 flat key（如 "retry.xfyun-coding"）
                const flatKey: `retry.${string}` = `retry.${providerKey}`;
                const subPreset = config[flatKey];
                if (subPreset) {
                    preset = subPreset;
                    Logger.debug(
                        `[Config/Retry] getProviderRetryConfig("${providerKey}"): found flat preset from configProviders["${key}"]["${flatKey}"] = ${JSON.stringify(preset)}`
                    );
                    break;
                }
                // 回退到顶层 retry 配置
                if (config.retry) {
                    preset = config.retry;
                    Logger.debug(
                        `[Config/Retry] getProviderRetryConfig("${providerKey}"): found top-level preset from configProviders["${key}"].retry = ${JSON.stringify(preset)}`
                    );
                    break;
                }
                Logger.debug(
                    `[Config/Retry] getProviderRetryConfig("${providerKey}"): configProviders["${key}"].retry is undefined`
                );
            } else {
                Logger.debug(
                    `[Config/Retry] getProviderRetryConfig("${providerKey}"): configProviders["${key}"] is undefined`
                );
            }
        }

        if (!preset) {
            Logger.debug(
                `[Config/Retry] getProviderRetryConfig("${providerKey}"): no preset found in any lookup key, falling back to global`
            );
        }

        // override：按优先级从 providerOverrides 中查找（精确 key → 根 key → compatible）
        // 查找顺序：overrides[key]["retry.{providerKey}"] → overrides[key].retry → 下一个 key
        let override: ProviderRetryOverride | undefined;
        const overrides = this.getProviderOverrides();
        for (const key of lookupKeys) {
            const providerOverride = overrides[key];
            if (providerOverride) {
                // 优先查找子 provider 级别的 flat key（如 "retry.xfyun-coding"）
                const flatKey: `retry.${string}` = `retry.${providerKey}`;
                const subOverride = providerOverride[flatKey];
                if (subOverride) {
                    override = subOverride;
                    Logger.debug(
                        `[Config/Retry] getProviderRetryConfig("${providerKey}"): found flat override from providerOverrides["${key}"]["${flatKey}"] = ${JSON.stringify(override)}`
                    );
                    break;
                }
                // 回退到顶层 retry 配置
                if (providerOverride.retry) {
                    override = providerOverride.retry;
                    Logger.debug(
                        `[Config/Retry] getProviderRetryConfig("${providerKey}"): found top-level override from providerOverrides["${key}"].retry = ${JSON.stringify(override)}`
                    );
                    break;
                }
                Logger.debug(
                    `[Config/Retry] getProviderRetryConfig("${providerKey}"): providerOverrides["${key}"].retry is undefined`
                );
            } else {
                Logger.debug(
                    `[Config/Retry] getProviderRetryConfig("${providerKey}"): providerOverrides["${key}"] is undefined`
                );
            }
        }

        if (!override) {
            Logger.debug(
                `[Config/Retry] getProviderRetryConfig("${providerKey}"): no override found in any lookup key, falling back to preset/global`
            );
        }

        const resolved = this.resolveProviderRetryOverride(
            override,
            preset,
            globalRetry,
            explicitGlobalRetryEnabled,
            providerKey
        );
        Logger.debug(
            `[Config/Retry] getProviderRetryConfig("${providerKey}"): resolved={enabled:${resolved.enabled},maxAttempts:${resolved.maxAttempts},initialDelayMs:${resolved.initialDelayMs},maxDelayMs:${resolved.maxDelayMs}}`
        );
        return {
            enabled: resolved.enabled,
            maxAttempts: resolved.maxAttempts,
            initialDelayMs: resolved.initialDelayMs,
            maxDelayMs: resolved.maxDelayMs
        };
    }

    /**
     * 解析 provider 级别的 retry 配置（字段级合并）。
     *
     * enabled 合并规则：override → explicit global → preset → global default
     *   仅当用户显式设置 gcmp.retry.enabled 时，才让全局值优先于 config 预置；
     *   若全局未显式设置，则继续允许 preset 决定该 provider 的默认行为。
     *
     * maxAttempts 合并规则：
     *   - 若 override 显式指定，直接使用 override 值（支持 -1/0/正整数）
     *   - 否则取 global 与 preset 的最大值（确保预置的更高重试次数不被全局上限压低）
     *   - 特殊值 -1（无限）优先于任何正整数
     *
     * initialDelayMs / maxDelayMs：override → preset → 内置默认值（两层，全局配置无此字段）
     *
     * @param override 用户 providerOverrides.retry（最高优先级，可为 undefined）
     * @param preset   内置 configProviders.retry 预置（中间层，可为 undefined）
     * @param globalRetry 全局 gcmp.retry 配置（最低优先级，仅含 enabled/maxAttempts）
     * @param explicitGlobalEnabled 用户是否显式设置了全局 gcmp.retry.enabled；未显式设置时为 undefined
     */
    private static resolveProviderRetryOverride(
        override: ProviderRetryOverride | undefined,
        preset: ProviderRetryOverride | undefined,
        globalRetry: RequestRetryConfig,
        explicitGlobalEnabled: boolean | undefined,
        providerKey: string
    ): { enabled: boolean; maxAttempts: number; initialDelayMs: number; maxDelayMs: number } {
        // enabled：override → explicit global → preset → global default
        // 仅在用户显式设置全局 enabled 时才压过 preset；否则允许 preset 决定默认行为
        const mergedEnabled = override?.enabled ?? explicitGlobalEnabled ?? preset?.enabled ?? globalRetry.enabled;
        const maxAttempts = this.resolveProviderMaxAttempts(
            override?.maxAttempts,
            preset?.maxAttempts,
            globalRetry.maxAttempts,
            providerKey
        );

        // 当 maxAttempts=0 时，强制 enabled=false 以确保不进入重试循环
        const effectiveEnabled = maxAttempts === 0 ? false : mergedEnabled;

        // initialDelayMs / maxDelayMs 校验（非法值继续回退到下一层；均未声明时回退到内置默认值）
        const initialDelayMs = this.resolvePositiveMs(
            [
                { value: override?.initialDelayMs, source: 'override' },
                { value: preset?.initialDelayMs, source: 'preset' }
            ],
            DEFAULT_RETRY_INITIAL_DELAY_MS,
            `provider "${providerKey}" retry.initialDelayMs`
        );
        const maxDelayMs = this.resolvePositiveMs(
            [
                { value: override?.maxDelayMs, source: 'override' },
                { value: preset?.maxDelayMs, source: 'preset' }
            ],
            DEFAULT_RETRY_MAX_DELAY_MS,
            `provider "${providerKey}" retry.maxDelayMs`
        );

        return { enabled: effectiveEnabled, maxAttempts, initialDelayMs, maxDelayMs };
    }

    /**
     * 解析 provider 级别 maxAttempts。
     *
     * 合并规则：
     *   1. 若 override 显式指定，直接使用（支持 -1/0/正整数，不受全局 1-10 上限约束）
     *   2. 否则取 global 与 preset 的最大值（确保预置的更高重试次数不被全局上限压低）
     *   3. preset = -1（无限）优先于任何正整数；preset = 0 不会压低全局次数
     *
     * 全局 maxAttempts 已由 validateRetryMaxAttempts 保证 1-10，不会出现 -1/0/超限值。
     * 非法 override/preset 值会跳过；preset = 0 也会保留全局次数下限。
     */
    private static resolveProviderMaxAttempts(
        overrideValue: number | undefined,
        presetValue: number | undefined,
        globalValue: number,
        providerKey: string
    ): number {
        // 1. override 显式指定时直接使用
        if (overrideValue !== undefined) {
            if (overrideValue === -1) {
                Logger.debug(
                    `[Config/Retry] Provider "${providerKey}" maxAttempts = -1 (override, unlimited retries, governed by isRetryable)`
                );
                return -1;
            }
            if (overrideValue === 0) {
                Logger.debug(`[Config/Retry] Provider "${providerKey}" maxAttempts = 0 (override, retries disabled)`);
                return 0;
            }
            if (Number.isFinite(overrideValue) && Number.isInteger(overrideValue) && overrideValue > 0) {
                if (overrideValue > 10) {
                    Logger.debug(
                        `[Config/Retry] Provider "${providerKey}" maxAttempts = ${overrideValue} (override bypasses global 1-10 cap)`
                    );
                }
                return overrideValue;
            }
            Logger.warn(
                `[Config/Retry] Provider "${providerKey}" maxAttempts = ${overrideValue} from override is invalid; falling back to max(global, preset)`
            );
        }

        // 2. 无 override 时，取 global 与 preset 的最大值
        // 全局 maxAttempts 已由 validateRetryMaxAttempts 保证为 1-10，不会出现 -1/0/超限值
        // preset = -1 表示"无限重试"，优先于任何正整数
        if (presetValue === -1) {
            Logger.debug(
                `[Config/Retry] Provider "${providerKey}" maxAttempts = -1 (preset, unlimited retries, governed by isRetryable)`
            );
            return -1;
        }

        // 取 global 与 preset 的最大值（仅正整数）
        const validPreset =
            (
                presetValue !== undefined &&
                Number.isFinite(presetValue) &&
                Number.isInteger(presetValue) &&
                presetValue > 0
            ) ?
                presetValue
            :   undefined;

        if (validPreset !== undefined) {
            const maxVal = Math.max(globalValue, validPreset);
            if (validPreset > globalValue) {
                Logger.debug(
                    `[Config/Retry] Provider "${providerKey}" maxAttempts = ${maxVal} (preset=${validPreset} > global=${globalValue}, using preset)`
                );
            }
            return maxVal;
        }

        return globalValue;
    }

    /**
     * 校验正整数毫秒值；非法值继续回退到下一层，所有候选都不可用时回退到默认值
     */
    private static resolvePositiveMs(
        candidates: ReadonlyArray<{ value: number | undefined; source: 'override' | 'preset' }>,
        defaultValue: number,
        label: string
    ): number {
        for (const candidate of candidates) {
            if (candidate.value === undefined) {
                continue;
            }
            if (Number.isFinite(candidate.value) && Number.isInteger(candidate.value) && candidate.value > 0) {
                return candidate.value;
            }
            Logger.warn(
                `[Config/Retry] ${label} = ${candidate.value} from ${candidate.source} is invalid; falling back to the next layer`
            );
        }

        return defaultValue;
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
     * 获取阶跃星辰 StepFun 搜索配置
     */
    static getStepFunSearchConfig(): StepFunSearchConfig {
        return this.getConfig().stepfun.search;
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
     * 验证最大重试次数
     */
    private static validateRetryMaxAttempts(value: number): number {
        if (isNaN(value) || value < 1 || value > 10) {
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
     * 验证 HAR 文件保留数量
     */
    private static validateHarRetentionCount(value: number): number {
        if (isNaN(value) || value < 0 || value > 100) {
            Logger.warn(`Invalid debug.harRetentionCount value: ${value}; using default 7`);
            return 7;
        }
        return Math.floor(value);
    }

    /**
     * 归一化单个 provider JSON 配置中的 tokenPricing（支持数组简写）。
     * 在消费方按需调用，不在模块顶层转换，保持原始 JSON 形态不变。
     */
    private static normalizeProviderPricing(config: { models?: readonly Record<string, unknown>[] }): {
        models?: readonly Record<string, unknown>[];
    } {
        if (!config.models) {
            return config;
        }
        let changed = false;
        const normalizedModels = config.models.map(model => {
            const tokenPricing = model.tokenPricing;
            if (tokenPricing === undefined || tokenPricing === null) {
                return model;
            }
            const normalized = normalizeTokenPricing(tokenPricing as ModelTokenPricingInput);
            if (!normalized) {
                Logger.warn(
                    `[GCMP] Invalid tokenPricing in built-in provider config: model=${String(model.id ?? '(unknown)')}`
                );
                // 剥离无效 tokenPricing，避免消费方拿到未归一化结构
                changed = true;
                return { ...model, tokenPricing: undefined };
            }

            const invalidCrons = collectInvalidTierCrons(normalized);
            if (invalidCrons.length > 0) {
                Logger.warn(
                    `[GCMP] Invalid tokenPricing cron ignored in built-in provider config: model=${String(model.id ?? '(unknown)')}, cron=${invalidCrons.join(', ')}`
                );
            }

            if (normalized === tokenPricing) {
                return model;
            }

            changed = true;
            return { ...model, tokenPricing: normalized };
        });
        return changed ? { ...config, models: normalizedModels } : config;
    }

    /**
     * 获取提供商配置（新模式：直接 import configProviders）。
     * 在返回前对 tokenPricing 做归一化，确保消费方拿到的始终是对象形式。
     */
    static getConfigProvider(): ConfigProvider {
        const normalized: ConfigProvider = {};
        for (const [key, config] of Object.entries(configProviders)) {
            normalized[key] = this.normalizeProviderPricing(
                config as unknown as { models?: readonly Record<string, unknown>[] }
            ) as unknown as ProviderConfig;
        }
        return normalized;
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
                Logger.debug(
                    `  Model ${modelOverride.id}: override webSearchTool = ${JSON.stringify(modelOverride.webSearchTool)}`
                );
            }
            if (modelOverride.nativeTools !== undefined) {
                target.nativeTools = modelOverride.nativeTools;
                Logger.debug(
                    `  Model ${modelOverride.id}: override nativeTools = ${JSON.stringify(modelOverride.nativeTools)}`
                );
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
            if (modelOverride.reasoningFormat !== undefined) {
                target.reasoningFormat = modelOverride.reasoningFormat;
                Logger.debug(
                    `  Model ${modelOverride.id}: override reasoningFormat = ${modelOverride.reasoningFormat}`
                );
            }
            if (modelOverride.reasoningEffort !== undefined) {
                target.reasoningEffort = [...modelOverride.reasoningEffort];
                Logger.debug(
                    `  Model ${modelOverride.id}: override reasoningEffort = ${JSON.stringify(modelOverride.reasoningEffort)}`
                );
            }
            if (modelOverride.reasoningDefault !== undefined) {
                target.reasoningDefault = modelOverride.reasoningDefault;
                Logger.debug(
                    `  Model ${modelOverride.id}: override reasoningDefault = ${modelOverride.reasoningDefault}`
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
            if (modelOverride.tokenPricing !== undefined) {
                const normalized = normalizeTokenPricing(modelOverride.tokenPricing);
                if (normalized) {
                    const invalidCrons = collectInvalidTierCrons(normalized);
                    if (invalidCrons.length > 0) {
                        Logger.warn(
                            `  Model ${modelOverride.id}: invalid tokenPricing cron ignored: ${invalidCrons.join(', ')}`
                        );
                    }
                    target.tokenPricing = normalized;
                    Logger.debug(`  Model ${modelOverride.id}: override tokenPricing = ${JSON.stringify(normalized)}`);
                } else {
                    Logger.warn(
                        `  Model ${modelOverride.id}: invalid tokenPricing override ignored: ${JSON.stringify(modelOverride.tokenPricing)}`
                    );
                }
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

    private static resolveExplicitProxyValue(
        proxyValue: string | null | undefined,
        sourceLabel: string
    ): string | undefined {
        if (isNoProxyValue(proxyValue)) {
            Logger.debug(`[Proxy] ${sourceLabel} explicitly disables proxy via ${NO_PROXY_SENTINEL}`);
            return NO_PROXY_SENTINEL;
        }

        if (proxyValue) {
            Logger.debug(`[Proxy] Using ${sourceLabel}: ${redactProxyUrl(proxyValue)}`);
        }

        return proxyValue || undefined;
    }

    /**
     * 解析模型请求应使用的代理地址
     * 优先级：model.proxy > providerOverrides.{provider}.proxy > providerOverrides.compatible.proxy（非内置 provider） > provider config.proxy > gcmp.proxy > VS Code http.proxy > 环境变量
     * 当显式设置为 `noproxy` 时，停止继续回退并直接绕过代理。
     */
    static resolveProxyForModel(
        modelConfig?: Pick<ModelConfig, 'proxy' | 'provider'>,
        providerKey?: string
    ): string | undefined {
        // 1. 模型级别
        if (modelConfig?.proxy !== undefined) {
            return this.resolveExplicitProxyValue(modelConfig.proxy, 'model-level proxy');
        }

        // 2. providerOverrides 级别
        // 兼容模型（providerKey === 'compatible'）时，优先使用 modelConfig.provider 指定的 provider
        const effectiveProviderKey = providerKey === 'compatible' ? modelConfig?.provider : providerKey;

        if (effectiveProviderKey) {
            const proxyLookupKeys = this.getProxyLookupKeys(effectiveProviderKey);
            const overrides = this.getProviderOverrides();
            for (const lookupKey of proxyLookupKeys) {
                const providerOverride = overrides[lookupKey];
                if (providerOverride?.proxy !== undefined) {
                    return this.resolveExplicitProxyValue(
                        providerOverride.proxy,
                        `provider-level proxy (${lookupKey})`
                    );
                }
            }

            // 3. providerConfig 级别
            for (const lookupKey of proxyLookupKeys) {
                const originalProviderConfig =
                    lookupKey in configProviders ?
                        configProviders[lookupKey as keyof typeof configProviders]
                    :   undefined;
                if (originalProviderConfig?.proxy) {
                    return this.resolveExplicitProxyValue(
                        originalProviderConfig.proxy,
                        `provider config proxy (${lookupKey})`
                    );
                }
            }
        }

        // 4. 全局设置
        const globalProxy = this.getProxy();
        if (globalProxy) {
            return this.resolveExplicitProxyValue(globalProxy, 'global proxy');
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
        const proxiedFetch = createProxiedFetch(proxyUrl);
        if (options.skipHar) {
            return proxiedFetch;
        }
        return HarRecorder.getInstance().wrapFetch(proxiedFetch);
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
    static async dispose(): Promise<void> {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this.cache = null;
        this.context = null;
        this.extensionVersion = null;
        await HarRecorder.getInstance().dispose();
        Logger.trace('Config manager disposed');
    }
}
