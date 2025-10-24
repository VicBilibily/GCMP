/*---------------------------------------------------------------------------------------------
 *  智谱AI联网搜索工具
 *  支持MCP和标准计费接口的切换
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { MCPWebSearchClient, type WebSearchRequest } from '../utils/mcpWebSearchClient';

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
     * 通过 MCP 搜索（仅Pro及以上套餐支持）
     */
    private async searchViaMCP(params: ZhipuSearchRequest): Promise<ZhipuSearchResult[]> {
        Logger.info(`🔄 [智谱搜索] 使用MCP模式搜索: "${params.search_query}"`);

        // 获取 MCP 客户端实例（单例模式，带缓存）
        const mcpClient = await MCPWebSearchClient.getInstance();

        const searchRequest: WebSearchRequest = {
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
            throw new Error('智谱AI API密钥未设置，请先运行命令"GCMP: 设置 智谱AI API密钥"');
        }

        const url = `${this.baseURL}/web_search`;

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

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': VersionManager.getUserAgent('ZhipuSearch')
            }
        };

        Logger.info(
            `🔍 [智谱搜索] 开始搜索: "${params.search_query}" 使用引擎 ${params.search_engine || 'search_std'}`
        );
        Logger.debug(`📝 [智谱搜索] 请求数据: ${requestData}`);

        return new Promise((resolve, reject) => {
            const req = https.request(url, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [智谱搜索] 响应状态码: ${res.statusCode}`);
                        Logger.debug(`📄 [智谱搜索] 响应数据: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `智谱AI搜索API错误 ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            Logger.error('❌ [智谱搜索] API返回错误', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as ZhipuSearchResponse;
                        Logger.info(`✅ [智谱搜索] 搜索完成: 找到 ${response.search_result?.length || 0} 个结果`);
                        resolve(response);
                    } catch (error) {
                        Logger.error('❌ [智谱搜索] 解析响应失败', error instanceof Error ? error : undefined);
                        reject(
                            new Error(`解析智谱AI搜索响应失败: ${error instanceof Error ? error.message : '未知错误'}`)
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [智谱搜索] 请求失败', error);
                reject(new Error(`智谱AI搜索请求失败: ${error.message}`));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<ZhipuSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [工具调用] 智谱AI联网搜索工具被调用: ${JSON.stringify(request.input)}`);

            const params = request.input as ZhipuSearchRequest;
            if (!params.search_query) {
                throw new Error('缺少必需参数: search_query');
            }

            // 根据配置选择搜索模式
            let searchResults: ZhipuSearchResult[];
            if (this.isMCPEnabled()) {
                Logger.info('🔄 [智谱搜索] 使用MCP模式搜索（仅Pro及以上套餐支持）');
                searchResults = await this.searchViaMCP(params);
            } else {
                Logger.info('🔄 [智谱搜索] 使用标准计费接口搜索（按次计费）');
                const response = await this.search(params);
                searchResults = response.search_result || [];
            }

            Logger.info('✅ [工具调用] 智谱AI联网搜索工具调用成功');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] 智谱AI联网搜索工具调用失败', error instanceof Error ? error : undefined);

            throw new vscode.LanguageModelError(`智谱AI搜索失败: ${errorMessage}`);
        }
    }

    /**
     * 获取搜索模式状态
     */
    getSearchModeStatus(): { mode: 'MCP' | 'Standard'; description: string } {
        const isMCP = this.isMCPEnabled();
        return {
            mode: isMCP ? 'MCP' : 'Standard',
            description: isMCP ? 'MCP模式（仅Pro及以上套餐支持）' : '标准计费接口模式（按次计费）'
        };
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            // MCP 客户端使用单例模式，不需要在这里清理
            // 如果需要清理所有 MCP 客户端缓存，可以调用 MCPWebSearchClient.clearCache()
            Logger.info('✅ [智谱搜索] 工具资源已清理');
        } catch (error) {
            Logger.error('❌ [智谱搜索] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 获取 MCP 客户端缓存统计信息
     */
    getMCPCacheStats() {
        return MCPWebSearchClient.getCacheStats();
    }

    /**
     * 清除 MCP 客户端缓存
     */
    async clearMCPCache(apiKey?: string): Promise<void> {
        await MCPWebSearchClient.clearCache(apiKey);
    }
}
