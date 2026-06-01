/*---------------------------------------------------------------------------------------------
 *  MiniMax 网络搜索工具
 *  使用 Token Plan API 直接进行 HTTP 请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { ConfigManager, Logger } from '../utils';
import { t } from '../utils/l10n';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
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

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': VersionManager.getUserAgent('MiniMaxSearch')
            }
        };

        Logger.info(`🔍 [MiniMax Search] Starting search: "${params.q}"`);
        Logger.debug(`📝 [MiniMax Search] Request payload: ${requestData}`);

        let requestUrl = this.baseURL;
        if (ConfigManager.getMinimaxEndpoint() === 'minimax.io') {
            // 国际站需要使用指定的搜索端点
            requestUrl = requestUrl.replace('api.minimax.chat', 'api.minimax.io');
        }

        return new Promise((resolve, reject) => {
            const req = https.request(requestUrl, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [MiniMax Search] Response status: ${res.statusCode}`);
                        Logger.debug(`📄 [MiniMax Search] Response body: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `MiniMax search API error ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            Logger.error('❌ [MiniMax Search] API returned error', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as MiniMaxSearchResponse;
                        Logger.info(
                            `✅ [MiniMax Search] Search completed: found ${response.organic?.length || 0} results`
                        );
                        resolve(response);
                    } catch (error) {
                        Logger.error(
                            '❌ [MiniMax Search] Failed to parse response',
                            error instanceof Error ? error : undefined
                        );
                        reject(
                            new Error(
                                `Failed to parse MiniMax search response: ${error instanceof Error ? error.message : 'Unknown error'}`
                            )
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [MiniMax Search] Request failed', error);
                reject(new Error(`MiniMax search request failed: ${error.message}`));
            });

            req.write(requestData);
            req.end();
        });
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
