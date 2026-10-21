import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { StatsRefreshResult } from '../../../fileLogger/refresh/statsRefreshQueue';
import { createUsageHost } from '../../../tests/hostFixture';
import { refreshFixture, refreshClock, gate } from '../../../tests/refresh/fixture';
import type { SnapshotStatsInternals } from '../../../tests/snapshotFixture';

test('late saved reads cannot supersede a completed source or suppress its publication', async suite => {
    const host = await createUsageHost();
    try {
        const { UsageStatusSnapshots } = await import('../../usageStatusSnapshots');
        Object.assign(host.bus, { publishIpcOnly: () => true });
        for (const publishedFirst of [false, true]) {
            await suite.test(`new source published first=${publishedFirst}`, async c => {
                host.reset();
                refreshClock(c);
                const f = await refreshFixture(host, c);
                const status = new UsageStatusSnapshots(
                    false,
                    date => f.fileLogger.readSavedStats(date),
                    date => f.fileLogger.getDateStats(date),
                    stats => f.fileLogger.getStatsSource(stats),
                    date => f.fileLogger.getLatestStatusStats(date)
                );
                Object.assign(f.manager, { statusSnapshots: status });
                await f.seed(1);
                assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
                const internals = f.internals.logStatsManager as unknown as SnapshotStatsInternals;
                const read = internals.loadStats.bind(internals);
                const entered = gate();
                const release = gate();
                let first = true;
                const blocked = c.mock.method(internals, 'loadStats', async (date: string) => {
                    const value = await read(date);
                    if (first && date === f.date) {
                        first = false;
                        assert.equal(value?.total.requests, 1);
                        entered.release();
                        await release.promise;
                    }
                    return value;
                });
                const oldRead = f.fileLogger.readSavedStats(f.date);
                try {
                    await entered.promise;
                    await f.fileLogger.recordEstimatedTokens({
                        requestId: `${Date.now()}_new`,
                        providerKey: 'test',
                        providerName: 'Test',
                        modelId: 'test',
                        modelName: 'Test',
                        estimatedInput: 10
                    });
                    await f.fileLogger.flush();
                    const current = await f.fileLogger.getDateStats(f.date, true);
                    assert.equal(current.total.requests, 2);
                    const result: StatsRefreshResult = {
                        date: f.date,
                        stats: current,
                        changed: true,
                        delegated: false
                    };
                    if (publishedFirst) {
                        f.manager.notifyStatsUpdate(result);
                        await f.internals.logStatsManager.flushStatsPublications();
                    }
                    assert.equal(f.fileLogger.getLatestStatusStats(f.date)?.stats.total.requests, 2);
                    release.release();
                    const old = await oldRead;
                    assert.equal(old?.total.requests, 1);
                    assert.ok(old);
                    const broadcasts = f.broadcasts().length;
                    f.manager.notifyStatsUpdate({ date: f.date, stats: old, changed: true, delegated: false });
                    assert.equal(f.broadcasts().length, broadcasts);
                    const latest = f.fileLogger.getLatestStatusStats(f.date);
                    f.manager.notifyStatsUpdate(result);
                    const displayed = await f.manager.getStatusSnapshot();
                    await f.internals.logStatsManager.flushStatsPublications();
                    const pending = await (
                        f.internals.logStatsManager as unknown as { publication: StatsPublication }
                    ).publication.readPendingStats(join(f.dir, 'usages', f.date, 'stats.json'));
                    assert.equal((await f.saved()).total.requests, 2);
                    assert.equal(latest?.stats.total.requests, 2);
                    assert.equal(displayed?.stats.total.requests, 2);
                    assert.equal(pending, undefined);
                    assert.equal(f.broadcasts().length, 1);
                } finally {
                    release.release();
                    try {
                        await oldRead;
                    } finally {
                        blocked.mock.restore();
                        await f.manager.dispose();
                    }
                }
            });
        }
    } finally {
        host.restore();
    }
});
