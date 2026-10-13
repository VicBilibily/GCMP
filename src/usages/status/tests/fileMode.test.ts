import assert from 'node:assert/strict';
import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createUsageHost } from '../../tests/hostFixture';
import { DateUtils } from '../../fileLogger/dateUtils';
import { stats } from './fixture';

test('isolated status snapshots read actual saved files without raw aggregation or writes', async t => {
    const host = await createUsageHost();
    const { UsageStatusSnapshots } = await import('../usageStatusSnapshots');
    t.after(() => host.restore());
    const date = DateUtils.getTodayDateString();
    const setup = async (context: import('node:test').TestContext) => {
        const f = await host.fixture(context);
        const path = join(f.dir, 'usages', date, 'stats.json');
        await mkdir(join(f.dir, 'usages', date), { recursive: true });
        const aggregate = context.mock.method(f.internals.logStatsManager, 'getDateStats', async () => {
            throw new Error('Status file mode must not aggregate raw logs');
        });
        const details = context.mock.method(f.fileLogger, 'getRequestDetails', async () => {
            throw new Error('Status file mode must not read request details');
        });
        const writes = context.mock.method(f.internals.writeManager, 'flush');
        const service = new UsageStatusSnapshots(
            true,
            day => f.fileLogger.readSavedStats(day),
            day => f.fileLogger.getDateStats(day),
            value => f.fileLogger.getStatsSource(value)
        );
        Object.assign(f.manager, { statusSnapshots: service });
        const assertNoWork = () => {
            assert.equal(aggregate.mock.calls.length, 0);
            assert.equal(details.mock.calls.length, 0);
            assert.equal(writes.mock.calls.length, 0);
        };
        return { ...f, path, service, assertNoWork };
    };

    await t.test('missing statistics remain unknown and do not trigger regeneration', async c => {
        const f = await setup(c);
        assert.equal(await f.manager.getStatusSnapshot(), undefined);
        assert.equal(f.service.peek(), undefined);
        f.assertNoWork();
    });

    await t.test('incomplete and malformed statistics cannot be projected as zero usage', async c => {
        const f = await setup(c);
        for (const value of [
            { total: {}, providers: {} },
            { ...stats(), total: { ...stats().total, actualInput: undefined } },
            { ...stats(), providers: [] },
            { ...stats(), total: { ...stats().total, requests: -1 } }
        ]) {
            await writeFile(f.path, JSON.stringify(value));
            assert.equal(await f.manager.getStatusSnapshot(), undefined);
            assert.equal(f.service.peek(), undefined);
        }
        await writeFile(f.path, '{');
        assert.equal(await f.manager.getStatusSnapshot(), undefined);
        f.assertNoWork();
    });

    await t.test('atomic replacement with restored mtime refreshes the actual saved summary', async c => {
        const f = await setup(c);
        await writeFile(f.path, JSON.stringify(stats(4)));
        assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 4);
        const before = await stat(f.path);
        const replacement = `${f.path}.replacement`;
        await writeFile(replacement, JSON.stringify(stats(5)));
        await utimes(replacement, before.atime, before.mtime);
        await rename(replacement, f.path);
        assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 5);
        assert.equal((JSON.parse(await readFile(f.path, 'utf8')) as ReturnType<typeof stats>).total.requests, 5);
        f.assertNoWork();
    });
});
