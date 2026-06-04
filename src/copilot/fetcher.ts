/*---------------------------------------------------------------------------------------------
 *  Copilot Fetcher - HTTP 请求处理
 *  实现 IFetcher 接口，处理 API 请求
 *--------------------------------------------------------------------------------------------*/

import { VersionManager } from '../utils/versionManager';
import type { NESCompletionConfig } from '../utils/configManager';
import {
    FetchOptions,
    PaginationOptions,
    IAbortController,
    IHeaders,
    Response,
    HeadersImpl
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/fetcherService';
import { IFetcher } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
import { StatusBarManager } from '../status';
import { configProviders } from '../providers/config';
import { getCompletionLogger, getApiKeyManager, getConfigManager } from './singletons';
import { fetch, ProxyAgent } from 'undici';

// ============================================================================
// Fetcher - 实现 IFetcher 接口
// 参考: nesProvider.spec.ts 中的 TestFetcher
// ============================================================================

/**
 * 自定义 Fetcher 实现
 */
export class Fetcher implements IFetcher {
    /** 按代理地址缓存 ProxyAgent，避免重复创建连接池 */
    private static proxyAgents = new Map<string, ProxyAgent>();

    /**
     * 脱敏代理 URL，仅保留协议+主机+端口，移除用户凭据
     */
    private static redactProxyUrl(raw: string): string {
        try {
            const u = new URL(raw);
            if (u.username || u.password) {
                u.password = '';
                u.username = '';
                return u.toString();
            }
            return raw;
        } catch {
            return raw;
        }
    }

    getUserAgentLibrary(): string {
        return 'Fetcher';
    }

    isNetworkProcessCrashedError(_err: unknown): boolean {
        return false;
    }

    async fetch(url: string, options: FetchOptions): Promise<Response> {
        // 优先使用 globalThis 中的单例实例（确保跨 bundle 的单例性）
        const logger = getCompletionLogger();
        const keyManager = getApiKeyManager();

        if (options?.method === 'GET' && url.endsWith('/models')) {
            // 返回一个空模型列表的响应
            const emptyModelsResponse = '{"object":"list","data":[]}';
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
            return Response.fromText(200, 'OK', headers, emptyModelsResponse, 'node-http');
        }

        if (options?.method !== 'POST' || url.endsWith('/completions') === false) {
            logger.warn(`[Fetcher] Rejected request: method=${options?.method}, url=${url}`);
            throw new Error('Not Support Request');
        }

        const requestStartTime = Date.now();

        let isFimRequest = false; // FIM /completions (非 /chat/completions)
        let dashscopeStopChunk = false; // 只截取 stop 表示的 chunk, 阿里云百炼补全接口

        let fimSseBuffer = '';
        const fimDecoder = new TextDecoder();

        const requestBody: Record<string, unknown> = {}; // as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
        if (options.json) {
            Object.assign(requestBody, options.json);
        } else if (options.body) {
            try {
                Object.assign(requestBody, JSON.parse(options.body));
            } catch (error) {
                throw new Error('Failed to parse request body', { cause: error });
            }
        }

        const ConfigManager = getConfigManager();
        let modelConfig: NESCompletionConfig['modelConfig'];
        if (url.endsWith('/chat/completions')) {
            modelConfig = ConfigManager.getNESConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] NES model configuration missing');
                throw new Error('NES model configuration is missing');
            }
            url = `${modelConfig.baseUrl}/chat/completions`;
        } else if (url.endsWith('/completions')) {
            modelConfig = ConfigManager.getFIMConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] FIM model configuration missing');
                throw new Error('FIM model configuration is missing');
            }
            isFimRequest = true;
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
                logger.error(`[Fetcher] ${provider} API key is not configured`);
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
                    const value = extraBody[key];
                    if (value) {
                        requestBody[key] = value;
                    } else {
                        delete requestBody[key];
                    }
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
            //     CompletionLogger.trace('[Fetcher] Injected Prompt directive to disable Markdown');
            // }

            const fetchOptions: {
                method: string;
                headers: Record<string, string>;
                body: string;
                signal: AbortSignal | undefined;
                dispatcher?: ProxyAgent;
            } = {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify({
                    ...requestBody,
                    model,
                    max_tokens: maxTokens
                }),
                signal: options.signal as AbortSignal | undefined
            };

            if (modelConfig.proxy) {
                const redactedProxy = Fetcher.redactProxyUrl(modelConfig.proxy);
                let agent = Fetcher.proxyAgents.get(modelConfig.proxy);
                if (!agent) {
                    agent = new ProxyAgent(modelConfig.proxy);
                    Fetcher.proxyAgents.set(modelConfig.proxy, agent);
                    logger.info(`[Fetcher] Created ProxyAgent for ${redactedProxy}`);
                }
                fetchOptions.dispatcher = agent;
                logger.debug(`[Fetcher] Using proxy for request: ${redactedProxy}`);
            }

            logger.info(`[Fetcher] Sending request: ${url}`);
            const response = await fetch(url, fetchOptions);
            logger.debug(`[Fetcher] Received response - status: ${response.status} ${response.statusText}`);

            // 从 fetch response 获取 Web ReadableStream
            if (!response.body) {
                throw new Error('Response body is null');
            }

            // 将 Web ReadableStream 转换为 Web ReadableStream<Uint8Array>
            const reader = response.body.getReader();
            const encoder = new TextEncoder();
            const enqueueFimLine = (controller: ReadableStreamDefaultController<Uint8Array>, rawLine: string): void => {
                const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                if (line.trim() === '') {
                    return;
                }

                if (!line.startsWith('data: ')) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                    return;
                }

                const data = line.slice(6);
                if (data === '[DONE]') {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    return;
                }

                try {
                    const parsed = JSON.parse(data) as Record<string, unknown>;
                    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
                    const choice = choices?.[0];

                    if (dashscopeStopChunk && choice?.finish_reason !== 'stop') {
                        controller.enqueue(encoder.encode('\n\n'));
                        return;
                    }

                    // 将 delta.content 转换为 text（部分 FIM 接口返回 chat completion chunk 格式）
                    if (choice && 'delta' in choice) {
                        const delta = choice.delta as Record<string, unknown> | undefined;
                        if (delta && 'content' in delta) {
                            const newChoice: Record<string, unknown> = { ...choice };
                            delete newChoice.delta;
                            newChoice.text = delta.content;
                            const converted = { ...parsed, choices: [newChoice] };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n`));
                            return;
                        }
                    }

                    controller.enqueue(encoder.encode(`${line}\n`));
                } catch {
                    controller.enqueue(encoder.encode(`${line}\n`));
                }
            };
            const bodyStream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (isFimRequest) {
                                fimSseBuffer += fimDecoder.decode();
                                if (fimSseBuffer.trim() !== '') {
                                    enqueueFimLine(controller, fimSseBuffer);
                                    fimSseBuffer = '';
                                }
                            }
                            controller.close();
                            return;
                        }

                        if (isFimRequest) {
                            const chunk = fimSseBuffer + fimDecoder.decode(value, { stream: true });
                            const lines = chunk.split('\n');
                            fimSseBuffer = lines.pop() ?? '';

                            for (const line of lines) {
                                enqueueFimLine(controller, line);
                            }
                        } else {
                            controller.enqueue(new Uint8Array(value));
                        }
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel() {
                    reader.cancel();
                }
            });

            // 规范化 headers：将 Web Headers 转换为 chat-lib 的 HeadersImpl，
            // 避免某些 provider 返回的 headers 在迭代或 get() 行为上与 IHeaders 不兼容
            const headerRecord: Record<string, string> = {};
            try {
                response.headers.forEach((value, key) => {
                    headerRecord[key] = value;
                });
            } catch (headersErr) {
                logger.warn('[Fetcher] Failed to iterate response headers:', headersErr);
            }
            const chatLibHeaders = HeadersImpl.fromMap(new Map(Object.entries(headerRecord)));

            return new Response(
                response.status,
                response.statusText,
                chatLibHeaders,
                bodyStream,
                'node-http',
                () => {},
                '',
                ''
            );
        } catch (error) {
            // 如果是请求中止，不记录错误日志
            if (!this.isAbortError(error)) {
                const elapsed = Date.now() - requestStartTime;
                const stack = error instanceof Error ? error.stack : '';
                logger.error(
                    `[Fetcher] Request failed (${elapsed}ms) for ${url}: ${error instanceof Error ? error.message : String(error)}\n${stack}`
                );
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
        // 关闭所有缓存的 ProxyAgent，释放底层连接池
        const promises: Promise<unknown>[] = [];
        for (const [url, agent] of Fetcher.proxyAgents) {
            Fetcher.proxyAgents.delete(url);
            promises.push(
                agent.close().catch(() => {
                    /* 忽略关闭异常 */
                })
            );
        }
        if (promises.length) {
            const logger = getCompletionLogger();
            logger.info(`[Fetcher] Closed ${promises.length} ProxyAgent(s)`);
        }
        await Promise.all(promises);
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
