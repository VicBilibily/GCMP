import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export interface ResponsesConnectionIdentity {
    readonly ownerId: string;
    readonly provider: string;
    readonly modelId: string;
    readonly sessionId: string;
    readonly origin: string;
    readonly purpose: string;
    readonly branchId: string;
    readonly binding: string;
}

export interface ResponsesConnection {
    readonly opened: Promise<void>;
    readonly closed: Promise<void>;
    readonly reusable: boolean;
    interrupt(error: Error): void;
    close(): Promise<void>;
}

export interface ResponsesClock {
    now(): number;
    schedule(callback: () => void, delay: number): () => void;
}

export const responsesClock: ResponsesClock = {
    now: () => performance.now(),
    schedule(callback, delay) {
        const timer = setTimeout(callback, delay);
        timer.unref();
        return () => clearTimeout(timer);
    }
};

interface PoolLimits {
    maximum: number;
    perProvider: number;
    idleMs: number;
    lifetimeMs: number;
    requestMs: number;
}

interface FailureRecord {
    ownerId: string;
    times: number[];
    blockedUntil: number;
    probe: boolean;
}

const FAILURE_WINDOW_MS = 300_000;
const MAX_FAILURE_RECORDS = 1024;

interface PoolEntry {
    identity: ResponsesConnectionIdentity;
    key: string;
    connection: ResponsesConnection;
    generation: number;
    openedAt?: number;
    idleAt?: number;
    lease?: symbol;
    retiring: boolean;
    physicallyClosed: boolean;
    cancelIdle?: () => void;
    cancelLifetime?: () => void;
    cleanup?: Promise<void>;
    cancelLease?: () => void;
}

export interface ResponsesConnectionLease {
    readonly connection: ResponsesConnection;
    readonly generation: number;
    readonly requestDeadline: number;
    isCurrent(): boolean;
    release(reusable: boolean): void;
}

export class ResponsesConnectionPool {
    private readonly secret = randomBytes(32);
    private readonly entries = new Set<PoolEntry>();
    private readonly available = new Map<string, PoolEntry>();
    private readonly stoppedOwners = new Set<string>();
    private readonly ownerCleanup = new Map<string, Promise<void>>();
    private readonly activeLeases = new Map<symbol, PoolEntry>();
    private readonly leasedKeys = new Map<string, PoolEntry>();
    private readonly failures = new Map<string, FailureRecord>();
    private cancelFailureSweep?: () => void;
    private readonly limits: PoolLimits;
    private generation = 0;
    private stopped = false;
    private cleanup?: Promise<void>;

    constructor(
        private readonly clock: ResponsesClock = responsesClock,
        limits: Partial<PoolLimits> = {}
    ) {
        this.limits = {
            maximum: 32,
            perProvider: 8,
            idleMs: 120_000,
            lifetimeMs: 900_000,
            requestMs: 900_000,
            ...limits
        };
    }

    fingerprint(value: unknown): string {
        return createHmac('sha256', this.secret).update(JSON.stringify(value)).digest('hex');
    }

    async acquire(
        identity: ResponsesConnectionIdentity,
        create: () => ResponsesConnection,
        signal: AbortSignal,
        isolateWhenBusy = false
    ): Promise<ResponsesConnectionLease | undefined> {
        if (signal.aborted) {
            throw new DOMException('Request aborted', 'AbortError');
        }
        if (this.stopped || this.stoppedOwners.has(identity.ownerId)) {
            return undefined;
        }
        this.sweepFailures();
        const key = this.fingerprint([
            identity.ownerId,
            identity.provider,
            identity.modelId,
            identity.sessionId,
            identity.origin,
            identity.purpose,
            identity.branchId,
            identity.binding
        ]);
        const busy = this.leasedKeys.get(key);
        if (busy) {
            if (this.expired(busy, this.clock.now())) {
                busy.retiring = true;
            }
            if (!isolateWhenBusy || this.failures.get(key)?.probe) {
                return undefined;
            }
            const isolated = await this.acquire({ ...identity, branchId: randomUUID() }, create, signal);
            return isolated ? { ...isolated, release: () => isolated.release(false) } : undefined;
        }
        let entry = this.available.get(key);
        const now = this.clock.now();
        if (entry && (entry.retiring || !entry.connection.reusable || this.expired(entry, now))) {
            this.retire(entry);
            entry = undefined;
        }
        if (entry?.lease) {
            return undefined;
        }
        const line = this.failures.get(key);
        if (line && (line.blockedUntil > now || line.probe)) {
            return undefined;
        }
        if (!entry && !line && this.failures.size >= MAX_FAILURE_RECORDS) {
            return undefined;
        }
        if (line && line.blockedUntil > 0) {
            line.probe = true;
            this.sweepFailures();
        }
        if (!entry) {
            const providerEntries = [...this.entries].filter(item => item.identity.provider === identity.provider);
            if (this.entries.size >= this.limits.maximum || providerEntries.length >= this.limits.perProvider) {
                if (line) {
                    line.probe = false;
                    this.sweepFailures();
                }
                const idle = providerEntries.find(item => !item.lease && !item.retiring);
                if (idle) {
                    this.retire(idle);
                }
                return undefined;
            }
            let connection: ResponsesConnection;
            try {
                connection = create();
            } catch (error) {
                if (line) {
                    line.probe = false;
                    this.sweepFailures();
                }
                throw error;
            }
            entry = {
                identity: Object.freeze({ ...identity }),
                key,
                connection,
                generation: ++this.generation,
                retiring: false,
                physicallyClosed: false
            };
            this.entries.add(entry);
            this.available.set(key, entry);
            const registered = entry;
            void connection.closed.then(
                () => {
                    registered.physicallyClosed = true;
                    registered.retiring = true;
                    registered.cancelIdle?.();
                    registered.cancelLifetime?.();
                    if (this.available.get(key) === registered) {
                        this.available.delete(key);
                    }
                    this.entries.delete(registered);
                },
                () => {
                    registered.retiring = true;
                    this.stoppedOwners.add(identity.ownerId);
                }
            );
        }
        const owned = entry;
        owned.cancelIdle?.();
        owned.cancelIdle = undefined;
        owned.idleAt = undefined;
        const leaseId = Symbol('responses-lease');
        owned.lease = leaseId;
        this.activeLeases.set(leaseId, owned);
        this.leasedKeys.set(key, owned);
        const requestDeadline = now + this.limits.requestMs;
        const abort = () => {
            if (owned.lease !== leaseId) {
                return;
            }
            try {
                owned.connection.interrupt(new DOMException('Request aborted', 'AbortError'));
            } finally {
                release(false);
            }
        };
        signal.addEventListener('abort', abort, { once: true });
        const cancelRequest = this.clock.schedule(() => {
            if (owned.lease !== leaseId) {
                return;
            }
            try {
                owned.connection.interrupt(new Error('Responses request total deadline exceeded'));
            } finally {
                release(false);
            }
        }, this.limits.requestMs);
        let released = false;
        const release = (reusable: boolean) => {
            if (released) {
                return;
            }
            released = true;
            cancelRequest();
            signal.removeEventListener('abort', abort);
            this.activeLeases.delete(leaseId);
            if (this.leasedKeys.get(key) === owned) {
                this.leasedKeys.delete(key);
            }
            if (owned.lease !== leaseId) {
                return;
            }
            owned.lease = undefined;
            owned.cancelLease = undefined;
            if (line?.probe) {
                line.probe = false;
                this.sweepFailures();
            }
            if (
                !reusable ||
                owned.retiring ||
                signal.aborted ||
                this.expired(owned, this.clock.now()) ||
                !owned.connection.reusable
            ) {
                this.retire(owned);
                return;
            }
            owned.idleAt = this.clock.now();
            owned.cancelIdle = this.clock.schedule(() => {
                if (
                    !owned.lease &&
                    owned.idleAt !== undefined &&
                    this.clock.now() >= owned.idleAt + this.limits.idleMs
                ) {
                    this.retire(owned);
                }
            }, this.limits.idleMs);
        };
        owned.cancelLease = abort;
        try {
            await owned.connection.opened;
            if (signal.aborted || owned.retiring || this.clock.now() >= requestDeadline) {
                throw new DOMException('Request aborted or expired', 'AbortError');
            }
            if (owned.openedAt === undefined) {
                owned.openedAt = this.clock.now();
                owned.cancelLifetime = this.clock.schedule(() => {
                    owned.retiring = true;
                    if (!owned.lease) {
                        this.retire(owned);
                    }
                }, this.limits.lifetimeMs);
            }
            this.failures.delete(key);
            this.sweepFailures();
            return {
                connection: owned.connection,
                generation: owned.generation,
                requestDeadline,
                isCurrent: () =>
                    !released &&
                    owned.lease === leaseId &&
                    !owned.retiring &&
                    !owned.physicallyClosed &&
                    !signal.aborted &&
                    !this.expired(owned, this.clock.now()) &&
                    this.clock.now() < requestDeadline,
                release
            };
        } catch (error) {
            release(false);
            throw error;
        }
    }

    recordResult(identity: ResponsesConnectionIdentity, transportFailure: boolean): void {
        if (this.stopped || this.stoppedOwners.has(identity.ownerId)) {
            return;
        }
        this.sweepFailures();
        const key = this.fingerprint([
            identity.ownerId,
            identity.provider,
            identity.modelId,
            identity.sessionId,
            identity.origin,
            identity.purpose,
            identity.branchId,
            identity.binding
        ]);
        if (!transportFailure) {
            this.failures.delete(key);
            this.sweepFailures();
            return;
        }
        const now = this.clock.now();
        const existing = this.failures.get(key);
        if (!existing && this.failures.size >= MAX_FAILURE_RECORDS) {
            return;
        }
        const line = existing ?? { ownerId: identity.ownerId, times: [], blockedUntil: 0, probe: false };
        line.times = line.times.filter(time => time > now - FAILURE_WINDOW_MS).slice(-2);
        line.times.push(now);
        line.probe = false;
        if (line.times.length >= 3) {
            line.blockedUntil = now + 60_000;
        }
        this.failures.set(key, line);
        this.sweepFailures();
    }

    retireSuperseded(identity: ResponsesConnectionIdentity): void {
        const fields = ['ownerId', 'provider', 'modelId', 'sessionId', 'origin', 'purpose', 'branchId'] as const;
        for (const entry of this.entries) {
            if (
                entry.identity.binding === identity.binding ||
                fields.some(field => entry.identity[field] !== identity[field])
            ) {
                continue;
            }
            entry.retiring = true;
            if (!entry.lease) {
                this.retire(entry);
            }
        }
    }

    retireOwner(ownerId: string): void {
        for (const entry of this.entries) {
            if (entry.identity.ownerId !== ownerId) {
                continue;
            }
            entry.retiring = true;
            if (!entry.lease) {
                this.retire(entry);
            }
        }
    }

    retireModel(ownerId: string, provider: string, modelId: string): void {
        for (const entry of this.entries) {
            if (
                entry.identity.ownerId !== ownerId ||
                entry.identity.provider !== provider ||
                entry.identity.modelId !== modelId
            ) {
                continue;
            }
            entry.retiring = true;
            if (!entry.lease) {
                this.retire(entry);
            }
        }
    }

    disposeOwner(ownerId: string): Promise<void> {
        const previous = this.ownerCleanup.get(ownerId);
        if (previous) {
            return previous;
        }
        this.stoppedOwners.add(ownerId);
        for (const [key, line] of this.failures) {
            if (line.ownerId === ownerId) {
                this.failures.delete(key);
            }
        }
        this.sweepFailures();
        const cleanup = this.closeEntries(
            [...new Set([...this.entries, ...this.activeLeases.values()])].filter(
                entry => entry.identity.ownerId === ownerId
            )
        );
        this.ownerCleanup.set(ownerId, cleanup);
        return cleanup;
    }

    dispose(): Promise<void> {
        if (!this.cleanup) {
            this.stopped = true;
            this.failures.clear();
            this.sweepFailures();
            this.cleanup = this.closeEntries([...new Set([...this.entries, ...this.activeLeases.values()])]);
        }
        return this.cleanup;
    }

    diagnostics(): { connections: number; leases: number; closing: number } {
        return {
            connections: this.entries.size,
            leases: this.activeLeases.size,
            closing: [...this.entries].filter(entry => entry.retiring).length
        };
    }

    private sweepFailures(): void {
        this.cancelFailureSweep?.();
        this.cancelFailureSweep = undefined;
        if (this.stopped) {
            return;
        }
        const now = this.clock.now();
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const [key, line] of this.failures) {
            if (line.probe) {
                continue;
            }
            const expiresAt = line.times[line.times.length - 1] + FAILURE_WINDOW_MS;
            if (expiresAt <= now) {
                this.failures.delete(key);
            } else {
                nextExpiry = Math.min(nextExpiry, expiresAt);
            }
        }
        if (Number.isFinite(nextExpiry)) {
            this.cancelFailureSweep = this.clock.schedule(() => this.sweepFailures(), nextExpiry - now);
        }
    }

    private expired(entry: PoolEntry, now: number): boolean {
        return (
            (entry.openedAt !== undefined && now >= entry.openedAt + this.limits.lifetimeMs) ||
            (entry.idleAt !== undefined && now >= entry.idleAt + this.limits.idleMs)
        );
    }

    private retire(entry: PoolEntry): Promise<void> {
        entry.retiring = true;
        entry.cancelIdle?.();
        entry.cancelLifetime?.();
        if (this.available.get(entry.key) === entry) {
            this.available.delete(entry.key);
        }
        if (!entry.cleanup) {
            try {
                entry.cleanup = entry.connection.close();
            } catch (error) {
                entry.cleanup = Promise.reject(error);
            }
            void entry.cleanup.catch(() => {
                this.stoppedOwners.add(entry.identity.ownerId);
            });
        }
        return entry.cleanup;
    }

    private async closeEntries(entries: PoolEntry[]): Promise<void> {
        const results = await Promise.allSettled(
            entries.map(entry => {
                try {
                    if (entry.cancelLease) {
                        entry.cancelLease();
                    } else {
                        entry.connection.interrupt(new DOMException('Responses owner disposed', 'AbortError'));
                    }
                } catch (error) {
                    return this.retire(entry).then(() => {
                        throw error;
                    });
                }
                return this.retire(entry);
            })
        );
        const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));
        if (errors.length) {
            throw new AggregateError(errors, 'Responses connections failed to close');
        }
    }
}

export const responsesConnectionPool = new ResponsesConnectionPool();
