/*---------------------------------------------------------------------------------------------
 *  限流器宿主层
 *  Leader：本地权威桶直调；Follower：IPC 请求-回执；降级：本地桶
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { InterInstanceBus } from '../interInstance';
import { LeaderElectionService } from '../status/leaderElectionService';
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
    type RateLimitRefund
} from './rateLimitStore';
import {
    RateLimitClientCore,
    type RateLimitGrantMessage,
    type RateLimitQueueUpdateMessage
} from './rateLimitClientCore';

/** acquire 成功后返回的句柄，release 时回传 */
export interface RateLimitHandle {
    grantId: string;
    bucketKey: string;
    costs: RateLimitCosts;
    leaseMs: number;
    /** true = 授权来自权威桶（Leader 直调或远端回执），false = 本地降级桶 */
    authoritative: boolean;
}

export interface RateLimitWaitingEvent {
    scope: 'leader' | 'local' | 'ipc';
    waitStartTime: number;
    waitMs?: number;
    queuePosition?: number;
}

export interface RateLimitAcquireOptions {
    token?: vscode.CancellationToken;
    timeout?: number;
    onWaiting?: (event: RateLimitWaitingEvent) => void;
}

interface PendingWaiter {
    bucketKey: string;
    onWaiting?: (event: RateLimitWaitingEvent) => void;
    resolve: (result: PendingGrant | undefined) => void;
}

interface LeaderPendingWaiter {
    bucketKey: string;
    onWaiting?: (event: RateLimitWaitingEvent) => void;
    resolve: (result: PendingGrant | 'role-changed' | undefined) => void;
}

/** 降级恢复探测间隔 */
const PROBE_INTERVAL_MS = 60_000;
/** Leader 侧 pending 队列清扫间隔 */
const SWEEP_INTERVAL_MS = 1_000;
const MAX_SLEEP_CHUNK_MS = 2_147_483_647;
const MIN_LEASE_RENEW_INTERVAL_MS = 250;

/**
 * 跨实例限流器（静态门面）
 */
export class RateLimiter {
    private static initialized = false;
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

    /** 降级状态 */
    private static degraded = false;
    private static degradedNotified = false;
    private static lastProbeAt = 0;

    /** 可观测计数器 */
    private static counters = {
        acquires: 0,
        totalWaitMs: 0,
        ipcTimeouts: 0,
        rejected: 0,
        degradedEntries: 0,
        leaseReclaims: 0
    };

    static initialize(context: vscode.ExtensionContext): void {
        if (this.initialized) {
            return;
        }
        this.initialized = true;

        this.clientCore = new RateLimitClientCore({
            send: msg => {
                InterInstanceBus.publish({
                    type: 'rateLimitAcquireRequested',
                    payload: { requestId: msg.requestId, bucketKey: msg.bucketKey, costs: msg.costs, dims: msg.dims }
                });
            },
            sendCancel: msg => {
                InterInstanceBus.publish({
                    type: 'rateLimitAcquireCancelled',
                    payload: { requestId: msg.requestId, bucketKey: msg.bucketKey }
                });
            },
            onGrantEvent: handler => {
                const disposable = InterInstanceBus.subscribe('rateLimitAcquireGranted', event => {
                    handler(event.payload as RateLimitGrantMessage);
                });
                return () => disposable.dispose();
            },
            onQueueUpdateEvent: handler => {
                const disposable = InterInstanceBus.subscribe('rateLimitQueueUpdated', event => {
                    handler(event.payload as RateLimitQueueUpdateMessage);
                });
                return () => disposable.dispose();
            },
            isTransportHealthy: () => InterInstanceBus.isConnected(),
            now: () => Date.now(),
            nextRequestId: () => crypto.randomUUID()
        });

        // Leader 变更：成为 Leader 时重建权威桶（旧 Leader 状态不可知，空桶启动）
        this.leaderChangeSubscription = LeaderElectionService.onLeaderChanged(isLeader => {
            if (isLeader) {
                this.clientCore?.settlePendingAsDegraded('timeout');
                this.leaderStore = new RateLimitStore();
                this.exitDegraded('became leader');
                StatusLogger.info('[RateLimiter] Became leader, authoritative bucket reset (empty start)');
                return;
            }

            this.recoverLeaderWaitersAfterRoleChange();
            this.leaderStore = new RateLimitStore();
            StatusLogger.info('[RateLimiter] Lost leader role, pending leader waiters will reacquire');
        });

        // 周期清扫：Leader 桶的 pending 超时/授予 + lease 回收；本地桶的 lease 回收
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);

        context.subscriptions.push(
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
        this.counters.acquires++;

        return this.acquireForCurrentRole(bucketKey, dims, costs, options);
    }

    private static async acquireForCurrentRole(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions
    ): Promise<RateLimitHandle | undefined> {
        if (options?.token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        if (LeaderElectionService.isLeader()) {
            return this.acquireViaLeaderStore(bucketKey, dims, costs, options);
        }
        if (this.shouldUseIpc()) {
            const handle = await this.acquireViaIpc(bucketKey, dims, costs, options);
            if (handle) {
                return handle;
            }
            // IPC 失败已在 acquireViaIpc 内进入降级
            if (LeaderElectionService.isLeader()) {
                return this.acquireViaLeaderStore(bucketKey, dims, costs, options);
            }
        }
        return this.acquireViaLocalStore(bucketKey, dims, costs, options);
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
            InterInstanceBus.publish({
                type: 'rateLimitReleased',
                payload: { grantId: handle.grantId, refund }
            });
        } else {
            const granted = this.localStore.release(handle.grantId, refund, Date.now());
            this.distributeLocalGrants(granted);
        }
    }

    /** 可观测计数器快照（测试/调试用） */
    static getCounters(): Readonly<typeof RateLimiter.counters> {
        return this.counters;
    }

    /** 当前是否处于降级模式 */
    static isDegraded(): boolean {
        return this.degraded;
    }

    // ==================== Leader 侧：处理远端请求 ====================

    /**
     * Leader 处理远端 acquire 请求（extension.ts 订阅挂接）
     */
    static handleAcquireRequest(payload: {
        requestId: string;
        bucketKey: string;
        costs: RateLimitCosts;
        dims: RateLimitDimensions;
    }): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const result = this.leaderStore.acquire(
            payload.requestId,
            payload.bucketKey,
            payload.dims,
            payload.costs,
            Date.now()
        );
        if (result.kind === 'granted') {
            this.publishGranted(payload.requestId, true, result.waitMs, result.grantId);
        } else {
            this.publishQueueUpdated(payload.requestId, result.queuePosition);
        }
        // queued：等待 release/sweep 触发授予后统一回执
    }

    /**
     * Leader 处理远端 release（extension.ts 订阅挂接）
     */
    static handleRemoteRelease(payload: { grantId: string; refund?: RateLimitRefund }): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const granted = this.leaderStore.release(payload.grantId, payload.refund, Date.now());
        this.distributeLeaderGrants(granted);
    }

    static handleRemoteAcquireCancelled(payload: { requestId: string; bucketKey: string }): void {
        if (!LeaderElectionService.isLeader()) {
            return;
        }
        const granted = this.leaderStore.abortRequest(payload.bucketKey, payload.requestId, Date.now());
        this.distributeLeaderGrants(granted);
        this.publishQueuePositionUpdates(this.leaderStore.getPendingPositions(payload.bucketKey));
    }

    static handleRemoteLeaseRenewal(payload: { grantId: string }): void {
        if (!LeaderElectionService.isLeader()) {
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
        options?: RateLimitAcquireOptions
    ): Promise<RateLimitHandle | undefined> {
        const leaseMs = dims.lease ?? DEFAULT_RATE_LIMIT_LEASE_MS;
        const requestId = crypto.randomUUID();
        const result = this.leaderStore.acquire(requestId, bucketKey, dims, costs, Date.now());
        if (result.kind === 'granted') {
            Logger.debug(
                `[RateLimit] leader acquire granted: bucket=${bucketKey}, waitMs=${result.waitMs}, costs=${JSON.stringify(costs)}`
            );
            options?.onWaiting?.({ scope: 'leader', waitStartTime: Date.now(), waitMs: result.waitMs });
            const handle: RateLimitHandle = { grantId: result.grantId, bucketKey, costs, leaseMs, authoritative: true };
            await this.sleepOrRefund(result.waitMs, handle, options?.token);
            this.startLeaseHeartbeat(handle);
            return handle;
        }

        // queued：挂起直到 release/sweep 授予，按 FIFO 等待放行
        Logger.debug(`[RateLimit] leader acquire queued: bucket=${bucketKey}, costs=${JSON.stringify(costs)}`);
        const waitStartTime = Date.now();
        const grantPromise = this.waitForLeaderGrant(requestId, bucketKey, options?.token, options?.onWaiting);
        options?.onWaiting?.({ scope: 'leader', waitStartTime, queuePosition: result.queuePosition });
        const grant = await grantPromise;
        if (!grant) {
            // 仅取消才会走到这里
            throw new vscode.CancellationError();
        }
        if (grant === 'role-changed') {
            return this.acquireForCurrentRole(bucketKey, dims, costs, options);
        }
        Logger.debug(
            `[RateLimit] leader acquire granted: bucket=${bucketKey}, waitMs=${grant.waitMs}, costs=${JSON.stringify(costs)}`
        );
        options?.onWaiting?.({ scope: 'leader', waitStartTime: Date.now(), waitMs: grant.waitMs });
        const handle: RateLimitHandle = { grantId: grant.grantId, bucketKey, costs, leaseMs, authoritative: true };
        await this.sleepOrRefund(grant.waitMs, handle, options?.token);
        this.startLeaseHeartbeat(handle);
        return handle;
    }

    /** Follower：IPC 请求-回执；失败返回 undefined 并进入降级 */
    private static async acquireViaIpc(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions
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
                        scope: 'ipc',
                        waitStartTime: Date.now(),
                        queuePosition: msg.queuePosition
                    });
                }
            }
        );
        if (outcome.status === 'cancelled') {
            throw new vscode.CancellationError();
        }
        if (outcome.status === 'degraded') {
            if (LeaderElectionService.isLeader()) {
                return undefined;
            }
            if (outcome.reason === 'timeout') {
                this.counters.ipcTimeouts++;
            } else {
                this.counters.rejected++;
            }
            this.enterDegraded(outcome.reason);
            return undefined;
        }

        const handle: RateLimitHandle = {
            grantId: outcome.grantId,
            bucketKey,
            costs,
            leaseMs: dims.lease ?? DEFAULT_RATE_LIMIT_LEASE_MS,
            authoritative: true
        };
        Logger.debug(
            `[RateLimit] ipc acquire granted: bucket=${bucketKey}, waitMs=${outcome.waitMs}, costs=${JSON.stringify(costs)}`
        );
        options?.onWaiting?.({ scope: 'ipc', waitStartTime: Date.now(), waitMs: outcome.waitMs });
        await this.sleepOrRefund(outcome.waitMs, handle, options?.token);
        this.startLeaseHeartbeat(handle);
        this.exitDegraded('ipc acquire succeeded');
        return handle;
    }

    /** 本地降级桶：queued 时真实挂起等待授予（FIFO，不轮询抢槽位） */
    private static async acquireViaLocalStore(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        options?: RateLimitAcquireOptions
    ): Promise<RateLimitHandle | undefined> {
        const leaseMs = dims.lease ?? DEFAULT_RATE_LIMIT_LEASE_MS;
        const requestId = crypto.randomUUID();
        if (options?.token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const result = this.localStore.acquire(requestId, bucketKey, dims, costs, Date.now());
        if (result.kind === 'granted') {
            Logger.debug(
                `[RateLimit] local acquire granted: bucket=${bucketKey}, waitMs=${result.waitMs}, costs=${JSON.stringify(costs)}`
            );
            options?.onWaiting?.({ scope: 'local', waitStartTime: Date.now(), waitMs: result.waitMs });
            const handle: RateLimitHandle = {
                grantId: result.grantId,
                bucketKey,
                costs,
                leaseMs,
                authoritative: false
            };
            await this.sleepOrRefund(result.waitMs, handle, options?.token);
            this.startLeaseHeartbeat(handle);
            return handle;
        }

        Logger.debug(`[RateLimit] local acquire queued: bucket=${bucketKey}, costs=${JSON.stringify(costs)}`);
        const waitStartTime = Date.now();
        const grantPromise = this.waitForLocalGrant(requestId, bucketKey, options?.token, options?.onWaiting);
        options?.onWaiting?.({ scope: 'local', waitStartTime, queuePosition: result.queuePosition });
        const grant = await grantPromise;
        if (!grant) {
            throw new vscode.CancellationError();
        }
        Logger.debug(
            `[RateLimit] local acquire granted: bucket=${bucketKey}, waitMs=${grant.waitMs}, costs=${JSON.stringify(costs)}`
        );
        options?.onWaiting?.({ scope: 'local', waitStartTime: Date.now(), waitMs: grant.waitMs });
        const handle: RateLimitHandle = { grantId: grant.grantId, bucketKey, costs, leaseMs, authoritative: false };
        await this.sleepOrRefund(grant.waitMs, handle, options?.token);
        this.startLeaseHeartbeat(handle);
        return handle;
    }

    /** Leader 自身请求 queued 时的挂起等待（仅取消可打断，不超时） */
    private static waitForLeaderGrant(
        requestId: string,
        bucketKey: string,
        token?: vscode.CancellationToken,
        onWaiting?: (event: RateLimitWaitingEvent) => void
    ): Promise<PendingGrant | 'role-changed' | undefined> {
        return new Promise<PendingGrant | 'role-changed' | undefined>(resolve => {
            const cancelSub = token?.onCancellationRequested(() => {
                this.leaderWaiters.delete(requestId);
                this.leaderStore.cancelPending(bucketKey, requestId);
                this.notifyQueuePositionUpdates(
                    this.leaderStore.getPendingPositions(bucketKey),
                    this.leaderWaiters,
                    'leader'
                );
                resolve(undefined);
            });
            this.leaderWaiters.set(requestId, {
                bucketKey,
                onWaiting,
                resolve: result => {
                    cancelSub?.dispose();
                    resolve(result);
                }
            });
        });
    }

    /** 本地降级桶 queued 时的挂起等待（仅取消可打断，不超时） */
    private static waitForLocalGrant(
        requestId: string,
        bucketKey: string,
        token?: vscode.CancellationToken,
        onWaiting?: (event: RateLimitWaitingEvent) => void
    ): Promise<PendingGrant | undefined> {
        return new Promise(resolve => {
            const cancelSub = token?.onCancellationRequested(() => {
                this.localWaiters.delete(requestId);
                this.localStore.cancelPending(bucketKey, requestId);
                this.notifyQueuePositionUpdates(
                    this.localStore.getPendingPositions(bucketKey),
                    this.localWaiters,
                    'local'
                );
                resolve(undefined);
            });
            this.localWaiters.set(requestId, {
                bucketKey,
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
        scope: 'leader' | 'local'
    ): void {
        const waitStartTime = Date.now();
        for (const entry of pending) {
            const waiter = waiters.get(entry.requestId);
            if (!waiter?.onWaiting) {
                continue;
            }
            waiter.onWaiting({
                scope,
                waitStartTime,
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
        token?: vscode.CancellationToken
    ): Promise<void> {
        if (waitMs <= 0) {
            return;
        }
        this.counters.totalWaitMs += waitMs;
        try {
            await this.sleep(waitMs, token);
        } catch (error) {
            this.release(handle, { requests: handle.costs.requests, tokens: handle.costs.tokens });
            throw error;
        }
    }

    private static sleep(ms: number, token?: vscode.CancellationToken): Promise<void> {
        return new Promise((resolve, reject) => {
            let remainingMs = ms;
            let timer: NodeJS.Timeout | undefined;
            let settled = false;
            const cleanup = () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                cancelSub?.dispose();
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
            InterInstanceBus.publish({
                type: 'rateLimitLeaseRenewed',
                payload: { grantId: handle.grantId }
            });
            return true;
        }
        return this.localStore.renew(handle.grantId, now);
    }

    // ==================== 降级管理 ====================

    private static shouldUseIpc(): boolean {
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
            this.counters.degradedEntries++;
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
            const result = this.leaderStore.sweep(now);
            this.distributeLeaderGrants(result.granted);
        }
        const localResult = this.localStore.sweep(now);
        this.distributeLocalGrants(localResult.granted);
    }

    /** pending 授予分发：Leader 本地等待者优先，其余广播回执 */
    private static distributeLeaderGrants(granted: PendingGrant[]): void {
        const affectedBuckets = new Set<string>();
        for (const grant of granted) {
            const waiter = this.leaderWaiters.get(grant.requestId);
            if (waiter) {
                this.leaderWaiters.delete(grant.requestId);
                waiter.resolve(grant);
            } else {
                this.publishGranted(grant.requestId, true, grant.waitMs, grant.grantId);
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

    private static publishGranted(requestId: string, granted: boolean, waitMs: number, grantId?: string): void {
        InterInstanceBus.publish(
            {
                type: 'rateLimitAcquireGranted',
                payload: { requestId, granted, waitMs, grantId }
            },
            { alsoFallback: true }
        );
    }

    private static publishQueueUpdated(requestId: string, queuePosition: number): void {
        InterInstanceBus.publish({
            type: 'rateLimitQueueUpdated',
            payload: { requestId, queuePosition }
        });
    }

    private static publishQueuePositionUpdates(pending: PendingPosition[]): void {
        for (const entry of pending) {
            this.publishQueueUpdated(entry.requestId, entry.queuePosition);
        }
    }
}
