/*---------------------------------------------------------------------------------------------
 *  智谱AI联网搜索工具
 *  支持MCP和标准计费接口的切换
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { t } from '../utils/l10n';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { ZhipuMCPWebSearchClient, type ZhipuWebSearchRequest } from './mcp/zhipuMCPClient';
import { StatusBarManager } from '../status/statusBarManager';

/**
 * 智谱AI搜索引擎类型
 */
export type ZhipuSearchEngine = 'search_std' | 'search_pro' | 'search_pro_sogou' | 'search_pro_quark';

/**
 * 搜索请求参数
 */
export interface ZhipuSearchRequest {
    search_query: string;
    search_engine?: ZhipuSearchEngine;
    search_intent?: boolean;
    count?: number;
    search_domain_filter?: string;
    search_recency_filter?: 'noLimit' | 'day' | 'week' | 'month' | 'year';
    content_size?: 'low' | 'medium' | 'high';
    request_id?: string;
    user_id?: string;
}

/**
 * 搜索结果项
 */
export interface ZhipuSearchResult {
    title: string;
    link: string;
    content: string;
    media?: string;
    icon?: string;
    refer?: string;
    publish_date?: string;
}

/**
 * 搜索响应
 */
export interface ZhipuSearchResponse {
    id: string;
    created: number;
    request_id?: string;
    search_intent?: Array<{
        query: string;
        intent: string;
        keywords: string;
    }>;
    search_result: ZhipuSearchResult[];
}

/**
 * 智谱AI联网搜索工具
 */
export class ZhipuSearchTool {
    private readonly baseURL = 'https://open.bigmodel.cn/api/paas/v4';
    // MCP 客户端使用单例模式，不在这里直接实例化

    /**
     * 检查是否启用 MCP 模式
     */
    private isMCPEnabled(): boolean {
        const config = ConfigManager.getZhipuSearchConfig();
        return config.enableMCP;
    }

    /**
     * 通过 MCP 搜索
     */
    private async searchViaMCP(params: ZhipuSearchRequest): Promise<ZhipuSearchResult[]> {
        // 获取 MCP 客户端实例（单例模式，带缓存）
        const mcpClient = await ZhipuMCPWebSearchClient.getInstance();

        const searchRequest: ZhipuWebSearchRequest = {
            search_query: params.search_query,
            search_engine: params.search_engine,
            search_intent: params.search_intent,
            count: params.count,
            search_domain_filter: params.search_domain_filter,
            search_recency_filter: params.search_recency_filter,
            content_size: params.content_size
        };

        return await mcpClient.search(searchRequest);
    }

    /**
     * 执行搜索（标准计费接口）
     */
    async search(params: ZhipuSearchRequest): Promise<ZhipuSearchResponse> {
        const apiKey = await ApiKeyManager.getApiKey('zhipu');
        if (!apiKey) {
            throw new Error(
                t(
                    'Zhipu AI API key is not set. Run "GCMP: Set Zhipu AI API Key" first',
                    '智谱AI API密钥未设置，请先运行命令"GCMP: 设置 智谱AI API密钥"'
                )
            );
        }

        // 根据 endpoint 配置确定 baseURL
        let baseURL = this.baseURL;
        const endpoint = ConfigManager.getZhipuEndpoint();
        if (endpoint === 'api.z.ai') {
            baseURL = baseURL.replace('open.bigmodel.cn', 'api.z.ai');
        }

        const url = `${baseURL}/web_search`;

        const requestData = JSON.stringify({
            search_query: params.search_query,
            search_engine: params.search_engine || 'search_std',
            search_intent: params.search_intent !== undefined ? params.search_intent : false,
            count: params.count || 10,
            search_domain_filter: params.search_domain_filter,
            search_recency_filter: params.search_recency_filter || 'noLimit',
            content_size: params.content_size || 'medium',
            request_id: params.request_id,
            user_id: params.user_id
        });

        const requestOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': VersionManager.getUserAgent('ZhipuSearch')
            },
            body: requestData
        };

        Logger.info(
            `🔍 [Zhipu Search] Starting search: "${params.search_query}" with engine ${params.search_engine || 'search_std'}`
        );
        Logger.debug(`📝 [Zhipu Search] Request payload: ${requestData}`);

        try {
            const response = await ConfigManager.fetchWithProxy(url, requestOptions, { providerKey: 'zhipu' });
            const data = await response.text();

            Logger.debug(`📊 [Zhipu Search] Response status: ${response.status}`);
            Logger.debug(`📄 [Zhipu Search] Response body: ${data}`);

            if (!response.ok) {
                let errorMessage = `Zhipu AI search API error ${response.status}`;
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }
                Logger.error('❌ [Zhipu Search] API returned an error', new Error(errorMessage));
                throw new Error(errorMessage);
            }

            const parsed = JSON.parse(data) as ZhipuSearchResponse;
            Logger.info(`✅ [Zhipu Search] Search completed: found ${parsed.search_result?.length || 0} results`);
            return parsed;
        } catch (error) {
            Logger.error('❌ [Zhipu Search] Request failed', error instanceof Error ? error : undefined);
            throw new Error(
                `Zhipu AI search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * 准备调用时的提示信息
     */
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<ZhipuSearchRequest>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via Zhipu AI...', '正在通过智谱AI搜索网络...')
        };
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<ZhipuSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Call] Zhipu AI web search tool invoked: ${JSON.stringify(request.input)}`);

            const params = request.input as ZhipuSearchRequest;
            if (!params.search_query) {
                throw new Error(t('Missing required parameter: search_query', '缺少必需参数: search_query'));
            }

            // 根据配置选择搜索模式
            let searchResults: ZhipuSearchResult[];
            if (this.isMCPEnabled()) {
                Logger.info(`🔄 [Zhipu Search] Using MCP mode for query: "${params.search_query}"`);
                searchResults = await this.searchViaMCP(params);
            } else {
                Logger.info('[Zhipu Search] Using standard billing API for search (per-request billing)');
                const response = await this.search(params);
                searchResults = response.search_result || [];
            }

            Logger.info('✅ [Tool Call] Zhipu AI web search tool invocation succeeded');

            // 搜索完成后，延时更新智谱AI状态栏（用量显示）
            StatusBarManager.zhipu?.delayedUpdate();

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(
                '❌ [Tool Call] Zhipu AI web search tool invocation failed',
                error instanceof Error ? error : undefined
            );

            throw new vscode.LanguageModelError(t('Zhipu AI search failed: {0}', '智谱AI搜索失败: {0}', errorMessage));
        }
    }

    /**
     * 获取搜索模式状态
     */
    getSearchModeStatus(): { mode: 'MCP' | 'Standard'; description: string } {
        const isMCP = this.isMCPEnabled();
        return {
            mode: isMCP ? 'MCP' : 'Standard',
            description:
                isMCP ?
                    t('MCP mode (Coding Plan only)', 'MCP模式（Coding Plan专属）')
                :   t('Standard billing API mode (per-request billing)', '标准计费接口模式（按次计费）')
        };
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            // MCP 客户端使用单例模式，不需要在这里清理
            // 如果需要清理所有 MCP 客户端缓存，可以调用 ZhipuMCPWebSearchClient.clearCache()
            Logger.info('✅ [Zhipu Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [Zhipu Search] Failed to clean up resources', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 获取 MCP 客户端缓存统计信息
     */
    getMCPCacheStats() {
        return ZhipuMCPWebSearchClient.getCacheStats();
    }

    /**
     * 清除 MCP 客户端缓存
     */
    async clearMCPCache(apiKey?: string): Promise<void> {
        await ZhipuMCPWebSearchClient.clearCache(apiKey);
    }
}
