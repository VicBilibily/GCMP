/*---------------------------------------------------------------------------------------------
 *  Copilot Fetcher - HTTP 请求处理
 *  实现 IFetcher 接口，处理 API 请求
 *--------------------------------------------------------------------------------------------*/

import { Readable } from 'stream';
import { VersionManager } from '../utils/versionManager';
import type { NESCompletionConfig } from '../utils/configManager';
import type {
    FetchOptions,
    PaginationOptions,
    IAbortController,
    IHeaders,
    Response
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/fetcherService';
import { IFetcher } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
import { StatusBarManager } from '../status';
import { configProviders } from '../providers/config';
import OpenAI from 'openai';
import { getCompletionLogger, getApiKeyManager, getConfigManager } from './singletons';

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
// 参考: nesProvider.spec.ts 中的 TestFetcher
// ============================================================================

/**
 * 自定义 Fetcher 实现
 */
export class Fetcher implements IFetcher {
    getUserAgentLibrary(): string {
        return 'Fetcher';
    }

    async fetch(url: string, options: FetchOptions): Promise<Response> {
        // 优先使用 globalThis 中的单例实例（确保跨 bundle 的单例性）
        const logger = getCompletionLogger();
        const keyManager = getApiKeyManager();

        if (options?.method === 'GET' && url.endsWith('/models')) {
            // 返回一个空模型列表的响应
            const emptyModelsResponse = {
                object: 'list',
                data: []
            };
            // 创建符合 IHeaders 接口的 headers 对象
            const headers: IHeaders = {
                get: (name: string) => {
                    if (name.toLowerCase() === 'content-type') {
                        return 'application/json';
                    }
                    return null;
                },
                [Symbol.iterator]: function* () {
                    yield ['content-type', 'application/json'];
                }
            };
            return new ResponseWrapper(
                200,
                'OK',
                headers,
                async () => JSON.stringify(emptyModelsResponse),
                async () => emptyModelsResponse,
                async () => null,
                'fetcher'
            ) as unknown as Response;
        }

        if (options?.method !== 'POST' || url.endsWith('/completions') === false) {
            throw new Error('Not Support Request');
        }

        let dashscopeStopChunk = false; // 只截取 stop 表示的 chunk, 阿里云百炼补全接口
        const requestBody = { ...(options.json as Record<string, unknown>) } as Record<string, unknown>; // as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

        const ConfigManager = getConfigManager();
        let modelConfig: NESCompletionConfig['modelConfig'];
        if (url.endsWith('/chat/completions')) {
            modelConfig = ConfigManager.getNESConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] NES 模型配置缺失');
                throw new Error('NES model configuration is missing');
            }
            url = `${modelConfig.baseUrl}/chat/completions`;
        } else if (url.endsWith('/completions')) {
            modelConfig = ConfigManager.getFIMConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] FIM 模型配置缺失');
                throw new Error('FIM model configuration is missing');
            }
            url = `${modelConfig.baseUrl}/completions`;
            if (modelConfig.provider === 'dashscope') {
                const { prompt, suffix } = requestBody;
                if (prompt && suffix) {
                    dashscopeStopChunk = true;
                    delete requestBody.suffix;
                    requestBody.prompt = `<|fim_prefix|>${prompt}<|fim_suffix|>${suffix}<|fim_middle|>`;
                }
            }
        } else {
            throw new Error('Not Support Request URL');
        }

        const { provider, model, maxTokens, extraBody } = modelConfig;

        try {
            const apiKey = await keyManager.getApiKey(provider);
            if (!apiKey) {
                logger.error(`[Fetcher] ${provider} API key 未配置`);
                throw new Error('API key not configured');
            }

            const requestHeaders: Record<string, string> = {
                ...(options.headers || {}),
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent(provider),
                Authorization: `Bearer ${apiKey}`
            };

            if (extraBody) {
                for (const key in extraBody) {
                    requestBody[key] = extraBody[key];
                }
            }
            // if (Array.isArray(requestBody.messages)) {
            //     const messages = requestBody.messages;
            //     const promptAddition =
            //         '\n IMPORTANT: Do NOT use markdown code blocks (```). Output ONLY the raw code. Do not explain.';
            //     // 尝试添加到 system message
            //     const systemMessage = messages.find(m => m.role === 'system');
            //     if (systemMessage) {
            //         systemMessage.content = (systemMessage.content || '') + promptAddition;
            //     }
            //     CompletionLogger.trace('[Fetcher] 已注入 Prompt 指令以禁止 Markdown');
            // }

            const fetchOptions: RequestInit = {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify({
                    ...requestBody,
                    model,
                    max_tokens: maxTokens
                }),
                signal: options.signal as AbortSignal | undefined
            };

            logger.info(`[Fetcher] 发送请求: ${url}`);
            const response = await fetch(url, fetchOptions);
            logger.debug(`[Fetcher] 收到响应 - 状态码: ${response.status} ${response.statusText}`);

            // let responseText: string | null = null;
            // if (response.ok) {
            //     responseText = await response.text();
            //     CompletionLogger.trace(`[Fetcher] 收到响应 - 正文体: ${responseText}`);

            //     const completion = JSON.parse(responseText) as OpenAI.ChatCompletion;
            //     if (completion?.choices?.length === 1) {
            //         const [choice] = completion.choices;
            //         const { message } = choice;
            //         const { content } = message;
            //         if (content && content.startsWith('```')) {
            //             // 使用正则表达式高效移除代码块标记
            //             // 匹配开头的 ```language\n 和结尾的 \n``` 或单独一行的 ```
            //             const newContent = content
            //                 .replace(/^```\w*\n/, '') // 移除开头的 ```language\n
            //                 .replace(/\n```$/, ''); // 移除结尾的 \n```

            //             // 更新响应内容
            //             if (newContent && newContent !== content) {
            //                 message.content = newContent;
            //                 responseText = JSON.stringify(completion);
            //                 CompletionLogger.debug(`[Fetcher] 修正响应 - 正文体: ${responseText}`);
            //             }
            //         }
            //     }
            // }

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
                logger.trace(`[Fetcher] 响应体长度: ${cachedText.length} 字符`);
                return cachedText;
            };

            const getJson = async (): Promise<unknown> => {
                const text = await getText();
                try {
                    return JSON.parse(text);
                } catch (e) {
                    logger.error('[Fetcher.ResponseWrapper] JSON 解析失败:', e);
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
                                if (dashscopeStopChunk) {
                                    const chunk = Buffer.from(value).toString('utf-8');
                                    logger.trace(`[Fetcher] 收到 chunk: ${chunk}`);
                                    const lines = chunk.split('\n');

                                    for (const line of lines) {
                                        if (line.trim() === '') {
                                            continue; // 跳过空行
                                        }

                                        if (line.startsWith('data: ')) {
                                            const data = line.slice(6); // 移除 'data: ' 前缀

                                            // 检查是否为 [DONE] 消息
                                            if (data === '[DONE]') {
                                                this.push(Buffer.from('data: [DONE]\n\n'));
                                                continue;
                                            }

                                            try {
                                                const parsed = JSON.parse(data) as OpenAI.Completion;
                                                // 检查是否包含有效的选择项
                                                if (parsed?.choices?.[0]?.finish_reason === 'stop') {
                                                    // 推送最后一个补全完整的有效的响应数据
                                                    this.push(Buffer.from(line + '\n'));
                                                    logger.debug(`[Fetcher] 推送数据: ${line}`);
                                                } else {
                                                    // 中间的无效数据不推送，空消息保持
                                                    this.push(Buffer.from('\n\n'));
                                                }
                                            } catch (e) {
                                                logger.debug(`[Fetcher] JSON 解析失败: ${e}`);
                                                // 忽略解析错误
                                            }
                                        }
                                    }
                                } else {
                                    this.push(Buffer.from(value));
                                }
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
                response.headers as unknown as IHeaders,
                getText,
                getJson,
                getBody,
                'node-fetch'
            ) as unknown as Response;
        } catch (error) {
            // 如果是请求中止，不记录错误日志
            if (!this.isAbortError(error)) {
                logger.error('[Fetcher] 异常:', error);
            }
            throw error;
        } finally {
            if (Object.keys(configProviders).includes(provider)) {
                StatusBarManager.getStatusBar(provider)?.delayedUpdate(200);
            } else {
                StatusBarManager.compatible?.delayedUpdate(provider, 200);
            }
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
