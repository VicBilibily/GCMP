import assert from 'node:assert/strict';
import test from 'node:test';
import { USAGES_QUERY_PROTOCOL_VERSION } from '../../../interInstance/eventProtocol';
import { DateUtils } from '../../fileLogger/dateUtils';
import { projectUsageStatus, type UsageStatusSnapshot } from '../snapshot';
import { createStatusHost, gate, stats } from './fixture';

test('status snapshots use owner pushes and isolated-host file reads', async t => {
    const host = await createStatusHost();
    t.after(() => host.restore());
    const today = DateUtils.getTodayDateString();
    const snapshot = (revision = 1, count = 1): UsageStatusSnapshot => ({
        date: today,
        authorityTerm: 'leader:1',
        revision,
        stats: projectUsageStatus(stats(count))
    });
    const push = (data: UsageStatusSnapshot, senderInstanceId = 'leader') =>
        host.deliver({
            type: 'usageStatusSnapshot',
            timestamp: Date.now(),
            senderInstanceId,
            payload: { snapshot: data }
        });

    await t.test('owner consumes existing results and publishes only changed lightweight data', async c => {
        host.reset();
        const owner = host.fixture(c);
        host.run('leader', () => owner.update(today, stats()));
        host.run('leader', () => owner.update(today, stats()));
        assert.equal((await host.run('leader', () => owner.get()))?.stats.total.requests, 1);
        assert.equal(host.state.ownedReads, 0);
        assert.equal(host.events.length, 1);
        const event = host.events[0];
        assert.equal(event.type, 'usageStatusSnapshot');
        assert.doesNotMatch(JSON.stringify(event), /hourly|models|rawUsage|sessionTitle/);
        assert.ok(Object.isFrozen(owner.peek()?.stats.total));
    });

    await t.test('multiple new windows share one owner initialization and never read saved files', async c => {
        host.reset();
        const entered = gate();
        const release = gate();
        host.fixture(c, 'leader', false, undefined, async () => {
            entered.release();
            await release.promise;
            return stats();
        });
        const followers = Array.from({ length: 8 }, (_, i) => host.fixture(c, `follower${i}`));
        const queries = followers.map((service, i) => host.run(`follower${i}`, () => service.get()));
        await entered.promise;
        assert.equal(host.state.ownedReads, 1);
        release.release();
        assert.ok((await Promise.all(queries)).every(value => value?.stats.total.requests === 1));
        assert.equal(host.state.savedReads, 0);
        await new Promise<void>(resolve => setImmediate(resolve));
        const another = host.fixture(c, 'another');
        assert.equal((await host.run('another', () => another.get()))?.stats.total.requests, 1);
        assert.equal(host.state.ownedReads, 1);
    });

    await t.test('disconnection and unavailable authority never trigger file fallback', async c => {
        host.reset();
        host.state.connected = false;
        const follower = host.fixture(c, 'follower');
        assert.equal(await host.run('follower', () => follower.get()), undefined);
        host.state.term = '';
        assert.equal(await host.run('follower', () => follower.get()), undefined);
        assert.equal(host.state.savedReads, 0);
        assert.equal(host.state.ownedReads, 0);
    });

    await t.test('failed snapshot send never triggers file fallback', async c => {
        host.reset();
        host.state.send = false;
        const follower = host.fixture(c, 'follower');
        assert.equal(await host.run('follower', () => follower.get()), undefined);
        assert.equal(host.state.savedReads, 0);
    });

    await t.test('reconnect requests the current snapshot without needing a changed broadcast', async c => {
        host.reset();
        const owner = host.fixture(c);
        host.run('leader', () => owner.update(today, stats(2)));
        const follower = host.fixture(c, 'follower');
        host.deliver({
            type: 'remoteInstanceCapabilities',
            timestamp: Date.now(),
            senderInstanceId: 'leader',
            payload: {
                targetInstanceId: 'follower',
                authorityTerm: 'leader:1',
                usagesQueryProtocolVersion: USAGES_QUERY_PROTOCOL_VERSION,
                extensionVersion: 'test'
            }
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(follower.peek()?.stats.total.requests, 2);
        assert.equal(host.state.savedReads, 0);
        assert.equal(host.state.ownedReads, 0);
    });

    await t.test('wrong sender, old revision, old authority and invalid data are rejected', async c => {
        host.reset();
        const follower = host.fixture(c, 'follower');
        push(snapshot(2, 2));
        push(snapshot(1, 1));
        push(snapshot(3, 3), 'forged');
        push({ ...snapshot(4, 4), authorityTerm: 'leader:0' });
        push({ ...snapshot(5, 5), revision: NaN });
        push({ ...snapshot(6, 6), date: DateUtils.getDateStringDaysAgo(1) });
        assert.equal(follower.peek()?.stats.total.requests, 2);
        assert.equal(host.state.savedReads, 0);
    });

    await t.test('ownership change during initialization discards old results', async c => {
        host.reset();
        const entered = gate();
        const release = gate();
        const owner = host.fixture(c, 'leader', false, undefined, async () => {
            entered.release();
            await release.promise;
            return stats(1);
        });
        const pending = host.run('leader', () => owner.get());
        await entered.promise;
        host.state.leader = 'successor';
        host.state.term = 'successor:2';
        release.release();
        assert.equal(await pending, undefined);
        assert.equal(owner.peek(), undefined);
        assert.equal(host.events.length, 0);
    });

    await t.test('isolated environment shares saved reads without owner queries or network traffic', async c => {
        host.reset();
        const release = gate();
        const local = host.fixture(c, 'remote', true, async () => {
            await release.promise;
            return stats();
        });
        const queries = Array.from({ length: 10 }, () => local.get());
        assert.equal(host.state.savedReads, 1);
        release.release();
        assert.ok((await Promise.all(queries)).every(value => value?.stats.total.requests === 1));
        assert.equal(host.state.ownedReads, 0);
        assert.equal(host.events.length, 0);
    });

    await t.test('isolated-host local results beat late saved-file reads', async c => {
        host.reset();
        const release = gate();
        const local = host.fixture(c, 'remote', true, async () => {
            await release.promise;
            return stats(1);
        });
        const pending = local.get();
        local.update(today, stats(2));
        release.release();
        assert.equal((await pending)?.stats.total.requests, 2);
        assert.equal(local.peek()?.stats.total.requests, 2);
    });

    await t.test('missing isolated-host statistics do not request owner calculation', async c => {
        host.reset();
        const local = host.fixture(c, 'remote', true, async () => null);
        assert.equal(await local.get(), undefined);
        assert.equal(host.state.ownedReads, 0);
        assert.equal(host.events.length, 0);
    });

    await t.test('midnight discards yesterday presentation and loads current saved statistics', async c => {
        host.reset();
        const local = host.fixture(c, 'remote', true);
        local.update(today, stats());
        c.mock.method(DateUtils, 'getTodayDateString', () => '2099-01-02');
        assert.equal(local.peek(), undefined);
        assert.equal((await local.get())?.date, '2099-01-02');
        assert.equal(host.state.savedReads, 1);
    });

    await t.test('disposed pending requests and saved reads cannot apply late data', async c => {
        host.reset();
        const follower = host.fixture(c, 'follower');
        const pending = host.run('follower', () => follower.get());
        follower.dispose();
        assert.equal(await pending, undefined);
        push(snapshot());
        assert.equal(follower.peek(), undefined);
        const release = gate();
        const local = host.fixture(c, 'remote', true, async () => {
            await release.promise;
            return stats();
        });
        const read = local.get();
        local.dispose();
        release.release();
        assert.equal(await read, undefined);
        assert.equal(local.peek(), undefined);
    });
});
