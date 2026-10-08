import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { DateIndex, TokenUsageStatsFromFile } from '../fileLogger/types';
import { createUsageHost } from './hostFixture';

const currentDate = '2026-10-07';
const previousDate = '2026-10-06';

test('multi-day analysis reuses one reconciled index without keeping it across requests', async suite => {
    const host = await createUsageHost();
    try {
        const { MultiDayAggregator } = await import('../multiDay/multiDayAggregator');
        async function fixture(context: TestContext) {
            host.reset();
            const f = await host.fixture(context);
            const indexPath = join(f.dir, 'usages', 'index.json');
            async function setDay(date: string, tokens: number) {
                const stats = host.emptyStats();
                Object.assign(stats.total, { actualInput: tokens, requests: 1, completedRequests: 1 });
                const folder = join(f.dir, 'usages', date);
                await mkdir(folder, { recursive: true });
                await writeFile(join(folder, 'stats.json'), JSON.stringify(stats));
            }
            await setDay(previousDate, 10);
            await setDay(currentDate, 20);
            await writeFile(
                indexPath,
                JSON.stringify({
                    versionTimestamp: 42,
                    dates: {
                        '2026-10-01': {
                            total_input: 999,
                            total_output: 0,
                            total_cache: 0,
                            total_requests: 99,
                            total_cost: 0,
                            total_cost_rmb: 0
                        }
                    }
                })
            );
            const regenerate = context.mock.method(f.fileLogger, 'regenerateOutdatedStats', async () => ({}));
            const index = context.mock.method(f.fileLogger, 'getIndex');
            const fast = context.mock.method(f.fileLogger, 'getIndexFast', async () => {
                throw new Error('must reconcile');
            });
            context.mock.method(
                f.internals.logStatsManager,
                'getDateStats',
                async (date: string) =>
                    JSON.parse(
                        await readFile(join(f.dir, 'usages', date, 'stats.json'), 'utf8')
                    ) as TokenUsageStatsFromFile
            );
            return { ...f, indexPath, setDay, regenerate, index, fast };
        }

        await suite.test(
            'current and previous periods share one full reconciliation and repair a stale index',
            async context => {
                const f = await fixture(context);
                const result = await f.manager.getMultiDayStats(currentDate, currentDate);
                assert.equal(result.summary.totalTokens, 20);
                assert.equal(result.summary.tokensChangePct, 100);
                assert.equal(result.dayCount, 1);
                assert.deepEqual(result.missingDates, []);
                const saved = JSON.parse(await readFile(f.indexPath, 'utf8')) as DateIndex;
                assert.deepEqual(Object.keys(saved.dates).sort(), [previousDate, currentDate]);
                assert.equal(saved.dates[currentDate].total_input, 20);
                assert.equal(saved.dates[previousDate].total_input, 10);
                assert.equal(saved.versionTimestamp, 42);
                assert.equal(f.index.mock.callCount(), 1);
                assert.equal(f.fast.mock.callCount(), 0);
                assert.equal(f.regenerate.mock.callCount(), 1);
            }
        );

        await suite.test('a later analysis sees new stats and reconciles again', async context => {
            const f = await fixture(context);
            const first = await f.manager.getMultiDayStats(currentDate, currentDate);
            await f.setDay(currentDate, 40);
            const second = await f.manager.getMultiDayStats(currentDate, currentDate);
            assert.equal(first.summary.totalTokens, 20);
            assert.equal(second.summary.totalTokens, 40);
            assert.equal(second.summary.tokensChangePct, 300);
            assert.equal(f.index.mock.callCount(), 2);
            assert.equal(f.regenerate.mock.callCount(), 2);
        });

        await suite.test('concurrent analyses each own one reconciled index', async context => {
            const f = await fixture(context);
            const results = await Promise.all(
                Array.from({ length: 3 }, () => f.manager.getMultiDayStats(currentDate, currentDate))
            );
            assert.equal(
                results.every(result => result.summary.totalTokens === 20 && result.summary.tokensChangePct === 100),
                true
            );
            assert.equal(f.index.mock.callCount(), 3);
        });

        for (const kind of ['empty-range', 'zero-tokens', 'current-read-failure', 'previous-read-failure'] as const) {
            await suite.test(`${kind} keeps existing missing-data and comparison behavior`, async context => {
                const f = await fixture(context);
                if (kind === 'zero-tokens') {
                    await f.setDay(currentDate, 0);
                }
                if (kind === 'current-read-failure' || kind === 'previous-read-failure') {
                    const dateToFail = kind === 'current-read-failure' ? currentDate : previousDate;
                    const read = f.fileLogger.getDateStatsFromFile.bind(f.fileLogger);
                    context.mock.method(f.fileLogger, 'getDateStatsFromFile', async (date: string) => {
                        if (date === dateToFail) {
                            throw new Error('synthetic unreadable date');
                        }
                        return read(date);
                    });
                }
                const date = kind === 'empty-range' ? '2026-09-01' : currentDate;
                const result = await f.manager.getMultiDayStats(date, date);
                assert.equal(result.summary.tokensChangePct, null);
                assert.deepEqual(result.missingDates, kind === 'current-read-failure' ? [currentDate] : []);
                assert.equal(result.summary.totalTokens, kind === 'previous-read-failure' ? 20 : 0);
                assert.equal(f.index.mock.callCount(), 1);
                assert.equal(f.fast.mock.callCount(), 0);
            });
        }

        await suite.test('index failures propagate and do not poison the next analysis', async context => {
            const f = await fixture(context);
            const read = f.fileLogger.getIndex.bind(f.fileLogger);
            let fail = true;
            context.mock.method(f.fileLogger, 'getIndex', async () => {
                if (fail) {
                    throw new Error('synthetic index failure');
                }
                return read();
            });
            await assert.rejects(f.manager.getMultiDayStats(currentDate, currentDate), /synthetic index failure/);
            fail = false;
            assert.equal((await f.manager.getMultiDayStats(currentDate, currentDate)).summary.totalTokens, 20);
            assert.equal(f.index.mock.callCount(), 1);
        });

        await suite.test(
            'standalone aggregator still refreshes its index on each call and validates ranges',
            async context => {
                const f = await fixture(context);
                const aggregator = new MultiDayAggregator(f.fileLogger);
                await assert.rejects(aggregator.aggregate('2024-01-01', currentDate), /maximum of 365 days/);
                assert.equal(f.index.mock.callCount(), 0);
                assert.equal((await aggregator.aggregate(currentDate, currentDate)).summary.totalTokens, 20);
                await f.setDay(currentDate, 50);
                assert.equal((await aggregator.aggregate(currentDate, currentDate)).summary.totalTokens, 50);
                assert.equal(f.index.mock.callCount(), 2);
            }
        );
    } finally {
        host.restore();
    }
});
