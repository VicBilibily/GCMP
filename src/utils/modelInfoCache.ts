/*---------------------------------------------------------------------------------------------
 *  模型信息缓存管理器
 *  提供模型信息的持久化缓存功能，加速扩展激活时的模型选择器显示
 *  参考: Microsoft vscode-copilot-chat LanguageModelAccessPromptBaseCountCache
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { LanguageModelChatInformation } from 'vscode';
import { Logger } from './logger';
import { configProviders } from '../providers/config';
import crypto from 'crypto';

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
    /** 缓存时创建的扩展版本（用于版本检查失效） */
    extensionVersion: string;
    /** 缓存创建时间戳 */
    timestamp: number;
    /** API 密钥的哈希值（用于密钥变更检查） */
    apiKeyHash: string;
}

/**
 * 模型信息缓存管理器
 *
 * 采用 VS Code globalState 持久化缓存，支持：
 * - 跨激活会话缓存持久化
 * - 自动版本检查失效
 * - API 密钥变更检测
 * - 24小时时间过期
 * - 全局模型选择持久化（保存用户上次选择的模型，跨所有提供商）
 */
export class ModelInfoCache {
    private readonly context: vscode.ExtensionContext;
    private readonly cacheVersion = '1';
    private readonly cacheExpiryMs = 24 * 60 * 60 * 1000; // 24 hours
    private static readonly SELECTED_MODEL_KEY = 'gcmp_selected_model'; // 全局模型选择存储键

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * 获取缓存的模型信息
     *
     * 快速检查缓存是否有效。检查项目：
     * - 缓存存在性
     * - 扩展版本匹配
     * - API 密钥哈希匹配
     * - 缓存时间未过期
     *
     * @param providerKey 提供商标识符（如 'zhipu', 'kimi'）
     * @param apiKeyHash API 密钥的哈希值
     * @returns 有效的模型信息列表，或 null（表示缓存无效或不存在）
     */
    async getCachedModels(providerKey: string, apiKeyHash: string): Promise<LanguageModelChatInformation[] | null> {
        try {
            const cacheKey = this.getCacheKey(providerKey);
            const cached = this.context.globalState.get<CachedModelInfo>(cacheKey);

            if (!cached) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: 无缓存`);
                return null;
            }

            // 检查 1: 版本匹配
            const currentVersion = vscode.extensions.getExtension('vicanent.gcmp')?.packageJSON.version || '';
            if (cached.extensionVersion !== currentVersion) {
                Logger.trace(
                    `[ModelInfoCache] ${providerKey}: 版本不匹配 ` +
                        `(缓存: ${cached.extensionVersion}, 当前: ${currentVersion})`
                );
                return null;
            }

            // 检查 2: API 密钥匹配
            if (cached.apiKeyHash !== apiKeyHash) {
                Logger.trace(`[ModelInfoCache] ${providerKey}: API 密钥已变更`);
                return null;
            }

            // 检查 3: 时间未过期
            const now = Date.now();
            const ageMs = now - cached.timestamp;
            if (ageMs > this.cacheExpiryMs) {
                const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
                Logger.trace(`[ModelInfoCache] ${providerKey}: 缓存已过期 ` + `(${ageHours}小时前)`);
                return null;
            }

            Logger.trace(
                `[ModelInfoCache] ${providerKey}: 缓存命中 ` +
                    `(${cached.models.length} 个模型, 存活 ${(ageMs / 1000).toFixed(1)}s)`
            );
            return cached.models;
        } catch (err) {
            // 缓存读取错误不应该影响扩展运行
            Logger.warn(
                `[ModelInfoCache] 读取 ${providerKey} 缓存失败:`,
                err instanceof Error ? err.message : String(err)
            );
            return null;
        }
    }

    /**
     * 缓存模型信息
     *
     * 异步存储模型信息到 globalState。这个操作不应该阻塞返回流程。
     *
     * @param providerKey 提供商标识符
     * @param models 要缓存的模型信息列表
     * @param apiKeyHash API 密钥的哈希值
     */
    async cacheModels(providerKey: string, models: LanguageModelChatInformation[], apiKeyHash: string): Promise<void> {
        try {
            const currentVersion = vscode.extensions.getExtension('vicanent.gcmp')?.packageJSON.version || '';

            const cacheData: CachedModelInfo = {
                models,
                extensionVersion: currentVersion,
                timestamp: Date.now(),
                apiKeyHash
            };

            const cacheKey = this.getCacheKey(providerKey);
            await this.context.globalState.update(cacheKey, cacheData);

            Logger.trace(`[ModelInfoCache] ${providerKey}: 缓存已保存 ` + `(${models.length} 个模型)`);
        } catch (err) {
            // 缓存失败不应该阻塞扩展
            Logger.warn(`[ModelInfoCache] 缓存 ${providerKey} 失败:`, err instanceof Error ? err.message : String(err));
        }
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
        try {
            const cacheKey = this.getCacheKey(providerKey);
            await this.context.globalState.update(cacheKey, undefined);
            Logger.trace(`[ModelInfoCache] ${providerKey}: 缓存已清除`);
        } catch (err) {
            Logger.warn(
                `[ModelInfoCache] 清除 ${providerKey} 缓存失败:`,
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    /**
     * 清除所有缓存
     *
     * 在扩展卸载或用户请求时调用
     */
    async clearAll(): Promise<void> {
        // 从配置文件动态获取所有提供商 key，最后加入 'compatible'
        const allProviderKeys = [...Object.keys(configProviders), 'compatible'];

        let clearedCount = 0;
        for (const key of allProviderKeys) {
            try {
                await this.invalidateCache(key);
                clearedCount++;
            } catch (err) {
                // 继续清除其他缓存，不中断流程
                Logger.warn(
                    `[ModelInfoCache] 清除 ${key} 缓存时出错:`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        }

        Logger.info(`[ModelInfoCache] 已清除全部缓存 (${clearedCount}/${allProviderKeys.length})`);
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
     * 获取缓存的存储键
     *
     * 格式: gcmp_modelinfo_cache_<version>_<providerKey>
     * 这样不同版本的缓存不会冲突
     */
    private getCacheKey(providerKey: string): string {
        return `gcmp_modelinfo_cache_${this.cacheVersion}_${providerKey}`;
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
            Logger.trace(`[ModelInfoCache] 已保存默认模型选择 (${providerKey}: ${modelId})`);
        } catch (err) {
            Logger.warn('[ModelInfoCache] 保存模型选择失败:', err instanceof Error ? err.message : String(err));
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
                Logger.trace(`[ModelInfoCache] ${providerKey}: 读取到默认模型 (${saved.modelId})`);
                return saved.modelId;
            }
            if (saved) {
                Logger.trace(
                    `[ModelInfoCache] ${providerKey}: 跳过其他提供商的默认选择 (` +
                        `已保存: ${saved.providerKey}/${saved.modelId})`
                );
            }
            return null;
        } catch (err) {
            Logger.warn('[ModelInfoCache] 读取模型选择失败:', err instanceof Error ? err.message : String(err));
            return null;
        }
    }
}
