/*---------------------------------------------------------------------------------------------
 *  模型信息缓存管理器
 *  提供模型信息的进程内缓存，避免同一进程内重复构建模型元数据
 *  模型清单的持久化由 RemoteModelsService 的磁盘缓存承担
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { LanguageModelChatInformation } from 'vscode';
import { Logger } from '../runtime/logger';

/**
 * 已保存的模型选择信息
 */
interface SavedModelSelection {
    /** 提供商标识符 */
    providerKey: string;
    /** 模型 ID */
    modelId: string;
    /** 保存时间戳 */
    timestamp: number;
}

/**
 * 缓存的模型信息结构
 */
interface CachedModelInfo {
    /** 模型信息列表 */
    models: LanguageModelChatInformation[];
    /** API 密钥哈希（仅作漏调失效时的兜底校验） */
    apiKeyHash: string;
}

/**
 * 模型信息缓存管理器
 *
 * 模型列表只做进程内缓存：模型清单的持久化与跨实例同步已由 RemoteModelsService
 * 的磁盘缓存（含内容哈希校验）承担，此处仅避免同一进程内重复构建
 * LanguageModelChatInformation；失效由各变更路径显式调用 invalidateCache，
 * apiKeyHash 仅作兜底校验。
 * 用户上次选择的模型仍持久化到 globalState（需跨会话保留）。
 */
export class ModelInfoCache {
    private readonly context: vscode.ExtensionContext;
    /** 进程内模型信息缓存（键 = providerKey / slot） */
    private static readonly memoryCache = new Map<string, CachedModelInfo>();
    private static readonly SELECTED_MODEL_KEY = 'gcmp_selected_model'; // 全局模型选择存储键

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * 获取缓存的模型信息
     *
     * 检查缓存存在性与 API 密钥哈希匹配；内容是否过期由各变更路径显式
     * invalidateCache 决定。
     *
     * @param providerKey 提供商标识符（如 'zhipu', 'kimi'）
     * @param apiKeyHash API 密钥的哈希值
     * @returns 有效的模型信息列表，或 null（表示缓存无效或不存在）
     */
    async getCachedModels(providerKey: string, apiKeyHash: string): Promise<LanguageModelChatInformation[] | null> {
        const cached = ModelInfoCache.memoryCache.get(providerKey);
        if (!cached) {
            Logger.trace(`[ModelInfoCache] ${providerKey}: no cache`);
            return null;
        }
        if (cached.apiKeyHash !== apiKeyHash) {
            Logger.trace(`[ModelInfoCache] ${providerKey}: API key changed`);
            return null;
        }
        Logger.trace(`[ModelInfoCache] ${providerKey}: cache hit (${cached.models.length} models)`);
        return cached.models;
    }

    /**
     * 缓存模型信息
     *
     * 写入进程内缓存，供同一进程内后续请求复用。
     *
     * @param providerKey 提供商标识符
     * @param models 要缓存的模型信息列表
     * @param apiKeyHash API 密钥的哈希值
     */
    async cacheModels(providerKey: string, models: LanguageModelChatInformation[], apiKeyHash: string): Promise<void> {
        ModelInfoCache.memoryCache.set(providerKey, { models, apiKeyHash });
        Logger.trace(`[ModelInfoCache] ${providerKey}: cache saved ` + `(${models.length} models)`);
    }

    /**
     * 清除特定提供商的缓存
     *
     * 在以下情况调用：
     * - API 密钥变更（ApiKeyManager.setApiKey）
     * - 提供商配置变更（onDidChangeConfiguration）
     * - 用户手动清除缓存
     *
     * @param providerKey 提供商标识符
     */
    async invalidateCache(providerKey: string): Promise<void> {
        ModelInfoCache.memoryCache.delete(providerKey);
        Logger.trace(`[ModelInfoCache] ${providerKey}: cache cleared`);
    }

    /**
     * 清除所有缓存
     *
     * 在扩展卸载或用户请求时调用
     */
    async clearAll(): Promise<void> {
        const clearedCount = ModelInfoCache.memoryCache.size;
        ModelInfoCache.memoryCache.clear();
        Logger.info(`[ModelInfoCache] Cleared all cached providers (${clearedCount})`);
    }

    /**
     * 计算 API 密钥的哈希值
     *
     * 使用 SHA-256 哈希并只取前 16 字符，避免在缓存中存储完整密钥
     *
     * @param apiKey API 密钥
     * @returns 密钥哈希值的前 16 字符
     */
    static async computeApiKeyHash(apiKey: string): Promise<string> {
        try {
            const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
            return hash.substring(0, 16);
        } catch (err) {
            Logger.warn('Failed to compute API key hash:', err instanceof Error ? err.message : String(err));
            // 如果哈希失败，返回固定值（此时将无法验证密钥变更）
            return 'hash-error';
        }
    }

    /**
     * 保存用户选择的模型（全局保存提供商+模型对）
     *
     * 参考: Microsoft vscode-copilot-chat COPILOT_CLI_MODEL_MEMENTO_KEY
     * 保存用户上次选择的模型及其所属提供商，这样能区分同名模型来自不同提供商的情况
     *
     * @param providerKey 提供商标识符
     * @param modelId 模型 ID
     */
    async saveLastSelectedModel(providerKey: string, modelId: string): Promise<void> {
        try {
            const selection: SavedModelSelection = {
                providerKey,
                modelId,
                timestamp: Date.now()
            };
            await this.context.globalState.update(ModelInfoCache.SELECTED_MODEL_KEY, selection);
            Logger.trace(`[ModelInfoCache] Saved default model selection (${providerKey}: ${modelId})`);
        } catch (err) {
            Logger.warn(
                '[ModelInfoCache] Failed to save model selection:',
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    /**
     * 获取用户上次选择的模型（全局查询）
     * 只返回与当前提供商匹配的已保存模型
     *
     * @param providerKey 当前提供商标识符
     * @returns 如果上次选择的提供商与当前相同，返回模型 ID；否则返回 null
     */
    getLastSelectedModel(providerKey: string): string | null {
        try {
            const saved = this.context.globalState.get<SavedModelSelection>(ModelInfoCache.SELECTED_MODEL_KEY);
            if (saved && saved.providerKey === providerKey) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: loaded default model (${saved.modelId})`);
                return saved.modelId;
            }
            if (saved) {
                Logger.trace(
                    `[ModelInfoCache] ${providerKey}: skipping default selection from another provider (` +
                        `saved: ${saved.providerKey}/${saved.modelId})`
                );
            }
            return null;
        } catch (err) {
            Logger.warn(
                '[ModelInfoCache] Failed to read model selection:',
                err instanceof Error ? err.message : String(err)
            );
            return null;
        }
    }
}
