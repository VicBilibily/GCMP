import assert from 'node:assert/strict';
import { readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TokenUsageStatsFromFile } from '../fileLogger/types';
import { createUsageHost } from './hostFixture';
import { gate, snapshotFixture, snapshotRow } from './snapshotFixture';

test('snapshot validation remains bound to the source and saved stats versions', { timeout: 30000 }, async suite => {
    const host = await createUsageHost();
    try {
        const { SnapshotManager } = await import('../fileLogger/snapshotManager');
        for (const kind of ['snapshot', 'same-mtime-snapshot', 'raw'] as const) {
            await suite.test(`${kind}: a later source change invalidates the acknowledged version`, async context => {
                const f = await snapshotFixture(host, context);
                await f.changeTitle();
                if (kind === 'same-mtime-snapshot') {
                    await f.equalMtime();
                }
                await f.fileLogger.getDateStats(f.date);
                const oldSnapshot = await stat(f.snapshotPath);
                const second = snapshotRow(f.date, 'second', 10);
                if (kind === 'raw') {
                    await writeFile(
                        f.internals.pathManager.getHourFilePath(f.date, 10),
                        JSON.stringify(second) + '\n',
                        { flag: 'wx' }
                    );
                } else {
                    const external = new SnapshotManager(f.internals.pathManager, () => {});
                    await external.upsertRecord(f.date, second);
                    if (kind === 'same-mtime-snapshot') {
                        await utimes(f.snapshotPath, oldSnapshot.atime, oldSnapshot.mtime);
                    }
                }
                assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                assert.equal(rebuilt[f.date]?.total.requests, 2);
                assert.equal(rebuilt[f.date]?.total.actualInput, 20);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
            });
        }

        await suite.test('same size and mtime replacement cannot validate an old snapshot cache', async context => {
            const f = await snapshotFixture(host, context);
            await f.changeTitle();
            await f.equalMtime();
            await f.fileLogger.getDateStats(f.date);
            const previous = await stat(f.snapshotPath);
            const external = new SnapshotManager(f.internals.pathManager, () => {});
            await external.upsertRecord(f.date, {
                ...f.row,
                sessionTitle: '回填标题',
                rawUsage: { prompt_tokens: 20, completion_tokens: 6 },
                streamStartTime: f.row.streamStartTime! + 1000,
                streamEndTime: f.row.streamEndTime! + 1000
            });
            await utimes(f.snapshotPath, previous.atime, previous.mtime);
            const replaced = await stat(f.snapshotPath);
            assert.equal(replaced.mtimeMs, previous.mtimeMs);
            assert.equal(replaced.size, previous.size);
            assert.ok(replaced.ctimeMs !== previous.ctimeMs || replaced.ino !== previous.ino);
            const rebuilt = await f.fileLogger.regenerateOutdatedStats();
            assert.equal(rebuilt[f.date]?.total.actualInput, 20);
            assert.equal(rebuilt[f.date]?.total.outputTokens, 6);
            assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
        });

        for (const kind of ['code-version', 'saved-version', 'missing-stats'] as const) {
            await suite.test(`${kind}: acknowledged sources do not bypass stats validity`, async context => {
                const f = await snapshotFixture(host, context);
                await f.changeTitle();
                await f.fileLogger.getDateStats(f.date);
                if (kind === 'code-version') {
                    f.internals.logStatsManager.updateCodeVersionTimestamp(2);
                } else if (kind === 'saved-version') {
                    const saved = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                    saved.versionTimestamp = 0;
                    saved.total.actualInput = 999;
                    await writeFile(f.statsPath, JSON.stringify(saved));
                } else {
                    await unlink(f.statsPath);
                }
                const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                assert.equal(rebuilt[f.date]?.total.actualInput, 10);
                assert.equal(rebuilt[f.date]?.versionTimestamp, kind === 'code-version' ? 2 : 1);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
            });
        }

        await suite.test(
            'duplicate raw sources and their removal converge without changing statistics',
            async context => {
                const f = await snapshotFixture(host, context);
                const rawPath = f.internals.pathManager.getHourFilePath(f.date, 9);
                await writeFile(rawPath, JSON.stringify(f.row) + '\n', { flag: 'wx' });
                await f.changeTitle();
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                assert.equal(await f.privateStats.needsRegeneration(f.date), false);
                await unlink(rawPath);
                assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                assert.equal(await f.privateStats.needsRegeneration(f.date), false);
                assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
            }
        );

        for (const kind of ['snapshot', 'raw', 'stats'] as const) {
            await suite.test(
                `${kind}: writes during validation are not acknowledged as already read`,
                async context => {
                    const f = await snapshotFixture(host, context);
                    await f.changeTitle();
                    const entered = gate();
                    const release = gate();
                    if (kind === 'stats') {
                        const load = f.privateStats.loadStats.bind(f.privateStats);
                        let calls = 0;
                        context.mock.method(f.privateStats, 'loadStats', async (date: string) => {
                            const result = await load(date);
                            if (++calls === 2) {
                                entered.release();
                                await release.promise;
                            }
                            return result;
                        });
                    } else {
                        const read = f.internals.snapshotManager.read.bind(f.internals.snapshotManager);
                        let first = true;
                        context.mock.method(f.internals.snapshotManager, 'read', async (date: string) => {
                            const result = await read(date);
                            if (first) {
                                first = false;
                                entered.release();
                                await release.promise;
                            }
                            return result;
                        });
                    }
                    const reading = f.fileLogger.getDateStats(f.date);
                    try {
                        await entered.promise;
                        const second = snapshotRow(f.date, 'late', 10);
                        if (kind === 'snapshot') {
                            await f.internals.snapshotManager.upsertRecord(f.date, second);
                        } else if (kind === 'raw') {
                            await writeFile(
                                f.internals.pathManager.getHourFilePath(f.date, 10),
                                JSON.stringify(second) + '\n',
                                { flag: 'wx' }
                            );
                        } else {
                            const saved = JSON.parse(await readFile(f.statsPath, 'utf8')) as TokenUsageStatsFromFile;
                            saved.versionTimestamp = 0;
                            await writeFile(f.statsPath, JSON.stringify(saved));
                        }
                        release.release();
                        await reading;
                        assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                        const rebuilt = await f.fileLogger.regenerateOutdatedStats();
                        assert.equal(rebuilt[f.date]?.total.requests, kind === 'stats' ? 1 : 2);
                        assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                    } finally {
                        release.release();
                        await reading;
                    }
                }
            );
        }

        await suite.test(
            'snapshot read failure does not acknowledge a changed source or rewrite old files',
            async context => {
                const f = await snapshotFixture(host, context);
                await f.changeTitle();
                await f.fileLogger.getDateStats(f.date);
                await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
                const indexPath = join(f.dir, 'usages', 'index.json');
                const indexBefore = await readFile(indexPath, 'utf8');
                const failed = context.mock.method(f.internals.snapshotManager, 'read', async () => {
                    throw new Error('snapshot read failure');
                });
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
                assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
                assert.equal(await readFile(indexPath, 'utf8'), indexBefore);
                assert.equal(await f.privateStats.needsRegeneration(f.date), true);
                failed.mock.restore();
                assert.equal((await f.fileLogger.regenerateOutdatedStats())[f.date]?.total.requests, 2);
                assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
            }
        );

        await suite.test('an acknowledged source still allows explicit refresh', async context => {
            const f = await snapshotFixture(host, context);
            await f.changeTitle();
            await f.fileLogger.getDateStats(f.date);
            const read = context.mock.method(f.internals.snapshotManager, 'read');
            const result = await f.fileLogger.getDateStats(f.date, true);
            assert.equal(result.total.requests, 1);
            assert.equal(read.mock.callCount(), 1);
            assert.equal(await readFile(f.statsPath, 'utf8'), f.originalStats);
        });

        await suite.test('a genuine rebuilt result is not hidden by a later unchanged verification', async context => {
            const f = await snapshotFixture(host, context);
            await f.internals.snapshotManager.upsertRecord(f.date, snapshotRow(f.date, 'second', 10));
            const getStats = f.internals.logStatsManager.getDateStats.bind(f.internals.logStatsManager);
            let first = true;
            context.mock.method(
                f.internals.logStatsManager,
                'getDateStats',
                async (date: string, ignoreCache?: boolean) => {
                    const result = await getStats(date, ignoreCache);
                    if (first) {
                        first = false;
                        await getStats(date, true);
                    }
                    return result;
                }
            );
            const rebuilt = await f.fileLogger.regenerateOutdatedStats();
            assert.equal(rebuilt[f.date]?.total.requests, 2);
            assert.deepEqual(await f.fileLogger.regenerateOutdatedStats(), {});
        });
    } finally {
        host.restore();
    }
});
