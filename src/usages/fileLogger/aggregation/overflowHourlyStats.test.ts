import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { StatsCalculator } from '../statsCalculator';
import type { TokenRequestLog } from '../types';
import { RawHourlyStats, type HourSource } from './rawHourlyStats';
import { HourlyMembership } from './hourlyMembership';
import { OverflowHourlyStats } from './overflowHourlyStats';

const row = (id: string, hour: number, completed = true): TokenRequestLog => ({
    requestId: id,
    timestamp: new Date(2026, 9, 12, hour).getTime(),
    isoTime: '',
    providerKey: 'test',
    providerName: 'Test',
    modelId: 'test',
    modelName: 'Test',
    estimatedInput: 10,
    status: completed ? 'completed' : 'estimated',
    rawUsage: completed ? { prompt_tokens: 10, completion_tokens: 5 } : null
});
const source = (hour: number, version = 1): HourSource => ({
    hour: String(hour).padStart(2, '0'),
    modifiedTime: version,
    version: String(version)
});
async function fixture(context: TestContext) {
    const limits = RawHourlyStats as unknown as { MAX_RECORDS: number };
    const previous = limits.MAX_RECORDS;
    limits.MAX_RECORDS = 4;
    context.after(() => {
        limits.MAX_RECORDS = previous;
    });
    const cache = new RawHourlyStats();
    const files = [source(9), source(10), source(11)];
    const logs = new Map([
        [9, [row('nine', 9), row('shared', 9, false)]],
        [10, [row('shared', 10), row('ten', 10)]],
        [11, [row('eleven-a', 11), row('eleven-b', 11)]]
    ]);
    const reads: number[] = [];
    const read = async (hour: number) => {
        reads.push(hour);
        return logs.get(hour)!;
    };
    await cache.calculate('date', files, read, false);
    reads.length = 0;
    return { cache, files, logs, reads, read };
}

test('overflow retains unchanged-hour aggregates without retaining full request records', async context => {
    const f = await fixture(context);
    const first = await f.cache.calculate('date', f.files, f.read, false);
    assert.deepEqual(f.reads, []);
    f.logs.get(11)!.push(row('new', 11));
    f.files[2] = source(11, 2);
    const result = await f.cache.calculate('date', f.files, f.read, false);
    assert.deepEqual(f.reads, [11]);
    assert.equal(result.hourly['09'].providers, first.hourly['09'].providers);
    assert.equal(result.hourly['11'].requests, 3);
    const internals = f.cache as unknown as { dates: Map<string, unknown> };
    assert.equal(internals.dates.size, 0);
});

for (const change of ['update', 'truncate', 'remove-owner', 'remove-terminal'] as const) {
    test(`overflow ${change} refreshes shared ownership but not independent hours`, async context => {
        const f = await fixture(context);
        if (change === 'update') {
            f.logs.set(10, [
                { ...row('shared', 10), rawUsage: { prompt_tokens: 20, completion_tokens: 8 } },
                row('ten', 10)
            ]);
            f.files[1] = source(10, 2);
        } else if (change === 'truncate') {
            f.logs.set(10, []);
            f.files[1] = source(10, 2);
        } else {
            f.files.splice(change === 'remove-owner' ? 0 : 1, 1);
        }
        const result = await f.cache.calculate('date', f.files, f.read, false);
        assert.equal(f.reads.includes(11), false);
        const expected = StatsCalculator.aggregateLogs(f.files.flatMap(file => f.logs.get(Number(file.hour))!));
        for (const key of ['requests', 'actualInput', 'outputTokens', 'completedRequests'] as const) {
            assert.equal(
                Object.values(result.hourly).reduce((sum, stats) => sum + stats[key], 0),
                expected.total[key]
            );
        }
        if (change === 'remove-owner') {
            assert.equal(result.hourly['09'], undefined);
            assert.equal(result.hourly['10'].requests, 2);
        }
    });
}

test('overflow discovers a new cross-hour terminal and does not duplicate its request', async context => {
    const f = await fixture(context);
    f.logs.get(11)!.push({ ...row('nine', 11), rawUsage: { prompt_tokens: 30, completion_tokens: 7 } });
    f.files[2] = source(11, 2);
    const result = await f.cache.calculate('date', f.files, f.read, false);
    assert.equal(result.hourly['09'].actualInput, 40);
    assert.equal(result.hourly['09'].requests, 2);
    assert.equal(result.hourly['11'].requests, 2);
    assert.equal(
        Object.values(result.hourly).reduce((sum, stats) => sum + stats.requests, 0),
        5
    );
});

test('overflow moves an existing unique request when an earlier source is restored', async context => {
    const f = await fixture(context);
    f.logs.set(8, [row('eleven-a', 8, false)]);
    f.files.unshift(source(8, 2));
    const result = await f.cache.calculate('date', f.files, f.read, false);
    assert.equal(result.hourly['08'].requests, 1);
    assert.equal(result.hourly['08'].completedRequests, 1);
    assert.equal(result.hourly['11'].requests, 1);
    assert.equal(
        Object.values(result.hourly).reduce((sum, stats) => sum + stats.requests, 0),
        5
    );
    assert.deepEqual(
        f.reads.sort((left, right) => left - right),
        [8, 11]
    );
});

test('overflow does not propagate a changed shared request through unrelated adjacent-hour links', async context => {
    const f = await fixture(context);
    const files = Array.from({ length: 6 }, (_, hour) => source(hour));
    const logs = new Map(
        files.map(file => {
            const hour = Number(file.hour);
            return [
                hour,
                [
                    row(`own-${hour}`, hour),
                    row(`link-${hour}`, hour, false),
                    ...(hour ? [row(`link-${hour - 1}`, hour)] : [])
                ]
            ];
        })
    );
    const reads: number[] = [];
    const read = async (hour: number) => {
        reads.push(hour);
        return logs.get(hour)!;
    };
    await f.cache.calculate('chain', files, read, false);
    reads.length = 0;
    logs.get(5)!.push(row('last', 5));
    files[5] = source(5, 2);
    await f.cache.calculate('chain', files, read, false);
    assert.deepEqual(reads.sort(), [4, 5]);
});

test('overflow failed dependency reads leave the previous summary reusable', async context => {
    const f = await fixture(context);
    const changed = [f.files[0], source(10, 2), f.files[2]];
    await assert.rejects(
        f.cache.calculate(
            'date',
            changed,
            async hour => {
                if (hour === 9) {
                    throw new Error('dependency read failed');
                }
                return f.read(hour);
            },
            false
        ),
        /dependency read failed/
    );
    f.reads.length = 0;
    const result = await f.cache.calculate('date', f.files, f.read, false);
    assert.deepEqual(f.reads, []);
    assert.equal(result.hourly['09'].actualInput, 20);
});

test('overflow forced refresh still reads every source with unchanged timestamps', async context => {
    const f = await fixture(context);
    f.logs.get(11)!.push(row('forced', 11));
    const result = await f.cache.calculate('date', f.files, f.read, true);
    assert.deepEqual(f.reads, [9, 10, 11]);
    assert.equal(result.hourly['11'].requests, 3);
});

test('membership false positives only increase reads and cannot change ownership', async context => {
    const f = await fixture(context);
    context.mock.method(HourlyMembership.prototype, 'mayContain', () => true);
    f.logs.get(11)!.push(row('new', 11));
    f.files[2] = source(11, 2);
    const result = await f.cache.calculate('date', f.files, f.read, false);
    assert.deepEqual(f.reads.sort(), [9, 10, 11].sort());
    assert.equal(result.hourly['09'].requests, 2);
    assert.equal(result.hourly['10'].requests, 1);
    assert.equal(result.hourly['11'].requests, 3);
});

test('overflow summaries share the two-date limit and cap cross-hour request identities', async context => {
    const f = await fixture(context);
    for (const date of ['second', 'third']) {
        await f.cache.calculate(date, f.files, f.read, false);
    }
    const internals = f.cache as unknown as {
        overflow: { dates: Map<string, { shared: Map<string, number> }> };
    };
    assert.deepEqual([...internals.overflow.dates.keys()], ['second', 'third']);
    const limits = OverflowHourlyStats as unknown as { MAX_SHARED_REQUESTS: number };
    const previous = limits.MAX_SHARED_REQUESTS;
    limits.MAX_SHARED_REQUESTS = 1;
    context.after(() => {
        limits.MAX_SHARED_REQUESTS = previous;
    });
    const records = [row('one', 9), row('two', 9), row('three', 9)];
    const result = await f.cache.calculate('dense', [source(9), source(10)], async () => records, false);
    assert.equal(result.hourly['09'].requests, 3);
    assert.equal(result.hourly['10'].requests, 0);
    assert.equal(internals.overflow.dates.has('dense'), false);
    assert.ok(internals.overflow.dates.size <= 2);
});

for (const operation of ['clear', 'dispose'] as const) {
    test(`overflow ${operation} prevents a late calculation from refilling caches`, async context => {
        const f = await fixture(context);
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>(resolve => {
            release = resolve;
        });
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        f.files[2] = source(11, 2);
        const work = f.cache.calculate(
            'date',
            f.files,
            async hour => {
                entered();
                await blocked;
                return f.read(hour);
            },
            false
        );
        await started;
        f.cache[operation]();
        release();
        await work;
        f.reads.length = 0;
        await f.cache.calculate('date', f.files, f.read, false);
        assert.deepEqual(f.reads, [9, 10, 11]);
    });
}
