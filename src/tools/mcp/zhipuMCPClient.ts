/*---------------------------------------------------------------------------------------------
 *  智谱AI MCP WebSearch 客户端
 *  使用官方 @modelcontextprotocol/sdk 通过 StreamableHTTP 连接智谱 AI MCP
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from '../../utils/logger';
import { ConfigManager } from '../../utils/configManager';
import { ApiKeyManager } from '../../utils/apiKeyManager';
import { t } from '../../utils/l10n';
import { VersionManager } from '../../utils/versionManager';
import { ZhipuSearchResult } from '../zhipuSearch';
import { clearMCPClientCache, getMCPClientCacheStats, clearStaleMCPInstances } from './mcpCacheHelpers';

/**
 * 搜索请求参数
 */
export interface ZhipuWebSearchRequest {
    search_query: string;
    search_engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
    search_intent?: boolean;
    count?: number;
    search_domain_filter?: string;
    search_recency_filter?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
    content_size?: 'low' | 'medium' | 'high';
}

/**
 * 智谱AI MCP WebSearch 客户端
 */
export class ZhipuMCPWebSearchClient {
    private static clientCache = new Map<string, ZhipuMCPWebSearchClient>();

    private static buildCacheKey(apiKey: string): string {
        const endpoint = ConfigManager.getZhipuEndpoint();
        const proxyUrl = ConfigManager.resolveProxyForModel(undefined, 'zhipu') || '';
        return `${apiKey}::${endpoint}::${proxyUrl}`;
    }

    private static async clearStaleInstances(apiKey: string, activeCacheKey: string): Promise<void> {
        await clearStaleMCPInstances(this.clientCache, 'Zhipu MCP', apiKey, activeCacheKey);
    }

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('MCPWebSearch');
    }

    static async getInstance(apiKey?: string): Promise<ZhipuMCPWebSearchClient> {
        const resolvedApiKey = apiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!resolvedApiKey) {
            throw new Error(t('Zhipu AI API key is not configured', '智谱AI API密钥未设置'));
        }

        const cacheKey = this.buildCacheKey(resolvedApiKey);
        await this.clearStaleInstances(resolvedApiKey, cacheKey);

        let instance = ZhipuMCPWebSearchClient.clientCache.get(cacheKey);

        if (!instance) {
            Logger.debug(`📦 [Zhipu MCP] Creating new client instance (API key: ${resolvedApiKey.substring(0, 8)}...)`);
            instance = new ZhipuMCPWebSearchClient();
            instance.currentApiKey = resolvedApiKey;
            ZhipuMCPWebSearchClient.clientCache.set(cacheKey, instance);
        } else {
            Logger.debug(
                `♻️ [Zhipu MCP] Reusing cached client instance (API key: ${resolvedApiKey.substring(0, 8)}...)`
            );
        }

        await instance.ensureConnected();

        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        await clearMCPClientCache(this.clientCache, 'Zhipu MCP', apiKey);
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        return getMCPClientCacheStats(this.clientCache);
    }

    private async handleErrorResponse(error: Error): Promise<void> {
        const errorMessage = error.message;

        if (errorMessage.includes('403') || errorMessage.includes('您无权访问')) {
            if (errorMessage.includes('search-prime') || errorMessage.includes('web_search_prime')) {
                Logger.warn(`⚠️ [Zhipu MCP] Detected insufficient MCP permission for web search: ${errorMessage}`);

                const shouldDisableMCP = await this.showMCPDisableDialog();

                if (shouldDisableMCP) {
                    await this.disableMCPMode();
                    throw new Error(
                        t(
                            'Zhipu AI search permission denied: MCP mode was disabled. Please retry the search.',
                            '智谱AI搜索权限不足：MCP模式已禁用，请重新尝试搜索。'
                        )
                    );
                } else {
                    throw new Error(
                        t(
                            'Zhipu AI search permission denied: your account cannot access the web search MCP feature. Check your Zhipu AI plan subscription.',
                            '智谱AI搜索权限不足：您的账户无权访问联网搜索 MCP 功能。请检查您的智谱AI套餐订阅状态。'
                        )
                    );
                }
            } else {
                throw new Error(
                    t(
                        'Zhipu AI search permission denied: HTTP 403. Check your API key permissions or plan subscription status.',
                        '智谱AI搜索权限不足：403错误。请检查您的API密钥权限或套餐订阅状态。'
                    )
                );
            }
        } else if (errorMessage.includes('MCP error')) {
            const mcpErrorMatch = errorMessage.match(/MCP error (\d+): (.+)/);
            if (mcpErrorMatch) {
                const [, errorCode, errorDesc] = mcpErrorMatch;
                throw new Error(
                    t('Zhipu AI MCP protocol error {0}: {1}', '智谱AI MCP协议错误 {0}: {1}', errorCode, errorDesc)
                );
            }
        }

        throw error;
    }

    private async showMCPDisableDialog(): Promise<boolean> {
        const message = t(
            'Your Zhipu AI account cannot access the web search MCP feature. Possible reasons:\n\n1. Your account does not support MCP features (Coding Plan required)\n2. Your API key does not have sufficient permissions\n\nSwitch to standard billing mode (per-request billing)?',
            '检测到您的智谱AI账户无权访问联网搜索 MCP 功能。这可能是因为：\n\n1. 您的账户不支持 MCP 功能（需要 Coding Plan 套餐）\n2. API 密钥权限不足\n\n是否切换到标准计费模式（按次计费）？'
        );
        const switchLabel = t('Switch to standard mode', '切换到标准模式');
        const keepLabel = t('Keep MCP mode', '保持MCP模式');

        const result = await vscode.window.showWarningMessage(message, { modal: true }, switchLabel, keepLabel);

        return result === switchLabel;
    }

    private async disableMCPMode(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.zhipu.search');
            await config.update('enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [Zhipu MCP] MCP mode disabled, switched to standard billing mode');

            vscode.window.showInformationMessage(
                t(
                    'Zhipu AI search was switched to standard billing mode (per-request billing). You can re-enable MCP mode in settings.',
                    '智谱AI搜索已切换到标准计费模式（按次计费）。您可以在设置中重新启用 MCP 模式。'
                )
            );

            await this.internalCleanup();
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Failed to disable MCP mode', error instanceof Error ? error : undefined);
            throw new Error(
                t(
                    'Failed to disable MCP mode: {0}',
                    '禁用MCP模式失败: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                )
            );
        }
    }

    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        return !!apiKey;
    }

    isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    private async ensureConnected(): Promise<void> {
        if (this.isConnected()) {
            Logger.debug('✅ [Zhipu MCP] Client connected');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [Zhipu MCP] Waiting for connection to complete...');
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
            Logger.debug('✅ [Zhipu MCP] Client initialized');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!apiKey) {
            throw new Error(t('Zhipu AI API key is not configured', '智谱AI API密钥未设置'));
        }

        this.currentApiKey = apiKey;

        Logger.info('🔗 [Zhipu MCP] Initializing MCP client...');

        try {
            let httpUrl = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (endpoint === 'api.z.ai') {
                httpUrl = httpUrl.replace('open.bigmodel.cn', 'api.z.ai');
            }

            this.client = new Client(
                {
                    name: 'GCMP-Zhipu-WebSearch-Client',
                    version: VersionManager.getVersion()
                },
                {
                    capabilities: {
                        sampling: {
                            tools: {}
                        }
                    }
                }
            );

            this.transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
                fetch: ConfigManager.createProxyAwareFetch({ providerKey: 'zhipu' }) as typeof fetch,
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [Zhipu MCP] Connected using StreamableHTTP transport');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Client initialization failed', error instanceof Error ? error : undefined);
            await this.internalCleanup();
            throw new Error(
                t(
                    'MCP client connection failed: {0}',
                    'MCP 客户端连接失败: {0}',
                    error instanceof Error ? error.message : 'Unknown error'
                )
            );
        }
    }

    async search(params: ZhipuWebSearchRequest): Promise<ZhipuSearchResult[]> {
        Logger.info(`🔍 [Zhipu MCP] Starting search: "${params.search_query}"`);

        await this.ensureConnected();

        if (!this.client) {
            throw new Error(t('MCP client is not initialized', 'MCP 客户端未初始化'));
        }

        try {
            const tools = await this.client.listTools();
            Logger.debug(`📋 [Zhipu MCP] Available tools: ${tools.tools.map(t => t.name).join(', ')}`);

            const webSearchTool = tools.tools.find(t => t.name === 'web_search_prime');
            if (!webSearchTool) {
                throw new Error(t('web_search_prime tool not found', '未找到 web_search_prime 工具'));
            }

            const result = await this.client.callTool({
                name: 'web_search_prime',
                arguments: {
                    search_query: params.search_query,
                    search_engine: params.search_engine || 'search_std',
                    search_intent: params.search_intent || false,
                    count: params.count || 10,
                    search_domain_filter: params.search_domain_filter,
                    search_recency_filter: params.search_recency_filter || 'noLimit',
                    content_size: params.content_size || 'medium'
                }
            });

            if (Array.isArray(result.content)) {
                const [{ text }] = result.content as { type: 'text'; text: string }[];
                if (text.startsWith('MCP error')) {
                    throw new Error(text);
                }
                const searchResults = JSON.parse(JSON.parse(text) as string) as ZhipuSearchResult[];
                Logger.debug(`📊 [Zhipu MCP] Tool call succeeded: ${searchResults?.length || 0} results`);
                return searchResults;
            }

            Logger.debug('📊 [Zhipu MCP] Tool call ended with no results');
            return [];
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Search failed', error instanceof Error ? error : undefined);

            if (error instanceof Error) {
                await this.handleErrorResponse(error);
            }

            if (error instanceof Error && (error.message.includes('连接') || error.message.includes('connect'))) {
                Logger.warn('⚠️ [Zhipu MCP] Connection error detected, will auto-reconnect on next search');
                await this.internalCleanup();
            }

            throw new Error(
                t('Search failed: {0}', '搜索失败: {0}', error instanceof Error ? error.message : 'Unknown error')
            );
        }
    }

    getStatus(): { name: string; version: string; enabled: boolean; connected: boolean } {
        return {
            name: 'GCMP-Zhipu-MCP-WebSearch-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connected: this.isConnected()
        };
    }

    private async internalCleanup(): Promise<void> {
        Logger.debug('🔌 [Zhipu MCP] Cleaning up client connection...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }

            this.client = null;

            Logger.debug('✅ [Zhipu MCP] Client connection cleaned up');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Connection cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    async cleanup(): Promise<void> {
        Logger.info('🔌 [Zhipu MCP] Cleaning up client resources...');

        try {
            await this.internalCleanup();

            if (this.currentApiKey) {
                ZhipuMCPWebSearchClient.clientCache.delete(this.currentApiKey);
                Logger.info(
                    `🗑️ [Zhipu MCP] Removed client from cache (API key: ${this.currentApiKey.substring(0, 8)}...)`
                );
            }

            Logger.info('✅ [Zhipu MCP] Client resources cleaned up');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] Failed to clean up resources', error instanceof Error ? error : undefined);
        }
    }

    async reconnect(): Promise<void> {
        Logger.info('🔄 [Zhipu MCP] Reconnecting client...');
        await this.internalCleanup();
        await this.ensureConnected();
    }
}
