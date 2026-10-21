import assert from 'node:assert/strict';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import { refreshFixture, refreshClock, gate } from '../../../tests/refresh/fixture';
import type { SnapshotStatsInternals } from '../../../tests/snapshotFixture';

interface Calculating {
    calculateDateStats(date: string, force: boolean): Promise<TokenUsageStatsFromFile>;
}

async function waitForPause(ready: Promise<void>, work: Promise<unknown>, context: TestContext): Promise<void> {
    context.signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(context.signal.reason);
        context.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([
            ready,
            work.then(() => {
                throw new Error('Operation ended before the expected pause');
            }),
            aborted
        ]);
    } finally {
        context.signal.removeEventListener('abort', onAbort);
    }
}

test(
    'display reads during active refresh must not outrank the subsequently committed source',
    { timeout: 30000 },
    async suite => {
        const host = await createUsageHost();
        try {
            const { UsageStatusSnapshots } = await import('../../usageStatusSnapshots');
            const { TokenFileLogger } = await import('../../../fileLogger');
            Object.assign(host.bus, { publishIpcOnly: () => true });
            const makeStatus = (f: Awaited<ReturnType<typeof refreshFixture>>) => {
                const status = new UsageStatusSnapshots(
                    false,
                    date => f.fileLogger.readSavedStats(date),
                    date => f.fileLogger.getDateStats(date),
                    stats => f.fileLogger.getStatsSource(stats),
                    date => f.fileLogger.getLatestStatusStats(date)
                );
                Object.assign(f.manager, { statusSnapshots: status });
                return status;
            };
            const row = {
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10
            };
            for (const overlap of [false, true]) {
                await suite.test(`display overlaps calculation=${overlap}`, async c => {
                    host.reset();
                    const clock = refreshClock(c);
                    const f = await refreshFixture(host, c);
                    const status = makeStatus(f);
                    await f.seed(1);
                    assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
                    await f.fileLogger.recordEstimatedTokens({ ...row, requestId: `${Date.now()}_second` });
                    await f.fileLogger.flush();
                    const stats = f.internals.logStatsManager as unknown as Calculating;
                    const calculate = stats.calculateDateStats.bind(stats);
                    const entered = gate();
                    const release = gate();
                    const paused = c.mock.method(
                        stats,
                        'calculateDateStats',
                        async (...args: Parameters<typeof calculate>) => {
                            const value = await calculate(...args);
                            assert.equal(value.total.requests, 2);
                            entered.release();
                            await release.promise;
                            return value;
                        }
                    );
                    const running = f.fileLogger.refreshStats(f.date);
                    void running.catch(() => undefined);
                    try {
                        clock.fire();
                        await waitForPause(entered.promise, running, c);
                        if (overlap) {
                            const displayedRead = await f.fileLogger.getDateStats(f.date, false, true);
                            assert.equal(displayedRead.total.requests, 1);
                        }
                        release.release();
                        const result = await running;
                        assert.ok(result?.changed);
                        assert.equal(result.stats.total.requests, 2);
                        if (!overlap) {
                            const displayedRead = await f.fileLogger.getDateStats(f.date, false, true);
                            assert.equal(displayedRead.total.requests, 2);
                        }
                        const acknowledgements = c.mock.method(f.fileLogger, 'markStatsPublished');
                        f.manager.notifyStatsUpdate(result);
                        await f.internals.logStatsManager.flushStatsPublications();
                        const latest = f.fileLogger.getLatestStatusStats(f.date);
                        const displayed = status.peek();
                        const ownerRead = await f.manager.getStatusSnapshot();
                        const pending = await (
                            f.internals.logStatsManager as unknown as { publication: StatsPublication }
                        ).publication.readPendingStats(join(f.dir, 'usages', f.date, 'stats.json'));
                        assert.equal((await f.saved()).total.requests, 2);
                        assert.equal(latest?.stats.total.requests, 2);
                        assert.equal(displayed?.stats.total.requests, 2);
                        assert.equal(ownerRead?.stats.total.requests, 2);
                        assert.equal(f.broadcasts().length, 1);
                        assert.equal(acknowledgements.mock.calls.length, 1);
                        assert.equal(pending, undefined);
                    } finally {
                        entered.release();
                        release.release();
                        try {
                            await running;
                        } finally {
                            paused.mock.restore();
                            await f.manager.dispose();
                        }
                    }
                });
            }
            await suite.test('saved reads follow disk versions, not start or finish order', async c => {
                host.reset();
                refreshClock(c);
                const f = await refreshFixture(host, c);
                const status = makeStatus(f);
                await f.seed(1);
                assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
                const writer = new TokenFileLogger(f.extensionContext);
                const stats = f.internals.logStatsManager as unknown as SnapshotStatsInternals;
                const load = stats.loadStats.bind(stats);
                const beforeLoad = gate();
                const allowLoad = gate();
                const oldLoaded = gate();
                const allowOldReturn = gate();
                let reads = 0;
                const paused = c.mock.method(stats, 'loadStats', async (date: string) => {
                    const order = ++reads;
                    if (order === 1) {
                        beforeLoad.release();
                        await allowLoad.promise;
                    }
                    const value = await load(date);
                    if (order === 2) {
                        assert.equal(value?.total.requests, 1);
                        oldLoaded.release();
                        await allowOldReturn.promise;
                    }
                    return value;
                });
                const first = f.fileLogger.readSavedStats(f.date);
                const tasks: Promise<unknown>[] = [first];
                void first.catch(() => undefined);
                try {
                    await waitForPause(beforeLoad.promise, first, c);
                    const second = f.fileLogger.readSavedStats(f.date);
                    tasks.push(second);
                    void second.catch(() => undefined);
                    await waitForPause(oldLoaded.promise, second, c);
                    await writer.recordEstimatedTokens({ ...row, requestId: `${Date.now()}_new` });
                    await writer.flush();
                    assert.equal((await writer.getDateStats(f.date, true)).total.requests, 2);
                    allowLoad.release();
                    const newer = await first;
                    assert.ok(newer);
                    assert.equal(newer.total.requests, 2);
                    status.update(f.date, newer);
                    assert.equal(status.peek()?.stats.total.requests, 2);
                    allowOldReturn.release();
                    const older = await second;
                    assert.ok(older);
                    assert.equal(older.total.requests, 1);
                    status.update(f.date, older);
                    assert.equal((await f.saved()).total.requests, 2);
                    assert.equal(f.fileLogger.getLatestStatusStats(f.date)?.stats.total.requests, 2);
                    assert.equal(status.peek()?.stats.total.requests, 2);
                    assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 2);
                } finally {
                    beforeLoad.release();
                    allowLoad.release();
                    oldLoaded.release();
                    allowOldReturn.release();
                    await Promise.allSettled(tasks);
                    paused.mock.restore();
                    try {
                        await writer.dispose();
                    } finally {
                        await f.manager.dispose();
                    }
                }
            });
        } finally {
            host.restore();
        }
    }
);
