/*---------------------------------------------------------------------------------------------
 *  Copilot Fetcher - HTTP 请求处理
 *  实现 IFetcher 接口，处理 API 请求
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { Logger } from '../utils/logger';
import { VersionManager } from '../utils/versionManager';
import { ApiKeyManager } from '../utils';
import type {
    FetchOptions,
    PaginationOptions,
    IAbortController,
    IHeaders,
    Response
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/fetcherService';
import { IFetcher } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
import { FimProviderConfig } from './types';
import OpenAI from 'openai';

// ============================================================================
// Response 包装类
// ============================================================================

/**
 * Response 类 - 兼容 @vscode/chat-lib 的 Response 接口
 * 支持流式响应，body() 返回可读流
 */
class ResponseWrapper {
    readonly ok: boolean;

    constructor(
        readonly status: number,
        readonly statusText: string,
        readonly headers: IHeaders,
        private readonly getText: () => Promise<string>,
        private readonly getJson: () => Promise<unknown>,
        private readonly getBody: () => Promise<Readable | null>,
        readonly fetcher: string
    ) {
        this.ok = status >= 200 && status < 300;
    }

    async text(): Promise<string> {
        return this.getText();
    }

    async json(): Promise<unknown> {
        return this.getJson();
    }

    async body(): Promise<Readable | null> {
        return this.getBody();
    }
}

// ============================================================================
// Fetcher - 实现 IFetcher 接口
// 参考: getInlineCompletions.spec.ts 中的 TestFetcher
// ============================================================================

/**
 * 自定义 Fetcher 实现
 * 基于 DeepSeek FIM API 的请求处理
 */
export class Fetcher implements IFetcher {
    constructor(private readonly providerConfig: FimProviderConfig) {}

    getUserAgentLibrary(): string {
        return 'Fetcher';
    }

    async fetch(url: string, options: FetchOptions): Promise<Response> {
        if (options?.method === 'GET' && url.endsWith('/models')) {
            // 返回一个空模型列表的响应
            const emptyModelsResponse = {
                object: 'list',
                data: []
            };
            return new ResponseWrapper(
                200,
                'OK',
                { 'Content-Type': 'application/json' } as unknown as IHeaders,
                async () => JSON.stringify(emptyModelsResponse),
                async () => emptyModelsResponse,
                async () => null,
                'fetcher'
            ) as unknown as Response;
        }

        if (options?.method !== 'POST' || url.endsWith('/completions') === false) {
            throw new Error('Not Support Request');
        }

        const { baseUrl, requestPath, providerKey, requestModel } = this.providerConfig;
        url = `${baseUrl}/${requestPath}`;

        try {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (!apiKey) {
                Logger.error(`[Fetcher] ${providerKey} API key 未配置`);
                throw new Error('API key not configured');
            }

            const headers: Record<string, string> = {
                ...(options.headers || {}),
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent(`${this.providerConfig.name}-FIM`),
                Authorization: `Bearer ${apiKey}`
            };

            // 拦截并修改 messages，添加 Prompt 指令
            const requestBody = options.json as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
            // if (Array.isArray(requestBody.messages)) {
            //     const messages = requestBody.messages;
            //     const promptAddition =
            //         '\n IMPORTANT: Do NOT use markdown code blocks (```). Output ONLY the raw code. Do not explain.';
            //     // 尝试添加到 system message
            //     const systemMessage = messages.find(m => m.role === 'system');
            //     if (systemMessage) {
            //         systemMessage.content = (systemMessage.content || '') + promptAddition;
            //     }
            //     Logger.trace('[Fetcher] 已注入 Prompt 指令以禁止 Markdown');
            // }

            const fetchOptions: RequestInit = {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    ...requestBody,
                    model: requestModel
                }),
                signal: options.signal as AbortSignal | undefined
            };

            Logger.trace(`[Fetcher] 发送请求: ${url}`);
            const response = await fetch(url, fetchOptions);
            Logger.trace(`[Fetcher] 收到响应 - 状态码: ${response.status} ${response.statusText}`);

            // 缓存响应文本（用于 text() 和 json() 方法）
            let cachedText: string | null = null;
            let bodyConsumed = false;

            const getText = async (): Promise<string> => {
                if (cachedText !== null) {
                    return cachedText;
                }
                if (bodyConsumed) {
                    throw new Error('Response body has already been consumed as stream');
                }
                bodyConsumed = true;
                cachedText = await response.text();
                Logger.trace(`[Fetcher] 响应体长度: ${cachedText.length} 字符`);
                return cachedText;
            };

            const getJson = async (): Promise<unknown> => {
                const text = await getText();
                try {
                    return JSON.parse(text);
                } catch (e) {
                    Logger.error('[Fetcher.ResponseWrapper] JSON 解析失败:', e);
                    throw e;
                }
            };

            const getBody = async (): Promise<Readable | null> => {
                if (bodyConsumed) {
                    // 如果已经读取了文本，返回基于缓存文本的流
                    if (cachedText !== null) {
                        return Readable.from([cachedText]);
                    }
                    throw new Error('Response body has already been consumed');
                }
                bodyConsumed = true;

                // 从 fetch response 获取 Web ReadableStream 并转换为 Node.js Readable
                if (!response.body) {
                    return null;
                }

                // 将 Web ReadableStream 转换为 Node.js Readable
                const reader = response.body.getReader();
                const nodeStream = new Readable({
                    async read() {
                        try {
                            const { done, value } = await reader.read();
                            if (done) {
                                this.push(null);
                            } else {
                                this.push(Buffer.from(value));
                            }
                        } catch (error) {
                            this.destroy(error as Error);
                        }
                    }
                });
                return nodeStream;
            };

            return new ResponseWrapper(
                response.status,
                response.statusText,
                response.headers,
                getText,
                getJson,
                getBody,
                'node-fetch'
            ) as unknown as Response;
        } catch (error) {
            // 如果是中止错误，不记录错误日志
            if (!this.isAbortError(error)) {
                Logger.error('[Fetcher] 异常:', error);
            }
            throw error;
        }
    }

    fetchWithPagination<T>(_baseUrl: string, _options: PaginationOptions<T>): Promise<T[]> {
        throw new Error('Method not implemented.');
    }

    async disconnectAll(): Promise<unknown> {
        return Promise.resolve();
    }

    makeAbortController(): IAbortController {
        return new AbortController() as IAbortController;
    }

    isAbortError(e: unknown): boolean {
        return !!e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'AbortError';
    }

    isInternetDisconnectedError(_e: unknown): boolean {
        return false;
    }

    isFetcherError(_e: unknown): boolean {
        return false;
    }

    getUserMessageForFetcherError(err: unknown): string {
        const message = err instanceof Error ? err.message : String(err);
        return `Fetcher error: ${message}`;
    }
}
