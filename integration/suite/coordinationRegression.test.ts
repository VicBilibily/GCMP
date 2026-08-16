import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import { InterInstanceBus } from '../../src/interInstance';
import { IpcClient } from '../../src/interInstance/ipcClient';
import { GenericModelProvider } from '../../src/providers/genericModelProvider';
import { RateLimiter, type RateLimitHandle } from '../../src/rateLimit/rateLimiter';
import { LeaderElectionService, type LeaderIdentity } from '../../src/status/leaderElectionService';
import type { ModelConfig, RateLimitConfig } from '../../src/types/sharedTypes';
import { ConfigManager } from '../../src/utils/config/configManager';

interface InterInstanceBusInternals {
    initialized: boolean;
    context: vscode.ExtensionContext | undefined;
    instanceId: string | undefined;
    client: IpcClient | undefined;
    reconnectTimer: NodeJS.Timeout | undefined;
    reconnectAttempts: number;
    lifecycleGeneration: number;
    authorityTerm: string | undefined;
    connectToLeader: () => Promise<void>;
    scheduleReconnect: () => void;
}

interface PatchedLeaderElectionService {
    isLeader: typeof LeaderElectionService.isLeader;
    isAgentsWindow: typeof LeaderElectionService.isAgentsWindow;
    getLeaderIdentity: typeof LeaderElectionService.getLeaderIdentity;
}

interface LeaderElectionInternals {
    context: vscode.ExtensionContext | undefined;
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

suite('Coordination regressions', () => {
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
});
