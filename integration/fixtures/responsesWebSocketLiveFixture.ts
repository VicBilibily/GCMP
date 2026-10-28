import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Agent, ProxyAgent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { ResponsesConnectionPool } from '../../src/handlers/openai/transport/responsesConnectionPool';
import { ResponsesWebSocketTransport } from '../../src/handlers/openai/transport/responsesWebSocketTransport';
import { isStatefulMarkerMimeType } from '../../src/handlers/types';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { TokenUsagesManager } from '../../src/usages/usagesManager';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ConfigSetStore } from '../../src/utils/config/configSetStore';
import { HarRecorder } from '../../src/utils/net/harRecorder';
import { Logger } from '../../src/utils/runtime/logger';
import { closeProxyAgents, leaseProxyDispatcher } from '../../src/utils/net/proxyAgent';
import { SDK_MAIN } from '../../src/handlers/classification/testFixtures/sdkPurposeSamples';
import { createContext, trackedCancellation } from '../suite/balance/retryFixture';
import { startResponsesMockProcess } from './responsesWebSocketMockProcess';
import type { MockExpectations, MockFunctionTool, MockNetwork, MockScenario } from './responsesWebSocketMockProcess';

const slot = 'responses-live-e2e';

class LiveProvider extends GenericModelProvider {
    grants = 0;
    constructor(
        context: vscode.ExtensionContext,
        config: ModelConfig,
        services: NonNullable<ConstructorParameters<typeof GenericModelProvider>[3]>,
        private readonly retryEnabled: boolean,
        private readonly retryAttempts: number
    ) {
        super(
            context,
            slot,
            { displayName: 'Live E2E', baseUrl: config.baseUrl!, apiKeyTemplate: 'synthetic', models: [config] },
            services
        );
    }
    protected override async acquireRateLimit() {
        this.grants++;
        return undefined;
    }
    protected override getRequestRetryConfig() {
        return { enabled: this.retryEnabled, maxAttempts: this.retryAttempts, initialDelayMs: 0, maxDelayMs: 0 };
    }
}

interface HarProbe {
    log: { entries: Array<{ request: { url: string; postData?: { text: string } }; response: { status: number } }> };
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function harProbe(value: unknown): value is HarProbe {
    return (
        object(value) &&
        object(value.log) &&
        Array.isArray(value.log.entries) &&
        value.log.entries.every(
            entry =>
                object(entry) &&
                object(entry.request) &&
                typeof entry.request.url === 'string' &&
                object(entry.response) &&
                typeof entry.response.status === 'number'
        )
    );
}

export interface LiveResponsesOptions {
    delta?: boolean;
    useInstructions?: boolean;
    contexts?: MockExpectations['contexts'];
    httpResponseText?: string;
    responseText?: string;
    poolIdleMs?: number;
    requestMs?: number;
    eventMs?: number;
    retryEnabled?: boolean;
    retryAttempts?: number;
    network?: MockNetwork;
    proxy?: 'direct' | 'configured' | 'system';
    trusted?: boolean;
    proxyTrusted?: boolean;
    productionRouting?: boolean;
    environment?: 'proxy' | 'no-proxy';
}

export async function createLiveResponsesFixture(scenario: MockScenario, options: LiveResponsesOptions = {}) {
    const runDirectory = process.env.GCMP_WS_HOST_RUN_DIR;
    if (!runDirectory) {
        throw new Error('Live E2E logs require the PowerShell Host entry');
    }
    const storage = await mkdtemp(join(runDirectory, 'live-'));
    const wrappedCustom = scenario === 'custom-wrapped-full' || scenario === 'custom-wrapped-delta';
    const reasoningReplay =
        scenario === 'reasoning-replay' ||
        scenario === 'reasoning-omitted' ||
        scenario === 'parallel-done-empty' ||
        scenario === 'parallel-done-reasoning';
    const toolName = wrappedCustom ? 'raw' : 'lookup';
    const toolSchema: MockFunctionTool['parameters'] =
        wrappedCustom ?
            {
                type: 'object' as const,
                properties: { input: { type: 'string' as const } },
                required: ['input']
            }
        :   {
                type: 'object' as const,
                properties: {
                    key: { type: 'string' as const },
                    ...(reasoningReplay ? { limit: { type: 'number' as const } } : {})
                },
                required: ['key'],
                additionalProperties: false
            };
    const mock = await startResponsesMockProcess(
        scenario,
        {
            instructions: SDK_MAIN.trim(),
            contexts: options.contexts,
            httpResponseText: options.httpResponseText,
            responseText: options.responseText,
            tools: [
                {
                    type: 'function',
                    name: toolName,
                    description: toolName,
                    strict: false,
                    parameters: toolSchema
                }
            ]
        },
        options.network
    );
    const context = createContext();
    ApiKeyManager.initialize(context);
    ConfigSetStore.initialize(context);
    await ConfigSetStore.setSwitchMode(slot, 'off');
    await ApiKeyManager.setApiKey(slot, 'synthetic-mock');
    const manager = TokenUsagesManager.instance;
    const originalRecord = manager.recordEstimatedTokens;
    const originalUpdate = manager.updateActualTokens;
    const originalHydrate = manager.hydrateSessionTitle;
    const originalFetch = ConfigManager.createProxyAwareFetch;
    const originalHarInstance = HarRecorder.getInstance;
    const originalInfo = Logger.info;
    const diagnostics: Array<{ event: string; data: Record<string, unknown> }> = [];
    Logger.info = (message, ...args) => {
        if (
            (message === 'Responses transport selected' || message === 'Responses checkpoint commit') &&
            object(args[0])
        ) {
            diagnostics.push({ event: message, data: args[0] });
        }
        originalInfo.call(Logger, message, ...args);
    };
    const estimates: Parameters<typeof originalRecord>[0][] = [];
    const updates: Parameters<typeof originalUpdate>[0][] = [];
    const owned = new Set<Dispatcher>();
    const aborted = new Set<Dispatcher>();
    const closing = new Map<Dispatcher, Promise<void>>();
    const httpAgents = new Map<string, Dispatcher>();
    const tlsDirectory = process.env.GCMP_WS_TLS_DIR;
    const ca = options.trusted && tlsDirectory ? await readFile(join(tlsDirectory, 'ca.cert.pem')) : undefined;
    const proxyCa =
        options.proxyTrusted && tlsDirectory ? await readFile(join(tlsDirectory, 'ca.cert.pem')) : undefined;
    const createDispatcher = (proxyUrl?: string): Dispatcher => {
        const agent =
            proxyUrl && proxyUrl !== 'noproxy' ?
                new ProxyAgent({
                    uri: proxyUrl,
                    proxyTunnel: true,
                    requestTls: { ca, rejectUnauthorized: true },
                    proxyTls: { ca: proxyCa, rejectUnauthorized: true }
                })
            : options.proxy === 'system' && options.environment && !proxyUrl ?
                new EnvHttpProxyAgent({
                    httpProxy: mock.proxyUrl,
                    httpsProxy: mock.proxyUrl,
                    noProxy: options.environment === 'no-proxy' ? '127.0.0.1' : '',
                    proxyTunnel: true,
                    requestTls: { ca, rejectUnauthorized: true }
                })
            :   new Agent({ connect: { ca, rejectUnauthorized: true } });
        owned.add(agent);
        return agent;
    };
    const environmentKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
    const previousEnvironment = new Map(
        (options.productionRouting && options.environment ? environmentKeys : []).map(key => [key, process.env[key]])
    );
    if (options.productionRouting && options.environment) {
        assert.ok(mock.proxyUrl);
        for (const key of environmentKeys) {
            process.env[key] =
                key.toLowerCase() === 'no_proxy' ?
                    options.environment === 'no-proxy' ?
                        '127.0.0.1'
                    :   ''
                :   mock.proxyUrl;
        }
    }
    if (options.productionRouting) {
        await closeProxyAgents();
    }
    const pool = new ResponsesConnectionPool(undefined, {
        ...(options.requestMs === undefined ? {} : { requestMs: options.requestMs }),
        ...(options.poolIdleMs === undefined ? {} : { idleMs: options.poolIdleMs })
    });
    const connections = new Set<ResponsesWebSocketTransport>();
    const acquire = pool.acquire.bind(pool);
    pool.acquire = async (...args) => {
        const lease = await acquire(...args);
        if (lease?.connection instanceof ResponsesWebSocketTransport) {
            if (options.eventMs !== undefined) {
                lease.connection['limits'].firstMs = options.eventMs;
                lease.connection['limits'].idleMs = options.eventMs;
            }
            connections.add(lease.connection);
        }
        return lease;
    };
    const recorder = new HarRecorder();
    const recordingOptions = {
        enabled: true,
        extensionVersion: 'local-e2e',
        defaultStoragePath: storage,
        retentionCount: 8
    };
    recorder.initialize(recordingOptions);
    const originalWrap = recorder.wrapFetch.bind(recorder);
    let captures = 0;
    let wraps = 0;
    let http = 0;
    let failFast = false;
    let dispatcherLeases = 0;
    recorder.wrapFetch = fetchImpl => {
        wraps++;
        const capture = originalWrap(fetchImpl);
        return async (input, init) => {
            captures++;
            if (failFast) {
                throw new Error('WS attempted HTTP/HAR capture');
            }
            return capture(input, init);
        };
    };
    HarRecorder.getInstance = () => recorder;
    ConfigManager.createProxyAwareFetch = parameters => {
        if (options.productionRouting) {
            const fetch = originalFetch.call(ConfigManager, parameters);
            return async (input, init) => {
                http++;
                return fetch(input, init);
            };
        }
        const proxyUrl = parameters?.proxyUrl;
        return HarRecorder.getInstance().wrapFetch(async (input, init) => {
            const resource = typeof input === 'string' || input instanceof URL ? input : input.url;
            assert.equal(new URL(String(resource)).origin, mock.origin);
            http++;
            const route = proxyUrl ?? 'noproxy';
            let agent = httpAgents.get(route);
            if (!agent) {
                agent = createDispatcher(proxyUrl);
                httpAgents.set(route, agent);
            }
            return (await undiciFetch(resource, {
                ...(init as unknown as UndiciRequestInit),
                dispatcher: agent
            })) as unknown as Response;
        });
    };
    manager.recordEstimatedTokens = async record => {
        estimates.push(record);
        return `live-request-${estimates.length}`;
    };
    manager.updateActualTokens = update => {
        updates.push(update);
    };
    manager.hydrateSessionTitle = async () => undefined;
    const config: ModelConfig = {
        id: 'mock-model',
        name: 'Live model',
        tooltip: 'Live model',
        provider: slot,
        sdkMode: 'openai-responses',
        baseUrl: mock.origin,
        endpoint: '/responses',
        proxy:
            options.proxy === 'system' ? ''
            : options.proxy === 'configured' ? mock.proxyUrl
            : 'noproxy',
        useWebSocket: true,
        useInstructions: 'useInstructions' in options ? options.useInstructions : true,
        extraBody: { store: false, parallel_tool_calls: false },
        maxInputTokens: 128_000,
        maxOutputTokens: 1024,
        capabilities: { toolCalling: true, imageInput: false }
    };
    if (options.proxy === 'configured') {
        assert.ok(mock.proxyUrl);
        if (options.network?.proxy === 'auth') {
            const proxy = new URL(mock.proxyUrl);
            proxy.username = 'fixture';
            proxy.password = 'synthetic-proxy';
            config.proxy = proxy.href;
        }
    }
    const providers: LiveProvider[] = [];
    const makeProvider = (useWebSocket: boolean | undefined) => {
        const provider = new LiveProvider(
            context,
            { ...config, useWebSocket },
            {
                pool,
                allowDelta: options.delta === true ? undefined : false,
                dispatcher: proxyUrl => {
                    dispatcherLeases++;
                    const network =
                        options.productionRouting ?
                            leaseProxyDispatcher(proxyUrl, true)
                        :   {
                                dispatcher: createDispatcher(proxyUrl),
                                fingerprint: `live-route:${proxyUrl ?? 'system'}`,
                                release() {}
                            };
                    owned.add(network.dispatcher);
                    let released = false;
                    return {
                        ...network,
                        abortPending: () => {
                            aborted.add(network.dispatcher);
                            return 'abortPending' in network && network.abortPending ?
                                    network.abortPending()
                                :   network.dispatcher.destroy();
                        },
                        release: () => {
                            if (released) {
                                return closing.get(network.dispatcher);
                            }
                            released = true;
                            dispatcherLeases--;
                            const releaseResult = network.release();
                            const cleanup =
                                options.productionRouting ? Promise.resolve(releaseResult)
                                : aborted.has(network.dispatcher) ? Promise.resolve()
                                : network.dispatcher.close();
                            closing.set(network.dispatcher, cleanup);
                            void cleanup.catch(() => undefined);
                            return cleanup;
                        }
                    };
                }
            },
            options.retryEnabled !== false,
            options.retryAttempts ?? 1
        );
        providers.push(provider);
        return provider;
    };
    const provider = makeProvider(true);
    const cancellations: ReturnType<typeof trackedCancellation>[] = [];
    const active = new Set<Promise<vscode.LanguageModelResponsePart[]>>();
    const controllers = new Set<ReturnType<typeof trackedCancellation>>();
    const begin = (
        history: vscode.LanguageModelChatMessage[],
        turn: number | string | undefined,
        callOptions: {
            provider?: LiveProvider;
            session?: string | false;
            report?: (part: vscode.LanguageModelResponsePart) => void;
        } = {}
    ) => {
        const cancellation = trackedCancellation();
        cancellations.push(cancellation);
        controllers.add(cancellation);
        const parts: vscode.LanguageModelResponsePart[] = [];
        const result = (callOptions.provider ?? provider)
            .provideLanguageModelChatResponse(
                { id: config.id, name: config.name } as vscode.LanguageModelChatInformation,
                history,
                {
                    requestInitiator: 'core',
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                    modelOptions: {
                        ...(callOptions.session === false ?
                            {}
                        :   { _conversationId: callOptions.session ?? 'live-e2e-session' }),
                        _telemetryTurn: turn
                    },
                    tools: [{ name: toolName, description: toolName, inputSchema: toolSchema }]
                },
                {
                    report: part => {
                        parts.push(part);
                        callOptions.report?.(part);
                    }
                },
                cancellation.token
            )
            .then(() => parts);
        active.add(result);
        const complete = () => {
            active.delete(result);
            controllers.delete(cancellation);
            cancellation.dispose();
        };
        void result.then(complete, complete);
        return { result, parts, cancel: () => cancellation.cancel() };
    };
    const harEntries = async () => {
        await recorder.dispose();
        const entries: HarProbe['log']['entries'] = [];
        for (const name of await readdir(join(storage, 'har'))) {
            if (!name.endsWith('.har')) {
                continue;
            }
            const value: unknown = JSON.parse(await readFile(join(storage, 'har', name), 'utf8'));
            assert.ok(harProbe(value));
            entries.push(...value.log.entries);
        }
        return entries;
    };
    return {
        mock,
        provider,
        pool,
        estimates,
        updates,
        diagnostics,
        begin,
        makeProvider,
        configure(changes: Partial<ModelConfig>) {
            Object.assign(config, changes);
            provider.updateRemoteModels([{ ...config }]);
        },
        credential: (alternate: boolean) =>
            ApiKeyManager.setApiKey(slot, alternate ? 'synthetic-mock-B' : 'synthetic-mock'),
        harEntries,
        history: (text: string) => [
            new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.System, SDK_MAIN),
            vscode.LanguageModelChatMessage.User(text)
        ],
        replay: (parts: vscode.LanguageModelResponsePart[]) =>
            parts.filter(
                part =>
                    part instanceof vscode.LanguageModelTextPart ||
                    part instanceof vscode.LanguageModelToolCallPart ||
                    part instanceof vscode.LanguageModelDataPart
            ),
        text: (parts: vscode.LanguageModelResponsePart[]) =>
            parts
                .filter(part => part instanceof vscode.LanguageModelTextPart)
                .map(part => part.value)
                .join(''),
        assertNoMarkers(parts: vscode.LanguageModelResponsePart[]) {
            assert.equal(
                parts.some(
                    part => part instanceof vscode.LanguageModelDataPart && isStatefulMarkerMimeType(part.mimeType)
                ),
                false
            );
        },
        counters: () => ({ captures, wraps, http, dispatcherLeases, active: active.size }),
        networkDiagnostics: () => ({
            caBytes: ca?.length ?? 0,
            proxyCaBytes: proxyCa?.length ?? 0,
            owned: owned.size,
            aborted: aborted.size
        }),
        failFastCapture(value = true) {
            failFast = value;
        },
        recording(enabled: boolean) {
            recorder.initialize({ ...recordingOptions, enabled });
        },
        async close() {
            assert.equal(active.size, 0);
            await Promise.all(providers.map(provider => provider.dispose()));
            await pool.dispose();
            await Promise.all(
                [...owned].map(agent => closing.get(agent) ?? (aborted.has(agent) ? Promise.resolve() : agent.close()))
            );
            if (options.productionRouting) {
                await closeProxyAgents();
            }
            await mock.waitFor({ webSockets: 0, tcpSockets: 0, proxySockets: 0, pendingResponses: 0 });
            assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
            assert.equal(dispatcherLeases, 0);
            for (const connection of connections) {
                assert.deepEqual(connection.diagnostics(), { queueBytes: 0, handles: 0, processQueueBytes: 0 });
            }
            for (const cancellation of cancellations) {
                assert.equal(cancellation.subscriptions, cancellation.disposals);
            }
            const snapshot = await mock.snapshot();
            assert.equal(snapshot.forcedTerminations, 0);
            assert.equal(snapshot.protocolErrors, 0);
            assert.equal(snapshot.waiters, 0);
            const stopped = await mock.stop();
            assert.equal(stopped.listening, false);
            assert.equal(stopped.proxyListening, false);
            assert.equal(stopped.forcedTerminations, 0);
            assert.deepEqual(mock.diagnostics(), { exited: true, pending: 0, forcedKills: 0 });
            return harEntries();
        },
        async dispose() {
            try {
                for (const controller of controllers) {
                    controller.cancel();
                }
                const cleanup = providers.map(provider => provider.dispose());
                await Promise.allSettled([
                    ...cleanup,
                    pool.dispose(),
                    ...[...owned].map(agent => agent.destroy()),
                    recorder.dispose(),
                    ...active
                ]);
                if (options.productionRouting) {
                    await closeProxyAgents();
                }
                await mock.dispose();
            } finally {
                connections.clear();
                ConfigManager.createProxyAwareFetch = originalFetch;
                HarRecorder.getInstance = originalHarInstance;
                Logger.info = originalInfo;
                manager.recordEstimatedTokens = originalRecord;
                manager.updateActualTokens = originalUpdate;
                manager.hydrateSessionTitle = originalHydrate;
                for (const [key, value] of previousEnvironment) {
                    if (value === undefined) {
                        delete process.env[key];
                    } else {
                        process.env[key] = value;
                    }
                }
                for (const disposable of context.subscriptions) {
                    disposable.dispose();
                }
            }
        }
    };
}
