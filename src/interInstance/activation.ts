import * as vscode from 'vscode';
import { InterInstanceBus } from './interInstanceBus';
import type {
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

export function registerInterInstanceHandlers(context: vscode.ExtensionContext): void {
    setCrossInstanceBroadcaster(event => {
        InterInstanceBus.publishIpcOnly({ type: 'liveMetricsUpdated', payload: { event } });
    });

    const requestLiveMetricsSnapshot = (authorityTerm?: string) => {
        if (authorityTerm && !LeaderElectionService.isLeader()) {
            InterInstanceBus.publishIpcOnly({ type: 'liveMetricsSnapshotRequested', payload: {} });
        }
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
            RateLimiter.handleRemoteRelease(event.payload as RateLimitReleasedEvent['payload']);
        }),
        InterInstanceBus.subscribe('rateLimitAcquireCancelled', event => {
            RateLimiter.handleRemoteAcquireCancelled(event.payload as RateLimitAcquireCancelledEvent['payload']);
        }),
        InterInstanceBus.subscribe('rateLimitLeaseRenewed', event => {
            RateLimiter.handleRemoteLeaseRenewal(event.payload as RateLimitLeaseRenewedEvent['payload']);
        })
    );

    requestLiveMetricsSnapshot(InterInstanceBus.getAuthorityTerm());
}
