/*---------------------------------------------------------------------------------------------
 *  MiniMax 网络搜索工具
 *  使用 Coding Plan API 直接进行 HTTP 请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as https from 'https';
import { ConfigManager, Logger } from '../utils';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

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
        const apiKey = await ApiKeyManager.getApiKey('minimax-coding');
        if (!apiKey) {
            throw new Error('MiniMax Coding Plan API密钥未设置，请先运行命令"GCMP: 设置 MiniMax Coding Plan API密钥"');
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

        Logger.info(`🔍 [MiniMax 搜索] 开始搜索: "${params.q}"`);
        Logger.debug(`📝 [MiniMax 搜索] 请求数据: ${requestData}`);

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
                        Logger.debug(`📊 [MiniMax 搜索] 响应状态码: ${res.statusCode}`);
                        Logger.debug(`📄 [MiniMax 搜索] 响应数据: ${data}`);

                        if (res.statusCode !== 200) {
                            let errorMessage = `MiniMax搜索API错误 ${res.statusCode}`;
                            try {
                                const errorData = JSON.parse(data);
                                errorMessage += `: ${errorData.error?.message || JSON.stringify(errorData)}`;
                            } catch {
                                errorMessage += `: ${data}`;
                            }
                            Logger.error('❌ [MiniMax 搜索] API返回错误', new Error(errorMessage));
                            reject(new Error(errorMessage));
                            return;
                        }

                        const response = JSON.parse(data) as MiniMaxSearchResponse;
                        Logger.info(`✅ [MiniMax 搜索] 搜索完成: 找到 ${response.organic?.length || 0} 个结果`);
                        resolve(response);
                    } catch (error) {
                        Logger.error('❌ [MiniMax 搜索] 解析响应失败', error instanceof Error ? error : undefined);
                        reject(
                            new Error(`解析MiniMax搜索响应失败: ${error instanceof Error ? error.message : '未知错误'}`)
                        );
                    }
                });
            });

            req.on('error', error => {
                Logger.error('❌ [MiniMax 搜索] 请求失败', error);
                reject(new Error(`MiniMax搜索请求失败: ${error.message}`));
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
            Logger.info(`🚀 [工具调用] MiniMax网络搜索工具被调用: ${JSON.stringify(request.input)}`);

            const params = request.input as MiniMaxSearchRequest;
            if (!params.q) {
                throw new Error('缺少必需参数: q');
            }

            // 执行搜索
            const response = await this.search(params);
            const searchResults = response.organic || [];

            Logger.info('✅ [工具调用] MiniMax网络搜索工具调用成功');

            // 创建更丰富的搜索结果展示
            const parts: vscode.LanguageModelTextPart[] = [];

            // 添加搜索摘要
            if (searchResults.length > 0) {
                parts.push(new vscode.LanguageModelTextPart(`## 搜索结果 (${searchResults.length} 条)`));
                // 为每个搜索结果创建结构化的展示
                searchResults.forEach((result, index) => {
                    // 创建格式化的搜索结果文本
                    const formattedResult = `**${index + 1}. ${result.title}**\n\n${result.snippet}\n\n📅 ${result.date}\n\n🔗 [查看原文](${result.link})\n\n---\n`;
                    parts.push(new vscode.LanguageModelTextPart(formattedResult));
                });
            } else {
                if (response.base_resp?.status_code !== 0 && response.base_resp?.status_msg) {
                    throw new vscode.LanguageModelError(response.base_resp.status_msg);
                } else {
                    parts.push(new vscode.LanguageModelTextPart('未找到相关搜索结果。'));
                }
            }

            return new vscode.LanguageModelToolResult(parts);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error('❌ [工具调用] MiniMax网络搜索工具调用失败', error instanceof Error ? error : undefined);
            throw new vscode.LanguageModelError(`MiniMax搜索失败: ${errorMessage}`);
        }
    }

    /**
     * 清理工具资源
     */
    async cleanup(): Promise<void> {
        try {
            Logger.info('✅ [MiniMax 搜索] 工具资源已清理');
        } catch (error) {
            Logger.error('❌ [MiniMax 搜索] 资源清理失败', error instanceof Error ? error : undefined);
        }
    }
}
