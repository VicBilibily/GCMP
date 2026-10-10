import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { CompletionModelConfig, ProxyFetchOptionsLike } from '../types';

const child = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const noop = (): void => {};
const providers = ['dashscope', 'dashscope-coding', 'dashscope-token', 'dashscope-token-personal'];

interface FetcherResponse {
    status: number;
    body: ReadableStream<Uint8Array>;
}
interface Fetcher {
    fetch(url: string, options: { method: string; json: Record<string, unknown> }): Promise<FetcherResponse>;
}

function fixture(
    provider: string,
    baseUrl: string,
    endpoint: 'cn-beijing' | 'ap-southeast-1',
    sse = 'data: [DONE]\n\n'
) {
    const modelConfig: CompletionModelConfig = {
        provider,
        baseUrl,
        model: 'route-model',
        maxTokens: 200,
        proxy: 'noproxy'
    };
    const keys: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit; options?: ProxyFetchOptionsLike }> = [];
    let endpointReads = 0;
    let slotReads = 0;
    const configManager = {
        getDashscopeEndpoint: () => {
            endpointReads++;
            return endpoint;
        },
        fetchWithProxy: async (input: string | URL | Request, init?: RequestInit, options?: ProxyFetchOptionsLike) => {
            requests.push({ url: String(input), init, options });
            return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
        }
    };
    const shared = {
        completionLogger: { trace: noop, debug: noop, info: noop, warn: noop, error: noop },
        getApiKeyManager: () => ({
            getApiKey: async (key: string) => {
                keys.push(key);
                return 'synthetic-routing-key';
            }
        }),
        getConfigManager: () => configManager,
        isDashscopeProviderSlot: (slot: string) => {
            slotReads++;
            return providers.includes(slot);
        }
    };
    const vscode = {
        workspace: {
            getConfiguration: () => ({
                get: (key: string, fallback?: unknown) => {
                    const field = key.replace(/^(fimCompletion|nesCompletion)\.modelConfig\./, '');
                    return field in modelConfig ? modelConfig[field as keyof CompletionModelConfig] : fallback;
                }
            })
        }
    };
    class ChatResponse {
        constructor(
            readonly status: number,
            readonly statusText: string,
            readonly headers: object,
            readonly body: ReadableStream<Uint8Array>
        ) {}
    }
    const cache = new Map<string, unknown>();
    function load<T>(filename: string): T {
        if (cache.has(filename)) {
            return cache.get(filename) as T;
        }
        const module = { exports: {} };
        const code = transformSync(readFileSync(filename, 'utf8'), {
            loader: 'ts',
            format: 'cjs',
            target: 'es2022'
        }).code;
        runInNewContext(
            code,
            {
                module,
                exports: module.exports,
                URL,
                Request,
                Response,
                Headers,
                AbortController,
                ReadableStream,
                TextEncoder,
                TextDecoder,
                require: (id: string) => {
                    if (id === 'vscode') {
                        return vscode;
                    }
                    if (id === '../gcmpServices') {
                        return shared;
                    }
                    if (id === '../utils/versionManager') {
                        return { VersionManager: { getUserAgent: () => 'routing-test' } };
                    }
                    if (id.startsWith('@vscode/chat-lib/')) {
                        return {
                            Response: ChatResponse,
                            HeadersImpl: { fromMap: (headers: Map<string, string>) => headers }
                        };
                    }
                    return load(resolve(dirname(filename), `${id}.ts`));
                }
            },
            { filename }
        );
        cache.set(filename, module.exports);
        return module.exports as T;
    }
    const { Fetcher } = load<{ Fetcher: new () => Fetcher }>(resolve(child, 'src/copilot/fetcher.ts'));
    return {
        fetcher: new Fetcher(),
        modelConfig,
        keys,
        requests,
        get endpointReads() {
            return endpointReads;
        },
        get slotReads() {
            return slotReads;
        }
    };
}

for (const endpoint of ['cn-beijing', 'ap-southeast-1'] as const) {
    for (const suffix of ['/completions', '/chat/completions']) {
        for (const [provider, baseUrl] of [
            ['dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
            ['dashscope', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
            ['dashscope-coding', 'https://coding.dashscope.aliyuncs.com/v1'],
            ['dashscope-token', 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'],
            ['dashscope-token-personal', 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'],
            ['review', 'https://dashscope.aliyuncs.com/custom/v1'],
            ['Dashscope', 'https://dashscope.aliyuncs.com/compatible-mode/v1']
        ]) {
            test(`${provider} ${baseUrl} ${suffix} ignores main endpoint=${endpoint}`, async () => {
                const f = fixture(provider, baseUrl, endpoint);
                const response = await f.fetcher.fetch(`https://example.invalid${suffix}`, {
                    method: 'POST',
                    json: { prompt: 'prefix' }
                });
                assert.equal(response.status, 200);
                assert.equal(f.requests.length, 1);
                assert.equal(f.requests[0].url, `${baseUrl}${suffix}`);
                assert.equal(f.endpointReads, 0);
                assert.equal(f.slotReads, 0);
                assert.deepEqual(f.keys, [provider]);
                assert.equal(
                    new Headers(f.requests[0].init?.headers).get('Authorization'),
                    'Bearer synthetic-routing-key'
                );
                assert.equal(f.requests[0].options?.providerKey, provider);
                assert.equal(f.requests[0].options?.modelConfig?.provider, provider);
                assert.equal(f.requests[0].options?.modelConfig?.proxy, 'noproxy');
                assert.equal(f.requests[0].options?.skipHar, true);
                assert.equal(await new Response(response.body).text(), 'data: [DONE]\n\n');
            });
        }
    }
}

const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'streamed' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'finished' }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
].join('');

test('exact dashscope retains FIM markers and stop-only stream conversion', async () => {
    const f = fixture('dashscope', 'https://example.invalid/v1', 'ap-southeast-1', sse);
    const response = await f.fetcher.fetch('https://example.invalid/completions', {
        method: 'POST',
        json: { prompt: 'prefix', suffix: 'suffix' }
    });
    const body = JSON.parse(String(f.requests[0].init?.body)) as {
        prompt: string;
        suffix?: string;
        model: string;
        max_tokens: number;
    };
    assert.equal(body.prompt, '<|fim_prefix|>prefix<|fim_suffix|>suffix<|fim_middle|>');
    assert.equal(body.suffix, undefined);
    assert.equal(body.model, 'route-model');
    assert.equal(body.max_tokens, 200);
    const text = await new Response(response.body).text();
    assert.equal(text.includes('streamed'), false);
    assert.ok(text.includes('"text":"finished"'));
    assert.equal(text.includes('delta'), false);
    assert.ok(text.includes('data: [DONE]'));
});

for (const provider of ['dashscope-coding', 'dashscope-token', 'dashscope-token-personal', 'Dashscope', 'review']) {
    test(`${provider} keeps the ordinary FIM request and generic stream conversion`, async () => {
        const f = fixture(provider, 'https://example.invalid/v1', 'ap-southeast-1', sse);
        const response = await f.fetcher.fetch('https://example.invalid/completions', {
            method: 'POST',
            json: { prompt: 'prefix', suffix: 'suffix' }
        });
        const body = JSON.parse(String(f.requests[0].init?.body)) as { prompt: string; suffix: string };
        assert.equal(body.prompt, 'prefix');
        assert.equal(body.suffix, 'suffix');
        const text = await new Response(response.body).text();
        assert.ok(text.includes('"text":"streamed"'));
        assert.ok(text.includes('"text":"finished"'));
        assert.equal(text.includes('delta'), false);
    });
}

test('dashscope NES keeps its chat request and unfiltered response', async () => {
    const f = fixture('dashscope', 'https://example.invalid/v1', 'ap-southeast-1', sse);
    const response = await f.fetcher.fetch('https://example.invalid/chat/completions', {
        method: 'POST',
        json: { prompt: 'prefix', suffix: 'suffix', messages: [{ role: 'system', content: 'system' }] }
    });
    const body = JSON.parse(String(f.requests[0].init?.body)) as {
        prompt: string;
        suffix: string;
        messages: Array<{ content: string }>;
    };
    assert.equal(body.prompt, 'prefix');
    assert.equal(body.suffix, 'suffix');
    assert.ok(body.messages[0].content.includes('# Output Format'));
    assert.equal(await new Response(response.body).text(), sse);
});

for (const suffix of ['/completions', '/chat/completions']) {
    test(`missing configured baseUrl rejects ${suffix} before key or proxy access`, async () => {
        const f = fixture('dashscope', '', 'ap-southeast-1');
        await assert.rejects(
            f.fetcher.fetch(`https://example.invalid${suffix}`, { method: 'POST', json: {} }),
            /configuration is missing/
        );
        assert.equal(f.requests.length, 0);
        assert.equal(f.keys.length, 0);
        assert.equal(f.endpointReads, 0);
    });
}
