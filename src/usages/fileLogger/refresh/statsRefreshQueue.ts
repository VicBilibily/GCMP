import type { TokenUsageStatsFromFile } from '../types';
import { StatusLogger } from '../../../utils/runtime/statusLogger';

export interface StatsRefreshResult {
    date: string;
    stats: TokenUsageStatsFromFile;
    changed: boolean;
    delegated: boolean;
}

interface RefreshBatch {
    promise: Promise<StatsRefreshResult | undefined>;
    resolve: (result: StatsRefreshResult | undefined) => void;
    timer?: ReturnType<typeof setTimeout>;
}

interface DateRefresh {
    active?: RefreshBatch;
    pending?: RefreshBatch;
}

export class StatsRefreshQueue {
    private readonly dates = new Map<string, DateRefresh>();
    private disposed = false;

    constructor(private readonly refresh: (date: string) => Promise<StatsRefreshResult | undefined>) {}

    has(date: string): boolean {
        return this.dates.has(date);
    }

    request(date: string, dirty = false): Promise<StatsRefreshResult | undefined> {
        if (this.disposed) {
            return Promise.resolve(undefined);
        }
        const state = this.dates.get(date) ?? {};
        if (state.pending) {
            return state.pending.promise;
        }
        if (state.active && !dirty) {
            return state.active.promise;
        }
        let resolve!: RefreshBatch['resolve'];
        const promise = new Promise<StatsRefreshResult | undefined>(done => {
            resolve = done;
        });
        state.pending = { promise, resolve };
        this.dates.set(date, state);
        if (!state.active) {
            this.schedule(date, state);
        }
        return promise;
    }

    private schedule(date: string, state: DateRefresh): void {
        const batch = state.pending;
        if (!batch || this.disposed) {
            return;
        }
        batch.timer = setTimeout(() => {
            if (this.disposed || state.pending !== batch) {
                return;
            }
            state.pending = undefined;
            state.active = batch;
            void this.refresh(date)
                .then(result => batch.resolve(this.disposed ? undefined : result))
                .catch(error => {
                    StatusLogger.warn('[TokenFileLogger] Failed to refresh stats:', error);
                    batch.resolve(undefined);
                })
                .finally(() => {
                    state.active = undefined;
                    if (this.disposed) {
                        return;
                    }
                    if (state.pending) {
                        this.schedule(date, state);
                    } else {
                        this.dates.delete(date);
                    }
                });
        }, 1000);
    }

    dispose(): void {
        this.disposed = true;
        for (const state of this.dates.values()) {
            for (const batch of [state.pending, state.active]) {
                if (!batch) {
                    continue;
                }
                clearTimeout(batch.timer);
                batch.resolve(undefined);
            }
        }
        this.dates.clear();
    }
}
