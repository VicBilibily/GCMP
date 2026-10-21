import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LiveMetricsTracker } from '../../handlers/liveMetricsTracker';
import {
    cacheProviderRequestBalanceEntry,
    cacheRequestBalance,
    getCachedRequestBalance
} from '../../quota/requestBalance';
import type { LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import { DateUtils } from './dateUtils';
import { UsageParser } from './usageParser';
import type { RequestBalanceLog, TokenRequestLog } from './types';
import type { TokenFileLogger } from './index';
import type { LogPathManager } from './logPathManager';
import type { LogReadManager } from './logReadManager';
import type { SnapshotManager } from './snapshotManager';
import type {
    RequestClassificationMetadata,
    RequestContinuity
} from '../../handlers/classification/requestClassification';

const classification: RequestClassificationMetadata = {
    version: 1,
    requestOrigin: 'copilot-sdk',
    agentRole: 'undetermined',
    evidence: {
        origin: { level: 'signature', ruleId: 'sdk-identity' },
        purpose: { level: 'unknown' },
        role: { level: 'unknown' }
    }
};
const continuity: RequestContinuity = { version: 1, scope: 'chain', source: 'marker' };

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

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

test('request-start JSONL stores business data without presentation or cache metadata', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-start-compact-'));
    const restoreHost = mockLoggerHost();
    let logger: TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const internals = logger as unknown as { pathManager: LogPathManager; refreshCurrentStats(): void };
        context.mock.method(internals, 'refreshCurrentStats', () => {});
        const now = Date.now();
        const status = {
            provider: 'minimax-token' as const,
            data: {
                limits: [
                    {
                        label: 'saved window label',
                        limitType: 'weekly' as const,
                        remaining: 75,
                        remainMs: 3600000,
                        resetTime: now + 3600000
                    }
                ]
            },
            context: { language: 'en', locale: 'en-US', timeZone: 'UTC', title: 'saved title', icon: 'saved icon' }
        };
        cacheRequestBalance('minimax-token', 'compact-key', [], now, status);
        const entry = { id: 'minimax-token::compact-wallet', balance: 3, currency: 'USD' };
        cacheProviderRequestBalanceEntry('minimax-token', entry, now, {
            provider: 'compatible',
            data: {
                queryScope: 'provider',
                providerId: entry.id,
                providerName: 'Wallet',
                balanceInfo: entry,
                lastUpdated: new Date(now).toISOString()
            }
        });
        const balance = getCachedRequestBalance('minimax-token', 'compact-key');
        assert.ok(balance);
        assert.equal(balance.statusSnapshots?.length, 2);
        const legacyEntry = { id: 'legacy-only', balance: 7, currency: 'USD' };
        balance.entries.push(legacyEntry);
        const persistedBalance = { ...balance, entries: [legacyEntry] };
        await logger.recordEstimatedTokens({
            requestId: 'compact',
            providerKey: 'test',
            providerName: 'Test',
            modelId: 'test',
            modelName: 'Test',
            estimatedInput: 10
        });
        logger.recordRequestBalance('compact', balance);
        await logger.flush();
        await logger.updateActualTokens({ requestId: 'compact', status: 'completed' });
        await logger.flush();
        const text = await readFile(internals.pathManager.getLogPathFromDate(new Date()).fullPath, 'utf8');
        const rows = text
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as TokenRequestLog);
        assert.equal(rows.length, 3);
        assert.deepEqual(rows[1].balance, persistedBalance);
        assert.deepEqual(rows[2].balance, persistedBalance);
        assert.equal(balance.entries.length, 2);
        for (const field of [
            'context',
            'language',
            'locale',
            'timeZone',
            'icon',
            'lastUpdated',
            'queryScope',
            'label',
            'remainMs'
        ]) {
            assert.equal(text.includes(`"${field}":`), false, `Unexpected persisted field: ${field}`);
        }
        assert.equal(text.includes('compact-key'), false);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const { status, missingRetry } of (['completed', 'failed', 'cancelled'] as const).flatMap(status =>
    [false, true].map(missingRetry => ({ status, missingRetry }))
)) {
    test(`queued initial log and rapid retries compact correctly: ${status}, missing=${missingRetry}`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-start-rapid-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let initialWrite: Promise<void> | undefined;
        let terminal: Promise<void> | undefined;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let entered!: () => void;
        const writing = new Promise<void>(resolve => {
            entered = resolve;
        });
        try {
            const { TokenFileLogger } = await import('./index');
            const { SnapshotManager } = await import('./snapshotManager');
            const realNow = Date.now;
            const date = DateUtils.getDateStringDaysAgo(3);
            let now = new Date(`${date}T12:00:00`).getTime();
            context.mock.method(Date, 'now', () => now);
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                pathManager: LogPathManager;
                refreshCurrentStats(): void;
                updateStreamingMetrics(event: LiveStreamMetricEvent): void;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const ensure = internals.pathManager.ensureDirectoryExists.bind(internals.pathManager);
            let writes = 0;
            context.mock.method(internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                if (++writes === 1) {
                    entered();
                    await gate;
                }
                await ensure(folder);
            });
            const requestId = 'start-rapid';
            initialWrite = logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10
            });
            await writing;
            const first: RequestBalanceLog = {
                queriedAt: Date.now(),
                entries: [{ id: 'test', balance: 20, currency: 'USD' }]
            };
            const second: RequestBalanceLog | undefined =
                missingRetry ? undefined : (
                    { queriedAt: Date.now(), entries: [{ id: 'test', balance: 5, currency: 'USD' }] }
                );
            for (const [name, balance] of [
                ['First', first],
                ['Retry', second]
            ] as const) {
                internals.updateStreamingMetrics({
                    type: 'requestStarted',
                    requestId,
                    requestStartTime: Date.now(),
                    providerName: 'Test',
                    modelName: 'Test',
                    apiKeyHash: createHash('sha256').update(name).digest('hex'),
                    apiKeyName: name
                });
                logger.recordRequestBalance(requestId, balance);
            }
            const rawUsage = { prompt_tokens: 10, completion_tokens: 5 };
            terminal = logger.updateActualTokens({ requestId, status, rawUsage });
            release();
            await initialWrite;
            await terminal;
            await logger.flush();
            const rawPath = internals.pathManager.getLogPathFromDate(new Date(now)).fullPath;
            const text = await readFile(rawPath, 'utf8');
            const rows = text
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            assert.equal(rows.length, 4);
            assert.equal(rows[0].balance, undefined);
            assert.equal(rows[0].apiKeyName, undefined);
            assert.equal(rows[0].status, 'estimated');
            assert.deepEqual(rows[1].balance, first);
            assert.equal(rows[1].apiKeyName, 'First');
            assert.deepEqual(rows[2].balance, second ?? null);
            assert.equal(rows[2].apiKeyName, 'Retry');
            assert.deepEqual(rows[3].balance, second ?? null);
            assert.equal(rows[3].status, status);
            await logger.dispose();
            logger = undefined;
            now = realNow();
            const snapshot = new SnapshotManager(internals.pathManager, () => {});
            assert.equal(await snapshot.compactHistoricalDates(2), 1);
            await assert.rejects(readFile(rawPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
            const reopened = new SnapshotManager(internals.pathManager, () => {});
            const records = await reopened.read(date);
            assert.equal(records?.length, 1);
            const record = records?.[0];
            assert.equal(record?.status, status);
            assert.equal(record?.apiKeyName, 'Retry');
            assert.equal(record?.apiKeyHash, createHash('sha256').update('Retry').digest('hex'));
            assert.deepEqual(record?.balance, second ?? null);
            assert.deepEqual(record?.rawUsage, rawUsage);
            assert.equal(await reopened.compactHistoricalDates(2), 0);
        } finally {
            release();
            await initialWrite;
            await terminal;
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const drain of ['flush', 'dispose'] as const) {
    test(`${drain} persists accepted request-start balance behind an earlier log update`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-start-drain-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let draining: Promise<void> | undefined;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                pathManager: LogPathManager;
                refreshCurrentStats(): void;
                serializeRequestLogUpdate(requestId: string, operation: () => Promise<void>): Promise<void>;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const requestId = 'start-drain';
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10
            });
            const previousUpdate = internals.serializeRequestLogUpdate(requestId, () => gate);
            const balance: RequestBalanceLog = {
                queriedAt: Date.now(),
                entries: [{ id: 'test', balance: 20, currency: 'USD' }]
            };
            logger.recordRequestBalance(requestId, balance);
            let completed = false;
            draining = logger[drain]().then(() => {
                completed = true;
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(completed, false);
            release();
            await previousUpdate;
            await draining;
            if (drain === 'dispose') {
                logger = undefined;
            }
            const text = await readFile(internals.pathManager.getLogPathFromDate(new Date()).fullPath, 'utf8');
            const rows = text
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            assert.equal(rows.at(-1)?.status, 'estimated');
            assert.deepEqual(rows.at(-1)?.balance, balance);
        } finally {
            release();
            await draining;
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const failedWrite of [false, true]) {
    test(`terminal waits for request-start balance write without losing data: failure=${failedWrite}`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-start-order-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let terminal: Promise<void> | undefined;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let entered!: () => void;
        const writing = new Promise<void>(resolve => {
            entered = resolve;
        });
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as { pathManager: LogPathManager; refreshCurrentStats(): void };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const requestId = 'start-write-order';
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10
            });
            const ensure = internals.pathManager.ensureDirectoryExists.bind(internals.pathManager);
            let attempts = 0;
            context.mock.method(internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                if (++attempts === 1) {
                    entered();
                    await gate;
                    if (failedWrite) {
                        throw new Error('start write failed');
                    }
                }
                await ensure(folder);
            });
            const balance: RequestBalanceLog = {
                queriedAt: Date.now(),
                entries: [{ id: 'test', balance: 20, currency: 'USD' }]
            };
            let notifications = 0;
            logger.recordRequestBalance(requestId, balance, () => {
                notifications++;
            });
            await writing;
            let completed = false;
            terminal = logger.updateActualTokens({ requestId, status: 'completed' }).then(() => {
                completed = true;
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(completed, false);
            release();
            await terminal;
            await logger.flush();
            const text = await readFile(internals.pathManager.getLogPathFromDate(new Date()).fullPath, 'utf8');
            const rows = text
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            assert.equal(rows.at(-1)?.status, 'completed');
            assert.deepEqual(rows.at(-1)?.balance, balance);
            assert.equal(rows.filter(row => row.status === 'estimated' && row.balance).length, failedWrite ? 0 : 1);
            assert.equal(notifications, failedWrite ? 0 : 1);
        } finally {
            release();
            await terminal;
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const retry of ['none', 'snapshot', 'missing'] as const) {
        test(`request-start balance is persisted before ${status} and survives ${retry} retry`, async context => {
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-start-balance-'));
            const restoreHost = mockLoggerHost();
            let logger: TokenFileLogger | undefined;
            try {
                const { TokenFileLogger } = await import('./index');
                logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
                const internals = logger as unknown as {
                    refreshCurrentStats(): void;
                    updateStreamingMetrics(event: LiveStreamMetricEvent): void;
                };
                context.mock.method(internals, 'refreshCurrentStats', () => {});
                const requestId = `start-${status}-${retry}`;
                await logger.recordEstimatedTokens({
                    requestId,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10
                });
                const initial: RequestBalanceLog = {
                    queriedAt: Date.now() - 1000,
                    entries: [{ id: 'test', balance: 20, currency: 'USD' }]
                };
                const expectedInitial = structuredClone(initial);
                const notifications: string[] = [];
                logger.recordRequestBalance(requestId, initial, date => notifications.push(date));
                initial.entries[0].balance = 999;
                await logger.flush();
                const date = DateUtils.getTodayDateString();
                const started = (await logger.getRequestDetails(date)).find(record => record.requestId === requestId);
                assert.equal(started?.status, 'estimated');
                assert.deepEqual(started?.balance, expectedInitial);
                assert.deepEqual(notifications, [date]);
                let expected: RequestBalanceLog | null = expectedInitial;
                if (retry !== 'none') {
                    internals.updateStreamingMetrics({
                        type: 'requestStarted',
                        requestId,
                        requestStartTime: Date.now(),
                        providerName: 'Test',
                        modelName: 'Test',
                        apiKeyHash: createHash('sha256').update('retry-key').digest('hex'),
                        apiKeyName: 'Retry Key'
                    });
                    expected =
                        retry === 'missing' ? null : (
                            { queriedAt: Date.now(), entries: [{ id: 'test', balance: 5, currency: 'USD' }] }
                        );
                    logger.recordRequestBalance(requestId, expected ?? undefined);
                    await logger.flush();
                    const retried = (await logger.getRequestDetails(date)).find(
                        record => record.requestId === requestId
                    );
                    assert.deepEqual(retried?.balance, expected);
                    assert.equal(retried?.apiKeyName, 'Retry Key');
                }
                await logger.updateActualTokens({
                    requestId,
                    status,
                    rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
                });
                await logger.flush();
                const terminal = (await logger.getRequestDetails(date)).find(record => record.requestId === requestId);
                assert.equal(terminal?.status, status);
                assert.deepEqual(terminal?.balance, expected);
            } finally {
                await logger?.dispose();
                restoreHost();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
}

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const finishOrder of ['before', 'during', 'after'] as const) {
        test(`${status} timing survives metrics finishing ${finishOrder} terminal write`, async context => {
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-terminal-metrics-'));
            const restoreHost = mockLoggerHost();
            let logger: TokenFileLogger | undefined;
            let terminalWrite: Promise<void> | undefined;
            let releaseWrite!: () => void;
            const writeReleased = new Promise<void>(resolve => {
                releaseWrite = resolve;
            });
            try {
                const { TokenFileLogger } = await import('./index');
                logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
                const internals = logger as unknown as {
                    pathManager: LogPathManager;
                    snapshotManager: SnapshotManager;
                    finalizingRequestIds: Set<string>;
                    updateStreamingMetrics(event: LiveStreamMetricEvent): void;
                    refreshCurrentStats(): void;
                };
                context.mock.method(internals, 'refreshCurrentStats', () => {});
                const requestStartTime = Date.now();
                const streamStartTime = requestStartTime + 100;
                const streamEndTime = streamStartTime + 1000;
                const requestId = `${status}-${finishOrder}`;
                await logger.recordEstimatedTokens({
                    requestId,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    requestClassification: classification,
                    requestContinuity: continuity,
                    timestamp: requestStartTime
                });
                const pending = logger.getPendingLogs()[0];
                assert.ok(pending);
                assert.deepEqual(pending.requestClassification, classification);
                assert.deepEqual(pending.requestContinuity, continuity);
                const apiKeyHash = createHash('sha256').update('request-key-a').digest('hex');
                const requestStarted = {
                    type: 'requestStarted' as const,
                    requestId,
                    requestStartTime,
                    providerName: 'Test',
                    modelName: 'Test',
                    apiKeyHash,
                    apiKeyName: '请求时的配置名称'
                };
                internals.updateStreamingMetrics(requestStarted);
                let now = streamStartTime;
                const tracker = new LiveMetricsTracker({
                    requestId,
                    requestStartTime,
                    providerName: 'Test',
                    modelName: 'Test',
                    now: () => now,
                    onLiveMetrics: event => internals.updateStreamingMetrics(event)
                });
                tracker.markStreamStarted(streamStartTime);
                now = streamEndTime;
                tracker.reportOutput(100);
                assert.equal(pending.streamStartTime, streamStartTime);
                assert.equal(pending.outputSpeed, 100);
                assert.equal(pending.outputTokens, 100);
                assert.deepEqual(pending.requestClassification, classification);
                assert.deepEqual(pending.requestContinuity, continuity);

                let signalWriteStarted!: () => void;
                const writeStarted = new Promise<void>(resolve => {
                    signalWriteStarted = resolve;
                });
                const ensureDirectoryExists = internals.pathManager.ensureDirectoryExists.bind(internals.pathManager);

                now = streamEndTime + 500;
                if (finishOrder === 'before') {
                    tracker.finishMetrics();
                    assert.equal(pending.streamEndTime, now);
                }
                const rawUsage = { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 };
                const balance: RequestBalanceLog = {
                    queriedAt: streamEndTime + 500,
                    entries: [{ id: 'test', balance: 12.5, currency: 'USD', paid: 10, granted: 2.5 }],
                    statusSnapshots: [
                        {
                            version: 1,
                            provider: 'commandcode',
                            queriedAt: streamEndTime + 500,
                            data: {
                                planId: 'individual-pro',
                                monthlyCredits: 2,
                                purchasedCredits: 10,
                                freeCredits: 0.5,
                                totalCredits: 12.5,
                                fiveHour: {
                                    used: 30,
                                    cap: 100,
                                    exceeded: false,
                                    resetAt: new Date(streamEndTime + 60_000).toISOString()
                                },
                                weekly: { used: 60, cap: 200, exceeded: false },
                                lastUpdated: new Date(streamEndTime + 500).toISOString()
                            },
                            context: {
                                icon: '$(gcmp-commandcode)',
                                title: 'Command Code Pro',
                                language: 'en',
                                locale: 'en-US',
                                timeZone: 'UTC'
                            }
                        }
                    ]
                };
                logger.recordRequestBalance(requestId, balance);
                await logger.flush();
                context.mock.method(internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                    await ensureDirectoryExists(folder);
                    signalWriteStarted();
                    await writeReleased;
                });
                terminalWrite = logger.updateActualTokens({
                    requestId,
                    status,
                    requestMetricStartTime: requestStartTime,
                    streamStartTime,
                    streamEndTime,
                    rawUsage,
                    estimatedCost: 0.125
                });
                await writeStarted;
                assert.equal(internals.finalizingRequestIds.has(requestId), true);
                assert.equal(pending.status, status);
                assert.equal(pending.streamEndTime, streamEndTime);
                if (finishOrder === 'during') {
                    tracker.finishMetrics();
                    internals.updateStreamingMetrics({
                        ...requestStarted,
                        requestStartTime: streamEndTime + 1,
                        apiKeyHash: createHash('sha256').update('request-key-b').digest('hex'),
                        apiKeyName: '不应覆盖的名称'
                    });
                }
                releaseWrite();
                await terminalWrite;
                if (finishOrder === 'after') {
                    tracker.finishMetrics();
                }

                assert.equal(internals.finalizingRequestIds.has(requestId), false);
                assert.equal(logger.getPendingLogs().length, 0);
                const records = await logger.readDateLogs(DateUtils.formatDate(new Date(pending.timestamp)));
                const saved = records.find(record => record.requestId === requestId && record.status === status);
                assert.ok(saved);
                assert.deepEqual(saved.requestClassification, classification);
                assert.deepEqual(saved.requestContinuity, continuity);
                assert.equal(saved.requestMetricStartTime, requestStartTime);
                assert.equal(saved.streamStartTime, streamStartTime);
                assert.equal(saved.streamEndTime, streamEndTime);
                assert.deepEqual(saved.rawUsage, rawUsage);
                assert.deepEqual(saved.balance, balance);
                assert.equal(saved.estimatedCost, 0.125);
                assert.equal(saved.apiKeyHash, apiKeyHash);
                assert.equal(saved.apiKeyName, requestStarted.apiKeyName);
                const date = DateUtils.formatDate(new Date(saved.timestamp));
                const merged = (await logger.getRequestDetails(date)).find(record => record.requestId === requestId);
                assert.deepEqual(merged?.requestClassification, classification);
                assert.deepEqual(merged?.requestContinuity, continuity);
                assert.equal(merged?.apiKeyHash, apiKeyHash);
                assert.equal(merged?.apiKeyName, requestStarted.apiKeyName);
                assert.deepEqual(merged?.balance, balance);
                const rawLog = await readFile(
                    internals.pathManager.getLogPathFromDate(new Date(saved.timestamp)).fullPath,
                    'utf8'
                );
                assert.equal(rawLog.includes('request-key-a'), false);
                assert.equal(rawLog.includes('request-key-b'), false);
                await internals.snapshotManager.buildSnapshotFromLogs(date, [saved]);
                const snapshotText = await readFile(join(dir, 'usages', date, 'requests.jsonl'), 'utf8');
                assert.equal(snapshotText.includes(apiKeyHash), true);
                assert.equal(snapshotText.includes(requestStarted.apiKeyName), true);
                assert.equal(snapshotText.includes('request-key-a'), false);
                const snapshotRecord = await internals.snapshotManager.readRecord(date, requestId);
                assert.deepEqual(snapshotRecord?.requestClassification, classification);
                assert.deepEqual(snapshotRecord?.requestContinuity, continuity);
                assert.deepEqual(snapshotRecord?.balance, balance);
                assert.equal((await internals.snapshotManager.readRecord(date, requestId))?.apiKeyHash, apiKeyHash);
                assert.equal(
                    (await internals.snapshotManager.readRecord(date, requestId))?.apiKeyName,
                    requestStarted.apiKeyName
                );
                const usage = UsageParser.parseFromLog(saved);
                assert.equal(usage.streamDuration, 1000);
                assert.equal(usage.outputTokens, 100);
                assert.equal(usage.outputSpeed, 100);
            } finally {
                releaseWrite();
                await terminalWrite?.catch(() => {});
                await logger?.dispose();
                restoreHost();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
}

for (const scenario of ['later-attempt', 'same-millisecond', 'unknown-key', 'unknown-name'] as const) {
    test(`request key hash follows ${scenario} without retaining a stale key`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-request-key-hash-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                snapshotManager: SnapshotManager;
                updateStreamingMetrics(event: LiveStreamMetricEvent): void;
                refreshCurrentStats(): void;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const timestamp = Date.now();
            const requestId = `key-hash-${scenario}`;
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                timestamp
            });
            const legacyRecords = await logger.readDateLogs(DateUtils.formatDate(new Date(timestamp)));
            assert.equal(legacyRecords[0].apiKeyHash, undefined);
            assert.equal(legacyRecords[0].apiKeyName, undefined);
            const first = {
                type: 'requestStarted' as const,
                requestId,
                requestStartTime: timestamp,
                providerName: 'Test',
                modelName: 'Test',
                apiKeyHash: createHash('sha256').update('first-key').digest('hex'),
                apiKeyName: '首次配置'
            };
            internals.updateStreamingMetrics(first);
            assert.equal(logger.getPendingLogs()[0].apiKeyHash, first.apiKeyHash);
            assert.equal(logger.getPendingLogs()[0].apiKeyName, first.apiKeyName);
            const next = {
                ...first,
                requestStartTime: scenario === 'same-millisecond' ? timestamp : timestamp + 1,
                apiKeyHash:
                    scenario === 'unknown-key' ? undefined : createHash('sha256').update('next-key').digest('hex'),
                apiKeyName: scenario === 'unknown-key' || scenario === 'unknown-name' ? undefined : '下一配置'
            };
            internals.updateStreamingMetrics(next);
            internals.updateStreamingMetrics({ ...first, requestStartTime: timestamp - 1 });
            assert.equal(logger.getPendingLogs()[0].apiKeyHash, next.apiKeyHash);
            assert.equal(logger.getPendingLogs()[0].apiKeyName, next.apiKeyName);
            await logger.updateActualTokens({
                requestId,
                status: 'completed',
                rawUsage: { prompt_tokens: 10, completion_tokens: 5 }
            });
            const saved = (await logger.readDateLogs(DateUtils.formatDate(new Date(timestamp)))).find(
                record => record.requestId === requestId && record.status === 'completed'
            );
            assert.ok(saved);
            assert.equal(saved.apiKeyHash, next.apiKeyHash);
            assert.equal(saved.apiKeyName, next.apiKeyName);
            const date = DateUtils.formatDate(new Date(saved.timestamp));
            await internals.snapshotManager.buildSnapshotFromLogs(date, legacyRecords);
            assert.equal((await internals.snapshotManager.readRecord(date, requestId))?.apiKeyHash, undefined);
            assert.equal((await internals.snapshotManager.readRecord(date, requestId))?.apiKeyName, undefined);
            await internals.snapshotManager.upsertRecord(date, saved);
            assert.equal((await internals.snapshotManager.readRecord(date, requestId))?.apiKeyHash, next.apiKeyHash);
            assert.equal((await internals.snapshotManager.readRecord(date, requestId))?.apiKeyName, next.apiKeyName);
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const scenario of [
    'success',
    'quota-only',
    'duplicate',
    'retry',
    'unsupported',
    'dispose',
    'failed',
    'cancelled'
] as const) {
    test(`request-start balance survives terminal recording for ${scenario}`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-request-balance-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            assert.ok(logger);
            const internals = logger as unknown as {
                refreshCurrentStats(): void;
                pathManager: LogPathManager;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const requestId = `balance-${scenario}`;
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: scenario === 'quota-only' ? 'clinepass' : 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10
            });
            const balance: RequestBalanceLog = {
                queriedAt: Date.now(),
                entries: [{ id: 'test', balance: 0, currency: 'USD', paid: -2, granted: 2 }],
                statusSnapshots: [
                    {
                        version: 1,
                        provider: 'moonshot',
                        queriedAt: Date.now(),
                        data: {
                            balanceInfo: { available_balance: 0, cash_balance: -2, voucher_balance: 2 },
                            lastUpdated: '2026/10/21 10:00:00'
                        },
                        context: {
                            icon: '$(gcmp-moonshot)',
                            title: 'Moonshot Account Balance',
                            language: 'en',
                            locale: 'en-US',
                            timeZone: 'UTC'
                        }
                    }
                ]
            };
            if (scenario === 'quota-only') {
                balance.entries = [];
                balance.statusSnapshots = [
                    {
                        version: 1,
                        provider: 'clinepass',
                        queriedAt: balance.queriedAt,
                        data: {
                            limits: [
                                { type: 'five_hour', percentUsed: 10, resetsAt: '2026-10-21T12:00:00Z' },
                                { type: 'weekly', percentUsed: 25 },
                                { type: 'monthly', percentUsed: 40 }
                            ],
                            lastUpdated: '2026/10/21 10:00:00'
                        },
                        context: {
                            icon: '$(gcmp-cline)',
                            title: 'ClinePass Usage',
                            language: 'en',
                            locale: 'en-US',
                            timeZone: 'UTC'
                        }
                    }
                ];
            }
            if (scenario === 'retry') {
                logger.recordRequestBalance(requestId, undefined);
            }
            const balanceNotifications: string[] = [];
            logger.recordRequestBalance(requestId, scenario === 'unsupported' ? undefined : balance, date =>
                balanceNotifications.push(date)
            );
            const terminal = {
                requestId,
                status: scenario === 'failed' || scenario === 'cancelled' ? scenario : ('completed' as const),
                rawUsage: { prompt_tokens: 10, completion_tokens: 5 },
                streamEndTime: Date.now()
            };
            await logger.updateActualTokens(terminal);
            if (scenario === 'duplicate') {
                await logger.updateActualTokens({ ...terminal, status: 'failed' });
            }
            assert.equal(logger.getPendingLogs().length, 0);
            const settling = scenario === 'dispose' ? logger.dispose() : logger.flush();
            await settling;
            await new Promise<void>(resolve => setImmediate(resolve));
            const logPath = internals.pathManager.getLogPathFromDate(new Date(terminal.streamEndTime)).fullPath;
            const text = await readFile(logPath, 'utf8');
            const rows = text
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            const final = rows.at(-1);
            assert.ok(final);
            assert.equal(final.status, terminal.status);
            assert.deepEqual(final.rawUsage, terminal.rawUsage);
            assert.equal(final.streamEndTime, terminal.streamEndTime);
            const expected = scenario === 'unsupported' ? null : balance;
            assert.deepEqual(final.balance, expected);
            assert.equal(rows.filter(row => row.balance !== undefined).length, scenario === 'retry' ? 3 : 2);
            assert.deepEqual(balanceNotifications, [DateUtils.formatDate(new Date(final.timestamp))]);
            if (scenario === 'quota-only') {
                const records = await logger.getRequestDetails(DateUtils.formatDate(new Date(final.timestamp)));
                assert.deepEqual(records.find(record => record.requestId === requestId)?.balance, balance);
                assert.equal(final.providerKey, 'clinepass');
                assert.deepEqual(final.balance?.entries, []);
                assert.equal(final.balance?.statusSnapshots?.[0].provider, 'clinepass');
            }
            if (scenario === 'dispose') {
                logger = undefined;
            }
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const operation of ['flush', 'dispose'] as const) {
    test(`${operation} during terminal write preserves the already recorded balance`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-balance-drain-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let terminal: Promise<void> | undefined;
        let draining: Promise<void> | undefined;
        let releaseWrite!: () => void;
        const writeReady = new Promise<void>(resolve => {
            releaseWrite = resolve;
        });
        let enteredWrite!: () => void;
        const writeEntered = new Promise<void>(resolve => {
            enteredWrite = resolve;
        });
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                pathManager: LogPathManager;
                refreshCurrentStats(): void;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const timestamp = Date.now();
            await logger.recordEstimatedTokens({
                requestId: 'draining',
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                timestamp
            });
            const balance: RequestBalanceLog = {
                queriedAt: timestamp,
                entries: [{ id: 'test', currency: 'USD', balance: 5 }]
            };
            logger.recordRequestBalance('draining', balance);
            await logger.flush();
            const ensureDirectory = internals.pathManager.ensureDirectoryExists.bind(internals.pathManager);
            context.mock.method(internals.pathManager, 'ensureDirectoryExists', async (folder: string) => {
                await ensureDirectory(folder);
                enteredWrite();
                await writeReady;
            });
            terminal = logger.updateActualTokens({ requestId: 'draining', status: 'completed' });
            await writeEntered;
            let drained = false;
            draining = logger[operation]().then(() => {
                drained = true;
            });
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(drained, false);
            releaseWrite();
            await terminal;
            await draining;
            const path = internals.pathManager.getLogPathFromDate(new Date(timestamp)).fullPath;
            const rows = (await readFile(path, 'utf8'))
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            assert.deepEqual(rows.at(-1)?.balance, balance);
            assert.equal(rows.at(-1)?.status, 'completed');
            if (operation === 'dispose') {
                logger = undefined;
            }
        } finally {
            releaseWrite();
            await terminal?.catch(() => {});
            await draining?.catch(() => {});
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const withBalance of [false, true]) {
        test(`${status} persists titles accepted after serialization (balance=${withBalance})`, async context => {
            const dir = await mkdtemp(join(tmpdir(), 'gcmp-terminal-title-'));
            const restoreHost = mockLoggerHost();
            let logger: TokenFileLogger | undefined;
            let terminal: Promise<void> | undefined;
            let enterWrite!: () => void;
            const writeEntered = new Promise<void>(resolve => {
                enterWrite = resolve;
            });
            let releaseWrite!: () => void;
            const writeReady = new Promise<void>(resolve => {
                releaseWrite = resolve;
            });
            try {
                const { TokenFileLogger } = await import('./index');
                logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
                const internals = logger as unknown as { refreshCurrentStats(): void };
                context.mock.method(internals, 'refreshCurrentStats', () => {});
                const requestId = `${Date.now()}_terminal-title`;
                await logger.recordEstimatedTokens({
                    requestId,
                    providerKey: 'test',
                    providerName: 'Test',
                    modelId: 'test',
                    modelName: 'Test',
                    estimatedInput: 10,
                    sessionTitle: 'old title',
                    requestClassification: classification
                });
                const pending = logger.getPendingLogs()[0];
                const balance: RequestBalanceLog = {
                    queriedAt: Date.now(),
                    entries: [{ id: 'wallet', balance: 0, currency: 'USD' }]
                };
                if (withBalance) {
                    logger.recordRequestBalance(requestId, balance);
                    await logger.flush();
                }
                const fileSystem = require('node:fs/promises') as typeof FsPromises;
                const appendFile = fileSystem.appendFile;
                let writes = 0;
                context.mock.method(fileSystem, 'appendFile', async (...args: Parameters<typeof appendFile>) => {
                    if (++writes === 1) {
                        enterWrite();
                        await writeReady;
                    }
                    return appendFile(...args);
                });
                const rawUsage = { prompt_tokens: 10, completion_tokens: 5 };
                terminal = logger.updateActualTokens({ requestId, status, rawUsage });
                await writeEntered;
                for (const sessionTitle of ['first title', 'resolved title']) {
                    assert.equal(
                        await logger.backfillSessionTitle({ requestId, sessionId: 'session', sessionTitle }),
                        true
                    );
                }
                releaseWrite();
                await terminal;
                await logger.flush();
                const final = (await logger.readDateLogs(DateUtils.formatDate(new Date(pending.timestamp)))).at(-1);
                assert.equal(final?.sessionTitle, 'resolved title');
                assert.equal(final?.sessionId, 'session');
                assert.equal(final?.status, status);
                assert.deepEqual(final?.rawUsage, rawUsage);
                assert.deepEqual(final?.requestClassification, classification);
                assert.deepEqual(final?.balance, withBalance ? balance : undefined);
                assert.equal(logger.getPendingLogs().length, 0);
            } finally {
                releaseWrite();
                await terminal?.catch(() => {});
                await logger?.dispose();
                restoreHost();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
}

for (const titleSource of ['none', 'local', 'other-instance'] as const) {
    test(`request-start balance avoids full hourly reads and survives title updates (title=${titleSource})`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-balance-owned-record-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let otherLogger: TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                refreshCurrentStats(): void;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const fileSystem = require('node:fs/promises') as typeof FsPromises;
            const originalRead = fileSystem.readFile;
            let hourlyReads = 0;
            context.mock.method(fileSystem, 'readFile', async (...args: Parameters<typeof originalRead>) => {
                if (/\d{2}\.jsonl$/.test(String(args[0]))) {
                    hourlyReads++;
                }
                return originalRead(...args);
            });
            const requestId = `${Date.now()}_owned-record`;
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                sessionId: 'session',
                sessionTitle: 'old title'
            });
            const pending = logger.getPendingLogs()[0];
            const balance: RequestBalanceLog = {
                queriedAt: Date.now(),
                entries: [{ id: 'wallet', balance: 20, currency: 'USD' }]
            };
            logger.recordRequestBalance(requestId, balance);
            await logger.updateActualTokens({ requestId, status: 'completed', rawUsage: { prompt_tokens: 10 } });
            if (titleSource !== 'none') {
                if (titleSource === 'other-instance') {
                    otherLogger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
                }
                assert.equal(
                    await (otherLogger ?? logger).backfillSessionTitle({
                        requestId,
                        sessionId: 'session',
                        sessionTitle: 'resolved title'
                    }),
                    true
                );
            }
            await logger.flush();
            assert.equal(hourlyReads, 0);
            const final = (await logger.readDateLogs(DateUtils.formatDate(new Date(pending.timestamp)))).at(-1);
            assert.deepEqual(final?.balance, balance);
            assert.equal(final?.sessionTitle, titleSource !== 'none' ? 'resolved title' : 'old title');
        } finally {
            await otherLogger?.dispose();
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

for (const scenario of ['title-first', 'title-reading', 'title-read-error', 'dispose-title-reading'] as const) {
    test(`balance and title updates preserve both fields: ${scenario}`, async context => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-balance-title-'));
        const restoreHost = mockLoggerHost();
        let logger: TokenFileLogger | undefined;
        let titleCheck: Promise<void> | undefined;
        let disposing: Promise<void> | undefined;
        let releaseRead!: () => void;
        const readReady = new Promise<void>(resolve => {
            releaseRead = resolve;
        });
        let enterRead!: () => void;
        const readEntered = new Promise<void>(resolve => {
            enterRead = resolve;
        });
        const pauseRead = scenario !== 'title-first';
        const failTitle = scenario === 'title-read-error';
        try {
            const { TokenFileLogger } = await import('./index');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const internals = logger as unknown as {
                refreshCurrentStats(): void;
                readManager: LogReadManager;
                pathManager: LogPathManager;
                requestLogUpdates: Map<string, Promise<void>>;
            };
            context.mock.method(internals, 'refreshCurrentStats', () => {});
            const now = Date.now();
            const requestId = `${now}_${scenario}`;
            await logger.recordEstimatedTokens({
                requestId,
                providerKey: 'test',
                providerName: 'Test',
                modelId: 'test',
                modelName: 'Test',
                estimatedInput: 10,
                sessionId: 'session',
                sessionTitle: 'old title',
                requestClassification: classification,
                requestContinuity: continuity
            });
            const balance: RequestBalanceLog = {
                queriedAt: now,
                entries: [{ id: 'wallet', balance: 20, currency: 'USD' }]
            };
            logger.recordRequestBalance(requestId, balance);
            const rawUsage = { prompt_tokens: 10, completion_tokens: 5 };
            await logger.updateActualTokens({
                requestId,
                status: 'completed',
                rawUsage,
                streamEndTime: now,
                estimatedCost: 0.25
            });
            const findLatest = internals.readManager.findLatestRequestLog.bind(internals.readManager);
            let reads = 0;
            context.mock.method(internals.readManager, 'findLatestRequestLog', async (date: string, id: string) => {
                const firstRead = ++reads === 1;
                const latest = await findLatest(date, id);
                if (pauseRead && firstRead) {
                    enterRead();
                    await readReady;
                    if (failTitle) {
                        throw new Error('injected title read failure');
                    }
                }
                return latest;
            });
            const updateTitle = () => {
                const task = logger!.backfillSessionTitle({
                    requestId,
                    sessionId: 'session',
                    sessionTitle: 'resolved title'
                });
                return failTitle ?
                        assert.rejects(task, /injected title read failure/)
                    :   task.then(result => {
                            assert.equal(result, true);
                        });
            };
            titleCheck = updateTitle();
            if (pauseRead) {
                await readEntered;
            } else {
                await titleCheck;
            }
            let disposed = false;
            if (scenario === 'dispose-title-reading') {
                disposing = logger.dispose().then(() => {
                    disposed = true;
                });
            }
            if (pauseRead) {
                await new Promise<void>(resolve => setImmediate(resolve));
                assert.equal(reads, 1);
                assert.equal(disposed, false);
            }
            releaseRead();
            await titleCheck;
            if (disposing) {
                await disposing;
            } else {
                await logger.flush();
            }
            const logPath = internals.pathManager.getLogPathFromDate(new Date(now)).fullPath;
            const rows = (await readFile(logPath, 'utf8'))
                .trim()
                .split('\n')
                .map(line => JSON.parse(line) as TokenRequestLog);
            const final = rows.at(-1);
            assert.equal(final?.sessionTitle, failTitle ? 'old title' : 'resolved title');
            assert.deepEqual(final?.balance, balance);
            assert.equal(final?.status, 'completed');
            assert.deepEqual(final?.rawUsage, rawUsage);
            assert.deepEqual(final?.requestClassification, classification);
            assert.deepEqual(final?.requestContinuity, continuity);
            assert.equal(final?.estimatedCost, 0.25);
            assert.equal(final?.streamEndTime, now);
            assert.equal(internals.requestLogUpdates.size, 0);
        } finally {
            releaseRead();
            await titleCheck?.catch(() => {});
            await disposing?.catch(() => {});
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
