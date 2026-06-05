/*-----------------------------------------------------------------
 *  Kimi 网络搜索工具
 * 使用 Kimi Code search API 进行 HTTP 请求
 *--------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConfigManager, Logger } from '../utils';
import { t } from '../utils/l10n';
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
        return await ApiKeyManager.getApiKey('kimi');
    }

    /**
     * 执行搜索
     */
    async search(params: KimiSearchRequest): Promise<KimiSearchResponse> {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
            throw new Error(
                t(
                    'Kimi API key is not set. Run "GCMP: Set Kimi For Coding API Key" first',
                    'Kimi API 密钥未设置，请先运行命令"GCMP: 设置 Kimi For Coding API 密钥"'
                )
            );
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

        Logger.info(`🔍 [Kimi Search] Starting search: "${params.query}"`);
        Logger.debug(`📝 [Kimi Search] Request payload: ${requestData}`);

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), DEFAULT_TIMEOUT_SECONDS * 1000);

        try {
            const response = await ConfigManager.fetchWithProxy(
                this.baseURL,
                {
                    ...options,
                    body: requestData,
                    signal: abortController.signal
                },
                { providerKey: 'kimi' }
            );
            const data = await response.text();

            Logger.debug(`📊 [Kimi Search] Response status: ${response.status}`);

            if (!response.ok) {
                let errorMessage = `Kimi search API error ${response.status}`;
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }

                Logger.error('❌ [Kimi Search] API returned an error', new Error(errorMessage));
                throw new Error(errorMessage);
            }

            const apiResponse = JSON.parse(data) as KimiApiResponse;
            const requestId =
                response.headers.get('x-request-id') ?? response.headers.get('x-msh-request-id') ?? undefined;

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

            Logger.info(`✅ [Kimi Search] Search completed: found ${searchResults.length} results`);
            return {
                searchResults,
                requestId
            };
        } catch (error) {
            if (abortController.signal.aborted) {
                throw new Error('Kimi search request timed out');
            }

            Logger.error('❌ [Kimi Search] Request failed', error instanceof Error ? error : undefined);
            throw new Error(`Kimi search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 准备调用时的提示信息
     */
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<KimiSearchRequest>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via Kimi...', '正在通过Kimi搜索网络...')
        };
    }

    /**
     * 工具调用处理器
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<KimiSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Call] Kimi web search tool invoked: ${JSON.stringify(request.input)}`);
            const params = request.input as KimiSearchRequest;
            if (!params.query) {
                throw new Error(t('Missing required parameter: query', '缺少必需参数: query'));
            }

            const response = await this.search(params);
            Logger.info('✅ [Tool Call] Kimi web search tool invocation succeeded');

            StatusBarManager.kimi?.delayedUpdate();

            const searchResults = response.searchResults;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(
                '❌ [Tool Call] Kimi web search tool invocation failed',
                error instanceof Error ? error : undefined
            );
            throw new vscode.LanguageModelError(t('Kimi search failed: {0}', 'Kimi 搜索失败: {0}', errorMessage));
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [Kimi Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error('❌ [Kimi Search] Failed to clean up resources', error instanceof Error ? error : undefined);
        }
    }
}
