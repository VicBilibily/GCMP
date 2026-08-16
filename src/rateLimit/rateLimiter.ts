/*---------------------------------------------------------------------------------------------
 *  限流器宿主层
 *  Leader：本地权威桶直调；Follower：IPC 请求-回执；降级：本地桶
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { InterInstanceBus } from '../interInstance';
import type {
    LeaderResigningEvent,
    RateLimitAcquireCancelledEvent,
    RateLimitAcquireGrantedEvent,
    RateLimitAcquireRequestedEvent,
    RateLimitLeaseRenewedEvent,
    RateLimitQueueUpdatedEvent,
    RateLimitReleasedEvent
} from '../interInstance';
import { LeaderElectionService } from '../status/leaderElectionService';
import type { RateLimitWaitScope } from '../types/sharedTypes';
import { ConfigManager } from '../utils/config/configManager';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';
import {
    DEFAULT_RATE_LIMIT_LEASE_MS,
    RateLimitStore,
    type PendingPosition,
    type PendingGrant,
    type RateLimitCosts,
    type RateLimitDimensions,
    type RateLimitRefund,
    type RateLimitStoreSnapshot
} from './rateLimitStore';
import { RateLimitClientCore } from './rateLimitClientCore';

/** acquire 成功后返回的句柄，release 时回传 */
export interface RateLimitHandle {
    grantId: string;
    costs: RateLimitCosts;
    leaseMs: number;
    authorityTerm?: string;
    /** true = 授权来自权威桶（Leader 直调或远端回执），false = 本地降级桶 */
    authoritative: boolean;
}

export interface RateLimitWaitingEvent {
    waitScope: RateLimitWaitScope;
    requestStartTime: number;
    queuePosition?: number;
}

export interface RateLimitAcquireOptions {
    token?: vscode.CancellationToken;
    timeout?: number;
    onWaiting?: (event: RateLimitWaitingEvent) => void;
}

interface QueuedWaiter<TResult> {
    onWaiting?: (event: RateLimitWaitingEvent) => void;
    resolve: (result: TResult) => void;
}

interface PersistedLeaderHandoff {
    leaderId: string;
    receivedAt: number;
    snapshot: RateLimitStoreSnapshot;
}

type PendingWaiter = QueuedWaiter<PendingGrant | undefined>;

type LeaderPendingWaiter = QueuedWaiter<PendingGrant | 'role-changed' | undefined>;

/** 降级恢复探测间隔 */
const PROBE_INTERVAL_MS = 60_000;
/** Leader 侧 pending 队列清扫间隔 */
const SWEEP_INTERVAL_MS = 1_000;
const MAX_SLEEP_CHUNK_MS = 2_147_483_647;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;
const AUTHORITY_TRANSITION_TIMEOUT_MS = 30_000;
/** 单次 acquire 链上允许的最大任期变更重试次数，超出后仅当前请求回退本地桶，避免选举抖动时自旋 */
const MAX_AUTHORITY_CHANGE_RETRIES = 3;
const LEADER_HANDOFF_TTL_MS = AUTHORITY_TRANSITION_TIMEOUT_MS;
const LEADER_HANDOFF_OWNERLESS_GRANT_GRACE_MS = 5_000;
const PERSISTED_LEADER_HANDOFF_KEY = 'gcmp.rateLimit.handoff.v1';

/**
 * 跨实例限流器（静态门面）
 */
export class RateLimiter {
    private static initialized = false;
    private static context: vscode.ExtensionContext | undefined;
    /** Leader 权威桶（仅本实例为 Leader 时使用；角色变更时重建） */
    private static leaderStore = new RateLimitStore();
    /** 本地降级桶（Follower 在 IPC 不可用/回执超时时使用） */
    private static localStore = new RateLimitStore();
    private static clientCore: RateLimitClientCore | undefined;
    private static sweepTimer: NodeJS.Timeout | undefined;
    private static leaderChangeSubscription: vscode.Disposable | undefined;

    /** Leader 侧：本地排队等待者（Leader 自身请求 queued 时挂起） */
    private static leaderWaiters = new Map<string, LeaderPendingWaiter>();
    /** 本地降级桶排队等待者（本窗口 queued 时挂起） */
    private static localWaiters = new Map<string, PendingWaiter>();
    /** 活跃 grant 的 lease 续租心跳 */
    private static leaseHeartbeatTimers = new Map<string, NodeJS.Timeout>();
    private static pendingLeaderHandoff:
        | {
              leaderId: string;
              snapshot: RateLimitStoreSnapshot;
              receivedAt: number;
          }
        | undefined;

    /** 降级状态 */
    private static degraded = false;
    private static degradedNotified = false;
    private static lastProbeAt = 0;

    static initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.context = context;

        this.clientCore = new RateLimitClientCore({
            send: msg => {
                InterInstanceBus.publish({
                    type: 'rateLimitAcquireRequested',
                    payload: msg
                });
            },
            sendCancel: msg => {
                InterInstanceBus.publish(
                    {
                        type: 'rateLimitAcquireCancelled',
                        payload: msg
                    },
                    { alsoFallback: true }
                );
            },
            onGrantEvent: handler => {
                const disposable = InterInstanceBus.subscribe('rateLimitAcquireGranted', event => {
                    handler(event.payload as RateLimitAcquireGrantedEvent['payload']);
                });
                return () => disposable.dispose();
            },
            onQueueUpdateEvent: handler => {
                const disposable = InterInstanceBus.subscribe('rateLimitQueueUpdated', event => {
                    handler(event.payload as RateLimitQueueUpdatedEvent['payload']);
                });
                return () => disposable.dispose();
            },
            isTransportHealthy: () => InterInstanceBus.isConnected(),
            getAuthorityTerm: () => InterInstanceBus.getAuthorityTerm(),
            now: () => Date.now(),
            nextRequestId: () => crypto.randomUUID()
        });

        LeaderElectionService.setRateLimitSnapshotProvider(() => this.exportLeaderStateSnapshot());

        // Leader 变更：优先恢复平滑 handoff 快照，拿不到时再空桶启动
        this.leaderChangeSubscription = LeaderElectionService.onLeaderChanged(isLeader => {
            if (isLeader) {
                this.becomeLeaderWithFreshState();
                return;
            }

            this.recoverLeaderWaitersAfterRoleChange();
            this.leaderStore = new RateLimitStore();
            this.pendingLeaderHandoff = undefined;
            StatusLogger.info('[RateLimiter] Lost leader role, pending leader waiters will reacquire');
        });

        // 周期清扫：Leader 桶的 pending 超时/授予 + lease 回收；本地桶的 lease 回收
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);

        context.subscriptions.push(
            InterInstanceBus.subscribe('leaderResigning', event => {
                this.handleLeaderResigning(event.payload as LeaderResigningEvent['payload']);
            }),
            vscode.Disposable.from({
                dispose: () => {
                    if (this.sweepTimer) {
                        clearInterval(this.sweepTimer);
                    }
                    for (const timer of this.leaseHeartbeatTimers.values()) {
                        clearInterval(timer);
                    }
                    this.leaseHeartbeatTimers.clear();
                    this.leaderChangeSubscription?.dispose();
                    this.clientCore?.dispose();
                    this.pendingLeaderHandoff = undefined;
                    this.context = undefined;
                    LeaderElectionService.setRateLimitSnapshotProvider(undefined);
                    this.initialized = false;
                }
            })
        );
        StatusLogger.info('[RateLimiter] Initialized');
    }

    /**
     * 申请限流配额。返回 undefined 表示当前未启用限流。
     * 等待期间被取消时自动全额退款并抛 CancellationError。
     */
    static async acquire(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions
    ): Promise<RateLimitHandle | undefined> {
        if (!this.initialized) {
            return undefined;
        }

        return this.acquireForCurrentRole(bucketKey, dims, costs, options);
    }

    private static async acquireForCurrentRole(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions,
        authorityChangeAttempts: number = 0
    ): Promise<RateLimitHandle | undefined> {
        if (options?.token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        if (LeaderElectionService.isLeader()) {
            return this.acquireViaLeaderStore(bucketKey, dims, costs, options, authorityChangeAttempts);
        }
        if (authorityChangeAttempts >= MAX_AUTHORITY_CHANGE_RETRIES) {
            Logger.warn(
                `[RateLimit] authority changed too frequently for bucket=${bucketKey}, falling back current acquire to local bucket`
            );
            return this.acquireViaLocalStore(bucketKey, dims, costs, options, authorityChangeAttempts);
        }
        if (authorityChangeAttempts > 0 && !this.hasUsableAuthorityTransport()) {
            const recovered = await this.waitForAuthorityRecovery(options?.token);
            if (recovered) {
                return this.acquireForCurrentRole(bucketKey, dims, costs, options, authorityChangeAttempts);
            }
            Logger.warn(
                `[RateLimit] authority recovery timed out for bucket=${bucketKey}, falling back current acquire to local bucket`
            );
            return this.acquireViaLocalStore(bucketKey, dims, costs, options, authorityChangeAttempts);
        }
        if (this.shouldUseIpc() || (authorityChangeAttempts > 0 && this.hasUsableAuthorityTransport())) {
            const handle = await this.acquireViaIpc(bucketKey, dims, costs, options, authorityChangeAttempts);
            if (handle) {
                return handle;
            }
            // IPC 失败已在 acquireViaIpc 内进入降级
            if (LeaderElectionService.isLeader()) {
                return this.acquireViaLeaderStore(bucketKey, dims, costs, options, authorityChangeAttempts);
            }
        }
        return this.acquireViaLocalStore(bucketKey, dims, costs, options, authorityChangeAttempts);
    }

    /**
     * 释放配额（幂等）。refund 未提供的字段不退。
     */
    static release(handle: RateLimitHandle, refund?: RateLimitRefund): void {
        this.stopLeaseHeartbeat(handle.grantId);
        if (!this.initialized) {
            return;
        }
        if (handle.authoritative && LeaderElectionService.isLeader()) {
            const granted = this.leaderStore.release(handle.grantId, refund, Date.now());
            this.distributeLeaderGrants(granted);
        } else if (handle.authoritative) {
            const authorityTerm = handle.authorityTerm;
            if (!authorityTerm) {
                return;
            }
            InterInstanceBus.publish(
                {
                    type: 'rateLimitReleased',
                    payload: { authorityTerm, grantId: handle.grantId, refund }
                },
                { alsoFallback: true }
            );
        } else {
            const granted = this.localStore.release(handle.grantId, refund, Date.now());
            this.distributeLocalGrants(granted);
        }
    }

    // ==================== Leader 侧：处理远端请求 ====================

    /**
     * Leader 处理远端 acquire 请求（extension.ts 订阅挂接）
     * dims 以 Leader 本机配置重算为准（保证配置热更新生效），请求侧 dims 仅兼容旧版本协议
     */
    static handleAcquireRequest(payload: RateLimitAcquireRequestedEvent['payload'], senderInstanceId?: string): void {
        if (!LeaderElectionService.isLeader() || payload.authorityTerm !== LeaderElectionService.getAuthorityTerm()) {
            return;
        }
        const result = this.leaderStore.acquire(
            payload.requestId,
            payload.bucketKey,
            this.resolveAuthoritativeDims(payload.bucketKey),
            payload.costs,
            Date.now(),
            { ownerInstanceId: senderInstanceId }
        );
        if (result.kind === 'granted') {
            this.publishGranted(payload.authorityTerm, payload.requestId, result.waitMs, result.grantId);
        } else {
            this.publishQueueUpdated(payload.authorityTerm, payload.requestId, result.queuePosition);
        }
        // queued：等待 release/sweep 触发授予后统一回执
    }

    /**
     * 远端实例断线：Leader 回收其排队项与持有 grant，避免幽灵占用阻塞 FIFO（extension.ts 订阅挂接）
     */
    static handleInstanceDisconnected(instanceId: string): void {
        if (!this.initialized || !LeaderElectionService.isLeader()) {
            return;
        }
        const { granted, affectedBucketKeys } = this.leaderStore.reclaimInstance(instanceId, Date.now());
        if (affectedBucketKeys.length === 0) {
            return;
        }
        StatusLogger.info(
            `[RateLimiter] Reclaimed rate-limit state of disconnected instance ${instanceId} (${granted.length} granted)`
        );
        this.distributeLeaderGrants(granted);
        for (const bucketKey of affectedBucketKeys) {
            const positions = this.leaderStore.getPendingPositions(bucketKey);
            this.notifyQueuePositionUpdates(positions, this.leaderWaiters, 'leader');
            this.publishQueuePositionUpdates(positions);
        }
    }

    /** 以 Leader 本机配置解析桶的权威维度（provider 级 + 模型级字段覆盖） */
    private static resolveAuthoritativeDims(bucketKey: string): RateLimitDimensions {
        const separatorIndex = bucketKey.indexOf('::');
        const providerKey = separatorIndex >= 0 ? bucketKey.slice(0, separatorIndex) : bucketKey;
        const modelId = separatorIndex >= 0 ? bucketKey.slice(separatorIndex + 2) : undefined;
        const providerLimit = ConfigManager.getProviderRateLimitConfig(providerKey);
        const modelLimit = modelId ? ConfigManager.getModelRateLimitConfig(providerKey, modelId) : undefined;
        return { ...providerLimit, ...modelLimit };
    }

    /**
     * Leader 处理远端 release（extension.ts 订阅挂接）
     */
    static handleRemoteRelease(payload: RateLimitReleasedEvent['payload']): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const currentAuthorityTerm = LeaderElectionService.getAuthorityTerm();
        if (payload.authorityTerm !== currentAuthorityTerm && !this.leaderStore.hasGrant(payload.grantId)) {
            return;
        }
        const granted = this.leaderStore.release(payload.grantId, payload.refund, Date.now());
        this.distributeLeaderGrants(granted);
    }

    static handleRemoteAcquireCancelled(payload: RateLimitAcquireCancelledEvent['payload']): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const currentAuthorityTerm = LeaderElectionService.getAuthorityTerm();
        if (
            payload.authorityTerm !== currentAuthorityTerm &&
            !this.leaderStore.hasRequest(payload.bucketKey, payload.requestId)
        ) {
            return;
        }
        const granted = this.leaderStore.abortRequest(payload.bucketKey, payload.requestId, Date.now());
        this.distributeLeaderGrants(granted);
        this.publishQueuePositionUpdates(this.leaderStore.getPendingPositions(payload.bucketKey));
    }

    static handleRemoteLeaseRenewal(payload: RateLimitLeaseRenewedEvent['payload']): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const currentAuthorityTerm = LeaderElectionService.getAuthorityTerm();
        if (payload.authorityTerm !== currentAuthorityTerm && !this.leaderStore.hasGrant(payload.grantId)) {
            return;
        }
        this.leaderStore.renew(payload.grantId, Date.now());
    }

    // ==================== 内部实现 ====================

    /** Leader 自身请求：直调权威桶；queued 时挂起等待授予 */
    private static async acquireViaLeaderStore(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions,
        authorityChangeAttempts: number = 0
    ): Promise<RateLimitHandle | undefined> {
        const leaseMs = DEFAULT_RATE_LIMIT_LEASE_MS;
        const requestId = crypto.randomUUID();
        const result = this.leaderStore.acquire(requestId, bucketKey, dims, costs, Date.now());
        if (result.kind === 'granted') {
            Logger.debug(
                `[RateLimit] leader acquire granted: bucket=${bucketKey}, waitMs=${result.waitMs}, costs=${JSON.stringify(costs)}`
            );
            if (result.waitMs > 0) {
                options?.onWaiting?.({ waitScope: 'leader', requestStartTime: Date.now() });
            }
            const handle: RateLimitHandle = {
                grantId: result.grantId,
                costs,
                leaseMs,
                authorityTerm: LeaderElectionService.getAuthorityTerm(),
                authoritative: true
            };
            this.startLeaseHeartbeat(handle);
            return this.sleepOrRefund(
                result.waitMs,
                handle,
                options?.token,
                bucketKey,
                dims,
                options,
                authorityChangeAttempts
            );
        }

        // queued：挂起直到 release/sweep 授予，按 FIFO 等待放行
        Logger.debug(`[RateLimit] leader acquire queued: bucket=${bucketKey}, costs=${JSON.stringify(costs)}`);
        const requestStartTime = Date.now();
        const grantPromise = this.waitForLeaderGrant(requestId, bucketKey, options?.token, options?.onWaiting);
        options?.onWaiting?.({ waitScope: 'leader', requestStartTime, queuePosition: result.queuePosition });
        const grant = await grantPromise;
        if (!grant) {
            // 仅取消才会走到这里
            throw new vscode.CancellationError();
        }
        if (grant === 'role-changed') {
            return this.acquireForCurrentRole(bucketKey, dims, costs, options, authorityChangeAttempts + 1);
        }
        Logger.debug(
            `[RateLimit] leader acquire granted: bucket=${bucketKey}, waitMs=${grant.waitMs}, costs=${JSON.stringify(costs)}`
        );
        if (grant.waitMs > 0) {
            options?.onWaiting?.({ waitScope: 'leader', requestStartTime: Date.now() });
        }
        const handle: RateLimitHandle = {
            grantId: grant.grantId,
            costs,
            leaseMs,
            authorityTerm: LeaderElectionService.getAuthorityTerm(),
            authoritative: true
        };
        this.startLeaseHeartbeat(handle);
        return this.sleepOrRefund(
            grant.waitMs,
            handle,
            options?.token,
            bucketKey,
            dims,
            options,
            authorityChangeAttempts
        );
    }

    /** Follower：IPC 请求-回执；仅 authority 不可用时进入全局降级，其余失败只回退当前请求 */
    private static async acquireViaIpc(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions,
        authorityChangeAttempts: number = 0
    ): Promise<RateLimitHandle | undefined> {
        if (!this.clientCore) {
            return undefined;
        }
        const outcome = await this.clientCore.acquire(
            bucketKey,
            dims,
            costs,
            {
                isCancelled: () => options?.token?.isCancellationRequested === true
            },
            {
                timeout: options?.timeout,
                onQueueUpdate: msg => {
                    options?.onWaiting?.({
                        waitScope: 'ipc',
                        requestStartTime: Date.now(),
                        queuePosition: msg.queuePosition
                    });
                }
            }
        );
        if (outcome.status === 'cancelled') {
            throw new vscode.CancellationError();
        }
        if (outcome.status === 'authority-changed') {
            return this.acquireForCurrentRole(bucketKey, dims, costs, options, authorityChangeAttempts + 1);
        }
        if (outcome.status === 'degraded') {
            if (LeaderElectionService.isLeader()) {
                return undefined;
            }
            if (outcome.reason === 'authority-unavailable') {
                const recovered = await this.waitForAuthorityRecovery(options?.token);
                if (recovered) {
                    return this.acquireForCurrentRole(bucketKey, dims, costs, options, authorityChangeAttempts + 1);
                }
                this.enterDegraded(outcome.reason);
                return undefined;
            }
            Logger.warn(
                `[RateLimit] ipc acquire timed out without progress for bucket=${bucketKey}, falling back current acquire to local bucket`
            );
            return undefined;
        }

        const handle: RateLimitHandle = {
            grantId: outcome.grantId,
            costs,
            leaseMs: DEFAULT_RATE_LIMIT_LEASE_MS,
            authorityTerm: outcome.authorityTerm,
            authoritative: true
        };
        Logger.debug(
            `[RateLimit] ipc acquire granted: bucket=${bucketKey}, waitMs=${outcome.waitMs}, costs=${JSON.stringify(costs)}`
        );
        if (outcome.waitMs > 0) {
            options?.onWaiting?.({ waitScope: 'ipc', requestStartTime: Date.now() });
        }
        this.startLeaseHeartbeat(handle);
        const settledHandle = await this.sleepOrRefund(
            outcome.waitMs,
            handle,
            options?.token,
            bucketKey,
            dims,
            options,
            authorityChangeAttempts
        );
        this.exitDegraded('ipc acquire succeeded');
        return settledHandle;
    }

    /** 本地降级桶：queued 时真实挂起等待授予（FIFO，不轮询抢槽位） */
    private static async acquireViaLocalStore(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions,
        authorityChangeAttempts: number = 0
    ): Promise<RateLimitHandle | undefined> {
        const leaseMs = DEFAULT_RATE_LIMIT_LEASE_MS;
        const requestId = crypto.randomUUID();
        if (options?.token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const result = this.localStore.acquire(requestId, bucketKey, dims, costs, Date.now());
        if (result.kind === 'granted') {
            Logger.debug(
                `[RateLimit] local acquire granted: bucket=${bucketKey}, waitMs=${result.waitMs}, costs=${JSON.stringify(costs)}`
            );
            if (result.waitMs > 0) {
                options?.onWaiting?.({ waitScope: 'local', requestStartTime: Date.now() });
            }
            const handle: RateLimitHandle = {
                grantId: result.grantId,
                costs,
                leaseMs,
                authoritative: false
            };
            this.startLeaseHeartbeat(handle);
            return this.sleepOrRefund(
                result.waitMs,
                handle,
                options?.token,
                bucketKey,
                dims,
                options,
                authorityChangeAttempts
            );
        }

        Logger.debug(`[RateLimit] local acquire queued: bucket=${bucketKey}, costs=${JSON.stringify(costs)}`);
        const requestStartTime = Date.now();
        const grantPromise = this.waitForLocalGrant(requestId, bucketKey, options?.token, options?.onWaiting);
        options?.onWaiting?.({ waitScope: 'local', requestStartTime, queuePosition: result.queuePosition });
        const grant = await grantPromise;
        if (!grant) {
            throw new vscode.CancellationError();
        }
        Logger.debug(
            `[RateLimit] local acquire granted: bucket=${bucketKey}, waitMs=${grant.waitMs}, costs=${JSON.stringify(costs)}`
        );
        if (grant.waitMs > 0) {
            options?.onWaiting?.({ waitScope: 'local', requestStartTime: Date.now() });
        }
        const handle: RateLimitHandle = { grantId: grant.grantId, costs, leaseMs, authoritative: false };
        this.startLeaseHeartbeat(handle);
        return this.sleepOrRefund(
            grant.waitMs,
            handle,
            options?.token,
            bucketKey,
            dims,
            options,
            authorityChangeAttempts
        );
    }

    /** Leader 自身请求 queued 时的挂起等待（仅取消可打断，不超时） */
    private static waitForLeaderGrant(
        requestId: string,
        bucketKey: string,
        token?: vscode.CancellationToken,
        onWaiting?: (event: RateLimitWaitingEvent) => void
    ): Promise<PendingGrant | 'role-changed' | undefined> {
        return this.waitForGrant(requestId, token, onWaiting, this.leaderWaiters, () => {
            this.leaderStore.cancelPending(bucketKey, requestId);
            this.notifyQueuePositionUpdates(
                this.leaderStore.getPendingPositions(bucketKey),
                this.leaderWaiters,
                'leader'
            );
        });
    }

    /** 本地降级桶 queued 时的挂起等待（仅取消可打断，不超时） */
    private static waitForLocalGrant(
        requestId: string,
        bucketKey: string,
        token?: vscode.CancellationToken,
        onWaiting?: (event: RateLimitWaitingEvent) => void
    ): Promise<PendingGrant | undefined> {
        return this.waitForGrant(requestId, token, onWaiting, this.localWaiters, () => {
            this.localStore.cancelPending(bucketKey, requestId);
            this.notifyQueuePositionUpdates(this.localStore.getPendingPositions(bucketKey), this.localWaiters, 'local');
        });
    }
    private static waitForGrant<TResult>(
        requestId: string,
        token: vscode.CancellationToken | undefined,
        onWaiting: ((event: RateLimitWaitingEvent) => void) | undefined,
        waiters: Map<string, QueuedWaiter<TResult>>,
        onCancelled: () => void
    ): Promise<TResult> {
        return new Promise<TResult>(resolve => {
            const cancelSub = token?.onCancellationRequested(() => {
                waiters.delete(requestId);
                onCancelled();
                resolve(undefined as TResult);
            });
            waiters.set(requestId, {
                onWaiting,
                resolve: result => {
                    cancelSub?.dispose();
                    resolve(result);
                }
            });
        });
    }

    private static notifyQueuePositionUpdates(
        pending: PendingPosition[],
        waiters: Map<string, PendingWaiter | LeaderPendingWaiter>,
        waitScope: 'leader' | 'local'
    ): void {
        const requestStartTime = Date.now();
        for (const entry of pending) {
            const waiter = waiters.get(entry.requestId);
            if (!waiter?.onWaiting) {
                continue;
            }
            waiter.onWaiting({
                waitScope,
                requestStartTime,
                queuePosition: entry.queuePosition
            });
        }
    }

    private static recoverLeaderWaitersAfterRoleChange(): void {
        const waiters = Array.from(this.leaderWaiters.values());
        this.leaderWaiters.clear();
        for (const waiter of waiters) {
            waiter.resolve('role-changed');
        }
    }

    /** sleep waitMs；取消时全额退款并抛 CancellationError */
    private static async sleepOrRefund(
        waitMs: number,
        handle: RateLimitHandle,
        token?: vscode.CancellationToken,
        bucketKey?: string,
        dims?: RateLimitDimensions,
        options?: RateLimitAcquireOptions,
        authorityChangeAttempts: number = 0
    ): Promise<RateLimitHandle | undefined> {
        if (waitMs <= 0) {
            return handle;
        }
        try {
            await this.sleep(waitMs, token, handle.authorityTerm);
            return handle;
        } catch (error) {
            if (error instanceof AuthorityChangedError && bucketKey && dims) {
                this.release(handle, { requests: handle.costs.requests, tokens: handle.costs.tokens });
                return this.acquireForCurrentRole(bucketKey, dims, handle.costs, options, authorityChangeAttempts + 1);
            }
            this.release(handle, { requests: handle.costs.requests, tokens: handle.costs.tokens });
            throw error;
        }
    }

    private static sleep(ms: number, token?: vscode.CancellationToken, authorityTerm?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            let remainingMs = ms;
            let timer: NodeJS.Timeout | undefined;
            let settled = false;
            let authoritySub: vscode.Disposable | undefined;
            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                cancelSub?.dispose();
                authoritySub?.dispose();
            };
            const finish = (error?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            };
            const schedule = () => {
                if (token?.isCancellationRequested) {
                    finish(new vscode.CancellationError());
                    return;
                }
                if (remainingMs <= 0) {
                    finish();
                    return;
                }
                const delayMs = Math.min(remainingMs, MAX_SLEEP_CHUNK_MS);
                timer = setTimeout(() => {
                    timer = undefined;
                    remainingMs -= delayMs;
                    schedule();
                }, delayMs);
            };
            const cancelSub = token?.onCancellationRequested(() => finish(new vscode.CancellationError()));
            if (authorityTerm) {
                authoritySub = InterInstanceBus.onAuthorityChanged(nextAuthorityTerm => {
                    if (nextAuthorityTerm !== authorityTerm) {
                        finish(new AuthorityChangedError());
                    }
                });
            }
            schedule();
        });
    }

    private static startLeaseHeartbeat(handle: RateLimitHandle): void {
        if (handle.leaseMs <= 0) {
            return;
        }
        this.stopLeaseHeartbeat(handle.grantId);
        const renewEveryMs = Math.max(MIN_LEASE_RENEW_INTERVAL_MS, Math.floor(handle.leaseMs / 2));
        const timer = setInterval(() => {
            if (!this.initialized) {
                this.stopLeaseHeartbeat(handle.grantId);
                return;
            }
            const renewed = this.renewLease(handle);
            if (!renewed) {
                this.stopLeaseHeartbeat(handle.grantId);
            }
        }, renewEveryMs);
        this.leaseHeartbeatTimers.set(handle.grantId, timer);
    }

    private static stopLeaseHeartbeat(grantId: string): void {
        const timer = this.leaseHeartbeatTimers.get(grantId);
        if (!timer) {
            return;
        }
        clearInterval(timer);
        this.leaseHeartbeatTimers.delete(grantId);
    }

    private static renewLease(handle: RateLimitHandle): boolean {
        const now = Date.now();
        if (handle.authoritative && LeaderElectionService.isLeader()) {
            return this.leaderStore.renew(handle.grantId, now);
        }
        if (handle.authoritative) {
            const authorityTerm = handle.authorityTerm;
            if (!authorityTerm) {
                return false;
            }
            InterInstanceBus.publish(
                {
                    type: 'rateLimitLeaseRenewed',
                    payload: { authorityTerm, grantId: handle.grantId }
                },
                { alsoFallback: true }
            );
            return true;
        }
        return this.localStore.renew(handle.grantId, now);
    }

    private static hasUsableAuthorityTransport(): boolean {
        return !!InterInstanceBus.getAuthorityTerm() && InterInstanceBus.isConnected();
    }

    private static handleLeaderResigning(payload: LeaderResigningEvent['payload']): void {
        if (payload.leaderId === LeaderElectionService.getInstanceId() || !payload.rateLimitSnapshot) {
            return;
        }
        this.pendingLeaderHandoff = {
            leaderId: payload.leaderId,
            snapshot: payload.rateLimitSnapshot,
            receivedAt: Date.now()
        };
        void this.persistLeaderHandoffSnapshot(payload.leaderId, payload.rateLimitSnapshot);
    }

    private static async exportLeaderStateSnapshot(): Promise<RateLimitStoreSnapshot | undefined> {
        if (!this.initialized || !LeaderElectionService.isLeader()) {
            return undefined;
        }
        const snapshot = this.leaderStore.exportSnapshot(Date.now());
        await this.persistLeaderHandoffSnapshot(LeaderElectionService.getInstanceId(), snapshot);
        return snapshot;
    }

    private static consumePendingLeaderHandoff():
        | {
              leaderId: string;
              snapshot: RateLimitStoreSnapshot;
          }
        | undefined {
        const handoff = this.pendingLeaderHandoff;
        this.pendingLeaderHandoff = undefined;
        if (!handoff) {
            return undefined;
        }
        if (Date.now() - handoff.receivedAt > LEADER_HANDOFF_TTL_MS) {
            return undefined;
        }
        return { leaderId: handoff.leaderId, snapshot: handoff.snapshot };
    }

    private static consumePersistedLeaderHandoff():
        | {
              leaderId: string;
              snapshot: RateLimitStoreSnapshot;
          }
        | undefined {
        const persisted = this.context?.globalState.get<PersistedLeaderHandoff>(PERSISTED_LEADER_HANDOFF_KEY);
        if (!persisted) {
            return undefined;
        }
        if (Date.now() - persisted.receivedAt > LEADER_HANDOFF_TTL_MS) {
            this.clearPersistedLeaderHandoff();
            return undefined;
        }
        return { leaderId: persisted.leaderId, snapshot: persisted.snapshot };
    }

    private static async persistLeaderHandoffSnapshot(
        leaderId: string,
        snapshot: RateLimitStoreSnapshot,
        receivedAt: number = Date.now()
    ): Promise<void> {
        if (!this.context) {
            return;
        }
        try {
            await this.context.globalState.update(PERSISTED_LEADER_HANDOFF_KEY, {
                leaderId,
                receivedAt,
                snapshot
            } satisfies PersistedLeaderHandoff);
        } catch (error) {
            Logger.warn('[RateLimit] Failed to persist leader handoff snapshot', error);
        }
    }

    private static clearPersistedLeaderHandoff(): void {
        if (!this.context) {
            return;
        }
        void this.context.globalState
            .update(PERSISTED_LEADER_HANDOFF_KEY, undefined)
            .then(undefined, error =>
                Logger.warn('[RateLimit] Failed to clear persisted leader handoff snapshot', error)
            );
    }

    private static becomeLeaderWithFreshState(): void {
        this.clientCore?.settlePendingAsDegraded();
        this.leaderStore = new RateLimitStore();
        const handoff = this.consumePendingLeaderHandoff() ?? this.consumePersistedLeaderHandoff();
        if (handoff) {
            const now = Date.now();
            this.leaderStore.importSnapshot(handoff.snapshot, now, {
                ownerlessGrantGraceMs: LEADER_HANDOFF_OWNERLESS_GRANT_GRACE_MS
            });
            this.clearPersistedLeaderHandoff();
            this.exitDegraded('became leader');
            StatusLogger.info(
                `[RateLimiter] Became leader, authoritative bucket restored from ${handoff.leaderId} handoff`
            );
            return;
        }
        this.exitDegraded('became leader');
        StatusLogger.info('[RateLimiter] Became leader, authoritative bucket reset (empty start)');
    }

    // ==================== 降级管理 ====================

    private static shouldUseIpc(): boolean {
        if (!InterInstanceBus.getAuthorityTerm()) {
            return false;
        }
        if (this.degraded) {
            // 恢复探测：每 60s 允许一次 IPC 尝试
            if (Date.now() - this.lastProbeAt >= PROBE_INTERVAL_MS && InterInstanceBus.isConnected()) {
                this.lastProbeAt = Date.now();
                return true;
            }
            return false;
        }
        return InterInstanceBus.isConnected();
    }

    private static enterDegraded(reason: string): void {
        if (!this.degraded) {
            this.degraded = true;
            StatusLogger.warn(`[RateLimiter] Entering degraded mode (${reason}), using local bucket`);
        }
        this.lastProbeAt = Date.now();
        if (!this.degradedNotified) {
            this.degradedNotified = true;
            void vscode.window.showWarningMessage(
                t(
                    'GCMP rate limiting degraded to per-window local mode (cross-instance coordination unavailable).',
                    'GCMP 限流已降级为单窗口本地模式（跨实例协调不可用）。'
                )
            );
        }
    }

    private static exitDegraded(reason: string): void {
        if (!this.degraded) {
            return;
        }
        this.degraded = false;
        this.degradedNotified = false;
        StatusLogger.info(`[RateLimiter] Exited degraded mode (${reason})`);
    }

    // ==================== 清扫与授予分发 ====================

    private static sweep(): void {
        const now = Date.now();
        if (LeaderElectionService.isLeader()) {
            this.distributeLeaderGrants(this.leaderStore.sweep(now));
        }
        this.distributeLocalGrants(this.localStore.sweep(now));
    }

    /** pending 授予分发：Leader 本地等待者优先，其余广播回执 */
    private static distributeLeaderGrants(granted: PendingGrant[]): void {
        const authorityTerm = LeaderElectionService.getAuthorityTerm();
        const affectedBuckets = new Set<string>();
        for (const grant of granted) {
            const waiter = this.leaderWaiters.get(grant.requestId);
            if (waiter) {
                this.leaderWaiters.delete(grant.requestId);
                waiter.resolve(grant);
            } else {
                if (authorityTerm) {
                    this.publishGranted(authorityTerm, grant.requestId, grant.waitMs, grant.grantId);
                }
            }
            affectedBuckets.add(grant.bucketKey);
        }
        for (const bucketKey of affectedBuckets) {
            this.notifyQueuePositionUpdates(
                this.leaderStore.getPendingPositions(bucketKey),
                this.leaderWaiters,
                'leader'
            );
            this.publishQueuePositionUpdates(this.leaderStore.getPendingPositions(bucketKey));
        }
    }

    /** 本地 pending 授予分发：仅唤醒本窗口等待者 */
    private static distributeLocalGrants(granted: PendingGrant[]): void {
        const affectedBuckets = new Set<string>();
        for (const grant of granted) {
            const waiter = this.localWaiters.get(grant.requestId);
            if (!waiter) {
                affectedBuckets.add(grant.bucketKey);
                continue;
            }
            this.localWaiters.delete(grant.requestId);
            waiter.resolve(grant);
            affectedBuckets.add(grant.bucketKey);
        }
        for (const bucketKey of affectedBuckets) {
            this.notifyQueuePositionUpdates(this.localStore.getPendingPositions(bucketKey), this.localWaiters, 'local');
        }
    }

    private static publishGranted(authorityTerm: string, requestId: string, waitMs: number, grantId: string): void {
        InterInstanceBus.publish(
            {
                type: 'rateLimitAcquireGranted',
                payload: { authorityTerm, requestId, waitMs, grantId }
            },
            { alsoFallback: true }
        );
    }

    private static publishQueueUpdated(authorityTerm: string, requestId: string, queuePosition: number): void {
        InterInstanceBus.publish({
            type: 'rateLimitQueueUpdated',
            payload: { authorityTerm, requestId, queuePosition }
        });
    }

    private static publishQueuePositionUpdates(pending: PendingPosition[]): void {
        const authorityTerm = LeaderElectionService.getAuthorityTerm();
        if (!authorityTerm) {
            return;
        }
        for (const entry of pending) {
            this.publishQueueUpdated(authorityTerm, entry.requestId, entry.queuePosition);
        }
    }

    private static waitForAuthorityRecovery(token?: vscode.CancellationToken): Promise<boolean> {
        if (LeaderElectionService.isLeader() || this.hasUsableAuthorityTransport()) {
            return Promise.resolve(true);
        }
        return new Promise<boolean>(resolve => {
            const timerRef: { current?: NodeJS.Timeout } = {};
            let settled = false;
            const authoritySub = InterInstanceBus.onAuthorityChanged(authorityTerm => {
                if (authorityTerm && this.hasUsableAuthorityTransport()) {
                    finish(true);
                    return;
                }
                if (LeaderElectionService.isLeader()) {
                    finish(true);
                }
            });
            const cancelSub = token?.onCancellationRequested(() => finish(false));
            const finish = (value: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timerRef.current) {
                    clearTimeout(timerRef.current);
                }
                authoritySub.dispose();
                cancelSub?.dispose();
                resolve(value);
            };
            timerRef.current = setTimeout(() => finish(false), AUTHORITY_TRANSITION_TIMEOUT_MS);
        });
    }
}

class AuthorityChangedError extends Error {}
