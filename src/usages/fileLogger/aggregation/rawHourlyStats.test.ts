import assert from 'node:assert/strict';
import test from 'node:test';
import { StatsCalculator } from '../statsCalculator';
import type { TokenRequestLog } from '../types';
import { RawHourlyStats, type HourSource } from './rawHourlyStats';

const row = (id: string, hour: number, completed = false): TokenRequestLog => ({
    requestId: id,
    timestamp: new Date(2026, 9, 11, hour).getTime(),
    isoTime: '',
    providerKey: 'test',
    providerName: 'Test',
    modelId: 'test',
    modelName: 'Test',
    estimatedInput: 10,
    status: completed ? 'completed' : 'estimated',
    rawUsage: completed ? { prompt_tokens: 10, completion_tokens: 5 } : null
});
const source = (hour: number, modifiedTime = 1): HourSource => ({
    hour: String(hour).padStart(2, '0'),
    modifiedTime,
    version: String(modifiedTime)
});

test('only changed source files and affected ownership buckets are recomputed', async context => {
    const cache = new RawHourlyStats();
    const logs = new Map([
        [9, [row('shared', 9)]],
        [10, [row('shared', 10, true), row('ten', 10, true)]],
        [11, [row('unaffected', 11, true)]]
    ]);
    const reads: number[] = [];
    const read = async (hour: number) => {
        reads.push(hour);
        return logs.get(hour)!;
    };
    const files = [source(9), source(10), source(11)];
    const first = await cache.calculate('date', files, read, false);
    assert.equal(first.hourly['09'].requests, 1);
    assert.equal(first.hourly['10'].requests, 1);
    assert.equal(first.hourly['11'].requests, 1);
    reads.length = 0;
    const aggregate = context.mock.method(StatsCalculator, 'aggregateLogs');
    logs.set(10, [
        { ...row('shared', 10, true), rawUsage: { prompt_tokens: 20, completion_tokens: 8 } },
        row('ten', 10, true)
    ]);
    files[1] = source(10, 2);
    const next = await cache.calculate('date', files, read, false);
    assert.deepEqual(reads, [10]);
    assert.equal(next.hourly['09'].actualInput, 20);
    assert.equal(next.hourly['09'].outputTokens, 8);
    assert.equal(next.hourly['09'].requests, 1);
    assert.equal(next.hourly['11'].providers, first.hourly['11'].providers);
    assert.equal(
        aggregate.mock.calls.some(call => call.arguments[0].some(log => log.requestId === 'unaffected')),
        false
    );
    assert.equal(next.reused, 2);
    assert.equal(next.recomputed, 1);
    assert.equal(first.hourly['09'].actualInput, 10);
});

test('removing sources moves ownership and removes obsolete requests without rereading', async () => {
    const cache = new RawHourlyStats();
    const logs = new Map([
        [9, [row('shared', 9)]],
        [10, [row('shared', 10, true)]]
    ]);
    const reads: number[] = [];
    const read = async (hour: number) => {
        reads.push(hour);
        return logs.get(hour)!;
    };
    await cache.calculate('date', [source(9), source(10)], read, false);
    reads.length = 0;
    const moved = await cache.calculate('date', [source(10)], read, false);
    assert.equal(moved.hourly['09'], undefined);
    assert.equal(moved.hourly['10'].requests, 1);
    assert.equal(moved.hourly['10'].actualInput, 10);
    assert.deepEqual(reads, []);
    assert.deepEqual((await cache.calculate('date', [], read, false)).hourly, {});
    const restored = await cache.calculate('date', [source(9)], read, false);
    assert.equal(restored.hourly['09'].requests, 1);
    assert.equal(restored.hourly['09'].actualInput, 0);
    assert.deepEqual(reads, [9]);
});

test('late changes retain their read-start version and read failures do not commit partial ownership', async () => {
    const cache = new RawHourlyStats();
    await cache.calculate('date', [source(9)], async () => [row('shared', 9)], false);
    await assert.rejects(
        cache.calculate(
            'date',
            [source(9, 2), source(10)],
            async hour => {
                if (hour === 10) {
                    throw new Error('read failure');
                }
                return [row('new', 9)];
            },
            false
        ),
        /read failure/
    );
    const recovered = await cache.calculate(
        'date',
        [source(9), source(10, 2)],
        async hour => {
            assert.equal(hour, 10);
            return [row('shared', 10, true)];
        },
        false
    );
    assert.equal(recovered.hourly['09'].requests, 1);
    assert.equal(recovered.hourly['09'].completedRequests, 1);
    assert.equal(recovered.hourly['10'].requests, 0);
    assert.equal(recovered.hourly['10'].modifiedTime, 2);
});

for (const operation of ['clear', 'dispose'] as const) {
    test(`${operation} prevents an in-flight calculation from retaining request records`, async () => {
        const cache = new RawHourlyStats();
        let release!: () => void;
        let entered!: () => void;
        const start = new Promise<void>(resolve => {
            entered = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const pending = cache.calculate(
            'date',
            [source(9)],
            async () => {
                entered();
                await gate;
                return [row('shared', 9)];
            },
            false
        );
        await start;
        cache[operation]();
        release();
        assert.equal((await pending).hourly['09'].requests, 1);
        const internals = cache as unknown as { dates: Map<string, unknown> };
        assert.equal(internals.dates.size, 0);
        await cache.calculate('date', [source(9)], async () => [row('shared', 9)], false);
        assert.equal(internals.dates.size, operation === 'clear' ? 1 : 0);
    });
}

test('request records stay bounded by both date and record budgets', async context => {
    const limits = RawHourlyStats as unknown as { MAX_RECORDS: number };
    const original = limits.MAX_RECORDS;
    limits.MAX_RECORDS = 3;
    context.after(() => {
        limits.MAX_RECORDS = original;
    });
    const cache = new RawHourlyStats();
    const internals = cache as unknown as { dates: Map<string, { records: number }> };
    for (const date of ['first', 'second', 'third']) {
        await cache.calculate(date, [source(9)], async () => [row(date, 9)], false);
    }
    assert.deepEqual([...internals.dates.keys()], ['second', 'third']);
    await cache.calculate('fourth', [source(9)], async () => [row('a', 9), row('b', 9), row('c', 9)], false);
    assert.deepEqual([...internals.dates.keys()], ['fourth']);
    await cache.calculate('large', [source(9)], async () => ['a', 'b', 'c', 'd'].map(id => row(id, 9)), false);
    assert.equal(internals.dates.has('large'), false);
    assert.equal(
        [...internals.dates.values()].reduce((sum, value) => sum + value.records, 0),
        3
    );
});

test('forced recomputation reads unchanged-mtime sources while ordinary refresh preserves the cache contract', async () => {
    const cache = new RawHourlyStats();
    const files = [source(9), source(10)];
    let completed = false;
    const read = async (hour: number) =>
        hour === 9 ? [row('shared', 9)]
        : completed ? [row('shared', 10, true)]
        : [];
    const first = await cache.calculate('date', files, read, false);
    assert.equal(first.hourly['09'].completedRequests, 0);
    completed = true;
    assert.equal((await cache.calculate('date', files, read, false)).hourly['09'].completedRequests, 0);
    const forced = await cache.calculate('date', files, read, true);
    assert.equal(forced.hourly['09'].completedRequests, 1);
    assert.equal(forced.hourly['09'].requests, 1);
    assert.equal(forced.hourly['10'].requests, 0);
});
