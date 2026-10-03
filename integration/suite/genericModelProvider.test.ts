import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import OpenAI from 'openai';

import * as vscode from 'vscode';

import { InterInstanceBus, type ApiKeyFailoverRequestedEvent } from '../../src/interInstance';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { OpenAIHandler } from '../../src/handlers/openai/openaiHandler';
import { RateLimiter, type RateLimitHandle } from '../../src/rateLimit/rateLimiter';
import { LeaderElectionService } from '../../src/status/leaderElectionService';
import type { ModelConfig, ProviderConfig } from '../../src/types/sharedTypes';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { applyConfigSet } from '../../src/utils/config/configSetCommands';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { ApiKeyFailoverManager } from '../../src/utils/config/failover/apiKeyFailoverManager';

function failoverIdentity(id: string, apiKey: string, site?: string): string {
    const fingerprint = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    return `${id}:${fingerprint}:${site ?? ''}`;
}

interface PatchedInterInstanceBus {
    getAuthorityTerm: typeof InterInstanceBus.getAuthorityTerm;
    isConnected: typeof InterInstanceBus.isConnected;
    publish: typeof InterInstanceBus.publish;
}

interface PatchedLeaderElectionService {
    getInstanceId: typeof LeaderElectionService.getInstanceId;
    getAuthorityTerm: typeof LeaderElectionService.getAuthorityTerm;
    getOwnedAuthorityTerm: typeof LeaderElectionService.getOwnedAuthorityTerm;
    isAgentsWindow: typeof LeaderElectionService.isAgentsWindow;
    isInitialized: typeof LeaderElectionService.isInitialized;
    isLeader: typeof LeaderElectionService.isLeader;
}

interface TestHandler {
    handleRequest: (
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        requestStartTime?: number,
        onRequestDispatched?: (requestMetricStartTime: number) => void,
        wasThrottled?: boolean
    ) => Promise<void>;
}

interface TestProvider {
    acquireRateLimit?: () => Promise<RateLimitHandle | undefined>;
    resolveRequestBaseUrl?: () => string;
    anthropicHandler: TestHandler;
    geminiHandler: TestHandler;
    baseProviderConfig: ProviderConfig;
    cachedProviderConfig: ProviderConfig;
    executeModelRequest: (
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: Array<vscode.LanguageModelChatMessage>,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        effectiveProviderKey?: string,
        requestStartTime?: number,
        totalInputTokens?: number,
        onAttemptStarted?: (requestMetricStartTime: number) => void
    ) => Promise<void>;
    getRequestRetryConfig: () => { enabled: boolean; maxAttempts: number; initialDelayMs: number; maxDelayMs: number };
    openaiCustomHandler: TestHandler;
    openaiHandler: TestHandler;
    openaiResponsesHandler: {
        handleResponsesRequest: (
            model: vscode.LanguageModelChatInformation,
            modelConfig: ModelConfig,
            messages: readonly vscode.LanguageModelChatMessage[],
            options: vscode.ProvideLanguageModelChatResponseOptions,
            progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
            requestId: string,
            sessionId: string,
            token: vscode.CancellationToken,
            requestStartTime?: number
        ) => Promise<void>;
    };
    providerKey: string;
    shouldRetryRequest: () => boolean;
    visionCache?: unknown;
}

function createTestProvider(handler: TestHandler): TestProvider {
    const provider = Object.create(GenericModelProvider.prototype) as unknown as TestProvider;
    const providerConfig = {
        displayName: 'Test Provider',
        models: []
    } as unknown as ProviderConfig;

    provider.providerKey = 'test-provider';
    provider.baseProviderConfig = providerConfig;
    provider.cachedProviderConfig = providerConfig;
    provider.visionCache = undefined;
    provider.openaiHandler = handler;
    provider.openaiCustomHandler = { handleRequest: handler.handleRequest };
    provider.openaiResponsesHandler = {
        handleResponsesRequest: async (
            model,
            modelConfig,
            messages,
            options,
            progress,
            requestId,
            sessionId,
            token,
            requestStartTime
        ) =>
            handler.handleRequest(
                model,
                modelConfig,
                messages,
                options,
                progress as unknown as vscode.Progress<vscode.LanguageModelResponsePart>,
                requestId,
                sessionId,
                token,
                requestStartTime
            )
    };
    provider.anthropicHandler = handler;
    provider.geminiHandler = handler;
    provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 });
    provider.shouldRetryRequest = () => true;

    return provider;
}

const model = {
    id: 'test-model',
    name: 'Test Model'
} as unknown as vscode.LanguageModelChatInformation;

const modelConfig: ModelConfig = {
    id: 'test-model',
    name: 'Test Model',
    tooltip: 'Test Model',
    maxInputTokens: 1024,
    maxOutputTokens: 1024,
    capabilities: {
        toolCalling: false,
        imageInput: true
    },
    sdkMode: 'openai'
};

function createProgress(outputs: string[]): vscode.Progress<vscode.LanguageModelResponsePart> {
    return {
        report(value) {
            if (value instanceof vscode.LanguageModelTextPart) {
                outputs.push(value.value);
            }
        }
    };
}

function createFailoverContext(): vscode.ExtensionContext {
    const globalState = new Map<string, unknown>();
    const secrets = new Map<string, string>();
    return {
        globalState: {
            get<T>(key: string, defaultValue?: T): T {
                return (globalState.has(key) ? globalState.get(key) : defaultValue) as T;
            },
            keys(): readonly string[] {
                return Array.from(globalState.keys());
            },
            async update(key: string, value: unknown): Promise<void> {
                if (value === undefined) {
                    globalState.delete(key);
                } else {
                    globalState.set(key, value);
                }
            }
        },
        secrets: {
            get(key: string): Thenable<string | undefined> {
                return Promise.resolve(secrets.get(key));
            },
            store(key: string, value: string): Thenable<void> {
                secrets.set(key, value);
                return Promise.resolve();
            },
            delete(key: string): Thenable<void> {
                secrets.delete(key);
                return Promise.resolve();
            }
        },
        globalStorageUri: vscode.Uri.file('v:/tmp/gcmp-tests/global'),
        globalStoragePath: 'v:/tmp/gcmp-tests/global'
    } as unknown as vscode.ExtensionContext;
}

suite('genericModelProvider retry gating', () => {
    for (const failure of ['snapshot', 'endpoint', 'cancelled'] as const) {
        test(`request preparation ${failure} failure releases the grant without dispatch`, async () => {
            const context = createFailoverContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const cancellation = new vscode.CancellationTokenSource();
            let calls = 0;
            let acquires = 0;
            const provider = createTestProvider({
                async handleRequest() {
                    calls += 1;
                }
            });
            const grant: RateLimitHandle = {
                grantId: 'preparation-grant',
                leaseMs: 10_000,
                costs: { requests: 1, tokens: 100 },
                authoritative: false
            };
            provider.acquireRateLimit = async () => {
                acquires += 1;
                return grant;
            };
            if (failure === 'endpoint') {
                provider.resolveRequestBaseUrl = () => {
                    throw new Error('preparation-failed');
                };
            }
            const originalCapture = ApiKeyFailoverManager.captureAttempt;
            const originalRelease = RateLimiter.release;
            const releases: Parameters<typeof RateLimiter.release>[] = [];
            ApiKeyFailoverManager.captureAttempt = async () => {
                if (failure === 'snapshot') {
                    throw new Error('preparation-failed');
                }
                if (failure === 'cancelled') {
                    cancellation.cancel();
                }
                return undefined;
            };
            RateLimiter.release = (...args) => {
                releases.push(args);
            };
            try {
                await assert.rejects(() =>
                    provider.executeModelRequest(
                        model,
                        modelConfig,
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        'session-preparation-failure',
                        cancellation.token,
                        'test-provider',
                        Date.now()
                    )
                );
                assert.equal(calls, 0);
                assert.equal(acquires, 1);
                assert.deepEqual(releases, [[grant, grant.costs]]);
            } finally {
                ApiKeyFailoverManager.captureAttempt = originalCapture;
                RateLimiter.release = originalRelease;
                cancellation.dispose();
            }
        });
    }

    for (const baseUrl of [undefined, '', '   ']) {
        test(`Gemini 缺少模型级地址时不派发：${JSON.stringify(baseUrl)}`, async () => {
            let attempts = 0;
            const provider = createTestProvider({
                async handleRequest() {
                    attempts++;
                }
            });
            provider.cachedProviderConfig.baseUrl = 'https://provider.test/v1';
            const source = new vscode.CancellationTokenSource();
            try {
                await assert.rejects(
                    provider.executeModelRequest(
                        model,
                        { ...modelConfig, sdkMode: 'gemini-sse', baseUrl },
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        'session-base-url',
                        source.token
                    ),
                    /baseUrl/
                );
                assert.equal(attempts, 0);
            } finally {
                source.dispose();
            }
        });
    }

    for (const sdkMode of ['gemini-sse', 'openai'] as const) {
        test(`${sdkMode} 保留原有有效地址解析且不修改模型配置`, async () => {
            let dispatchedBaseUrl: string | undefined;
            const provider = createTestProvider({
                async handleRequest(_model, config) {
                    dispatchedBaseUrl = config.baseUrl;
                }
            });
            provider.cachedProviderConfig.baseUrl = 'https://provider.test/v1';
            const config = {
                ...modelConfig,
                sdkMode,
                baseUrl: sdkMode === 'gemini-sse' ? 'https://gemini.test/v1beta' : undefined
            };
            const originalConfig = { ...config };
            const source = new vscode.CancellationTokenSource();
            try {
                await provider.executeModelRequest(
                    model,
                    config,
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress([]),
                    '',
                    'session-base-url-valid',
                    source.token
                );
                assert.equal(dispatchedBaseUrl, config.baseUrl ?? provider.cachedProviderConfig.baseUrl);
                assert.deepEqual(config, originalConfig);
            } finally {
                source.dispose();
            }
        });
    }

    test('does not retry after a streamed response part was emitted', async () => {
        let attempts = 0;
        const provider = createTestProvider({
            async handleRequest(_model, _config, _messages, _options, progress) {
                attempts += 1;
                progress.report(new vscode.LanguageModelTextPart(`attempt-${attempts}`));
                throw new Error('stream dropped after output');
            }
        });
        const outputs: string[] = [];

        await assert.rejects(
            () =>
                provider.executeModelRequest(
                    model,
                    modelConfig,
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress(outputs),
                    '',
                    'session-1',
                    new vscode.CancellationTokenSource().token,
                    'test-provider',
                    Date.now()
                ),
            /stream dropped after output/
        );

        assert.equal(attempts, 1);
        assert.deepEqual(outputs, ['attempt-1']);
    });

    test('keeps retrying when the failed attempt emitted nothing', async () => {
        let attempts = 0;
        const provider = createTestProvider({
            async handleRequest(_model, _config, _messages, _options, progress) {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('temporary network error');
                }
                progress.report(new vscode.LanguageModelTextPart('final-response'));
            }
        });
        const outputs: string[] = [];

        await provider.executeModelRequest(
            model,
            modelConfig,
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress(outputs),
            '',
            'session-2',
            new vscode.CancellationTokenSource().token,
            'test-provider',
            Date.now()
        );

        assert.equal(attempts, 2);
        assert.deepEqual(outputs, ['final-response']);
    });

    test('propagates attempt start time even when the request was not throttled', async () => {
        const provider = createTestProvider({
            async handleRequest(
                _model,
                _config,
                _messages,
                _options,
                _progress,
                _requestId,
                _sessionId,
                _token,
                _requestStartTime,
                onRequestDispatched
            ) {
                onRequestDispatched?.(Date.now());
                throw new Error('request failed after dispatch');
            }
        });
        provider.shouldRetryRequest = () => false;
        const attemptStarts: number[] = [];

        await assert.rejects(
            () =>
                provider.executeModelRequest(
                    model,
                    modelConfig,
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress([]),
                    '',
                    'session-3',
                    new vscode.CancellationTokenSource().token,
                    'test-provider',
                    Date.now(),
                    0,
                    requestMetricStartTime => {
                        attemptStarts.push(requestMetricStartTime);
                    }
                ),
            /request failed after dispatch/
        );

        assert.equal(attemptStarts.length, 1);
        assert.equal(Number.isFinite(attemptStarts[0]), true);
    });

    test('retries with the next API key after the configured failure threshold', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-provider';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const originalGet = context.secrets.get.bind(context.secrets);
        let secretReads = 0;
        context.secrets.get = async key => {
            secretReads += 1;
            return await originalGet(key);
        };
        let firstAttemptSecretReads = 0;
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress) {
                if (usedKeys.length === 0) {
                    firstAttemptSecretReads = secretReads;
                }
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                usedKeys.push(apiKey ?? '');
                if (apiKey === 'key-a') {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 });
        const outputs: string[] = [];

        await provider.executeModelRequest(
            model,
            { ...modelConfig, provider: slot },
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress(outputs),
            '',
            'session-failover',
            new vscode.CancellationTokenSource().token,
            slot,
            Date.now()
        );

        assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b']);
        assert.equal(firstAttemptSecretReads, 3, 'only the dispatched attempt should scan the key pool');
        assert.deepEqual(outputs, ['recovered']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
    });

    for (const [name, failure] of [
        ['request', Object.assign(new Error('invalid request'), { status: 400 })],
        ['server', Object.assign(new Error('server failure'), { status: 500 })],
        ['network', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
        ['quota', new Error('令牌额度不足')],
        ['unknown', new Error('unrecognized upstream failure')],
        ['null', null],
        ['string', 'upstream failure']
    ] as const) {
        test(`switches after three ${name} errors without relying on ordinary retry classification`, async () => {
            const context = createFailoverContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const slot = `test-failover-any-error-${name}`;
            await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
            await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
            await applyConfigSet(slot, { id: 'a', label: 'a' });
            await ConfigSetStore.setAutoSwitchEnabled(slot, true);
            const usedKeys: string[] = [];
            const provider = createTestProvider({
                async handleRequest(_model, config, _messages, _options, progress) {
                    const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                    usedKeys.push(apiKey ?? '');
                    if (apiKey === 'key-a') {
                        throw failure;
                    }
                    progress.report(new vscode.LanguageModelTextPart('recovered'));
                }
            });
            Reflect.deleteProperty(provider, 'shouldRetryRequest');
            const cancellation = new vscode.CancellationTokenSource();
            const outputs: string[] = [];
            try {
                await provider.executeModelRequest(
                    model,
                    { ...modelConfig, provider: slot },
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress(outputs),
                    '',
                    'session-any-error',
                    cancellation.token,
                    slot
                );
                assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b']);
                assert.deepEqual(outputs, ['recovered']);
                assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            } finally {
                cancellation.dispose();
            }
        });
    }

    for (const status of [200, 400]) {
        test(`switches after three SDK-wrapped gateway errors (HTTP ${status})`, async () => {
            const context = createFailoverContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const slot = `test-failover-sdk-gateway-${status}`;
            await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
            await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
            await applyConfigSet(slot, { id: 'a', label: 'a' });
            await ConfigSetStore.setAutoSwitchEnabled(slot, true);
            const preprocessor = Object.create(OpenAIHandler.prototype) as {
                preprocessSSEResponse(response: Response): Promise<Response>;
            };
            const usedKeys: string[] = [];
            const sdkErrors: unknown[] = [];
            const eventTypes: string[] = [];
            const provider = createTestProvider({
                async handleRequest(_model, config, _messages, _options, progress) {
                    const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                    usedKeys.push(apiKey ?? '');
                    const client = new OpenAI({
                        apiKey: apiKey ?? '',
                        baseURL: 'https://gateway.test/v1',
                        maxRetries: 0,
                        fetch: async () => {
                            if (apiKey === 'key-a') {
                                return await preprocessor.preprocessSSEResponse(
                                    new Response(JSON.stringify({ error: { message: '令牌额度不足' } }), {
                                        status,
                                        headers: { 'Content-Type': 'application/json' }
                                    })
                                );
                            }
                            return new Response(
                                'data: {"type":"response.completed","response":{"id":"recovered","output":[]}}\n\ndata: [DONE]\n\n',
                                { headers: { 'Content-Type': 'text/event-stream' } }
                            );
                        }
                    });
                    try {
                        const stream = await client.responses.create({
                            model: config.id,
                            input: 'test',
                            stream: true
                        });
                        for await (const event of stream) {
                            eventTypes.push(event.type);
                        }
                    } catch (error) {
                        sdkErrors.push(error);
                        throw error;
                    }
                    progress.report(new vscode.LanguageModelTextPart('recovered'));
                }
            });
            Reflect.deleteProperty(provider, 'shouldRetryRequest');
            const cancellation = new vscode.CancellationTokenSource();
            const outputs: string[] = [];
            try {
                await provider.executeModelRequest(
                    model,
                    { ...modelConfig, provider: slot, sdkMode: 'openai-responses' },
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress(outputs),
                    '',
                    'session-sdk-gateway',
                    cancellation.token,
                    slot
                );
                assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b']);
                assert.equal(sdkErrors.length, 3);
                for (const error of sdkErrors) {
                    assert.ok(error instanceof OpenAI.APIError);
                    assert.equal(error.status, status);
                    assert.deepEqual(error.error, { message: '令牌额度不足' });
                    if (status === 400) {
                        assert.ok(error instanceof OpenAI.BadRequestError);
                    } else {
                        assert.ok(!(error instanceof OpenAI.APIConnectionError));
                    }
                }
                assert.deepEqual(eventTypes, ['response.completed']);
                assert.deepEqual(outputs, ['recovered']);
                assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            } finally {
                cancellation.dispose();
            }
        });
    }

    for (const mode of ['error', 'token'] as const) {
        test(`does not count ${mode} cancellation as the third failure`, async () => {
            const context = createFailoverContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const slot = `test-failover-cancel-third-${mode}`;
            await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
            await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
            await applyConfigSet(slot, { id: 'a', label: 'a' });
            await ConfigSetStore.setAutoSwitchEnabled(slot, true);
            const cancellation = new vscode.CancellationTokenSource();
            let attempts = 0;
            const provider = createTestProvider({
                async handleRequest() {
                    attempts += 1;
                    if (attempts < 3) {
                        throw Object.assign(new Error('server failure'), { status: 503 });
                    }
                    if (mode === 'error') {
                        throw new vscode.CancellationError();
                    }
                    cancellation.cancel();
                    throw new Error('Connection error.');
                }
            });
            provider.getRequestRetryConfig = () => ({
                enabled: true,
                maxAttempts: 3,
                initialDelayMs: 0,
                maxDelayMs: 0
            });
            try {
                await assert.rejects(() =>
                    provider.executeModelRequest(
                        model,
                        { ...modelConfig, provider: slot },
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        'session-cancel-third',
                        cancellation.token,
                        slot
                    )
                );
                assert.equal(attempts, 3);
                assert.equal(ConfigSetStore.getActiveId(slot), 'a');
                assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
            } finally {
                cancellation.dispose();
            }
        });
    }

    test('waits for leader confirmation before retrying with a switched API key', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-leader-confirmation';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalPublish = patchedBus.publish;
        const originalGetInstanceId = patchedLeaderElection.getInstanceId;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        let requestedPayload: ApiKeyFailoverRequestedEvent['payload'] | undefined;

        try {
            patchedLeaderElection.getInstanceId = () => 'follower-a';
            patchedLeaderElection.getAuthorityTerm = () => 'leader-a:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-a:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.publish = ((event: { type: string; payload: unknown }) => {
                if (event.type === 'apiKeyFailoverRequested') {
                    requestedPayload = event.payload as ApiKeyFailoverRequestedEvent['payload'];
                }
            }) as typeof InterInstanceBus.publish;

            const attemptedIdentities = new Set<string>();
            let settled = false;
            const pendingDecision = ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                attemptedIdentities,
                3,
                'a'
            ).then(decision => {
                settled = true;
                return decision;
            });

            await new Promise(resolve => setImmediate(resolve));
            assert.equal(settled, false);
            assert.ok(requestedPayload);
            assert.equal('apiKey' in requestedPayload, false);
            assert.deepEqual(requestedPayload.attemptedIdentities, [attempt.identity]);

            patchedLeaderElection.isLeader = () => true;
            const leaderDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal(requestedPayload);
            assert.deepEqual(leaderDecision, { handled: true, shouldRetry: true, switched: true });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');

            ApiKeyFailoverManager.resolveLeaderDecision(requestedPayload.requestId, leaderDecision);
            assert.deepEqual(await pendingDecision, leaderDecision);
            assert.equal(settled, true);
        } finally {
            patchedBus.publish = originalPublish;
            patchedLeaderElection.getInstanceId = originalGetInstanceId;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('stops waiting for leader confirmation when the request is cancelled', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-leader-cancellation';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalPublish = patchedBus.publish;
        const originalGetInstanceId = patchedLeaderElection.getInstanceId;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        let requestedPayload: ApiKeyFailoverRequestedEvent['payload'] | undefined;
        const cts = new vscode.CancellationTokenSource();

        try {
            patchedLeaderElection.getInstanceId = () => 'follower-cancelled';
            patchedLeaderElection.getAuthorityTerm = () => 'leader-cancelled:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.publish = (event => {
                if (event.type === 'apiKeyFailoverRequested') {
                    requestedPayload = event.payload as ApiKeyFailoverRequestedEvent['payload'];
                }
            }) as typeof InterInstanceBus.publish;

            const pendingDecision = ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                new Set(),
                3,
                'a',
                false,
                undefined,
                undefined,
                undefined,
                cts.token
            );
            await new Promise(resolve => setImmediate(resolve));
            assert.ok(requestedPayload);
            cts.cancel();

            const outcome = await Promise.race([
                pendingDecision,
                new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 500))
            ]);
            assert.notEqual(outcome, 'timed-out');
            assert.deepEqual(outcome, { handled: true, shouldRetry: false, switched: false });

            ApiKeyFailoverManager.resolveLeaderDecision(requestedPayload.requestId, {
                handled: true,
                shouldRetry: true,
                switched: true
            });
        } finally {
            cts.dispose();
            patchedBus.publish = originalPublish;
            patchedLeaderElection.getInstanceId = originalGetInstanceId;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('continues a leader rotation after the originating request is cancelled', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-leader-cancelled-request';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsAgentsWindow = patchedLeaderElection.isAgentsWindow;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const cts = new vscode.CancellationTokenSource();

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-cancelled-request:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-cancelled-request:1';
            patchedLeaderElection.isAgentsWindow = () => false;
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const decision = ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                new Set(),
                3,
                'a',
                false,
                undefined,
                'leader-cancelled-request-source',
                undefined,
                cts.token
            );
            await new Promise(resolve => setImmediate(resolve));
            cts.cancel();

            assert.deepEqual(await decision, { handled: true, shouldRetry: true, switched: true });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
        } finally {
            cts.dispose();
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isAgentsWindow = originalIsAgentsWindow;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    for (const outcome of ['cancelled-token', 'cancellation-error', 'success', 'error'] as const) {
        test(`handles a contributing request ending with ${outcome} during leader rotation`, async () => {
            const context = createFailoverContext();
            ApiKeyManager.initialize(context);
            ConfigSetStore.initialize(context);
            const slot = `test-failover-contributor-${outcome}`;
            await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
            await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
            await ConfigSetStore.setActive(slot, 'a');
            await ApiKeyManager.setApiKey(slot, 'key-a');
            await ConfigSetStore.setAutoSwitchEnabled(slot, true);

            const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
            const originals = {
                getAuthorityTerm: patchedLeaderElection.getAuthorityTerm,
                getOwnedAuthorityTerm: patchedLeaderElection.getOwnedAuthorityTerm,
                isAgentsWindow: patchedLeaderElection.isAgentsWindow,
                isInitialized: patchedLeaderElection.isInitialized,
                isLeader: patchedLeaderElection.isLeader
            };
            const manager = ApiKeyFailoverManager as unknown as {
                leaderFailureWindows: Map<string, { slot: string; aggregateFailureCount: number }>;
                rotateLeaderConfiguration: (...args: unknown[]) => Promise<unknown>;
            };
            const originalRotate = manager.rotateLeaderConfiguration;
            const cancellation = new vscode.CancellationTokenSource();
            const otherCancellation = new vscode.CancellationTokenSource();
            let notifyThirdAttempt: (() => void) | undefined;
            const thirdAttempt = new Promise<boolean>(resolve => {
                notifyThirdAttempt = () => resolve(true);
            });
            let releaseThirdAttempt: (() => void) | undefined;
            const thirdAttemptGate = new Promise<void>(resolve => {
                releaseThirdAttempt = resolve;
            });
            let notifyRotation: (() => void) | undefined;
            const rotationStarted = new Promise<boolean>(resolve => {
                notifyRotation = () => resolve(true);
            });
            const usedKeys: string[] = [];
            const otherKeys: string[] = [];
            const outputs: string[] = [];
            const contributor = createTestProvider({
                async handleRequest(_model, config, _messages, _options, progress) {
                    const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                    usedKeys.push(apiKey ?? '');
                    if (apiKey === 'key-b') {
                        progress.report(new vscode.LanguageModelTextPart('recovered'));
                        return;
                    }
                    if (usedKeys.length === 3) {
                        notifyThirdAttempt?.();
                        await thirdAttemptGate;
                        if (outcome === 'cancellation-error') {
                            throw new vscode.CancellationError();
                        }
                        if (outcome === 'success') {
                            progress.report(new vscode.LanguageModelTextPart('successful'));
                            return;
                        }
                    }
                    throw Object.assign(new Error('service unavailable'), { status: 503 });
                }
            });
            const other = createTestProvider({
                async handleRequest(_model, config) {
                    otherKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                    throw Object.assign(new Error('service unavailable'), { status: 503 });
                }
            });
            contributor.acquireRateLimit = async () => undefined;
            other.acquireRateLimit = async () => undefined;
            other.getRequestRetryConfig = () => ({ enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 });
            const runRequest = (provider: TestProvider, token: vscode.CancellationToken) =>
                provider.executeModelRequest(
                    model,
                    { ...modelConfig, provider: slot },
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress(outputs),
                    '',
                    'session-contributor-rotation',
                    token,
                    slot
                );
            let contributorDone: Promise<PromiseSettledResult<void>[]> | undefined;
            let otherDone: Promise<PromiseSettledResult<void>[]> | undefined;

            try {
                patchedLeaderElection.getAuthorityTerm = () => `${slot}:1`;
                patchedLeaderElection.getOwnedAuthorityTerm = () => `${slot}:1`;
                patchedLeaderElection.isAgentsWindow = () => false;
                patchedLeaderElection.isInitialized = () => true;
                patchedLeaderElection.isLeader = () => true;
                manager.rotateLeaderConfiguration = (...args) => {
                    const pending = originalRotate.apply(ApiKeyFailoverManager, args);
                    notifyRotation?.();
                    return pending;
                };

                contributorDone = Promise.allSettled([runRequest(contributor, cancellation.token)]);
                assert.equal(await Promise.race([thirdAttempt, contributorDone.then(() => false)]), true);
                const failureWindow = [...manager.leaderFailureWindows.values()].find(state => state.slot === slot);
                assert.equal(failureWindow?.aggregateFailureCount, 2);

                otherDone = Promise.allSettled([runRequest(other, otherCancellation.token)]);
                assert.equal(await Promise.race([rotationStarted, otherDone.then(() => false)]), true);
                assert.equal(failureWindow?.aggregateFailureCount, 3);
                if (outcome === 'cancelled-token') {
                    cancellation.cancel();
                }
                releaseThirdAttempt?.();

                const [contributorResult] = await contributorDone;
                const [otherResult] = await otherDone;
                assert.equal(otherResult.status, 'rejected');
                assert.deepEqual(otherKeys, ['key-a']);
                assert.equal(
                    contributorResult.status,
                    outcome === 'cancelled-token' || outcome === 'cancellation-error' ? 'rejected' : 'fulfilled'
                );
                assert.deepEqual(
                    usedKeys,
                    outcome === 'error' ? ['key-a', 'key-a', 'key-a', 'key-b'] : ['key-a', 'key-a', 'key-a']
                );
                assert.deepEqual(
                    outputs,
                    outcome === 'error' ? ['recovered']
                    : outcome === 'success' ? ['successful']
                    : []
                );
                assert.equal(ConfigSetStore.getActiveId(slot), outcome === 'success' ? 'a' : 'b');
                assert.equal(await ApiKeyManager.getApiKey(slot), outcome === 'success' ? 'key-a' : 'key-b');
            } finally {
                releaseThirdAttempt?.();
                await contributorDone;
                await otherDone;
                manager.rotateLeaderConfiguration = originalRotate;
                Object.assign(patchedLeaderElection, originals);
                cancellation.dispose();
                otherCancellation.dispose();
            }
        });
    }

    test('stops immediately when a follower cannot publish its failover request', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-follower-publish-failure';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalPublish = patchedBus.publish;
        const originalGetInstanceId = patchedLeaderElection.getInstanceId;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalIsAgentsWindow = patchedLeaderElection.isAgentsWindow;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getInstanceId = () => 'follower-publish-failure';
            patchedLeaderElection.getAuthorityTerm = () => 'leader-publish-failure:1';
            patchedLeaderElection.isAgentsWindow = () => false;
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.publish = (() => {
                throw new Error('publish-failed');
            }) as typeof InterInstanceBus.publish;

            const outcome = await Promise.race([
                ApiKeyFailoverManager.handleFailure(slot, { status: 429 }, attempt, new Set(), 3, 'a'),
                new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 500))
            ]);

            assert.notEqual(outcome, 'timed-out');
            assert.deepEqual(outcome, { handled: true, shouldRetry: false, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        } finally {
            patchedBus.publish = originalPublish;
            patchedLeaderElection.getInstanceId = originalGetInstanceId;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.isAgentsWindow = originalIsAgentsWindow;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('aggregates simultaneous failures across instances before one rotation', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-batch-dedup';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalPublish = patchedBus.publish;
        const originalGetInstanceId = patchedLeaderElection.getInstanceId;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const requestedPayloads: ApiKeyFailoverRequestedEvent['payload'][] = [];

        try {
            patchedLeaderElection.getInstanceId = () => 'follower-batch';
            patchedLeaderElection.getAuthorityTerm = () => 'leader-batch:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-batch:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => false;
            patchedBus.publish = (event => {
                if (event.type === 'apiKeyFailoverRequested') {
                    requestedPayloads.push(event.payload as ApiKeyFailoverRequestedEvent['payload']);
                }
            }) as typeof InterInstanceBus.publish;

            const firstPending = ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                new Set(),
                1,
                'a',
                false
            );
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(requestedPayloads.length, 1);
            const secondPending = ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                new Set(),
                1,
                'a'
            );
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(requestedPayloads.length, 2);
            assert.notEqual(requestedPayloads[0]!.failureRequestId, requestedPayloads[1]!.failureRequestId);
            patchedLeaderElection.isLeader = () => true;
            const firstDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal(requestedPayloads[0]!);
            const secondDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal(requestedPayloads[1]!);
            const duplicateFirstDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                ...requestedPayloads[0]!,
                requestId: 'duplicate-transport-request'
            });
            assert.deepEqual(duplicateFirstDecision, { handled: true, shouldRetry: true, switched: false });
            ApiKeyFailoverManager.resetFailureCount(slot, requestedPayloads[0]!.failureRequestId);
            const cumulativeFirstDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                ...requestedPayloads[0]!,
                requestId: 'cumulative-transport-request',
                failureRequestId: 'cumulative-failure-source',
                consecutiveFailureCount: 2
            });
            assert.deepEqual(cumulativeFirstDecision, { handled: true, shouldRetry: true, switched: true });

            assert.deepEqual(firstDecision, { handled: true, shouldRetry: true, switched: false });
            assert.deepEqual(secondDecision, { handled: true, shouldRetry: true, switched: false });
            assert.deepEqual(duplicateFirstDecision, { handled: true, shouldRetry: true, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            await ConfigSetStore.setActive(slot, 'a');
            await ApiKeyManager.setApiKey(slot, 'key-a');
            const returnedToInitialDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                ...requestedPayloads[0]!,
                requestId: 'returned-to-initial-request',
                failureRequestId: 'returned-to-initial-failure',
                activeId: 'a',
                identity: attempt.identity,
                attemptedIdentities: [attempt.identity, failoverIdentity('b', 'key-b')],
                initialConfigId: 'a',
                returnedToInitial: true,
                consecutiveFailureCount: 1
            });
            assert.deepEqual(returnedToInitialDecision, { handled: true, shouldRetry: false, switched: false });

            ApiKeyFailoverManager.resolveLeaderDecision(requestedPayloads[0]!.requestId, firstDecision);
            ApiKeyFailoverManager.resolveLeaderDecision(requestedPayloads[1]!.requestId, secondDecision);
            assert.deepEqual(await firstPending, firstDecision);
            assert.deepEqual(await secondPending, secondDecision);
        } finally {
            patchedBus.publish = originalPublish;
            patchedLeaderElection.getInstanceId = originalGetInstanceId;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('aggregates leader-local and follower failures in the same window', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-leader-and-follower';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-local:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-local:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const attempted = new Set<string>();
            const firstLocal = await ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                attempted,
                1,
                'a',
                false,
                undefined,
                'leader-local-request'
            );
            const follower = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'follower-transport-1',
                failureRequestId: 'follower-source-1',
                authorityTerm: 'leader-local:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 1,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            const secondLocal = await ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                attempted,
                2,
                'a',
                false,
                undefined,
                'leader-local-request'
            );

            assert.deepEqual(firstLocal, { handled: true, shouldRetry: true, switched: false });
            assert.deepEqual(follower, { handled: true, shouldRetry: true, switched: false });
            assert.deepEqual(secondLocal, { handled: true, shouldRetry: true, switched: true });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('does not aggregate failures across an expired leader window', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-expired-leader-window';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalNow = Date.now;
        let now = 100_000;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-expired-window:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-expired-window:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;
            Date.now = () => now;

            const first = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'expired-window-request-1',
                failureRequestId: 'expired-window-source-1',
                authorityTerm: 'leader-expired-window:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 2,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            now += 10_001;
            const second = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'expired-window-request-2',
                failureRequestId: 'expired-window-source-2',
                authorityTerm: 'leader-expired-window:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 1,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(first, { handled: true, shouldRetry: true, switched: false });
            assert.deepEqual(second, { handled: true, shouldRetry: true, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        } finally {
            Date.now = originalNow;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('derives retry decisions independently for requests sharing one rotation', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-request-local-decision';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalHandleFailure = ApiKeyFailoverManager.handleFailure;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-request-local:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-request-local:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;
            ApiKeyFailoverManager.handleFailure = async () => {
                throw new Error('Leader rotation must not re-enter the public failure handler');
            };

            const retryingRequest = ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'request-local-1',
                failureRequestId: 'request-local-source-1',
                authorityTerm: 'leader-request-local:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            const exhaustedRequest = ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'request-local-2',
                failureRequestId: 'request-local-source-2',
                authorityTerm: 'leader-request-local:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [attempt.identity, failoverIdentity('b', 'key-b')],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(await retryingRequest, { handled: true, shouldRetry: true, switched: true });
            assert.deepEqual(await exhaustedRequest, { handled: true, shouldRetry: false, switched: true });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        } finally {
            ApiKeyFailoverManager.handleFailure = originalHandleFailure;
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('cancels a pending rotation when a success reset arrives during settlement', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-reset-during-settlement';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-reset-settlement:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-reset-settlement:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const decision = ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'reset-settlement-request',
                failureRequestId: 'reset-settlement-source',
                authorityTerm: 'leader-reset-settlement:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            ApiKeyFailoverManager.handleLeaderFailureReset({
                authorityTerm: 'leader-reset-settlement:1',
                slot,
                failureRequestId: 'reset-settlement-source'
            });

            assert.deepEqual(await decision, { handled: true, shouldRetry: true, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('stops a pending rotation when automatic switching is disabled during settlement', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-disabled-during-settlement';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-disabled-settlement:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-disabled-settlement:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const decision = ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'disabled-settlement-request',
                failureRequestId: 'disabled-settlement-source',
                authorityTerm: 'leader-disabled-settlement:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            await ConfigSetStore.setAutoSwitchEnabled(slot, false);

            assert.deepEqual(await decision, { handled: true, shouldRetry: false, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('does not reuse a completed rotation after the active credential returns', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-completed-window';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const firstAttempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(firstAttempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-completed-window:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-completed-window:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const firstRotation = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'completed-window-a-to-b',
                failureRequestId: 'completed-window-source-a',
                authorityTerm: 'leader-completed-window:1',
                slot,
                activeId: 'a',
                identity: firstAttempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [firstAttempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            assert.deepEqual(firstRotation, { handled: true, shouldRetry: true, switched: true });

            const secondAttempt = await ApiKeyFailoverManager.captureAttempt(slot);
            assert.ok(secondAttempt);
            const secondRotation = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'completed-window-b-to-a',
                failureRequestId: 'completed-window-source-b',
                authorityTerm: 'leader-completed-window:1',
                slot,
                activeId: 'b',
                identity: secondAttempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [firstAttempt.identity, secondAttempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            assert.deepEqual(secondRotation, {
                handled: true,
                shouldRetry: true,
                switched: true,
                switchedToInitial: true
            });

            const returnedAttempt = await ApiKeyFailoverManager.captureAttempt(slot);
            assert.ok(returnedAttempt);
            const freshFailure = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'completed-window-fresh-a',
                failureRequestId: 'completed-window-source-fresh-a',
                authorityTerm: 'leader-completed-window:1',
                slot,
                activeId: 'a',
                identity: returnedAttempt.identity,
                consecutiveFailureCount: 1,
                attemptedIdentities: [returnedAttempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(freshFailure, { handled: true, shouldRetry: true, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('rejects a failover request when the shared term belongs to a newer leader', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-old-leader-fencing';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'new-leader:2';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'old-leader:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            const decision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'new-term-transport',
                failureRequestId: 'new-term-source',
                authorityTerm: 'new-leader:2',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 3,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(decision, { handled: true, shouldRetry: false, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('does not carry delayed failures across an external configuration change', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-stale-identity';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-stale:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-stale:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            await ConfigSetStore.setActive(slot, 'b');
            await ApiKeyManager.setApiKey(slot, 'key-b');
            const staleDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'stale-transport',
                failureRequestId: 'stale-source',
                authorityTerm: 'leader-stale:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 1,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            assert.deepEqual(staleDecision, { handled: true, shouldRetry: true, switched: true });

            await ConfigSetStore.setActive(slot, 'a');
            await ApiKeyManager.setApiKey(slot, 'key-a');
            const freshDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'fresh-transport',
                failureRequestId: 'fresh-source',
                authorityTerm: 'leader-stale:1',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 2,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(freshDecision, { handled: true, shouldRetry: true, switched: false });
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('does not retry an attempted credential when the same configuration reverts to it', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-identity-revert';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a-v1');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a-v1');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const firstAttempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(firstAttempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-revert:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-revert:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;

            await ConfigSetStore.setApiKey(slot, 'a', 'key-a-v2');
            await ApiKeyManager.setApiKey(slot, 'key-a-v2');
            const secondAttempt = await ApiKeyFailoverManager.captureAttempt(slot);
            assert.ok(secondAttempt);
            assert.notEqual(secondAttempt.identity, firstAttempt.identity);

            const changedDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'identity-changed',
                failureRequestId: 'identity-source',
                authorityTerm: 'leader-revert:1',
                slot,
                activeId: 'a',
                identity: firstAttempt.identity,
                consecutiveFailureCount: 1,
                attemptedIdentities: [firstAttempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });
            assert.deepEqual(changedDecision, { handled: true, shouldRetry: true, switched: true });

            await ConfigSetStore.setApiKey(slot, 'a', 'key-a-v1');
            await ApiKeyManager.setApiKey(slot, 'key-a-v1');
            const revertedDecision = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                requestId: 'identity-reverted',
                failureRequestId: 'identity-source',
                authorityTerm: 'leader-revert:1',
                slot,
                activeId: 'a',
                identity: secondAttempt.identity,
                consecutiveFailureCount: 2,
                attemptedIdentities: [firstAttempt.identity, secondAttempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            });

            assert.deepEqual(revertedDecision, { handled: true, shouldRetry: false, switched: true });
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('ignores delayed failure events after their source was reset', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-reset-tombstone';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedLeaderElection.getAuthorityTerm;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;

        try {
            patchedLeaderElection.getAuthorityTerm = () => 'leader-reset:1';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-reset:1';
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => true;
            const payload: ApiKeyFailoverRequestedEvent['payload'] = {
                requestId: 'reset-transport-1',
                failureRequestId: 'reset-source',
                authorityTerm: 'leader-reset:1',
                requestedBy: 'follower-reset',
                slot,
                activeId: 'a',
                identity: attempt.identity,
                consecutiveFailureCount: 2,
                attemptedIdentities: [attempt.identity],
                initialConfigId: 'a',
                returnedToInitial: false
            };

            assert.deepEqual(await ApiKeyFailoverManager.handleLeaderFailureSignal(payload), {
                handled: true,
                shouldRetry: true,
                switched: false
            });
            ApiKeyFailoverManager.handleLeaderFailureReset({
                authorityTerm: payload.authorityTerm,
                slot,
                failureRequestId: payload.failureRequestId
            });
            assert.deepEqual(
                await ApiKeyFailoverManager.handleLeaderFailureSignal({
                    ...payload,
                    requestId: 'reset-transport-delayed',
                    consecutiveFailureCount: 3
                }),
                { handled: true, shouldRetry: true, switched: false }
            );
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');

            const newSource = { ...payload, requestId: 'reset-transport-new', failureRequestId: 'new-source' };
            await ApiKeyFailoverManager.handleLeaderFailureSignal({ ...newSource, consecutiveFailureCount: 1 });
            const switched = await ApiKeyFailoverManager.handleLeaderFailureSignal({
                ...newSource,
                requestId: 'reset-transport-new-3',
                consecutiveFailureCount: 3
            });
            assert.deepEqual(switched, { handled: true, shouldRetry: true, switched: true });
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        } finally {
            patchedLeaderElection.getAuthorityTerm = originalGetAuthorityTerm;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    test('does not request failover from an agent window without a leader service', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-agent-without-leader';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const attempt = await ApiKeyFailoverManager.captureAttempt(slot);
        assert.ok(attempt);
        const patchedBus = InterInstanceBus as unknown as PatchedInterInstanceBus;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalGetAuthorityTerm = patchedBus.getAuthorityTerm;
        const originalIsConnected = patchedBus.isConnected;
        const originalPublish = patchedBus.publish;
        const originalIsAgentsWindow = patchedLeaderElection.isAgentsWindow;
        const originalIsInitialized = patchedLeaderElection.isInitialized;
        const originalIsLeader = patchedLeaderElection.isLeader;
        let publishCalls = 0;

        try {
            patchedBus.getAuthorityTerm = () => undefined;
            patchedBus.isConnected = () => false;
            patchedBus.publish = (() => {
                publishCalls += 1;
            }) as typeof InterInstanceBus.publish;
            patchedLeaderElection.isAgentsWindow = () => true;
            patchedLeaderElection.isInitialized = () => true;
            patchedLeaderElection.isLeader = () => false;

            const decision = await ApiKeyFailoverManager.handleFailure(
                slot,
                { status: 429 },
                attempt,
                new Set(),
                3,
                'a'
            );

            assert.deepEqual(decision, { handled: true, shouldRetry: false, switched: false });
            assert.equal(publishCalls, 0);
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
        } finally {
            patchedBus.getAuthorityTerm = originalGetAuthorityTerm;
            patchedBus.isConnected = originalIsConnected;
            patchedBus.publish = originalPublish;
            patchedLeaderElection.isAgentsWindow = originalIsAgentsWindow;
            patchedLeaderElection.isInitialized = originalIsInitialized;
            patchedLeaderElection.isLeader = originalIsLeader;
        }
    });

    for (const leader of [false, true]) {
        for (const change of ['configuration', 'credential'] as const) {
            test(`resets failures when ${change} changes between attempts (leader=${leader})`, async () => {
                const context = createFailoverContext();
                ApiKeyManager.initialize(context);
                ConfigSetStore.initialize(context);
                const slot = `test-failover-between-attempts-${change}-${leader}`;
                for (const id of ['a', 'b', 'c']) {
                    await ConfigSetStore.add(slot, { id, label: id }, `key-${id}`);
                }
                await applyConfigSet(slot, { id: 'a', label: 'a' });
                await ConfigSetStore.setAutoSwitchEnabled(slot, true);

                const originalElection = {
                    isInitialized: LeaderElectionService.isInitialized,
                    isLeader: LeaderElectionService.isLeader,
                    isAgentsWindow: LeaderElectionService.isAgentsWindow,
                    getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
                    getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm
                };
                const originalReset = ApiKeyFailoverManager.resetFailureCount;
                const resetSources: string[] = [];
                const usedKeys: string[] = [];
                let resetsBeforeChangedAttempt = 0;
                let acquires = 0;
                const cancellation = new vscode.CancellationTokenSource();
                const provider = createTestProvider({
                    async handleRequest(_model, config) {
                        usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                        if (usedKeys.length === 3) {
                            resetsBeforeChangedAttempt = resetSources.length;
                        }
                        if (usedKeys.length <= 3) {
                            throw Object.assign(new Error('rate limited'), { status: 429 });
                        }
                    }
                });
                provider.acquireRateLimit = async () => {
                    if (++acquires === 3) {
                        if (change === 'configuration') {
                            await applyConfigSet(slot, { id: 'b', label: 'b' });
                        } else {
                            await ConfigSetStore.setApiKey(slot, 'a', 'key-a-v2');
                            await ApiKeyManager.setApiKey(slot, 'key-a-v2');
                        }
                    }
                    return undefined;
                };

                try {
                    LeaderElectionService.isInitialized = () => leader;
                    LeaderElectionService.isLeader = () => leader;
                    LeaderElectionService.isAgentsWindow = () => false;
                    LeaderElectionService.getAuthorityTerm = () => 'between-attempts-leader:1';
                    LeaderElectionService.getOwnedAuthorityTerm = () => 'between-attempts-leader:1';
                    ApiKeyFailoverManager.resetFailureCount = (targetSlot, failureRequestId) => {
                        resetSources.push(failureRequestId);
                        originalReset.call(ApiKeyFailoverManager, targetSlot, failureRequestId);
                    };
                    await provider.executeModelRequest(
                        model,
                        { ...modelConfig, provider: slot },
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        'session-between-attempts',
                        cancellation.token,
                        slot
                    );
                } finally {
                    Object.assign(LeaderElectionService, originalElection);
                    ApiKeyFailoverManager.resetFailureCount = originalReset;
                    cancellation.dispose();
                }

                const changedKey = change === 'configuration' ? 'key-b' : 'key-a-v2';
                assert.deepEqual(usedKeys, ['key-a', 'key-a', changedKey, changedKey]);
                assert.equal(ConfigSetStore.getActiveId(slot), change === 'configuration' ? 'b' : 'a');
                assert.equal(resetsBeforeChangedAttempt, 1);
                assert.equal(resetSources.length, 2);
                assert.notEqual(resetSources[0], resetSources[1]);
            });
        }
    }

    for (const failure of ['server', 'network'] as const) {
        for (const mode of ['bounded', 'unlimited', 'disabled', 'zero'] as const) {
            test(`preserves the ${mode} retry budget for ${failure} errors with failover disabled`, async () => {
                const context = createFailoverContext();
                ApiKeyManager.initialize(context);
                ConfigSetStore.initialize(context);
                const slot = `test-failover-budget-${failure}-${mode}`;
                await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
                await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
                await applyConfigSet(slot, { id: 'a', label: 'a' });
                await ConfigSetStore.setAutoSwitchEnabled(slot, false);

                let attempts = 0;
                const failureError =
                    failure === 'server' ?
                        Object.assign(new Error('service unavailable'), { status: 503 })
                    :   Object.assign(new Error('ECONNRESET socket hang up'), { code: 'ECONNRESET' });
                const provider = createTestProvider({
                    async handleRequest() {
                        if (++attempts === 8) {
                            return;
                        }
                        throw failureError;
                    }
                });
                provider.getRequestRetryConfig = () => ({
                    enabled: mode !== 'disabled',
                    maxAttempts:
                        mode === 'unlimited' ? -1
                        : mode === 'zero' ? 0
                        : 2,
                    initialDelayMs: 0,
                    maxDelayMs: 0
                });
                const cancellation = new vscode.CancellationTokenSource();
                try {
                    const request = provider.executeModelRequest(
                        model,
                        { ...modelConfig, provider: slot },
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        'session-non-key-budget',
                        cancellation.token,
                        slot
                    );
                    if (mode === 'unlimited') {
                        await request;
                    } else {
                        await assert.rejects(request, error => error === failureError);
                    }
                    assert.equal(
                        attempts,
                        mode === 'unlimited' ? 8
                        : mode === 'bounded' ? 3
                        : 1
                    );
                    assert.equal(ConfigSetStore.getActiveId(slot), 'a');
                } finally {
                    cancellation.dispose();
                }
            });
        }
    }

    test('counts failures on the leader when ordinary retries are disabled', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-disabled-retry-counts';
        await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
        await applyConfigSet(slot, { id: 'a', label: 'a' });
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);
        const originalElection = {
            isInitialized: LeaderElectionService.isInitialized,
            isLeader: LeaderElectionService.isLeader,
            isAgentsWindow: LeaderElectionService.isAgentsWindow,
            getAuthorityTerm: LeaderElectionService.getAuthorityTerm,
            getOwnedAuthorityTerm: LeaderElectionService.getOwnedAuthorityTerm
        };
        const usedKeys: string[] = [];
        const failure = Object.assign(new Error('server failure'), { status: 503 });
        const provider = createTestProvider({
            async handleRequest(_model, config) {
                usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                throw failure;
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: false, maxAttempts: 0, initialDelayMs: 0, maxDelayMs: 0 });
        const cancellation = new vscode.CancellationTokenSource();
        try {
            LeaderElectionService.isInitialized = () => true;
            LeaderElectionService.isLeader = () => true;
            LeaderElectionService.isAgentsWindow = () => false;
            LeaderElectionService.getAuthorityTerm = () => 'disabled-retry-leader:1';
            LeaderElectionService.getOwnedAuthorityTerm = () => 'disabled-retry-leader:1';
            for (const request of [1, 2, 3]) {
                await assert.rejects(
                    provider.executeModelRequest(
                        model,
                        { ...modelConfig, provider: slot },
                        [],
                        {
                            modelOptions: { requestKind: 'main-agent' }
                        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                        createProgress([]),
                        '',
                        `session-disabled-retry-${request}`,
                        cancellation.token,
                        slot
                    ),
                    error => error === failure
                );
                assert.equal(ConfigSetStore.getActiveId(slot), request < 3 ? 'a' : 'b');
                assert.equal(usedKeys.length, request);
            }
            assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a']);
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
        } finally {
            Object.assign(LeaderElectionService, originalElection);
            cancellation.dispose();
        }
    });

    test('continues failover for server failures after a rate-limit switch', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-budget-later-server-failure';
        await ConfigSetStore.add(slot, { id: 'a', label: 'a' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'b' }, 'key-b');
        await applyConfigSet(slot, { id: 'a', label: 'a' });
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config) {
                usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                if (usedKeys.length <= 3) {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                throw Object.assign(new Error('service unavailable'), { status: 503 });
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 });
        const cancellation = new vscode.CancellationTokenSource();
        try {
            await assert.rejects(
                provider.executeModelRequest(
                    model,
                    { ...modelConfig, provider: slot },
                    [],
                    {
                        modelOptions: { requestKind: 'main-agent' }
                    } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                    createProgress([]),
                    '',
                    'session-later-server-failure',
                    cancellation.token,
                    slot
                ),
                /service unavailable/
            );
            assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b', 'key-b', 'key-b', 'key-a']);
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        } finally {
            cancellation.dispose();
        }
    });

    test('extends retry budget to complete the configured failover threshold', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-retry-budget';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.add(slot, { id: 'duplicate', label: 'Duplicate B' }, 'key-b');
        await ConfigSetStore.add(slot, { id: 'empty', label: 'Empty key' }, '');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config) {
                usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                throw Object.assign(new Error('rate limited'), { status: 429 });
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 });

        await assert.rejects(() =>
            provider.executeModelRequest(
                model,
                { ...modelConfig, provider: slot },
                [],
                {
                    modelOptions: { requestKind: 'main-agent' }
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                createProgress([]),
                '',
                'session-failover-retry-budget',
                new vscode.CancellationTokenSource().token,
                slot,
                Date.now()
            )
        );

        assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b', 'key-b', 'key-b', 'key-a']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('counts mixed server, network, and rate-limit failures toward the same threshold', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-mixed-errors';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        let attempts = 0;
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config) {
                attempts += 1;
                usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                if (attempts === 1) {
                    throw Object.assign(new Error('temporary server failure'), { status: 503 });
                }
                if (attempts === 2) {
                    throw Object.assign(new Error('socket terminated'), { code: 'ECONNRESET' });
                }
                throw Object.assign(new Error('rate limited'), { status: 429 });
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 });

        await assert.rejects(() =>
            provider.executeModelRequest(
                model,
                { ...modelConfig, provider: slot },
                [],
                {
                    modelOptions: { requestKind: 'main-agent' }
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                createProgress([]),
                '',
                'session-failover-mixed-errors',
                new vscode.CancellationTokenSource().token,
                slot,
                Date.now()
            )
        );

        assert.equal(attempts, 7);
        assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b', 'key-b', 'key-b', 'key-a']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('resets failover counting after switching to a new configuration', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-reset-after-switch';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.add(slot, { id: 'c', label: 'Account C' }, 'key-c');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const keyAttempts = new Map<string, number>();
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress) {
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                usedKeys.push(apiKey ?? '');
                const count = (keyAttempts.get(apiKey ?? '') ?? 0) + 1;
                keyAttempts.set(apiKey ?? '', count);
                if (apiKey === 'key-a' || (apiKey === 'key-b' && count === 1)) {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 5, initialDelayMs: 0, maxDelayMs: 0 });

        await provider.executeModelRequest(
            model,
            { ...modelConfig, provider: slot },
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress([]),
            '',
            'session-failover-reset-after-switch',
            new vscode.CancellationTokenSource().token,
            slot,
            Date.now()
        );

        assert.deepEqual(usedKeys, ['key-a', 'key-a', 'key-a', 'key-b', 'key-b']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
    });

    test('allows a full key rotation and stops after retrying the initial key again', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-full-rotation';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.add(slot, { id: 'c', label: 'Account C' }, 'key-c');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config) {
                usedKeys.push((await ApiKeyManager.getApiKeyForRequest(slot, config)) ?? '');
                throw Object.assign(new Error('rate limited'), { status: 429 });
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 20, initialDelayMs: 0, maxDelayMs: 0 });

        await assert.rejects(() =>
            provider.executeModelRequest(
                model,
                { ...modelConfig, provider: slot },
                [],
                {
                    modelOptions: { requestKind: 'main-agent' }
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                createProgress([]),
                '',
                'session-failover-full-rotation',
                new vscode.CancellationTokenSource().token,
                slot,
                Date.now()
            )
        );

        assert.deepEqual(usedKeys, [
            'key-a',
            'key-a',
            'key-a',
            'key-b',
            'key-b',
            'key-b',
            'key-c',
            'key-c',
            'key-c',
            'key-a'
        ]);
        assert.equal(ConfigSetStore.getActiveId(slot), 'a');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
    });

    test('captures the active configuration after rate-limit waiting completes', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-rate-limit-wait';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.add(slot, { id: 'c', label: 'Account C' }, 'key-c');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        let releaseWait: (() => void) | undefined;
        let reportWaiting: (() => void) | undefined;
        const waiting = new Promise<void>(resolve => {
            reportWaiting = resolve;
        });
        const waitGate = new Promise<void>(resolve => {
            releaseWait = resolve;
        });
        let firstAcquire = true;
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress) {
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                usedKeys.push(apiKey ?? '');
                if (apiKey === 'key-b') {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.acquireRateLimit = async () => {
            if (firstAcquire) {
                firstAcquire = false;
                reportWaiting?.();
                await waitGate;
            }
            return undefined;
        };
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 4, initialDelayMs: 0, maxDelayMs: 0 });

        const request = provider.executeModelRequest(
            model,
            { ...modelConfig, provider: slot },
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress([]),
            '',
            'session-failover-rate-limit-wait',
            new vscode.CancellationTokenSource().token,
            slot,
            Date.now()
        );

        await waiting;
        await ConfigSetStore.setActive(slot, 'b');
        await ApiKeyManager.setApiKey(slot, 'key-b');
        releaseWait?.();
        await request;

        assert.deepEqual(usedKeys, ['key-b', 'key-b', 'key-b', 'key-c']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'c');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-c');
    });

    test('uses the captured API key when the active configuration changes before dispatch', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-dispatch-snapshot';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        let firstAttempt = true;
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress) {
                if (firstAttempt) {
                    firstAttempt = false;
                    await ConfigSetStore.setActive(slot, 'b');
                    await ApiKeyManager.setApiKey(slot, 'key-b');
                }
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                usedKeys.push(apiKey ?? '');
                if (apiKey === 'key-a') {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 });

        await provider.executeModelRequest(
            model,
            { ...modelConfig, provider: slot },
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress([]),
            '',
            'session-failover-dispatch-snapshot',
            new vscode.CancellationTokenSource().token,
            slot,
            Date.now()
        );

        assert.deepEqual(usedKeys, ['key-a', 'key-b']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
    });

    test('preserves the captured API key in the Responses API branch', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-responses-snapshot';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        let firstAttempt = true;
        const usedKeys: string[] = [];
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress) {
                if (firstAttempt) {
                    firstAttempt = false;
                    await ConfigSetStore.setActive(slot, 'b');
                    await ApiKeyManager.setApiKey(slot, 'key-b');
                }
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                usedKeys.push(apiKey ?? '');
                if (apiKey === 'key-a') {
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 });

        await provider.executeModelRequest(
            model,
            { ...modelConfig, provider: slot, sdkMode: 'openai-responses' },
            [],
            {
                modelOptions: { requestKind: 'main-agent' }
            } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
            createProgress([]),
            '',
            'session-failover-responses-snapshot',
            new vscode.CancellationTokenSource().token,
            slot,
            Date.now()
        );

        assert.deepEqual(usedKeys, ['key-a', 'key-b']);
        assert.equal(ConfigSetStore.getActiveId(slot), 'b');
        assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
    });

    test('keeps failover counting isolated per request instead of aggregating concurrent failures', async () => {
        const context = createFailoverContext();
        ApiKeyManager.initialize(context);
        ConfigSetStore.initialize(context);
        const slot = 'test-failover-isolation';
        await ConfigSetStore.add(slot, { id: 'a', label: 'Account A' }, 'key-a');
        await ConfigSetStore.add(slot, { id: 'b', label: 'Account B' }, 'key-b');
        await ConfigSetStore.setActive(slot, 'a');
        await ApiKeyManager.setApiKey(slot, 'key-a');
        await ConfigSetStore.setAutoSwitchEnabled(slot, true);

        let releaseGate: (() => void) | undefined;
        const gate = new Promise<void>(resolve => {
            releaseGate = resolve;
        });
        let notifyThirdAttemptsReady: (() => void) | undefined;
        const thirdAttemptsReady = new Promise<boolean>(resolve => {
            notifyThirdAttemptsReady = () => resolve(true);
        });
        const usedKeys = new Map<string, string[]>();
        let waitingRequests = 0;
        const provider = createTestProvider({
            async handleRequest(_model, config, _messages, _options, progress, _requestId, sessionId) {
                const apiKey = await ApiKeyManager.getApiKeyForRequest(slot, config);
                const requestKeys = usedKeys.get(sessionId) ?? [];
                requestKeys.push(apiKey ?? '');
                usedKeys.set(sessionId, requestKeys);
                if (apiKey === 'key-a') {
                    if (requestKeys.length === 3) {
                        waitingRequests += 1;
                        if (waitingRequests === 2) {
                            notifyThirdAttemptsReady?.();
                        }
                        await gate;
                    }
                    throw Object.assign(new Error('rate limited'), { status: 429 });
                }
                progress.report(new vscode.LanguageModelTextPart('recovered'));
            }
        });
        provider.getRequestRetryConfig = () => ({ enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 });

        const runRequest = async (sessionId: string): Promise<void> =>
            provider.executeModelRequest(
                model,
                { ...modelConfig, provider: slot },
                [],
                {
                    modelOptions: { requestKind: 'main-agent' }
                } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
                createProgress([]),
                '',
                sessionId,
                new vscode.CancellationTokenSource().token,
                slot,
                Date.now()
            );

        const [first, second] = [runRequest('session-a'), runRequest('session-b')];
        const completedRequests = Promise.allSettled([first, second]);
        try {
            assert.equal(
                await Promise.race([
                    thirdAttemptsReady,
                    first.then(
                        () => false,
                        () => false
                    ),
                    second.then(
                        () => false,
                        () => false
                    )
                ]),
                true
            );
            assert.equal(ConfigSetStore.getActiveId(slot), 'a');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-a');
            releaseGate?.();
            const results = await completedRequests;
            assert.equal(
                results.every(result => result.status === 'fulfilled'),
                true
            );
            assert.deepEqual(usedKeys.get('session-a'), ['key-a', 'key-a', 'key-a', 'key-b']);
            assert.deepEqual(usedKeys.get('session-b'), ['key-a', 'key-a', 'key-a', 'key-b']);
            assert.equal(ConfigSetStore.getActiveId(slot), 'b');
            assert.equal(await ApiKeyManager.getApiKey(slot), 'key-b');
        } finally {
            releaseGate?.();
            await completedRequests;
        }
    });
});
