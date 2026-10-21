import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { StatsPublication } from '../../fileLogger/refresh/statsPublication';
import { createUsageHost } from '../hostFixture';
import { nextTurn, refreshClock, refreshFixture, terminal } from './fixture';

test('statistics publication survives foreground calculations', async suite => {
    const host = await createUsageHost();
    try {
        const { registerUsageRefreshHandlers } = await import('../../usageActivation');
        for (const phase of ['estimated', 'completed'] as const) {
            for (const read of ['none', 'display', 'forced'] as const) {
                await suite.test(`${phase}: foreground ${read} publishes once`, async context => {
                    host.reset();
                    const clock = refreshClock(context);
                    const leader = await refreshFixture(host, context);
                    const writer = await refreshFixture(host, context, 'writer', leader.extensionContext);
                    const ids = await writer.seed(1);
                    host.run('leader', () => registerUsageRefreshHandlers(leader.extensionContext));
                    assert.equal((await leader.manager.getDateStats(leader.date)).total.requests, 1);
                    if (phase === 'completed') {
                        host.run('writer', () => writer.manager.updateActualTokens(terminal(ids[0])));
                    } else {
                        await host.run('writer', () =>
                            writer.manager.recordEstimatedTokens({
                                providerKey: 'test',
                                displayName: 'Test',
                                modelId: 'test',
                                modelName: 'Test',
                                estimatedInputTokens: 10
                            })
                        );
                    }
                    await writer.idleWrites();
                    if (read === 'display') {
                        await leader.manager.getDateStats(leader.date);
                    } else if (read === 'forced') {
                        await leader.fileLogger.getDateStats(leader.date, true);
                    }
                    await clock.settle(() => host.events.some(item => item.event.type === 'statsRefreshCompleted'));
                    await leader.settled();
                    await writer.settled();
                    assert.equal(leader.broadcasts().length, 1);
                    assert.equal(writer.counters.calculations, 0);
                    assert.equal(writer.counters.notifications, 1);
                    const saved = await leader.saved();
                    assert.equal(saved.total.requests, phase === 'estimated' ? 2 : 1);
                    assert.equal(saved.total.completedRequests, phase === 'completed' ? 1 : 0);
                    for (let round = 0; round < 3; round++) {
                        let done = false;
                        const pending = host
                            .run('leader', () => host.periodic[0]())
                            .finally(() => {
                                done = true;
                            });
                        await clock.settle(() => done);
                        await pending;
                        assert.equal(leader.broadcasts().length, 1);
                    }
                });
            }
        }
        await suite.test('an older publication cannot acknowledge a newer calculation', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(2);
            await f.fileLogger.updateActualTokens(terminal(ids[0]));
            let firstDone = false;
            const firstPending = f.fileLogger.refreshStats(f.date).finally(() => {
                firstDone = true;
            });
            await clock.settle(() => firstDone);
            const first = await firstPending;
            assert.ok(first);
            await f.fileLogger.updateActualTokens(terminal(ids[1]));
            const newer = await f.fileLogger.getDateStats(f.date, true);
            assert.equal(newer.total.completedRequests, 2);
            const acknowledgements = context.mock.method(f.fileLogger, 'markStatsPublished');
            const publication = (f.internals.logStatsManager as unknown as { publication: StatsPublication })
                .publication;
            const statsPath = join(f.dir, 'usages', f.date, 'stats.json');
            f.manager.notifyStatsUpdate(first);
            assert.equal(f.broadcasts().length, 0);
            assert.equal(acknowledgements.mock.callCount(), 0);
            assert.equal(f.fileLogger.getStatsSource(first.stats)?.stale, true);
            assert.equal((await publication.readPendingStats(statsPath))?.total.completedRequests, 2);
            let nextDone = false;
            const nextPending = f.fileLogger.refreshStats(f.date).finally(() => {
                nextDone = true;
            });
            await clock.settle(() => nextDone);
            const next = await nextPending;
            assert.ok(next);
            f.manager.notifyStatsUpdate(next);
            await f.internals.logStatsManager.flushStatsPublications();
            assert.equal(f.broadcasts().length, 1);
            assert.equal(acknowledgements.mock.callCount(), 1);
            assert.equal(acknowledgements.mock.calls[0].arguments[0], next);
            assert.equal(await publication.readPendingStats(statsPath), undefined);
            const event = f.broadcasts()[0].event;
            assert.equal(event.type, 'tokenUsageUpdated');
            if (event.type === 'tokenUsageUpdated') {
                assert.equal(event.payload.totalRequests, 2);
            }
        });
        await suite.test('a foreground first calculation still reaches other windows', async context => {
            host.reset();
            const clock = refreshClock(context);
            const leader = await refreshFixture(host, context);
            const writer = await refreshFixture(host, context, 'writer', leader.extensionContext);
            host.run('leader', () => registerUsageRefreshHandlers(leader.extensionContext));
            await host.run('writer', () =>
                writer.manager.recordEstimatedTokens({
                    providerKey: 'test',
                    displayName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInputTokens: 10
                })
            );
            await writer.idleWrites();
            assert.equal((await leader.manager.getDateStats(leader.date)).total.requests, 1);
            await clock.settle(() => host.events.some(item => item.event.type === 'statsRefreshCompleted'));
            await leader.settled();
            await writer.settled();
            assert.equal(leader.broadcasts().length, 1);
            assert.equal(writer.counters.calculations, 0);
        });
        await suite.test('a failed broadcast leaves the persisted change pending', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(1);
            await f.fileLogger.updateActualTokens(terminal(ids[0]));
            let done = false;
            const work = f.fileLogger.refreshStats(f.date).finally(() => {
                done = true;
            });
            await clock.settle(() => done);
            const result = await work;
            assert.ok(result);
            const publish = host.bus.publish.bind(host.bus);
            const mock = context.mock.method(host.bus, 'publish', (...args: Parameters<typeof publish>) => {
                if (args[0].type === 'tokenUsageUpdated') {
                    throw new Error('broadcast failure');
                }
                return publish(...args);
            });
            assert.throws(() => f.manager.notifyStatsUpdate(result), /broadcast failure/);
            mock.mock.restore();
            done = false;
            const retry = f.fileLogger.refreshStats(f.date).finally(() => {
                done = true;
            });
            await clock.settle(() => done);
            f.manager.notifyStatsUpdate(await retry);
            assert.equal(f.broadcasts().length, 1);
        });
        await suite.test('an all-date cache hit preserves the pending periodic notification', async context => {
            host.reset();
            const clock = refreshClock(context);
            const f = await refreshFixture(host, context);
            const ids = await f.seed(1);
            host.run('leader', () => registerUsageRefreshHandlers(f.extensionContext));
            await f.fileLogger.updateActualTokens(terminal(ids[0]));
            await f.fileLogger.getDateStats(f.date, true);
            for (let i = 0; i < 2; i++) {
                host.run('peer', () =>
                    host.bus.publish({
                        type: 'statsRefreshRequested',
                        payload: { requestId: `all-${i}`, regenerateAll: true, requestedBy: 'peer' }
                    })
                );
                const { until } = await import('./fixture');
                await until(() => host.events.filter(item => item.event.type === 'statsRefreshCompleted').length > i);
                assert.equal(f.broadcasts().length, 0);
            }
            for (let i = 0; i < 2; i++) {
                let done = false;
                const pending = host
                    .run('leader', () => host.periodic[0]())
                    .finally(() => {
                        done = true;
                    });
                await clock.settle(() => done);
                await pending;
                assert.equal(f.broadcasts().length, 1);
            }
        });
    } finally {
        await nextTurn();
        host.restore();
    }
});
