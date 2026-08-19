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

export interface RateLimitReservationSnapshot {
    grantId: string;
    endAt: number;
    cost?: number;
}

export interface RateLimitPaceStateSnapshot {
    emissionIntervalMs: number;
    reservations: RateLimitReservationSnapshot[];
}

export interface RateLimitPendingSnapshot {
    requestId: string;
    costs: RateLimitCosts;
    ownerInstanceId?: string;
}

export interface RateLimitGrantSnapshot {
    grantId: string;
    requestId: string;
    bucketKey: string;
    costs: RateLimitCosts;
    expiresAt: number;
    leaseMs: number;
    ownerInstanceId?: string;
}

export interface RateLimitBucketSnapshot {
    bucketKey: string;
    dims: RateLimitDimensions;
    paceRpm?: RateLimitPaceStateSnapshot;
    paceRps?: RateLimitPaceStateSnapshot;
    paceTpm?: RateLimitPaceStateSnapshot;
    pending: RateLimitPendingSnapshot[];
}

export interface RateLimitStoreSnapshot {
    buckets: RateLimitBucketSnapshot[];
    grants: RateLimitGrantSnapshot[];
}

interface ImportSnapshotOptions {
    ownerlessGrantGraceMs?: number;
}

interface GrantRecord {
    requestId: string;
    bucketKey: string;
    costs: RateLimitCosts;
    expiresAt: number;
    leaseMs: number;
    /** 发起方实例 ID（本地请求为空），实例断线时据此回收 */
    ownerInstanceId?: string;
}

interface PendingEntry {
    requestId: string;
    costs: RateLimitCosts;
    ownerInstanceId?: string;
}

interface PaceReservation {
    grantId: string;
    endAt: number;
    cost: number;
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

function isPositiveFiniteRate(rate: number | undefined): rate is number {
    return Number.isFinite(rate) && (rate as number) > 0;
}

const RATE_LIMIT_DIM_KEYS = ['rpm', 'rps', 'tpm', 'parallel'] as const;

/**
 * 清洗权威限流维度：只保留有限正数。
 * - 无配置 → `{}`（不限流）
 * - `0` 表示该维不限，清洗后省略
 * - 出现 NaN/Infinity/负数且清洗后无有效正数维 → `undefined`（fail-closed）
 */
export function sanitizeAuthoritativeDims(
    providerLimit?: RateLimitConfig,
    modelLimit?: RateLimitConfig
): RateLimitDimensions | undefined {
    if (!providerLimit && !modelLimit) {
        return {};
    }
    const merged: RateLimitDimensions = { ...providerLimit, ...modelLimit };
    const sanitized: RateLimitDimensions = {};
    let hasInvalid = false;
    for (const key of RATE_LIMIT_DIM_KEYS) {
        const value = merged[key];
        if (value === undefined) {
            continue;
        }
        if (isPositiveFiniteRate(value)) {
            sanitized[key] = value;
            continue;
        }
        if (value === 0) {
            continue;
        }
        hasInvalid = true;
    }
    if (hasInvalid && Object.keys(sanitized).length === 0) {
        return undefined;
    }
    return sanitized;
}

function makePaceStates(dims: RateLimitDimensions): Pick<BucketState, 'paceRpm' | 'paceRps' | 'paceTpm'> {
    const rpmInterval = isPositiveFiniteRate(dims.rpm) ? intervalFromPerMinute(dims.rpm) : undefined;
    const rpsInterval = isPositiveFiniteRate(dims.rps) ? intervalFromPerSecond(dims.rps) : undefined;
    const tpmInterval = isPositiveFiniteRate(dims.tpm) ? intervalFromPerMinute(dims.tpm) : undefined;
    return {
        paceRpm: rpmInterval !== undefined ? makePaceState(rpmInterval) : undefined,
        paceRps: rpsInterval !== undefined ? makePaceState(rpsInterval) : undefined,
        paceTpm: tpmInterval !== undefined ? makePaceState(tpmInterval) : undefined
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
     * @param opts.ownerInstanceId 发起方实例 ID，用于断线回收
     */
    acquire(
        requestId: string,
        bucketKey: string,
        dims: RateLimitDimensions,
        costs: RateLimitCosts,
        now: number,
        opts?: { ownerInstanceId?: string }
    ): AcquireResult {
        const bucket = this.getOrCreateBucket(bucketKey, dims);
        bucket.dims = dims;
        this.reclaimExpiredLeases(now);

        const parallel = this.effectiveParallel(bucket);
        if (bucket.pending.length > 0 || (parallel !== undefined && bucket.inflight >= parallel)) {
            // 已有队列必须优先，避免容量变化时新请求插队
            bucket.pending.push({
                requestId,
                costs,
                ownerInstanceId: opts?.ownerInstanceId
            });
            return { kind: 'queued', queuePosition: bucket.pending.length };
        }

        return this.grantNow(requestId, bucketKey, bucket, costs, now, opts?.ownerInstanceId);
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
        if (!grant || grant.expiresAt <= now) {
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

    exportSnapshot(now: number): RateLimitStoreSnapshot {
        this.reclaimExpiredLeases(now);
        const grants = Array.from(this.grants.entries()).map(([grantId, grant]) => ({
            grantId,
            requestId: grant.requestId,
            bucketKey: grant.bucketKey,
            costs: { ...grant.costs },
            expiresAt: grant.expiresAt,
            leaseMs: grant.leaseMs,
            ownerInstanceId: grant.ownerInstanceId
        }));
        const grantIds = new Set(grants.map(grant => grant.grantId));
        const grantBucketKeys = new Set(grants.map(grant => grant.bucketKey));
        return {
            buckets: Array.from(this.buckets.entries()).flatMap(([bucketKey, bucket]) => {
                if (!grantBucketKeys.has(bucketKey)) {
                    return [];
                }
                return [
                    {
                        bucketKey,
                        dims: { ...bucket.dims },
                        paceRpm: this.exportPaceState(bucket.paceRpm, now, grantIds),
                        paceRps: this.exportPaceState(bucket.paceRps, now, grantIds),
                        paceTpm: this.exportPaceState(bucket.paceTpm, now, grantIds),
                        pending: []
                    }
                ];
            }),
            grants
        };
    }

    hasGrant(grantId: string): boolean {
        return this.grants.has(grantId);
    }

    getGrantOwnerInstanceId(grantId: string): string | undefined {
        return this.grants.get(grantId)?.ownerInstanceId;
    }

    hasRequest(bucketKey: string, requestId: string): boolean {
        const bucket = this.buckets.get(bucketKey);
        if (bucket?.pending.some(entry => entry.requestId === requestId)) {
            return true;
        }
        for (const grant of this.grants.values()) {
            if (grant.bucketKey === bucketKey && grant.requestId === requestId) {
                return true;
            }
        }
        return false;
    }

    importSnapshot(snapshot: RateLimitStoreSnapshot, now: number, options?: ImportSnapshotOptions): void {
        if (!isRateLimitStoreSnapshot(snapshot)) {
            throw new Error('Invalid rate-limit store snapshot');
        }
        this.buckets.clear();
        this.grants.clear();

        try {
            for (const bucketSnapshot of snapshot.buckets) {
                this.buckets.set(bucketSnapshot.bucketKey, {
                    dims: { ...bucketSnapshot.dims },
                    paceRpm: this.importPaceState(bucketSnapshot.paceRpm, now),
                    paceRps: this.importPaceState(bucketSnapshot.paceRps, now),
                    paceTpm: this.importPaceState(bucketSnapshot.paceTpm, now),
                    inflight: 0,
                    pending: bucketSnapshot.pending.map(entry => ({
                        requestId: entry.requestId,
                        costs: { ...entry.costs },
                        ownerInstanceId: entry.ownerInstanceId
                    }))
                });
            }

            const survivingGrantIds = new Set<string>();
            for (const grantSnapshot of snapshot.grants) {
                const expiresAt =
                    grantSnapshot.ownerInstanceId === undefined && options?.ownerlessGrantGraceMs !== undefined ?
                        Math.min(grantSnapshot.expiresAt, now + options.ownerlessGrantGraceMs)
                    :   grantSnapshot.expiresAt;
                if (expiresAt <= now) {
                    continue;
                }
                const bucket = this.buckets.get(grantSnapshot.bucketKey);
                if (!bucket) {
                    continue;
                }
                this.grants.set(grantSnapshot.grantId, {
                    requestId: grantSnapshot.requestId,
                    bucketKey: grantSnapshot.bucketKey,
                    costs: { ...grantSnapshot.costs },
                    expiresAt,
                    leaseMs: grantSnapshot.leaseMs,
                    ownerInstanceId: grantSnapshot.ownerInstanceId
                });
                survivingGrantIds.add(grantSnapshot.grantId);
                bucket.inflight += 1;
            }

            for (const bucket of this.buckets.values()) {
                this.retainPaceReservations(bucket.paceRpm, survivingGrantIds);
                this.retainPaceReservations(bucket.paceRps, survivingGrantIds);
                this.retainPaceReservations(bucket.paceTpm, survivingGrantIds);
            }
        } catch (error) {
            this.buckets.clear();
            this.grants.clear();
            throw error;
        }
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

    /**
     * 回收指定实例的全部排队项与持有 grant（实例断线时调用，避免幽灵占用阻塞 FIFO）
     */
    reclaimInstance(ownerInstanceId: string, now: number): { granted: PendingGrant[]; affectedBucketKeys: string[] } {
        if (!ownerInstanceId) {
            return { granted: [], affectedBucketKeys: [] };
        }
        const granted: PendingGrant[] = [];
        const affected = new Set<string>();
        for (const [bucketKey, bucket] of this.buckets) {
            const before = bucket.pending.length;
            bucket.pending = bucket.pending.filter(entry => entry.ownerInstanceId !== ownerInstanceId);
            if (bucket.pending.length !== before) {
                affected.add(bucketKey);
            }
        }
        const grantIds: string[] = [];
        for (const [grantId, grant] of this.grants) {
            if (grant.ownerInstanceId === ownerInstanceId) {
                grantIds.push(grantId);
            }
        }
        for (const grantId of grantIds) {
            const grant = this.grants.get(grantId);
            if (!grant) {
                continue;
            }
            affected.add(grant.bucketKey);
            this.grants.delete(grantId);
            const bucket = this.buckets.get(grant.bucketKey);
            if (!bucket) {
                continue;
            }
            bucket.inflight = Math.max(0, bucket.inflight - 1);
            granted.push(...this.flushPending(grant.bucketKey, bucket, now));
        }
        return { granted, affectedBucketKeys: [...affected] };
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
        toInterval: (perUnit: number) => number | undefined
    ): PaceState | undefined {
        if (!isPositiveFiniteRate(rate)) {
            return undefined;
        }
        const interval = toInterval(rate);
        if (interval === undefined) {
            return undefined;
        }
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
        now: number,
        ownerInstanceId?: string
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
            leaseMs,
            ownerInstanceId
        });
        return { kind: 'granted', grantId, waitMs };
    }

    private applyRefund(bucket: BucketState, grantId: string, refund: RateLimitRefund | undefined, now: number): void {
        if (!refund) {
            return;
        }
        if (Number.isFinite(refund.requests) && (refund.requests as number) > 0) {
            this.refundPacing(bucket.paceRpm, grantId, refund.requests as number, now);
            this.refundPacing(bucket.paceRps, grantId, refund.requests as number, now);
        }
        if (Number.isFinite(refund.tokens) && (refund.tokens as number) > 0) {
            this.refundPacing(bucket.paceTpm, grantId, refund.tokens as number, now);
        }
    }

    /** 槽位释放后按 FIFO 授予 pending（授予时点重算 waitMs 并扣 GCRA） */
    private flushPending(bucketKey: string, bucket: BucketState, now: number): PendingGrant[] {
        const granted: PendingGrant[] = [];
        const parallel = this.effectiveParallel(bucket);
        while (bucket.pending.length > 0 && (parallel === undefined || bucket.inflight < parallel)) {
            const entry = bucket.pending[0];
            bucket.pending.shift();
            const result = this.grantNow(entry.requestId, bucketKey, bucket, entry.costs, now, entry.ownerInstanceId);
            granted.push({ requestId: entry.requestId, bucketKey, grantId: result.grantId, waitMs: result.waitMs });
        }
        return granted;
    }

    /** 惰性回收过期租约（Follower 崩溃后槽位兜底）。
     *  过期时请求几乎必然已发出并真实消耗配额，故只回收并发槽位、不退 pacing，
     *  避免退款导致 tpm/rpm 超发；残留 reservation 由 pruneExpiredReservations 按时自愈 */
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
        if (!state || !Number.isFinite(cost) || cost <= 0) {
            return 0;
        }
        this.pruneExpiredReservations(state, now);
        const lastReservation = state.reservations[state.reservations.length - 1];
        const startAt = Math.max(lastReservation?.endAt ?? now, now);
        state.reservations.push({
            grantId,
            cost,
            endAt: startAt + cost * state.emissionIntervalMs
        });
        return startAt - now;
    }

    /**
     * 缩短指定 grant 的 pacing 占用。部分退款只缩短本笔 endAt，不前移后续 reservation，
     * 避免取消中间 grant 时后续请求重叠到同一放行时刻。
     */
    private refundPacing(state: PaceState | undefined, grantId: string, refundedCost: number, now: number): void {
        if (!state || !Number.isFinite(refundedCost) || refundedCost <= 0) {
            return;
        }
        this.pruneExpiredReservations(state, now);
        const index = state.reservations.findIndex(item => item.grantId === grantId);
        if (index < 0) {
            return;
        }
        const reservation = state.reservations[index]!;
        const remaining = reservation.cost - refundedCost;
        if (remaining <= 0) {
            // 全额退款直接移除本笔，不前移后续 reservation
            state.reservations.splice(index, 1);
            return;
        }
        const refundedMs = refundedCost * state.emissionIntervalMs;
        reservation.cost = remaining;
        reservation.endAt = Math.max(now, reservation.endAt - refundedMs);
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

    private exportPaceState(
        state: PaceState | undefined,
        now: number,
        allowedGrantIds: ReadonlySet<string>
    ): RateLimitPaceStateSnapshot | undefined {
        if (!state) {
            return undefined;
        }
        this.pruneExpiredReservations(state, now);
        const reservations = state.reservations.filter(reservation => allowedGrantIds.has(reservation.grantId));
        if (reservations.length === 0) {
            return undefined;
        }
        return {
            emissionIntervalMs: state.emissionIntervalMs,
            reservations: reservations.map(reservation => ({
                grantId: reservation.grantId,
                endAt: reservation.endAt,
                cost: reservation.cost
            }))
        };
    }

    private importPaceState(snapshot: RateLimitPaceStateSnapshot | undefined, now: number): PaceState | undefined {
        if (!snapshot) {
            return undefined;
        }
        if (!Number.isFinite(snapshot.emissionIntervalMs) || snapshot.emissionIntervalMs <= 0) {
            return undefined;
        }
        return {
            emissionIntervalMs: snapshot.emissionIntervalMs,
            reservations: snapshot.reservations
                .filter(reservation => reservation.endAt > now)
                .map(reservation => ({
                    grantId: reservation.grantId,
                    endAt: reservation.endAt,
                    cost:
                        Number.isFinite(reservation.cost) && (reservation.cost as number) > 0 ?
                            (reservation.cost as number)
                        :   0
                }))
        };
    }

    private retainPaceReservations(state: PaceState | undefined, allowedGrantIds: ReadonlySet<string>): void {
        if (!state) {
            return;
        }
        state.reservations = state.reservations.filter(reservation => allowedGrantIds.has(reservation.grantId));
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRateLimitCosts(value: unknown): value is RateLimitCosts {
    return isRecord(value) && isFiniteNumber(value.requests) && isFiniteNumber(value.tokens);
}

function isRateLimitReservationSnapshot(value: unknown): value is RateLimitReservationSnapshot {
    if (!isRecord(value) || typeof value.grantId !== 'string' || !isFiniteNumber(value.endAt)) {
        return false;
    }
    return value.cost === undefined || isFiniteNumber(value.cost);
}

function isRateLimitPaceStateSnapshot(value: unknown): value is RateLimitPaceStateSnapshot {
    return (
        isRecord(value) &&
        isFiniteNumber(value.emissionIntervalMs) &&
        Array.isArray(value.reservations) &&
        value.reservations.every(isRateLimitReservationSnapshot)
    );
}

function isRateLimitPendingSnapshot(value: unknown): value is RateLimitPendingSnapshot {
    return (
        isRecord(value) &&
        typeof value.requestId === 'string' &&
        isRateLimitCosts(value.costs) &&
        (value.ownerInstanceId === undefined || typeof value.ownerInstanceId === 'string')
    );
}

function isRateLimitGrantSnapshot(value: unknown): value is RateLimitGrantSnapshot {
    return (
        isRecord(value) &&
        typeof value.grantId === 'string' &&
        typeof value.requestId === 'string' &&
        typeof value.bucketKey === 'string' &&
        isRateLimitCosts(value.costs) &&
        isFiniteNumber(value.expiresAt) &&
        isFiniteNumber(value.leaseMs) &&
        (value.ownerInstanceId === undefined || typeof value.ownerInstanceId === 'string')
    );
}

function isRateLimitBucketSnapshot(value: unknown): value is RateLimitBucketSnapshot {
    return (
        isRecord(value) &&
        typeof value.bucketKey === 'string' &&
        isRecord(value.dims) &&
        Array.isArray(value.pending) &&
        value.pending.every(isRateLimitPendingSnapshot) &&
        (value.paceRpm === undefined || isRateLimitPaceStateSnapshot(value.paceRpm)) &&
        (value.paceRps === undefined || isRateLimitPaceStateSnapshot(value.paceRps)) &&
        (value.paceTpm === undefined || isRateLimitPaceStateSnapshot(value.paceTpm))
    );
}

export function isRateLimitStoreSnapshot(value: unknown): value is RateLimitStoreSnapshot {
    return (
        isRecord(value) &&
        Array.isArray(value.buckets) &&
        Array.isArray(value.grants) &&
        value.buckets.every(isRateLimitBucketSnapshot) &&
        value.grants.every(isRateLimitGrantSnapshot)
    );
}
