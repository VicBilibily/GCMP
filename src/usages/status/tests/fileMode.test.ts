import assert from 'node:assert/strict';
import { mkdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { createUsageHost } from '../../tests/hostFixture';
import { DateUtils } from '../../fileLogger/dateUtils';
import { stats } from './fixture';

test('isolated status snapshots read actual saved files without raw aggregation or writes', async t => {
    const host = await createUsageHost();
    const { UsageStatusSnapshots } = await import('../usageStatusSnapshots');
    t.after(() => host.restore());
    const date = DateUtils.getTodayDateString();
    const setup = async (context: import('node:test').TestContext, fileMode = true) => {
        if (!fileMode) {
            host.state.leaderId = undefined;
            Object.assign(host.bus, { getAuthorityTerm: () => undefined });
        }
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
            fileMode,
            day => f.fileLogger.readSavedStats(day),
            day => f.fileLogger.getDateStats(day),
            value => f.fileLogger.getStatsSource(value),
            day => f.fileLogger.getLatestStatusStats(day)
        );
        Object.assign(f.manager, { statusSnapshots: service });
        const assertNoWork = () => {
            assert.equal(aggregate.mock.calls.length, 0);
            assert.equal(details.mock.calls.length, 0);
            assert.equal(writes.mock.calls.length, 0);
        };
        return { ...f, path, service, assertNoWork };
    };

    await t.test('leaderless startup displays an actual saved summary without aggregation or writes', async c => {
        const f = await setup(c, false);
        const saved = JSON.stringify(stats(4));
        await writeFile(f.path, saved);
        const reads = c.mock.method(f.fileLogger, 'readSavedStats');
        const updates: number[] = [];
        f.service.onUpdate(value => updates.push(value.stats.total.requests));
        for (let i = 0; i < 5; i++) {
            const value = await f.manager.getStatusSnapshot();
            assert.equal(value?.stats.total.requests, 4);
            assert.equal(value?.authorityTerm, 'file');
        }
        assert.deepEqual(updates, [4]);
        assert.equal(reads.mock.calls.length, 1);
        assert.equal(await readFile(f.path, 'utf8'), saved);
        f.assertNoWork();
    });

    await t.test('leaderless startup with missing or damaged saved data remains unknown', async c => {
        const f = await setup(c, false);
        assert.equal(await f.manager.getStatusSnapshot(), undefined);
        await writeFile(f.path, '{');
        assert.equal(await f.manager.getStatusSnapshot(), undefined);
        await writeFile(f.path, JSON.stringify({ total: {}, providers: {} }));
        assert.equal(await f.manager.getStatusSnapshot(), undefined);
        assert.equal(f.service.peek(), undefined);
        f.assertNoWork();
    });

    await t.test('leaderless startup preserves a genuine saved zero rather than reporting unknown', async c => {
        const f = await setup(c, false);
        await writeFile(f.path, JSON.stringify(stats(0)));
        assert.equal((await f.manager.getStatusSnapshot())?.stats.total.requests, 0);
        f.assertNoWork();
    });

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

    await t.test('an owned snapshot reconciles after a missed notification and honors explicit pulls', async c => {
        host.reset();
        Object.assign(host.bus, { publishIpcOnly: () => true });
        let now = Date.now();
        c.mock.method(Date, 'now', () => now);
        let current = stats(4);
        let reads = 0;
        const service = new UsageStatusSnapshots(
            false,
            async () => current,
            async () => {
                reads++;
                return current;
            }
        );
        c.after(() => service.dispose());
        assert.equal((await service.get())?.stats.total.requests, 4);
        current = stats(5);
        assert.equal((await service.get())?.stats.total.requests, 4);
        now += 30001;
        assert.equal((await service.get())?.stats.total.requests, 5);
        assert.equal(reads, 2);
        current = stats(6);
        assert.equal((await service.get(true))?.stats.total.requests, 6);
        assert.equal(reads, 3);
    });

    for (const mode of ['forced-fresh', 'forced-expired', 'expired'] as const) {
        for (const unseenSource of [false, true]) {
            await t.test(`${mode} reads the committed file with unseen source=${unseenSource}`, async c => {
                host.reset();
                Object.assign(host.bus, { publishIpcOnly: () => true });
                const f = await host.fixture(c);
                const path = join(f.fileLogger.getStorageDir(), date, 'stats.json');
                await mkdir(join(f.fileLogger.getStorageDir(), date), { recursive: true });
                await AtomicJsonFile.writeJsonAtomically(path, stats(1));
                let now = Date.now();
                c.mock.method(Date, 'now', () => now);
                let reads = 0;
                const service = new UsageStatusSnapshots(
                    false,
                    day => f.fileLogger.readSavedStats(day),
                    async day => {
                        reads++;
                        const saved = await f.fileLogger.readSavedStats(day);
                        assert.ok(saved);
                        return saved;
                    },
                    value => f.fileLogger.getStatsSource(value),
                    day => f.fileLogger.getLatestStatusStats(day)
                );
                c.after(() => service.dispose());
                assert.equal((await service.get())?.stats.total.requests, 1);
                if (unseenSource) {
                    assert.equal((await f.fileLogger.readSavedStats(date))?.total.requests, 1);
                }
                await AtomicJsonFile.writeJsonAtomically(path, stats(2));
                now += mode === 'forced-fresh' ? 1 : 30001;
                const before = reads;
                assert.equal((await service.get(mode !== 'expired'))?.stats.total.requests, 2);
                assert.equal(reads - before, 1);
                assert.equal((await service.get())?.stats.total.requests, 2);
                assert.equal(reads - before, 1);
            });
        }
    }
});
