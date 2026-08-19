/*---------------------------------------------------------------------------------------------
 *  Follower 端限流请求-回执状态机
 *  纯逻辑模块：注入 send/onEvent/now/sleep 接口，不依赖 vscode，node:test 可测
 *  职责：发起 acquire → 等待 granted 回执（幂等匹配）→ 超时降级 → sleep waitMs（可取消）
 *--------------------------------------------------------------------------------------------*/

import type {
    RateLimitAcquireCancelledEvent,
    RateLimitAcquireGrantedEvent,
    RateLimitAcquireRequestedEvent,
    RateLimitQueueUpdatedEvent,
    RateLimitReleasedEvent
} from '../interInstance';
import { DEFAULT_RATE_LIMIT_LEASE_MS, type RateLimitCosts, type RateLimitDimensions } from './rateLimitStore';

export type RateLimitGrantMessage = RateLimitAcquireGrantedEvent['payload'];

export type RateLimitQueueUpdateMessage = RateLimitQueueUpdatedEvent['payload'];

export type RateLimitAcquireRequestMessage = RateLimitAcquireRequestedEvent['payload'];

export type AcquireOutcome =
    | { status: 'granted'; grantId: string; waitMs: number; authorityTerm: string }
    | { status: 'authority-changed' }
    | { status: 'degraded'; reason: 'timeout' | 'authority-unavailable' }
    | { status: 'cancelled' };

export interface RateLimitClientCoreOptions {
    /** 回执等待超时（毫秒），默认 3000 */
    timeout?: number;
    /** 当前 IPC 传输是否仍健康可用 */
    isTransportHealthy?: () => boolean;
    /** 当前连接到的限流权威任期；缺失时表示当前不可用 */
    getAuthorityTerm?: () => string | undefined;
    /** 角色/连接切换中：term 短暂缺失时不要把在途请求结算为 authority-unavailable */
    isAuthorityTransitioning?: () => boolean;
    /** 发送 acquire 请求（完整负载） */
    send: (msg: RateLimitAcquireRequestMessage) => void;
    /** 发送 acquire cancel 请求 */
    sendCancel?: (msg: RateLimitAcquireCancelledEvent['payload']) => void;
    /** 迟到 grant 到达后立即释放权威槽位，避免超时降级与迟到授予双重计数 */
    sendRelease?: (msg: RateLimitReleasedEvent['payload']) => void;
    /** 订阅 granted 回执；返回取消订阅函数 */
    onGrantEvent: (handler: (msg: RateLimitGrantMessage) => void) => () => void;
    /** 订阅排队顺位更新；返回取消订阅函数 */
    onQueueUpdateEvent?: (handler: (msg: RateLimitQueueUpdateMessage) => void) => () => void;
    /** 当前时间（毫秒） */
    now: () => number;
    /** 生成请求 ID */
    nextRequestId?: () => string;
}

export interface RateLimitAcquireOptions {
    timeout?: number;
    onQueueUpdate?: (msg: RateLimitQueueUpdateMessage) => void;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 3_000;
const LATE_GRANT_WATCH_MS = Math.min(10_000, Math.max(1_000, Math.floor(DEFAULT_RATE_LIMIT_LEASE_MS / 60)));

interface LateGrantWatch {
    authorityTerm: string;
    expireAt: number;
}

interface PendingWaiter {
    bucketKey: string;
    authorityTerm: string;
    resolve: (outcome: AcquireOutcome) => void;
    settled: boolean;
    queueAcknowledged: boolean;
    lastQueuePosition?: number;
    timeoutMs: number;
    timeout?: NodeJS.Timeout;
    cancelCheck?: NodeJS.Timeout;
    onQueueUpdate?: (msg: RateLimitQueueUpdateMessage) => void;
}

/**
 * Follower 端限流客户端核心
 * 并发安全：每个 acquire 用独立 requestId 匹配回执，首次匹配即 settle，重复回执为 no-op
 */
export class RateLimitClientCore {
    private readonly pending = new Map<string, PendingWaiter>();
    private readonly lateWatch = new Map<string, LateGrantWatch>();
    private readonly unsubscribeGrant: () => void;
    private readonly unsubscribeQueueUpdate?: () => void;
    private requestSeq = 0;
    private readonly timeout: number;

    constructor(private readonly options: RateLimitClientCoreOptions) {
        this.timeout = options.timeout ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
        this.unsubscribeGrant = options.onGrantEvent(msg => this.handleGrant(msg));
        this.unsubscribeQueueUpdate = options.onQueueUpdateEvent?.(msg => this.handleQueueUpdate(msg));
    }

    /**
     * 发起一次限流申请
     * - granted：携带 waitMs，调用方需自行 sleep 后发请求
     * - degraded：超时，调用方走本地降级桶
     * - cancelled：等待期间被取消
     */
    async acquire(
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        signal?: { isCancelled: () => boolean },
        options?: RateLimitAcquireOptions
    ): Promise<AcquireOutcome> {
        this.pruneLateGrantWatches();
        if (signal?.isCancelled()) {
            return { status: 'cancelled' };
        }
        const authorityTerm = this.options.getAuthorityTerm?.();
        if (!authorityTerm) {
            if (this.options.isAuthorityTransitioning?.()) {
                return { status: 'degraded', reason: 'timeout' };
            }
            return { status: 'degraded', reason: 'authority-unavailable' };
        }
        const requestId = this.options.nextRequestId?.() ?? `rl-${++this.requestSeq}-${this.options.now()}`;
        const timeout = options?.timeout ?? this.timeout;
        const outcome = await new Promise<AcquireOutcome>(resolve => {
            const waiter: PendingWaiter = {
                bucketKey,
                authorityTerm,
                resolve,
                settled: false,
                queueAcknowledged: false,
                timeoutMs: timeout,
                onQueueUpdate: options?.onQueueUpdate
            };
            waiter.timeout = this.armTimeout(requestId, waiter);
            this.pending.set(requestId, waiter);
            this.options.send({ authorityTerm, requestId, bucketKey, dims, costs });
            // 任期切换不会主动推送到此纯逻辑模块，等待中需要本地轮询观察。
            if (signal || this.options.isTransportHealthy || this.options.getAuthorityTerm) {
                waiter.cancelCheck = setInterval(() => {
                    if (signal?.isCancelled() && !waiter.settled) {
                        waiter.settled = true;
                        if (waiter.timeout) {
                            clearTimeout(waiter.timeout);
                        }
                        clearInterval(waiter.cancelCheck);
                        this.pending.delete(requestId);
                        this.options.sendCancel?.({
                            authorityTerm: waiter.authorityTerm,
                            requestId,
                            bucketKey: waiter.bucketKey
                        });
                        resolve({ status: 'cancelled' });
                        return;
                    }
                    const currentAuthorityTerm = this.options.getAuthorityTerm?.();
                    if (
                        this.options.getAuthorityTerm &&
                        currentAuthorityTerm !== waiter.authorityTerm &&
                        !waiter.settled
                    ) {
                        if (!currentAuthorityTerm) {
                            if (this.options.isAuthorityTransitioning?.()) {
                                return;
                            }
                            this.settleAuthorityUnavailable(requestId, waiter);
                        } else {
                            this.settleAuthorityChanged(requestId, waiter);
                        }
                        return;
                    }
                    if (this.options.isTransportHealthy && !this.options.isTransportHealthy() && !waiter.settled) {
                        if (this.options.isAuthorityTransitioning?.()) {
                            return;
                        }
                        this.settleAuthorityUnavailable(requestId, waiter);
                        return;
                    }
                    if (waiter.settled) {
                        clearInterval(waiter.cancelCheck);
                    }
                }, 100);
            }
        });
        return outcome;
    }

    /** 初次回执超时：尚未收到权威确认时降级；入队确认后由授权/取消/断线结算 */
    private armTimeout(requestId: string, waiter: PendingWaiter): NodeJS.Timeout {
        return setTimeout(() => {
            if (waiter.settled) {
                return;
            }
            waiter.settled = true;
            this.pending.delete(requestId);
            this.watchLateGrant(requestId, waiter.authorityTerm);
            if (waiter.cancelCheck) {
                clearInterval(waiter.cancelCheck);
            }
            this.options.sendCancel?.({
                authorityTerm: waiter.authorityTerm,
                requestId,
                bucketKey: waiter.bucketKey
            });
            waiter.resolve({ status: 'degraded', reason: 'timeout' });
        }, waiter.timeoutMs);
    }

    /**
     * 回执处理：首次匹配即 settle，后续重复回执忽略
     */
    private handleGrant(msg: RateLimitGrantMessage): void {
        this.releaseLateGrantIfNeeded(msg);
        const waiter = this.pending.get(msg.requestId);
        if (!waiter || waiter.settled) {
            return;
        }
        const currentAuthorityTerm = this.options.getAuthorityTerm?.();
        if (this.options.getAuthorityTerm && currentAuthorityTerm !== waiter.authorityTerm) {
            if (!currentAuthorityTerm) {
                if (this.options.isAuthorityTransitioning?.()) {
                    return;
                }
                this.settleAuthorityUnavailable(msg.requestId, waiter);
            } else {
                this.settleAuthorityChanged(msg.requestId, waiter);
            }
            return;
        }
        if (msg.authorityTerm !== waiter.authorityTerm) {
            return;
        }
        if (!msg.grantId) {
            this.settleInvalidGrant(msg.requestId, waiter);
            return;
        }
        waiter.settled = true;
        if (waiter.timeout) {
            clearTimeout(waiter.timeout);
        }
        if (waiter.cancelCheck) {
            clearInterval(waiter.cancelCheck);
        }
        this.pending.delete(msg.requestId);
        waiter.resolve({
            status: 'granted',
            grantId: msg.grantId,
            waitMs: msg.waitMs,
            authorityTerm: msg.authorityTerm
        });
    }

    private handleQueueUpdate(msg: RateLimitQueueUpdateMessage): void {
        const waiter = this.pending.get(msg.requestId);
        if (!waiter || waiter.settled) {
            return;
        }
        const currentAuthorityTerm = this.options.getAuthorityTerm?.();
        if (this.options.getAuthorityTerm && currentAuthorityTerm !== waiter.authorityTerm) {
            if (!currentAuthorityTerm) {
                if (this.options.isAuthorityTransitioning?.()) {
                    return;
                }
                this.settleAuthorityUnavailable(msg.requestId, waiter);
            } else {
                this.settleAuthorityChanged(msg.requestId, waiter);
            }
            return;
        }
        if (msg.authorityTerm !== waiter.authorityTerm) {
            return;
        }
        if (!waiter.queueAcknowledged) {
            waiter.queueAcknowledged = true;
            waiter.lastQueuePosition = msg.queuePosition;
            if (waiter.timeout) {
                clearTimeout(waiter.timeout);
                waiter.timeout = undefined;
            }
        } else if ((waiter.lastQueuePosition ?? Number.POSITIVE_INFINITY) > msg.queuePosition) {
            waiter.lastQueuePosition = msg.queuePosition;
        }
        if (!waiter.onQueueUpdate) {
            return;
        }
        waiter.onQueueUpdate(msg);
    }

    /** 待处理的等待数（观测用） */
    get pendingCount(): number {
        return this.pending.size;
    }

    settlePendingAsDegraded(): void {
        for (const [requestId, waiter] of this.pending) {
            if (waiter.settled) {
                continue;
            }
            waiter.settled = true;
            if (waiter.timeout) {
                clearTimeout(waiter.timeout);
            }
            if (waiter.cancelCheck) {
                clearInterval(waiter.cancelCheck);
            }
            this.pending.delete(requestId);
            this.options.sendCancel?.({
                authorityTerm: waiter.authorityTerm,
                requestId,
                bucketKey: waiter.bucketKey
            });
            waiter.resolve({ status: 'degraded', reason: 'timeout' });
        }
    }

    private watchLateGrant(requestId: string, authorityTerm: string): void {
        this.pruneLateGrantWatches();
        this.lateWatch.set(requestId, {
            authorityTerm,
            expireAt: this.options.now() + LATE_GRANT_WATCH_MS
        });
    }

    private releaseLateGrantIfNeeded(msg: RateLimitGrantMessage): void {
        this.pruneLateGrantWatches();
        const watch = this.lateWatch.get(msg.requestId);
        if (!watch) {
            return;
        }
        this.lateWatch.delete(msg.requestId);
        if (this.options.now() > watch.expireAt || !msg.grantId || msg.authorityTerm !== watch.authorityTerm) {
            return;
        }
        this.options.sendRelease?.({
            authorityTerm: msg.authorityTerm,
            grantId: msg.grantId
        });
    }

    private pruneLateGrantWatches(now: number = this.options.now()): void {
        for (const [requestId, watch] of this.lateWatch) {
            if (watch.expireAt <= now) {
                this.lateWatch.delete(requestId);
            }
        }
    }

    private settleAuthorityChanged(requestId: string, waiter: PendingWaiter): void {
        if (waiter.settled) {
            return;
        }
        waiter.settled = true;
        if (waiter.timeout) {
            clearTimeout(waiter.timeout);
        }
        if (waiter.cancelCheck) {
            clearInterval(waiter.cancelCheck);
        }
        this.pending.delete(requestId);
        this.options.sendCancel?.({
            authorityTerm: waiter.authorityTerm,
            requestId,
            bucketKey: waiter.bucketKey
        });
        waiter.resolve({ status: 'authority-changed' });
    }

    private settleAuthorityUnavailable(requestId: string, waiter: PendingWaiter): void {
        if (waiter.settled) {
            return;
        }
        waiter.settled = true;
        if (waiter.timeout) {
            clearTimeout(waiter.timeout);
        }
        if (waiter.cancelCheck) {
            clearInterval(waiter.cancelCheck);
        }
        this.pending.delete(requestId);
        this.options.sendCancel?.({
            authorityTerm: waiter.authorityTerm,
            requestId,
            bucketKey: waiter.bucketKey
        });
        waiter.resolve({ status: 'degraded', reason: 'authority-unavailable' });
    }

    private settleInvalidGrant(requestId: string, waiter: PendingWaiter): void {
        if (waiter.settled) {
            return;
        }
        waiter.settled = true;
        if (waiter.timeout) {
            clearTimeout(waiter.timeout);
        }
        if (waiter.cancelCheck) {
            clearInterval(waiter.cancelCheck);
        }
        this.pending.delete(requestId);
        this.options.sendCancel?.({
            authorityTerm: waiter.authorityTerm,
            requestId,
            bucketKey: waiter.bucketKey
        });
        waiter.resolve({ status: 'degraded', reason: 'timeout' });
    }

    dispose(): void {
        this.unsubscribeGrant();
        this.unsubscribeQueueUpdate?.();
        this.lateWatch.clear();
        this.settlePendingAsDegraded();
    }
}
