/*---------------------------------------------------------------------------------------------
 *  限流桶存储（Leader 权威计数核心）
 *  每桶键：三维 GCRA（rpm/rps/tpm）+ 并发槽位 + pending FIFO 队列
 *  纯逻辑模块：全部方法同步、由调用方注入 now，不依赖 vscode / 定时器
 *--------------------------------------------------------------------------------------------*/

import type { RateLimitConfig } from '../types/sharedTypes';
import { intervalFromPerMinute, intervalFromPerSecond } from './gcra';

export type RateLimitDimensions = RateLimitConfig;

export const DEFAULT_RATE_LIMIT_LEASE_MS = 600_000;

/** 单次 acquire 的成本 */
export interface RateLimitCosts {
    requests: number;
    tokens: number;
}

/** release 退款（未提供的字段不退） */
export interface RateLimitRefund {
    requests?: number;
    tokens?: number;
}

export type AcquireResult =
    | { kind: 'granted'; grantId: string; waitMs: number }
    | { kind: 'queued'; queuePosition: number };

/** pending 授予结果（Leader 宿主据此回发 granted 事件） */
export interface PendingGrant {
    requestId: string;
    bucketKey: string;
    grantId: string;
    waitMs: number;
}

export interface PendingPosition {
    requestId: string;
    queuePosition: number;
}

interface GrantRecord {
    requestId: string;
    bucketKey: string;
    costs: RateLimitCosts;
    expiresAt: number;
    leaseMs: number;
}

interface PendingEntry {
    requestId: string;
    costs: RateLimitCosts;
}

interface PaceReservation {
    grantId: string;
    endAt: number;
}

interface PaceState {
    emissionIntervalMs: number;
    reservations: PaceReservation[];
}

interface BucketState {
    dims: RateLimitDimensions;
    paceRpm?: PaceState;
    paceRps?: PaceState;
    paceTpm?: PaceState;
    inflight: number;
    pending: PendingEntry[];
}

function makePaceState(emissionIntervalMs: number): PaceState {
    return { emissionIntervalMs, reservations: [] };
}

function makePaceStates(dims: RateLimitDimensions): Pick<BucketState, 'paceRpm' | 'paceRps' | 'paceTpm'> {
    return {
        paceRpm: dims.rpm && dims.rpm > 0 ? makePaceState(intervalFromPerMinute(dims.rpm)) : undefined,
        paceRps: dims.rps && dims.rps > 0 ? makePaceState(intervalFromPerSecond(dims.rps)) : undefined,
        paceTpm: dims.tpm && dims.tpm > 0 ? makePaceState(intervalFromPerMinute(dims.tpm)) : undefined
    };
}

/**
 * 限流桶存储
 * Leader 进程内单实例；Follower 降级模式下同样使用本地实例
 */
export class RateLimitStore {
    private readonly buckets = new Map<string, BucketState>();
    private readonly grants = new Map<string, GrantRecord>();
    private grantSeq = 0;
    /** 实例级随机后缀：Leader 切换后旧 grantId 不会误命中新 grant */
    private readonly instanceTag: string;
    private readonly defaultLeaseMs: number;

    constructor(instanceTag?: string, defaultLeaseMs = DEFAULT_RATE_LIMIT_LEASE_MS) {
        this.instanceTag = instanceTag ?? Math.random().toString(36).slice(2, 10);
        this.defaultLeaseMs = defaultLeaseMs;
    }

    /**
     * 申请配额（同步；并发满时排队，由 release/sweep 触发后续授予）
     */
    acquire(
        requestId: string,
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        now: number
    ): AcquireResult {
        const bucket = this.getOrCreateBucket(bucketKey, dims);
        bucket.dims = dims;
        this.reclaimExpiredLeases(now);

        const parallel = this.effectiveParallel(bucket);
        if (bucket.pending.length > 0 || (parallel !== undefined && bucket.inflight >= parallel)) {
            // 已有队列必须优先，避免容量变化时新请求插队
            bucket.pending.push({
                requestId,
                costs
            });
            return { kind: 'queued', queuePosition: bucket.pending.length };
        }

        return this.grantNow(requestId, bucketKey, bucket, costs, now);
    }

    /**
     * 释放 grant（幂等）；返回因槽位释放而被授予的 pending 请求
     */
    release(grantId: string, refund: RateLimitRefund | undefined, now: number): PendingGrant[] {
        const grant = this.grants.get(grantId);
        if (!grant) {
            return [];
        }
        this.grants.delete(grantId);
        const bucket = this.buckets.get(grant.bucketKey);
        if (!bucket) {
            return [];
        }
        bucket.inflight = Math.max(0, bucket.inflight - 1);
        this.applyRefund(bucket, grantId, refund, now);
        return this.flushPending(grant.bucketKey, bucket, now);
    }

    renew(grantId: string, now: number): boolean {
        const grant = this.grants.get(grantId);
        if (!grant) {
            return false;
        }
        grant.expiresAt = Math.max(grant.expiresAt, now + grant.leaseMs);
        return true;
    }

    /**
     * 周期清扫：回收过期 lease，并授予 pending（FIFO 依次放行）
     */
    sweep(now: number): PendingGrant[] {
        const granted: PendingGrant[] = [];
        this.reclaimExpiredLeases(now);
        for (const [bucketKey, bucket] of this.buckets) {
            granted.push(...this.flushPending(bucketKey, bucket, now));
        }
        return granted;
    }

    /** 观测用：桶当前状态快照 */
    stats(bucketKey: string, now: number): { inflight: number; pending: number; waitMs: number } | undefined {
        const bucket = this.buckets.get(bucketKey);
        if (!bucket) {
            return undefined;
        }
        const waitMs = Math.max(
            this.peekPacingWait(bucket.paceRpm, now),
            this.peekPacingWait(bucket.paceRps, now),
            this.peekPacingWait(bucket.paceTpm, now)
        );
        return { inflight: bucket.inflight, pending: bucket.pending.length, waitMs };
    }

    getPendingPositions(bucketKey: string): PendingPosition[] {
        const bucket = this.buckets.get(bucketKey);
        if (!bucket) {
            return [];
        }
        return bucket.pending.map((entry, index) => ({ requestId: entry.requestId, queuePosition: index + 1 }));
    }

    /**
     * 取消排队中的 pending 请求（等待期取消时调用）
     * @returns true 表示已移除；false 表示不存在（可能已被授予）
     */
    cancelPending(bucketKey: string, requestId: string): boolean {
        const bucket = this.buckets.get(bucketKey);
        if (!bucket) {
            return false;
        }
        const idx = bucket.pending.findIndex(e => e.requestId === requestId);
        if (idx < 0) {
            return false;
        }
        bucket.pending.splice(idx, 1);
        return true;
    }

    abortRequest(bucketKey: string, requestId: string, now: number): PendingGrant[] {
        if (this.cancelPending(bucketKey, requestId)) {
            return [];
        }
        for (const [grantId, grant] of this.grants) {
            if (grant.bucketKey === bucketKey && grant.requestId === requestId) {
                return this.release(grantId, grant.costs, now);
            }
        }
        return [];
    }

    private getOrCreateBucket(bucketKey: string, dims: RateLimitDimensions): BucketState {
        let bucket = this.buckets.get(bucketKey);
        if (!bucket) {
            bucket = { dims, ...makePaceStates(dims), inflight: 0, pending: [] };
            this.buckets.set(bucketKey, bucket);
            return bucket;
        }
        this.syncPaceStates(bucket, dims);
        return bucket;
    }

    private syncPaceStates(bucket: BucketState, dims: RateLimitDimensions): void {
        bucket.paceRpm = this.syncPaceState(bucket.paceRpm, dims.rpm, intervalFromPerMinute);
        bucket.paceRps = this.syncPaceState(bucket.paceRps, dims.rps, intervalFromPerSecond);
        bucket.paceTpm = this.syncPaceState(bucket.paceTpm, dims.tpm, intervalFromPerMinute);
    }

    private syncPaceState(
        existing: PaceState | undefined,
        rate: number | undefined,
        toInterval: (perUnit: number) => number
    ): PaceState | undefined {
        if (!rate || rate <= 0) {
            return undefined;
        }
        const interval = toInterval(rate);
        if (existing) {
            existing.emissionIntervalMs = interval;
            return existing;
        }
        return makePaceState(interval);
    }

    private effectiveParallel(bucket: BucketState): number | undefined {
        return bucket.dims.parallel && bucket.dims.parallel > 0 ? bucket.dims.parallel : undefined;
    }

    /** 授予即扣 GCRA 并预占并发槽位 */
    private grantNow(
        requestId: string,
        bucketKey: string,
        bucket: BucketState,
        costs: RateLimitCosts,
        now: number
    ): { kind: 'granted'; grantId: string; waitMs: number } {
        const grantId = `grant-${this.instanceTag}-${++this.grantSeq}`;
        const waitMs = Math.max(
            this.reservePacing(bucket.paceRpm, grantId, costs.requests, now),
            this.reservePacing(bucket.paceRps, grantId, costs.requests, now),
            this.reservePacing(bucket.paceTpm, grantId, costs.tokens, now)
        );
        bucket.inflight += 1;
        const leaseMs = this.defaultLeaseMs;
        this.grants.set(grantId, {
            requestId,
            bucketKey,
            costs: { ...costs },
            expiresAt: now + waitMs + leaseMs,
            leaseMs
        });
        return { kind: 'granted', grantId, waitMs };
    }

    private applyRefund(bucket: BucketState, grantId: string, refund: RateLimitRefund | undefined, now: number): void {
        if (!refund) {
            return;
        }
        if (refund.requests && refund.requests > 0) {
            this.refundPacing(bucket.paceRpm, grantId, now);
            this.refundPacing(bucket.paceRps, grantId, now);
        }
        if (refund.tokens && refund.tokens > 0) {
            this.refundPacing(bucket.paceTpm, grantId, now);
        }
    }

    /** 槽位释放后按 FIFO 授予 pending（授予时点重算 waitMs 并扣 GCRA） */
    private flushPending(bucketKey: string, bucket: BucketState, now: number): PendingGrant[] {
        const granted: PendingGrant[] = [];
        const parallel = this.effectiveParallel(bucket);
        while (bucket.pending.length > 0 && (parallel === undefined || bucket.inflight < parallel)) {
            const entry = bucket.pending[0];
            bucket.pending.shift();
            const result = this.grantNow(entry.requestId, bucketKey, bucket, entry.costs, now);
            granted.push({ requestId: entry.requestId, bucketKey, grantId: result.grantId, waitMs: result.waitMs });
        }
        return granted;
    }

    /** 惰性回收过期租约（Follower 崩溃后槽位兜底） */
    private reclaimExpiredLeases(now: number): void {
        for (const [grantId, grant] of this.grants) {
            if (grant.expiresAt <= now) {
                const bucket = this.buckets.get(grant.bucketKey);
                if (bucket) {
                    bucket.inflight = Math.max(0, bucket.inflight - 1);
                }
                this.grants.delete(grantId);
            }
        }
    }

    private reservePacing(state: PaceState | undefined, grantId: string, cost: number, now: number): number {
        if (!state || cost <= 0) {
            return 0;
        }
        this.pruneExpiredReservations(state, now);
        const lastReservation = state.reservations[state.reservations.length - 1];
        const startAt = Math.max(lastReservation?.endAt ?? now, now);
        state.reservations.push({
            grantId,
            endAt: startAt + cost * state.emissionIntervalMs
        });
        return startAt - now;
    }

    private refundPacing(state: PaceState | undefined, grantId: string, now: number): void {
        if (!state) {
            return;
        }
        this.pruneExpiredReservations(state, now);
        const index = state.reservations.findIndex(reservation => reservation.grantId === grantId);
        if (index >= 0) {
            state.reservations.splice(index, 1);
        }
    }

    private peekPacingWait(state: PaceState | undefined, now: number): number {
        if (!state) {
            return 0;
        }
        this.pruneExpiredReservations(state, now);
        const lastReservation = state.reservations[state.reservations.length - 1];
        return Math.max(0, (lastReservation?.endAt ?? now) - now);
    }

    private pruneExpiredReservations(state: PaceState, now: number): void {
        while (state.reservations.length > 0 && state.reservations[0]!.endAt <= now) {
            state.reservations.shift();
        }
    }
}
