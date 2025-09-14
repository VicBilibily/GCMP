/*---------------------------------------------------------------------------------------------
 *  智谱AI搜索工具
 *  基于智谱AI官方文档实现
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';

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
 * 智谱AI搜索工具
 */
export class ZhipuSearchTool {
    private readonly baseURL = 'https://open.bigmodel.cn/api/paas/v4';

    /**
     * 执行搜索
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
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(requestData),
                'User-Agent': 'GCMP-ZhipuSearch/1.0.0'
            }
        };

        Logger.info(`🔍 [智谱搜索] 开始搜索: "${params.search_query}" 使用引擎 ${params.search_engine || 'search_std'}`);
        Logger.debug(`📝 [智谱搜索] 请求数据: ${requestData}`);

        return new Promise((resolve, reject) => {
            const req = https.request(url, options, (res) => {
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
                        reject(new Error(`解析智谱AI搜索响应失败: ${error instanceof Error ? error.message : '未知错误'}`));
                    }
                });
            });

            req.on('error', (error) => {
                Logger.error('❌ [智谱搜索] 请求失败', error);
                reject(new Error(`智谱AI搜索请求失败: ${error.message}`));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * 格式化搜索结果为文本
     */
    formatResults(response: ZhipuSearchResponse): string {
        Logger.debug(`📋 [智谱搜索] 格式化搜索结果: ${JSON.stringify(response)}`);

        if (!response.search_result || response.search_result.length === 0) {
            return '没有找到相关搜索结果。';
        }

        let formatted = `找到 ${response.search_result.length} 个搜索结果：\n\n`;

        response.search_result.forEach((result, index) => {
            formatted += `${index + 1}. **${result.title}**\n`;
            formatted += `   ${result.content}\n`;
            formatted += `   🔗 ${result.link}\n`;
            if (result.refer) {
                formatted += `   📰 ${result.refer}`;
            }
            if (result.publish_date) {
                formatted += ` • 📅 ${result.publish_date}`;
            }
            formatted += '\n\n';
        });

        if (response.search_intent && response.search_intent.length > 0) {
            formatted += `---\n搜索意图: ${response.search_intent[0].intent} | 关键词: ${response.search_intent[0].keywords}`;
        }

        return formatted;
    }

    /**
     * 工具调用处理器
     */
    async invoke(request: vscode.LanguageModelToolInvocationOptions<ZhipuSearchRequest>): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [工具调用] 智谱AI搜索工具被调用: ${JSON.stringify(request.input)}`);

            const params = request.input as ZhipuSearchRequest;
            if (!params.search_query) {
                throw new Error('缺少必需参数: search_query');
            }

            const searchResponse = await this.search(params);
            const formattedResults = this.formatResults(searchResponse);

            Logger.info('✅ [工具调用] 智谱AI搜索工具调用成功');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(formattedResults)
            ]);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] 智谱AI搜索工具调用失败', error instanceof Error ? error : undefined);

            throw new vscode.LanguageModelError(
                `智谱AI搜索失败: ${errorMessage}`
            );
        }
    }
}