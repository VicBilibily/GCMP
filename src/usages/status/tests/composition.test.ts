import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { createUsageHost } from '../../tests/hostFixture';
import { refreshFixture, refreshClock, terminal } from '../../tests/refresh/fixture';
import { StatsPublication } from '../../fileLogger/refresh/statsPublication';
test('status presentation ordering preserves actual statistics publication', async suite => {
    const host = await createUsageHost();
    const { UsageStatusSnapshots: Service } = await import('../usageStatusSnapshots');
    Object.assign(host.bus, { publishIpcOnly: () => true });
    try {
        const makeStatus = (f: Awaited<ReturnType<typeof refreshFixture>>, fileMode: boolean) => {
            const service = new Service(
                fileMode,
                date => f.fileLogger.readSavedStats(date),
                date => f.fileLogger.getDateStats(date),
                value => f.fileLogger.getStatsSource(value),
                date => f.fileLogger.getLatestStatusStats(date)
            );
            Object.assign(f.manager, { statusSnapshots: service });
            return service;
        };
        for (const observed of [false, true]) {
            await suite.test(
                `same saved content observed first=${observed} publishes and acknowledges once`,
                async c => {
                    host.reset();
                    const clock = refreshClock(c);
                    const f = await refreshFixture(host, c);
                    makeStatus(f, true);
                    const ids = await f.seed(1);
                    await f.fileLogger.updateActualTokens(terminal(ids[0]));
                    let done = false;
                    const work = f.fileLogger.refreshStats(f.date).finally(() => {
                        done = true;
                    });
                    await clock.settle(() => done);
                    const result = await work;
                    assert.ok(result?.changed);
                    if (observed) {
                        assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
                    }
                    const acknowledgements = c.mock.method(f.fileLogger, 'markStatsPublished');
                    f.manager.notifyStatsUpdate(result);
                    f.manager.notifyStatsUpdate(result);
                    await f.internals.logStatsManager.flushStatsPublications();
                    assert.equal(f.broadcasts().length, 1);
                    assert.equal(acknowledgements.mock.calls.length, 1);
                    assert.equal(
                        await new StatsPublication().readPendingStats(join(f.dir, 'usages', f.date, 'stats.json')),
                        undefined
                    );
                }
            );
        }
        for (const publishNewer of [true, false]) {
            await suite.test(
                `latest completed source published first=${publishNewer} cannot be replaced by a late notification`,
                async c => {
                    host.reset();
                    const clock = refreshClock(c);
                    const f = await refreshFixture(host, c);
                    const status = makeStatus(f, false);
                    await f.seed(1);
                    assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 1);
                    const row = {
                        providerKey: 'test',
                        providerName: 'Test',
                        modelId: 'test',
                        modelName: 'Test',
                        estimatedInput: 10
                    };
                    await f.fileLogger.recordEstimatedTokens({ ...row, requestId: `${Date.now()}_first` });
                    await f.fileLogger.flush();
                    let done = false;
                    const work = f.fileLogger.refreshStats(f.date).finally(() => {
                        done = true;
                    });
                    await clock.settle(() => done);
                    const first = await work;
                    assert.ok(first);
                    assert.equal(first.stats.total.requests, 2);
                    await f.fileLogger.recordEstimatedTokens({ ...row, requestId: `${Date.now()}_second` });
                    await f.fileLogger.flush();
                    const current = await f.fileLogger.getDateStats(f.date, true);
                    assert.equal(current.total.requests, 3);
                    if (publishNewer) {
                        f.manager.notifyStatsUpdate({ date: f.date, stats: current, changed: true, delegated: false });
                    }
                    const acknowledgements = c.mock.method(f.fileLogger, 'markStatsPublished');
                    f.manager.notifyStatsUpdate(first);
                    assert.equal(acknowledgements.mock.calls.length, 0);
                    assert.equal(status.peek()?.stats.total.requests, 3);
                    const reads = c.mock.method(f.fileLogger, 'getDateStats');
                    assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 3);
                    assert.equal(reads.mock.calls.length, 0);
                    assert.equal((await f.saved()).total.requests, 3);
                    const latest = f.fileLogger.getLatestStatusStats(f.date);
                    assert.ok(latest);
                    assert.ok(Object.isFrozen(latest));
                    assert.ok(Object.isFrozen(latest.stats.total));
                    assert.throws(() => {
                        latest.stats.total.requests = 99;
                    }, TypeError);
                    assert.equal(status.peek()?.stats.total.requests, 3);
                }
            );
        }
    } finally {
        host.restore();
    }
});
