import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { nextTurn, refreshClock, refreshFixture, terminal } from './fixture';

test('usage recording shares the statistics refresh window', async suite => {
    const host = await createUsageHost();
    try {
        for (const phase of ['estimated', 'completed', 'failed', 'cancelled'] as const) {
            for (const count of [1, 8]) {
                await suite.test(`${phase}/${count}: recording does not bypass the refresh window`, async context => {
                    host.reset();
                    const clock = refreshClock(context),
                        f = await refreshFixture(host, context);
                    const ids = await f.seed(count);
                    for (const id of ids) {
                        if (phase === 'estimated') {
                            await f.manager.recordEstimatedTokens({
                                providerKey: 'test',
                                displayName: 'Test',
                                modelId: 'test',
                                modelName: 'Test',
                                estimatedInputTokens: 10
                            });
                        } else {
                            f.manager.updateActualTokens({ ...terminal(id), status: phase });
                        }
                        await f.idleWrites();
                    }
                    assert.equal(f.counters.calculations, 0);
                    assert.equal(f.counters.notifications, 0);
                    assert.equal(f.broadcasts().length, 0);
                    await clock.settle(() => f.counters.notifications === 1);
                    assert.equal(f.counters.calculations, 1);
                    assert.equal(f.counters.peak, 1);
                    assert.equal(f.broadcasts().length, 1);
                    const saved = await f.saved();
                    assert.equal(saved.total.requests, phase === 'estimated' ? count * 2 : count);
                    if (phase !== 'estimated') {
                        assert.equal(saved.total[`${phase}Requests`], count);
                    }
                });
            }
        }
        await suite.test('twenty notifications share one refresh and one broadcast', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            await f.seed(1);
            for (let i = 0; i < 20; i++) {
                f.manager.notifyStatsUpdate();
            }
            await nextTurn();
            assert.equal(f.counters.notifications, 0);
            await clock.settle(() => f.counters.notifications === 1);
            assert.equal(f.counters.refreshes, 1);
            assert.equal(f.broadcasts().length, 1);
        });
        await suite.test(
            'a late terminal write queues one follow-up without overlapping calculations',
            async context => {
                host.reset();
                const clock = refreshClock(context),
                    f = await refreshFixture(host, context);
                const ids = await f.seed(8),
                    held = f.holdRead();
                try {
                    f.manager.updateActualTokens(terminal(ids[0]));
                    await f.fileLogger.flush();
                    clock.fire();
                    await held.entered;
                    for (const id of ids.slice(1)) {
                        f.manager.updateActualTokens(terminal(id));
                    }
                    await f.fileLogger.flush();
                    await nextTurn();
                    clock.fire();
                    assert.equal(f.counters.active, 1);
                    assert.equal(f.counters.peak, 1);
                    held.release();
                    await clock.settle(() => f.counters.notifications === 2);
                    assert.equal(f.counters.refreshes, 2);
                    assert.equal(f.counters.calculations, 2);
                    assert.equal(f.counters.peak, 1);
                    assert.equal((await f.saved()).total.completedRequests, 8);
                    assert.equal(f.broadcasts().length, 2);
                } finally {
                    held.release();
                    await f.settled();
                }
            }
        );
        await suite.test('an explicit forced read still bypasses the background window', async context => {
            host.reset();
            refreshClock(context);
            const f = await refreshFixture(host, context),
                ids = await f.seed(1);
            f.manager.updateActualTokens(terminal(ids[0]));
            await f.fileLogger.flush();
            const result = await f.fileLogger.getDateStats(f.date, true);
            assert.equal(result.total.completedRequests, 1);
            assert.ok(f.counters.calculations >= 1);
        });
        await suite.test('a terminal timestamp crossing midnight refreshes the actual written date', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const previous = new Date(`${f.date}T00:00:00`).getTime() - 1;
            context.mock.method(Date, 'now', () => previous);
            const id = await f.manager.recordEstimatedTokens({
                providerKey: 'test',
                displayName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInputTokens: 10
            });
            await f.idleWrites();
            f.manager.updateActualTokens(terminal(id));
            await f.idleWrites();
            assert.equal(f.counters.calculations, 0);
            await clock.settle(() => f.counters.notifications === 2);
            const dates = f
                .broadcasts()
                .flatMap(item => (item.event.type === 'tokenUsageUpdated' ? [item.event.payload.date] : []));
            assert.equal(new Set(dates).size, 2);
            assert.ok(dates.includes(f.date));
            assert.equal((await f.saved()).total.completedRequests, 1);
        });
    } finally {
        host.restore();
    }
});
