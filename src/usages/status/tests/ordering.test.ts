import assert from 'node:assert/strict';
import test from 'node:test';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { StatsRefreshResult, StatsResultSource } from '../../fileLogger/refresh/statsRefreshQueue';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import { createStatusHost, stats } from './fixture';

test('status publication rejects stale results and survives same-term service reconstruction', async t => {
    const host = await createStatusHost();
    t.after(() => host.restore());
    const today = DateUtils.getTodayDateString();
    const sources = new WeakMap<TokenUsageStatsFromFile, StatsResultSource>();
    const result = (revision: number, count: number, authorityTerm = 'leader:1'): StatsRefreshResult => {
        const data = stats(count);
        sources.set(data, { revision, authorityTerm });
        return { date: today, stats: data, changed: true, delegated: false };
    };

    await t.test(
        'manager drops repeated and separately wrapped old results before notifying or acknowledging',
        async c => {
            host.reset();
            const status = host.fixture(c, 'leader', false, undefined, undefined, value => sources.get(value));
            const { TokenUsagesManager } = await import('../../usagesManager');
            const Manager = TokenUsagesManager as unknown as new () => typeof TokenUsagesManager.instance;
            const manager = new Manager();
            let acknowledgements = 0;
            Object.assign(manager, {
                initialized: true,
                statusSnapshots: status,
                fileLogger: {
                    getStatsSource: (value: TokenUsageStatsFromFile) => sources.get(value),
                    markStatsPublished: () => {
                        acknowledgements++;
                    },
                    dispose: async () => {}
                }
            });
            c.after(() => manager.dispose());
            const first = result(1, 1);
            const second = result(2, 2);
            manager.notifyStatsUpdate(first);
            manager.notifyStatsUpdate(second);
            manager.notifyStatsUpdate(first);
            manager.notifyStatsUpdate({ ...first });
            assert.equal(status.peek()?.stats.total.requests, 2);
            assert.equal(host.events.filter(event => event.type === 'usageStatusSnapshot').length, 2);
            assert.equal(host.events.filter(event => event.type === 'tokenUsageUpdated').length, 2);
            assert.equal(acknowledgements, 2);
            manager.notifyStatsUpdate(result(3, 1));
            assert.equal(status.peek()?.stats.total.requests, 1);
            assert.equal(acknowledgements, 3);
        }
    );

    await t.test('unchanged results initialize presentation without consuming publication acknowledgement', async c => {
        host.reset();
        const status = host.fixture(c, 'leader', false, undefined, undefined, value => sources.get(value));
        const { TokenUsagesManager } = await import('../../usagesManager');
        const Manager = TokenUsagesManager as unknown as new () => typeof TokenUsagesManager.instance;
        const manager = new Manager();
        let acknowledgements = 0;
        Object.assign(manager, {
            initialized: true,
            statusSnapshots: status,
            fileLogger: {
                getStatsSource: (value: TokenUsageStatsFromFile) => sources.get(value),
                markStatsPublished: () => {
                    acknowledgements++;
                },
                dispose: async () => {}
            }
        });
        c.after(() => manager.dispose());
        manager.notifyStatsUpdate({ ...result(1, 1), changed: false });
        assert.equal(status.peek()?.stats.total.requests, 1);
        assert.equal(host.events.filter(event => event.type === 'tokenUsageUpdated').length, 0);
        assert.equal(acknowledgements, 0);
    });

    await t.test('old-term data cannot be relabelled as a new term', c => {
        host.reset();
        const status = host.fixture(c, 'leader', false, undefined, undefined, value => sources.get(value));
        const old = result(1, 1);
        status.update(today, old.stats);
        host.state.term = 'leader:2';
        assert.equal(status.update(today, old.stats), undefined);
        const current = result(2, 2, 'leader:2');
        status.update(today, current.stats);
        assert.equal(status.peek()?.authorityTerm, 'leader:2');
        assert.equal(status.peek()?.stats.total.requests, 2);
        assert.equal(host.events.filter(event => event.type === 'usageStatusSnapshot').length, 2);
    });

    await t.test('same-term service reconstruction retains monotonic push revisions', c => {
        host.reset();
        const follower = host.fixture(c, 'follower');
        const old = host.fixture(c);
        old.update(today, stats(1));
        const revision = follower.peek()!.revision;
        old.dispose();
        const current = host.fixture(c);
        current.update(today, stats(2));
        assert.ok(follower.peek()!.revision > revision);
        assert.equal(follower.peek()?.stats.total.requests, 2);
    });
});
