import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { TokenFileLogger as Logger } from '../../../fileLogger';
import { DateUtils } from '../../../fileLogger/dateUtils';
import type { LogIndexManager } from '../../../fileLogger/logIndexManager';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost, type LoggerInternals } from '../../../tests/hostFixture';

const indexOf = (logger: Logger) => (logger as unknown as { indexManager: LogIndexManager }).indexManager;
const versionOf = (logger: Logger) =>
    (
        logger as unknown as { logStatsManager: { getCodeVersionTimestamp(): number } }
    ).logStatsManager.getCodeVersionTimestamp();
type FaultMode = 'none' | 'once' | 'persistent';

function injectReadError(c: TestContext, path: string, mode: FaultMode, inBoundary: () => boolean) {
    const read = fs.readFile.bind(fs);
    const injected = Object.assign(new Error('Injected statistics body read inside index operation'), { code: 'EIO' });
    let reads = 0;
    let failures = 0;
    c.mock.method(fs, 'readFile', ((...args: Parameters<typeof read>) => {
        if (inBoundary() && String(args[0]) === path) {
            reads++;
            if (mode === 'persistent' || (mode === 'once' && failures === 0)) {
                failures++;
                return Promise.reject(injected);
            }
        }
        return read(...args);
    }) as typeof fs.readFile);
    return () => {
        assert.ok(reads > 0, 'The real index operation must read the statistics body');
        if (mode === 'persistent') {
            assert.equal(failures, reads);
        } else {
            assert.equal(failures, mode === 'once' ? 1 : 0);
        }
    };
}

test('index recovery survives initialization failures and logger replacement', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const { TokenFileLogger } = await import('../../../fileLogger');
        const { snapshotFixture, snapshotRow } = await import('../../../tests/snapshotFixture');
        const { initializeLogger } = await import('../../../tests/recovery/fixture');
        const { indexFiles, statisticsFiles } = await import('../../statisticsFiles');

        async function fixture(c: TestContext) {
            const f = await snapshotFixture(host, c);
            await initializeLogger(host, c, f.fileLogger);
            assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 1);
            const other = DateUtils.getDateStringDaysAgo(8);
            await f.internals.snapshotManager.buildSnapshotFromLogs(other, [snapshotRow(other, 'other')]);
            assert.equal((await f.fileLogger.getDateStats(other)).total.requests, 1);
            await f.fileLogger.getIndex();
            const index = indexOf(f.fileLogger);
            const indexPath = index.getIndexPath();
            const before = JSON.parse(await fs.readFile(indexPath, 'utf8')) as DateIndex;
            const statsBody = await fs.readFile(f.statsPath, 'utf8');
            const otherPath = join(f.dir, 'usages', other, 'stats.json');
            const otherBody = await fs.readFile(otherPath, 'utf8');
            const codeVersion = versionOf(f.fileLogger);
            assert.ok(codeVersion > 1);
            assert.equal(before.versionTimestamp, codeVersion);
            assert.equal((JSON.parse(statsBody) as TokenUsageStatsFromFile).versionTimestamp, codeVersion);
            function assertDates(entries: DateIndex['dates'], requests = 1) {
                assert.deepEqual(Object.keys(entries).sort(), [f.date, other].sort());
                assert.equal(entries[f.date]?.total_requests, requests);
                assert.equal(entries[other]?.total_requests, 1);
                assert.equal(JSON.stringify(entries[other]), JSON.stringify(before.dates[other]));
            }
            assertDates(before.dates);
            async function assertStats(body = statsBody) {
                assert.equal(await fs.readFile(f.statsPath, 'utf8'), body);
                assert.equal(await fs.readFile(otherPath, 'utf8'), otherBody);
            }
            function invalidate() {
                indexFiles.invalidate(indexPath);
                statisticsFiles.invalidate(f.statsPath);
                statisticsFiles.invalidate(otherPath);
            }
            return { ...f, index, indexPath, codeVersion, assertDates, assertStats, invalidate };
        }

        for (const mode of ['none', 'once', 'persistent'] as const) {
            await suite.test(`malformed index initialization/${mode} statistics EIO`, async c => {
                const f = await fixture(c);
                let successor: Logger | undefined;
                try {
                    await f.fileLogger.dispose();
                    await fs.writeFile(f.indexPath, '{', 'utf8');
                    f.invalidate();
                    successor = host.run('leader', () => new TokenFileLogger(f.extensionContext));
                    const index = indexOf(successor);
                    const repair = index.repairIfNeeded.bind(index);
                    let inRepair = false;
                    c.mock.method(index, 'repairIfNeeded', async (...args: Parameters<typeof repair>) => {
                        inRepair = true;
                        statisticsFiles.invalidate(f.statsPath);
                        try {
                            return await repair(...args);
                        } finally {
                            inRepair = false;
                        }
                    });
                    const assertInjection = injectReadError(c, f.statsPath, mode, () => inRepair);
                    let initError: unknown;
                    try {
                        await initializeLogger(host, c, successor);
                    } catch (error) {
                        initError = error;
                    }
                    assertInjection();
                    await f.assertStats();
                    if (mode === 'persistent') {
                        assert.equal(await fs.readFile(f.indexPath, 'utf8'), '{');
                    }
                    assert.equal(
                        initError,
                        undefined,
                        'An unavailable rebuildable index must not abort initialization'
                    );
                    assert.equal(versionOf(successor), f.codeVersion);
                    c.mock.restoreAll();
                    assert.equal((await successor.getDateStats(f.date)).total.requests, 1);
                    f.assertDates(await successor.getIndexFast());
                    f.assertDates((JSON.parse(await fs.readFile(f.indexPath, 'utf8')) as DateIndex).dates);
                    await f.assertStats();
                } finally {
                    c.mock.restoreAll();
                    try {
                        await successor?.dispose();
                    } finally {
                        await f.fileLogger.dispose();
                    }
                }
            });
        }

        for (const entry of ['ordinary read', 'first fast read', 'explicit repair'] as const) {
            for (const inject of [false, true]) {
                await suite.test(`restart/${entry}/${inject ? 'update EIO' : 'no-fault control'}`, async c => {
                    const f = await fixture(c);
                    let successor: Logger | undefined;
                    try {
                        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                        const update = f.index.updateIndex.bind(f.index);
                        let inUpdate = false;
                        c.mock.method(f.index, 'updateIndex', async (...args: Parameters<typeof update>) => {
                            inUpdate = true;
                            statisticsFiles.invalidate(f.statsPath);
                            try {
                                return await update(...args);
                            } finally {
                                inUpdate = false;
                            }
                        });
                        const assertInjection = injectReadError(
                            c,
                            f.statsPath,
                            inject ? 'once' : 'none',
                            () => inUpdate
                        );
                        let calculated: TokenUsageStatsFromFile;
                        try {
                            calculated = await f.fileLogger.getDateStats(f.date);
                        } finally {
                            c.mock.restoreAll();
                        }
                        assertInjection();
                        assert.equal(calculated.total.requests, 2);
                        const savedBody = await fs.readFile(f.statsPath, 'utf8');
                        const saved = JSON.parse(savedBody) as TokenUsageStatsFromFile;
                        assert.equal(saved.total.requests, 2);
                        assert.equal(saved.versionTimestamp, f.codeVersion);
                        await f.assertStats(savedBody);
                        const pending = JSON.parse(await fs.readFile(f.indexPath, 'utf8')) as DateIndex;
                        f.assertDates(pending.dates, inject ? 1 : 2);
                        assert.equal(pending.versionTimestamp, f.codeVersion);
                        await f.fileLogger.dispose();
                        f.invalidate();
                        successor = host.run('leader', () => new TokenFileLogger(f.extensionContext));
                        const index = indexOf(successor);
                        const scanning = index as unknown as { getAllStatsDates(): Promise<string[]> };
                        const scans = c.mock.method(scanning, 'getAllStatsDates');
                        await initializeLogger(host, c, successor);
                        assert.equal(
                            scans.mock.callCount(),
                            0,
                            'Initialization with a valid version must not force a full history reconciliation'
                        );
                        assert.equal(versionOf(successor), f.codeVersion);
                        const snapshots = c.mock.method(
                            (successor as unknown as LoggerInternals).snapshotManager,
                            'read'
                        );
                        if (entry === 'ordinary read') {
                            assert.equal((await successor.getDateStats(f.date)).total.requests, 2);
                        } else if (entry === 'first fast read') {
                            f.assertDates(await successor.getIndexFast(), 2);
                        } else {
                            await index.repairIfNeeded();
                        }
                        const repaired = JSON.parse(await fs.readFile(f.indexPath, 'utf8')) as DateIndex;
                        f.assertDates(repaired.dates, 2);
                        assert.equal(repaired.versionTimestamp, f.codeVersion);
                        const scansAfterRecovery = scans.mock.callCount();
                        if (entry === 'first fast read' && inject) {
                            assert.ok(scansAfterRecovery > 0, 'The first fast read must reconcile the stale index');
                        }
                        for (let round = 0; round < 3; round++) {
                            f.assertDates(await successor.getIndexFast(), 2);
                        }
                        assert.equal(
                            scans.mock.callCount(),
                            scansAfterRecovery,
                            'Consecutive fast reads must not reconcile the recovered index again'
                        );
                        assert.equal((await successor.getDateStats(f.date)).total.requests, 2);
                        assert.equal(
                            snapshots.mock.callCount(),
                            0,
                            'Current saved statistics must not be recalculated'
                        );
                        snapshots.mock.restore();
                        assert.equal(
                            (await (successor as unknown as LoggerInternals).snapshotManager.read(f.date))?.length,
                            2
                        );
                        f.assertDates(await successor.getIndex(), 2);
                        f.assertDates((JSON.parse(await fs.readFile(f.indexPath, 'utf8')) as DateIndex).dates, 2);
                        await f.assertStats(savedBody);
                    } finally {
                        c.mock.restoreAll();
                        try {
                            await successor?.dispose();
                        } finally {
                            await f.fileLogger.dispose();
                        }
                    }
                });
            }
        }
    } finally {
        host.restore();
    }
});
