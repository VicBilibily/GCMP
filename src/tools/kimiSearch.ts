/*-----------------------------------------------------------------
 *  Kimi 网络搜索工具
 * 使用 Kimi Code search API 进行 HTTP 请求
 *--------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as https from 'https';
import { Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { StatusBarManager } from '../status';

/**
 * Kimi 搜索请求参数
 */
export interface KimiSearchRequest {
    query: string; // 搜索查询词
    limit?: number; // 返回结果数量 (1-50, 默认 10)
    includeContent?: boolean; // 是否抓取页面内容
}

/**
 * Kimi 搜索结果项
 */
export interface KimiSearchResult {
    title: string;
    url: string;
    snippet?: string; // 内容摘要
    content?: string; // 页面内容 (如果 includeContent 为 true)
    date?: string; // 发布日期
    siteName?: string; // 网站名称
}

/**
 * Kimi 搜索响应
 */
export interface KimiSearchResponse {
    searchResults: KimiSearchResult[];
    requestId?: string;
}

/**
 * Kimi API 原始响应格式
 */
interface KimiApiResponse {
    search_results?: Array<{
        title?: string;
        url?: string;
        snippet?: string;
        content?: string;
        date?: string;
        site_name?: string;
    }>;
}

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Kimi 网络搜索工具
 */
export class KimiSearchTool {
    private readonly baseURL = 'https://api.kimi.com/coding/v1/search';

    /**
     * 限制结果数量在有效范围内
     */
    private clampNumResults(value: number | undefined): number {
        if (!value || Number.isNaN(value)) {
            return DEFAULT_NUM_RESULTS;
        }

        return Math.min(MAX_NUM_RESULTS, Math.max(1, value));
    }

    /**
     * 获取 API Key
     */
    private async getApiKey(): Promise<string | undefined> {
        let apiKey = await ApiKeyManager.getApiKey('kimi');

        if (!apiKey) {
            apiKey = await ApiKeyManager.getApiKey('moonshot');
        }

        return apiKey;
    }

    /**
     * 执行搜索
     */
    async search(params: KimiSearchRequest): Promise<KimiSearchResponse> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error('Kimi API 密钥未设置，请先运行命令"GCMP: 设置 Kimi For Coding API 密钥"');
        }

        const limit = this.clampNumResults(params.limit);
        const requestData = JSON.stringify({
            text_query: params.query,
            limit,
            enable_page_crawling: params.includeContent ?? false,
            timeout_seconds: DEFAULT_TIMEOUT_SECONDS
        });

        const options = {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'KimiCLI/OpenClawKimiSearchPlugin',
                Authorization: `Bearer ${apiKey}`
            }
        };

        Logger.info(`🔍 [Kimi 搜索] 开始搜索: "${params.query}"`);
        Logger.debug(`📝 [Kimi 搜索] 请求数据: ${requestData}`);

        return new Promise((resolve, reject) => {
            const req = https.request(this.baseURL, options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        Logger.debug(`📊 [Kimi 搜索] 响应状态码: ${res.statusCode}`);
                        // Logger.debug(`📄 [Kimi 搜索] 响应数据: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `Kimi 搜索 API 错误 ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }

                            Logger.error('❌ [Kimi 搜索] API 返回错误', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const apiResponse = JSON.parse(data) as KimiApiResponse;
                        const requestId =
                            res.headers['x-request-id']?.toString() ??
                            res.headers['x-msh-request-id']?.toString() ??
                            undefined;

                        const searchResults: KimiSearchResult[] = [];
                        for (const result of apiResponse.search_results ?? []) {
                            if (!result.url) {
                                continue;
                            }

                            searchResults.push({
                                title: result.title ?? result.url,
                                url: result.url,
                                snippet: result.snippet,
                                content: result.content,
                                date: result.date,
                                siteName: result.site_name
                            });
                        }

                        Logger.info(`✅ [Kimi 搜索] 搜索完成: 找到 ${searchResults.length} 个结果`);
                        resolve({
                            searchResults,
                            requestId
                        });
                    } catch (error) {
                        Logger.error('❌ [Kimi 搜索] 解析响应失败', error instanceof Error ? error : undefined);
                        reject(
                            new Error(`解析 Kimi 搜索响应失败: ${error instanceof Error ? error.message : '未知错误'}`)
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [Kimi 搜索] 请求失败', error);
                reject(new Error(`Kimi 搜索请求失败: ${error.message}`));
            });

            req.setTimeout(DEFAULT_TIMEOUT_SECONDS * 1000, () => {
                req.destroy();
                reject(new Error('Kimi 搜索请求超时'));
            });

            req.write(requestData);
            req.end();
        });
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<KimiSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [工具调用] Kimi 网络搜索工具被调用: ${JSON.stringify(request.input)}`);
            const params = request.input as KimiSearchRequest;
            if (!params.query) {
                throw new Error('缺少必需参数: query');
            }

            const response = await this.search(params);
            Logger.info('✅ [工具调用] Kimi 网络搜索工具调用成功');

            StatusBarManager.kimi?.delayedUpdate();

            const searchResults = response.searchResults;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] Kimi 网络搜索工具调用失败', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(`Kimi 搜索失败: ${errorMessage}`);
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [Kimi 搜索] 工具资源已清理');
        } catch (error) {
            Logger.error('❌ [Kimi 搜索] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }
}
