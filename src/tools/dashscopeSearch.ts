/*---------------------------------------------------------------------------------------------
 *  阿里云百炼 (DashScope) 联网搜索工具
 *  通过 MCP 协议接入百炼 WebSearch MCP 服务
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { t } from '../utils/l10n';
import {
    DashscopeMCPWebSearchClient,
    type DashscopeWebSearchRequest,
    type DashscopeSearchPage
} from './mcp/dashscopeMCPClient';

/**
 * 搜索请求参数
 */
export interface DashscopeSearchRequest {
    query: string;
    count?: number;
}

/**
 * 阿里云百炼联网搜索工具
 */
export class DashscopeSearchTool {
    /**
     * 通过 MCP 搜索
     */
    private async searchViaMCP(params: DashscopeSearchRequest): Promise<DashscopeSearchPage[]> {
        const mcpClient = await DashscopeMCPWebSearchClient.getInstance();

        const searchRequest: DashscopeWebSearchRequest = {
            query: params.query,
            ...(params.count ? { count: params.count } : {})
        };

        return await mcpClient.search(searchRequest);
    }

    /**
     * 准备调用时的提示信息
     */
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<DashscopeSearchRequest>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via DashScope...', '正在通过阿里云百炼搜索网络...')
        };
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<DashscopeSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Call] DashScope web search tool invoked: ${JSON.stringify(request.input)}`);

            const params = request.input as DashscopeSearchRequest;
            if (!params.query) {
                throw new Error(t('Missing required parameter: query', '缺少必需参数: query'));
            }

            Logger.info(`🔄 [DashScope Search] Using MCP mode for query: "${params.query}"`);
            const searchResults = await this.searchViaMCP(params);

            Logger.info('✅ [Tool call] DashScope web search tool invoked successfully');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(
                '❌ [Tool call] DashScope web search tool invocation failed',
                error instanceof Error ? error : undefined
            );

            throw new vscode.LanguageModelError(
                t('DashScope search failed: {0}', 'DashScope搜索失败: {0}', errorMessage)
            );
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            // MCP 客户端使用单例模式，不需要在这里清理
            // 如果需要清理所有 MCP 客户端缓存，可以调用 DashscopeMCPWebSearchClient.clearCache()
            Logger.info('✅ [DashScope Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [DashScope Search] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }

    /**
     * 获取 MCP 客户端缓存统计信息
     */
    getMCPCacheStats() {
        return DashscopeMCPWebSearchClient.getCacheStats();
    }

    /**
     * 清除 MCP 客户端缓存
     */
    async clearMCPCache(apiKey?: string): Promise<void> {
        await DashscopeMCPWebSearchClient.clearCache(apiKey);
    }
}
