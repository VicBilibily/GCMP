import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { nextTurn, refreshClock, refreshFixture, terminal } from './fixture';

test('statistics publication survives publisher replacement without repeating acknowledged versions', async suite => {
    const host = await createUsageHost();
    try {
        const { registerUsageRefreshHandlers } = await import('../../usageActivation');
        for (const phase of ['estimated', 'completed'] as const) {
            for (const lifecycle of ['stable', 'handoff', 'restart'] as const) {
                for (const published of [false, true]) {
                    await suite.test(`${phase}/${lifecycle}/published=${published}`, async context => {
                        host.reset();
                        const clock = refreshClock(context);
                        const initial = await refreshFixture(host, context);
                        const writer = await refreshFixture(host, context, 'writer', initial.extensionContext);
                        const ids = await writer.seed(1);
                        host.run('leader', () => registerUsageRefreshHandlers(initial.extensionContext));
                        await initial.manager.getDateStats(initial.date);
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
                        const stats = await initial.manager.getDateStats(initial.date);
                        assert.equal(stats.total.requests, phase === 'estimated' ? 2 : 1);
                        assert.equal(stats.total.completedRequests, phase === 'completed' ? 1 : 0);
                        if (published) {
                            const persisted = await initial.fileLogger.getDateStats(initial.date);
                            initial.manager.notifyStatsUpdate({
                                date: initial.date,
                                stats: persisted,
                                changed: true,
                                delegated: false
                            });
                            await initial.fileLogger.flush();
                        }
                        const before = host.events.filter(item => item.event.type === 'tokenUsageUpdated').length;
                        let receiver = initial;
                        if (lifecycle === 'handoff') {
                            receiver = await refreshFixture(host, context, 'successor', initial.extensionContext);
                            host.state.leaderId = 'successor';
                            host.run('successor', () => registerUsageRefreshHandlers(receiver.extensionContext));
                        } else if (lifecycle === 'restart') {
                            await initial.manager.dispose();
                            for (const subscription of initial.extensionContext.subscriptions) {
                                subscription.dispose();
                            }
                            receiver = await refreshFixture(host, context, 'leader', initial.extensionContext);
                            host.run('leader', () => registerUsageRefreshHandlers(receiver.extensionContext));
                        }
                        await clock.settle(() => host.events.some(item => item.event.type === 'statsRefreshCompleted'));
                        await receiver.settled();
                        await writer.settled();
                        for (let round = 0; round < 3; round++) {
                            let done = false;
                            const pending = host
                                .run(receiver.id, () => host.periodic[host.periodic.length - 1]())
                                .finally(() => {
                                    done = true;
                                });
                            await clock.settle(() => done);
                            await pending;
                            const count = host.events.filter(item => item.event.type === 'tokenUsageUpdated').length;
                            assert.equal(count - before, published ? 0 : 1);
                        }
                        assert.equal(writer.counters.calculations, 0);
                        assert.equal(writer.counters.notifications, 1);
                        assert.equal((await receiver.saved()).total.completedRequests, phase === 'completed' ? 1 : 0);
                    });
                }
            }
        }
    } finally {
        await nextTurn();
        host.restore();
    }
});
