/*---------------------------------------------------------------------------------------------
 *  兼容提供商余额查询管理器
 *  管理所有兼容提供商的余额查询器
 *  作为全局静态实例提供，无需实例化
 *--------------------------------------------------------------------------------------------*/

import { StatusLogger } from '../../utils/runtime/statusLogger';
import { ConfigManager } from '../../utils/config/configManager';
import { CompatibleModelManager } from '../../utils/config/compatibleModelManager';
import { KnownProviders } from '../../utils/config/knownProviders';
import { IBalanceQuery, BalanceQueryResult } from './balanceQuery';
import { AiHubMixBalanceQuery } from './providers/aihubmixBalanceQuery';
import { CustomUsageQuery } from './customUsageQuery';
import {
    mergeProviderUsageOverride,
    parseCustomUsageTarget,
    type ResolvedCustomUsageEntry,
    resolveCustomUsageEntries
} from './usageConfigResolver';

/**
 * 余额查询管理器
 * 负责管理所有兼容提供商的余额查询器
 * 作为全局静态实例提供，所有方法均为静态方法
 */
export class BalanceQueryManager {
    private static queryHandlers = new Map<string, IBalanceQuery>();
    private static initialized = false;
    private static customUsageQuery = new CustomUsageQuery();

    /** 私有构造函数，禁止实例化 */
    private constructor() {}

    /**
     * 初始化管理器（注册默认处理器）
     * 首次调用任何静态方法时自动初始化
     */
    private static ensureInitialized(): void {
        if (!BalanceQueryManager.initialized) {
            BalanceQueryManager.registerDefaultHandlers();
            BalanceQueryManager.initialized = true;
        }
    }

    /**
     * 注册默认的余额查询器
     */
    private static registerDefaultHandlers(): void {
        BalanceQueryManager.registerHandler('aihubmix', new AiHubMixBalanceQuery());
    }

    /**
     * 注册余额查询器
     * @param providerId 提供商标识符
     * @param handler 余额查询器实例
     */
    static registerHandler(providerId: string, handler: IBalanceQuery): void {
        BalanceQueryManager.queryHandlers.set(providerId, handler);
        StatusLogger.debug(`[BalanceQueryManager] Registered balance query handler for provider ${providerId}`);
    }

    /**
     * 注销余额查询器
     * @param providerId 提供商标识符
     */
    static unregisterHandler(providerId: string): void {
        if (BalanceQueryManager.queryHandlers.has(providerId)) {
            BalanceQueryManager.queryHandlers.delete(providerId);
            StatusLogger.debug(`[BalanceQueryManager] Unregistered balance query handler for provider ${providerId}`);
        }
    }

    /**
     * 查询提供商余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    static async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        BalanceQueryManager.ensureInitialized();

        // 1. 内置/已知 provider 优先使用专用 handler
        const handler = BalanceQueryManager.queryHandlers.get(providerId);
        if (handler) {
            try {
                const result = await handler.queryBalance(providerId);
                StatusLogger.debug(
                    `[BalanceQueryManager] Successfully queried balance for provider ${providerId}: ${result.balance}`
                );
                return result;
            } catch (error) {
                StatusLogger.error(`[BalanceQueryManager] Failed to query balance for provider ${providerId}`, error);
                throw error;
            }
        }

        // 2. provider usage/usages 配置，使用通用查询
        if (BalanceQueryManager.isCustomProviderWithUsage(providerId)) {
            try {
                const result = await BalanceQueryManager.customUsageQuery.queryBalance(providerId);
                StatusLogger.debug(
                    `[BalanceQueryManager] Successfully queried custom balance for provider ${providerId}: ${result.balance}`
                );
                return result;
            } catch (error) {
                StatusLogger.error(`[BalanceQueryManager] Failed to query balance for provider ${providerId}`, error);
                throw error;
            }
        }

        // 3. 如果没有注册的查询器，返回默认值
        StatusLogger.warn(
            `[BalanceQueryManager] No balance query handler found for provider ${providerId}, using default value`
        );
        return {
            balance: 0,
            currency: 'CNY'
        };
    }

    /**
     * 获取所有已注册的提供商ID
     * 包含内置/已知 provider 以及配置了 usage/usages 的 provider
     * @returns 提供商ID列表
     */
    static getRegisteredProviders(): string[] {
        BalanceQueryManager.ensureInitialized();
        const staticProviders = Array.from(BalanceQueryManager.queryHandlers.keys());
        const customUsageEntries = BalanceQueryManager.getCustomUsageEntries().map(entry => entry.id);
        return [...new Set([...staticProviders, ...customUsageEntries])];
    }

    /**
     * 获取给定基础 provider 对应的所有可查询入口。
     * - 内置 provider 返回自身
     * - 自定义 usages provider 返回该 provider 下的全部 usage entry
     * - 已经是 usage entry id 时原样返回
     */
    static getRegisteredProvidersForBaseProvider(providerId: string): string[] {
        BalanceQueryManager.ensureInitialized();

        if (BalanceQueryManager.queryHandlers.has(providerId)) {
            return [providerId];
        }

        const exactCustomEntry = BalanceQueryManager.getCustomUsageEntry(providerId);
        if (exactCustomEntry) {
            return [providerId];
        }

        return BalanceQueryManager.getCustomUsageEntries(providerId).map(entry => entry.id);
    }

    /**
     * 获取配置了 usage/usages 的 provider 基础 ID 列表
     * @returns provider ID 列表
     */
    static getCustomProvidersWithUsage(): string[] {
        const providerIds = Array.from(
            new Set(
                CompatibleModelManager.getModels()
                    .map(model => model.provider)
                    .filter(Boolean)
            )
        );
        return providerIds.filter(id => BalanceQueryManager.getCustomUsageEntries(id).length > 0);
    }

    /**
     * 判断指定 provider 是否是可直接查询的自定义 usage provider
     * @param providerId 提供商标识符
     * @returns 是否可直接用于 usage 查询
     */
    static isCustomProviderWithUsage(providerId: string): boolean {
        if (BalanceQueryManager.getCustomUsageEntry(providerId)) {
            return true;
        }

        return BalanceQueryManager.getCustomUsageEntries(providerId).length === 1;
    }

    /**
     * 判断基础 provider 是否配置了 usage/usages。
     */
    static hasCustomUsageEntries(providerId: string): boolean {
        return BalanceQueryManager.getCustomUsageEntries(providerId).length > 0;
    }

    /**
     * 获取 provider/usage entry 对应的基础 provider ID。
     */
    static getBaseProviderId(providerId: string): string {
        return parseCustomUsageTarget(providerId).baseProviderId;
    }

    /**
     * 获取 usage entry 的显示名称（优先 displayName，其次 usage key）。
     */
    static getCustomUsageDisplayName(providerId: string): string | undefined {
        const entry = BalanceQueryManager.getCustomUsageEntry(providerId);
        if (!entry) {
            return undefined;
        }

        if (entry.usageKey === 'default' && !entry.usageConfig.displayName) {
            return undefined;
        }

        return entry.usageConfig.displayName || entry.usageKey;
    }

    /**
     * 判断指定 provider/usage entry 是否需要 API Key。
     */
    static requiresApiKey(providerId: string): boolean {
        const entry = BalanceQueryManager.getCustomUsageEntry(providerId);
        if (!entry) {
            return true;
        }

        return entry.usageConfig.authType !== 'none';
    }

    /**
     * 检查是否已注册指定提供商的查询器
     * @param providerId 提供商标识符
     * @returns 是否已注册
     */
    static hasHandler(providerId: string): boolean {
        BalanceQueryManager.ensureInitialized();
        return BalanceQueryManager.queryHandlers.has(providerId);
    }

    private static getCustomUsageEntries(baseProviderId?: string) {
        const overrides = ConfigManager.getProviderOverrides();
        const configuredProviderIds = Array.from(
            new Set(
                CompatibleModelManager.getModels()
                    .map(model => model.provider)
                    .filter(Boolean)
            )
        );
        const providerIds =
            baseProviderId ? configuredProviderIds.filter(id => id === baseProviderId) : configuredProviderIds;

        return providerIds.flatMap(providerId => {
            const override = mergeProviderUsageOverride(KnownProviders[providerId], overrides[providerId]);
            return resolveCustomUsageEntries(providerId, override);
        });
    }

    private static getCustomUsageEntry(providerId: string): ResolvedCustomUsageEntry | undefined {
        const { baseProviderId, usageKey } = parseCustomUsageTarget(providerId);
        if (!usageKey) {
            return undefined;
        }

        return BalanceQueryManager.getCustomUsageEntries(baseProviderId).find(entry => entry.usageKey === usageKey);
    }
}
