import { StatsCalculator } from '../statsCalculator';
import type { HourlyStats, TokenRequestLog } from '../types';
import { HourlyMembership, type HourRecordSource, type HourSource } from './hourlyMembership';

interface OverflowSource extends HourSource {
    membership: HourlyMembership;
}
interface OverflowDate {
    sources: Map<string, OverflowSource>;
    shared: Map<string, number>;
    hourly: Record<string, HourlyStats>;
}
const bit = (hour: string) => 1 << Number(hour);
const firstHour = (mask: number) => String(31 - Math.clz32(mask & -mask)).padStart(2, '0');

export class OverflowHourlyStats {
    private static readonly MAX_SHARED_REQUESTS = 30_000;
    private readonly dates = new Map<string, OverflowDate>();

    clear(): void {
        this.dates.clear();
    }

    forget(date: string): void {
        this.dates.delete(date);
    }

    remember(date: string, sources: ReadonlyMap<string, HourRecordSource>, hourly: Record<string, HourlyStats>): void {
        const masks = new Map<string, number>();
        for (const [hour, source] of sources) {
            for (const id of source.records.keys()) {
                masks.set(id, (masks.get(id) ?? 0) | bit(hour));
            }
        }
        const shared = new Map([...masks].filter(([, mask]) => (mask & (mask - 1)) !== 0));
        this.forget(date);
        if (shared.size > OverflowHourlyStats.MAX_SHARED_REQUESTS) {
            return;
        }
        this.dates.set(date, {
            sources: new Map(
                [...sources].map(([hour, source]) => [
                    hour,
                    {
                        hour,
                        version: source.version,
                        modifiedTime: source.modifiedTime,
                        membership: new HourlyMembership(source.records.keys())
                    }
                ])
            ),
            shared,
            hourly
        });
    }

    async calculate(
        date: string,
        files: HourSource[],
        read: (hour: number) => Promise<TokenRequestLog[]>,
        canRetain: () => boolean
    ): Promise<{ hourly: Record<string, HourlyStats>; reused: number; recomputed: number } | undefined> {
        const previous = this.dates.get(date);
        if (!previous) {
            return undefined;
        }
        const sources = new Map<string, OverflowSource>();
        const loaded = new Map<string, Map<string, TokenRequestLog>>();
        const changedIds = new Set<string>();
        let changedMask = 0;
        const load = async (hour: string): Promise<Map<string, TokenRequestLog>> => {
            let records = loaded.get(hour);
            if (!records) {
                records = StatsCalculator.mergeLogsByRequestId(await read(Number(hour)));
                loaded.set(hour, records);
            }
            return records;
        };
        for (const file of files) {
            const cached = previous.sources.get(file.hour);
            if (cached?.version === file.version) {
                sources.set(file.hour, cached);
            } else {
                const records = await load(file.hour);
                changedMask |= bit(file.hour);
                for (const id of records.keys()) {
                    changedIds.add(id);
                }
                sources.set(file.hour, { ...file, membership: new HourlyMembership(records.keys()) });
            }
        }
        for (const hour of previous.sources.keys()) {
            if (!sources.has(hour)) {
                changedMask |= bit(hour);
            }
        }
        for (const [id, mask] of previous.shared) {
            if (mask & changedMask) {
                changedIds.add(id);
            }
        }
        const shared = new Map(previous.shared);
        let affectedMask = changedMask;
        for (const id of changedIds) {
            const oldMask = previous.shared.get(id);
            const positions = oldMask === undefined ? HourlyMembership.positions(id) : undefined;
            let mask = 0;
            for (const [hour, source] of sources) {
                const known = loaded.get(hour);
                const candidate =
                    oldMask === undefined ? source.membership.mayContain(positions!) : (oldMask & bit(hour)) !== 0;
                if (known ? known.has(id) : candidate && (await load(hour)).has(id)) {
                    mask |= bit(hour);
                }
            }
            if (oldMask !== undefined) {
                affectedMask |= bit(firstHour(oldMask));
            } else if (mask & ~changedMask) {
                affectedMask |= bit(firstHour(mask & ~changedMask));
            }
            if (mask) {
                affectedMask |= bit(firstHour(mask));
            }
            if ((mask & (mask - 1)) !== 0) {
                shared.set(id, mask);
            } else {
                shared.delete(id);
            }
        }
        const hourly: Record<string, HourlyStats> = {};
        for (const file of files) {
            if (!(affectedMask & bit(file.hour))) {
                hourly[file.hour] = previous.hourly[file.hour];
                continue;
            }
            const records = await load(file.hour);
            const owned: TokenRequestLog[] = [];
            for (const [id, record] of records) {
                const mask = shared.get(id);
                if (mask === undefined) {
                    owned.push(record);
                } else if (firstHour(mask) === file.hour) {
                    const parts: TokenRequestLog[] = [];
                    for (const source of files) {
                        if (mask & bit(source.hour)) {
                            parts.push((await load(source.hour)).get(id)!);
                        }
                    }
                    owned.push(StatsCalculator.mergeLogsByRequestId(parts).get(id)!);
                }
            }
            const stats = StatsCalculator.aggregateLogs(owned);
            hourly[file.hour] = { ...stats.total, providers: stats.providers, modifiedTime: file.modifiedTime };
        }
        if (canRetain()) {
            if (shared.size <= OverflowHourlyStats.MAX_SHARED_REQUESTS) {
                this.dates.set(date, { sources, shared, hourly });
            } else {
                this.forget(date);
            }
        }
        return { hourly, reused: files.length - loaded.size, recomputed: loaded.size };
    }
}
