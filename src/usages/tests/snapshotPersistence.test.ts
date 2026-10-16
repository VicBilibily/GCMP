import assert from 'node:assert/strict';
import fs, { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { AtomicJsonFile } from '../atomicJsonFile';
import { DateUtils } from '../fileLogger/dateUtils';
import { createUsageHost } from './hostFixture';
import { initializeLogger } from './recovery/fixture';
import { gate, sharedSnapshotFixture, snapshotFixture, snapshotPage, snapshotRow } from './snapshotFixture';

const sharedHost = createUsageHost();
after(async () => {
    (await sharedHost).restore();
});

for (const scenario of [
    { source: 'history', pause: 'read', failure: 'none' },
    { source: 'history', pause: 'commit', failure: 'none' },
    { source: 'history', pause: 'commit', failure: 'write' },
    { source: 'history', pause: 'commit', failure: 'subscription' },
    { source: 'raw', pause: 'read', failure: 'none' }
] as const) {
    test(
        `detail lifecycle disposal drains ${scenario.source}/${scenario.pause}/${scenario.failure}`,
        { timeout: 5000 },
        async context => {
            const host = await sharedHost;
            host.reset();
            const fixture = await host.fixture(context);
            await initializeLogger(host, context, fixture.fileLogger);
            const date = scenario.source === 'history' ? '2020-01-01' : DateUtils.getTodayDateString();
            const { pathManager, snapshotManager, readManager } = fixture.internals;
            const rawPath = pathManager.getHourFilePath(date, 1);
            const snapshotPath = pathManager.getSnapshotFilePath(date);
            const lockPath = join(pathManager.getDateFolderPath(date), '.requests.lock');
            const row = snapshotRow(date, 'detail-disposal', 1);
            await fs.mkdir(dirname(rawPath), { recursive: true });
            await fs.writeFile(rawPath, JSON.stringify(row) + '\n');
            const entered = gate();
            const release = gate();
            const failure = Object.assign(new Error('Injected detail cleanup failure'), { code: 'EIO' });
            let returned = false;
            let queryReturned = false;
            let lateLocks = 0;
            let lateCommits = 0;
            let building: Promise<void> | undefined;
            let buildError: unknown;
            const build = snapshotManager.buildSnapshotFromLogs.bind(snapshotManager);
            context.mock.method(snapshotManager, 'buildSnapshotFromLogs', (...args: Parameters<typeof build>) => {
                const operation = build(...args);
                building = operation.catch(error => {
                    buildError = error;
                });
                return operation;
            });
            if (scenario.failure === 'subscription') {
                const internal = fixture.fileLogger as unknown as { liveMetricsDisposable: { dispose(): void } };
                let injected = false;
                context.mock.method(internal.liveMetricsDisposable, 'dispose', () => {
                    if (!injected) {
                        injected = true;
                        throw failure;
                    }
                });
            }
            const mkdir = fs.mkdir.bind(fs);
            const rename = fs.rename.bind(fs);
            context.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
                if (String(args[0]) === lockPath && returned) {
                    lateLocks++;
                }
                return mkdir(...args);
            });
            context.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
                if (String(args[1]) === snapshotPath) {
                    if (scenario.pause === 'commit') {
                        entered.release();
                        await release.promise;
                    }
                    if (scenario.failure === 'write') {
                        throw failure;
                    }
                    if (returned) {
                        lateCommits++;
                    }
                }
                return rename(...args);
            });
            if (scenario.pause === 'read') {
                const read = readManager.getRequestDetails.bind(readManager);
                context.mock.method(readManager, 'getRequestDetails', async (...args: Parameters<typeof read>) => {
                    const records = await read(...args);
                    entered.release();
                    await release.promise;
                    return records;
                });
            }
            const querying = fixture.fileLogger.getRequestDetails(date).then(records => {
                queryReturned = true;
                return records;
            });
            let disposing: Promise<unknown> | undefined;
            try {
                await entered.promise;
                if (scenario.pause === 'commit') {
                    assert.equal(
                        queryReturned,
                        true,
                        'query completion must not wait for background snapshot persistence'
                    );
                    await fs.stat(lockPath);
                }
                disposing = fixture.manager.dispose().then(
                    () => {
                        returned = true;
                    },
                    (error: unknown) => {
                        returned = true;
                        return error;
                    }
                );
                await new Promise<void>(resolve => setImmediate(resolve));
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.equal(returned, false);
            } finally {
                release.release();
                await querying;
                await Promise.all([building, disposing]);
            }
            assert.equal((await querying).length, 1);
            assert.equal(lateLocks, 0);
            assert.equal(lateCommits, 0);
            await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
            if (scenario.source === 'history' && scenario.failure !== 'write') {
                assert.equal((await snapshotManager.read(date))?.length, 1);
            } else {
                await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' });
            }
            const lifecycle = fixture.fileLogger as unknown as {
                requestDetailsTasks: { size: number };
                snapshotBuildTasks: { size: number };
            };
            assert.equal(lifecycle.requestDetailsTasks.size, 0);
            assert.equal(lifecycle.snapshotBuildTasks.size, 0);
            const error = await disposing;
            if (scenario.failure === 'subscription') {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [failure]);
            } else {
                assert.equal(error, undefined);
            }
            if (scenario.failure === 'write') {
                assert.equal(buildError, failure);
            }
        }
    );
}

for (const phase of ['starting', 'completed'] as const) {
    test(`detail lifecycle rejects new queries when disposal is ${phase}`, async context => {
        const host = await sharedHost;
        host.reset();
        const fixture = await host.fixture(context);
        await initializeLogger(host, context, fixture.fileLogger);
        const date = '2020-01-01';
        await fixture.internals.snapshotManager.buildSnapshotFromLogs(date, [snapshotRow(date)]);
        const disposing = fixture.manager.dispose();
        if (phase === 'completed') {
            await disposing;
        }
        const read = context.mock.method(fixture.internals.snapshotManager, 'read');
        const readRaw = context.mock.method(fixture.internals.readManager, 'getRequestDetails');
        const build = context.mock.method(fixture.internals.snapshotManager, 'buildSnapshotFromLogs');
        try {
            assert.deepEqual(await fixture.fileLogger.getRequestDetails(date), []);
        } finally {
            await disposing;
        }
        assert.equal(read.mock.callCount(), 0);
        assert.equal(readRaw.mock.callCount(), 0);
        assert.equal(build.mock.callCount(), 0);
    });
}

test('snapshot persistence keeps unread and unsaved changes pending', { timeout: 30000 }, async suite => {
    const host = await sharedHost;
    const { SnapshotManager } = await import('../fileLogger/snapshotManager');
    for (const phase of ['snapshot-read', 'stats-read', 'stats-write'] as const) {
        for (const source of ['snapshot', 'raw'] as const) {
            await suite.test(`${phase}/${source}: a real rebuild preserves late writes`, async context => {
                const f = await snapshotFixture(host, context);
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                const entered = gate();
                const release = gate();
                let first = true;
                if (phase === 'snapshot-read') {
                    const read = f.internals.snapshotManager.read.bind(f.internals.snapshotManager);
                    context.mock.method(f.internals.snapshotManager, 'read', async (date: string) => {
                        const records = await read(date);
                        if (first && date === f.date) {
                            first = false;
                            entered.release();
                            await release.promise;
                        }
                        return records;
                    });
                } else if (phase === 'stats-read') {
                    const load = f.privateStats.loadStats.bind(f.privateStats);
                    context.mock.method(f.privateStats, 'loadStats', async (date: string) => {
                        const saved = await load(date);
                        if (first && date === f.date) {
                            first = false;
                            entered.release();
                            await release.promise;
                        }
                        return saved;
                    });
                } else {
                    const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                    context.mock.method(
                        AtomicJsonFile,
                        'writeJsonAtomically',
                        async (...args: Parameters<typeof write>) => {
                            if (first && args[0] === f.statsPath) {
                                first = false;
                                entered.release();
                                await release.promise;
                            }
                            return write(...args);
                        }
                    );
                }
                const reading = f.fileLogger.getDateStats(f.date);
                try {
                    await entered.promise;
                    const external = new SnapshotManager(f.internals.pathManager, () => {});
                    const late = snapshotRow(f.date, 'third', 11);
                    if (source === 'snapshot') {
                        await external.upsertRecord(f.date, late);
                    } else {
                        await writeFile(
                            f.internals.pathManager.getHourFilePath(f.date, 11),
                            JSON.stringify(late) + '\n',
                            { flag: 'wx' }
                        );
                    }
                    release.release();
                    assert.equal((await reading).total.requests, 2);
                    assert.equal((await external.read(f.date))?.length, 3);
                    const pending = await f.privateStats.needsRegeneration(f.date);
                    const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                    assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 3);
                    assert.equal(pending, true);
                    assert.equal(rebuilt[f.date]?.total.requests, 3);
                    const saved = await readFile(f.statsPath, 'utf8');
                    const savedMtime = (await stat(f.statsPath)).mtimeMs;
                    for (let round = 0; round < 3; round++) {
                        assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                    }
                    assert.equal(await f.privateStats.needsRegeneration(f.date), false);
                    assert.equal(await readFile(f.statsPath, 'utf8'), saved);
                    assert.equal((await stat(f.statsPath)).mtimeMs, savedMtime);
                } finally {
                    release.release();
                    await reading;
                }
            });
        }
    }

    for (const code of ['EACCES', 'EBUSY', 'ENOSPC'] as const) {
        for (const preserveMtime of [false, true]) {
            await suite.test(`${code}/preserveMtime=${preserveMtime}: failed writes remain pending`, async context => {
                const f = await snapshotFixture(host, context);
                await f.fileLogger.getDateStats(f.date, true);
                const previous = await stat(f.snapshotPath);
                const external = new SnapshotManager(f.internals.pathManager, () => {});
                await external.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                if (preserveMtime) {
                    await utimes(f.snapshotPath, previous.atime, previous.mtime);
                    assert.equal((await stat(f.snapshotPath)).mtimeMs, previous.mtimeMs);
                    assert.ok(previous.mtimeMs < (await stat(f.statsPath)).mtimeMs);
                }
                assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                const indexPath = join(f.dir, 'usages', 'index.json');
                const indexBefore = await readFile(indexPath, 'utf8');
                const write = AtomicJsonFile.writeJsonAtomically.bind(AtomicJsonFile);
                let attempts = 0;
                const failure = context.mock.method(
                    AtomicJsonFile,
                    'writeJsonAtomically',
                    async (...args: Parameters<typeof write>) => {
                        if (args[0] === f.statsPath) {
                            attempts++;
                            throw Object.assign(new Error('Injected stats write failure'), { code });
                        }
                        return write(...args);
                    }
                );
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                assert.equal(attempts, 1);
                assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
                assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
                const pending = await f.privateStats.needsRegeneration(f.date);
                failure.mock.restore();
                const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 2);
                assert.equal(pending, true);
                assert.equal(rebuilt[f.date]?.total.requests, 2);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
            });
        }
    }

    for (const preserveMtime of [false, true]) {
        await suite.test(
            `preserveMtime=${preserveMtime}: skipped writes cannot acknowledge persistence`,
            async context => {
                const f = await snapshotFixture(host, context);
                await f.fileLogger.getDateStats(f.date, true);
                const previous = await stat(f.snapshotPath);
                const external = new SnapshotManager(f.internals.pathManager, () => {});
                await external.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                if (preserveMtime) {
                    await utimes(f.snapshotPath, previous.atime, previous.mtime);
                    assert.equal((await stat(f.snapshotPath)).mtimeMs, previous.mtimeMs);
                }
                f.internals.logStatsManager.setCanWriteStats(() => false);
                const unsaved = await f.fileLogger.getDateStats(f.date);
                const pending = await f.privateStats.needsRegeneration(f.date);
                f.internals.logStatsManager.setCanWriteStats(() => true);
                assert.equal(unsaved.total.requests, 2);
                assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
                const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 2);
                assert.equal(pending, true);
                assert.equal(rebuilt[f.date]?.total.requests, 2);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
            }
        );
    }

    await suite.test('same-mtime snapshot read failure retains the unprocessed source', async context => {
        const f = await snapshotFixture(host, context);
        await f.fileLogger.getDateStats(f.date, true);
        const previous = await stat(f.snapshotPath);
        const external = new SnapshotManager(f.internals.pathManager, () => {});
        await external.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
        await utimes(f.snapshotPath, previous.atime, previous.mtime);
        assert.equal((await stat(f.snapshotPath)).mtimeMs, previous.mtimeMs);
        assert.equal(await f.privateStats.needsRegeneration(f.date), true);
        const failure = context.mock.method(f.internals.snapshotManager, 'read', async () => {
            throw Object.assign(new Error('Injected snapshot read failure'), { code: 'EACCES' });
        });
        assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
        assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
        const pending = await f.privateStats.needsRegeneration(f.date);
        failure.mock.restore();
        const rebuilt = await f.fileLogger.regenerateOutdatedStats();
        assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 2);
        assert.equal(pending, true);
        assert.equal(rebuilt[f.date]?.total.requests, 2);
        assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
    });

    for (const source of ['snapshot', 'raw'] as const) {
        await suite.test(`${source}: the shared-file page catches up after a real rebuild`, async context => {
            const { leader, follower, background } = await sharedSnapshotFixture(host, context);
            await leader.internals.snapshotManager.upsertRecord(leader.date, snapshotRow(leader.date, 'second', 10));
            const entered = gate();
            const release = gate();
            const read = leader.internals.snapshotManager.read.bind(leader.internals.snapshotManager);
            let first = true;
            context.mock.method(leader.internals.snapshotManager, 'read', async (date: string) => {
                const records = await read(date);
                if (first && date === leader.date) {
                    first = false;
                    entered.release();
                    await release.promise;
                }
                return records;
            });
            host.events.length = 0;
            context.mock.timers.enable({ apis: ['setTimeout'] });
            const page = await snapshotPage(host, context, follower.extensionContext, leader.date, background);
            const query = page.query();
            try {
                await entered.promise;
                const external = new SnapshotManager(leader.internals.pathManager, () => {});
                const late = snapshotRow(leader.date, 'third', 11);
                if (source === 'snapshot') {
                    await external.upsertRecord(leader.date, late);
                } else {
                    await writeFile(
                        leader.internals.pathManager.getHourFilePath(leader.date, 11),
                        JSON.stringify(late) + '\n',
                        { flag: 'wx' }
                    );
                }
                release.release();
                await query;
                await page.settle();
                for (let round = 0; round < 3; round++) {
                    context.mock.timers.tick(5000);
                    await page.settle();
                }
                const totals = page.messages
                    .filter(message => message.command === 'updateMultiDayAnalysis')
                    .map(message => message.data?.summary.totalTokens);
                assert.equal(totals.at(-1), 45);
                assert.equal((await external.read(leader.date))?.length, 3);
                assert.equal((await leader.fileLogger.getDateStats(leader.date)).total.requests, 3);
                assert.equal(page.queries, 3);
                assert.equal(host.events.filter(item => item.event.type === 'tokenUsageUpdated').length, 2);
                assert.deepEqual(await leader.privateStats.getOutdatedDates(), []);
                for (let round = 0; round < 3; round++) {
                    context.mock.timers.tick(5000);
                    await page.settle();
                }
                assert.equal(page.queries, 3);
            } finally {
                release.release();
                await query;
                page.view.dispose();
                await page.settle();
            }
        });
    }
});
