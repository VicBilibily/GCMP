/*---------------------------------------------------------------------------------------------
 *  MiniMax 网络搜索工具
 *  使用 Token Plan API 直接进行 HTTP 请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { VersionManager } from '../utils/runtime/versionManager';
import { StatusBarManager } from '../status';

/**
 * MiniMax 搜索请求参数
 */
export interface MiniMaxSearchRequest {
    q: string; // 搜索查询词
}

/**
 * MiniMax 搜索结果项
 */
export interface MiniMaxSearchResult {
    title: string;
    link: string;
    snippet: string; // 内容摘要
    date: string; // 发布日期
}

/**
 * MiniMax 搜索响应
 */
export interface MiniMaxSearchResponse {
    organic: MiniMaxSearchResult[]; // 搜索结果列表
    base_resp: {
        status_code: number;
        status_msg: string;
    };
}

/**
 * MiniMax 网络搜索工具
 */
export class MiniMaxSearchTool {
    private readonly baseURL = 'https://api.minimax.chat/v1/coding_plan/search';

    /**
     * 执行搜索
     */
    async search(params: MiniMaxSearchRequest): Promise<MiniMaxSearchResponse> {
        const apiKey = await ApiKeyManager.getApiKey('minimax-token');
        if (!apiKey) {
            throw new Error(
                t(
                    'MiniMax Token Plan API key is not set. Run "GCMP: Set MiniMax Token Plan API Key" first',
                    'MiniMax Token Plan API密钥未设置，请先运行命令"GCMP: 设置 MiniMax Token Plan API密钥"'
                )
            );
        }

        const requestData = JSON.stringify({
            q: params.q
        });

        const requestOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': VersionManager.getUserAgent('MiniMaxSearch')
            },
            body: requestData
        };

        Logger.info(`🔍 [MiniMax Search] Starting search: "${params.q}"`);
        Logger.debug(`📝 [MiniMax Search] Request payload: ${requestData}`);

        let requestUrl = this.baseURL;
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            // 国际站需要使用指定的搜索端点
            requestUrl = requestUrl.replace('api.minimax.chat', 'api.minimax.io');
        }

        try {
            const response = await ConfigManager.fetchWithProxy(requestUrl, requestOptions, {
                providerKey: 'minimax-token'
            });
            const data = await response.text();

            Logger.debug(`📊 [MiniMax Search] Response status: ${response.status}`);
            Logger.debug(`📄 [MiniMax Search] Response body: ${data}`);

            if (!response.ok) {
                let errorMessage = `MiniMax search API error ${response.status}`;
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }
                Logger.error('❌ [MiniMax Search] API returned error', new Error(errorMessage));
                throw new Error(errorMessage);
            }

            const parsed = JSON.parse(data) as MiniMaxSearchResponse;
            Logger.info(`✅ [MiniMax Search] Search completed: found ${parsed.organic?.length || 0} results`);
            return parsed;
        } catch (error) {
            Logger.error('❌ [MiniMax Search] Request failed', error instanceof Error ? error : undefined);
            throw new Error(
                `MiniMax search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * 准备调用时的提示信息
     */
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<MiniMaxSearchRequest>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via MiniMax...', '正在通过MiniMax搜索网络...')
        };
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<MiniMaxSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Call] MiniMax web search tool invoked: ${JSON.stringify(request.input)}`);

            const params = request.input as MiniMaxSearchRequest;
            if (!params.q) {
                throw new Error(t('Missing required parameter: q', '缺少必需参数: q'));
            }

            const response = await this.search(params);
            Logger.info('✅ [Tool call] MiniMax web search tool invoked successfully');

            StatusBarManager.minimax?.delayedUpdate();

            const searchResults = response.organic;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(
                '❌ [Tool call] MiniMax web search tool invocation failed',
                error instanceof Error ? error : undefined
            );
            throw new vscode.LanguageModelError(t('MiniMax search failed: {0}', 'MiniMax搜索失败: {0}', errorMessage));
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [MiniMax Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [MiniMax Search] Resource cleanup failed', error instanceof Error ? error : undefined);
        }
    }
}
