import { StatsCalculator } from '../statsCalculator';
import type { HourlyStats, TokenRequestLog } from '../types';
import type { HourSource, HourRecordSource } from './hourlyMembership';
import { OverflowHourlyStats } from './overflowHourlyStats';

export type { HourSource } from './hourlyMembership';
interface DateCache {
    sources: Map<string, HourRecordSource>;
    owners: Map<string, string>;
    buckets: Map<string, Map<string, TokenRequestLog>>;
    hourly: Record<string, HourlyStats>;
    records: number;
}

export class RawHourlyStats {
    private static readonly MAX_DATES = 2;
    private static readonly MAX_RECORDS = 30_000;
    private readonly dates = new Map<string, DateCache>();
    private readonly overflow = new OverflowHourlyStats();
    private readonly retainedDates = new Map<string, true>();
    private generation = 0;
    private disposed = false;

    clear(): void {
        this.generation++;
        this.dates.clear();
        this.overflow.clear();
        this.retainedDates.clear();
    }

    forget(date: string): void {
        this.dates.delete(date);
        this.overflow.forget(date);
        this.retainedDates.delete(date);
    }

    dispose(): void {
        this.disposed = true;
        this.clear();
    }

    async calculate(
        date: string,
        files: HourSource[],
        read: (hour: number) => Promise<TokenRequestLog[]>,
        force: boolean
    ): Promise<{ hourly: Record<string, HourlyStats>; reused: number; recomputed: number }> {
        const generation = this.generation;
        const previous = this.dates.get(date);
        const canRetain = () => !this.disposed && generation === this.generation;
        if (!previous && !force) {
            const result = await this.overflow.calculate(date, files, read, canRetain);
            if (result) {
                if (canRetain()) {
                    this.retainDate(date);
                }
                return result;
            }
        }
        const sources = new Map<string, HourRecordSource>();
        const changedIds = new Set<string>();
        let reused = 0;
        for (const file of files) {
            const cached = previous?.sources.get(file.hour);
            if (!force && cached?.version === file.version) {
                sources.set(file.hour, cached);
                reused++;
                continue;
            }
            const records = StatsCalculator.mergeLogsByRequestId(await read(Number(file.hour)));
            for (const id of cached?.records.keys() ?? []) {
                changedIds.add(id);
            }
            for (const id of records.keys()) {
                changedIds.add(id);
            }
            sources.set(file.hour, { ...file, records });
        }
        for (const [hour, cached] of previous?.sources ?? []) {
            if (!sources.has(hour)) {
                for (const id of cached.records.keys()) {
                    changedIds.add(id);
                }
            }
        }

        const owners = new Map(previous?.owners);
        const buckets = new Map(previous?.buckets);
        const dirtyHours = new Set<string>();
        const editBucket = (hour: string): Map<string, TokenRequestLog> => {
            if (!dirtyHours.has(hour)) {
                buckets.set(hour, new Map(buckets.get(hour)));
                dirtyHours.add(hour);
            }
            return buckets.get(hour)!;
        };
        for (const id of changedIds) {
            const oldOwner = owners.get(id);
            if (oldOwner !== undefined) {
                editBucket(oldOwner).delete(id);
                owners.delete(id);
            }
            const parts: TokenRequestLog[] = [];
            let owner: string | undefined;
            for (const [hour, source] of sources) {
                const record = source.records.get(id);
                if (record) {
                    owner ??= hour;
                    parts.push(record);
                }
            }
            if (owner !== undefined) {
                const merged = StatsCalculator.mergeLogsByRequestId(parts).get(id)!;
                editBucket(owner).set(id, merged);
                owners.set(id, owner);
            }
        }

        const hourly: Record<string, HourlyStats> = {};
        for (const file of files) {
            const cached = previous?.hourly[file.hour];
            if (cached && !dirtyHours.has(file.hour)) {
                hourly[file.hour] = { ...cached, modifiedTime: file.modifiedTime };
            } else {
                const stats = StatsCalculator.aggregateLogs([...(buckets.get(file.hour)?.values() ?? [])]);
                hourly[file.hour] = { ...stats.total, providers: stats.providers, modifiedTime: file.modifiedTime };
            }
        }
        for (const hour of buckets.keys()) {
            if (!sources.has(hour)) {
                buckets.delete(hour);
            }
        }
        const records = [...sources.values()].reduce((total, source) => total + source.records.size, 0);
        if (canRetain()) {
            this.dates.delete(date);
            if (records <= RawHourlyStats.MAX_RECORDS) {
                this.dates.set(date, { sources, owners, buckets, hourly, records });
                this.overflow.forget(date);
            } else {
                this.overflow.remember(date, sources, hourly);
            }
            let cachedRecords = [...this.dates.values()].reduce((total, entry) => total + entry.records, 0);
            while (cachedRecords > RawHourlyStats.MAX_RECORDS) {
                const oldest = this.dates.keys().next().value!;
                const cached = this.dates.get(oldest)!;
                cachedRecords -= cached.records;
                this.overflow.remember(oldest, cached.sources, cached.hourly);
                this.dates.delete(oldest);
            }
            this.retainDate(date);
        }
        return { hourly, reused, recomputed: files.length - reused };
    }

    private retainDate(date: string): void {
        this.retainedDates.delete(date);
        this.retainedDates.set(date, true);
        while (this.retainedDates.size > RawHourlyStats.MAX_DATES) {
            this.forget(this.retainedDates.keys().next().value!);
        }
    }
}
