/*---------------------------------------------------------------------------------------------
 *  阿里云百炼 (DashScope) 联网搜索工具
 *  通过 MCP 协议接入百炼 WebSearch MCP 服务
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
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
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<DashscopeSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [工具调用] 阿里云百炼联网搜索工具被调用: ${JSON.stringify(request.input)}`);

            const params = request.input as DashscopeSearchRequest;
            if (!params.query) {
                throw new Error('缺少必需参数: query');
            }

            Logger.info(`🔄 [DashScope 搜索] 使用MCP模式搜索: "${params.query}"`);
            const searchResults = await this.searchViaMCP(params);

            Logger.info('✅ [工具调用] 阿里云百炼联网搜索工具调用成功');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] 阿里云百炼联网搜索工具调用失败', error instanceof Error ? error : undefined);

            throw new vscode.LanguageModelError(`DashScope搜索失败: ${errorMessage}`);
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            // MCP 客户端使用单例模式，不需要在这里清理
            // 如果需要清理所有 MCP 客户端缓存，可以调用 DashscopeMCPWebSearchClient.clearCache()
            Logger.info('✅ [DashScope 搜索] 工具资源已清理');
        } catch (error) {
            Logger.error('❌ [DashScope 搜索] 资源清理失败', error instanceof Error ? error : undefined);
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
