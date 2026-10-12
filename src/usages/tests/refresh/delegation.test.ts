import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { nextTurn, refreshClock, refreshFixture, terminal, until } from './fixture';

test('delegated statistics refresh coalescing', async suite => {
    const host = await createUsageHost();
    try {
        const { registerUsageRefreshHandlers } = await import('../../usageActivation');
        await suite.test('follower recording and display reads do not recalculate local hours', async context => {
            host.reset();
            const clock = refreshClock(context);
            const leader = await refreshFixture(host, context);
            const follower = await refreshFixture(host, context, 'follower', leader.extensionContext);
            const ids = await follower.seed(8);
            host.run('leader', () => registerUsageRefreshHandlers(leader.extensionContext));
            for (const id of ids) {
                host.run('follower', () => follower.manager.updateActualTokens(terminal(id)));
                await follower.idleWrites();
                await host.run('follower', () => follower.manager.getDateStats(follower.date));
            }
            assert.equal(follower.counters.calculations, 0);
            assert.equal(follower.broadcasts().length, 0);
            await clock.settle(() => leader.broadcasts().length === 1 && follower.counters.notifications === 1);
            assert.equal(leader.counters.calculations, 1);
            assert.equal(follower.counters.calculations, 0);
            assert.equal((await follower.saved()).total.completedRequests, 8);
        });
        for (const changed of [false, true]) {
            await suite.test(`eight delegated requests share completion with changed=${changed}`, async context => {
                host.reset();
                const clock = refreshClock(context),
                    f = await refreshFixture(host, context);
                const ids = await f.seed(1);
                host.run('leader', () => registerUsageRefreshHandlers(f.extensionContext));
                if (changed) {
                    await f.fileLogger.updateActualTokens(terminal(ids[0]));
                }
                for (let i = 0; i < 8; i++) {
                    host.run(`peer-${i}`, () =>
                        host.bus.publish({
                            type: 'statsRefreshRequested',
                            payload: {
                                requestId: `request-${i}`,
                                date: f.date,
                                regenerateAll: false,
                                requestedBy: `peer-${i}`
                            }
                        })
                    );
                }
                await nextTurn();
                await clock.settle(
                    () => host.events.filter(item => item.event.type === 'statsRefreshCompleted').length === 8
                );
                assert.equal(f.counters.calculations, changed ? 1 : 0);
                assert.equal(f.counters.refreshes, 1);
                assert.equal(f.broadcasts().length, changed ? 1 : 0);
                const idsCompleted = host.events.flatMap(item =>
                    item.event.type === 'statsRefreshCompleted' ? [item.event.payload.requestId] : []
                );
                assert.equal(new Set(idsCompleted).size, 8);
            });
        }
        await suite.test('local records and delegated requests share one published batch', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(1);
            host.run('leader', () => registerUsageRefreshHandlers(f.extensionContext));
            f.manager.updateActualTokens(terminal(ids[0]));
            await f.idleWrites();
            host.run('peer', () =>
                host.bus.publish({
                    type: 'statsRefreshRequested',
                    payload: { requestId: 'peer', date: f.date, regenerateAll: false, requestedBy: 'peer' }
                })
            );
            await clock.settle(() => host.events.some(item => item.event.type === 'statsRefreshCompleted'));
            await until(() => f.counters.notifications > 0);
            assert.equal(f.counters.calculations, 1);
            assert.equal(f.counters.notifications, 1);
            assert.equal(f.broadcasts().length, 1);
        });
    } finally {
        host.restore();
    }
});
