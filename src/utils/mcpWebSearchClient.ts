/*---------------------------------------------------------------------------------------------
 *  基于 MCP SDK 的标准 WebSearch 客户端
 *  使用官方 @modelcontextprotocol/sdk 替换自定义 SSE 实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Logger } from './logger';
import { ConfigManager } from './configManager';
import { ApiKeyManager } from './apiKeyManager';
import { VersionManager } from './versionManager';
import { ZhipuSearchResult } from '../tools/zhipuSearch';

/**
 * 搜索请求参数
 */
export interface WebSearchRequest {
    search_query: string;
    search_engine?: 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';
    search_intent?: boolean;
    count?: number;
    search_domain_filter?: string;
    search_recency_filter?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
    content_size?: 'low' | 'medium' | 'high';
}

/**
 * MCP WebSearch 客户端 - 使用标准 MCP SDK
 */
export class MCPWebSearchClient {
    // 静态缓存：根据 API key 缓存客户端实例
    private static clientCache = new Map<string, MCPWebSearchClient>();

    private client: Client | null = null;
    private transport: StreamableHTTPClientTransport | null = null;
    private readonly userAgent: string;
    private currentApiKey: string | null = null;
    private isConnecting = false;
    private connectionPromise: Promise<void> | null = null;

    private constructor() {
        this.userAgent = VersionManager.getUserAgent('MCPWebSearch');
    }

    /**
     * 获取或创建客户端实例（单例模式，基于 API key）
     */
    static async getInstance(apiKey?: string): Promise<MCPWebSearchClient> {
        const key = apiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!key) {
            throw new Error('智谱AI API密钥未设置');
        }

        // 检查缓存中是否存在该 API key 的客户端
        let instance = MCPWebSearchClient.clientCache.get(key);

        if (!instance) {
            Logger.debug(`📦 [MCP WebSearch] 创建新的客户端实例 (API key: ${key.substring(0, 8)}...)`);
            instance = new MCPWebSearchClient();
            instance.currentApiKey = key;
            MCPWebSearchClient.clientCache.set(key, instance);
        } else {
            Logger.debug(`♻️ [MCP WebSearch] 复用已缓存的客户端实例 (API key: ${key.substring(0, 8)}...)`);
        }

        // 确保客户端已初始化和连接
        await instance.ensureConnected();

        return instance;
    }

    /**
     * 清除指定 API key 的缓存
     */
    static async clearCache(apiKey?: string): Promise<void> {
        if (apiKey) {
            const instance = MCPWebSearchClient.clientCache.get(apiKey);
            if (instance) {
                await instance.cleanup();
                MCPWebSearchClient.clientCache.delete(apiKey);
                Logger.info(`🗑️ [MCP WebSearch] 已清除 API key ${apiKey.substring(0, 8)}... 的缓存`);
            }
        } else {
            // 清除所有缓存
            for (const [key, instance] of MCPWebSearchClient.clientCache.entries()) {
                await instance.cleanup();
                Logger.info(`🗑️ [MCP WebSearch] 已清除 API key ${key.substring(0, 8)}... 的缓存`);
            }
            MCPWebSearchClient.clientCache.clear();
            Logger.info('🗑️ [MCP WebSearch] 已清除所有客户端缓存');
        }
    }

    /**
     * 获取缓存统计信息
     */
    static getCacheStats(): { totalClients: number; connectedClients: number; apiKeys: string[] } {
        const stats = {
            totalClients: MCPWebSearchClient.clientCache.size,
            connectedClients: 0,
            apiKeys: [] as string[]
        };

        for (const [key, instance] of MCPWebSearchClient.clientCache.entries()) {
            if (instance.isConnected()) {
                stats.connectedClients++;
            }
            stats.apiKeys.push(key.substring(0, 8) + '...');
        }

        return stats;
    }

    /**
     * 处理错误响应
     */
    private async handleErrorResponse(error: Error): Promise<void> {
        const errorMessage = error.message;

        // 检查是否是403权限错误
        if (errorMessage.includes('403') || errorMessage.includes('您无权访问')) {
            // 特殊处理MCP 403权限错误
            if (errorMessage.includes('search-prime') || errorMessage.includes('web_search_prime')) {
                Logger.warn(`⚠️ [MCP WebSearch] 检测到联网搜索 MCP 权限不足: ${errorMessage}`);

                // 弹出用户对话框询问是否停用MCP模式
                const shouldDisableMCP = await this.showMCPDisableDialog();

                if (shouldDisableMCP) {
                    // 用户选择停用MCP模式，更新配置
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
            // 提取MCP错误信息
            const mcpErrorMatch = errorMessage.match(/MCP error (\d+): (.+)/);
            if (mcpErrorMatch) {
                const [, errorCode, errorDesc] = mcpErrorMatch;
                throw new Error(`智谱AI MCP协议错误 ${errorCode}: ${errorDesc}`);
            }
        }

        // 其他错误直接抛出
        throw error;
    }

    /**
     * 显示MCP禁用对话框
     */
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

    /**
     * 禁用MCP模式
     */
    private async disableMCPMode(): Promise<void> {
        try {
            // 更新配置：禁用MCP模式
            const config = vscode.workspace.getConfiguration('gcmp.zhipu.search');
            await config.update('enableMCP', false, vscode.ConfigurationTarget.Global);

            Logger.info('✅ [MCP WebSearch] MCP模式已禁用，已切换到标准计费模式');

            // 显示通知
            vscode.window.showInformationMessage(
                '智谱AI搜索已切换到标准计费模式（按次计费）。您可以在设置中重新启用 MCP 模式。'
            );

            // 清理当前客户端
            await this.internalCleanup();
        } catch (error) {
            Logger.error('❌ [MCP WebSearch] 禁用MCP模式失败', error instanceof Error ? error : undefined);
            throw new Error(`禁用MCP模式失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 检查是否可用
     */
    async isEnabled(): Promise<boolean> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        return !!apiKey;
    }

    /**
     * 检查是否已连接
     */
    private isConnected(): boolean {
        return this.client !== null && this.transport !== null;
    }

    /**
     * 确保客户端已连接（带自动重连）
     */
    private async ensureConnected(): Promise<void> {
        // 如果已经连接，直接返回
        if (this.isConnected()) {
            Logger.debug('✅ [MCP WebSearch] 客户端已连接');
            return;
        }

        // 如果正在连接中，等待连接完成
        if (this.isConnecting && this.connectionPromise) {
            Logger.debug('⏳ [MCP WebSearch] 等待连接完成...');
            return this.connectionPromise;
        }

        // 开始新的连接
        this.isConnecting = true;
        this.connectionPromise = this.initializeClient().finally(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
        });

        return this.connectionPromise;
    }

    /**
     * 初始化 MCP 客户端连接
     */
    private async initializeClient(): Promise<void> {
        if (this.client && this.transport) {
            Logger.debug('✅ [MCP WebSearch] 客户端已初始化');
            return;
        }

        const apiKey = this.currentApiKey || (await ApiKeyManager.getApiKey('zhipu'));
        if (!apiKey) {
            throw new Error('智谱AI API密钥未设置');
        }

        // 更新当前使用的 API key
        this.currentApiKey = apiKey;

        Logger.info('🔗 [MCP WebSearch] 初始化 MCP 客户端...');

        try {
            // 使用 StreamableHTTP 传输，通过 requestInit.headers 传递 Authorization token
            // 根据 endpoint 配置确定 MCP URL
            let httpUrl = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (endpoint === 'api.z.ai') {
                httpUrl = httpUrl.replace('open.bigmodel.cn', 'api.z.ai');
            }

            this.client = new Client(
                {
                    name: 'GCMP-WebSearch-Client',
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

            // 使用 StreamableHTTP 传输，通过 requestInit 传递认证 headers
            // 这是 MCP SDK 推荐的方式：通过 requestInit.headers 传递自定义 headers
            this.transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
                requestInit: {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': this.userAgent
                    }
                }
            });

            await this.client.connect(this.transport);
            Logger.info('✅ [MCP WebSearch] 使用 StreamableHTTP 传输连接成功（通过 Authorization header 认证）');
        } catch (error) {
            Logger.error('❌ [MCP WebSearch] 客户端初始化失败', error instanceof Error ? error : undefined);
            await this.internalCleanup();
            throw new Error(`MCP 客户端连接失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 执行搜索
     */
    async search(params: WebSearchRequest): Promise<ZhipuSearchResult[]> {
        Logger.info(`🔍 [MCP WebSearch] 开始搜索: "${params.search_query}"`);

        // 确保客户端已连接（自动重连）
        await this.ensureConnected();

        if (!this.client) {
            throw new Error('MCP 客户端未初始化');
        }

        try {
            // 列出可用工具
            const tools = await this.client.listTools();
            Logger.debug(`📋 [MCP WebSearch] 可用工具: ${tools.tools.map(t => t.name).join(', ')}`);

            // 查找 webSearchPrime 工具
            const webSearchTool = tools.tools.find(t => t.name === 'webSearchPrime');
            if (!webSearchTool) {
                throw new Error('未找到 webSearchPrime 工具');
            }

            // 调用搜索工具
            const result = await this.client.callTool({
                name: 'webSearchPrime',
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
                Logger.debug(`📊 [MCP WebSearch] 工具调用成功: ${searchResults?.length || 0}个结果`);
                return searchResults;
            }

            Logger.debug('📊 [MCP WebSearch] 工具调用结束: 无结果');
            return [];
        } catch (error) {
            Logger.error('❌ [MCP WebSearch] 搜索失败', error instanceof Error ? error : undefined);

            // 使用统一的错误处理
            if (error instanceof Error) {
                await this.handleErrorResponse(error);
            }

            // 检查是否是连接错误，如果是，标记为未连接以便下次自动重连
            if (error instanceof Error && (error.message.includes('连接') || error.message.includes('connect'))) {
                Logger.warn('⚠️ [MCP WebSearch] 检测到连接错误，将在下次搜索时自动重连');
                await this.internalCleanup();
            }

            throw new Error(`搜索失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
    }

    /**
     * 获取客户端状态
     */
    getStatus(): { name: string; version: string; enabled: boolean; connected: boolean } {
        return {
            name: 'GCMP-MCP-WebSearch-Client',
            version: VersionManager.getVersion(),
            enabled: true,
            connected: this.isConnected()
        };
    }

    /**
     * 内部清理方法（不从缓存中移除）
     */
    private async internalCleanup(): Promise<void> {
        Logger.debug('🔌 [MCP WebSearch] 清理客户端连接...');

        try {
            if (this.transport) {
                await this.transport.close();
                this.transport = null;
            }

            this.client = null;

            Logger.debug('✅ [MCP WebSearch] 客户端连接已清理');
        } catch (error) {
            Logger.error('❌ [MCP WebSearch] 连接清理失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 清理资源（公共方法，从缓存中移除）
     */
    async cleanup(): Promise<void> {
        Logger.info('🔌 [MCP WebSearch] 清理客户端资源...');

        try {
            await this.internalCleanup();

            // 从缓存中移除
            if (this.currentApiKey) {
                MCPWebSearchClient.clientCache.delete(this.currentApiKey);
                Logger.info(
                    `🗑️ [MCP WebSearch] 已从缓存中移除客户端 (API key: ${this.currentApiKey.substring(0, 8)}...)`
                );
            }

            Logger.info('✅ [MCP WebSearch] 客户端资源已清理');
        } catch (error) {
            Logger.error('❌ [MCP WebSearch] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 重新连接
     */
    async reconnect(): Promise<void> {
        Logger.info('🔄 [MCP WebSearch] 重新连接客户端...');
        await this.internalCleanup();
        await this.ensureConnected();
    }
}
