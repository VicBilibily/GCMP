import assert from 'node:assert/strict';
import { appendFile, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import test, { type TestContext } from 'node:test';
import { DateUtils } from '../fileLogger/dateUtils';
import type { TokenRequestLog } from '../fileLogger/types';
import { createUsageHost } from './hostFixture';

function record(date: string, hour: number, suffix = 'seed'): TokenRequestLog {
    const timestamp = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`).getTime();
    return {
        requestId: `${timestamp}_${suffix}`,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 10,
        status: 'completed',
        rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
    };
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}

test('local hourly writes preserve unrelated detail caches', async suite => {
    const host = await createUsageHost();
    try {
        async function fixture(context: TestContext) {
            host.reset();
            const result = await host.fixture(context);
            const date = DateUtils.getDateStringDaysAgo(1);
            const { pathManager, readManager } = result.internals;
            await mkdir(pathManager.getDateFolderPath(date), { recursive: true });
            const rows = [8, 9, 10].map(hour => record(date, hour));
            for (const row of rows) {
                await writeFile(
                    pathManager.getLogPathFromDate(new Date(row.timestamp)).fullPath,
                    JSON.stringify(row) + '\n',
                    { flag: 'wx' }
                );
            }
            const reads: number[] = [];
            const read = readManager.readHourLogs.bind(readManager);
            context.mock.method(readManager, 'readHourLogs', async (day: string, hour: number, strict?: boolean) => {
                reads.push(hour);
                return read(day, hour, strict);
            });
            async function warm() {
                assert.equal((await result.fileLogger.getRequestDetails(date)).length, 3);
                reads.length = 0;
                await result.fileLogger.getRequestDetails(date);
                assert.deepEqual(reads, []);
            }
            return { ...result, date, rows, reads, warm };
        }

        for (const kind of ['estimated', 'completed', 'cancelled', 'failed', 'title'] as const) {
            for (const sameMtime of [false, true]) {
                await suite.test(
                    `${kind} invalidates only the written hour, same mtime=${sameMtime}`,
                    async context => {
                        const f = await fixture(context);
                        const target = f.rows[1];
                        if (kind !== 'estimated' && kind !== 'title') {
                            await f.fileLogger.recordEstimatedTokens(target);
                            context.mock.method(Date, 'now', () => target.timestamp + 1000);
                        }
                        await f.warm();
                        const source = f.internals.pathManager.getHourFilePath(f.date, 9);
                        const originalStat = await stat(source);
                        if (sameMtime) {
                            const append = f.internals.writeManager.appendLog.bind(f.internals.writeManager);
                            context.mock.method(f.internals.writeManager, 'appendLog', async (log: TokenRequestLog) => {
                                const result = await append(log);
                                await utimes(source, originalStat.atime, originalStat.mtime);
                                return result;
                            });
                        }
                        const snapshotInvalidation = context.mock.method(
                            f.internals.snapshotManager,
                            'invalidateCache'
                        );
                        if (kind === 'estimated') {
                            await f.fileLogger.recordEstimatedTokens({
                                ...target,
                                requestId: `${target.timestamp}_new`
                            });
                        } else if (kind === 'title') {
                            assert.equal(
                                await f.fileLogger.backfillSessionTitle({
                                    requestId: target.requestId,
                                    sessionId: 'session',
                                    sessionTitle: '更新标题'
                                }),
                                true
                            );
                        } else {
                            await f.fileLogger.updateActualTokens({
                                requestId: target.requestId,
                                status: kind,
                                rawUsage: { prompt_tokens: 10, completion_tokens: 7 }
                            });
                        }
                        f.reads.length = 0;
                        const details = await f.fileLogger.getRequestDetails(f.date);
                        assert.deepEqual(f.reads, [9]);
                        assert.equal(details.length, kind === 'estimated' ? 4 : 3);
                        const saved = details.find(
                            row =>
                                row.requestId === (kind === 'estimated' ? `${target.timestamp}_new` : target.requestId)
                        );
                        assert.ok(saved);
                        if (kind === 'title') {
                            assert.equal(saved.sessionTitle, '更新标题');
                        } else {
                            assert.equal(saved.status, kind);
                        }
                        assert.equal(
                            snapshotInvalidation.mock.calls.some(call => call.arguments[0] === f.date),
                            true
                        );
                        const cache = f.internals.readManager as unknown as { cachedHourDetailsRecords: number };
                        assert.equal(cache.cachedHourDetailsRecords, details.length);
                    }
                );
            }
        }

        await suite.test(
            'terminal write in a later hour preserves the earlier hour and merged start time',
            async context => {
                const f = await fixture(context);
                const start = f.rows[1];
                await f.fileLogger.recordEstimatedTokens(start);
                await f.warm();
                context.mock.method(Date, 'now', () => f.rows[2].timestamp + 1000);
                await f.fileLogger.updateActualTokens({
                    requestId: start.requestId,
                    status: 'completed',
                    rawUsage: { completion_tokens: 9 }
                });
                const details = await f.fileLogger.getRequestDetails(f.date);
                assert.deepEqual(f.reads, [10]);
                assert.equal(details.find(row => row.requestId === start.requestId)?.timestamp, start.timestamp);
                assert.equal(details.find(row => row.requestId === start.requestId)?.rawUsage?.completion_tokens, 9);
            }
        );

        await suite.test('same-millisecond terminal rollover invalidates only next-day midnight', async context => {
            const f = await fixture(context);
            const previousDate = f.date;
            const start = new Date(`${previousDate}T23:59:59.999`).getTime();
            const nextDate = DateUtils.formatDate(new Date(start + 1));
            for (const [date, hours] of [
                [previousDate, [22, 23]],
                [nextDate, [0, 1]]
            ] as const) {
                await mkdir(f.internals.pathManager.getDateFolderPath(date), { recursive: true });
                for (const hour of hours) {
                    const row = record(date, hour);
                    await writeFile(f.internals.pathManager.getHourFilePath(date, hour), JSON.stringify(row) + '\n', {
                        flag: 'wx'
                    });
                }
            }
            const pending = { ...record(previousDate, 23), requestId: `${start}_rollover`, timestamp: start };
            await f.fileLogger.recordEstimatedTokens(pending);
            await f.internals.readManager.getRequestDetails(previousDate);
            await f.internals.readManager.getRequestDetails(nextDate);
            f.reads.length = 0;
            context.mock.method(Date, 'now', () => start);
            await f.fileLogger.updateActualTokens({ requestId: pending.requestId, status: 'completed' });
            await f.internals.readManager.getRequestDetails(previousDate);
            const nextRows = await f.internals.readManager.getRequestDetails(nextDate);
            assert.deepEqual(f.reads, [0]);
            assert.equal(nextRows.find(row => row.requestId === pending.requestId)?.timestamp, start + 1);
        });

        await suite.test(
            'in-flight timestamp mutation invalidates the actual path of each queued write',
            async context => {
                const f = await fixture(context);
                await f.warm();
                const firstStarted = gate();
                const secondStarted = gate();
                const releaseFirst = gate();
                const releaseSecond = gate();
                const ensure = f.internals.pathManager.ensureDirectoryExists.bind(f.internals.pathManager);
                let calls = 0;
                context.mock.method(f.internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                    await ensure(folder);
                    if (++calls === 1) {
                        firstStarted.release();
                        await releaseFirst.promise;
                    } else if (calls === 2) {
                        secondStarted.release();
                        await releaseSecond.promise;
                    }
                });
                const pending = { ...record(f.date, 9, 'mutable'), timestamp: f.rows[1].timestamp + 3599_000 };
                const estimated = f.fileLogger.recordEstimatedTokens(pending);
                let terminal: Promise<void> | undefined;
                try {
                    await firstStarted.promise;
                    context.mock.method(Date, 'now', () => f.rows[2].timestamp + 1000);
                    terminal = f.fileLogger.updateActualTokens({ requestId: pending.requestId, status: 'completed' });
                    releaseFirst.release();
                    await estimated;
                    await secondStarted.promise;
                    await f.fileLogger.getRequestDetails(f.date);
                    assert.deepEqual(f.reads, [9]);
                    f.reads.length = 0;
                    releaseSecond.release();
                    await terminal;
                    await f.fileLogger.getRequestDetails(f.date);
                    assert.deepEqual(f.reads, [10]);
                } finally {
                    releaseFirst.release();
                    releaseSecond.release();
                    await Promise.allSettled([estimated, ...(terminal ? [terminal] : [])]);
                }
            }
        );

        for (const phase of ['hour-read', 'directory-list'] as const) {
            await suite.test(`local invalidation rejects late cache insertion during ${phase}`, async context => {
                const f = await fixture(context);
                await f.warm();
                const source = f.internals.pathManager.getHourFilePath(f.date, 9);
                const changed = record(f.date, 9, 'external');
                await appendFile(source, JSON.stringify(changed) + '\n');
                const modified = (await stat(source)).mtimeMs;
                await utimes(source, new Date(modified + 2000), new Date(modified + 2000));
                const entered = gate();
                const release = gate();
                if (phase === 'hour-read') {
                    const read = f.internals.readManager.readHourLogs.bind(f.internals.readManager);
                    let gated = false;
                    context.mock.method(
                        f.internals.readManager,
                        'readHourLogs',
                        async (date: string, hour: number, strict?: boolean) => {
                            const rows = await read(date, hour, strict);
                            if (hour === 9 && !gated) {
                                gated = true;
                                entered.release();
                                await release.promise;
                            }
                            return rows;
                        }
                    );
                } else {
                    const reader = f.internals.readManager as unknown as {
                        listHourFiles(folder: string): Promise<string[]>;
                    };
                    const list = reader.listHourFiles.bind(reader);
                    let gated = false;
                    context.mock.method(reader, 'listHourFiles', async (folder: string) => {
                        const files = await list(folder);
                        if (!gated) {
                            gated = true;
                            entered.release();
                            await release.promise;
                        }
                        return files;
                    });
                }
                const reading = f.fileLogger.getRequestDetails(f.date);
                try {
                    await entered.promise;
                    await f.fileLogger.recordEstimatedTokens(record(f.date, 9, 'local'));
                    release.release();
                    await reading;
                    const reader = f.internals.readManager as unknown as { hourDetailsCache: Map<string, unknown> };
                    assert.equal(reader.hourDetailsCache.has(`${f.date}:9`), false);
                    f.reads.length = 0;
                    const latest = await f.fileLogger.getRequestDetails(f.date);
                    assert.deepEqual(f.reads, [9]);
                    assert.equal(
                        latest.some(row => row.requestId.endsWith('_local')),
                        true
                    );
                } finally {
                    release.release();
                    await reading;
                }
            });
        }

        await suite.test('failed append does not invalidate successful hourly caches', async context => {
            const f = await fixture(context);
            await f.warm();
            context.mock.method(f.internals.writeManager, 'appendLog', async () => {
                throw new Error('write failed');
            });
            await assert.rejects(f.fileLogger.recordEstimatedTokens(record(f.date, 9, 'failed-write')), /write failed/);
            await f.fileLogger.getRequestDetails(f.date);
            assert.deepEqual(f.reads, []);
        });

        await suite.test('unknown-hour invalidation still clears all hours and the date snapshot', async context => {
            const f = await fixture(context);
            await f.warm();
            const snapshot = context.mock.method(f.internals.snapshotManager, 'invalidateCache');
            f.fileLogger.invalidateDetailCaches(f.date);
            await f.fileLogger.getRequestDetails(f.date);
            assert.deepEqual(
                [...f.reads].sort((a, b) => a - b),
                [8, 9, 10]
            );
            assert.equal(snapshot.mock.calls[0].arguments[0], f.date);
        });

        await suite.test(
            'snapshot title backfill keeps full-date invalidation and persists the title',
            async context => {
                host.reset();
                const f = await host.fixture(context);
                const date = DateUtils.getDateStringDaysAgo(7);
                const row = record(date, 9);
                await f.internals.snapshotManager.buildSnapshotFromLogs(date, [row]);
                await f.fileLogger.getRequestDetails(date);
                const invalidate = context.mock.method(f.internals.readManager, 'invalidateDateCache');
                assert.equal(
                    await f.fileLogger.backfillSessionTitle({
                        requestId: row.requestId,
                        sessionId: 'snapshot-session',
                        sessionTitle: '历史标题'
                    }),
                    true
                );
                assert.equal((await f.fileLogger.getRequestDetails(date))[0].sessionTitle, '历史标题');
                assert.equal(
                    invalidate.mock.calls.some(call => call.arguments[0] === date),
                    true
                );
            }
        );
    } finally {
        host.restore();
    }
});
