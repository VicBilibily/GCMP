import assert from 'node:assert/strict';
import test from 'node:test';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import type { StatsResultSource } from '../../fileLogger/refresh/statsRefreshQueue';
import { createStatusHost, stats, gate } from './fixture';
import { projectUsageStatus } from '../snapshot';

test('snapshot reads bind source updates and request dates', async suite => {
    const host = await createStatusHost();
    try {
        for (const count of [1, 2]) {
            await suite.test(`new source with projected requests=${count} protects an in-flight file read`, async c => {
                host.reset();
                const sources = new WeakMap<TokenUsageStatsFromFile, StatsResultSource>();
                const first = stats(1),
                    reading = stats(1),
                    current = stats(count);
                current.total.completedRequests = 0;
                sources.set(first, { revision: 1, authorityTerm: 'leader:1' });
                sources.set(reading, { revision: 2, authorityTerm: 'leader:1' });
                sources.set(current, { revision: 3, authorityTerm: 'leader:1' });
                const release = gate();
                const service = host.fixture(
                    c,
                    'remote',
                    true,
                    async () => {
                        await release.promise;
                        return reading;
                    },
                    undefined,
                    value => sources.get(value)
                );
                service.update(DateUtils.getTodayDateString(), first);
                const before = service.peek();
                const pending = service.get();
                service.update(DateUtils.getTodayDateString(), current);
                release.release();
                assert.equal((await pending)?.stats.total.requests, count);
                assert.equal(service.peek()?.stats.total.requests, count);
                assert.equal(service.peek() === before, count === 1);
                assert.equal(host.state.savedReads, 1);
            });
        }
        for (const revision of [1, 2]) {
            await suite.test(`unsolicited revision=${revision} cannot end a pending synchronization`, async c => {
                host.reset();
                let now = 1000;
                c.mock.method(Date, 'now', () => now);
                const service = host.fixture(c, 'follower');
                const snapshot = {
                    date: DateUtils.getTodayDateString(),
                    authorityTerm: 'leader:1',
                    revision: 2,
                    stats: projectUsageStatus(stats(2))
                };
                const push = (value: typeof snapshot) =>
                    host.deliver({
                        type: 'usageStatusSnapshot',
                        timestamp: now,
                        senderInstanceId: 'leader',
                        payload: { snapshot: value }
                    });
                push(snapshot);
                now += 30000;
                let completed = false;
                const pending = host
                    .run('follower', () => service.get())
                    .then(value => {
                        completed = true;
                        return value;
                    });
                const request = host.events.find(event => event.type === 'usageStatusSnapshotRequested');
                assert.ok(request?.type === 'usageStatusSnapshotRequested');
                push({ ...snapshot, revision });
                await Promise.resolve();
                assert.equal(completed, false);
                host.deliver({
                    type: 'usageStatusSnapshot',
                    timestamp: now,
                    senderInstanceId: 'leader',
                    payload: {
                        snapshot,
                        requestId: request.payload.requestId,
                        targetInstanceId: 'follower'
                    }
                });
                assert.equal((await pending)?.stats.total.requests, 2);
                const requests = host.events.length;
                await host.run('follower', () => service.get());
                assert.equal(host.events.length, requests);
            });
        }
        await suite.test(
            'same-term midnight replaces the previous date request and accepts only the new reply',
            async c => {
                host.reset();
                c.mock.timers.enable({ apis: ['setTimeout'] });
                let date = '2026-10-12';
                c.mock.method(DateUtils, 'getTodayDateString', () => date);
                host.state.deliver = false;
                const follower = host.fixture(c, 'follower');
                const old = host.run('follower', () => follower.get());
                date = '2026-10-13';
                const current = host.run('follower', () => follower.get());
                const requests = host.events.filter(event => event.type === 'usageStatusSnapshotRequested');
                assert.deepEqual(
                    requests.map(event => event.payload.date),
                    ['2026-10-12', '2026-10-13']
                );
                assert.notEqual(old, current);
                assert.equal(await old, undefined);
                c.mock.timers.tick(2000);
                assert.equal(await current, undefined);
                assert.equal(host.state.savedReads, 0);
                assert.equal(host.state.ownedReads, 0);
            }
        );
    } finally {
        host.restore();
    }
});
