import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { once } from 'node:events';
import * as net from 'node:net';

import * as vscode from 'vscode';

import { InterInstanceBus, type ApiKeyFailoverRequestedEvent, type InterInstanceEvent } from '../../src/interInstance';
import { registerInterInstanceHandlers } from '../../src/interInstance/activation';
import { IpcClient } from '../../src/interInstance/ipcClient';
import { IpcServer } from '../../src/interInstance/ipcServer';
import { resolveIpcPath } from '../../src/interInstance/pathResolver';
import { serializeEvent } from '../../src/interInstance/eventProtocol';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { configProviders } from '../../src/providers/config';
import { RateLimiter, type RateLimitHandle } from '../../src/rateLimit/rateLimiter';
import { RateLimitStore } from '../../src/rateLimit/rateLimitStore';
import { LeaderElectionService, type LeaderIdentity } from '../../src/status/leaderElectionService';
import type { ModelConfig, ProviderConfig, RateLimitConfig } from '../../src/types/sharedTypes';
import { CompatibleModelManager } from '../../src/utils/config/compatibleModelManager';
import { ConfigManager } from '../../src/utils/config/configManager';
import { ApiKeyFailoverManager } from '../../src/utils/config/failover/apiKeyFailoverManager';

interface InterInstanceBusInternals {
    initialized: boolean;
    context: vscode.ExtensionContext | undefined;
    instanceId: string | undefined;
    client: IpcClient | undefined;
    reconnectTimer: NodeJS.Timeout | undefined;
    reconnectAttempts: number;
    lifecycleGeneration: number;
    authorityTerm: string | undefined;
    handlers: Map<string, Set<(event: InterInstanceEvent) => void>>;
    connectToLeader: () => Promise<void>;
    dispatchEvent: (event: InterInstanceEvent) => void;
    scheduleReconnect: () => void;
}

interface PatchedLeaderElectionService {
    getOwnedAuthorityTerm: typeof LeaderElectionService.getOwnedAuthorityTerm;
    isLeader: typeof LeaderElectionService.isLeader;
    isAgentsWindow: typeof LeaderElectionService.isAgentsWindow;
    getLeaderIdentity: typeof LeaderElectionService.getLeaderIdentity;
}

interface LeaderElectionInternals {
    context: vscode.ExtensionContext | undefined;
    initialized: boolean;
    _isLeader: boolean;
    recoverAfterLeaderResigning: (resigningLeaderId: string) => Promise<void>;
    becomeLeader: (force?: boolean) => Promise<void>;
    checkLeader: () => Promise<void>;
}

interface GenericModelProviderPrototypeAccess {
    acquireRateLimit: (
        this: { providerConfig: { displayName: string } },
        effectiveProviderKey: string,
        modelConfig: ModelConfig,
        totalInputTokens: number,
        token: vscode.CancellationToken,
        requestId: string,
        onThrottled?: () => void
    ) => Promise<RateLimitHandle | undefined>;
}

const testModelConfig: ModelConfig = {
    id: 'test-model',
    name: 'Test Model',
    tooltip: 'Test Model',
    maxInputTokens: 8192,
    maxOutputTokens: 2048,
    capabilities: {
        toolCalling: false,
        imageInput: false
    }
};

suite('Coordination regressions', () => {
    suite('rate-limit ownership', () => {
        const limiter = RateLimiter as unknown as {
            leaderStore: RateLimitStore;
            handleRemoteRelease: (
                payload: Parameters<typeof RateLimiter.handleRemoteRelease>[0],
                sender?: string
            ) => void;
            handleRemoteAcquireCancelled: (
                payload: Parameters<typeof RateLimiter.handleRemoteAcquireCancelled>[0],
                sender?: string
            ) => void;
            handleRemoteLeaseRenewal: (
                payload: Parameters<typeof RateLimiter.handleRemoteLeaseRenewal>[0],
                sender?: string
            ) => void;
        };
        const now = 100_000;
        let originalStore: RateLimitStore;
        let originalIsLeader: typeof LeaderElectionService.isLeader;
        let originalTerm: typeof LeaderElectionService.getAuthorityTerm;
        let originalPublish: typeof InterInstanceBus.publish;
        let originalNow: typeof Date.now;

        setup(() => {
            originalStore = limiter.leaderStore;
            originalIsLeader = LeaderElectionService.isLeader;
            originalTerm = LeaderElectionService.getAuthorityTerm;
            originalPublish = InterInstanceBus.publish;
            originalNow = Date.now;
            limiter.leaderStore = new RateLimitStore('ownership-test', 10_000);
            LeaderElectionService.isLeader = () => true;
            LeaderElectionService.getAuthorityTerm = () => 'leader-b:2';
            InterInstanceBus.publish = () => {};
            Date.now = () => now;
        });

        teardown(() => {
            limiter.leaderStore = originalStore;
            LeaderElectionService.isLeader = originalIsLeader;
            LeaderElectionService.getAuthorityTerm = originalTerm;
            InterInstanceBus.publish = originalPublish;
            Date.now = originalNow;
        });

        for (const operation of ['release', 'cancel-grant', 'cancel-pending', 'renew'] as const) {
            for (const owner of ['follower-a', undefined]) {
                for (const sender of ['follower-a', 'follower-b', undefined]) {
                    for (const authorityTerm of ['leader-a:1', 'leader-b:2']) {
                        test(`${operation}: owner=${owner}, sender=${sender}, term=${authorityTerm}`, () => {
                            const store = limiter.leaderStore;
                            const dims = { parallel: 1, rpm: 60, tpm: 600 };
                            const costs = { requests: 1, tokens: 10 };
                            if (operation === 'cancel-pending') {
                                store.acquire('holder', 'bucket', dims, costs, now - 100, {
                                    ownerInstanceId: 'holder'
                                });
                            }
                            const result = store.acquire('request', 'bucket', dims, costs, now - 100, {
                                ownerInstanceId: owner
                            });
                            const before = store.exportSnapshot(now);
                            const positions = store.getPendingPositions('bucket');
                            if (operation === 'cancel-grant' || operation === 'cancel-pending') {
                                limiter.handleRemoteAcquireCancelled(
                                    { authorityTerm, bucketKey: 'bucket', requestId: 'request' },
                                    sender
                                );
                            } else {
                                if (result.kind !== 'granted') {
                                    assert.fail('request should be granted');
                                }
                                if (operation === 'release') {
                                    limiter.handleRemoteRelease(
                                        { authorityTerm, grantId: result.grantId, refund: costs },
                                        sender
                                    );
                                } else {
                                    limiter.handleRemoteLeaseRenewal(
                                        { authorityTerm, grantId: result.grantId },
                                        sender
                                    );
                                }
                            }
                            if (sender && owner === sender) {
                                if (operation === 'renew') {
                                    assert.equal(store.exportSnapshot(now).grants[0]?.expiresAt, now + 10_000);
                                } else if (operation === 'cancel-pending') {
                                    assert.equal(store.stats('bucket', now)?.pending, 0);
                                } else {
                                    assert.equal(store.stats('bucket', now)?.inflight, 0);
                                }
                            } else {
                                assert.deepEqual(store.exportSnapshot(now), before);
                                assert.deepEqual(store.getPendingPositions('bucket'), positions);
                            }
                        });
                    }
                }
            }
        }
    });

    test('IpcServer rejects sender identity changes on an established socket', async () => {
        const receivedTypes: string[] = [];
        let reportHello: (() => void) | undefined;
        const helloReceived = new Promise<void>(resolve => {
            reportHello = resolve;
        });
        const server = new IpcServer({
            onMessage(event) {
                receivedTypes.push(event.type);
                if (event.type === 'remoteInstanceHello') {
                    reportHello?.();
                }
            }
        });
        const ipcPath = resolveIpcPath(`sender-binding-${crypto.randomUUID()}`);
        let socket: net.Socket | undefined;

        try {
            await server.start(ipcPath);
            socket = net.connect(ipcPath);
            await once(socket, 'connect');
            socket.write(
                serializeEvent({
                    type: 'remoteInstanceHello',
                    payload: {},
                    timestamp: Date.now(),
                    senderInstanceId: 'follower-a'
                })
            );
            await helloReceived;

            const closed = once(socket, 'close');
            socket.write(
                serializeEvent({
                    type: 'configChanged',
                    payload: { changedKeys: [] },
                    timestamp: Date.now(),
                    senderInstanceId: 'spoofed-leader'
                })
            );
            await closed;

            assert.deepEqual(receivedTypes, ['remoteInstanceHello']);
        } finally {
            socket?.destroy();
            await server.stop();
        }
    });

    test('IpcServer rejects authority-only events from a follower socket', async () => {
        const receivedTypes: string[] = [];
        let reportHello: (() => void) | undefined;
        const helloReceived = new Promise<void>(resolve => {
            reportHello = resolve;
        });
        const server = new IpcServer({
            onMessage(event) {
                receivedTypes.push(event.type);
                if (event.type === 'remoteInstanceHello') {
                    reportHello?.();
                }
            }
        });
        const ipcPath = resolveIpcPath(`authority-binding-${crypto.randomUUID()}`);
        let socket: net.Socket | undefined;

        try {
            await server.start(ipcPath);
            socket = net.connect(ipcPath);
            await once(socket, 'connect');
            socket.write(
                serializeEvent({
                    type: 'remoteInstanceHello',
                    payload: {},
                    timestamp: Date.now(),
                    senderInstanceId: 'follower-a'
                })
            );
            await helloReceived;

            const closed = once(socket, 'close');
            socket.write(
                serializeEvent({
                    type: 'leaderResigning',
                    payload: { leaderId: 'leader-a', nextLeaderId: 'follower-a' },
                    timestamp: Date.now(),
                    senderInstanceId: 'follower-a'
                })
            );
            await closed;

            assert.deepEqual(receivedTypes, ['remoteInstanceHello']);
        } finally {
            socket?.destroy();
            await server.stop();
        }
    });

    test('balance coordination events preserve ordering over a real IPC socket', async () => {
        const receivedEvents: InterInstanceEvent[] = [];
        const events: InterInstanceEvent[] = [
            {
                type: 'remoteInstanceHello',
                payload: {},
                timestamp: Date.now(),
                senderInstanceId: 'follower-a'
            },
            {
                type: 'apiKeyBalanceAssignmentRequested',
                payload: {
                    requestId: 'balance-request-1',
                    requestedBy: 'follower-a',
                    authorityTerm: 'leader-a:1',
                    slot: 'slot',
                    balanceKey: 's:session-1'
                },
                timestamp: Date.now(),
                senderInstanceId: 'follower-a'
            },
            {
                type: 'apiKeyBalanceFailureReported',
                payload: {
                    requestId: 'balance-failure-1',
                    requestedBy: 'follower-a',
                    authorityTerm: 'leader-a:1',
                    slot: 'slot',
                    balanceKey: 's:session-1',
                    credentialId: 'credential-a',
                    leaseId: 'lease-a',
                    consecutiveFailureCount: 3
                },
                timestamp: Date.now(),
                senderInstanceId: 'follower-a'
            },
            {
                type: 'apiKeyBalanceLeaseRenewed',
                payload: { leaseId: 'lease-a', authorityTerm: 'leader-a:1' },
                timestamp: Date.now(),
                senderInstanceId: 'follower-a'
            },
            {
                type: 'apiKeyBalanceLeaseReleased',
                payload: { leaseId: 'lease-a', authorityTerm: 'leader-a:1' },
                timestamp: Date.now(),
                senderInstanceId: 'follower-a'
            }
        ];
        let resolveEvents!: () => void;
        let rejectEvents!: (error: Error) => void;
        const eventsReceived = new Promise<void>((resolve, reject) => {
            resolveEvents = resolve;
            rejectEvents = reject;
        });
        const timeout = setTimeout(() => rejectEvents(new Error('balance IPC events were not received')), 2000);
        const server = new IpcServer({
            onMessage: event => {
                receivedEvents.push(event);
                if (receivedEvents.length === events.length) {
                    clearTimeout(timeout);
                    resolveEvents();
                }
            }
        });
        const client = new IpcClient({ onMessage: () => {} });
        const ipcPath = resolveIpcPath(`balance-events-${crypto.randomUUID()}`);

        try {
            await server.start(ipcPath);
            await client.connect(ipcPath);
            for (const event of events) {
                client.send(event);
            }
            await eventsReceived;

            assert.deepEqual(
                receivedEvents.map(event => event.type),
                events.map(event => event.type)
            );
            assert.ok(receivedEvents.every(event => event.senderInstanceId === 'follower-a'));
        } finally {
            clearTimeout(timeout);
            await client.disconnect();
            await server.stop();
        }
    });

    test('failover request subscriptions validate sender, authority term, timestamp, and duplicates', async () => {
        const bus = InterInstanceBus as unknown as InterInstanceBusInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;
        const originalHandlers = bus.handlers;
        const originalInstanceId = bus.instanceId;
        const originalPublish = InterInstanceBus.publish;
        const originalHandleSignal = ApiKeyFailoverManager.handleLeaderFailureSignal;
        const originalGetOwnedAuthorityTerm = patchedLeaderElection.getOwnedAuthorityTerm;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalNow = Date.now;
        const context = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
        const resolutions: Array<{ type: string; payload: unknown }> = [];
        let signalCalls = 0;
        let reportResolution: (() => void) | undefined;

        try {
            bus.handlers = new Map();
            bus.instanceId = 'leader-a';
            patchedLeaderElection.getOwnedAuthorityTerm = () => 'leader-a:1';
            patchedLeaderElection.isLeader = () => true;
            Date.now = () => 100_000;
            InterInstanceBus.publish = (event => {
                if (event.type === 'apiKeyFailoverResolved') {
                    resolutions.push(event);
                    reportResolution?.();
                    reportResolution = undefined;
                }
            }) as typeof InterInstanceBus.publish;
            ApiKeyFailoverManager.handleLeaderFailureSignal = async () => {
                signalCalls += 1;
                return { handled: true, shouldRetry: true, switched: true };
            };
            registerInterInstanceHandlers(context);

            const payload: ApiKeyFailoverRequestedEvent['payload'] = {
                requestId: 'failover-request-1',
                failureRequestId: 'failure-source-1',
                requestedBy: 'follower-a',
                authorityTerm: 'leader-a:1',
                slot: 'zhipu',
                activeId: 'config-a',
                identity: 'config-a:fingerprint:open.bigmodel.cn',
                site: 'open.bigmodel.cn',
                consecutiveFailureCount: 3,
                attemptedIdentities: ['config-a:fingerprint:open.bigmodel.cn'],
                initialConfigId: 'config-a',
                returnedToInitial: false
            };
            const dispatch = (
                payloadOverrides: Partial<ApiKeyFailoverRequestedEvent['payload']> = {},
                eventOverrides: Partial<Pick<ApiKeyFailoverRequestedEvent, 'timestamp' | 'senderInstanceId'>> = {}
            ): void => {
                bus.dispatchEvent({
                    type: 'apiKeyFailoverRequested',
                    payload: { ...payload, ...payloadOverrides },
                    timestamp: 100_000,
                    senderInstanceId: 'follower-a',
                    ...eventOverrides
                });
            };

            dispatch({}, { senderInstanceId: 'follower-b' });
            dispatch({ authorityTerm: 'leader-b:2' });
            dispatch({}, { timestamp: 89_999 });
            dispatch({}, { timestamp: 101_001 });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(signalCalls, 0);
            assert.equal(resolutions.length, 0);

            const firstResolution = new Promise<void>(resolve => {
                reportResolution = resolve;
            });
            dispatch();
            await firstResolution;
            assert.equal(signalCalls, 1);
            assert.deepEqual(resolutions[0], {
                type: 'apiKeyFailoverResolved',
                payload: {
                    requestId: payload.requestId,
                    authorityTerm: payload.authorityTerm,
                    handled: true,
                    shouldRetry: true,
                    switched: true,
                    switchedToInitial: undefined
                }
            });

            const duplicateResolution = new Promise<void>(resolve => {
                reportResolution = resolve;
            });
            dispatch();
            await duplicateResolution;
            assert.equal(signalCalls, 1);
            assert.equal(resolutions.length, 2);
        } finally {
            for (const disposable of context.subscriptions.reverse()) {
                disposable.dispose();
            }
            bus.handlers = originalHandlers;
            bus.instanceId = originalInstanceId;
            InterInstanceBus.publish = originalPublish;
            ApiKeyFailoverManager.handleLeaderFailureSignal = originalHandleSignal;
            patchedLeaderElection.getOwnedAuthorityTerm = originalGetOwnedAuthorityTerm;
            patchedLeaderElection.isLeader = originalIsLeader;
            Date.now = originalNow;
        }
    });

    test('InterInstanceBus reconnects when leader target changes during connect', async () => {
        const bus = InterInstanceBus as unknown as InterInstanceBusInternals;
        const patchedLeaderElection = LeaderElectionService as unknown as PatchedLeaderElectionService;

        const originalInitialized = bus.initialized;
        const originalContext = bus.context;
        const originalInstanceId = bus.instanceId;
        const originalClient = bus.client;
        const originalReconnectTimer = bus.reconnectTimer;
        const originalReconnectAttempts = bus.reconnectAttempts;
        const originalLifecycleGeneration = bus.lifecycleGeneration;
        const originalAuthorityTerm = bus.authorityTerm;
        const originalScheduleReconnect = bus.scheduleReconnect;
        const originalIsLeader = patchedLeaderElection.isLeader;
        const originalIsAgentsWindow = patchedLeaderElection.isAgentsWindow;
        const originalGetLeaderIdentity = patchedLeaderElection.getLeaderIdentity;
        const originalConnect = IpcClient.prototype.connect;
        const originalDisconnect = IpcClient.prototype.disconnect;

        let leaderIdentity: LeaderIdentity | undefined = {
            instanceId: 'leader-a',
            electedAt: 1,
            authorityTerm: 'leader-a:1'
        };
        const connectedPaths: string[] = [];
        let disconnectCalls = 0;
        let reconnectScheduled = 0;

        try {
            bus.initialized = true;
            bus.context = {} as vscode.ExtensionContext;
            bus.instanceId = 'follower';
            bus.client = undefined;
            bus.reconnectTimer = undefined;
            bus.reconnectAttempts = 0;
            bus.lifecycleGeneration = 1;
            bus.authorityTerm = undefined;

            patchedLeaderElection.isLeader = () => false;
            patchedLeaderElection.isAgentsWindow = () => false;
            patchedLeaderElection.getLeaderIdentity = () => leaderIdentity;

            IpcClient.prototype.connect = async function (pipePath: string): Promise<void> {
                connectedPaths.push(pipePath);
                leaderIdentity = {
                    instanceId: 'leader-b',
                    electedAt: 2,
                    authorityTerm: 'leader-b:2'
                };
            };
            IpcClient.prototype.disconnect = async function (): Promise<void> {
                disconnectCalls += 1;
            };
            bus.scheduleReconnect = () => {
                reconnectScheduled += 1;
            };

            await bus.connectToLeader();

            assert.equal(connectedPaths.length, 1);
            assert.equal(disconnectCalls, 1);
            assert.equal(reconnectScheduled, 1);
            assert.equal(bus.client, undefined);
            assert.equal(bus.authorityTerm, undefined);
        } finally {
            bus.initialized = originalInitialized;
            bus.context = originalContext;
            bus.instanceId = originalInstanceId;
            bus.client = originalClient;
            bus.reconnectTimer = originalReconnectTimer;
            bus.reconnectAttempts = originalReconnectAttempts;
            bus.lifecycleGeneration = originalLifecycleGeneration;
            bus.authorityTerm = originalAuthorityTerm;
            bus.scheduleReconnect = originalScheduleReconnect;
            patchedLeaderElection.isLeader = originalIsLeader;
            patchedLeaderElection.isAgentsWindow = originalIsAgentsWindow;
            patchedLeaderElection.getLeaderIdentity = originalGetLeaderIdentity;
            IpcClient.prototype.connect = originalConnect;
            IpcClient.prototype.disconnect = originalDisconnect;
        }
    });

    test('recoverAfterLeaderResigning forces takeover even when old leader record is still fresh', async () => {
        const leaderElection = LeaderElectionService as unknown as LeaderElectionInternals;
        const originalContext = leaderElection.context;
        const originalInitialized = leaderElection.initialized;
        const originalIsLeaderState = leaderElection._isLeader;
        const originalBecomeLeader = leaderElection.becomeLeader;
        const originalCheckLeader = leaderElection.checkLeader;

        const forceFlags: Array<boolean | undefined> = [];
        let checkLeaderCalls = 0;

        try {
            leaderElection.context = {
                globalState: {
                    get: () => ({
                        instanceId: 'leader-a',
                        lastHeartbeat: Date.now(),
                        electedAt: 1
                    })
                }
            } as unknown as vscode.ExtensionContext;
            leaderElection.initialized = true;
            leaderElection._isLeader = false;
            leaderElection.becomeLeader = async (force?: boolean) => {
                forceFlags.push(force);
            };
            leaderElection.checkLeader = async () => {
                checkLeaderCalls += 1;
            };

            await leaderElection.recoverAfterLeaderResigning('leader-a');

            assert.deepEqual(forceFlags, [true]);
            assert.equal(checkLeaderCalls, 1);
        } finally {
            leaderElection.context = originalContext;
            leaderElection.initialized = originalInitialized;
            leaderElection._isLeader = originalIsLeaderState;
            leaderElection.becomeLeader = originalBecomeLeader;
            leaderElection.checkLeader = originalCheckLeader;
        }
    });

    test('empty model limit object reuses provider bucket instead of creating an isolated model bucket', async () => {
        const acquireRateLimit = (GenericModelProvider.prototype as unknown as GenericModelProviderPrototypeAccess)
            .acquireRateLimit;
        const originalGetProviderRateLimitConfig = ConfigManager.getProviderRateLimitConfig;
        const originalRateLimiterAcquire = RateLimiter.acquire;
        const calls: Array<{
            bucketKey: string;
            dims: RateLimitConfig;
            costs: { requests: number; tokens: number };
        }> = [];

        try {
            ConfigManager.getProviderRateLimitConfig = () => ({ rpm: 60 });
            RateLimiter.acquire = async (bucketKey, dims, costs) => {
                calls.push({ bucketKey, dims, costs });
                return undefined;
            };

            await acquireRateLimit.call(
                {
                    providerConfig: { displayName: 'Test Provider' }
                },
                'compatible',
                {
                    id: 'test-model',
                    name: 'Test Model',
                    tooltip: 'Test Model',
                    maxInputTokens: 8192,
                    maxOutputTokens: 2048,
                    capabilities: {
                        toolCalling: false,
                        imageInput: false
                    },
                    limit: {}
                },
                123,
                {} as vscode.CancellationToken,
                'request-1'
            );

            assert.deepEqual(calls, [
                {
                    bucketKey: 'compatible',
                    dims: { rpm: 60 },
                    costs: { requests: 1, tokens: 2171 }
                }
            ]);
        } finally {
            ConfigManager.getProviderRateLimitConfig = originalGetProviderRateLimitConfig;
            RateLimiter.acquire = originalRateLimiterAcquire;
        }
    });

    test('invalid rate limit configuration fails closed even when an authoritative path exists', async () => {
        const acquireRateLimit = (GenericModelProvider.prototype as unknown as GenericModelProviderPrototypeAccess)
            .acquireRateLimit;
        const originalGetProviderRateLimitConfig = ConfigManager.getProviderRateLimitConfig;
        const originalHasAuthoritativePath = RateLimiter.hasAuthoritativePath;
        const originalRateLimiterAcquire = RateLimiter.acquire;
        let acquireCalled = false;

        try {
            ConfigManager.getProviderRateLimitConfig = () => ({ rpm: Number.NaN });
            RateLimiter.hasAuthoritativePath = () => true;
            RateLimiter.acquire = async () => {
                acquireCalled = true;
                return undefined;
            };

            await assert.rejects(
                acquireRateLimit.call(
                    {
                        providerConfig: { displayName: 'Test Provider' }
                    },
                    'compatible',
                    testModelConfig,
                    123,
                    {} as vscode.CancellationToken,
                    'request-2'
                ),
                /Invalid rate limit configuration/
            );
            assert.equal(acquireCalled, false);
        } finally {
            ConfigManager.getProviderRateLimitConfig = originalGetProviderRateLimitConfig;
            RateLimiter.hasAuthoritativePath = originalHasAuthoritativePath;
            RateLimiter.acquire = originalRateLimiterAcquire;
        }
    });

    test('empty effective rate limit returns undefined without entering the limiter', async () => {
        const acquireRateLimit = (GenericModelProvider.prototype as unknown as GenericModelProviderPrototypeAccess)
            .acquireRateLimit;
        const originalGetProviderRateLimitConfig = ConfigManager.getProviderRateLimitConfig;
        const originalRateLimiterAcquire = RateLimiter.acquire;
        let acquireCalled = false;

        try {
            ConfigManager.getProviderRateLimitConfig = () => undefined;
            RateLimiter.acquire = async () => {
                acquireCalled = true;
                return undefined;
            };

            const result = await acquireRateLimit.call(
                {
                    providerConfig: { displayName: 'Test Provider' }
                },
                'compatible',
                {
                    ...testModelConfig,
                    limit: {}
                },
                123,
                {} as vscode.CancellationToken,
                'request-empty-limit'
            );

            assert.equal(result, undefined);
            assert.equal(acquireCalled, false);
        } finally {
            ConfigManager.getProviderRateLimitConfig = originalGetProviderRateLimitConfig;
            RateLimiter.acquire = originalRateLimiterAcquire;
        }
    });

    test('applyProviderOverrides merges partial model limit with base model limit', () => {
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;

        try {
            ConfigManager.getProviderOverrides = () => ({
                'test-provider': {
                    models: [
                        {
                            id: 'test-model',
                            limit: { tpm: 1000 }
                        }
                    ]
                }
            });

            const resolved = ConfigManager.applyProviderOverrides('test-provider', {
                displayName: 'Test Provider',
                baseUrl: 'https://example.com/v1',
                apiKeyTemplate: 'sk-test',
                models: [
                    {
                        ...testModelConfig,
                        limit: { rpm: 60, parallel: 2 }
                    }
                ]
            });

            assert.deepEqual(resolved.models[0]?.limit, { rpm: 60, parallel: 2, tpm: 1000 });
        } finally {
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
        }
    });

    test('applyProviderOverrides preserves null customHeader deletion markers', () => {
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;

        try {
            ConfigManager.getProviderOverrides = () => ({
                'test-provider': {
                    customHeader: {
                        'x-builtin': null,
                        'X-Provider': 'provider'
                    },
                    models: [
                        {
                            id: 'test-model',
                            customHeader: { 'X-Model': null }
                        }
                    ]
                }
            });

            const resolved = ConfigManager.applyProviderOverrides('test-provider', {
                displayName: 'Test Provider',
                baseUrl: 'https://example.com/v1',
                apiKeyTemplate: 'sk-test',
                customHeader: {
                    'X-Builtin': 'builtin',
                    'X-Keep': 'keep'
                },
                models: [
                    {
                        ...testModelConfig,
                        customHeader: { 'X-Model': 'model' }
                    }
                ]
            });

            assert.deepEqual(resolved.customHeader, {
                'x-builtin': null,
                'X-Keep': 'keep',
                'X-Provider': 'provider'
            });
            assert.equal(resolved.models[0]?.customHeader?.['X-Model'], null);
            assert.equal(resolved.models[0]?.customHeader?.['X-Builtin'], undefined);
            assert.equal(resolved.models[0]?.customHeader?.['x-builtin'], null);
        } finally {
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
        }
    });

    test('getModelRateLimitConfig merges built-in model limit with partial override', () => {
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;
        const providerRegistry = configProviders as Record<string, ProviderConfig | undefined>;
        const providerKey = 'test-provider-config-manager';
        const originalProviderConfig = providerRegistry[providerKey];

        try {
            providerRegistry[providerKey] = {
                displayName: 'Test Provider',
                baseUrl: 'https://example.com/v1',
                apiKeyTemplate: 'sk-test',
                models: [
                    {
                        ...testModelConfig,
                        limit: { rpm: 60, parallel: 2 }
                    }
                ]
            };
            ConfigManager.getProviderOverrides = () => ({
                [providerKey]: {
                    models: [
                        {
                            id: 'test-model',
                            limit: { tpm: 1000 }
                        }
                    ]
                }
            });

            assert.deepEqual(ConfigManager.getModelRateLimitConfig(providerKey, 'test-model'), {
                rpm: 60,
                parallel: 2,
                tpm: 1000
            });
        } finally {
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
            if (originalProviderConfig) {
                providerRegistry[providerKey] = originalProviderConfig;
            } else {
                delete providerRegistry[providerKey];
            }
        }
    });

    test('getModelRateLimitConfig falls back to compatible custom model limit for custom provider', () => {
        const originalGetProviderOverrides = ConfigManager.getProviderOverrides;
        const originalGetModels = CompatibleModelManager.getModels;

        try {
            ConfigManager.getProviderOverrides = () => ({});
            CompatibleModelManager.getModels = () => [
                {
                    id: 'compatible-test-model',
                    name: 'Compatible Test Model',
                    provider: 'custom-provider',
                    maxInputTokens: 8192,
                    maxOutputTokens: 4096,
                    capabilities: {
                        toolCalling: false,
                        imageInput: false
                    },
                    limit: { tpm: 2000 }
                }
            ];

            assert.deepEqual(ConfigManager.getModelRateLimitConfig('custom-provider', 'compatible-test-model'), {
                tpm: 2000
            });
        } finally {
            ConfigManager.getProviderOverrides = originalGetProviderOverrides;
            CompatibleModelManager.getModels = originalGetModels;
        }
    });
});
