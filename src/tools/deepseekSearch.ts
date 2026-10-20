/*---------------------------------------------------------------------------------------------
 *  DeepSeek 网页搜索工具
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import { VersionManager } from '../utils/runtime/versionManager';
import { StatusBarManager } from '../status';

export interface DeepSeekSearchRequest {
    query: string;
    count?: number;
    ori_question?: string | null;
    localization?: string;
    need_content?: boolean;
}

export interface DeepSeekSearchResult {
    rerank_score: number;
    title: string;
    url: string;
    snippet: string;
    summary: string;
    content: string;
    site_name: string | null;
    site_icon: string | null;
    date: string | null;
    authority: number;
}

export interface DeepSeekSearchResponse {
    results: DeepSeekSearchResult[];
}

export class DeepSeekSearchTool {
    private readonly url = 'https://api.deepseek.com/v1/tools/search';

    async search(params: DeepSeekSearchRequest): Promise<DeepSeekSearchResponse> {
        this.validateRequest(params);

        const apiKey = await ApiKeyManager.getApiKey('deepseek');
        if (!apiKey) {
            throw new Error(
                t(
                    'DeepSeek API key is not set. Run "GCMP: Set DeepSeek API Key" first',
                    'DeepSeek API 密钥未设置，请先运行命令"GCMP: 设置 DeepSeek API 密钥"'
                )
            );
        }

        const requestData = JSON.stringify({
            query: params.query,
            count: params.count ?? 10,
            ori_question: params.ori_question,
            localization: params.localization ?? '',
            need_content: params.need_content ?? false
        });

        Logger.info(`[DeepSeek Search] Starting search: "${params.query}"`);
        Logger.debug(`[DeepSeek Search] Request payload: ${requestData}`);

        try {
            const response = await ConfigManager.fetchWithProxy(
                this.url,
                {
                    method: 'POST',
                    headers: {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${apiKey}`,
                        'User-Agent': VersionManager.getUserAgent('DeepSeekSearch')
                    },
                    body: requestData
                },
                { providerKey: 'deepseek' }
            );
            const data = await response.text();

            if (!response.ok) {
                let errorMessage = `DeepSeek search API error ${response.status}`;
                try {
                    const errorData = JSON.parse(data);
                    errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                } catch {
                    errorMessage += `: ${data}`;
                }
                throw new Error(errorMessage);
            }

            const parsed = JSON.parse(data) as DeepSeekSearchResponse;
            if (!Array.isArray(parsed.results)) {
                throw new Error('DeepSeek search API returned an invalid response: missing results array');
            }

            Logger.info(`[DeepSeek Search] Search completed: found ${parsed.results.length} results`);
            return parsed;
        } catch (error) {
            Logger.error('[DeepSeek Search] Request failed', error instanceof Error ? error : undefined);
            throw new Error(
                `DeepSeek search request failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    async prepareInvocation(
        _options: vscode.LanguageModelToolInvocationPrepareOptions<DeepSeekSearchRequest>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation | undefined> {
        return {
            invocationMessage: t('Searching the web via DeepSeek...', '正在通过 DeepSeek 搜索网络...')
        };
    }

    async invoke(
        request: vscode.LanguageModelToolInvocationOptions<DeepSeekSearchRequest>
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const params = this.extractRequest(request.input);
            const response = await this.search(params);
            StatusBarManager.deepseek?.delayedUpdate();
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(JSON.stringify(response.results))
            ]);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            Logger.error('[DeepSeek Search] Tool invocation failed', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(
                t('DeepSeek search failed: {0}', 'DeepSeek 搜索失败: {0}', errorMessage)
            );
        }
    }

    private extractRequest(input: unknown): DeepSeekSearchRequest {
        if (typeof input === 'string') {
            return { query: input };
        }
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            return { query: '' };
        }

        const params = input as Record<string, unknown>;
        return {
            query: params.query as string,
            count: params.count as number | undefined,
            ori_question: params.ori_question as string | null | undefined,
            localization: params.localization as string | undefined,
            need_content: params.need_content as boolean | undefined
        };
    }

    private validateRequest(params: DeepSeekSearchRequest): void {
        if (typeof params.query !== 'string' || params.query.trim().length === 0) {
            throw new Error(t('Missing or invalid required parameter: query', '缺少或无效的必需参数: query'));
        }
        const queryLength = [...params.query].length;
        if (queryLength > 128) {
            throw new Error(t('Parameter "query" must be at most 128 characters', '参数 "query" 最多为 128 个字符'));
        }
        if (params.count !== undefined && (!Number.isInteger(params.count) || params.count < 1 || params.count > 50)) {
            throw new Error(
                t('Parameter "count" must be an integer between 1 and 50', '参数 "count" 必须是 1 到 50 之间的整数')
            );
        }
        if (params.ori_question !== undefined && params.ori_question !== null) {
            if (
                typeof params.ori_question !== 'string' ||
                [...params.ori_question].length < 1 ||
                [...params.ori_question].length > 128
            ) {
                throw new Error(
                    t(
                        'Parameter "ori_question" must contain 1 to 128 characters',
                        '参数 "ori_question" 长度必须为 1 到 128 个字符'
                    )
                );
            }
        }
        if (params.localization !== undefined && typeof params.localization !== 'string') {
            throw new Error(t('Parameter "localization" must be a string', '参数 "localization" 必须是字符串'));
        }
        if (params.need_content !== undefined && typeof params.need_content !== 'boolean') {
            throw new Error(t('Parameter "need_content" must be a boolean', '参数 "need_content" 必须是布尔值'));
        }
    }

    async cleanup(): Promise<void> {
        Logger.info('[DeepSeek Search] Tool resources cleaned up');
    }
}
