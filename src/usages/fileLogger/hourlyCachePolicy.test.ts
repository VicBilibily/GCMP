import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { canReuseHourlyDetailsCache, canReuseHourlyStatsCache } from './hourlyCachePolicy';
import { DateUtils } from './dateUtils';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

function createRequestLog(requestId: string): TokenRequestLog {
    return {
        requestId,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 1,
        rawUsage: null,
        status: 'completed'
    };
}

function mockLoggerHost(): () => void {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/leaderElectionService')) {
            return { LeaderElectionService: { getLeaderId: () => 'self', getInstanceId: () => 'self' } };
        }
        if (id.endsWith('/interInstance')) {
            return { InterInstanceBus: { subscribe: () => ({ dispose() {} }) } };
        }
        if (id.endsWith('/liveMetrics')) {
            return { onLiveMetrics: () => ({ dispose() {} }) };
        }
        return originalRequire.call(this, id);
    };
    return () => {
        NodeModule.prototype.require = originalRequire;
    };
}

test('hourly stats cache is reused when version is compatible and source mtime is unchanged', () => {
    assert.equal(
        canReuseHourlyStatsCache({
            cachedModifiedTime: 200,
            sourceModifiedTime: 200,
            isVersionCompatible: true
        }),
        true
    );

    assert.equal(
        canReuseHourlyStatsCache({
            cachedModifiedTime: 220,
            sourceModifiedTime: 200,
            isVersionCompatible: true
        }),
        true
    );
});

test('hourly stats cache is not reused when version is incompatible', () => {
    assert.equal(
        canReuseHourlyStatsCache({
            cachedModifiedTime: 220,
            sourceModifiedTime: 200,
            isVersionCompatible: false
        }),
        false
    );
});

test('hourly stats cache is not reused when cache mtime is older or missing', () => {
    assert.equal(
        canReuseHourlyStatsCache({
            cachedModifiedTime: 199,
            sourceModifiedTime: 200,
            isVersionCompatible: true
        }),
        false
    );

    assert.equal(
        canReuseHourlyStatsCache({
            sourceModifiedTime: 200,
            isVersionCompatible: true
        }),
        false
    );
});

test('hourly details cache requires exact mtime match', () => {
    assert.equal(canReuseHourlyDetailsCache(123, 123), true);
    assert.equal(canReuseHourlyDetailsCache(124, 123), false);
    assert.equal(canReuseHourlyDetailsCache(undefined, 123), false);
});

test('hour details cache stays bounded and supports date/lifecycle invalidation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-hour-details-'));
    const originalRequire = NodeModule.prototype.require;

    try {
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return { window: {} };
            }
            return originalRequire.call(this, id);
        };

        const { LogReadManager } = await import('./logReadManager');
        const pathManager = {
            getDateFolderPath: (dateStr: string) => join(dir, dateStr),
            getHourFilePath: (dateStr: string, hour: number) =>
                join(dir, dateStr, `${String(hour).padStart(2, '0')}.jsonl`)
        };
        const manager = new LogReadManager(pathManager as never);

        for (let index = 1; index <= 49; index++) {
            const dateStr = `2026-09-${String(index).padStart(2, '0')}`;
            const dateFolder = join(dir, dateStr);
            await mkdir(dateFolder, { recursive: true });
            await writeFile(
                join(dateFolder, '00.jsonl'),
                `${JSON.stringify({ requestId: `request-${index}`, timestamp: index, status: 'completed' })}\n`,
                'utf8'
            );
            await manager.getRequestDetails(dateStr);
        }

        const cache = (manager as unknown as { hourDetailsCache: Map<string, unknown> }).hourDetailsCache;
        assert.equal(cache.size, 48);
        assert.equal(cache.has('2026-09-01:0'), false);
        assert.equal(cache.has('2026-09-49:0'), true);

        const recomputedDate = '2026-09-02';
        const recomputedFile = join(dir, recomputedDate, '00.jsonl');
        await utimes(recomputedFile, new Date(), new Date(Date.now() + 60_000));
        await manager.getRequestDetails(recomputedDate);
        await mkdir(join(dir, '2026-09-50'));
        await writeFile(join(dir, '2026-09-50', '00.jsonl'), '{"requestId":"new","timestamp":50}\n');
        await manager.getRequestDetails('2026-09-50');
        assert.equal(cache.has('2026-09-02:0'), true);
        assert.equal(cache.has('2026-09-03:0'), false);

        manager.invalidateDateCache('2026-09-49');
        assert.equal(cache.has('2026-09-49:0'), false);

        manager.clearCache();
        assert.equal(cache.size, 0);

        const raceDate = '2026-10-01';
        const raceFolder = join(dir, raceDate);
        await mkdir(raceFolder, { recursive: true });
        await writeFile(join(raceFolder, '00.jsonl'), '\n', 'utf8');

        let releaseRead!: () => void;
        let signalReadStarted!: () => void;
        const readStarted = new Promise<void>(resolve => {
            signalReadStarted = resolve;
        });
        const readManager = manager as unknown as {
            readHourLogs: typeof manager.readHourLogs;
            listHourFiles: (folder: string) => Promise<string[]>;
        };
        const originalReadHourLogs = manager.readHourLogs.bind(manager);
        readManager.readHourLogs = async () => {
            signalReadStarted();
            await new Promise<void>(resolve => {
                releaseRead = resolve;
            });
            return [
                {
                    requestId: 'race-request',
                    timestamp: 1,
                    isoTime: new Date(1).toISOString(),
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 0,
                    rawUsage: null,
                    status: 'completed'
                }
            ];
        };

        const pendingRead = manager.getRequestDetails(raceDate);
        await readStarted;
        manager.clearCache();
        releaseRead();
        await pendingRead;
        assert.equal(cache.size, 0);
        readManager.readHourLogs = originalReadHourLogs;

        const scanDate = '2026-10-02';
        const scanFolder = join(dir, scanDate);
        await mkdir(scanFolder);
        await writeFile(join(scanFolder, '00.jsonl'), '{"requestId":"scan","timestamp":2}\n');
        let releaseScan!: () => void;
        let signalScanStarted!: () => void;
        const scanStarted = new Promise<void>(resolve => {
            signalScanStarted = resolve;
        });
        const originalListHourFiles = readManager.listHourFiles.bind(manager);
        readManager.listHourFiles = async folder => {
            if (folder === scanFolder) {
                signalScanStarted();
                await new Promise<void>(resolve => {
                    releaseScan = resolve;
                });
            }
            return originalListHourFiles(folder);
        };
        const pendingScan = manager.getRequestDetails(scanDate);
        await scanStarted;
        manager.clearCache();
        releaseScan();
        await pendingScan;
        assert.equal(cache.size, 0);
        readManager.listHourFiles = originalListHourFiles;

        const missingDate = '2026-10-03';
        const missingFolder = join(dir, missingDate);
        const missingFile = join(missingFolder, '00.jsonl');
        await mkdir(missingFolder);
        await writeFile(missingFile, '{"requestId":"missing","timestamp":3}\n');
        readManager.listHourFiles = async folder => {
            const files = await originalListHourFiles(folder);
            if (folder === missingFolder) {
                await rename(missingFile, `${missingFile}.off`);
            }
            return files;
        };
        await assert.rejects(manager.getRequestDetails(missingDate), /Hourly log disappeared before reading/);
        readManager.listHourFiles = originalListHourFiles;

        manager.dispose();
        assert.equal((await manager.getRequestDetails(scanDate)).length, 1);
        assert.equal(cache.size, 0);
    } finally {
        NodeModule.prototype.require = originalRequire;
        await rm(dir, { recursive: true, force: true });
    }
});

test('hour details cache enforces a total record budget and bounds cold-read concurrency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-hour-details-budget-'));
    const restoreHost = mockLoggerHost();
    try {
        const { LogReadManager } = await import('./logReadManager');
        const limits = LogReadManager as unknown as {
            MAX_HOUR_DETAILS_CACHE_RECORDS: number;
        };
        const originalRecordLimit = limits.MAX_HOUR_DETAILS_CACHE_RECORDS;
        limits.MAX_HOUR_DETAILS_CACHE_RECORDS = 5;
        try {
            const pathManager = {
                getDateFolderPath: (dateStr: string) => join(dir, dateStr),
                getHourFilePath: (dateStr: string, hour: number) =>
                    join(dir, dateStr, `${String(hour).padStart(2, '0')}.jsonl`)
            };
            const manager = new LogReadManager(pathManager as never);
            for (const [date, prefix] of [
                ['2026-09-23', 'first'],
                ['2026-09-24', 'second']
            ] as const) {
                const folder = pathManager.getDateFolderPath(date);
                await mkdir(folder, { recursive: true });
                await writeFile(
                    pathManager.getHourFilePath(date, 0),
                    Array.from({ length: 3 }, (_, index) =>
                        JSON.stringify(createRequestLog(`${prefix}-${index}`))
                    ).join('\n') + '\n'
                );
                assert.equal((await manager.getRequestDetails(date)).length, 3);
            }

            const internals = manager as unknown as {
                hourDetailsCache: Map<string, { details: TokenRequestLog[] }>;
                cachedHourDetailsRecords: number;
                readHourLogs: typeof manager.readHourLogs;
            };
            assert.equal(internals.hourDetailsCache.has('2026-09-23:0'), false);
            assert.equal(internals.hourDetailsCache.has('2026-09-24:0'), true);
            assert.equal(internals.cachedHourDetailsRecords, 3);

            manager.clearCache();
            const concurrencyDate = '2026-09-22';
            const concurrencyFolder = pathManager.getDateFolderPath(concurrencyDate);
            await mkdir(concurrencyFolder, { recursive: true });
            for (let hour = 0; hour < 8; hour++) {
                await writeFile(pathManager.getHourFilePath(concurrencyDate, hour), '\n');
            }
            let activeReads = 0;
            let maxActiveReads = 0;
            internals.readHourLogs = async (_date, hour) => {
                activeReads += 1;
                maxActiveReads = Math.max(maxActiveReads, activeReads);
                await new Promise<void>(resolve => setImmediate(resolve));
                activeReads -= 1;
                return [createRequestLog(`concurrent-${hour}`)];
            };
            assert.equal((await manager.getRequestDetails(concurrencyDate)).length, 8);
            assert.equal(maxActiveReads, 4);
        } finally {
            limits.MAX_HOUR_DETAILS_CACHE_RECORDS = originalRecordLimit;
        }
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('session title backfill preserves cross-hour final state without populating the details cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-title-backfill-hour-'));
    const restoreHost = mockLoggerHost();
    try {
        const { TokenFileLogger } = await import('./index');
        const { StatsCalculator } = await import('./statsCalculator');
        const date = DateUtils.getTodayDateString();
        const timestamp = new Date(`${date}T05:59:00`).getTime();
        const requestId = `${timestamp}_target`;
        const folder = join(dir, 'usages', date);
        await mkdir(folder, { recursive: true });
        const estimated = {
            ...createRequestLog(requestId),
            timestamp,
            isoTime: new Date(timestamp).toISOString(),
            status: 'estimated' as const
        };
        const completed = {
            ...estimated,
            timestamp: timestamp + 2 * 60_000,
            isoTime: new Date(timestamp + 2 * 60_000).toISOString(),
            status: 'completed' as const,
            rawUsage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        };
        await writeFile(join(folder, '05.jsonl'), `${JSON.stringify(estimated)}\n`);
        await writeFile(join(folder, '06.jsonl'), `${JSON.stringify(completed)}\n`);

        const logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const internals = logger as unknown as {
            readManager: {
                hourDetailsCache: Map<string, unknown>;
                getRequestDetails: () => Promise<TokenRequestLog[]>;
            };
        };
        internals.readManager.getRequestDetails = async () => {
            throw new Error('full-day read should not run');
        };

        assert.equal(
            await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: 'Recovered title' }),
            true
        );
        assert.equal(internals.readManager.hourDetailsCache.size, 0);
        const merged = StatsCalculator.mergeLogsByRequestId(await logger.readDateLogs(date)).get(requestId);
        assert.equal(merged?.status, 'completed');
        assert.equal(merged?.rawUsage?.total_tokens, 12);
        assert.equal(merged?.sessionTitle, 'Recovered title');
        await logger.dispose();
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical snapshot cache stays within entry and record budgets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-snapshot-cache-budget-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const limits = SnapshotManager as unknown as {
            MAX_RECORD_CACHE_ENTRIES: number;
            MAX_RECORD_CACHE_RECORDS: number;
        };
        const originalEntryLimit = limits.MAX_RECORD_CACHE_ENTRIES;
        const originalRecordLimit = limits.MAX_RECORD_CACHE_RECORDS;
        limits.MAX_RECORD_CACHE_ENTRIES = 2;
        limits.MAX_RECORD_CACHE_RECORDS = 3;
        try {
            const manager = new SnapshotManager(new LogPathManager(dir), () => {});
            for (const [date, count] of [
                ['2026-09-20', 1],
                ['2026-09-21', 1],
                ['2026-09-22', 2]
            ] as const) {
                const logs = Array.from({ length: count }, (_, index) => createRequestLog(`${date}-${index}`));
                await manager.buildSnapshotFromLogs(date, logs);
                assert.equal((await manager.read(date))?.length, count);
            }

            const internals = manager as unknown as {
                recordCache: Map<string, unknown>;
                cachedSnapshotRecords: number;
                readFile: (filePath: string) => Promise<Record<string, unknown>>;
            };
            assert.equal(internals.recordCache.has('snapshot:2026-09-20'), false);
            assert.equal(internals.recordCache.has('snapshot:2026-09-21'), true);
            assert.equal(internals.recordCache.has('snapshot:2026-09-22'), true);
            assert.equal(internals.recordCache.size, 2);
            assert.equal(internals.cachedSnapshotRecords, 3);
            manager.clearCache();
            assert.equal(internals.cachedSnapshotRecords, 0);

            const raceDate = '2026-09-23';
            await manager.buildSnapshotFromLogs(raceDate, [createRequestLog('snapshot-race')]);
            manager.clearCache();
            const originalReadFile = internals.readFile.bind(manager);
            let signalReadStarted!: () => void;
            let releaseRead!: () => void;
            const readStarted = new Promise<void>(resolve => {
                signalReadStarted = resolve;
            });
            internals.readFile = async filePath => {
                signalReadStarted();
                await new Promise<void>(resolve => {
                    releaseRead = resolve;
                });
                return originalReadFile(filePath);
            };
            const pendingRead = manager.read(raceDate);
            await readStarted;
            manager.clearCache();
            releaseRead();
            assert.equal((await pendingRead)?.length, 1);
            assert.equal(internals.recordCache.size, 0);
            assert.equal(internals.cachedSnapshotRecords, 0);
        } finally {
            limits.MAX_RECORD_CACHE_ENTRIES = originalEntryLimit;
            limits.MAX_RECORD_CACHE_RECORDS = originalRecordLimit;
        }
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('date detail invalidation clears hourly and snapshot caches together', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-date-detail-invalidation-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const today = DateUtils.getTodayDateString();
        const historicalDate = DateUtils.getDateStringDaysAgo(3);
        const todayFolder = join(dir, 'usages', today);
        await mkdir(todayFolder, { recursive: true });
        await writeFile(join(todayFolder, '00.jsonl'), `${JSON.stringify(createRequestLog('today-cache'))}\n`);

        const internals = logger as unknown as {
            readManager: { hourDetailsCache: Map<string, unknown> };
            snapshotManager: {
                recordCache: Map<string, unknown>;
                buildSnapshotFromLogs: (date: string, logs: TokenRequestLog[]) => Promise<void>;
            };
            invalidateDetailCaches?: (date: string) => void;
        };
        await logger.getRequestDetails(today);
        await internals.snapshotManager.buildSnapshotFromLogs(historicalDate, [createRequestLog('snapshot-cache')]);
        await logger.getRequestDetails(historicalDate);
        assert.equal(internals.readManager.hourDetailsCache.has(`${today}:0`), true);
        assert.equal(internals.snapshotManager.recordCache.has(`snapshot:${historicalDate}`), true);
        assert.equal(typeof internals.invalidateDetailCaches, 'function');

        internals.invalidateDetailCaches?.(today);
        internals.invalidateDetailCaches?.(historicalDate);
        assert.equal(internals.readManager.hourDetailsCache.has(`${today}:0`), false);
        assert.equal(internals.snapshotManager.recordCache.has(`snapshot:${historicalDate}`), false);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('transient hourly read failure is retried rather than cached as an empty result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-hour-read-failure-'));
    const originalRequire = NodeModule.prototype.require;
    try {
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return { window: {} };
            }
            return originalRequire.call(this, id);
        };
        const { LogReadManager } = await import('./logReadManager');
        const { LogPathManager } = await import('./logPathManager');
        const { LogStatsManager } = await import('./logStatsManager');
        const pathManager = new LogPathManager(dir);
        const date = DateUtils.getTodayDateString();
        const hour = 0;
        const folder = pathManager.getDateFolderPath(date);
        const hourFile = pathManager.getHourFilePath(date, hour);
        await mkdir(folder, { recursive: true });
        await writeFile(
            hourFile,
            `${JSON.stringify({ requestId: 'retry', timestamp: Date.now(), status: 'completed', providerKey: 'test', modelId: 'test', estimatedInput: 1, rawUsage: null })}\n`
        );
        const reader = new LogReadManager(pathManager);
        const originalReadHourLogs = reader.readHourLogs.bind(reader);
        let failNext = true;
        reader.readHourLogs = async (requestedDate, requestedHour, strict = false) => {
            if (failNext) {
                failNext = false;
                if (strict) {
                    throw new Error('Injected transient read failure');
                }
                return [];
            }
            return originalReadHourLogs(requestedDate, requestedHour);
        };

        await assert.rejects(reader.getRequestDetails(date), /Injected transient read failure/);
        assert.equal((await reader.getRequestDetails(date)).length, 1);

        reader.clearCache();
        failNext = true;
        const statsManager = new LogStatsManager(
            reader,
            dir,
            { updateIndex: async () => {}, repairIfNeeded: async () => {} } as never,
            { read: async () => null } as never
        );
        statsManager.updateCodeVersionTimestamp(1);
        await assert.rejects(statsManager.getDateStats(date, true), /Injected transient read failure/);
        await assert.rejects(stat(join(folder, 'stats.json')), { code: 'ENOENT' });
        assert.equal((await statsManager.getDateStats(date, true)).total.requests, 1);

        const hourFileStat = await stat(hourFile);
        await writeFile(
            hourFile,
            `${await readFile(hourFile, 'utf8')}${JSON.stringify({ requestId: 'second', timestamp: Date.now(), status: 'completed', providerKey: 'test', modelId: 'test', estimatedInput: 1, rawUsage: null })}\n`
        );
        await utimes(hourFile, hourFileStat.atime, hourFileStat.mtime);
        assert.equal((await statsManager.getDateStats(date, true)).total.requests, 2);
    } finally {
        NodeModule.prototype.require = originalRequire;
        await rm(dir, { recursive: true, force: true });
    }
});

test('request completion refresh only reads changed hours and still permits explicit full recomputation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-completion-refresh-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const internals = logger as unknown as {
            readManager: import('./logReadManager').LogReadManager;
            doRefreshCurrentStats(): Promise<void>;
        };
        const date = DateUtils.getTodayDateString();
        const folder = join(dir, 'usages', date);
        await mkdir(folder, { recursive: true });
        const oldTime = new Date(Date.now() - 60_000);
        for (let hour = 0; hour < 6; hour++) {
            const file = join(folder, `${String(hour).padStart(2, '0')}.jsonl`);
            await writeFile(file, `${JSON.stringify(createRequestLog(`hour-${hour}`))}\n`);
            await utimes(file, oldTime, oldTime);
        }
        assert.equal((await logger.getDateStats(date, true)).total.requests, 6);
        const readHours: number[] = [];
        const readHourLogs = internals.readManager.readHourLogs.bind(internals.readManager);
        internals.readManager.readHourLogs = async (requestedDate, hour, strict) => {
            readHours.push(hour);
            return readHourLogs(requestedDate, hour, strict);
        };
        const changedFile = join(folder, '05.jsonl');
        await writeFile(
            changedFile,
            `${await readFile(changedFile, 'utf8')}${JSON.stringify(createRequestLog('new-request'))}\n`
        );
        const changedTime = new Date(Date.now() + 60_000);
        await utimes(changedFile, changedTime, changedTime);

        await internals.doRefreshCurrentStats();
        assert.deepEqual(readHours, [5]);
        assert.equal((await logger.getDateStats(date)).total.requests, 7);
        readHours.length = 0;
        await internals.doRefreshCurrentStats();
        assert.deepEqual(readHours, []);
        assert.equal((await logger.getDateStats(date, true)).total.requests, 7);
        assert.deepEqual(readHours, [0, 1, 2, 3, 4, 5]);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const lateWrite of ['append', 'new-hour'] as const) {
    test(`completion refresh detects ${lateWrite} after hourly reading but before stats saving`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-late-hour-write-'));
        const restoreHost = mockLoggerHost();
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                readManager: import('./logReadManager').LogReadManager;
                doRefreshCurrentStats(): Promise<void>;
            };
            const date = DateUtils.getTodayDateString();
            const folder = join(dir, 'usages', date);
            const statsFile = join(folder, 'stats.json');
            const firstChangeFile = join(folder, '01.jsonl');
            const lateChangeHour = lateWrite === 'append' ? 1 : 2;
            const lateChangeFile = join(folder, `${String(lateChangeHour).padStart(2, '0')}.jsonl`);
            await mkdir(folder, { recursive: true });
            const baseTime = Date.now() - 60_000;
            for (let hour = 0; hour < 2; hour++) {
                const file = join(folder, `${String(hour).padStart(2, '0')}.jsonl`);
                await writeFile(file, `${JSON.stringify(createRequestLog(`initial-${hour}`))}\n`);
                await utimes(file, new Date(baseTime), new Date(baseTime));
            }
            assert.equal((await logger.getDateStats(date, true)).total.requests, 2);
            await utimes(statsFile, new Date(baseTime + 10_000), new Date(baseTime + 10_000));
            await writeFile(
                firstChangeFile,
                `${await readFile(firstChangeFile, 'utf8')}${JSON.stringify(createRequestLog('first-change'))}\n`
            );
            await utimes(firstChangeFile, new Date(baseTime + 20_000), new Date(baseTime + 20_000));

            const readHours: number[] = [];
            let injected = false;
            const readHourLogs = internals.readManager.readHourLogs.bind(internals.readManager);
            internals.readManager.readHourLogs = async (requestedDate, hour, strict) => {
                readHours.push(hour);
                const logs = await readHourLogs(requestedDate, hour, strict);
                if (!injected && hour === 1) {
                    injected = true;
                    const lateRecords = lateWrite === 'append' ? logs : [];
                    await writeFile(
                        lateChangeFile,
                        [...lateRecords, createRequestLog('late-change')].map(log => JSON.stringify(log)).join('\n') +
                            '\n'
                    );
                    await utimes(lateChangeFile, new Date(baseTime + 30_000), new Date(baseTime + 30_000));
                }
                return logs;
            };
            assert.equal((await logger.getDateStats(date)).total.requests, 3);
            assert.equal(injected, true);
            assert.deepEqual(readHours, [1]);
            assert.ok((await stat(statsFile)).mtimeMs > (await stat(lateChangeFile)).mtimeMs);

            readHours.length = 0;
            await internals.doRefreshCurrentStats();
            const refreshed = JSON.parse(await readFile(statsFile, 'utf8')) as TokenUsageStatsFromFile;
            assert.equal(refreshed.total.requests, 4);
            assert.deepEqual(readHours, [lateChangeHour]);
            const savedMtime = (await stat(statsFile)).mtimeMs;
            readHours.length = 0;
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.equal((await logger.getDateStats(date)).total.requests, 4);
            }
            await internals.doRefreshCurrentStats();
            assert.deepEqual(readHours, []);
            assert.equal((await stat(statsFile)).mtimeMs, savedMtime);
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
test('raw statistics without hourly source metadata are regenerated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-missing-hour-metadata-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const { readManager } = logger as unknown as { readManager: import('./logReadManager').LogReadManager };
        const date = DateUtils.getTodayDateString();
        const folder = join(dir, 'usages', date);
        await mkdir(folder, { recursive: true });
        const rawFile = join(folder, '00.jsonl');
        await writeFile(rawFile, `${JSON.stringify(createRequestLog('missing-metadata'))}\n`);
        const oldTime = new Date(Date.now() - 60_000);
        await utimes(rawFile, oldTime, oldTime);
        const initial = await logger.getDateStats(date, true);
        delete initial.hourly;
        await writeFile(join(folder, 'stats.json'), JSON.stringify(initial));
        const readHours: number[] = [];
        const readHourLogs = readManager.readHourLogs.bind(readManager);
        readManager.readHourLogs = async (...args) => {
            readHours.push(args[1]);
            return readHourLogs(...args);
        };
        const refreshed = await logger.getDateStats(date);
        assert.deepEqual(readHours, [0]);
        assert.equal(refreshed.total.requests, 1);
        assert.equal(refreshed.hourly?.['00'].modifiedTime, (await stat(rawFile)).mtimeMs);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot statistics retain their own freshness check when raw hourly files remain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-snapshot-stats-cache-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const { snapshotManager, readManager } = logger as unknown as {
            snapshotManager: import('./snapshotManager').SnapshotManager;
            readManager: import('./logReadManager').LogReadManager;
        };
        const date = DateUtils.getDateStringDaysAgo(2);
        const folder = join(dir, 'usages', date);
        const record = {
            ...createRequestLog('snapshot-record'),
            timestamp: new Date(`${date}T12:00:00`).getTime()
        };
        await mkdir(folder, { recursive: true });
        await snapshotManager.buildSnapshotFromLogs(date, [record]);
        const snapshotFile = join(folder, 'requests.jsonl');
        const rawFile = join(folder, '00.jsonl');
        await writeFile(rawFile, `${JSON.stringify(record)}\n`);
        const oldTime = new Date(Date.now() - 60_000);
        await utimes(snapshotFile, oldTime, oldTime);
        await utimes(rawFile, oldTime, oldTime);
        let snapshotReads = 0;
        const readSnapshot = snapshotManager.read.bind(snapshotManager);
        snapshotManager.read = async requestedDate => {
            snapshotReads++;
            return readSnapshot(requestedDate);
        };
        readManager.readHourLogs = async () => {
            throw new Error('Snapshot-backed stats must not read raw hours');
        };
        assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
        assert.equal((await logger.getDateStats(date)).total.requests, 1);
        assert.equal(snapshotReads, 1);

        await snapshotManager.upsertRecord(date, { ...record, requestId: 'second-snapshot-record' });
        const changedTime = new Date(Date.now() + 60_000);
        await utimes(snapshotFile, changedTime, changedTime);
        assert.equal((await logger.getDateStats(date)).total.requests, 2);
        assert.equal(snapshotReads, 2);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('concurrent forced refreshes queue one full recomputation after the ordinary refresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-forced-refresh-'));
    const restoreHost = mockLoggerHost();
    try {
        const { LogReadManager } = await import('./logReadManager');
        const { LogPathManager } = await import('./logPathManager');
        const { LogStatsManager } = await import('./logStatsManager');
        const paths = new LogPathManager(dir);
        const reader = new LogReadManager(paths);
        const stats = new LogStatsManager(
            reader,
            dir,
            { updateIndex: async () => {}, repairIfNeeded: async () => {} } as never,
            {
                read: async () => null
            } as never
        );
        const date = DateUtils.getTodayDateString();
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        const oldTime = new Date(Date.now() - 60_000);
        for (let hour = 0; hour < 2; hour++) {
            const file = paths.getHourFilePath(date, hour);
            await writeFile(file, `${JSON.stringify(createRequestLog(`old-${hour}`))}\n`);
            await utimes(file, oldTime, oldTime);
        }
        assert.equal((await stats.getDateStats(date, true)).total.requests, 2);
        for (let hour = 0; hour < 2; hour++) {
            const file = paths.getHourFilePath(date, hour);
            await writeFile(
                file,
                `${await readFile(file, 'utf8')}${JSON.stringify(createRequestLog(`new-${hour}`))}\n`
            );
            const mtime = hour === 0 ? oldTime : new Date(Date.now() + 60_000);
            await utimes(file, mtime, mtime);
        }

        let signalRead!: () => void;
        let releaseRead!: () => void;
        const started = new Promise<void>(resolve => {
            signalRead = resolve;
        });
        const blocked = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        const readHours: number[] = [];
        let activeReads = 0;
        let maxActiveReads = 0;
        const readHourLogs = reader.readHourLogs.bind(reader);
        reader.readHourLogs = async (...args) => {
            readHours.push(args[1]);
            activeReads++;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            try {
                if (readHours.length === 1) {
                    signalRead();
                    await blocked;
                }
                return await readHourLogs(...args);
            } finally {
                activeReads--;
            }
        };
        const ordinary = stats.getDateStats(date);
        await started;
        const forced = stats.getDateStats(date, true);
        const forcedAgain = stats.getDateStats(date, true);
        releaseRead();
        const [ordinaryResult, forcedResult, sharedResult] = await Promise.all([ordinary, forced, forcedAgain]);
        assert.equal(ordinaryResult.total.requests, 3);
        assert.equal(forcedResult.total.requests, 4);
        assert.equal(sharedResult, forcedResult);
        assert.deepEqual(readHours, [1, 0, 1]);
        assert.equal(maxActiveReads, 1);
        assert.equal((await stats.getDateStats(date, true)).total.requests, 4);
        assert.deepEqual(readHours, [1, 0, 1, 0, 1]);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('queued forced refresh retries even when the preceding ordinary refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-forced-retry-'));
    const restoreHost = mockLoggerHost();
    try {
        const { LogReadManager } = await import('./logReadManager');
        const { LogPathManager } = await import('./logPathManager');
        const { LogStatsManager } = await import('./logStatsManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getTodayDateString();
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getHourFilePath(date, 0), `${JSON.stringify(createRequestLog('retry'))}\n`);
        const reader = new LogReadManager(paths);
        const stats = new LogStatsManager(
            reader,
            dir,
            { updateIndex: async () => {}, repairIfNeeded: async () => {} } as never,
            {
                read: async () => null
            } as never
        );
        let signalRead!: () => void;
        let releaseRead!: () => void;
        const started = new Promise<void>(resolve => {
            signalRead = resolve;
        });
        const blocked = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        const readHourLogs = reader.readHourLogs.bind(reader);
        let reads = 0;
        reader.readHourLogs = async (...args) => {
            if (++reads === 1) {
                signalRead();
                await blocked;
                throw new Error('transient read failure');
            }
            return readHourLogs(...args);
        };
        const ordinary = assert.rejects(stats.getDateStats(date), /transient read failure/);
        await started;
        const forced = stats.getDateStats(date, true);
        releaseRead();
        const [, result] = await Promise.all([ordinary, forced]);
        assert.equal(result.total.requests, 1);
        assert.equal(reads, 2);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const corruption of ['{', 'null', 'missing-total', 'array-total'] as const) {
    test(`automatic regeneration repairs corrupt historical stats (${corruption})`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-corrupt-stats-'));
        const restoreHost = mockLoggerHost();
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const { readManager } = logger as unknown as {
                readManager: import('./logReadManager').LogReadManager;
            };
            const today = DateUtils.getTodayDateString();
            const history = DateUtils.getDateStringDaysAgo(3);
            for (const date of [today, history]) {
                const folder = join(dir, 'usages', date);
                await mkdir(folder, { recursive: true });
                await writeFile(join(folder, '00.jsonl'), `${JSON.stringify(createRequestLog(date))}\n`);
                assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
            }
            await logger.getIndex();
            const indexPath = join(dir, 'usages', 'index.json');
            const savedIndex = await readFile(indexPath, 'utf8');
            const statsPath = join(dir, 'usages', history, 'stats.json');
            const validStats = JSON.parse(await readFile(statsPath, 'utf8')) as TokenUsageStatsFromFile;
            const corruptContent =
                corruption === 'missing-total' ? JSON.stringify({ ...validStats, total: undefined })
                : corruption === 'array-total' ? JSON.stringify({ ...validStats, total: [] })
                : corruption;
            await writeFile(statsPath, corruptContent);
            await assert.rejects(logger.getIndex());

            const readHourLogs = readManager.readHourLogs.bind(readManager);
            let failRead = true;
            const rawReads: string[] = [];
            readManager.readHourLogs = async (...args) => {
                rawReads.push(args[0]);
                if (failRead && args[0] === history) {
                    throw new Error('Injected historical source read failure');
                }
                return readHourLogs(...args);
            };
            assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            assert.deepEqual(rawReads, [history]);
            assert.equal(await readFile(statsPath, 'utf8'), corruptContent);
            assert.equal(await readFile(indexPath, 'utf8'), savedIndex);
            assert.equal((await logger.getIndexFast())[today].total_requests, 1);

            failRead = false;
            const regenerated = await logger.regenerateOutdatedStats();
            assert.deepEqual(Object.keys(regenerated), [history]);
            assert.equal(regenerated[history].total.requests, 1);
            const recovered = await logger.getIndexFast();
            assert.equal(recovered[today].total_requests, 1);
            assert.equal(recovered[history].total_requests, 1);
            assert.equal((JSON.parse(await readFile(statsPath, 'utf8')) as TokenUsageStatsFromFile).total.requests, 1);
            assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            assert.deepEqual(rawReads, [history, history]);
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
for (const code of ['EBUSY', 'EACCES', 'ENOENT'] as const) {
    test(`snapshot read failure (${code}) cannot publish empty regenerated stats`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-snapshot-read-failure-'));
        const restoreHost = mockLoggerHost();
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const { snapshotManager } = logger as unknown as {
                snapshotManager: import('./snapshotManager').SnapshotManager;
            };
            const date = DateUtils.getDateStringDaysAgo(3);
            const record = { ...createRequestLog('snapshot-only'), timestamp: new Date(`${date}T12:00:00`).getTime() };
            await snapshotManager.buildSnapshotFromLogs(date, [record]);
            const folder = join(dir, 'usages', date);
            const snapshotPath = join(folder, 'requests.jsonl');
            const statsPath = join(folder, 'stats.json');
            const indexPath = join(dir, 'usages', 'index.json');
            const oldTime = new Date(Date.now() - 60_000);
            await utimes(snapshotPath, oldTime, oldTime);
            assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
            await logger.getIndex();
            const savedIndex = await readFile(indexPath, 'utf8');
            const source = await readFile(snapshotPath, 'utf8');
            const sourceMtime = (await stat(snapshotPath)).mtimeMs;
            await writeFile(statsPath, '{');
            snapshotManager.clearCache();

            const fs = require('fs/promises') as typeof import('node:fs/promises');
            const readSource = fs.readFile;
            let failRead = true;
            let sourceReads = 0;
            context.mock.method(fs, 'readFile', (...args: Parameters<typeof readSource>) => {
                if (args[0] === snapshotPath) {
                    sourceReads++;
                    if (failRead) {
                        return Promise.reject(Object.assign(new Error('Injected snapshot read failure'), { code }));
                    }
                }
                return readSource(...args);
            });
            const failedRegeneration = await logger.regenerateOutdatedStats();
            assert.equal(sourceReads, 1);
            assert.deepEqual(failedRegeneration, {});
            await assert.rejects(logger.getDateStats(date, true), { code });
            await assert.rejects(snapshotManager.upsertRecord(date, createRequestLog('must-not-overwrite')), { code });
            assert.equal(sourceReads, 3);
            assert.equal(await readFile(statsPath, 'utf8'), '{');
            assert.equal(await readFile(indexPath, 'utf8'), savedIndex);
            assert.equal(await readSource(snapshotPath, 'utf8'), source);
            assert.equal((await stat(snapshotPath)).mtimeMs, sourceMtime);

            failRead = false;
            const recovered = await logger.regenerateOutdatedStats();
            assert.deepEqual(Object.keys(recovered), [date]);
            assert.equal(recovered[date].total.requests, 1);
            assert.equal((await logger.getIndexFast())[date].total_requests, 1);
            assert.equal((await logger.getDateStats(date)).total.requests, 1);
            assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
            assert.deepEqual(await logger.regenerateOutdatedStats(), {});
            assert.equal(sourceReads, 4);
            assert.equal(await readSource(snapshotPath, 'utf8'), source);
            assert.equal((await stat(snapshotPath)).mtimeMs, sourceMtime);
        } finally {
            context.mock.restoreAll();
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
