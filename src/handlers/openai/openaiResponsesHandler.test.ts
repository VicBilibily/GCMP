import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { ResponsesConnectionPool } from './transport/responsesConnectionPool';
import type { ResponsesConnectionLease } from './transport/responsesConnectionPool';
import type { ResponsesWebSocketOptions } from './transport/responsesWebSocketTransport';
import type { ResolvedOpenAIConnectionParameters } from './transport/clientFactory';
import type { ResponsesRequestScope } from './openaiResponsesHandler';
import type { ModelConfig } from '../../types/sharedTypes';
import { createOpenCodeHeaders } from '../../utils/text/formatUtils';
import { setScopedRequestClassification } from '../classification/requestClassification';
import type { RequestClassification } from '../classification/requestClassification';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: {
        require: (id: string) => unknown;
    };
};

const loggerInfoCalls: string[] = [];
const updateActualTokensCalls: Array<Record<string, unknown>> = [];
const consumedStreams: unknown[] = [];
const reportUsageCalls: Array<{ usage?: unknown; costNanoAiu?: unknown }> = [];
const flushAllCalls: Array<{ finishReason?: unknown; customStatefulData?: unknown; finalUsage?: unknown }> = [];
const reporterOptions: Array<{ requestStartTime?: number }> = [];
const builtModelConfigs: ModelConfig[] = [];

class MockStreamReporter {
    hasContent = true;

    constructor(options: { requestStartTime?: number }) {
        reporterOptions.push(options);
    }

    reportUsage(usage?: unknown, costNanoAiu?: unknown): void {
        if (usage === undefined && costNanoAiu === undefined) {
            return;
        }
        reportUsageCalls.push({ usage, costNanoAiu });
    }

    flushAll(finishReason?: unknown, customStatefulData?: unknown, finalUsage?: unknown): boolean {
        flushAllCalls.push({ finishReason, customStatefulData, finalUsage });
        return true;
    }

    getMetricStreamStartTime(): number | undefined {
        return undefined;
    }

    finishMetrics(): void {}
}

class MockOpenAIResponsesMessageConverter {
    constructor(_handler: unknown, _displayName: string) {}
}

class MockOpenAIResponsesRequestBuilder {
    constructor(_displayName: string, _messageConverter: unknown, _providerKey: string) {}

    build(params: { modelConfig: ModelConfig }): { requestBody: Record<string, unknown> } {
        builtModelConfigs.push(params.modelConfig);
        return { requestBody: { model: 'test-model', input: [] } };
    }
}

class MockOpenAIResponsesStreamProcessor {
    private finalUsage: { total_tokens: number } | undefined = { total_tokens: 12 };
    private finalized = false;

    constructor(_options: unknown) {}

    attach(): void {}

    async consume(stream: unknown): Promise<void> {
        consumedStreams.push(stream);
        this.finalUsage = (stream as { noUsage?: boolean }).noUsage ? undefined : { total_tokens: 12 };
        this.finalized = (stream as { responseFinalized?: boolean }).responseFinalized === true;
        if ((stream as { failure?: Error }).failure) {
            throw (stream as { failure: Error }).failure;
        }
        if ((stream as { shouldFail?: boolean }).shouldFail) {
            throw new Error('stream failed');
        }
    }

    getFinalUsage(): { total_tokens: number } | undefined {
        return this.finalUsage;
    }

    getFinishReason(): string {
        return 'length';
    }

    getStreamStartTime(): number {
        return 100;
    }

    getStreamEndTime(): number {
        return 200;
    }

    isResponseFinalized(): boolean {
        return this.finalized;
    }
}

let openAIResponsesHandlerModulePromise:
    | Promise<{
          OpenAIResponsesHandler: typeof import('./openaiResponsesHandler').OpenAIResponsesHandler;
      }>
    | undefined;

async function getOpenAIResponsesHandlerModule() {
    if (openAIResponsesHandlerModulePromise) {
        return openAIResponsesHandlerModulePromise;
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                env: { language: 'en' },
                CancellationError: class CancellationError extends Error {},
                LanguageModelError: class LanguageModelError extends Error {}
            };
        }
        if (id === '../streamReporter') {
            return { StreamReporter: MockStreamReporter };
        }
        if (id === './openaiResponsesMessageConverter') {
            return { OpenAIResponsesMessageConverter: MockOpenAIResponsesMessageConverter };
        }
        if (id === './openaiResponsesRequestBuilder') {
            return { OpenAIResponsesRequestBuilder: MockOpenAIResponsesRequestBuilder };
        }
        if (id === './openaiResponsesStreamProcessor') {
            return { OpenAIResponsesStreamProcessor: MockOpenAIResponsesStreamProcessor };
        }
        if (id === '../../usages/usagesManager') {
            return {
                TokenUsagesManager: {
                    instance: {
                        updateActualTokens(params: Record<string, unknown>) {
                            updateActualTokensCalls.push(params);
                        }
                    }
                }
            };
        }
        if (id === '../../utils/runtime/logger') {
            return {
                Logger: {
                    info(message: string) {
                        loggerInfoCalls.push(message);
                    },
                    debug() {},
                    error() {},
                    warn() {}
                }
            };
        }
        if (id === '../../utils/text/cancellationError') {
            return { isCancellationError: () => false };
        }
        if (id === '../../utils/text/formatUtils') {
            return { createOpenCodeHeaders };
        }
        if (id === '../../cli/auth/cliAuthFactory') {
            return { CliAuthFactory: { getInstance: () => ({ getAccountId: async () => ' synthetic-account ' }) } };
        }
        if (id === '../../cli/auth/codexCliAuth') {
            return { CodexCliAuth: class CodexCliAuth {} };
        }
        if (id === '../liveMetrics') {
            return { emitLiveMetrics() {} };
        }
        if (id === './openaiHandler') {
            return { OpenAIHandler: class OpenAIHandler {} };
        }
        return originalRequire.call(this, id);
    };

    openAIResponsesHandlerModulePromise = import('./openaiResponsesHandler').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });

    return openAIResponsesHandlerModulePromise;
}

async function createHandshakeFixture(providerKey: string, release: () => void | Promise<void> = () => {}) {
    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const pool = new ResponsesConnectionPool();
    const handshakes: ResponsesWebSocketOptions[] = [];
    const handler = new OpenAIResponsesHandler(
        { provider: providerKey, providerConfig: { displayName: 'Header test' } } as never,
        {
            createOpenAIClient: async () => {
                throw new Error('Unexpected HTTP client');
            }
        },
        {
            pool,
            dispatcher: () => ({
                dispatcher: {} as ResponsesWebSocketOptions['dispatcher'],
                fingerprint: 'test',
                release
            }),
            socket: options => {
                handshakes.push(options);
                let reusable = true;
                let resolveClosed!: () => void;
                const closed = new Promise<void>(resolve => {
                    resolveClosed = resolve;
                });
                const listeners = new Set<() => void>();
                return {
                    opened: Promise.resolve(),
                    closed,
                    get reusable() {
                        return reusable;
                    },
                    send() {},
                    onMessage: () => () => {},
                    onDisconnect: listener => {
                        listeners.add(listener);
                        return () => {
                            listeners.delete(listener);
                        };
                    },
                    close() {
                        if (reusable) {
                            reusable = false;
                            for (const listener of listeners) {
                                listener();
                            }
                            resolveClosed();
                        }
                        return closed;
                    }
                };
            }
        }
    );
    const internal = handler as unknown as {
        acquireWebSocket(
            model: { id: string },
            modelConfig: ModelConfig,
            sessionId: string,
            parameters: ResolvedOpenAIConnectionParameters,
            endpoint: URL,
            scope: ResponsesRequestScope,
            signal: AbortSignal,
            requestId: string
        ): Promise<ResponsesConnectionLease | undefined>;
        configureClientHeaders(client: unknown, requestId: string, sessionId: string): Promise<void>;
    };
    return {
        handler,
        pool,
        handshakes,
        internal,
        acquire: (requestId: string, endpoint = 'http://127.0.0.1/responses') =>
            internal.acquireWebSocket(
                { id: 'test-model' },
                {
                    id: 'test-model',
                    name: 'Test',
                    provider: providerKey,
                    tooltip: 'Test',
                    maxInputTokens: 1024,
                    maxOutputTokens: 128,
                    capabilities: { toolCalling: true, imageInput: false }
                },
                'test-session',
                {
                    apiKey: 'synthetic-key',
                    baseURL: undefined,
                    defaultHeaders: { 'X-Custom': 'retained' },
                    proxyUrl: 'noproxy'
                },
                new URL(endpoint),
                { origin: 'sdk', purpose: 'chat', branchId: 'main' },
                new AbortController().signal,
                requestId
            )
    };
}

for (const [endpoint, expectedUrl] of [
    ['http://gateway.invalid:8080/v1/responses?mode=stream', 'ws://gateway.invalid:8080/v1/responses?mode=stream'],
    ['http://192.0.2.10:8080/responses', 'ws://192.0.2.10:8080/responses'],
    ['http://[2001:db8::1]:8080/responses', 'ws://[2001:db8::1]:8080/responses'],
    ['http://127.0.0.1:8080/responses', 'ws://127.0.0.1:8080/responses'],
    ['http://localhost:8080/responses', 'ws://localhost:8080/responses'],
    ['http://[::1]:8080/responses', 'ws://[::1]:8080/responses'],
    ['https://gateway.invalid:8443/v1/responses?mode=stream', 'wss://gateway.invalid:8443/v1/responses?mode=stream'],
    ['https://127.0.0.1:8443/responses', 'wss://127.0.0.1:8443/responses']
]) {
    test(`WS-LOOP-06: endpoint ${endpoint} preserves WebSocket security scheme`, async () => {
        const fixture = await createHandshakeFixture('compatible');
        try {
            const lease = await fixture.acquire('request', endpoint);
            assert.ok(lease);
            assert.equal(fixture.handshakes.length, 1);
            assert.equal(fixture.handshakes[0].url, expectedUrl);
            assert.equal(fixture.handshakes[0].headers.authorization, 'Bearer synthetic-key');
            lease.release(true);
        } finally {
            await fixture.handler.dispose();
            await fixture.pool.dispose();
        }
    });
}

for (const endpoint of ['ftp://gateway.invalid/responses', 'file:///responses', 'data:text/plain,responses']) {
    test(`WS-LOOP-06: unsupported endpoint ${endpoint} is rejected before handshake`, async () => {
        const fixture = await createHandshakeFixture('compatible');
        try {
            await assert.rejects(fixture.acquire('request', endpoint), /Responses WebSocket requires/);
            assert.equal(fixture.handshakes.length, 0);
            assert.deepEqual(fixture.pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
        } finally {
            await fixture.handler.dispose();
            await fixture.pool.dispose();
        }
    });
}

test('WS-LOOP-15: provider disposal waits for its dispatcher and retains capacity', async () => {
    let finishRelease!: () => void;
    let releaseStarted = false;
    let disposed = false;
    const pending = new Promise<void>(resolve => {
        finishRelease = resolve;
    });
    const fixture = await createHandshakeFixture('codex', async () => {
        releaseStarted = true;
        await pending;
    });
    let cleanup: Promise<void> | undefined;
    try {
        (await fixture.acquire('request'))?.release(true);
        cleanup = fixture.handler.dispose().then(() => {
            disposed = true;
        });
        await nextTurn();
        assert.equal(releaseStarted, true);
        assert.equal(disposed, false);
        assert.equal(fixture.pool.diagnostics().connections, 1);
        finishRelease();
        await cleanup;
        assert.deepEqual(fixture.pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
    } finally {
        finishRelease();
        await cleanup;
        await fixture.handler.dispose();
        await fixture.pool.dispose();
    }
});

test('WS-LOOP-15: provider disposal reports dispatcher failure without losing registration', async () => {
    const failure = new Error('dispatcher cleanup failed');
    let releases = 0;
    const fixture = await createHandshakeFixture('codex', () => {
        releases++;
        return Promise.reject(failure);
    });
    try {
        (await fixture.acquire('request'))?.release(true);
        const cleanup = fixture.handler.dispose();
        assert.equal(fixture.handler.dispose(), cleanup);
        await assert.rejects(
            cleanup,
            (error: unknown) => error instanceof AggregateError && error.errors.includes(failure)
        );
        assert.equal(releases, 1);
        assert.equal(fixture.pool.diagnostics().connections, 1);
    } finally {
        await fixture.handler.dispose().catch(() => undefined);
        await fixture.pool.dispose().catch(() => undefined);
    }
});

for (const providerKey of ['codex', 'opencode']) {
    test(`WS-LOOP-06: ${providerKey} handshake preserves HTTP provider headers and binding`, async () => {
        const fixture = await createHandshakeFixture(providerKey);
        try {
            const client = { _options: { defaultHeaders: {} as Record<string, string> } };
            await fixture.internal.configureClientHeaders(client, 'request-one', 'test-session');
            const first = await fixture.acquire('request-one');
            assert.ok(first);
            for (const [name, value] of Object.entries(client._options.defaultHeaders)) {
                assert.equal(fixture.handshakes[0].headers[name], value, name);
            }
            assert.equal(fixture.handshakes[0].headers['x-custom'], 'retained');
            first.release(true);
            const second = await fixture.acquire('request-two');
            assert.ok(second);
            if (providerKey === 'codex') {
                assert.equal(second.connection, first.connection);
                assert.equal(fixture.handshakes.length, 1);
            } else {
                assert.notEqual(second.connection, first.connection);
                assert.equal(
                    fixture.handshakes[1].headers['x-opencode-request'],
                    createOpenCodeHeaders('request-two', 'test-session')['x-opencode-request']
                );
            }
            second.release(true);
        } finally {
            await fixture.handler.dispose();
            await fixture.pool.dispose();
        }
    });
}

for (const variant of ['missing-resolver', 'resolver-failure'] as const) {
    test(`WS-LOOP-01: explicit WS ${variant} never creates an HTTP client`, async () => {
        const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
        const options = { modelConfiguration: {} };
        setScopedRequestClassification(options, {
            version: 1,
            requestOrigin: 'copilot-sdk',
            requestKind: 'main-agent',
            agentRole: 'main',
            evidence: {
                origin: { level: 'signature' },
                purpose: { level: 'signature' },
                role: { level: 'signature' }
            }
        });
        let httpClients = 0;
        let cancellations = 0;
        const pool = new ResponsesConnectionPool();
        const handler = new OpenAIResponsesHandler(
            { provider: 'openai', providerConfig: { displayName: 'Strict WS test' } } as never,
            {
                async createOpenAIClient() {
                    httpClients++;
                    throw new Error('Unexpected HTTP client');
                },
                ...(variant === 'resolver-failure' ?
                    {
                        async resolveConnectionParameters(): Promise<ResolvedOpenAIConnectionParameters> {
                            throw new Error('Connection parameter lookup failed');
                        }
                    }
                :   {})
            },
            { pool }
        );
        try {
            await assert.rejects(
                handler.handleResponsesRequest(
                    { id: 'model-id', name: 'test-model' } as never,
                    { sdkMode: 'openai-responses', useWebSocket: true } as never,
                    [],
                    options as never,
                    { report() {} },
                    'request-1',
                    'session-1',
                    {
                        isCancellationRequested: false,
                        onCancellationRequested() {
                            cancellations++;
                            return { dispose: () => cancellations-- };
                        }
                    }
                ),
                variant === 'missing-resolver' ?
                    /Responses WebSocket connection parameters are unavailable/
                :   /Connection parameter lookup failed/
            );
            assert.equal(httpClients, 0);
            assert.equal(cancellations, 0);
            assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
        } finally {
            await handler.dispose();
            await pool.dispose();
        }
    });
}

const transportRoutingCases: Array<{
    name: string;
    kind?: RequestClassification['requestKind'];
    role?: RequestClassification['agentRole'];
    level?: 'signature' | 'contract' | 'heuristic' | 'unknown';
    useWebSocket?: boolean;
    expectedWebSocket: boolean;
}> = [
    { name: 'main agent', kind: 'main-agent', role: 'main', useWebSocket: true, expectedWebSocket: true },
    { name: 'generic subagent', kind: 'subagent', role: 'subagent', useWebSocket: true, expectedWebSocket: true },
    { name: 'search subagent', kind: 'search-subagent', role: 'subagent', useWebSocket: true, expectedWebSocket: true },
    {
        name: 'execution subagent',
        kind: 'execution-subagent',
        role: 'subagent',
        useWebSocket: true,
        expectedWebSocket: true
    },
    {
        name: 'contract agent',
        kind: 'main-agent',
        role: 'main',
        level: 'contract',
        useWebSocket: true,
        expectedWebSocket: true
    },
    { name: 'summary', kind: 'summarization', role: 'not-applicable', useWebSocket: true, expectedWebSocket: false },
    {
        name: 'SDK compaction',
        kind: 'summarization',
        role: 'undetermined',
        level: 'heuristic',
        useWebSocket: true,
        expectedWebSocket: false
    },
    { name: 'title', kind: 'chat-title', role: 'not-applicable', useWebSocket: true, expectedWebSocket: false },
    {
        name: 'patch helper',
        kind: 'patch-healer',
        role: 'not-applicable',
        useWebSocket: true,
        expectedWebSocket: false
    },
    { name: 'terminal helper', kind: 'terminal-steering', role: 'main', useWebSocket: true, expectedWebSocket: false },
    { name: 'unclassified', kind: 'unclassified', role: 'undetermined', useWebSocket: true, expectedWebSocket: false },
    {
        name: 'unverified agent',
        kind: 'main-agent',
        role: 'main',
        level: 'heuristic',
        useWebSocket: true,
        expectedWebSocket: false
    },
    {
        name: 'unknown agent role',
        kind: 'main-agent',
        role: 'undetermined',
        useWebSocket: true,
        expectedWebSocket: false
    },
    { name: 'unscoped options', useWebSocket: true, expectedWebSocket: false },
    { name: 'disabled WS', kind: 'main-agent', role: 'main', useWebSocket: false, expectedWebSocket: false },
    { name: 'default HTTP', kind: 'main-agent', role: 'main', expectedWebSocket: false }
];

for (const scenario of transportRoutingCases) {
    test(`WS-LOOP-01: request routing for ${scenario.name}`, async testContext => {
        const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
        const options = { modelConfiguration: {}, modelOptions: { requestKind: 'main-agent' } };
        if (scenario.kind && scenario.role) {
            setScopedRequestClassification(options, {
                version: 1,
                requestOrigin: 'copilot-sdk',
                requestKind: scenario.kind,
                agentRole: scenario.role,
                evidence: {
                    origin: { level: 'signature' },
                    purpose: { level: scenario.level ?? 'signature' },
                    role: { level: scenario.level ?? 'signature' }
                }
            });
        }
        const modelConfig = Object.freeze({
            sdkMode: 'openai-responses',
            useWebSocket: scenario.useWebSocket,
            extraBody: Object.freeze({ parallel_tool_calls: true })
        });
        const pool = new ResponsesConnectionPool();
        let httpRequests = 0;
        let websocketResolutions = 0;
        let retirements = 0;
        testContext.mock.method(pool, 'retireModel', () => {
            retirements++;
        });
        const handler = new OpenAIResponsesHandler(
            { provider: 'openai', providerConfig: { displayName: 'Routing test' } } as never,
            {
                async createOpenAIClient() {
                    return {
                        _options: { defaultHeaders: {} },
                        responses: {
                            async create() {
                                httpRequests++;
                                return {};
                            }
                        }
                    } as never;
                },
                async resolveConnectionParameters(): Promise<ResolvedOpenAIConnectionParameters> {
                    websocketResolutions++;
                    throw new Error('Expected Agent WebSocket route');
                }
            },
            { pool }
        );
        try {
            const request = handler.handleResponsesRequest(
                { id: 'model-id', name: 'test-model' } as never,
                modelConfig as never,
                [],
                options as never,
                { report() {} },
                'request-routing',
                'session-routing',
                { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
            );
            if (scenario.expectedWebSocket) {
                await assert.rejects(request, /Expected Agent WebSocket route/);
            } else {
                await request;
            }
            assert.equal(httpRequests, scenario.expectedWebSocket ? 0 : 1);
            assert.equal(websocketResolutions, scenario.expectedWebSocket ? 1 : 0);
            assert.equal(builtModelConfigs.at(-1)?.useWebSocket === true, scenario.expectedWebSocket);
            assert.equal(retirements, scenario.useWebSocket === true ? 0 : 1);
            assert.equal(modelConfig.useWebSocket, scenario.useWebSocket);
            assert.equal(modelConfig.extraBody.parallel_tool_calls, true);
        } finally {
            await handler.dispose();
            await pool.dispose();
        }
    });
}

test('WS-LOOP-01: Responses live metrics use the dispatched attempt timestamp', async testContext => {
    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    let now = 1000;
    testContext.mock.method(Date, 'now', () => now++);
    const reporterIndex = reporterOptions.length;
    let dispatchedTime: number | undefined;
    const handler = new OpenAIResponsesHandler(
        { provider: 'openai', providerConfig: { displayName: 'Live metrics test' } } as never,
        {
            async createOpenAIClient() {
                return {
                    _options: { defaultHeaders: {} },
                    responses: {
                        async create() {
                            return {};
                        }
                    }
                };
            }
        } as never
    );
    try {
        await handler.handleResponsesRequest(
            { id: 'model-id', name: 'test-model' } as never,
            { sdkMode: 'openai-responses' } as never,
            [],
            { modelConfiguration: {} } as never,
            { report() {} },
            'request-live-metrics',
            'session-live-metrics',
            {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose() {} })
            },
            123,
            timestamp => {
                dispatchedTime = timestamp;
            }
        );
        assert.equal(typeof dispatchedTime, 'number');
        assert.equal(reporterOptions[reporterIndex]?.requestStartTime, dispatchedTime);
        assert.equal(updateActualTokensCalls.at(-1)?.requestMetricStartTime, dispatchedTime);
    } finally {
        await handler.dispose();
    }
});

test('handleResponsesRequest：透传 length finishReason 到完成链路', async () => {
    loggerInfoCalls.length = 0;
    updateActualTokensCalls.length = 0;
    consumedStreams.length = 0;
    reportUsageCalls.length = 0;
    flushAllCalls.length = 0;

    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const fakeStream = { tag: 'responses-stream' };
    let requestOptions: unknown;
    const client = {
        _options: { defaultHeaders: {} as Record<string, string> },
        responses: {
            async create(_body: unknown, options: unknown) {
                requestOptions = options;
                return fakeStream;
            }
        }
    };
    const handler = new OpenAIResponsesHandler(
        {
            provider: 'openai',
            providerConfig: {
                displayName: 'Test Provider',
                customHeader: { 'X-Provider-Remove': null }
            }
        } as never,
        {
            async createOpenAIClient() {
                return client;
            }
        } as never
    );

    await handler.handleResponsesRequest(
        { id: 'model-id', name: 'test-model' } as never,
        { customHeader: { 'X-Model-Remove': null } } as never,
        [] as never,
        { modelConfiguration: {} } as never,
        { report() {} } as never,
        'request-1',
        'session-1',
        {
            isCancellationRequested: false,
            onCancellationRequested() {
                return { dispose() {} };
            }
        } as never,
        123
    );

    assert.deepEqual(consumedStreams, [fakeStream]);
    assert.ok((requestOptions as { signal?: unknown })?.signal);
    assert.deepEqual((requestOptions as { headers?: unknown })?.headers, {
        'X-Provider-Remove': null,
        'X-Model-Remove': null
    });
    assert.equal(client._options.defaultHeaders.conversation_id, 'session-1');
    assert.equal(client._options.defaultHeaders.session_id, 'session-1');
    assert.equal(updateActualTokensCalls.length, 1);
    assert.deepEqual(
        {
            ...updateActualTokensCalls[0],
            requestMetricStartTime: undefined
        },
        {
            requestId: 'request-1',
            sessionId: 'session-1',
            rawUsage: { total_tokens: 12 },
            status: 'completed',
            requestMetricStartTime: undefined,
            wasThrottled: false,
            streamStartTime: 100,
            streamEndTime: 200,
            estimatedCost: undefined,
            costBreakdown: undefined
        }
    );
    assert.equal(typeof updateActualTokensCalls[0]?.requestMetricStartTime, 'number');
    assert.ok(loggerInfoCalls.includes('📊 test-model Responses API request completed with finish reason: length'));
});

test('handleResponsesRequest：流处理失败时记录 failed 终态', async () => {
    loggerInfoCalls.length = 0;
    updateActualTokensCalls.length = 0;
    consumedStreams.length = 0;
    reportUsageCalls.length = 0;
    flushAllCalls.length = 0;

    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const fakeStream = { tag: 'responses-stream', shouldFail: true };
    const client = {
        _options: { defaultHeaders: {} as Record<string, string> },
        responses: {
            async create(_body: unknown, _options: unknown) {
                return fakeStream;
            }
        }
    };
    const handler = new OpenAIResponsesHandler(
        {
            provider: 'openai',
            providerConfig: { displayName: 'Test Provider' }
        } as never,
        {
            async createOpenAIClient() {
                return client;
            }
        } as never
    );

    await assert.rejects(
        handler.handleResponsesRequest(
            { id: 'model-id', name: 'test-model' } as never,
            {} as never,
            [] as never,
            { modelConfiguration: {} } as never,
            { report() {} } as never,
            'request-1',
            'session-1',
            {
                isCancellationRequested: false,
                onCancellationRequested() {
                    return { dispose() {} };
                }
            } as never,
            123
        ),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'stream failed');
            assert.equal((error as { gcmpFinalStatusRecorded?: boolean }).gcmpFinalStatusRecorded, true);
            return true;
        }
    );

    assert.deepEqual(consumedStreams, [fakeStream]);
    assert.equal(updateActualTokensCalls.length, 1);
    assert.deepEqual(reportUsageCalls, [{ usage: { total_tokens: 12 }, costNanoAiu: undefined }]);
    assert.deepEqual(flushAllCalls, [
        { finishReason: null, customStatefulData: undefined, finalUsage: { total_tokens: 12 } }
    ]);
    assert.deepEqual(
        {
            ...updateActualTokensCalls[0],
            requestMetricStartTime: undefined
        },
        {
            requestId: 'request-1',
            sessionId: 'session-1',
            rawUsage: { total_tokens: 12 },
            status: 'failed',
            requestMetricStartTime: undefined,
            wasThrottled: false,
            streamStartTime: 100,
            streamEndTime: 200,
            estimatedCost: undefined,
            costBreakdown: undefined
        }
    );
    assert.equal(typeof updateActualTokensCalls[0]?.requestMetricStartTime, 'number');
});

test('handleResponsesRequest：流处理失败且无 usage 时仍记录 failed 终态', async () => {
    loggerInfoCalls.length = 0;
    updateActualTokensCalls.length = 0;
    consumedStreams.length = 0;
    reportUsageCalls.length = 0;
    flushAllCalls.length = 0;

    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const fakeStream = { tag: 'responses-stream', shouldFail: true, noUsage: true };
    const client = {
        _options: { defaultHeaders: {} as Record<string, string> },
        responses: {
            async create(_body: unknown, _options: unknown) {
                return fakeStream;
            }
        }
    };
    const handler = new OpenAIResponsesHandler(
        {
            provider: 'openai',
            providerConfig: { displayName: 'Test Provider' }
        } as never,
        {
            async createOpenAIClient() {
                return client;
            }
        } as never
    );

    await assert.rejects(
        handler.handleResponsesRequest(
            { id: 'model-id', name: 'test-model' } as never,
            {} as never,
            [] as never,
            { modelConfiguration: {} } as never,
            { report() {} } as never,
            'request-1',
            'session-1',
            {
                isCancellationRequested: false,
                onCancellationRequested() {
                    return { dispose() {} };
                }
            } as never,
            123
        ),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, 'stream failed');
            assert.equal((error as { gcmpFinalStatusRecorded?: boolean }).gcmpFinalStatusRecorded, true);
            return true;
        }
    );

    assert.deepEqual(consumedStreams, [fakeStream]);
    assert.equal(updateActualTokensCalls.length, 1);
    assert.deepEqual(reportUsageCalls, []);
    assert.deepEqual(flushAllCalls, [{ finishReason: null, customStatefulData: undefined, finalUsage: undefined }]);
    assert.deepEqual(
        {
            ...updateActualTokensCalls[0],
            requestMetricStartTime: undefined
        },
        {
            requestId: 'request-1',
            sessionId: 'session-1',
            rawUsage: undefined,
            status: 'failed',
            requestMetricStartTime: undefined,
            wasThrottled: false,
            streamStartTime: 100,
            streamEndTime: 200,
            estimatedCost: undefined,
            costBreakdown: undefined
        }
    );
    assert.equal(typeof updateActualTokensCalls[0]?.requestMetricStartTime, 'number');
});

test('handleResponsesRequest：processor 已收口时不重复 flush reporter', async () => {
    loggerInfoCalls.length = 0;
    updateActualTokensCalls.length = 0;
    consumedStreams.length = 0;
    reportUsageCalls.length = 0;
    flushAllCalls.length = 0;

    const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
    const fakeStream = { tag: 'responses-stream', shouldFail: true, responseFinalized: true };
    const client = {
        _options: { defaultHeaders: {} as Record<string, string> },
        responses: {
            async create(_body: unknown, _options: unknown) {
                return fakeStream;
            }
        }
    };
    const handler = new OpenAIResponsesHandler(
        {
            provider: 'openai',
            providerConfig: { displayName: 'Test Provider' }
        } as never,
        {
            async createOpenAIClient() {
                return client;
            }
        } as never
    );

    await assert.rejects(
        handler.handleResponsesRequest(
            { id: 'model-id', name: 'test-model' } as never,
            {} as never,
            [] as never,
            { modelConfiguration: {} } as never,
            { report() {} } as never,
            'request-1',
            'session-1',
            {
                isCancellationRequested: false,
                onCancellationRequested() {
                    return { dispose() {} };
                }
            } as never,
            123
        ),
        /stream failed/
    );

    assert.deepEqual(flushAllCalls, []);
});

for (const message of ['terminated', 'Bad Gateway']) {
    test(`Responses preserves the original ${message} error and its final-status marker`, async () => {
        updateActualTokensCalls.length = 0;
        const { OpenAIResponsesHandler } = await getOpenAIResponsesHandlerModule();
        const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
        const failure = new TypeError(message, { cause });
        let disposals = 0;
        const handler = new OpenAIResponsesHandler(
            { provider: 'openai', providerConfig: { displayName: 'Test Provider' } } as never,
            {
                async createOpenAIClient() {
                    return {
                        _options: { defaultHeaders: {} },
                        responses: { create: async () => ({ failure }) }
                    };
                }
            } as never
        );
        await assert.rejects(
            handler.handleResponsesRequest(
                { id: 'model-id', name: 'test-model' } as never,
                {} as never,
                [],
                { modelConfiguration: {} } as never,
                { report() {} },
                'error-chain-request',
                'error-chain-session',
                {
                    isCancellationRequested: false,
                    onCancellationRequested: () => ({ dispose: () => disposals++ })
                } as never
            ),
            error => {
                assert.equal(error, failure);
                assert.equal(failure.cause, cause);
                assert.equal((error as { gcmpFinalStatusRecorded?: boolean }).gcmpFinalStatusRecorded, true);
                return true;
            }
        );
        assert.equal(disposals, 1);
        assert.equal(updateActualTokensCalls.length, 1);
        assert.equal(updateActualTokensCalls[0].status, 'failed');
    });
}
