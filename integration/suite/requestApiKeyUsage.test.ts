import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

import { onLiveMetrics, type LiveStreamMetricEvent } from '../../src/handlers/liveMetrics';
import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { OpenAICustomHandler } from '../../src/handlers/openai/openaiCustomHandler';
import { AnthropicHandler } from '../../src/handlers/anthropic/anthropicHandler';
import { GeminiHandler } from '../../src/handlers/gemini/geminiHandler';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import type { CustomHeaders, ModelConfig, ProviderConfig } from '../../src/types/sharedTypes';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { captureRequestApiKeyNames } from '../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ApiKeyFailoverManager } from '../../src/utils/config/failover/apiKeyFailoverManager';

type Handler = OpenAIHandler['handleRequest'];

interface TestProvider {
    providerKey: string;
    cachedProviderConfig: ProviderConfig;
    acquireRateLimit: () => Promise<undefined>;
    getRequestRetryConfig: () => { enabled: boolean; maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
    shouldRetryRequest: () => boolean;
    openaiHandler: { handleRequest: Handler };
    openaiCustomHandler: { handleRequest: Handler };
    anthropicHandler: { handleRequest: Handler };
    geminiHandler: { handleRequest: Handler };
    openaiResponsesHandler: { handleResponsesRequest: Handler };
    executeModelRequest: (
        model: vscode.LanguageModelChatInformation,
        config: ModelConfig,
        messages: vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken
    ) => Promise<void>;
}

function createFixture(handler: Handler) {
    const state = new Map<string, unknown>();
    const secrets = new Map<string, string>([['test-provider.apiKey', 'current-request-key']]);
    const context = {
        globalState: {
            get<T>(key: string, fallback?: T): T {
                return (state.has(key) ? state.get(key) : fallback) as T;
            },
            keys: () => [...state.keys()],
            async update(key: string, value: unknown) {
                if (value === undefined) {
                    state.delete(key);
                } else {
                    state.set(key, value);
                }
            }
        },
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            },
            delete: async (key: string) => {
                secrets.delete(key);
            }
        }
    } as unknown as vscode.ExtensionContext;
    ApiKeyManager.initialize(context);
    ConfigSetStore.initialize(context);
    const provider = Object.create(GenericModelProvider.prototype) as TestProvider;
    provider.providerKey = 'test-provider';
    provider.cachedProviderConfig = { displayName: 'Test Provider', models: [] } as unknown as ProviderConfig;
    provider.acquireRateLimit = async () => undefined;
    provider.getRequestRetryConfig = () => ({ enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 });
    provider.shouldRetryRequest = () => true;
    provider.openaiHandler = { handleRequest: handler };
    provider.openaiCustomHandler = { handleRequest: handler };
    provider.anthropicHandler = { handleRequest: handler };
    provider.geminiHandler = { handleRequest: handler };
    provider.openaiResponsesHandler = { handleResponsesRequest: handler };
    return { provider, secrets };
}

function execute(
    provider: TestProvider,
    sdkMode: ModelConfig['sdkMode'],
    requestId: string,
    token: vscode.CancellationToken,
    overrides: Partial<ModelConfig> = {}
) {
    return provider.executeModelRequest(
        { id: 'test-model', name: 'Test Model' } as vscode.LanguageModelChatInformation,
        {
            id: 'test-model',
            name: 'Test Model',
            tooltip: 'Test Model',
            maxInputTokens: 1024,
            maxOutputTokens: 1024,
            provider: 'test-provider',
            sdkMode,
            baseUrl: 'https://example.test/v1',
            capabilities: { imageInput: true, toolCalling: false },
            ...overrides
        },
        [],
        { modelOptions: { requestKind: 'main-agent' } } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        { report() {} },
        requestId,
        'key-usage-session',
        token
    );
}

suite('request API key usage identity', () => {
    for (const sdkMode of ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'] as const) {
        for (const snapshot of [false, true]) {
            test(`${sdkMode} logs the consumed ${snapshot ? 'bound' : 'current'} key rather than a later global key`, async () => {
                const events: LiveStreamMetricEvent[] = [];
                const requestId = `key-usage-${sdkMode}-${snapshot}`;
                const subscription = onLiveMetrics(event => {
                    if (event.requestId === requestId && event.type === 'requestStarted') {
                        events.push(event);
                    }
                });
                const cancellation = new vscode.CancellationTokenSource();
                let consumedKey: string | undefined;
                const { provider, secrets } = createFixture(
                    async (
                        _model,
                        config,
                        _messages,
                        _options,
                        _progress,
                        _requestId,
                        _sessionId,
                        _token,
                        _startedAt,
                        dispatched
                    ) => {
                        consumedKey = await ApiKeyManager.getApiKeyForRequest('test-provider', config);
                        await ConfigSetStore.updateMeta('test-provider', snapshot ? 'bound-config' : 'current-config', {
                            label: '请求期间改名'
                        });
                        secrets.set('test-provider.apiKey', 'changed-before-dispatch');
                        dispatched?.(Date.now());
                    }
                );
                const originalCapture = ApiKeyFailoverManager.captureAttempt;
                if (snapshot) {
                    ApiKeyFailoverManager.captureAttempt = async () => ({
                        activeId: 'bound-config',
                        apiKey: 'bound-request-key',
                        apiKeyName: '绑定配置',
                        identity: 'bound-identity'
                    });
                }
                try {
                    await ConfigSetStore.add(
                        'test-provider',
                        { id: 'current-config', label: '主配置' },
                        'current-request-key'
                    );
                    await ConfigSetStore.add(
                        'test-provider',
                        { id: 'bound-config', label: '绑定配置' },
                        'bound-request-key'
                    );
                    await ConfigSetStore.setActive('test-provider', 'current-config');
                    await execute(provider, sdkMode, requestId, cancellation.token);
                    const expectedKey = snapshot ? 'bound-request-key' : 'current-request-key';
                    assert.equal(consumedKey, expectedKey);
                    assert.equal(events.length, 1);
                    assert.equal(events[0].apiKeyHash, createHash('sha256').update(expectedKey).digest('hex'));
                    assert.equal(events[0].apiKeyName, snapshot ? '绑定配置' : '主配置');
                    assert.equal(JSON.stringify(events).includes(expectedKey), false);
                    assert.equal(JSON.stringify(events).includes('changed-before-dispatch'), false);
                } finally {
                    ApiKeyFailoverManager.captureAttempt = originalCapture;
                    subscription.dispose();
                    cancellation.dispose();
                }
            });
        }
    }

    test('retry records the newly consumed key for each dispatched attempt', async () => {
        const requestId = 'key-usage-retry';
        const events: LiveStreamMetricEvent[] = [];
        const subscription = onLiveMetrics(event => {
            if (event.requestId === requestId && event.type === 'requestStarted') {
                events.push(event);
            }
        });
        const cancellation = new vscode.CancellationTokenSource();
        let calls = 0;
        const { provider, secrets } = createFixture(
            async (
                _model,
                config,
                _messages,
                _options,
                _progress,
                _requestId,
                _sessionId,
                _token,
                _startedAt,
                dispatched
            ) => {
                calls += 1;
                await ApiKeyManager.getApiKeyForRequest('test-provider', config);
                dispatched?.(Date.now());
                if (calls === 1) {
                    secrets.set('test-provider.apiKey', 'retry-request-key');
                    throw new Error('retry this attempt');
                }
            }
        );
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 });
        try {
            await ConfigSetStore.add(
                'test-provider',
                { id: 'initial', label: 'Initial configuration' },
                'current-request-key'
            );
            await ConfigSetStore.add(
                'test-provider',
                { id: 'retry', label: 'Retry configuration' },
                'retry-request-key'
            );
            await ConfigSetStore.setActive('test-provider', 'initial');
            await execute(provider, 'openai', requestId, cancellation.token);
            assert.equal(calls, 2);
            assert.deepEqual(
                events.map(event => event.apiKeyHash),
                ['current-request-key', 'retry-request-key'].map(key => createHash('sha256').update(key).digest('hex'))
            );
            assert.deepEqual(
                events.map(event => event.apiKeyName),
                ['Initial configuration', 'Retry configuration']
            );
        } finally {
            subscription.dispose();
            cancellation.dispose();
        }
    });

    test('concurrent requests retain independent key hashes across a global key change', async () => {
        const events: LiveStreamMetricEvent[] = [];
        const subscription = onLiveMetrics(event => {
            if (event.requestId.startsWith('key-usage-concurrent-') && event.type === 'requestStarted') {
                events.push(event);
            }
        });
        const cancellation = new vscode.CancellationTokenSource();
        let signalRead!: () => void;
        const firstRead = new Promise<void>(resolve => {
            signalRead = resolve;
        });
        let releaseFirst!: () => void;
        const firstReleased = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const { provider, secrets } = createFixture(
            async (
                _model,
                config,
                _messages,
                _options,
                _progress,
                requestId,
                _sessionId,
                _token,
                _startedAt,
                dispatched
            ) => {
                await ApiKeyManager.getApiKeyForRequest('test-provider', config);
                if (requestId === 'key-usage-concurrent-first') {
                    signalRead();
                    await firstReleased;
                }
                dispatched?.(Date.now());
            }
        );
        await ConfigSetStore.add('test-provider', { id: 'first', label: 'First configuration' }, 'current-request-key');
        await ConfigSetStore.add(
            'test-provider',
            { id: 'second', label: 'Second configuration' },
            'concurrent-second-key'
        );
        const first = execute(provider, 'openai', 'key-usage-concurrent-first', cancellation.token);
        try {
            await Promise.race([
                firstRead,
                first.then(() => {
                    throw new Error('First request finished before reading its key');
                })
            ]);
            await ConfigSetStore.updateMeta('test-provider', 'first', { label: 'Renamed configuration' });
            secrets.set('test-provider.apiKey', 'concurrent-second-key');
            await execute(provider, 'openai', 'key-usage-concurrent-second', cancellation.token);
            releaseFirst();
            await first;
            assert.equal(events.length, 2);
            assert.equal(
                events.find(event => event.requestId === 'key-usage-concurrent-first')?.apiKeyHash,
                createHash('sha256').update('current-request-key').digest('hex')
            );
            assert.equal(
                events.find(event => event.requestId === 'key-usage-concurrent-second')?.apiKeyHash,
                createHash('sha256').update('concurrent-second-key').digest('hex')
            );
            assert.equal(
                events.find(event => event.requestId === 'key-usage-concurrent-first')?.apiKeyName,
                'First configuration'
            );
            assert.equal(
                events.find(event => event.requestId === 'key-usage-concurrent-second')?.apiKeyName,
                'Second configuration'
            );
        } finally {
            releaseFirst();
            await first.catch(() => {});
            subscription.dispose();
            cancellation.dispose();
        }
    });

    for (const autoSwitch of [false, true]) {
        for (const scenario of [
            'unique',
            'active-duplicate',
            'ambiguous',
            'stale-active',
            'blank-name',
            'unknown'
        ] as const) {
            test(`key name matching handles ${scenario} with auto switch ${autoSwitch}`, async () => {
                const requestId = `key-name-${scenario}-${autoSwitch}`;
                const events: LiveStreamMetricEvent[] = [];
                const subscription = onLiveMetrics(event => {
                    if (event.requestId === requestId && event.type === 'requestStarted') {
                        events.push(event);
                    }
                });
                const cancellation = new vscode.CancellationTokenSource();
                const { provider } = createFixture(
                    async (
                        _model,
                        config,
                        _messages,
                        _options,
                        _progress,
                        _id,
                        _session,
                        _token,
                        _start,
                        dispatched
                    ) => {
                        await ApiKeyManager.getApiKeyForRequest('test-provider', config);
                        await ConfigSetStore.updateMeta('test-provider', 'primary', { label: 'Later name' });
                        dispatched?.(Date.now());
                    }
                );
                try {
                    await ConfigSetStore.add(
                        'test-provider',
                        { id: 'primary', label: scenario === 'blank-name' ? '  ' : 'Primary name' },
                        scenario === 'unknown' ? 'unused-key' : 'current-request-key'
                    );
                    if (autoSwitch || scenario === 'stale-active') {
                        await ConfigSetStore.add('test-provider', { id: 'other', label: 'Other name' }, 'other-key');
                    }
                    if (scenario === 'active-duplicate' || scenario === 'ambiguous') {
                        await ConfigSetStore.add(
                            'test-provider',
                            { id: 'duplicate', label: 'Duplicate name' },
                            'current-request-key'
                        );
                    }
                    if (scenario === 'active-duplicate' || scenario === 'stale-active') {
                        await ConfigSetStore.setActive(
                            'test-provider',
                            scenario === 'active-duplicate' ? 'duplicate' : 'other'
                        );
                    }
                    await ConfigSetStore.setAutoSwitchEnabled('test-provider', autoSwitch);
                    await execute(provider, 'openai', requestId, cancellation.token);
                    assert.equal(events.length, 1);
                    assert.equal(
                        events[0].apiKeyHash,
                        createHash('sha256').update('current-request-key').digest('hex')
                    );
                    const expectedName =
                        scenario === 'active-duplicate' ? 'Duplicate name'
                        : scenario === 'unique' || scenario === 'stale-active' ? 'Primary name'
                        : undefined;
                    assert.equal(events[0].apiKeyName, expectedName);
                } finally {
                    subscription.dispose();
                    cancellation.dispose();
                }
            });
        }
    }

    for (const scenario of ['no-config', 'lookup-error', 'metadata-change'] as const) {
        test(`missing key name during ${scenario} does not prevent dispatch`, async () => {
            const requestId = `key-name-${scenario}`;
            const events: LiveStreamMetricEvent[] = [];
            const subscription = onLiveMetrics(event => {
                if (event.requestId === requestId && event.type === 'requestStarted') {
                    events.push(event);
                }
            });
            const cancellation = new vscode.CancellationTokenSource();
            const originalGetKey = ConfigSetStore.getApiKey;
            const { provider } = createFixture(
                async (_model, config, _messages, _options, _progress, _id, _session, _token, _start, dispatched) => {
                    await ApiKeyManager.getApiKeyForRequest('test-provider', config);
                    dispatched?.(Date.now());
                }
            );
            try {
                if (scenario !== 'no-config') {
                    await ConfigSetStore.add(
                        'test-provider',
                        { id: 'primary', label: 'Primary' },
                        'current-request-key'
                    );
                    ConfigSetStore.getApiKey = async (slot, id) => {
                        if (scenario === 'lookup-error') {
                            throw new Error('Metadata unavailable');
                        }
                        await ConfigSetStore.updateMeta(slot, id, { label: 'Changed while reading' });
                        return originalGetKey.call(ConfigSetStore, slot, id);
                    };
                }
                await execute(provider, 'openai', requestId, cancellation.token);
                assert.equal(events.length, 1);
                assert.equal(events[0].apiKeyHash, createHash('sha256').update('current-request-key').digest('hex'));
                assert.equal(events[0].apiKeyName, undefined);
            } finally {
                ConfigSetStore.getApiKey = originalGetKey;
                subscription.dispose();
                cancellation.dispose();
            }
        });
    }

    test('key name snapshot matches the request site rather than an active configuration at another site', async () => {
        createFixture(async () => {});
        await ConfigSetStore.add('zhipu', { id: 'china', label: '国内', site: 'open.bigmodel.cn' }, 'same-key');
        await ConfigSetStore.add('zhipu', { id: 'global', label: '国际', site: 'api.z.ai' }, 'same-key');
        await ConfigSetStore.setActive('zhipu', 'china');
        const hash = createHash('sha256').update('same-key').digest('hex');
        const snapshot = await captureRequestApiKeyNames('zhipu', 'api.z.ai');
        await ConfigSetStore.updateMeta('zhipu', 'global', { label: '改名后' });
        assert.equal(snapshot.get(hash), '国际');
        assert.equal((await captureRequestApiKeyNames('zhipu', 'api.z.ai')).get(hash), '改名后');
        assert.equal((await captureRequestApiKeyNames('zhipu', 'open.bigmodel.cn')).get(hash), '国内');
        assert.equal((await captureRequestApiKeyNames('zhipu', 'unknown-site')).get(hash), undefined);
        assert.equal(JSON.stringify([...snapshot]).includes('same-key'), false);
    });

    const headerCases: {
        name: string;
        provider?: CustomHeaders;
        model?: CustomHeaders;
        known: boolean;
    }[] = [
        { name: 'default', known: true },
        { name: 'placeholder', model: { authorization: 'bEaReR ${ aPiKeY }' }, known: true },
        { name: 'same-key', model: { Authorization: 'Bearer current-request-key' }, known: true },
        { name: 'provider-override', provider: { Authorization: 'Bearer other-key' }, known: false },
        { name: 'delete', model: { Authorization: null }, known: false },
        { name: 'api-key-override', model: { 'X-API-Key': 'other-key' }, known: false },
        { name: 'azure-key-override', model: { 'api-key': 'other-key' }, known: false },
        { name: 'google-key-override', model: { 'x-goog-api-key': 'other-key' }, known: false },
        { name: 'unrelated-deletion', model: { 'Content-Type': null }, known: true },
        {
            name: 'model-restores-key',
            provider: { Authorization: 'Bearer other-key' },
            model: { authorization: 'Bearer ${APIKEY}' },
            known: true
        },
        {
            name: 'model-deletes-key',
            provider: { Authorization: 'Bearer ${APIKEY}' },
            model: { authorization: null },
            known: false
        }
    ];
    for (const sdkMode of ['openai', 'openai-responses', 'anthropic', 'openai-sse', 'gemini-sse'] as const) {
        for (const scenario of headerCases) {
            test(`${sdkMode} captures reliable key identity after real header preparation: ${scenario.name}`, async () => {
                const requestId = `prepared-key-${sdkMode}-${scenario.name}`;
                const events: LiveStreamMetricEvent[] = [];
                const subscription = onLiveMetrics(event => {
                    if (event.requestId === requestId && event.type === 'requestStarted') {
                        events.push(event);
                    }
                });
                const cancellation = new vscode.CancellationTokenSource();
                const originalFetch = ConfigManager.fetchWithProxy;
                const originalProxyFetch = ConfigManager.createProxyAwareFetch;
                const stop = new Error('Stopped at isolated request transport');
                let request: Request | undefined;
                let preparedClients = 0;
                const { provider } = createFixture(async (...args) => {
                    const config = args[1];
                    if (sdkMode === 'anthropic') {
                        const handler = new AnthropicHandler(provider as unknown as GenericModelProvider);
                        await (
                            handler as unknown as {
                                createAnthropicClient(config: ModelConfig, sessionId: string): Promise<unknown>;
                            }
                        ).createAnthropicClient(config, args[6]);
                    } else {
                        const handler = new OpenAIHandler(provider as unknown as GenericModelProvider);
                        await handler.createOpenAIClient(config, args[6]);
                    }
                    preparedClients += 1;
                    args[9]?.(Date.now());
                });
                provider.cachedProviderConfig.customHeader = scenario.provider;
                ConfigManager.fetchWithProxy = (async (input: RequestInfo | URL, init?: RequestInit) => {
                    request = new Request(input, init);
                    throw stop;
                }) as typeof ConfigManager.fetchWithProxy;
                ConfigManager.createProxyAwareFetch = () => async () => {
                    throw new Error('Unexpected SDK network request');
                };
                if (sdkMode === 'openai-sse') {
                    provider.openaiCustomHandler = new OpenAICustomHandler(
                        provider as unknown as GenericModelProvider,
                        {
                            buildChatCompletionParams: () => ({ model: 'test-model', messages: [], stream: true })
                        } as unknown as ConstructorParameters<typeof OpenAICustomHandler>[1]
                    );
                } else if (sdkMode === 'gemini-sse') {
                    provider.geminiHandler = new GeminiHandler(provider as unknown as GenericModelProvider);
                }
                try {
                    await ConfigSetStore.add(
                        'test-provider',
                        { id: 'primary', label: 'Primary name' },
                        'current-request-key'
                    );
                    const execution = execute(provider, sdkMode, requestId, cancellation.token, {
                        customHeader: scenario.model,
                        ...(sdkMode === 'gemini-sse' ?
                            { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }
                        :   {})
                    });
                    if (sdkMode === 'openai-sse' || sdkMode === 'gemini-sse') {
                        await assert.rejects(execution, error => error === stop);
                        assert.ok(request);
                        const merged = { ...scenario.provider, ...scenario.model };
                        if (scenario.name === 'provider-override') {
                            assert.equal(request.headers.get('authorization'), 'Bearer other-key');
                        } else if (scenario.name === 'delete' || scenario.name === 'model-deletes-key') {
                            assert.equal(request.headers.get('authorization'), null);
                        }
                        for (const key of ['X-API-Key', 'api-key', 'x-goog-api-key']) {
                            if (merged[key] === 'other-key') {
                                assert.equal(request.headers.get(key), 'other-key');
                            }
                        }
                    } else {
                        await execution;
                        assert.equal(preparedClients, 1);
                    }
                    assert.equal(events.length, 1);
                    assert.equal(
                        events[0].apiKeyHash,
                        scenario.known ? createHash('sha256').update('current-request-key').digest('hex') : undefined
                    );
                    assert.equal(events[0].apiKeyName, scenario.known ? 'Primary name' : undefined);
                    assert.equal(JSON.stringify(events).includes('current-request-key'), false);
                    assert.equal(JSON.stringify(events).includes('other-key'), false);
                } finally {
                    ConfigManager.fetchWithProxy = originalFetch;
                    ConfigManager.createProxyAwareFetch = originalProxyFetch;
                    subscription.dispose();
                    cancellation.dispose();
                }
            });
        }
    }

    test('a preparation failure does not publish a key hash for an undispatched request', async () => {
        const events: LiveStreamMetricEvent[] = [];
        const requestId = 'key-usage-preparation';
        const subscription = onLiveMetrics(event => {
            if (event.requestId === requestId && event.type === 'requestStarted') {
                events.push(event);
            }
        });
        const cancellation = new vscode.CancellationTokenSource();
        const { provider } = createFixture(async (_model, config) => {
            await ApiKeyManager.getApiKeyForRequest('test-provider', config);
            throw new Error('not dispatched');
        });
        try {
            await assert.rejects(execute(provider, 'openai', requestId, cancellation.token), /not dispatched/);
            assert.equal(events.length, 0);
        } finally {
            subscription.dispose();
            cancellation.dispose();
        }
    });
});
