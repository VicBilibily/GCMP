/*---------------------------------------------------------------------------------------------
 *  阶跃星辰 StepFun 联网搜索工具
 *  支持 MCP 和标准计费接口的切换
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../utils';
import { t } from '../utils/l10n';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { StepFunMCPWebSearchClient, type StepFunWebSearchRequest } from './mcp/stepfunMCPClient';

/**
 * 搜索场景类型
 * 注意：API 文档中 category 默认为空字符串（搜索所有场景）
 */
export type StepFunSearchCategory = '' | 'programming' | 'research' | 'gov' | 'business';

/**
 * 搜索请求参数
 */
export interface StepFunSearchParams {
    query: string;
    n?: number;
    category?: StepFunSearchCategory;
}

/**
 * 搜索结果项
 */
export interface StepFunSearchResult {
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
export interface StepFunSearchResponse {
    query: string;
    n: number;
    results: StepFunSearchResult[];
}

/**
 * 阶跃星辰 StepFun 联网搜索工具
 */
export class StepFunSearchTool {
    private readonly baseURL = 'https://api.stepfun.com/v1';

    /**
     * 检查是否启用 MCP 模式
     */
    private isMCPEnabled(): boolean {
        const config = ConfigManager.getStepFunSearchConfig();
        return config.enableMCP;
    }

    /**
     * 通过 MCP 搜索
     */
    private async searchViaMCP(params: StepFunSearchParams): Promise<StepFunSearchResult[]> {
        // 获取 MCP 客户端实例（单例模式，带缓存）
        const mcpClient = await StepFunMCPWebSearchClient.getInstance();

        const searchRequest: StepFunWebSearchRequest = {
            search_query: params.query,
            n: params.n,
            category: params.category
        };

        return await mcpClient.search(searchRequest);
    }

    /**
     * 执行搜索（标准计费接口）
     */
    async search(params: StepFunSearchParams): Promise<StepFunSearchResponse> {
        const apiKey = await ApiKeyManager.getApiKey('stepfun');
        if (!apiKey) {
            throw new Error(
                t(
                    'StepFun API key is not set. Run "GCMP: Set StepFun API Key" first',
                    '阶跃星辰 API密钥未设置，请先运行命令"GCMP: 设置 StepFun API密钥"'
                )
            );
        }

        const url = `${this.baseURL}/search`;

        const requestData = JSON.stringify({
            query: params.query,
            n: params.n || 10,
            category: params.category || ''
        });

        const requestOptions: RequestInit = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': VersionManager.getUserAgent('StepFunSearch')
            },
            body: requestData
        };

        Logger.info(
            `🔍 [StepFun Search] Starting search: "${params.query}" with category ${params.category || 'default'}`
        );
        Logger.debug(`📝 [StepFun Search] Request payload: ${requestData}`);

        try {
            const response = await ConfigManager.fetchWithProxy(url, requestOptions, { providerKey: 'stepfun' });
            const data = await response.text();

            Logger.debug(`📊 [StepFun Search] Response status: ${response.status}`);
            Logger.debug(`📄 [StepFun Search] Response body: ${data}`);

            if (!response.ok) {
                let errorMessage = `StepFun search API error ${response.status}`;
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }
                Logger.error('❌ [StepFun Search] API returned an error', new Error(errorMessage));
                throw new Error(errorMessage);
            }

            const parsed = JSON.parse(data) as StepFunSearchResponse;
            Logger.info(`✅ [StepFun Search] Search completed: found ${parsed.results?.length || 0} results`);
            return parsed;
        } catch (error) {
            Logger.error('❌ [StepFun Search] Request failed', error instanceof Error ? error : undefined);
            throw new Error(
                `StepFun search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * 准备调用时的提示信息
     */
    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<StepFunSearchParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via StepFun...', '正在通过阶跃星辰搜索网络...')
        };
    }

    /**
     * 工具调用处理器
     * 支持多种输入格式：
     * 1. { query: "xxx" } — LLM 函数调用标准格式
     * 2. { q: "xxx" } — 兼容 minmax 格式
     * 3. "xxx" — 纯字符串（#toolName 引用时的原始文本）
     */
    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<StepFunSearchParams>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            Logger.info(`🚀 [Tool Call] StepFun web search tool invoked: ${JSON.stringify(request.input)}`);

            // 解析查询参数：兼容 #toolName 引用可能传递的多种格式
            const query = this.extractQuery(request.input);
            if (!query) {
                Logger.error(`❌ [StepFun Search] No valid query found in input: ${JSON.stringify(request.input)}`);
                throw new Error(t('Missing required parameter: query', '缺少必需参数: query'));
            }

            const inputObj = request.input as unknown as Record<string, unknown>;
            const params: StepFunSearchParams = {
                query,
                n: inputObj.n as number | undefined,
                category: inputObj.category as StepFunSearchCategory | undefined
            };

            // 根据配置选择搜索模式
            let searchResults: StepFunSearchResult[];
            if (this.isMCPEnabled()) {
                Logger.info(`🔄 [StepFun Search] Using MCP mode for query: "${params.query}"`);
                searchResults = await this.searchViaMCP(params);
            } else {
                Logger.info('[StepFun Search] Using standard billing API for search (per-request billing)');
                const response = await this.search(params);
                searchResults = response.results || [];
            }

            Logger.info('✅ [Tool Call] StepFun web search tool invocation succeeded');

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(searchResults))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error(
                '❌ [Tool Call] StepFun web search tool invocation failed',
                error instanceof Error ? error : undefined
            );

            throw new vscode.LanguageModelError(t('StepFun search failed: {0}', '阶跃星辰搜索失败: {0}', errorMessage));
        }
    }

    /**
     * 从各种可能的输入格式中提取查询文本
     */
    private extractQuery(input: unknown): string {
        if (!input) {
            return '';
        }

        // 格式1: 纯字符串 — #toolName 引用时的原始文本
        if (typeof input === 'string') {
            return input.trim();
        }

        // 格式2: { query: "xxx" } — LLM 标准格式
        if (typeof input === 'object' && input !== null) {
            const obj = input as Record<string, unknown>;

            if (typeof obj.query === 'string' && obj.query.trim()) {
                return obj.query.trim();
            }

            // 格式3: { q: "xxx" } — 兼容格式
            if (typeof obj.q === 'string' && obj.q.trim()) {
                return obj.q.trim();
            }

            // 格式4: { text: "xxx" } — 备选
            if (typeof obj.text === 'string' && obj.text.trim()) {
                return obj.text.trim();
            }

            // 格式5: { search_query: "xxx" } — 兼容智谱格式
            if (typeof obj.search_query === 'string' && obj.search_query.trim()) {
                return obj.search_query.trim();
            }
        }

        return '';
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
                    t('MCP mode (Step Plan only)', 'MCP模式（Step Plan专属）')
                :   t('Standard billing API mode (per-request billing)', '标准计费接口模式（按次计费 ¥0.04/次）')
        };
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [StepFun Search] Tool resources cleaned up');
        } catch (error) {
            Logger.error(
                '❌ [StepFun Search] Failed to clean up resources',
                error instanceof Error ? error : undefined
            );
        }
    }

    /**
     * 获取 MCP 客户端缓存统计信息
     */
    getMCPCacheStats() {
        return StepFunMCPWebSearchClient.getCacheStats();
    }

    /**
     * 清除 MCP 客户端缓存
     */
    async clearMCPCache(apiKey?: string): Promise<void> {
        await StepFunMCPWebSearchClient.clearCache(apiKey);
    }
}
