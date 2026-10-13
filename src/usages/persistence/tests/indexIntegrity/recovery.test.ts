import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DateUtils } from '../../../fileLogger/dateUtils';
import type { LogIndexManager } from '../../../fileLogger/logIndexManager';
import type { DateIndex, TokenUsageStatsFromFile } from '../../../fileLogger/types';
import { createUsageHost } from '../../../tests/hostFixture';
import type { RecoveryFixture } from '../../../tests/recovery/fixture';

async function readDisk(f: RecoveryFixture, indexPath: string) {
    const stats = JSON.parse(await fs.readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as DateIndex;
    return { stats: stats.total.requests, index };
}

test(
    'rebuildable indexes preserve initialization and recover post-save read failures',
    { timeout: 30000 },
    async suite => {
        const host = await createUsageHost();
        try {
            const { snapshotFixture, snapshotRow } = await import('../../../tests/snapshotFixture');
            const { initializeLogger } = await import('../../../tests/recovery/fixture');
            const { indexFiles, statisticsFiles } = await import('../../statisticsFiles');

            async function fixture(c: TestContext) {
                const f = await snapshotFixture(host, c);
                const other = DateUtils.getDateStringDaysAgo(8);
                await f.internals.snapshotManager.buildSnapshotFromLogs(other, [snapshotRow(other, 'other')]);
                assert.equal((await f.fileLogger.getDateStats(other)).total.requests, 1);
                const index = (f.internals as unknown as { indexManager: LogIndexManager }).indexManager;
                const indexPath = index.getIndexPath();
                assert.equal((await index.getIndex())[f.date]?.total_requests, 1);
                const original = await fs.readFile(indexPath, 'utf8');
                const before = JSON.parse(original) as DateIndex;
                const dates = [f.date, other].sort();
                assert.deepEqual(Object.keys(before.dates).sort(), dates);
                assert.equal(before.dates[f.date].total_requests, 1);
                assert.equal(before.dates[other].total_requests, 1);
                assert.equal((await readDisk(f, indexPath)).stats, 1);
                assert.deepEqual((await indexFiles.read(indexPath)).value, before);
                const otherPath = join(f.dir, 'usages', other, 'stats.json');
                const otherBody = await fs.readFile(otherPath, 'utf8');
                function assertDates(entries: DateIndex['dates'], requests = 1) {
                    assert.deepEqual(Object.keys(entries).sort(), dates);
                    assert.equal(entries[f.date].total_requests, requests);
                    const {
                        native_total_cost: actualUsd,
                        native_total_cost_rmb: actualRmb,
                        ...actual
                    } = entries[other];
                    const {
                        native_total_cost: expectedUsd,
                        native_total_cost_rmb: expectedRmb,
                        ...expected
                    } = before.dates[other];
                    assert.deepEqual(actual, expected);
                    assert.equal(actualUsd, expectedUsd);
                    assert.equal(actualRmb, expectedRmb);
                }
                async function assertOtherStats() {
                    assert.equal(await fs.readFile(otherPath, 'utf8'), otherBody);
                }
                return { ...f, other, index, indexPath, original, before, assertDates, assertOtherStats };
            }

            for (const scenario of ['same-value control', 'malformed JSON', 'invalid dates shape'] as const) {
                await suite.test(`initialize/${scenario}`, async c => {
                    const f = await fixture(c);
                    try {
                        const replacement =
                            scenario === 'same-value control' ? f.original
                            : scenario === 'malformed JSON' ? '{'
                            : JSON.stringify({ dates: [] });
                        await fs.writeFile(f.indexPath, replacement, 'utf8');
                        indexFiles.invalidate(f.indexPath);
                        let initError: unknown;
                        try {
                            await initializeLogger(host, c, f.fileLogger);
                        } catch (error) {
                            initError = error;
                        }
                        const saved = JSON.parse(await fs.readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                        assert.equal(saved.total.requests, 1, 'Index damage must not destroy saved statistics');
                        await f.assertOtherStats();
                        assert.equal(
                            initError,
                            undefined,
                            'A rebuildable index must not abort real logger initialization'
                        );
                        assert.equal((await f.fileLogger.getDateStats(f.date)).total.requests, 1);
                        f.assertDates(await f.index.getIndexFast());
                        const after = await readDisk(f, f.indexPath);
                        assert.equal(after.stats, 1);
                        f.assertDates(after.index.dates);
                        await f.assertOtherStats();
                    } finally {
                        c.mock.restoreAll();
                        await f.fileLogger.dispose();
                    }
                });
            }

            for (const code of [undefined, 'EIO', 'EACCES', 'EPERM'] as const) {
                await suite.test(`post-save stats read/${code ? `one ${code}` : 'no-fault control'}`, async c => {
                    const f = await fixture(c);
                    try {
                        await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                        const update = f.index.updateIndex.bind(f.index);
                        const read = fs.readFile.bind(fs);
                        const injected = Object.assign(new Error('Injected stats read inside updateIndex'), { code });
                        let inUpdate = false;
                        let updateCalls = 0;
                        let updateReads = 0;
                        let failures = 0;
                        let calculated: TokenUsageStatsFromFile;
                        try {
                            c.mock.method(f.index, 'updateIndex', async (...args: Parameters<typeof update>) => {
                                inUpdate = true;
                                updateCalls++;
                                statisticsFiles.invalidate(f.statsPath);
                                try {
                                    return await update(...args);
                                } finally {
                                    inUpdate = false;
                                }
                            });
                            c.mock.method(fs, 'readFile', ((...args: Parameters<typeof read>) => {
                                if (inUpdate && String(args[0]) === f.statsPath) {
                                    updateReads++;
                                    if (code && failures === 0) {
                                        failures++;
                                        return Promise.reject(injected);
                                    }
                                }
                                return read(...args);
                            }) as typeof fs.readFile);
                            calculated = await f.fileLogger.getDateStats(f.date);
                        } finally {
                            c.mock.restoreAll();
                        }
                        const firstDisk = await readDisk(f, f.indexPath);
                        const firstFast = await f.index.getIndexFast();
                        await f.index.repairIfNeeded();
                        const reread = await f.fileLogger.getDateStats(f.date);
                        const secondFast = await f.index.getIndexFast();
                        const secondDisk = await readDisk(f, f.indexPath);
                        const snapshotCount = (await f.internals.snapshotManager.read(f.date))?.length;
                        assert.equal(
                            failures,
                            code ? 1 : 0,
                            'Only the first stats body read inside updateIndex may fail'
                        );
                        assert.equal(updateCalls, 1);
                        assert.ok(updateReads >= 1, 'The real index updater must read the saved statistics');
                        assert.equal(inUpdate, false);
                        assert.equal(snapshotCount, 2);
                        assert.equal(calculated.total.requests, 2);
                        assert.equal(firstDisk.stats, 2);
                        assert.deepEqual(Object.keys(firstDisk.index.dates).sort(), Object.keys(f.before.dates).sort());
                        assert.deepEqual(firstDisk.index.dates[f.other], f.before.dates[f.other]);
                        if (!code) {
                            assert.equal(firstDisk.index.dates[f.date].total_requests, 2);
                        }
                        assert.equal(reread.total.requests, 2);
                        assert.equal(secondDisk.stats, 2);
                        f.assertDates(firstFast, 2);
                        f.assertDates(secondFast, 2);
                        f.assertDates(secondDisk.index.dates, 2);
                        await f.assertOtherStats();
                    } finally {
                        c.mock.restoreAll();
                        await f.fileLogger.dispose();
                    }
                });
            }

            for (const code of [undefined, 'EIO'] as const) {
                await suite.test(`setVersionTimestamp/${code ? 'one EIO' : 'no-fault control'}`, async c => {
                    const f = await fixture(c);
                    try {
                        const saved = await fs.readFile(f.statsPath, 'utf8');
                        indexFiles.invalidate(f.indexPath);
                        const injected = Object.assign(new Error('Injected index body read'), { code });
                        const read = fs.readFile.bind(fs);
                        let bodyReads = 0;
                        let failures = 0;
                        try {
                            c.mock.method(fs, 'readFile', ((...args: Parameters<typeof read>) => {
                                if (String(args[0]) === f.indexPath) {
                                    bodyReads++;
                                    if (code && failures === 0) {
                                        failures++;
                                        return Promise.reject(injected);
                                    }
                                }
                                return read(...args);
                            }) as typeof fs.readFile);
                            if (code) {
                                await assert.rejects(f.index.setVersionTimestamp(42), error => {
                                    assert.strictEqual(error, injected);
                                    return true;
                                });
                            } else {
                                await f.index.setVersionTimestamp(42);
                            }
                        } finally {
                            c.mock.restoreAll();
                        }
                        assert.ok(bodyReads > 0);
                        assert.equal(failures, code ? 1 : 0);
                        const after = await fs.readFile(f.indexPath, 'utf8');
                        if (code) {
                            assert.equal(after, f.original);
                        } else {
                            assert.equal((JSON.parse(after) as DateIndex).versionTimestamp, 42);
                        }
                        assert.deepEqual((JSON.parse(after) as DateIndex).dates, f.before.dates);
                        assert.equal(await fs.readFile(f.statsPath, 'utf8'), saved);
                        await f.assertOtherStats();
                    } finally {
                        c.mock.restoreAll();
                        await f.fileLogger.dispose();
                    }
                });
            }
        } finally {
            host.restore();
        }
    }
);
