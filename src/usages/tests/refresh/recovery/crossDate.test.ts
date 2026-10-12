import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { StatsPublication } from '../../../fileLogger/refresh/statsPublication';
import type { TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../hostFixture';
import { gate, refreshClock, refreshFixture, terminal } from '../fixture';

test('cross-midnight publication recovery is independent of historical regeneration', async suite => {
    const host = await createUsageHost();
    try {
        const { registerUsageRefreshHandlers } = await import('../../../usageActivation');
        for (const route of ['periodic', 'all-then-periodic'] as const) {
            for (const lifecycle of ['handoff', 'restart'] as const) {
                for (const publication of ['pending', 'published', 'legacy'] as const) {
                    await suite.test(`${route}/${lifecycle}/${publication}`, async context => {
                        host.reset();
                        const midnight = new Date(2026, 9, 11, 23, 59, 58).getTime();
                        context.mock.timers.enable({ apis: ['Date'], now: midnight });
                        const clock = refreshClock(context);
                        const original = await refreshFixture(host, context);
                        const ids = await original.seed(1);
                        original.manager.updateActualTokens(terminal(ids[0]));
                        await original.idleWrites();
                        const stats = await original.fileLogger.getDateStats(original.date);
                        assert.equal(stats.total.completedRequests, 1);
                        if (publication !== 'pending') {
                            original.manager.notifyStatsUpdate({
                                date: original.date,
                                stats,
                                changed: true,
                                delegated: false
                            });
                            await original.fileLogger.flush();
                        }
                        if (publication === 'legacy') {
                            await rm(join(original.dir, 'usages', original.date, 'stats-publication.json'));
                            await rm(join(original.dir, 'usages', original.date, 'stats-published.json'));
                        }
                        await original.manager.dispose();
                        for (const subscription of original.extensionContext.subscriptions) {
                            subscription.dispose();
                        }
                        context.mock.timers.setTime(midnight + 4000);
                        const id = lifecycle === 'restart' ? 'leader' : 'successor';
                        host.state.leaderId = id;
                        const receiver = await refreshFixture(host, context, id, original.extensionContext);
                        host.run(id, () => registerUsageRefreshHandlers(receiver.extensionContext));
                        const today = await host.run(id, () => receiver.fileLogger.getDateStats(receiver.date, true));
                        await host.run(id, () =>
                            receiver.internals.logStatsManager.markStatsPublished(receiver.date, today)
                        );
                        const count = () =>
                            host.events.filter(
                                item =>
                                    item.event.type === 'tokenUsageUpdated' && item.event.payload.date === original.date
                            ).length;
                        const before = count();
                        for (let round = 0; round < 3; round++) {
                            if (route === 'periodic') {
                                let done = false;
                                const work = host
                                    .run(id, () => host.periodic[host.periodic.length - 1]())
                                    .finally(() => {
                                        done = true;
                                    });
                                await clock.settle(() => done);
                                await work;
                            } else {
                                const requestId = `${route}-${lifecycle}-${publication}-${round}`;
                                host.run('observer', () =>
                                    host.bus.publish({
                                        type: 'statsRefreshRequested',
                                        payload: { requestId, regenerateAll: true, requestedBy: 'observer' }
                                    })
                                );
                                await clock.settle(() =>
                                    host.events.some(
                                        item =>
                                            item.event.type === 'statsRefreshCompleted' &&
                                            item.event.payload.requestId === requestId
                                    )
                                );
                                const reply = host.events.find(
                                    item =>
                                        item.event.type === 'statsRefreshCompleted' &&
                                        item.event.payload.requestId === requestId
                                )!.event;
                                assert.equal(reply.type, 'statsRefreshCompleted');
                                if (reply.type === 'statsRefreshCompleted') {
                                    assert.deepEqual(reply.payload.regeneratedDates, []);
                                }
                                await receiver.settled();
                            }
                            await receiver.fileLogger.flush();
                            assert.equal(count() - before, route === 'periodic' && publication === 'pending' ? 1 : 0);
                        }
                        if (route === 'all-then-periodic') {
                            let done = false;
                            const work = host
                                .run(id, () => host.periodic[host.periodic.length - 1]())
                                .finally(() => {
                                    done = true;
                                });
                            await clock.settle(() => done);
                            await work;
                            await receiver.fileLogger.flush();
                            assert.equal(count() - before, publication === 'pending' ? 1 : 0);
                        }
                        const saved = await host.run(id, () => receiver.fileLogger.getDateStats(original.date));
                        assert.ok(saved);
                        assert.equal(saved.total.completedRequests, 1);
                        assert.equal(
                            await receiver.internals.logStatsManager.hasStatsChanged(original.date, saved),
                            false
                        );
                        assert.equal(receiver.counters.calculations, 1);
                        assert.deepEqual(await host.run(id, () => receiver.fileLogger.regenerateOutdatedStats()), {});
                    });
                }
            }
        }
        await suite.test('bounded batches eventually recover all dates without parsing raw logs', async context => {
            host.reset();
            const f = await host.fixture(context);
            const publication = new StatsPublication();
            for (let day = 1; day <= 45; day++) {
                const date = new Date(2026, 7, day).toLocaleDateString('sv-SE');
                const folder = join(f.dir, 'usages', date);
                const stats = host.emptyStats();
                stats.total.requests = day;
                await mkdir(folder, { recursive: true });
                await publication.prepare(
                    join(folder, 'stats.json'),
                    createHash('sha256').update(JSON.stringify(stats)).digest('hex')
                );
                await writeFile(join(folder, 'stats.json'), JSON.stringify(stats));
            }
            context.mock.method(f.internals.logStatsManager, 'getDateStats', () => {
                throw new Error('publication recovery must not regenerate statistics');
            });
            const read = StatsPublication.prototype.readPendingStats;
            let reads = 0;
            context.mock.method(
                StatsPublication.prototype,
                'readPendingStats',
                function (this: StatsPublication, statsPath: string) {
                    reads++;
                    return read.call(this, statsPath);
                }
            );
            const batches: number[] = [];
            for (let round = 0; round < 4; round++) {
                const before = reads;
                await f.fileLogger.recoverStatsPublications(result => f.manager.notifyStatsUpdate(result));
                batches.push(reads - before);
                const updates = host.events.filter(item => item.event.type === 'tokenUsageUpdated');
                assert.equal(updates.length, Math.min((round + 1) * 20, 45));
                assert.equal(
                    new Set(
                        updates.map(item => (item.event.type === 'tokenUsageUpdated' ? item.event.payload.date : ''))
                    ).size,
                    updates.length
                );
            }
            assert.deepEqual(batches, [20, 20, 20, 20]);
        });
        for (const scenario of ['concurrent', 'follower', 'replacement', 'disposed', 'corrupt'] as const) {
            await suite.test(`pending recovery boundary/${scenario}`, async context => {
                host.reset();
                const f = await host.fixture(context);
                const folder = join(f.dir, 'usages', '2026-10-01');
                const stats: TokenUsageStatsFromFile = host.emptyStats();
                await mkdir(folder, { recursive: true });
                const statsPath = join(folder, 'stats.json');
                const publication = new StatsPublication();
                const fingerprint = createHash('sha256').update(JSON.stringify(stats)).digest('hex');
                await publication.prepare(statsPath, fingerprint);
                await writeFile(statsPath, JSON.stringify(stats));
                if (scenario === 'corrupt') {
                    const badFolder = join(f.dir, 'usages', '2026-09-30');
                    await mkdir(badFolder, { recursive: true });
                    await writeFile(join(badFolder, 'stats-publication.json'), '{');
                }
                if (scenario === 'follower') {
                    host.state.leaderId = 'successor';
                }
                const entered = gate(),
                    blocked = gate();
                const read = StatsPublication.prototype.readPendingStats;
                let reads = 0;
                context.mock.method(
                    StatsPublication.prototype,
                    'readPendingStats',
                    async function (this: StatsPublication, target: string) {
                        reads++;
                        const value = await read.call(this, target);
                        entered.release();
                        await blocked.promise;
                        return value;
                    }
                );
                const publish = (result: Parameters<typeof f.manager.notifyStatsUpdate>[0]) =>
                    f.manager.notifyStatsUpdate(result);
                const first = f.fileLogger.recoverStatsPublications(publish);
                let disposal: Promise<void> | undefined;
                try {
                    if (scenario !== 'follower') {
                        await entered.promise;
                    }
                    if (scenario === 'concurrent') {
                        assert.equal(f.fileLogger.recoverStatsPublications(publish), first);
                    }
                    if (scenario === 'replacement') {
                        host.state.leaderId = 'successor';
                    }
                    if (scenario === 'disposed') {
                        disposal = f.fileLogger.dispose();
                    }
                } finally {
                    blocked.release();
                }
                await first;
                await disposal;
                await f.fileLogger.flush();
                const expected = scenario === 'concurrent' || scenario === 'corrupt' ? 1 : 0;
                assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, expected);
                assert.equal(await publication.isPending(statsPath, fingerprint), expected === 0);
                assert.equal(
                    reads,
                    scenario === 'follower' ? 0
                    : scenario === 'corrupt' ? 2
                    : 1
                );
            });
        }
    } finally {
        host.restore();
    }
});
