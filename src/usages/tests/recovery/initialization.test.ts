import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type * as vscode from 'vscode';
import { AtomicJsonFile } from '../../atomicJsonFile';
import { DateUtils } from '../../fileLogger/dateUtils';
import type { TokenUsageStatsFromFile } from '../../fileLogger/types';
import { createUsageHost } from '../hostFixture';
import { gate, snapshotRow } from '../snapshotFixture';
import { initializeLogger } from './fixture';

interface LoggerLifecycleState {
    disposed: boolean;
    pendingLogsCleanupTimer: NodeJS.Timeout | null;
    historicalMaintenance?: Promise<void>;
    retentionTasks: Set<Promise<number>>;
    backfillTasks: Set<Promise<boolean>>;
    initCacheVersionTimestamp(): Promise<void>;
    cleanupManager: { cleanupExpiredLogs(retentionDays: number): Promise<number> };
}

interface StatsLifecycleState {
    statsTasks: Set<Promise<TokenUsageStatsFromFile>>;
    inFlightRegenerations: Map<string, { promise: Promise<TokenUsageStatsFromFile> }>;
    indexManager: { repairIfNeeded(): Promise<boolean> };
    calculateDateStats(date: string, forceHourlyRecompute: boolean): Promise<TokenUsageStatsFromFile>;
}

const managerResources = [
    'statusSnapshots',
    'usagesQueryCoordinator',
    'leaderChangeDisposable',
    'cacheInvalidationDisposable'
] as const;
type ManagerLifecycleState = Partial<Record<(typeof managerResources)[number], vscode.Disposable>> & {
    initialized: boolean;
};

test('initialization readiness propagates background cleanup failure instead of waiting for success', async c => {
    const host = await createUsageHost();
    try {
        const f = await host.fixture(c);
        const failure = new Error('Injected startup cleanup failure');
        c.mock.method(f.internals.snapshotManager, 'compactHistoricalDates', async () => {
            throw failure;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await assert.rejects(
                Promise.race([
                    initializeLogger(host, c, f.fileLogger),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Initialization readiness did not settle')), 1000);
                    })
                ]),
                error => error === failure
            );
        } finally {
            clearTimeout(timer);
        }
    } finally {
        host.restore();
    }
});

for (const failureStage of ['none', 'subscription', 'publications', 'writer'] as const) {
    test(
        `disposal drains historical maintenance after ${failureStage} cleanup failure`,
        { timeout: 5000 },
        async context => {
            const host = await createUsageHost();
            const fixture = await host.fixture(context);
            context.after(() => host.restore());
            const date = '2020-01-01';
            const rawPath = fixture.internals.pathManager.getHourFilePath(date, 1);
            await fs.mkdir(dirname(rawPath), { recursive: true });
            await fs.writeFile(rawPath, JSON.stringify(snapshotRow(date, 'lifecycle', 1)) + '\n');
            const release = gate();
            const snapshots = fixture.internals.snapshotManager;
            const compact = snapshots.compactHistoricalDates.bind(snapshots);
            context.mock.method(snapshots, 'compactHistoricalDates', async (...args: Parameters<typeof compact>) => {
                await release.promise;
                return compact(...args);
            });
            const failure = new Error(`Injected ${failureStage}`);
            let failed = false;
            const failOnce = (): void => {
                if (!failed) {
                    failed = true;
                    throw failure;
                }
            };
            if (failureStage === 'subscription') {
                const internal = fixture.fileLogger as unknown as { liveMetricsDisposable: vscode.Disposable };
                context.mock.method(internal.liveMetricsDisposable, 'dispose', failOnce);
            } else if (failureStage === 'publications') {
                context.mock.method(fixture.internals.logStatsManager, 'flushStatsPublications', async () =>
                    failOnce()
                );
            } else if (failureStage === 'writer') {
                const disposeWriter = fixture.internals.writeManager.dispose.bind(fixture.internals.writeManager);
                context.mock.method(fixture.internals.writeManager, 'dispose', async () => {
                    await disposeWriter();
                    failOnce();
                });
            }
            let returned = false;
            let locksAfterReturn = 0;
            const mkdir = fs.mkdir.bind(fs);
            context.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
                if (returned && String(args[0]).endsWith('.requests.lock')) {
                    locksAfterReturn++;
                }
                return mkdir(...args);
            });
            await fixture.fileLogger.initialize();
            const disposing = fixture.fileLogger.dispose().then(
                () => {
                    returned = true;
                    return undefined;
                },
                (error: unknown) => {
                    returned = true;
                    return error;
                }
            );
            let earlyReturn: boolean;
            try {
                await new Promise<void>(resolve => setImmediate(resolve));
                earlyReturn = returned;
            } finally {
                release.release();
            }
            const error = await disposing;
            await (fixture.fileLogger as unknown as { historicalMaintenance: Promise<void> }).historicalMaintenance;
            assert.equal(earlyReturn, false);
            assert.equal(locksAfterReturn, 0);
            assert.equal(error === undefined, failureStage === 'none');
            assert.equal((await snapshots.read(date))?.length, 1);
            await assert.rejects(fs.stat(rawPath), { code: 'ENOENT' });
        }
    );
}

test('disposal during initialization does not resurrect maintenance or timers', async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    const release = gate();
    const internal = fixture.fileLogger as unknown as {
        initCacheVersionTimestamp(): Promise<void>;
        pendingLogsCleanupTimer: NodeJS.Timeout | null;
    };
    context.mock.method(internal, 'initCacheVersionTimestamp', () => release.promise);
    const compact = context.mock.method(fixture.internals.snapshotManager, 'compactHistoricalDates', async () => 0);
    const initializing = fixture.fileLogger.initialize();
    let returned = false;
    const disposing = fixture.fileLogger.dispose().then(() => {
        returned = true;
    });
    try {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
    } finally {
        release.release();
        await Promise.all([initializing, disposing]);
    }
    assert.equal(compact.mock.callCount(), 0);
    assert.equal(internal.pendingLogsCleanupTimer, null);
});

test('disposal waits for the real initialization file handle and index lock', { timeout: 5000 }, async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    const indexPath = join(fixture.dir, 'usages', 'index.json');
    await fs.mkdir(dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify({ dates: {}, versionTimestamp: Date.now() }));
    const entered = gate();
    const release = gate();
    const readFile = fs.readFile.bind(fs);
    let openHandles = 0;
    let intercepted = false;
    context.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) => {
        if (String(args[0]) !== indexPath || intercepted) {
            return readFile(...args);
        }
        intercepted = true;
        const handle = await fs.open(indexPath, 'r');
        openHandles++;
        entered.release();
        try {
            await release.promise;
            return await handle.readFile(args[1]);
        } finally {
            await handle.close();
            openHandles--;
        }
    });
    const initializing = fixture.fileLogger.initialize();
    let returned = false;
    let nextAcquired = false;
    let disposing: Promise<void> | undefined;
    let nextOperation: Promise<void> | undefined;
    try {
        await entered.promise;
        disposing = fixture.fileLogger.dispose().then(() => {
            returned = true;
        });
        nextOperation = AtomicJsonFile.runExclusive(indexPath, async () => {
            nextAcquired = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        assert.equal(openHandles, 1);
        assert.equal(nextAcquired, false);
    } finally {
        release.release();
        await Promise.all([initializing, disposing, nextOperation]);
    }
    assert.equal(returned, true);
    assert.equal(openHandles, 0);
    assert.equal(nextAcquired, true);
});

test('concurrent and repeated initialization share one task and one maintenance run', async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
    const release = gate();
    const initialize = context.mock.method(lifecycle, 'initCacheVersionTimestamp', () => release.promise);
    const compact = context.mock.method(fixture.internals.snapshotManager, 'compactHistoricalDates', async () => 0);
    const sanitize = context.mock.method(
        fixture.internals.snapshotManager,
        'sanitizeHistoricalSnapshots',
        async () => 0
    );
    const first = fixture.fileLogger.initialize();
    const second = fixture.fileLogger.initialize();
    try {
        assert.equal(first, second);
        assert.equal(initialize.mock.callCount(), 1);
    } finally {
        release.release();
        await Promise.all([first, second]);
    }
    await lifecycle.historicalMaintenance;
    const timer = lifecycle.pendingLogsCleanupTimer;
    assert.ok(timer);
    assert.equal(fixture.fileLogger.initialize(), first);
    assert.equal(lifecycle.pendingLogsCleanupTimer, timer);
    assert.equal(compact.mock.callCount(), 1);
    assert.equal(sanitize.mock.callCount(), 1);
});

test('disposal drains accepted retention deletion and rejects new cleanup work', { timeout: 5000 }, async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    await initializeLogger(host, context, fixture.fileLogger);
    const date = '2020-01-01';
    const rawPath = fixture.internals.pathManager.getHourFilePath(date, 1);
    const dateFolder = dirname(rawPath);
    await fs.mkdir(dateFolder, { recursive: true });
    await fs.writeFile(rawPath, JSON.stringify(snapshotRow(date, 'retention', 1)) + '\n');
    const entered = gate();
    const release = gate();
    const readdir = fs.readdir.bind(fs);
    const remove = fs.rm.bind(fs);
    let returned = false;
    let lateDeletions = 0;
    context.mock.method(fs, 'readdir', async (...args: Parameters<typeof readdir>) => {
        if (String(args[0]) === dateFolder) {
            entered.release();
            await release.promise;
        }
        return readdir(...args);
    });
    context.mock.method(fs, 'rm', async (...args: Parameters<typeof remove>) => {
        if (String(args[0]) === dateFolder && returned) {
            lateDeletions++;
        }
        return remove(...args);
    });
    const cleaning = fixture.fileLogger.cleanupExpiredLogs(100);
    let disposing: Promise<void> | undefined;
    try {
        await entered.promise;
        disposing = fixture.manager.dispose().then(() => {
            returned = true;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        await fs.stat(dateFolder);
    } finally {
        release.release();
        await Promise.all([cleaning, disposing]);
    }
    assert.equal(lateDeletions, 0);
    assert.equal(returned, true);
    await assert.rejects(fs.stat(dateFolder), { code: 'ENOENT' });
    const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
    assert.equal(lifecycle.retentionTasks.size, 0);
    const compact = context.mock.method(fixture.internals.snapshotManager, 'compactHistoricalDates', async () => 0);
    const cleanup = context.mock.method(lifecycle.cleanupManager, 'cleanupExpiredLogs', async () => 0);
    assert.equal(await fixture.fileLogger.cleanupExpiredLogs(100), 0);
    assert.equal(compact.mock.callCount(), 0);
    assert.equal(cleanup.mock.callCount(), 0);
});

test('retention disposal waits for every accepted task even when one fails', { timeout: 5000 }, async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    await initializeLogger(host, context, fixture.fileLogger);
    const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
    const entered = gate();
    const releaseFailure = gate();
    const releaseSuccess = gate();
    const failure = new Error('Injected retention failure');
    context.mock.method(fixture.internals.snapshotManager, 'compactHistoricalDates', async () => 0);
    context.mock.method(lifecycle.cleanupManager, 'cleanupExpiredLogs', async (retentionDays: number) => {
        if (retentionDays === 1) {
            await releaseFailure.promise;
            throw failure;
        }
        entered.release();
        await releaseSuccess.promise;
        return 2;
    });
    const failed = fixture.fileLogger.cleanupExpiredLogs(1);
    const success = fixture.fileLogger.cleanupExpiredLogs(2);
    const rejected = assert.rejects(failed, error => error === failure);
    let returned = false;
    let disposing: Promise<void> | undefined;
    try {
        await entered.promise;
        disposing = fixture.fileLogger.dispose().then(() => {
            returned = true;
        });
        releaseFailure.release();
        await rejected;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        assert.equal(lifecycle.retentionTasks.size, 1);
    } finally {
        releaseFailure.release();
        releaseSuccess.release();
        await Promise.all([rejected, success, disposing]);
    }
    assert.equal(await success, 2);
    assert.equal(returned, true);
    assert.equal(lifecycle.retentionTasks.size, 0);
});

for (const scenario of [
    { source: 'history', pause: 'read', failure: 'none' },
    { source: 'history', pause: 'commit', failure: 'none' },
    { source: 'raw', pause: 'read', failure: 'none' },
    { source: 'history', pause: 'commit', failure: 'subscription' },
    { source: 'history', pause: 'commit', failure: 'publications' },
    { source: 'history', pause: 'commit', failure: 'writer' }
] as const) {
    test(
        `title backfill disposal drains ${scenario.source}/${scenario.pause} despite ${scenario.failure} failure`,
        { timeout: 5000 },
        async context => {
            const host = await createUsageHost();
            const fixture = await host.fixture(context);
            context.after(() => host.restore());
            await initializeLogger(host, context, fixture.fileLogger);
            const date = scenario.source === 'history' ? '2020-01-01' : DateUtils.getTodayDateString();
            const row = snapshotRow(date, 'backfill-lifecycle', 1);
            const { pathManager, snapshotManager, readManager, writeManager, logStatsManager } = fixture.internals;
            const snapshotPath = pathManager.getSnapshotFilePath(date);
            const rawPath = pathManager.getHourFilePath(date, 1);
            const lockPath = join(pathManager.getDateFolderPath(date), '.requests.lock');
            if (scenario.source === 'history') {
                await snapshotManager.buildSnapshotFromLogs(date, [row]);
            } else {
                await fs.mkdir(dirname(rawPath), { recursive: true });
                await fs.writeFile(rawPath, JSON.stringify(row) + '\n');
            }
            const failure = new Error(`Injected backfill ${scenario.failure} cleanup failure`);
            let failed = false;
            const failOnce = (): void => {
                if (!failed) {
                    failed = true;
                    throw failure;
                }
            };
            if (scenario.failure === 'subscription') {
                const internal = fixture.fileLogger as unknown as { liveMetricsDisposable: vscode.Disposable };
                context.mock.method(internal.liveMetricsDisposable, 'dispose', failOnce);
            } else if (scenario.failure === 'publications') {
                context.mock.method(logStatsManager, 'flushStatsPublications', async () => failOnce());
            } else if (scenario.failure === 'writer') {
                const disposeWriter = writeManager.dispose.bind(writeManager);
                context.mock.method(writeManager, 'dispose', async () => {
                    await disposeWriter();
                    failOnce();
                });
            }
            const entered = gate();
            const release = gate();
            let returned = false;
            let lateLocks = 0;
            let lateCommits = 0;
            const mkdir = fs.mkdir.bind(fs);
            const rename = fs.rename.bind(fs);
            const append = fs.appendFile.bind(fs);
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
                    if (returned) {
                        lateCommits++;
                    }
                }
                return rename(...args);
            });
            context.mock.method(fs, 'appendFile', async (...args: Parameters<typeof append>) => {
                if (String(args[0]) === rawPath && returned) {
                    lateCommits++;
                }
                return append(...args);
            });
            if (scenario.pause === 'read' && scenario.source === 'history') {
                const read = snapshotManager.read.bind(snapshotManager);
                context.mock.method(snapshotManager, 'read', async (...args: Parameters<typeof read>) => {
                    const records = await read(...args);
                    entered.release();
                    await release.promise;
                    return records;
                });
            } else if (scenario.pause === 'read') {
                const read = readManager.findLatestRequestLog.bind(readManager);
                context.mock.method(readManager, 'findLatestRequestLog', async (...args: Parameters<typeof read>) => {
                    const record = await read(...args);
                    entered.release();
                    await release.promise;
                    return record;
                });
            }
            const backfilling = fixture.manager.backfillResolvedSessionTitle(
                row.sessionId!,
                'Lifecycle title',
                row.requestId
            );
            let disposing: Promise<unknown> | undefined;
            try {
                await Promise.race([
                    entered.promise,
                    backfilling.then(() => {
                        throw new Error('Backfill did not reach its pause');
                    })
                ]);
                if (scenario.pause === 'commit') {
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
                await Promise.all([backfilling, disposing]);
            }
            assert.equal(returned, true);
            assert.equal(lateLocks, 0);
            assert.equal(lateCommits, 0);
            await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
            const latest =
                scenario.source === 'history' ?
                    (await snapshotManager.read(date))?.find(record => record.requestId === row.requestId)
                :   await readManager.findLatestRequestLog(date, row.requestId);
            assert.equal(latest?.sessionTitle, 'Lifecycle title');
            assert.equal((fixture.fileLogger as unknown as LoggerLifecycleState).backfillTasks.size, 0);
            const error = await disposing;
            if (scenario.failure === 'none') {
                assert.equal(error, undefined);
            } else {
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [failure]);
            }
        }
    );
}

test('title backfill disposal waits for every accepted task when one fails', { timeout: 5000 }, async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    await initializeLogger(host, context, fixture.fileLogger);
    const failedRow = snapshotRow('2020-01-01', 'failed-title', 1);
    const successfulRow = snapshotRow('2020-01-02', 'successful-title', 1);
    const { snapshotManager } = fixture.internals;
    await snapshotManager.buildSnapshotFromLogs('2020-01-01', [failedRow]);
    await snapshotManager.buildSnapshotFromLogs('2020-01-02', [successfulRow]);
    const entered = gate();
    const releaseFailure = gate();
    const releaseSuccess = gate();
    const failure = new Error('Injected title backfill read failure');
    const read = snapshotManager.read.bind(snapshotManager);
    context.mock.method(snapshotManager, 'read', async (date: string) => {
        if (date === '2020-01-01') {
            await releaseFailure.promise;
            throw failure;
        }
        entered.release();
        await releaseSuccess.promise;
        return read(date);
    });
    const failed = fixture.fileLogger.backfillSessionTitle({
        requestId: failedRow.requestId,
        sessionId: failedRow.sessionId!,
        sessionTitle: 'Failed title'
    });
    const success = fixture.fileLogger.backfillSessionTitle({
        requestId: successfulRow.requestId,
        sessionId: successfulRow.sessionId!,
        sessionTitle: 'Successful title'
    });
    const rejected = assert.rejects(failed, error => error === failure);
    const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
    let returned = false;
    let disposing: Promise<void> | undefined;
    try {
        await entered.promise;
        disposing = fixture.fileLogger.dispose().then(() => {
            returned = true;
        });
        releaseFailure.release();
        await rejected;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        assert.equal(lifecycle.backfillTasks.size, 1);
    } finally {
        releaseFailure.release();
        releaseSuccess.release();
        await Promise.all([rejected, success, disposing]);
    }
    assert.equal(await success, true);
    assert.equal(returned, true);
    assert.equal(lifecycle.backfillTasks.size, 0);
    assert.equal((await snapshotManager.read('2020-01-02'))?.[0].sessionTitle, 'Successful title');
});

for (const phase of ['starting', 'completed'] as const) {
    test(`title backfill rejects new work when disposal is ${phase}`, async context => {
        const host = await createUsageHost();
        const fixture = await host.fixture(context);
        context.after(() => host.restore());
        await initializeLogger(host, context, fixture.fileLogger);
        const date = '2020-01-01';
        const row = snapshotRow(date, 'late-backfill', 1);
        const { snapshotManager, readManager, writeManager } = fixture.internals;
        await snapshotManager.buildSnapshotFromLogs(date, [row]);
        const disposing = fixture.fileLogger.dispose();
        if (phase === 'completed') {
            await disposing;
        }
        const read = context.mock.method(snapshotManager, 'read');
        const upsert = context.mock.method(snapshotManager, 'upsertRecord');
        const readRaw = context.mock.method(readManager, 'findLatestRequestLog');
        const append = context.mock.method(writeManager, 'appendLog');
        try {
            assert.equal(
                await fixture.fileLogger.backfillSessionTitle({
                    requestId: row.requestId,
                    sessionId: row.sessionId!,
                    sessionTitle: 'Too late'
                }),
                false
            );
        } finally {
            await disposing;
        }
        assert.equal(read.mock.callCount(), 0);
        assert.equal(upsert.mock.callCount(), 0);
        assert.equal(readRaw.mock.callCount(), 0);
        assert.equal(append.mock.callCount(), 0);
        assert.equal((fixture.fileLogger as unknown as LoggerLifecycleState).backfillTasks.size, 0);
    });
}

for (const scenario of [
    { pause: 'preparation', fail: false },
    { pause: 'calculation', fail: false },
    { pause: 'commit', fail: false },
    { pause: 'commit', fail: true }
] as const) {
    test(`statistics disposal drains ${scenario.pause}; failure=${scenario.fail}`, { timeout: 5000 }, async context => {
        const host = await createUsageHost();
        const fixture = await host.fixture(context);
        context.after(() => host.restore());
        await initializeLogger(host, context, fixture.fileLogger);
        const date = DateUtils.getTodayDateString();
        const rawPath = fixture.internals.pathManager.getHourFilePath(date, 1);
        const statsPath = join(dirname(rawPath), 'stats.json');
        const lockPath = `${statsPath}.commit.lock`;
        await fs.mkdir(dirname(rawPath), { recursive: true });
        await fs.writeFile(rawPath, JSON.stringify(snapshotRow(date, 'stats-disposal', 1)) + '\n');
        const lifecycle = fixture.internals.logStatsManager as unknown as StatsLifecycleState;
        const entered = gate();
        const release = gate();
        const failure = Object.assign(new Error('Injected statistics commit failure'), { code: 'EIO' });
        let returned = false;
        let lateCommits = 0;
        const rename = fs.rename.bind(fs);
        context.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
            if (String(args[1]) === statsPath) {
                if (scenario.pause === 'commit') {
                    entered.release();
                    await release.promise;
                }
                if (scenario.fail) {
                    throw failure;
                }
                if (returned) {
                    lateCommits++;
                }
            }
            return rename(...args);
        });
        if (scenario.pause === 'preparation') {
            const repair = lifecycle.indexManager.repairIfNeeded.bind(lifecycle.indexManager);
            context.mock.method(lifecycle.indexManager, 'repairIfNeeded', async () => {
                const result = await repair();
                entered.release();
                await release.promise;
                return result;
            });
        } else if (scenario.pause === 'calculation') {
            const calculate = lifecycle.calculateDateStats.bind(lifecycle);
            context.mock.method(lifecycle, 'calculateDateStats', async (...args: Parameters<typeof calculate>) => {
                const result = await calculate(...args);
                entered.release();
                await release.promise;
                return result;
            });
        }
        const querying = fixture.fileLogger.getDateStats(date, true);
        const completion =
            scenario.fail ? assert.rejects(querying, error => error === failure) : querying.then(() => {});
        let disposing: Promise<void> | undefined;
        try {
            await Promise.race([
                entered.promise,
                completion.then(() => {
                    throw new Error('Statistics pause was not reached');
                })
            ]);
            if (scenario.pause === 'commit') {
                await fs.stat(lockPath);
            }
            disposing = fixture.manager.dispose().then(() => {
                returned = true;
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(returned, false);
        } finally {
            release.release();
            await Promise.all([completion, disposing]);
        }
        assert.equal(lateCommits, 0);
        assert.equal(lifecycle.statsTasks.size, 0);
        assert.equal(lifecycle.inFlightRegenerations.size, 0);
        await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
        if (scenario.pause === 'commit' && !scenario.fail) {
            await fs.stat(statsPath);
        } else {
            await assert.rejects(fs.stat(statsPath), { code: 'ENOENT' });
        }
    });
}

test('statistics disposal waits for another date when one query fails', { timeout: 5000 }, async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    await initializeLogger(host, context, fixture.fileLogger);
    const lifecycle = fixture.internals.logStatsManager as unknown as StatsLifecycleState;
    const failure = new Error('Injected statistics calculation failure');
    const entered = gate();
    const failedEntered = gate();
    const releaseFailure = gate();
    const releaseSuccess = gate();
    context.mock.method(lifecycle, 'calculateDateStats', async (date: string) => {
        if (date === '2020-01-01') {
            failedEntered.release();
            await releaseFailure.promise;
            throw failure;
        }
        entered.release();
        await releaseSuccess.promise;
        return host.emptyStats();
    });
    const failed = fixture.fileLogger.getDateStats('2020-01-01', true);
    const rejected = assert.rejects(failed, error => error === failure);
    const success = fixture.fileLogger.getDateStats('2020-01-02', true);
    let returned = false;
    let disposing: Promise<void> | undefined;
    try {
        await Promise.all([entered.promise, failedEntered.promise]);
        disposing = fixture.manager.dispose().then(() => {
            returned = true;
        });
        releaseFailure.release();
        await rejected;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(returned, false);
        assert.equal(lifecycle.statsTasks.size, 1);
    } finally {
        releaseFailure.release();
        releaseSuccess.release();
        await Promise.all([rejected, success, disposing]);
    }
    assert.equal(lifecycle.statsTasks.size, 0);
    assert.equal(lifecycle.inFlightRegenerations.size, 0);
});

for (const phase of ['starting', 'completed'] as const) {
    test(`statistics disposal rejects new calculation when ${phase}`, async context => {
        const host = await createUsageHost();
        const fixture = await host.fixture(context);
        context.after(() => host.restore());
        await initializeLogger(host, context, fixture.fileLogger);
        const lifecycle = fixture.internals.logStatsManager as unknown as StatsLifecycleState;
        const disposing = fixture.manager.dispose();
        if (phase === 'completed') {
            await disposing;
        }
        const calculation = context.mock.method(lifecycle, 'calculateDateStats');
        try {
            await fixture.internals.logStatsManager.getDateStats('2020-01-01', true);
        } finally {
            await disposing;
        }
        assert.equal(calculation.mock.callCount(), 0);
    });
}

for (const initialized of [true, false]) {
    for (const failedResource of managerResources) {
        test(`manager disposal continues after ${failedResource} fails; initialized=${initialized}`, async context => {
            const host = await createUsageHost();
            const fixture = await host.fixture(context);
            context.after(() => host.restore());
            await initializeLogger(host, context, fixture.fileLogger);
            const manager = fixture.manager as unknown as ManagerLifecycleState;
            manager.initialized = initialized;
            const calls: string[] = [];
            const failure = new Error(`Injected ${failedResource}`);
            for (const resource of managerResources) {
                manager[resource] = {
                    dispose() {
                        calls.push(resource);
                        if (resource === failedResource) {
                            throw failure;
                        }
                    }
                };
            }
            await assert.rejects(fixture.manager.dispose(), error => error === failure);
            assert.deepEqual(calls, [...managerResources]);
            for (const resource of managerResources) {
                assert.equal(manager[resource], undefined);
            }
            const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
            assert.equal(lifecycle.disposed, true);
            assert.equal(lifecycle.pendingLogsCleanupTimer, null);
            await fixture.manager.dispose();
            assert.deepEqual(calls, [...managerResources]);
        });
    }
}

test('manager disposal preserves multiple errors after releasing the file logger', async context => {
    const host = await createUsageHost();
    const fixture = await host.fixture(context);
    context.after(() => host.restore());
    await initializeLogger(host, context, fixture.fileLogger);
    const manager = fixture.manager as unknown as ManagerLifecycleState;
    const failures = [new Error('First disposal failure'), new Error('Second disposal failure')];
    manager.statusSnapshots = {
        dispose() {
            throw failures[0];
        }
    };
    manager.leaderChangeDisposable = {
        dispose() {
            throw failures[1];
        }
    };
    await assert.rejects(fixture.manager.dispose(), error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, failures);
        return true;
    });
    const lifecycle = fixture.fileLogger as unknown as LoggerLifecycleState;
    assert.equal(lifecycle.disposed, true);
    assert.equal(lifecycle.pendingLogsCleanupTimer, null);
});
