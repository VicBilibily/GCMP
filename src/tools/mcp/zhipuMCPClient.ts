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
import { VersionManager } from '../../utils/versionManager';
import { ZhipuSearchResult } from '../zhipuSearch';

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
        const key = apiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!key) {
            throw new Error('智谱AI API密钥未设置');
        }

        let instance = ZhipuMCPWebSearchClient.clientCache.get(key);

        if (!instance) {
            Logger.debug(`📦 [Zhipu MCP] 创建新的客户端实例 (API key: ${key.substring(0, 8)}...)`);
            instance = new ZhipuMCPWebSearchClient();
            instance.currentApiKey = key;
            ZhipuMCPWebSearchClient.clientCache.set(key, instance);
        } else {
            Logger.debug(`♻️ [Zhipu MCP] 复用已缓存的客户端实例 (API key: ${key.substring(0, 8)}...)`);
        }

        await instance.ensureConnected();

        return instance;
    }

    static async clearCache(apiKey?: string): Promise<void> {
        if (apiKey) {
            const instance = ZhipuMCPWebSearchClient.clientCache.get(apiKey);
            if (instance) {
                await instance.cleanup();
                ZhipuMCPWebSearchClient.clientCache.delete(apiKey);
                Logger.info(`🗑️ [Zhipu MCP] 已清除 API key ${apiKey.substring(0, 8)}... 的缓存`);
            }
        } else {
            for (const [key, instance] of ZhipuMCPWebSearchClient.clientCache.entries()) {
                await instance.cleanup();
                Logger.info(`🗑️ [Zhipu MCP] 已清除 API key ${key.substring(0, 8)}... 的缓存`);
            }
            ZhipuMCPWebSearchClient.clientCache.clear();
            Logger.info('🗑️ [Zhipu MCP] 已清除所有客户端缓存');
        }
    }

    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        const stats = {
            totalClients: ZhipuMCPWebSearchClient.clientCache.size,
            connectedClients: 0,
            apiKeys: [] as string[]
        };

        for (const [key, instance] of ZhipuMCPWebSearchClient.clientCache.entries()) {
            if (instance.isConnected()) {
                stats.connectedClients++;
            }
            stats.apiKeys.push(key.substring(0, 8) + '...');
        }

        return stats;
    }

    private async handleErrorResponse(error: Error): Promise<void> {
        const errorMessage = error.message;

        if (errorMessage.includes('403') || errorMessage.includes('您无权访问')) {
            if (errorMessage.includes('search-prime') || errorMessage.includes('web_search_prime')) {
                Logger.warn(`⚠️ [Zhipu MCP] 检测到联网搜索 MCP 权限不足: ${errorMessage}`);

                const shouldDisableMCP = await this.showMCPDisableDialog();

                if (shouldDisableMCP) {
                    await this.disableMCPMode();
                    throw new Error('智谱AI搜索权限不足：MCP模式已禁用，请重新尝试搜索。');
                } else {
                    throw new Error(
                        '智谱AI搜索权限不足：您的账户无权访问联网搜索 MCP 功能。请检查您的智谱AI套餐订阅状态。'
                    );
                }
            } else {
                throw new Error('智谱AI搜索权限不足：403错误。请检查您的API密钥权限或套餐订阅状态。');
            }
        } else if (errorMessage.includes('MCP error')) {
            const mcpErrorMatch = errorMessage.match(/MCP error (\d+): (.+)/);
            if (mcpErrorMatch) {
                const [, errorCode, errorDesc] = mcpErrorMatch;
                throw new Error(`智谱AI MCP协议错误 ${errorCode}: ${errorDesc}`);
            }
        }

        throw error;
    }

    private async showMCPDisableDialog(): Promise<boolean> {
        const message =
            '检测到您的智谱AI账户无权访问联网搜索 MCP 功能。这可能是因为：\n\n' +
            '1. 您的账户不支持 MCP 功能（需要 Coding Plan 套餐）\n' +
            '2. API 密钥权限不足\n\n' +
            '是否切换到标准计费模式（按次计费）？';

        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            '切换到标准模式',
            '保持MCP模式'
        );

        return result === '切换到标准模式';
    }

    private async disableMCPMode(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gcmp.zhipu.search');
            await config.update('enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [Zhipu MCP] MCP模式已禁用，已切换到标准计费模式');

            vscode.window.showInformationMessage(
                '智谱AI搜索已切换到标准计费模式（按次计费）。您可以在设置中重新启用 MCP 模式。'
            );

            await this.internalCleanup();
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] 禁用MCP模式失败', error instanceof Error ? error : undefined);
            throw new Error(`禁用MCP模式失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        return !!apiKey;
    }

    private isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    private async ensureConnected(): Promise<void> {
        if (this.isConnected()) {
            Logger.debug('✅ [Zhipu MCP] 客户端已连接');
            return;
        }

        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [Zhipu MCP] 等待连接完成...');
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
            Logger.debug('✅ [Zhipu MCP] 客户端已初始化');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!apiKey) {
            throw new Error('智谱AI API密钥未设置');
        }

        this.currentApiKey = apiKey;

        Logger.info('🔗 [Zhipu MCP] 初始化 MCP 客户端...');

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
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [Zhipu MCP] 使用 StreamableHTTP 传输连接成功');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] 客户端初始化失败', error instanceof Error ? error : undefined);
            await this.internalCleanup();
            throw new Error(`MCP 客户端连接失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    async search(params: ZhipuWebSearchRequest): Promise<ZhipuSearchResult[]> {
        Logger.info(`🔍 [Zhipu MCP] 开始搜索: "${params.search_query}"`);

        await this.ensureConnected();

        if (!this.client) {
            throw new Error('MCP 客户端未初始化');
        }

        try {
            const tools = await this.client.listTools();
            Logger.debug(`📋 [Zhipu MCP] 可用工具: ${tools.tools.map(t => t.name).join(', ')}`);

            const webSearchTool = tools.tools.find(t => t.name === 'web_search_prime');
            if (!webSearchTool) {
                throw new Error('未找到 web_search_prime 工具');
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
                Logger.debug(`📊 [Zhipu MCP] 工具调用成功: ${searchResults?.length || 0}个结果`);
                return searchResults;
            }

            Logger.debug('📊 [Zhipu MCP] 工具调用结束: 无结果');
            return [];
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] 搜索失败', error instanceof Error ? error : undefined);

            if (error instanceof Error) {
                await this.handleErrorResponse(error);
            }

            if (error instanceof Error && (error.message.includes('连接') || error.message.includes('connect'))) {
                Logger.warn('⚠️ [Zhipu MCP] 检测到连接错误，将在下次搜索时自动重连');
                await this.internalCleanup();
            }

            throw new Error(`搜索失败: ${error instanceof Error ? error.message : '未知错误'}`);
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
        Logger.debug('🔌 [Zhipu MCP] 清理客户端连接...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }

            this.client = null;

            Logger.debug('✅ [Zhipu MCP] 客户端连接已清理');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] 连接清理失败', error instanceof Error ? error : undefined);
        }
    }

    async cleanup(): Promise<void> {
        Logger.info('🔌 [Zhipu MCP] 清理客户端资源...');

        try {
            await this.internalCleanup();

            if (this.currentApiKey) {
                ZhipuMCPWebSearchClient.clientCache.delete(this.currentApiKey);
                Logger.info(`🗑️ [Zhipu MCP] 已从缓存中移除客户端 (API key: ${this.currentApiKey.substring(0, 8)}...)`);
            }

            Logger.info('✅ [Zhipu MCP] 客户端资源已清理');
        } catch (error) {
            Logger.error('❌ [Zhipu MCP] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }

    async reconnect(): Promise<void> {
        Logger.info('🔄 [Zhipu MCP] 重新连接客户端...');
        await this.internalCleanup();
        await this.ensureConnected();
    }
}
