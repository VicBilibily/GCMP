/*---------------------------------------------------------------------------------------------
 *  跨实例实时通讯模块
 *  提供 VS Code 多窗口之间的事件广播与订阅能力
 *--------------------------------------------------------------------------------------------*/

export { InterInstanceBus, type InterInstanceBusOptions } from './interInstanceBus';
export {
    type InterInstanceEvent,
    type StatusUpdatedEvent,
    type ApiKeyChangedEvent,
    type ConfigChangedEvent,
    type TokenUsageUpdatedEvent,
    type SyncCompletedEvent,
    type LeaderChangedEvent,
    type LeaderResigningEvent,
    type LiveMetricsUpdatedEvent,
    type LiveMetricsSnapshotRequestedEvent,
    type LiveMetricsSnapshotSyncEvent,
    type RemoteInstanceDisconnectedEvent,
    type CliAuthRefreshRequestedEvent,
    type CliAuthRefreshCompletedEvent,
    type RateLimitAcquireRequestedEvent,
    type RateLimitAcquireGrantedEvent,
    type RateLimitQueueUpdatedEvent,
    type RateLimitAcquireCancelledEvent,
    type RateLimitReleasedEvent,
    type RateLimitLeaseRenewedEvent,
    type InterInstanceEventHandler,
    INTER_INSTANCE_EVENT_TYPES,
    serializeEvent,
    parseEventsFromBuffer
} from './eventProtocol';
export { resolveIpcPath, isNamedPipePath, isIpcPathLengthSafe } from './pathResolver';
export { FallbackTransport, type FallbackTransportOptions } from './fallbackTransport';
