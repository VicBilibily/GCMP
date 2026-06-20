/*---------------------------------------------------------------------------------------------
 *  MCP 客户端缓存管理共享工具
 *  为 DashscopeMCPWebSearchClient / StepFunMCPWebSearchClient / ZhipuMCPWebSearchClient
 *  提供 clearCache / getCacheStats / clearStaleInstances 的通用实现，消除三处样板重复
 *--------------------------------------------------------------------------------------------*/

import { Logger } from '../../utils/logger';

/**
 * MCP 客户端实例的最小契约：支持 cleanup 与连接状态查询
 */
export interface MCPClientInstance {
    cleanup(): Promise<void>;
    isConnected(): boolean;
}

/**
 * 按 apiKey 清空缓存中匹配的实例，或清空全部
 * @param cache 各 MCP 客户端类的 clientCache 静态 Map
 * @param logPrefix 日志前缀，如 'DashScope MCP'
 * @param apiKey 可选；提供时仅清该 key 对应的实例，否则清空全部
 */
export async function clearMCPClientCache<T extends MCPClientInstance>(
    cache: Map<string, T>,
    logPrefix: string,
    apiKey?: string
): Promise<void> {
    if (apiKey) {
        const apiKeyPrefix = `${apiKey}::`;
        let removedCount = 0;
        for (const [cacheKey, instance] of cache.entries()) {
            if (cacheKey.startsWith(apiKeyPrefix)) {
                await instance.cleanup();
                cache.delete(cacheKey);
                removedCount++;
            }
        }
        if (removedCount > 0) {
            Logger.info(
                `🗑️ [${logPrefix}] Cleared ${removedCount} cache entr${removedCount === 1 ? 'y' : 'ies'} for API key ${apiKey.substring(0, 8)}...`
            );
        }
    } else {
        for (const [key, instance] of cache.entries()) {
            await instance.cleanup();
            Logger.info(`🗑️ [${logPrefix}] Cleared cache for API key ${key.substring(0, 8)}...`);
        }
        cache.clear();
        Logger.info(`🗑️ [${logPrefix}] All client caches cleared`);
    }
}

/**
 * 返回缓存的统计信息（总数、已连接数、API Key 前缀列表）
 */
export function getMCPClientCacheStats<T extends MCPClientInstance>(
    cache: Map<string, T>
): {
    totalClients: number;
    connectedClients: number;
    apiKeys: string[];
} {
    const stats = {
        totalClients: cache.size,
        connectedClients: 0,
        apiKeys: [] as string[]
    };

    for (const [key, instance] of cache.entries()) {
        if (instance.isConnected()) {
            stats.connectedClients++;
        }
        stats.apiKeys.push(key.substring(0, 8) + '...');
    }

    return stats;
}

/**
 * 清除同一 apiKey 下、与当前活动 cacheKey 不一致的陈旧实例
 * 用于切换 endpoint/proxy 后清理旧连接
 */
export async function clearStaleMCPInstances<T extends MCPClientInstance>(
    cache: Map<string, T>,
    logPrefix: string,
    apiKey: string,
    activeCacheKey: string
): Promise<void> {
    const apiKeyPrefix = `${apiKey}::`;
    for (const [cacheKey, instance] of cache.entries()) {
        if (cacheKey !== activeCacheKey && cacheKey.startsWith(apiKeyPrefix)) {
            await instance.cleanup();
            cache.delete(cacheKey);
            Logger.info(`🧹 [${logPrefix}] Cleared stale client cache for API key ${apiKey.substring(0, 8)}...`);
        }
    }
}
