/*---------------------------------------------------------------------------------------------
 *  阿里云百炼 DashScope MCP WebSearch 客户端
 *  使用官方 @modelcontextprotocol/sdk 通过 StreamableHTTP 连接百炼 WebSearch MCP
 *--------------------------------------------------------------------------------------------*/

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../../utils/logger';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { VersionManager } from '../../utils/versionManager';

/**
 * DashScope 搜索请求参数
 */
export interface DashscopeWebSearchRequest {
    query: string;
    count?: number;
}

/**
 * DashScope 搜索结果页项
 */
export interface DashscopeSearchPage {
    title: string;
    url: string;
    snippet: string;
    hostname?: string;
    hostlogo?: string;
}

/**
 * DashScope MCP 原始响应
 */
export interface DashscopeMCPResponse {
    pages: DashscopeSearchPage[];
    request_id?: string;
    tools?: unknown[];
    status?: number;
}

/**
 * DashScope MCP WebSearch 客户端
 */
export class DashscopeMCPWebSearchClient {
    private static clientCache = new Map<string, DashscopeMCPWebSearchClient>();

    private static readonly MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp';

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;
    private activeSearchCount = 0;
    private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
    private cleanupPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('DashScopeMCPWebSearch');
    }

    static async getInstance(apiKey?: string): Promise<DashscopeMCPWebSearchClient> {
        const key = apiKey || (await ApiKeyManager.getApiKey('dashscope'));
        if (!key) {
            throw new Error('DashScope API密钥未设置，请先运行命令"GCMP: 设置 DashScope API密钥"');
        }

        let instance = DashscopeMCPWebSearchClient.clientCache.get(key);
        if (!instance) {
            Logger.debug(`📦 [DashScope MCP] 创建新的客户端实例 (API key: ${key.substring(0, 8)}...)`);
            instance = new DashscopeMCPWebSearchClient();
            instance.currentApiKey = key;
            DashscopeMCPWebSearchClient.clientCache.set(key, instance);
        } else {
            Logger.debug(`♻️ [DashScope MCP] 复用已缓存的客户端实例 (API key: ${key.substring(0, 8)}...)`);
        }

        await instance.ensureConnected();
        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        if (apiKey) {
            const instance = DashscopeMCPWebSearchClient.clientCache.get(apiKey);
            if (instance) {
                await instance.cleanup();
                DashscopeMCPWebSearchClient.clientCache.delete(apiKey);
                Logger.info(`🗑️ [DashScope MCP] 已清除 API key ${apiKey.substring(0, 8)}... 的缓存`);
            }
        } else {
            for (const [key, instance] of DashscopeMCPWebSearchClient.clientCache.entries()) {
                await instance.cleanup();
                Logger.info(`🗑️ [DashScope MCP] 已清除 API key ${key.substring(0, 8)}... 的缓存`);
            }
            DashscopeMCPWebSearchClient.clientCache.clear();
            Logger.info('🗑️ [DashScope MCP] 已清除所有客户端缓存');
        }
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        const stats = {
            totalClients: DashscopeMCPWebSearchClient.clientCache.size,
            connectedClients: 0,
            apiKeys: [] as string[]
        };

        for (const [key, instance] of DashscopeMCPWebSearchClient.clientCache.entries()) {
            if (instance.isConnected()) {
                stats.connectedClients++;
            }
            stats.apiKeys.push(key.substring(0, 8) + '...');
        }

        return stats;
    }

    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('dashscope');
        return !!apiKey;
    }

    private isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    private async ensureConnected(): Promise<void> {
        this.cancelPendingCleanup();

        if (this.cleanupPromise) {
            Logger.debug('⏳ [DashScope MCP] 等待连接清理完成...');
            await this.cleanupPromise;
        }

        if (this.isConnected()) {
            Logger.debug('✅ [DashScope MCP] 客户端已连接');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [DashScope MCP] 等待连接完成...');
            return this.connectionPromise;
        }

        this.isConnecting = true;
        this.connectionPromise = this.initializeClient().finally(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
        });

        return this.connectionPromise;
    }

    private async initializeClient(): Promise<void> {
        if (this.client && this.transport) {
            Logger.debug('✅ [DashScope MCP] 客户端已初始化');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('dashscope'));
        if (!apiKey) {
            throw new Error('DashScope API密钥未设置');
        }

        this.currentApiKey = apiKey;

        Logger.info('🔗 [DashScope MCP] 初始化 MCP 客户端...');

        try {
            this.client = new Client(
                {
                    name: 'GCMP-DashScope-WebSearch-Client',
                    version: VersionManager.getVersion()
                },
                {
                    capabilities: {}
                }
            );

            this.transport = new StreamableHTTPClientTransport(new URL(DashscopeMCPWebSearchClient.MCP_URL), {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                },
                reconnectionOptions: {
                    maxRetries: 2,
                    initialReconnectionDelay: 300, // 30秒初始重连延迟
                    maxReconnectionDelay: 120000, // 最大2分钟
                    reconnectionDelayGrowFactor: 2.0
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [DashScope MCP] 使用 StreamableHTTP 传输连接成功');
        } catch (error) {
            let errorDetail = error instanceof Error ? error.message : String(error);
            let cause: unknown = error instanceof Error ? error.cause : undefined;
            while (cause) {
                errorDetail += ` | cause: ${cause instanceof Error ? cause.message : String(cause)}`;
                cause = cause instanceof Error ? cause.cause : undefined;
            }
            Logger.error(`❌ [DashScope MCP] 客户端初始化失败 ${errorDetail}`);
            await this.internalCleanup();
            throw new Error(`MCP 客户端连接失败: ${errorDetail}`);
        }
    }

    async search(params: DashscopeWebSearchRequest): Promise<DashscopeSearchPage[]> {
        Logger.info(`🔍 [DashScope MCP] 开始搜索: "${params.query}"`);

        this.cancelPendingCleanup();
        this.activeSearchCount++;

        await this.ensureConnected();

        if (!this.client) {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            throw new Error('MCP 客户端未初始化');
        }

        try {
            const tools = await this.client.listTools();
            Logger.debug(`📋 [DashScope MCP] 可用工具: ${tools.tools.map(t => t.name).join(', ')}`);

            const webSearchTool = tools.tools.find(t => t.name === 'bailian_web_search');
            if (!webSearchTool) {
                throw new Error('未找到 bailian_web_search 工具，请确认已开通百炼联网搜索 MCP 服务');
            }

            const result = await this.client.callTool({
                name: 'bailian_web_search',
                arguments: {
                    query: params.query,
                    ...(params.count ? { count: params.count } : {})
                }
            });

            if (Array.isArray(result.content) && result.content.length > 0) {
                const text = result.content.map(item => (item.type === 'text' ? item.text : '')).join('\n');
                if (text.startsWith('MCP error')) {
                    throw new Error(text);
                }
                const response = JSON.parse(text) as DashscopeMCPResponse;
                const pages = response.pages || [];
                Logger.info(`✅ [DashScope MCP] 搜索完成: 找到 ${pages.length} 个结果`);
                return pages;
            }
            Logger.debug('📊 [DashScope MCP] 工具调用结束: 无结果');
            return [];
        } catch (error) {
            Logger.error('❌ [DashScope MCP] 搜索失败', error instanceof Error ? error : undefined);

            if (error instanceof Error && (error.message.includes('连接') || error.message.includes('connect'))) {
                Logger.warn('⚠️ [DashScope MCP] 检测到连接错误，将在下次搜索时自动重连');
                await this.internalCleanup();
            }

            throw new Error(`搜索失败: ${error instanceof Error ? error.message : '未知错误'}`);
        } finally {
            this.activeSearchCount = Math.max(0, this.activeSearchCount - 1);
            this.scheduleCleanupAfterIdle();
        }
    }

    getStatus(): { name: string; version: string; enabled: boolean; connected: boolean } {
        return {
            name: 'GCMP-DashScope-MCP-WebSearch-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connected: this.isConnected()
        };
    }

    private async internalCleanup(): Promise<void> {
        Logger.debug('🔌 [DashScope MCP] 清理客户端连接...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }
            this.client = null;
            Logger.debug('✅ [DashScope MCP] 客户端连接已清理');
        } catch (error) {
            Logger.error('❌ [DashScope MCP] 连接清理失败', error instanceof Error ? error : undefined);
        }
    }

    private cancelPendingCleanup(): void {
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    private scheduleCleanupAfterIdle(): void {
        if (this.activeSearchCount > 0 || this.cleanupTimer || this.cleanupPromise) {
            return;
        }

        // 延迟到事件循环的下一拍再清理，避免并发搜索共享实例时互相关闭连接。
        this.cleanupTimer = setTimeout(() => {
            this.cleanupTimer = null;
            void this.cleanupIfIdle();
        }, 0);
    }

    private async cleanupIfIdle(): Promise<void> {
        if (this.activeSearchCount > 0 || this.cleanupPromise) {
            return;
        }

        this.cleanupPromise = (async () => {
            await this.internalCleanup();
            Logger.debug('🔌 [DashScope MCP] 空闲后已关闭连接');
        })().finally(() => {
            this.cleanupPromise = null;
        });

        await this.cleanupPromise;
    }

    async cleanup(): Promise<void> {
        this.cancelPendingCleanup();
        await this.internalCleanup();
    }
}
