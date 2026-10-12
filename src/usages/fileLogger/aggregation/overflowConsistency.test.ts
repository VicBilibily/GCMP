import assert from 'node:assert/strict';
import test from 'node:test';
import { StatsCalculator } from '../statsCalculator';
import type { HourlyStats, TokenRequestLog } from '../types';
import { RawHourlyStats, type HourSource } from './rawHourlyStats';

function compare(actual: unknown, expected: unknown, key = ''): void {
    if (typeof actual === 'number' && typeof expected === 'number' && /\.(outputSpeeds|firstTokenLatency)$/.test(key)) {
        assert.ok(Math.abs(actual - expected) <= 8 * Number.EPSILON * Math.max(1, Math.abs(expected)), key);
    } else if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), key);
        const left = actual as Record<string, unknown>,
            right = expected as Record<string, unknown>;
        for (const field of Object.keys(right)) {
            compare(left[field], right[field], `${key}.${field}`);
        }
    } else {
        assert.deepEqual(actual, expected, key);
    }
}

for (const seed of [7, 193, 20261012]) {
    test(`bounded overflow aggregation agrees with full-day ownership, seed=${seed}`, async context => {
        const limits = RawHourlyStats as unknown as { MAX_RECORDS: number };
        const previous = limits.MAX_RECORDS;
        limits.MAX_RECORDS = 4;
        context.after(() => {
            limits.MAX_RECORDS = previous;
        });
        const cache = new RawHourlyStats();
        let random = seed;
        const pick = (n: number): number => {
            random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
            return (random >>> 8) % n;
        };
        const dates = new Map<string, Map<number, { version: number; rows: TokenRequestLog[] }>>();
        for (let step = 1; step <= 240; step++) {
            const date = `2026-10-${10 + pick(3)}`;
            let sources = dates.get(date);
            if (!sources) {
                sources = new Map();
                dates.set(date, sources);
            }
            const hour = pick(6),
                existing = sources.get(hour),
                action = pick(10);
            if (action === 0) {
                sources.delete(hour);
            } else if (action === 1 && existing) {
                sources.set(hour, { version: step, rows: existing.rows.slice(1) });
            } else {
                const id = pick(14);
                const status = (['estimated', 'completed', 'failed', 'cancelled'] as const)[pick(4)];
                const timestamp = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime() + step;
                const row: TokenRequestLog = {
                    requestId: `request-${id}`,
                    timestamp,
                    isoTime: new Date(timestamp).toISOString(),
                    providerKey: `provider-${id % 2}`,
                    providerName: `Provider ${id % 2}`,
                    modelId: `model-${id % 3}`,
                    modelName: `Model ${id % 3}`,
                    estimatedInput: 10 + id,
                    status,
                    rawUsage:
                        status === 'estimated' || status === 'failed' ?
                            null
                        :   { prompt_tokens: 20 + pick(100), completion_tokens: 1 + pick(20) },
                    ...(pick(2) ? { sessionTitle: `Title ${step}` } : {}),
                    ...(pick(2) ?
                        { streamStartTime: timestamp + 1, streamEndTime: timestamp + 100, outputSpeed: 5 + pick(20) }
                    :   {}),
                    ...(pick(2) ? { estimatedCost: pick(10) / 100, estimatedIncrement: pick(20) } : {})
                };
                sources.set(hour, { version: step, rows: [...(existing?.rows ?? []), row] });
            }
            if (step % 31 === 0) {
                cache.clear();
            }
            if (step % 23 === 0) {
                cache.forget(date);
            }
            const sorted = [...sources].sort(([left], [right]) => left - right);
            const files: HourSource[] = sorted.map(([sourceHour, source]) => ({
                hour: String(sourceHour).padStart(2, '0'),
                version: String(source.version),
                modifiedTime: source.version
            }));
            const result = await cache.calculate(
                date,
                files,
                async requestedHour => sources!.get(requestedHour)!.rows,
                step % 17 === 0
            );
            const merged = StatsCalculator.mergeLogsByRequestId(sorted.flatMap(([, source]) => source.rows));
            const owner = new Map<string, number>();
            for (const [sourceHour, source] of sorted) {
                for (const row of source.rows) {
                    if (!owner.has(row.requestId)) {
                        owner.set(row.requestId, sourceHour);
                    }
                }
            }
            const expected: Record<string, HourlyStats> = {};
            for (const [sourceHour, source] of sorted) {
                const aggregate = StatsCalculator.aggregateLogs(
                    [...merged.values()].filter(row => owner.get(row.requestId) === sourceHour)
                );
                expected[String(sourceHour).padStart(2, '0')] = {
                    ...aggregate.total,
                    providers: aggregate.providers,
                    modifiedTime: source.version
                };
            }
            compare(result.hourly, expected, `seed=${seed} step=${step} date=${date}`);
        }
        cache.dispose();
    });
}
