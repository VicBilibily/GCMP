import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { AnthropicHandler } from '../../../src/handlers/anthropic/anthropicHandler';
import { GeminiHandler } from '../../../src/handlers/gemini/geminiHandler';
import { OpenAICustomHandler } from '../../../src/handlers/openai/openaiCustomHandler';
import { OpenAIHandler } from '../../../src/handlers/openai/openaiHandler';
import { OpenAIResponsesHandler } from '../../../src/handlers/openai/openaiResponsesHandler';
import { GenericModelProvider } from '../../../src/providers/genericModelProvider';
import type { RateLimitHandle } from '../../../src/rateLimit/rateLimiter';
import type { ModelConfig } from '../../../src/types/sharedTypes';
import type { RetryConfig } from '../../../src/utils/retry/retryManager';

export const slot = 'balance-retry-test';
const sessionId = 'balance-retry-session';
export const balanceKey = `m:${sessionId}:turn:1`;
export const defaultRetry: RetryConfig = { enabled: true, maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 };

export function createContext(): vscode.ExtensionContext {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        globalState: {
            get: <T>(key: string, fallback?: T): T => (state.has(key) ? state.get(key) : fallback) as T,
            keys: () => [...state.keys()],
            async update(key: string, value: unknown) {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, structuredClone(value));
                }
            }
        },
        subscriptions: [],
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            },
            onDidChange: () => ({ dispose() {} })
        }
    } as unknown as vscode.ExtensionContext;
}

export function identity(apiKey: string): string {
    return createHash('sha256').update(`${apiKey}\u0000`).digest('hex');
}

export function trackedCancellation(cancelOnSubscribe = false) {
    const source = new vscode.CancellationTokenSource();
    let subscriptions = 0;
    let disposals = 0;
    const token: vscode.CancellationToken = {
        get isCancellationRequested() {
            return source.token.isCancellationRequested;
        },
        onCancellationRequested(listener, thisArgs, disposables) {
            subscriptions++;
            const subscription = source.token.onCancellationRequested(listener, thisArgs);
            const disposable = {
                dispose() {
                    disposals++;
                    subscription.dispose();
                }
            };
            disposables?.push(disposable);
            if (cancelOnSubscribe) {
                source.cancel();
            }
            return disposable;
        }
    };
    return {
        token,
        cancel: () => source.cancel(),
        dispose: () => source.dispose(),
        get subscriptions() {
            return subscriptions;
        },
        get disposals() {
            return disposals;
        }
    };
}

export function successResponse(sdkMode: 'openai' | 'openai-responses'): Response {
    const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
    const events =
        sdkMode === 'openai' ?
            [
                {
                    id: 'chat-retry',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'retry-model',
                    choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered' }, finish_reason: null }]
                },
                {
                    id: 'chat-retry',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'retry-model',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
                }
            ]
        :   [
                { type: 'response.created', response: { id: 'response-retry', status: 'in_progress', output: [] } },
                {
                    type: 'response.output_text.delta',
                    item_id: 'message-retry',
                    output_index: 0,
                    content_index: 0,
                    delta: 'recovered'
                },
                {
                    type: 'response.completed',
                    response: {
                        id: 'response-retry',
                        status: 'completed',
                        usage,
                        output: [
                            {
                                id: 'message-retry',
                                type: 'message',
                                role: 'assistant',
                                status: 'completed',
                                content: [{ type: 'output_text', text: 'recovered', annotations: [] }]
                            }
                        ]
                    }
                }
            ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' }
    });
}

export function errorResponse(
    status = 503,
    message = 'service unavailable',
    code?: string | null,
    type?: string
): Response {
    return new Response(JSON.stringify({ error: { message, code, type } }), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'retry-http-error', 'retry-after': '2' }
    });
}

export class RetryProvider extends GenericModelProvider {
    private testRetry!: RetryConfig;
    private observed!: { grants: number; handle?: RateLimitHandle };

    static async run(
        sdkMode: 'openai' | 'openai-responses' | 'openai-sse' | 'anthropic' | 'gemini-sse',
        retry: RetryConfig,
        observed: { grants: number; handle?: RateLimitHandle },
        token: vscode.CancellationToken,
        parts: vscode.LanguageModelResponsePart[] = [],
        requestId = '',
        historyOverride?: readonly vscode.LanguageModelChatMessage[]
    ): Promise<void> {
        const config: ModelConfig = {
            id: 'retry-model',
            name: 'Retry Model',
            tooltip: 'Retry Model',
            provider: slot,
            sdkMode,
            baseUrl: 'https://balance-retry.test/v1',
            maxInputTokens: 1024,
            maxOutputTokens: 1024,
            capabilities: { imageInput: true, toolCalling: true }
        };
        const provider = Object.create(RetryProvider.prototype) as RetryProvider;
        Object.assign(provider, {
            providerKey: slot,
            cachedProviderConfig: { displayName: 'Retry Test', models: [config] },
            testRetry: retry,
            observed
        });
        const handler = new OpenAIHandler(provider);
        Object.assign(provider, {
            anthropicHandler: new AnthropicHandler(provider),
            geminiHandler: new GeminiHandler(provider),
            openaiHandler: handler,
            openaiCustomHandler: new OpenAICustomHandler(provider, handler),
            openaiResponsesHandler: new OpenAIResponsesHandler(provider, handler)
        });
        await provider.executeModelRequest(
            { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
            config,
            historyOverride ?
                [...historyOverride]
            :   [vscode.LanguageModelChatMessage.User('<userRequest>retry test</userRequest>')],
            {
                modelOptions: { requestKind: 'main-agent', _telemetryTurn: 1 }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            { report: part => parts.push(part) },
            requestId,
            sessionId,
            token,
            slot,
            Date.now(),
            0,
            undefined,
            undefined,
            balanceKey
        );
    }

    protected override async acquireRateLimit(): Promise<RateLimitHandle | undefined> {
        this.observed.grants++;
        return this.observed.handle;
    }

    protected override getRequestRetryConfig(): RetryConfig {
        return this.testRetry;
    }
}
