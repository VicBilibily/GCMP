import assert from 'node:assert/strict';
import test from 'node:test';
import { DateUtils } from '../../fileLogger/dateUtils';
import { createStatusHost, stats } from './fixture';

test('snapshot synchronization repairs missed pushes without file polling', async t => {
    const host = await createStatusHost();
    t.after(() => host.restore());

    await t.test('a connected follower requests its first snapshot despite incompatible detail queries', async c => {
        host.reset();
        const owner = host.fixture(c);
        owner.update(DateUtils.getTodayDateString(), stats(2));
        const follower = host.fixture(c, 'follower');
        host.state.queryCompatible = false;

        const snapshot = await host.run('follower', () => follower.get());

        assert.equal(snapshot?.stats.total.requests, 2);
        assert.equal(host.events.filter(event => event.type === 'usageStatusSnapshotRequested').length, 1);
        assert.equal(host.state.savedReads, 0);
        assert.equal(host.state.ownedReads, 0);
    });

    await t.test(
        'aged follower cache requests only the owner memory snapshot and renews on identical replies',
        async c => {
            host.reset();
            let now = 1000;
            c.mock.method(Date, 'now', () => now);
            const owner = host.fixture(c);
            const follower = host.fixture(c, 'follower');
            owner.update(DateUtils.getTodayDateString(), stats(1));
            assert.equal(follower.peek()?.stats.total.requests, 1);
            host.state.deliver = false;
            owner.update(DateUtils.getTodayDateString(), stats(2));
            host.state.deliver = true;
            assert.equal(follower.peek()?.stats.total.requests, 1);
            now += 30000;
            assert.equal((await host.run('follower', () => follower.get()))?.stats.total.requests, 2);
            assert.equal(host.state.savedReads, 0);
            assert.equal(host.state.ownedReads, 0);
            now += 30000;
            await host.run('follower', () => follower.get());
            const requests = host.events.filter(event => event.type === 'usageStatusSnapshotRequested').length;
            await host.run('follower', () => follower.get());
            assert.equal(host.events.filter(event => event.type === 'usageStatusSnapshotRequested').length, requests);
            assert.equal(requests, 2);
        }
    );

    await t.test('timed out snapshot request remains unknown and never reads local files', async c => {
        host.reset();
        c.mock.timers.enable({ apis: ['setTimeout'] });
        const follower = host.fixture(c, 'follower');
        const pending = host.run('follower', () => follower.get());
        c.mock.timers.tick(2000);
        assert.equal(await pending, undefined);
        assert.equal(host.state.savedReads, 0);
        assert.equal(host.state.ownedReads, 0);
    });

    for (const state of ['aged', 'new-term', 'no-authority'] as const) {
        await t.test(`${state}: unavailable transport cannot renew an old snapshot`, async c => {
            host.reset();
            let now = 1000;
            c.mock.method(Date, 'now', () => now);
            const owner = host.fixture(c);
            const follower = host.fixture(c, 'follower');
            owner.update(DateUtils.getTodayDateString(), stats(1));
            assert.equal((await host.run('follower', () => follower.get()))?.stats.total.requests, 1);
            host.state.connected = false;
            if (state === 'aged') {
                now += 30000;
            } else {
                host.state.term = state === 'new-term' ? 'successor:2' : '';
            }
            assert.equal(await host.run('follower', () => follower.get()), undefined);
            assert.equal(follower.peek()?.stats.total.requests, 1);
            assert.equal(host.state.savedReads, 0);
            assert.equal(host.state.ownedReads, 0);
        });
    }
});
