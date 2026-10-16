import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageHost } from '../hostFixture';
import { nextTurn, refreshClock, refreshFixture, terminal, until } from './fixture';

test('statistics refresh lifecycle boundaries', async suite => {
    const host = await createUsageHost();
    try {
        await suite.test('disposing a queued manager prevents reads and notifications', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(1);
            f.manager.updateActualTokens(terminal(ids[0]));
            await f.idleWrites();
            await f.manager.dispose();
            clock.fire();
            await nextTurn();
            assert.equal(f.counters.calculations, 0);
            assert.equal(f.counters.notifications, 0);
            assert.equal(f.broadcasts().length, 0);
        });
        await suite.test('disposing during a read suppresses late broadcasts', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(1),
                held = f.holdRead();
            let disposing: Promise<void> | undefined;
            let disposed = false;
            try {
                f.manager.updateActualTokens(terminal(ids[0]));
                await f.fileLogger.flush();
                clock.fire();
                await held.entered;
                disposing = f.manager.dispose().then(() => {
                    disposed = true;
                });
                await nextTurn();
                assert.equal(disposed, false);
                held.release();
                await disposing;
                await f.settled();
                assert.equal(f.broadcasts().length, 0);
                assert.equal(f.counters.notifications, 0);
            } finally {
                held.release();
                await disposing;
                await f.settled();
            }
        });
        await suite.test('a failed read does not prevent the next changed batch from refreshing', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(2);
            const read = f.internals.readManager.readHourLogs.bind(f.internals.readManager);
            let fail = true;
            context.mock.method(f.internals.readManager, 'readHourLogs', (...args: Parameters<typeof read>) => {
                if (fail) {
                    return Promise.reject(new Error('synthetic read failure'));
                }
                return read(...args);
            });
            f.manager.updateActualTokens(terminal(ids[0]));
            await f.fileLogger.flush();
            clock.fire();
            await until(() => host.warnings.some(message => message.includes('Failed to refresh stats')));
            assert.equal(f.broadcasts().length, 0);
            fail = false;
            f.manager.updateActualTokens(terminal(ids[1]));
            await f.fileLogger.flush();
            await clock.settle(() => f.counters.notifications === 1);
            assert.equal(f.broadcasts().length, 1);
            assert.equal((await f.saved()).total.completedRequests, 2);
        });
        await suite.test(
            'a queued refresh follows the new leader instead of forcing a stale local write',
            async context => {
                host.reset();
                const clock = refreshClock(context),
                    f = await refreshFixture(host, context);
                const ids = await f.seed(1);
                f.manager.updateActualTokens(terminal(ids[0]));
                await f.idleWrites();
                host.state.leaderId = 'successor';
                host.state.deliver = false;
                clock.fire();
                await until(() => host.events.some(item => item.event.type === 'statsRefreshRequested'));
                assert.equal(f.counters.calculations, 0);
                assert.equal(f.broadcasts().length, 0);
                await f.manager.dispose();
            }
        );
        await suite.test('losing leadership during a read does not publish an unpersisted result', async context => {
            host.reset();
            const clock = refreshClock(context),
                f = await refreshFixture(host, context);
            const ids = await f.seed(1),
                held = f.holdRead();
            try {
                f.manager.updateActualTokens(terminal(ids[0]));
                await f.fileLogger.flush();
                clock.fire();
                await held.entered;
                host.state.leaderId = 'successor';
                held.release();
                await f.settled();
                assert.equal(f.counters.notifications, 0);
                assert.equal(f.broadcasts().length, 0);
                assert.equal((await f.saved()).total.completedRequests, 0);
            } finally {
                held.release();
                await f.settled();
            }
        });
    } finally {
        host.restore();
    }
});
