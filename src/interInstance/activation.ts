import * as vscode from 'vscode';
import { InterInstanceBus } from './interInstanceBus';
import type {
    ApiKeyFailoverRequestedEvent,
    ApiKeyFailoverResetEvent,
    ApiKeyFailoverResolvedEvent,
    LeaderResigningEvent,
    LiveMetricsSnapshotSyncEvent,
    RateLimitAcquireCancelledEvent,
    RateLimitAcquireRequestedEvent,
    RateLimitLeaseRenewedEvent,
    RateLimitReleasedEvent
} from './eventProtocol';
import { LeaderElectionService } from '../status/leaderElectionService';
import { RateLimiter } from '../rateLimit/rateLimiter';
import {
    clearRemoteLiveMetrics,
    getCrossInstanceLiveMetricsSnapshot,
    receiveRemoteLiveMetrics,
    setCrossInstanceBroadcaster,
    syncRemoteLiveMetricsSnapshot
} from '../handlers/liveMetrics';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ApiKeyFailoverManager } from '../utils/config/failover/apiKeyFailoverManager';
import { ConfigSetManagerPanel } from '../ui/configSetManager';

function isApiKeyFailoverRequestedPayload(payload: unknown): payload is ApiKeyFailoverRequestedEvent['payload'] {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const value = payload as Record<string, unknown>;
    const consecutiveFailureCount = value.consecutiveFailureCount;
    return (
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        value.requestId.length <= 128 &&
        typeof value.failureRequestId === 'string' &&
        value.failureRequestId.length > 0 &&
        value.failureRequestId.length <= 128 &&
        typeof value.requestedBy === 'string' &&
        value.requestedBy.length > 0 &&
        typeof value.authorityTerm === 'string' &&
        value.authorityTerm.length > 0 &&
        typeof value.slot === 'string' &&
        value.slot.length > 0 &&
        typeof value.activeId === 'string' &&
        value.activeId.length > 0 &&
        typeof value.identity === 'string' &&
        value.identity.length > 0 &&
        (value.site === undefined || (typeof value.site === 'string' && value.site.length > 0)) &&
        typeof consecutiveFailureCount === 'number' &&
        Number.isSafeInteger(consecutiveFailureCount) &&
        consecutiveFailureCount >= 1 &&
        Array.isArray(value.attemptedIdentities) &&
        value.attemptedIdentities.length <= 1000 &&
        value.attemptedIdentities.every(item => typeof item === 'string' && item.length > 0) &&
        (value.initialConfigId === undefined || typeof value.initialConfigId === 'string') &&
        typeof value.returnedToInitial === 'boolean'
    );
}

function isApiKeyFailoverResolvedPayload(payload: unknown): payload is ApiKeyFailoverResolvedEvent['payload'] {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const value = payload as Record<string, unknown>;
    return (
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        value.requestId.length <= 128 &&
        typeof value.authorityTerm === 'string' &&
        value.authorityTerm.length > 0 &&
        typeof value.handled === 'boolean' &&
        typeof value.shouldRetry === 'boolean' &&
        typeof value.switched === 'boolean' &&
        (value.switchedToInitial === undefined || typeof value.switchedToInitial === 'boolean')
    );
}

function isApiKeyFailoverResetPayload(payload: unknown): payload is ApiKeyFailoverResetEvent['payload'] {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const value = payload as Record<string, unknown>;
    return (
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        value.requestId.length <= 128 &&
        typeof value.failureRequestId === 'string' &&
        value.failureRequestId.length > 0 &&
        value.failureRequestId.length <= 128 &&
        typeof value.requestedBy === 'string' &&
        value.requestedBy.length > 0 &&
        typeof value.authorityTerm === 'string' &&
        value.authorityTerm.length > 0 &&
        typeof value.slot === 'string' &&
        value.slot.length > 0
    );
}

function getFailoverLeaderId(): string | undefined {
    if (!LeaderElectionService.isAgentsWindow()) {
        return LeaderElectionService.getLeaderId();
    }
    const authorityTerm = InterInstanceBus.getAuthorityTerm();
    const separator = authorityTerm?.lastIndexOf(':') ?? -1;
    return separator > 0 ? authorityTerm?.slice(0, separator) : undefined;
}

export function registerInterInstanceHandlers(context: vscode.ExtensionContext): void {
    setCrossInstanceBroadcaster(event => {
        InterInstanceBus.publishIpcOnly({ type: 'liveMetricsUpdated', payload: { event } });
    });

    const requestLiveMetricsSnapshot = (authorityTerm?: string) => {
        if (authorityTerm && !LeaderElectionService.isLeader()) {
            InterInstanceBus.publishIpcOnly({ type: 'liveMetricsSnapshotRequested', payload: {} });
        }
    };

    const handledFailoverRequests = new Map<
        string,
        {
            authorityTerm: string;
            expiresAt: number;
            resolved?: ApiKeyFailoverResolvedEvent['payload'];
        }
    >();
    const cleanupHandledFailoverRequests = (now: number): void => {
        for (const [requestId, request] of handledFailoverRequests) {
            if (request.expiresAt <= now) {
                handledFailoverRequests.delete(requestId);
            }
        }
    };
    const publishFailoverResolution = (
        request: ApiKeyFailoverRequestedEvent['payload'],
        resolved: ApiKeyFailoverResolvedEvent['payload']
    ): void => {
        if (
            !LeaderElectionService.isLeader() ||
            LeaderElectionService.getOwnedAuthorityTerm() !== request.authorityTerm
        ) {
            return;
        }
        const state = handledFailoverRequests.get(request.requestId);
        if (state?.authorityTerm === request.authorityTerm) {
            state.resolved = resolved;
        }
        InterInstanceBus.publish({ type: 'apiKeyFailoverResolved', payload: resolved }, { alsoFallback: true });
    };

    const refreshConfigSetManager = (message: string): void => {
        void ConfigSetManagerPanel.current?.requestStatesRefresh().catch(error => {
            Logger.warn(message, error);
        });
    };

    context.subscriptions.push(
        InterInstanceBus.onAuthorityChanged(requestLiveMetricsSnapshot),
        InterInstanceBus.subscribe('liveMetricsUpdated', event => {
            receiveRemoteLiveMetrics(
                (event.payload as { event: import('../handlers/liveMetrics').LiveStreamMetricEvent }).event,
                event.senderInstanceId
            );
        }),
        InterInstanceBus.subscribe('liveMetricsSnapshotRequested', event => {
            if (!LeaderElectionService.isLeader()) {
                return;
            }
            const connectedFollowerIds = new Set(InterInstanceBus.getConnectedFollowerIds());
            InterInstanceBus.publishIpcOnly({
                type: 'liveMetricsSnapshotSync',
                payload: {
                    targetInstanceId: event.senderInstanceId,
                    authorityTerm: LeaderElectionService.getAuthorityTerm(),
                    entries: getCrossInstanceLiveMetricsSnapshot(connectedFollowerIds)
                }
            });
        }),
        InterInstanceBus.subscribe('liveMetricsSnapshotSync', event => {
            const payload = event.payload as LiveMetricsSnapshotSyncEvent['payload'];
            if (payload.targetInstanceId !== LeaderElectionService.getInstanceId()) {
                return;
            }
            if (payload.authorityTerm && payload.authorityTerm !== InterInstanceBus.getAuthorityTerm()) {
                return;
            }
            syncRemoteLiveMetricsSnapshot(payload.entries, event.senderInstanceId);
        }),
        InterInstanceBus.subscribe('leaderResigning', event => {
            clearRemoteLiveMetrics((event.payload as LeaderResigningEvent['payload']).leaderId);
        }),
        InterInstanceBus.subscribe('remoteInstanceHello', event => {
            RateLimiter.handleInstanceReconnected(event.senderInstanceId);
        }),
        InterInstanceBus.subscribe('remoteInstanceDisconnected', event => {
            const instanceId = (event.payload as { instanceId: string }).instanceId;
            clearRemoteLiveMetrics(instanceId);
            RateLimiter.handleInstanceDisconnected(instanceId);
        }),
        InterInstanceBus.subscribe('configChanged', () => {
            ConfigManager.handleExternalConfigChange();
            Logger.trace('[InterInstanceBus] Config cache and HAR recorder refreshed due to remote change');
        }),
        InterInstanceBus.subscribe('rateLimitAcquireRequested', event => {
            RateLimiter.handleAcquireRequest(
                event.payload as RateLimitAcquireRequestedEvent['payload'],
                event.senderInstanceId
            );
        }),
        InterInstanceBus.subscribe('rateLimitReleased', event => {
            RateLimiter.handleRemoteRelease(event.payload as RateLimitReleasedEvent['payload'], event.senderInstanceId);
        }),
        InterInstanceBus.subscribe('rateLimitAcquireCancelled', event => {
            RateLimiter.handleRemoteAcquireCancelled(
                event.payload as RateLimitAcquireCancelledEvent['payload'],
                event.senderInstanceId
            );
        }),
        InterInstanceBus.subscribe('rateLimitLeaseRenewed', event => {
            RateLimiter.handleRemoteLeaseRenewal(
                event.payload as RateLimitLeaseRenewedEvent['payload'],
                event.senderInstanceId
            );
        }),
        InterInstanceBus.subscribe('apiKeyFailoverToggled', () => {
            refreshConfigSetManager('[InterInstanceBus] Failed to refresh API key configuration panel');
        }),
        ApiKeyManager.onDidChangeApiKey(() => {
            refreshConfigSetManager('[ConfigSetManager] Failed to refresh after local API key change');
        }),
        InterInstanceBus.subscribe('apiKeyChanged', () => {
            refreshConfigSetManager('[InterInstanceBus] Failed to refresh after remote API key change');
        }),
        InterInstanceBus.subscribe('apiKeyFailoverRequested', event => {
            if (!LeaderElectionService.isLeader() || !isApiKeyFailoverRequestedPayload(event.payload)) {
                return;
            }
            const payload = event.payload;
            const now = Date.now();
            if (
                payload.requestedBy !== event.senderInstanceId ||
                payload.authorityTerm !== LeaderElectionService.getOwnedAuthorityTerm() ||
                !Number.isFinite(event.timestamp) ||
                now - event.timestamp > 10_000 ||
                event.timestamp - now > 1_000
            ) {
                return;
            }
            cleanupHandledFailoverRequests(now);
            const existingRequest = handledFailoverRequests.get(payload.requestId);
            if (existingRequest?.authorityTerm === payload.authorityTerm) {
                if (existingRequest.resolved) {
                    publishFailoverResolution(payload, existingRequest.resolved);
                }
                return;
            }
            handledFailoverRequests.set(payload.requestId, {
                authorityTerm: payload.authorityTerm,
                expiresAt: now + 10_000
            });
            void ApiKeyFailoverManager.handleLeaderFailureSignal(payload)
                .then(decision => {
                    publishFailoverResolution(payload, {
                        requestId: payload.requestId,
                        authorityTerm: payload.authorityTerm,
                        handled: decision.handled,
                        shouldRetry: decision.shouldRetry,
                        switched: decision.switched,
                        switchedToInitial: decision.switchedToInitial
                    });
                })
                .catch(error => {
                    Logger.warn('[InterInstanceBus] Failed to process API key failover request', error);
                    publishFailoverResolution(payload, {
                        requestId: payload.requestId,
                        authorityTerm: payload.authorityTerm,
                        handled: true,
                        shouldRetry: false,
                        switched: false
                    });
                });
        }),
        InterInstanceBus.subscribe('apiKeyFailoverReset', event => {
            if (!LeaderElectionService.isLeader() || !isApiKeyFailoverResetPayload(event.payload)) {
                return;
            }
            const payload = event.payload;
            const now = Date.now();
            if (
                payload.requestedBy !== event.senderInstanceId ||
                payload.authorityTerm !== LeaderElectionService.getOwnedAuthorityTerm() ||
                !Number.isFinite(event.timestamp) ||
                now - event.timestamp > 10_000 ||
                event.timestamp - now > 1_000
            ) {
                return;
            }
            ApiKeyFailoverManager.handleLeaderFailureReset(payload);
        }),
        InterInstanceBus.subscribe('apiKeyFailoverResolved', event => {
            const authorityTerm =
                LeaderElectionService.isAgentsWindow() ?
                    InterInstanceBus.getAuthorityTerm()
                :   (LeaderElectionService.getAuthorityTerm() ?? InterInstanceBus.getAuthorityTerm());
            if (
                !isApiKeyFailoverResolvedPayload(event.payload) ||
                (LeaderElectionService.isInitialized() && event.senderInstanceId !== getFailoverLeaderId()) ||
                event.payload.authorityTerm !== authorityTerm
            ) {
                return;
            }
            ApiKeyFailoverManager.resolveLeaderDecision(event.payload.requestId, event.payload);
        })
    );

    requestLiveMetricsSnapshot(InterInstanceBus.getAuthorityTerm());
}
