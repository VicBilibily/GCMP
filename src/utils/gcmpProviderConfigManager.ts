import * as vscode from 'vscode';
import {
    ModelConfig,
    ModelOverride,
    ProviderConfig,
    ResolvedUnifiedProviderConfig,
    ResolvedUnifiedProviderConfigMap,
    UnifiedModelConfig,
    UnifiedProviderConfig,
    UnifiedProviderConfigMap
} from '../types/sharedTypes';
import knownProviders from '../providers/known';
import { Logger } from './logger';

type StrategyConfig = Omit<ModelOverride, 'id'> | undefined;

export class GCMPProviderConfigManager {
    private static readonly CONFIG_KEY = 'providerConfig';
    private static readonly DEFAULT_API_KEY_TEMPLATE = 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    private static configListener: vscode.Disposable | null = null;
    private static resolvedProviders: ResolvedUnifiedProviderConfigMap = {};
    private static flattenedModels: ModelConfig[] = [];
    private static readonly _onDidChange = new vscode.EventEmitter<void>();

    static readonly onDidChange = GCMPProviderConfigManager._onDidChange.event;

    static initialize(): void {
        this.loadConfiguration();

        this.configListener?.dispose();
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(`gcmp.${this.CONFIG_KEY}`)) {
                this.loadConfiguration();
                this._onDidChange.fire();
            }
        });
    }

    static dispose(): void {
        this.configListener?.dispose();
        this.configListener = null;
        this._onDidChange.dispose();
    }

    static getUserConfig(): UnifiedProviderConfigMap {
        const config = vscode.workspace.getConfiguration('gcmp');
        return config.get<UnifiedProviderConfigMap>(this.CONFIG_KEY, {}) ?? {};
    }

    static getResolvedProviders(): ResolvedUnifiedProviderConfigMap {
        return this.resolvedProviders;
    }

    static getFlattenedModels(): ModelConfig[] {
        return this.flattenedModels;
    }

    static getProviderIds(): string[] {
        return Object.keys(this.resolvedProviders);
    }

    static getProviderDisplayName(providerKey: string): string {
        return this.resolvedProviders[providerKey]?.displayName || providerKey;
    }

    static getVirtualProviderConfig(): ProviderConfig {
        return {
            displayName: 'GCMP Experimental',
            baseUrl: '',
            apiKeyTemplate: this.DEFAULT_API_KEY_TEMPLATE,
            models: this.flattenedModels
        };
    }

    private static loadConfiguration(): void {
        try {
            const userConfig = this.getUserConfig();
            this.resolvedProviders = this.buildResolvedProviders(knownProviders, userConfig);
            this.flattenedModels = this.buildFlattenedModels(this.resolvedProviders);

            Logger.debug(
                `[GCMP] 已加载 ${Object.keys(this.resolvedProviders).length} 个统一 provider，` +
                    `${this.flattenedModels.length} 个模型`
            );
        } catch (error) {
            Logger.error('[GCMP] 加载统一 providerConfig 失败:', error);
            this.resolvedProviders = {};
            this.flattenedModels = [];
        }
    }

    private static buildResolvedProviders(
        baseProviders: UnifiedProviderConfigMap,
        userProviders: UnifiedProviderConfigMap
    ): ResolvedUnifiedProviderConfigMap {
        const keys = new Set([...Object.keys(baseProviders), ...Object.keys(userProviders)]);
        const resolved: ResolvedUnifiedProviderConfigMap = {};

        for (const key of keys) {
            resolved[key] = this.normalizeProviderConfig(
                key,
                this.mergeProviderConfig(baseProviders[key], userProviders[key])
            );
        }

        return resolved;
    }

    private static mergeProviderConfig(
        baseConfig?: UnifiedProviderConfig,
        userConfig?: UnifiedProviderConfig
    ): UnifiedProviderConfig {
        return {
            ...baseConfig,
            ...userConfig,
            customHeader: {
                ...(baseConfig?.customHeader || {}),
                ...(userConfig?.customHeader || {})
            },
            openai: this.mergeStrategy(baseConfig?.openai, userConfig?.openai),
            anthropic: this.mergeStrategy(baseConfig?.anthropic, userConfig?.anthropic),
            models: this.mergeModels(baseConfig?.models || [], userConfig?.models || [])
        };
    }

    private static mergeStrategy(baseStrategy?: StrategyConfig, userStrategy?: StrategyConfig): StrategyConfig {
        if (!baseStrategy && !userStrategy) {
            return undefined;
        }

        return {
            ...baseStrategy,
            ...userStrategy,
            capabilities: {
                ...(baseStrategy?.capabilities || {}),
                ...(userStrategy?.capabilities || {})
            },
            customHeader: {
                ...(baseStrategy?.customHeader || {}),
                ...(userStrategy?.customHeader || {})
            },
            extraBody: {
                ...(baseStrategy?.extraBody || {}),
                ...(userStrategy?.extraBody || {})
            }
        };
    }

    private static mergeModels(
        baseModels: UnifiedModelConfig[],
        userModels: UnifiedModelConfig[]
    ): UnifiedModelConfig[] {
        const mergedModels = new Map<string, UnifiedModelConfig>();

        for (const model of baseModels) {
            if (model?.id) {
                mergedModels.set(model.id, { ...model });
            }
        }

        for (const model of userModels) {
            if (!model?.id) {
                continue;
            }

            const existing = mergedModels.get(model.id);
            if (!existing) {
                mergedModels.set(model.id, { ...model });
                continue;
            }

            mergedModels.set(model.id, {
                ...existing,
                ...model,
                capabilities: {
                    ...(existing.capabilities || {}),
                    ...(model.capabilities || {})
                },
                customHeader: {
                    ...(existing.customHeader || {}),
                    ...(model.customHeader || {})
                },
                extraBody: {
                    ...(existing.extraBody || {}),
                    ...(model.extraBody || {})
                }
            });
        }

        return Array.from(mergedModels.values());
    }

    private static normalizeProviderConfig(
        providerKey: string,
        providerConfig: UnifiedProviderConfig
    ): ResolvedUnifiedProviderConfig {
        return {
            displayName: providerConfig.displayName || providerKey,
            baseUrl: providerConfig.baseUrl || '',
            apiKeyTemplate: providerConfig.apiKeyTemplate || this.DEFAULT_API_KEY_TEMPLATE,
            ...(providerConfig.codingKeyTemplate && { codingKeyTemplate: providerConfig.codingKeyTemplate }),
            ...(providerConfig.customHeader && {
                customHeader:
                    Object.keys(providerConfig.customHeader).length > 0 ? providerConfig.customHeader : undefined
            }),
            ...(providerConfig.openai && { openai: providerConfig.openai }),
            ...(providerConfig.anthropic && { anthropic: providerConfig.anthropic }),
            models: (providerConfig.models || []).map(model => this.normalizeModelConfig(providerKey, model))
        };
    }

    private static normalizeModelConfig(providerKey: string, modelConfig: UnifiedModelConfig): ModelConfig {
        const name = modelConfig.name || modelConfig.id;
        const sdkMode = modelConfig.sdkMode || 'openai';

        return {
            id: modelConfig.id,
            name,
            tooltip: modelConfig.tooltip || `${name} (${sdkMode})`,
            maxInputTokens: modelConfig.maxInputTokens ?? 128000,
            maxOutputTokens: modelConfig.maxOutputTokens ?? 8192,
            capabilities: {
                toolCalling: modelConfig.capabilities?.toolCalling ?? true,
                imageInput: modelConfig.capabilities?.imageInput ?? false
            },
            provider: providerKey,
            ...(modelConfig.sdkMode && { sdkMode: modelConfig.sdkMode }),
            ...(modelConfig.baseUrl && { baseUrl: modelConfig.baseUrl }),
            ...(modelConfig.endpoint && { endpoint: modelConfig.endpoint }),
            ...(modelConfig.model && { model: modelConfig.model }),
            ...(modelConfig.family && { family: modelConfig.family }),
            ...(modelConfig.thinking && { thinking: modelConfig.thinking }),
            ...(modelConfig.reasoningEffort && { reasoningEffort: modelConfig.reasoningEffort }),
            ...(modelConfig.customHeader && { customHeader: modelConfig.customHeader }),
            ...(modelConfig.extraBody && { extraBody: modelConfig.extraBody }),
            ...(modelConfig.useInstructions !== undefined && { useInstructions: modelConfig.useInstructions }),
            ...(modelConfig.webSearchTool !== undefined && { webSearchTool: modelConfig.webSearchTool })
        };
    }

    private static buildFlattenedModels(providers: ResolvedUnifiedProviderConfigMap): ModelConfig[] {
        const models: ModelConfig[] = [];

        for (const [providerKey, providerConfig] of Object.entries(providers)) {
            for (const model of providerConfig.models) {
                const strategy = model.sdkMode === 'anthropic' ? providerConfig.anthropic : providerConfig.openai;
                const mergedCustomHeader = {
                    ...(providerConfig.customHeader || {}),
                    ...(strategy?.customHeader || {}),
                    ...(model.customHeader || {})
                };
                const mergedExtraBody = {
                    ...(strategy?.extraBody || {}),
                    ...(model.extraBody || {})
                };
                const resolvedBaseUrl = model.baseUrl || strategy?.baseUrl || providerConfig.baseUrl;

                models.push({
                    ...model,
                    provider: providerKey,
                    ...(resolvedBaseUrl && { baseUrl: resolvedBaseUrl }),
                    ...(Object.keys(mergedCustomHeader).length > 0 && { customHeader: mergedCustomHeader }),
                    ...(Object.keys(mergedExtraBody).length > 0 && { extraBody: mergedExtraBody })
                });
            }
        }

        return models;
    }
}
