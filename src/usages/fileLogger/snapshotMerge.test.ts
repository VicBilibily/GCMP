import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DateUtils } from './dateUtils';
import { UsageParser } from './usageParser';
import {
    mergeSnapshotFiles,
    mergeSnapshotRecord,
    parseSnapshotFileContent,
    stringifySnapshotFile,
    type SnapshotFile,
    type SnapshotRequestRecord
} from './snapshotMerge';
import type { TokenRequestLog } from './types';

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

function createRecord(overrides: Partial<SnapshotRequestRecord> = {}): SnapshotRequestRecord {
    return {
        requestId: overrides.requestId ?? 'req-1',
        timestamp: overrides.timestamp ?? 1000,
        isoTime: overrides.isoTime ?? '1970-01-01T00:00:01.000Z',
        providerKey: overrides.providerKey ?? 'provider',
        providerName: overrides.providerName ?? 'Provider',
        modelId: overrides.modelId ?? 'model',
        modelName: overrides.modelName ?? 'Model',
        estimatedInput: overrides.estimatedInput ?? 10,
        rawUsage: overrides.rawUsage ?? null,
        status: overrides.status ?? 'estimated',
        maxInputTokens: overrides.maxInputTokens,
        requestKind: overrides.requestKind,
        sessionId: overrides.sessionId,
        sessionRecoverySource: overrides.sessionRecoverySource,
        sessionTitle: overrides.sessionTitle,
        requestInitiator: overrides.requestInitiator,
        capturingTokenCorrelationId: overrides.capturingTokenCorrelationId,
        otelTraceContext: overrides.otelTraceContext,
        telemetryTurn: overrides.telemetryTurn,
        requestMetricStartTime: overrides.requestMetricStartTime,
        streamStartTime: overrides.streamStartTime,
        streamEndTime: overrides.streamEndTime,
        actualInput: overrides.actualInput,
        outputTokens: overrides.outputTokens,
        totalTokens: overrides.totalTokens,
        cacheRead: overrides.cacheRead,
        cacheCreation: overrides.cacheCreation,
        streamDuration: overrides.streamDuration,
        outputSpeed: overrides.outputSpeed
    };
}

test('mergeSnapshotRecord keeps completed status and usage when overlay falls back to estimated', () => {
    const completed = createRecord({
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        sessionRecoverySource: 'summary-bridge-truncated',
        telemetryTurn: 7,
        rawUsage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        actualInput: 120,
        outputTokens: 30,
        totalTokens: 150,
        streamStartTime: 1100,
        streamEndTime: 1500,
        outputSpeed: 75
    });
    const estimated = createRecord({
        status: 'estimated',
        timestamp: 1200,
        isoTime: '1970-01-01T00:00:01.200Z',
        rawUsage: null,
        outputTokens: undefined,
        totalTokens: undefined,
        streamEndTime: undefined,
        outputSpeed: undefined
    });

    const merged = mergeSnapshotRecord(completed, estimated);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 1000);
    assert.equal(merged.isoTime, '1970-01-01T00:00:01.000Z');
    assert.deepEqual(merged.rawUsage, completed.rawUsage);
    assert.equal(merged.actualInput, 120);
    assert.equal(merged.outputTokens, 30);
    assert.equal(merged.totalTokens, 150);
    assert.equal(merged.streamEndTime, 1500);
    assert.equal(merged.outputSpeed, 75);
    assert.equal(merged.sessionRecoverySource, 'summary-bridge-truncated');
    assert.equal(merged.telemetryTurn, 7);
});

test('mergeSnapshotFiles keeps records unique to both stores and upgrades shared request to completed', () => {
    const baseOnly = createRecord({ requestId: 'base-only', status: 'completed', actualInput: 40, outputTokens: 8 });
    const oldShared = createRecord({ requestId: 'shared', status: 'estimated', timestamp: 2000 });
    const overlayOnly = createRecord({ requestId: 'overlay-only', status: 'failed', timestamp: 3000 });
    const newShared = createRecord({
        requestId: 'shared',
        status: 'completed',
        timestamp: 2100,
        rawUsage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
        actualInput: 50,
        outputTokens: 10,
        totalTokens: 60
    });

    const baseStore: SnapshotFile = {
        'base-only': baseOnly,
        shared: oldShared
    };
    const overlayStore: SnapshotFile = {
        'overlay-only': overlayOnly,
        shared: newShared
    };

    const merged = mergeSnapshotFiles(baseStore, overlayStore);

    assert.deepEqual(Object.keys(merged).sort(), ['base-only', 'overlay-only', 'shared']);
    assert.equal(merged['base-only']?.status, 'completed');
    assert.equal(merged['overlay-only']?.status, 'failed');
    assert.equal(merged.shared?.status, 'completed');
    assert.equal(merged.shared?.actualInput, 50);
    assert.equal(merged.shared?.outputTokens, 10);
    assert.equal(merged.shared?.timestamp, 2000, 'request start time should remain the earliest timestamp');
});

test('mergeSnapshotFiles prevents completed record from being overwritten by older partial snapshot', () => {
    const fullSnapshot: SnapshotFile = {
        a: createRecord({ requestId: 'a', status: 'completed', actualInput: 10, outputTokens: 2 }),
        b: createRecord({ requestId: 'b', status: 'completed', actualInput: 20, outputTokens: 4 })
    };
    const stalePartialSnapshot: SnapshotFile = {
        a: createRecord({ requestId: 'a', status: 'estimated', timestamp: 1100 }),
        c: createRecord({ requestId: 'c', status: 'completed', actualInput: 30, outputTokens: 6 })
    };

    const merged = mergeSnapshotFiles(fullSnapshot, stalePartialSnapshot);

    assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c']);
    assert.equal(merged.a?.status, 'completed');
    assert.equal(merged.a?.actualInput, 10);
    assert.equal(merged.b?.actualInput, 20);
    assert.equal(merged.c?.actualInput, 30);
});

test('mergeSnapshotRecord prefers newer terminal overlay fields while preserving earliest request start time', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        requestMetricStartTime: 1050,
        rawUsage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
        actualInput: 80,
        outputTokens: 20,
        totalTokens: 100,
        streamStartTime: 1100,
        streamEndTime: 1400,
        outputSpeed: 66
    });
    const overlayCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        isoTime: '1970-01-01T00:00:01.300Z',
        requestMetricStartTime: 1350,
        rawUsage: { prompt_tokens: 90, completion_tokens: 25, total_tokens: 115 },
        actualInput: 90,
        outputTokens: 25,
        totalTokens: 115,
        streamStartTime: undefined,
        streamEndTime: 1600,
        outputSpeed: 83
    });

    const merged = mergeSnapshotRecord(baseCompleted, overlayCompleted);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 1000);
    assert.equal(merged.isoTime, '1970-01-01T00:00:01.000Z');
    assert.deepEqual(merged.rawUsage, overlayCompleted.rawUsage);
    assert.equal(merged.actualInput, 90);
    assert.equal(merged.outputTokens, 25);
    assert.equal(merged.totalTokens, 115);
    assert.equal(merged.requestMetricStartTime, 1350);
    assert.equal(merged.streamStartTime, 1100, 'overlay 缺失时保留 base 的首流时间');
    assert.equal(merged.streamEndTime, 1600);
    assert.equal(merged.outputSpeed, 83);
});

test('mergeSnapshotRecord keeps base requestMetricStartTime when overlay is sparse', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        requestMetricStartTime: 1050,
        rawUsage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        actualInput: 60,
        outputTokens: 12,
        totalTokens: 72
    });
    const sparseCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        requestMetricStartTime: undefined,
        rawUsage: null,
        actualInput: undefined,
        outputTokens: undefined,
        totalTokens: undefined
    });

    const merged = mergeSnapshotRecord(baseCompleted, sparseCompleted);

    assert.equal(merged.requestMetricStartTime, 1050);
    assert.deepEqual(merged.rawUsage, baseCompleted.rawUsage);
});

test('mergeSnapshotRecord keeps late chat-title session reassignment metadata', () => {
    const completedTitleRequest = createRecord({
        requestId: 'req-chat-title',
        status: 'completed',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        requestKind: 'chat-title',
        sessionId: 'temp-session',
        sessionRecoverySource: 'new-uuid'
    });
    const lateMerge = createRecord({
        requestId: 'req-chat-title',
        status: 'completed',
        timestamp: 2000,
        isoTime: '1970-01-01T00:00:02.000Z',
        requestKind: 'chat-title',
        sessionId: 'main-session',
        sessionTitle: '查询 Vue 3.6 最新动态'
    });

    const merged = mergeSnapshotRecord(completedTitleRequest, lateMerge);

    assert.equal(merged.requestKind, 'chat-title');
    assert.equal(merged.sessionId, 'main-session');
    assert.equal(merged.sessionRecoverySource, 'new-uuid');
    assert.equal(merged.sessionTitle, '查询 Vue 3.6 最新动态');
    assert.equal(merged.timestamp, 1000);
});

test('three-stage merge keeps all unique records and lets latest overlay upgrade stale incoming snapshot', () => {
    const latestBase: SnapshotFile = {
        baseOnly: createRecord({ requestId: 'baseOnly', status: 'completed', actualInput: 10, outputTokens: 1 }),
        shared: createRecord({ requestId: 'shared', status: 'completed', actualInput: 20, outputTokens: 2 })
    };

    const incomingStore: SnapshotFile = {
        shared: createRecord({ requestId: 'shared', status: 'estimated', timestamp: 1200 }),
        incomingOnly: createRecord({ requestId: 'incomingOnly', status: 'completed', actualInput: 30, outputTokens: 3 })
    };

    const latestOverlay: SnapshotFile = {
        shared: createRecord({
            requestId: 'shared',
            status: 'completed',
            timestamp: 1300,
            rawUsage: { prompt_tokens: 25, completion_tokens: 4, total_tokens: 29 },
            actualInput: 25,
            outputTokens: 4,
            totalTokens: 29,
            outputSpeed: 40
        }),
        overlayOnly: createRecord({ requestId: 'overlayOnly', status: 'failed', timestamp: 1400 })
    };

    const merged = mergeSnapshotFiles(mergeSnapshotFiles(latestBase, incomingStore), latestOverlay);

    assert.deepEqual(Object.keys(merged).sort(), ['baseOnly', 'incomingOnly', 'overlayOnly', 'shared']);
    assert.equal(merged.baseOnly?.actualInput, 10);
    assert.equal(merged.incomingOnly?.actualInput, 30);
    assert.equal(merged.overlayOnly?.status, 'failed');
    assert.equal(merged.shared?.status, 'completed');
    assert.equal(merged.shared?.actualInput, 25);
    assert.equal(merged.shared?.outputTokens, 4);
    assert.equal(merged.shared?.outputSpeed, 40);
    assert.equal(merged.shared?.timestamp, 1000, '共享请求仍保留最早开始时间');
});

test('mergeSnapshotRecord keeps base parsed usage fields when same-rank overlay is sparse', () => {
    const baseCompleted = createRecord({
        status: 'completed',
        rawUsage: { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 },
        actualInput: 60,
        outputTokens: 12,
        totalTokens: 72,
        cacheRead: 8,
        cacheCreation: 52,
        outputSpeed: 24
    });
    const sparseCompleted = createRecord({
        status: 'completed',
        timestamp: 1300,
        rawUsage: null,
        actualInput: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        cacheRead: undefined,
        cacheCreation: undefined,
        outputSpeed: undefined
    });

    const merged = mergeSnapshotRecord(baseCompleted, sparseCompleted);

    assert.equal(merged.status, 'completed');
    assert.deepEqual(merged.rawUsage, baseCompleted.rawUsage);
    assert.equal(merged.actualInput, 60);
    assert.equal(merged.outputTokens, 12);
    assert.equal(merged.totalTokens, 72);
    assert.equal(merged.cacheRead, 8);
    assert.equal(merged.cacheCreation, 52);
    assert.equal(merged.outputSpeed, 24);
});

test('mergeSnapshotRecord uses earlier estimated timestamp and isoTime even when completed base remains preferred', () => {
    const completed = createRecord({
        status: 'completed',
        timestamp: 2000,
        isoTime: '1970-01-01T00:00:02.000Z',
        actualInput: 70,
        outputTokens: 14
    });
    const earlierEstimated = createRecord({
        status: 'estimated',
        timestamp: 900,
        isoTime: '1970-01-01T00:00:00.900Z'
    });

    const merged = mergeSnapshotRecord(completed, earlierEstimated);

    assert.equal(merged.status, 'completed');
    assert.equal(merged.timestamp, 900);
    assert.equal(merged.isoTime, '1970-01-01T00:00:00.900Z');
    assert.equal(merged.actualInput, 70);
    assert.equal(merged.outputTokens, 14);
});

test('mergeSnapshotFiles does not mutate input stores or source records', () => {
    const baseRecord = createRecord({ requestId: 'shared', status: 'completed', actualInput: 11, outputTokens: 2 });
    const overlayRecord = createRecord({ requestId: 'shared', status: 'estimated', timestamp: 1200 });
    const baseStore: SnapshotFile = { shared: baseRecord };
    const overlayStore: SnapshotFile = { shared: overlayRecord };

    const baseBefore = structuredClone(baseStore);
    const overlayBefore = structuredClone(overlayStore);

    const merged = mergeSnapshotFiles(baseStore, overlayStore);

    assert.deepEqual(baseStore, baseBefore);
    assert.deepEqual(overlayStore, overlayBefore);
    assert.notEqual(merged.shared, baseStore.shared);
    assert.notEqual(merged.shared, overlayStore.shared);
});

test('snapshot JSONL parse skips corrupt lines and keeps valid request records', () => {
    const first = createRecord({ requestId: 'req-1', status: 'completed', actualInput: 10 });
    const second = createRecord({ requestId: 'req-2', status: 'failed', timestamp: 2000 });
    const content = [
        JSON.stringify(first),
        '{bad json',
        JSON.stringify({ ignored: true }),
        JSON.stringify(second)
    ].join('\n');

    const parsed = parseSnapshotFileContent(content);

    assert.deepEqual(Object.keys(parsed).sort(), ['req-1', 'req-2']);
    assert.equal(parsed['req-1']?.actualInput, 10);
    assert.equal(parsed['req-2']?.status, 'failed');
});

test('snapshot JSONL stringify writes one final request record per line', () => {
    const store: SnapshotFile = {
        'req-2': createRecord({ requestId: 'req-2', timestamp: 2000 }),
        'req-1': createRecord({ requestId: 'req-1' })
    };

    const content = stringifySnapshotFile(store);
    const lines = content.split('\n');

    assert.equal(lines.length, 2);
    assert.deepEqual(
        lines.map(line => JSON.parse(line).requestId),
        ['req-1', 'req-2']
    );
});

test('UsageParser reparses historical snapshot rawUsage with unified OpenAI-compatible semantics', () => {
    const historicalSnapshotRecord = {
        requestId: 'req-hyper',
        timestamp: 1000,
        isoTime: '1970-01-01T00:00:01.000Z',
        providerKey: 'provider',
        providerName: 'Provider',
        modelId: 'model',
        modelName: 'Model',
        estimatedInput: 17,
        rawUsage: {
            prompt_tokens: 17,
            completion_tokens: 26,
            total_tokens: 5844,
            prompt_tokens_details: {
                cached_tokens: 5801
            }
        },
        status: 'completed' as const,
        // 模拟旧/错误快照字段：曾按 prompt_tokens 直接落 actualInput
        actualInput: 17,
        cacheReadTokens: 5801,
        cacheCreationTokens: 0,
        totalTokens: 43,
        outputTokens: 26
    };

    const extended = UsageParser.extendLog(historicalSnapshotRecord);

    assert.equal(extended.actualInput, 5818);
    assert.equal(extended.cacheReadTokens, 5801);
    assert.equal(extended.cacheCreationTokens, 17);
    assert.equal(extended.outputTokens, 26);
    assert.equal(extended.totalTokens, 5844);
});

test('missing and empty snapshots remain readable and allow the first record to be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-empty-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        assert.equal(await snapshot.read(date), null);
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getSnapshotFilePath(date), '');
        assert.equal(await snapshot.read(date), null);
        await snapshot.upsertRecord(date, createRequestLog('first'));
        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['first']
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('reverse snapshot read returns newest records without reading the full file', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-reverse-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T00:00:00`).getTime();
        const logs = Array.from({ length: 2000 }, (_, index) => ({
            ...createRequestLog(`reverse-${index}`),
            timestamp: baseTimestamp + index,
            isoTime: new Date(baseTimestamp + index).toISOString()
        }));

        await snapshot.buildSnapshotFromLogs(date, logs);
        const snapshotPath = paths.getSnapshotFilePath(date);
        const snapshotSize = (await stat(snapshotPath)).size;
        const fs = require('fs/promises') as typeof import('node:fs/promises');
        const openFile = fs.open;
        let bytesRead = 0;
        context.mock.method(fs, 'open', async (...args: Parameters<typeof openFile>) => {
            const handle = await openFile(...args);
            if (args[0] !== snapshotPath) {
                return handle;
            }
            const readAt = handle.read.bind(handle) as unknown as (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number | null
            ) => Promise<{ bytesRead: number; buffer: Buffer }>;
            return {
                stat: () => handle.stat(),
                read: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
                    const result = await readAt(buffer, offset, Math.min(length, 1024), position);
                    bytesRead += result.bytesRead;
                    return result;
                },
                close: () => handle.close()
            } as typeof handle;
        });

        assert.deepEqual(
            (await snapshot.readRecent(date, 20))?.map(record => record.requestId),
            Array.from({ length: 20 }, (_, index) => `reverse-${1999 - index}`)
        );
        assert.ok(bytesRead < snapshotSize);
    } finally {
        context.mock.restoreAll();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('reverse snapshot read preserves a record larger than one read chunk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-large-reverse-snapshot-record-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T00:00:00`).getTime();
        const oversizedRecord = {
            ...createRequestLog('oversized-record'),
            timestamp: baseTimestamp + 1,
            isoTime: new Date(baseTimestamp + 1).toISOString(),
            sessionTitle: 'x'.repeat(70 * 1024)
        };
        const newestRecord = {
            ...createRequestLog('newest-after-oversized'),
            timestamp: baseTimestamp + 2,
            isoTime: new Date(baseTimestamp + 2).toISOString()
        };

        await snapshot.buildSnapshotFromLogs(date, [oversizedRecord, newestRecord]);

        const records = await snapshot.readRecent(date, 2);
        assert.deepEqual(
            records?.map(record => record.requestId),
            ['newest-after-oversized', 'oversized-record']
        );
        assert.equal(records?.[1].sessionTitle?.length, 70 * 1024);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('bounded snapshot read supports legacy files written newest first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-legacy-descending-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const baseTimestamp = new Date(`${date}T00:00:00`).getTime();
        const records = Array.from({ length: 50 }, (_, index) => ({
            ...createRequestLog(`legacy-desc-${index}`),
            timestamp: baseTimestamp + index,
            isoTime: new Date(baseTimestamp + index).toISOString()
        })).reverse();
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getSnapshotFilePath(date), records.map(record => JSON.stringify(record)).join('\n'));

        assert.deepEqual(
            (await snapshot.readRecent(date, 20))?.map(record => record.requestId),
            Array.from({ length: 20 }, (_, index) => `legacy-desc-${49 - index}`)
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('reverse snapshot read skips corrupt tail lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-corrupt-snapshot-tail-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        await snapshot.buildSnapshotFromLogs(date, [createRequestLog('authoritative-record')]);
        const snapshotPath = paths.getSnapshotFilePath(date);
        await writeFile(snapshotPath, `${await readFile(snapshotPath, 'utf8')}\n{bad json`, 'utf8');

        assert.deepEqual(
            (await snapshot.readRecent(date, 20))?.map(record => record.requestId),
            ['authoritative-record']
        );
        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['authoritative-record']
        );
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('reverse snapshot read rejects records when the authoritative snapshot changes during the read', async context => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-racing-reverse-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        await snapshot.buildSnapshotFromLogs(date, [createRequestLog('old-record')]);

        const fs = require('fs/promises') as typeof import('node:fs/promises');
        const statFile = fs.stat;
        context.mock.method(fs, 'stat', async (...args: Parameters<typeof statFile>) => {
            const stats = await statFile(...args);
            if (args[0] === paths.getSnapshotFilePath(date)) {
                return Object.assign(stats, { mtimeMs: Number(stats.mtimeMs) + 1 });
            }
            return stats;
        });

        assert.equal(await snapshot.readRecent(date, 20), null);
    } finally {
        context.mock.restoreAll();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('reverse snapshot read is disabled while uncompressed raw logs remain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-reverse-snapshot-with-raw-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const snapshot = new SnapshotManager(paths, () => {});
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = createRequestLog('saved-record');
        await snapshot.buildSnapshotFromLogs(date, [record]);
        await writeFile(paths.getHourFilePath(date, 0), `${JSON.stringify(record)}\n`, 'utf8');

        assert.equal(await snapshot.readRecent(date, 20), null);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('recent historical records read the snapshot tail without parsing the full snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-bounded-reverse-preview-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const record = createRequestLog('legacy-full-record');
        await mkdir(paths.getDateFolderPath(date), { recursive: true });
        await writeFile(paths.getSnapshotFilePath(date), stringifySnapshotFile({ [record.requestId]: record }), 'utf8');
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        const { snapshotManager } = logger as unknown as {
            snapshotManager: import('./snapshotManager').SnapshotManager;
        };
        let fullReads = 0;
        snapshotManager.read = async () => {
            fullReads++;
            throw new Error('full snapshot read must not run');
        };

        assert.deepEqual(
            (await logger.getRecentRequestDetails(date, 20, true)).map(item => item.requestId),
            ['legacy-full-record']
        );
        assert.equal(fullReads, 0);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('independent snapshot managers preserve concurrent records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-cross-host-snapshot-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const first = new SnapshotManager(paths, () => {});
        const second = new SnapshotManager(paths, () => {});

        await Promise.all([
            first.upsertRecord(date, createRequestLog('cross-host-a')),
            second.upsertRecord(date, createRequestLog('cross-host-b'))
        ]);

        assert.deepEqual((await first.read(date))?.map(record => record.requestId).sort(), [
            'cross-host-a',
            'cross-host-b'
        ]);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes reclaim a lock left by a stopped host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-stale-snapshot-lock-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const folder = paths.getDateFolderPath(date);
        const lockPath = join(folder, '.requests.lock');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(lockPath, { recursive: true });
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'stopped-host' }));

        const internals = snapshot as unknown as { isProcessAlive: (pid: number) => boolean };
        internals.isProcessAlive = () => false;
        await snapshot.upsertRecord(date, createRequestLog('after-stale-lock'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-stale-lock']
        );
        await assert.rejects(stat(lockPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
        await assert.rejects(stat(`${lockPath}.reclaim`), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes reclaim an ownerless orphaned lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-ownerless-snapshot-lock-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const lockPath = join(paths.getDateFolderPath(date), '.requests.lock');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(lockPath, { recursive: true });
        const staleTime = new Date(Date.now() - 10_000);
        await utimes(lockPath, staleTime, staleTime);

        await snapshot.upsertRecord(date, createRequestLog('after-ownerless-lock'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-ownerless-lock']
        );
        await assert.rejects(stat(lockPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
        await assert.rejects(stat(`${lockPath}.reclaim`), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('snapshot writes recover an orphaned stale-lock reclaim guard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-orphaned-snapshot-reclaim-'));
    const restoreHost = mockLoggerHost();
    let constants:
        | {
              SNAPSHOT_LOCK_WAIT_MS: number;
              SNAPSHOT_LOCK_RETRY_MS: number;
          }
        | undefined;
    let originalWaitMs = 0;
    let originalRetryMs = 0;
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        constants = SnapshotManager as unknown as typeof constants & object;
        originalWaitMs = constants.SNAPSHOT_LOCK_WAIT_MS;
        originalRetryMs = constants.SNAPSHOT_LOCK_RETRY_MS;
        constants.SNAPSHOT_LOCK_WAIT_MS = 100;
        constants.SNAPSHOT_LOCK_RETRY_MS = 5;
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const reclaimPath = join(paths.getDateFolderPath(date), '.requests.lock.reclaim');
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(reclaimPath, { recursive: true });
        const staleTime = new Date(Date.now() - 1_000);
        await utimes(reclaimPath, staleTime, staleTime);

        await snapshot.upsertRecord(date, createRequestLog('after-orphaned-reclaim'));

        assert.deepEqual(
            (await snapshot.read(date))?.map(record => record.requestId),
            ['after-orphaned-reclaim']
        );
        await assert.rejects(stat(reclaimPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
    } finally {
        if (constants) {
            constants.SNAPSHOT_LOCK_WAIT_MS = originalWaitMs;
            constants.SNAPSHOT_LOCK_RETRY_MS = originalRetryMs;
        }
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('historical compaction keeps raw logs when their source changes during the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-compaction-source-race-'));
    const restoreHost = mockLoggerHost();
    try {
        const { SnapshotManager } = await import('./snapshotManager');
        const { LogPathManager } = await import('./logPathManager');
        const paths = new LogPathManager(dir);
        const date = DateUtils.getDateStringDaysAgo(3);
        const folder = paths.getDateFolderPath(date);
        const rawFile = paths.getHourFilePath(date, 0);
        const concurrentRawFile = paths.getHourFilePath(date, 1);
        const snapshot = new SnapshotManager(paths, () => {});
        await mkdir(folder, { recursive: true });
        await writeFile(rawFile, `${JSON.stringify(createRequestLog('before-compaction'))}\n`);

        const internals = snapshot as unknown as {
            atomicWriteStore: (filePath: string, store: SnapshotFile) => Promise<void>;
        };
        const atomicWriteStore = internals.atomicWriteStore.bind(snapshot);
        let injected = false;
        internals.atomicWriteStore = async (filePath, store) => {
            if (!injected) {
                injected = true;
                await writeFile(concurrentRawFile, `${JSON.stringify(createRequestLog('during-compaction'))}\n`);
            }
            await atomicWriteStore(filePath, store);
        };

        assert.equal(await snapshot.compactHistoricalDates(2), 0);
        await assert.doesNotReject(readFile(rawFile, 'utf8'));
        await assert.doesNotReject(readFile(concurrentRawFile, 'utf8'));
        assert.deepEqual((await snapshot.read(date))?.map(record => record.requestId).sort(), [
            'before-compaction',
            'during-compaction'
        ]);

        internals.atomicWriteStore = atomicWriteStore;
        assert.equal(await snapshot.compactHistoricalDates(2), 1);
        await assert.rejects(readFile(rawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        await assert.rejects(readFile(concurrentRawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        assert.deepEqual((await snapshot.read(date))?.map(record => record.requestId).sort(), [
            'before-compaction',
            'during-compaction'
        ]);
    } finally {
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const scenario of [
    { name: 'completed across hours', status: 'completed', startHour: 10, daysAgo: 0 },
    { name: 'cancelled across hours', status: 'cancelled', startHour: 10, daysAgo: 0 },
    { name: 'failed across hours', status: 'failed', startHour: 10, daysAgo: 0 },
    { name: 'completed within one hour', status: 'completed', startHour: 11, daysAgo: 0 },
    { name: 'completed yesterday across hours', status: 'completed', startHour: 10, daysAgo: 1 }
] as const) {
    test(`title backfill preserves hourly totals for ${scenario.name}`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-hourly-title-totals-'));
        const restoreHost = mockLoggerHost();
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            const date = DateUtils.getDateStringDaysAgo(scenario.daysAgo);
            const startedAt = new Date(`${date}T${scenario.startHour}:00:00`).getTime();
            const completedAt = new Date(`${date}T11:01:00`).getTime();
            const requestId = `${startedAt}_title-totals`;
            const estimated: TokenRequestLog = {
                ...createRequestLog(requestId),
                timestamp: startedAt,
                isoTime: new Date(startedAt).toISOString(),
                estimatedInput: 10,
                status: 'estimated',
                sessionId: 'session-a'
            };
            const terminal: TokenRequestLog = {
                ...estimated,
                timestamp: completedAt,
                isoTime: new Date(completedAt).toISOString(),
                status: scenario.status,
                sessionTitle: 'Original title',
                rawUsage:
                    scenario.status === 'failed' ? null : { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                ...(scenario.status === 'failed' ? {} : { estimatedCost: 0.25 }),
                streamStartTime: startedAt + 500,
                streamEndTime: completedAt
            };
            const folder = join(dir, 'usages', date);
            const sourcePath = join(folder, `${scenario.startHour}.jsonl`);
            const terminalPath = join(folder, '11.jsonl');
            const estimatedContent = `${JSON.stringify(estimated)}\n`;
            const terminalContent = `${JSON.stringify(terminal)}\n`;
            await mkdir(folder, { recursive: true });
            if (sourcePath === terminalPath) {
                await writeFile(terminalPath, estimatedContent + terminalContent);
            } else {
                await writeFile(sourcePath, estimatedContent);
                await writeFile(terminalPath, terminalContent);
            }
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const before = await logger.getDateStats(date, true);
            if (scenario.status !== 'failed') {
                assert.equal(before.total.actualInput, 10);
                assert.equal(before.total.outputTokens, 2);
                assert.equal(before.total.estimatedCost, 0.25);
            }

            for (const title of ['Resolved title', 'Renamed title']) {
                assert.equal(
                    await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: title }),
                    true
                );
                await logger.flush();
                const after = await logger.getDateStats(date, true);
                assert.deepEqual(after.total, before.total);
                assert.deepEqual(after.providers, before.providers);
                for (const [hour, stats] of Object.entries(before.hourly ?? {})) {
                    assert.deepEqual({ ...after.hourly?.[hour], modifiedTime: stats.modifiedTime }, stats);
                }
                if (sourcePath !== terminalPath) {
                    assert.equal(await readFile(sourcePath, 'utf8'), estimatedContent);
                }
                const terminalLines = (await readFile(terminalPath, 'utf8')).trim().split('\n');
                const appended = JSON.parse(terminalLines[terminalLines.length - 1]) as TokenRequestLog;
                assert.deepEqual(appended, { ...terminal, sessionTitle: title });
                logger.clearDetailCaches();
                const details = await logger.getRequestDetails(date);
                assert.equal(details.length, 1);
                assert.equal(details[0].timestamp, startedAt);
                assert.equal(details[0].status, scenario.status);
                assert.equal(details[0].sessionTitle, title);
                assert.deepEqual(details[0].rawUsage, terminal.rawUsage);
                const persisted = await readFile(terminalPath, 'utf8');
                assert.equal(
                    await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: title }),
                    true
                );
                assert.equal(await readFile(terminalPath, 'utf8'), persisted);
            }
        } finally {
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

test('historical title backfill updates the locked snapshot instead of appending compactable raw logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-historical-title-snapshot-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const date = DateUtils.getDateStringDaysAgo(3);
        const startedAt = new Date(`${date}T10:00:00`).getTime();
        const completedAt = new Date(`${date}T11:00:00`).getTime();
        const requestId = `${startedAt}_historical-title`;
        const estimated: TokenRequestLog = {
            ...createRequestLog(requestId),
            timestamp: startedAt,
            isoTime: new Date(startedAt).toISOString(),
            status: 'estimated',
            sessionId: 'historical-session'
        };
        const terminal: TokenRequestLog = {
            ...estimated,
            timestamp: completedAt,
            isoTime: new Date(completedAt).toISOString(),
            status: 'completed',
            sessionTitle: 'Original title',
            rawUsage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
        const folder = join(dir, 'usages', date);
        const rawFile = join(folder, '10.jsonl');
        const appendedRawFile = join(folder, '11.jsonl');
        const rawContent = `${JSON.stringify(estimated)}\n${JSON.stringify(terminal)}\n`;
        await mkdir(folder, { recursive: true });
        await writeFile(rawFile, rawContent);
        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);

        assert.equal(
            await logger.backfillSessionTitle({
                requestId,
                sessionId: 'historical-session',
                sessionTitle: 'Resolved historical title'
            }),
            true
        );
        assert.equal(await readFile(rawFile, 'utf8'), rawContent);
        await assert.rejects(readFile(appendedRawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        logger.clearDetailCaches();
        assert.equal((await logger.getRequestDetails(date))[0]?.sessionTitle, 'Resolved historical title');

        const snapshotManager = (logger as unknown as { snapshotManager: import('./snapshotManager').SnapshotManager })
            .snapshotManager;
        assert.equal(await snapshotManager.compactHistoricalDates(2), 1);
        await assert.rejects(readFile(rawFile, 'utf8'), error => {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        });
        logger.clearDetailCaches();
        assert.equal((await logger.getRequestDetails(date))[0]?.sessionTitle, 'Resolved historical title');
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

test('late title backfill does not overwrite a cross-midnight terminal record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gcmp-cross-midnight-title-'));
    const restoreHost = mockLoggerHost();
    let logger: import('./index').TokenFileLogger | undefined;
    try {
        const { TokenFileLogger } = await import('./index');
        const sourceDate = DateUtils.getDateStringDaysAgo(1);
        const completedDate = DateUtils.getTodayDateString();
        const startedAt = new Date(`${sourceDate}T23:59:00`).getTime();
        const completedAt = new Date(`${completedDate}T00:01:00`).getTime();
        const requestId = `${startedAt}_cross-midnight`;
        const sourceFolder = join(dir, 'usages', sourceDate);
        const completedFolder = join(dir, 'usages', completedDate);
        const baseLog = {
            ...createRequestLog(requestId),
            sessionId: 'session-a'
        };
        await mkdir(sourceFolder, { recursive: true });
        await mkdir(completedFolder, { recursive: true });
        await writeFile(
            join(sourceFolder, '23.jsonl'),
            `${JSON.stringify({
                ...baseLog,
                timestamp: startedAt,
                isoTime: new Date(startedAt).toISOString(),
                rawUsage: null,
                status: 'estimated'
            })}\n`
        );
        await writeFile(
            join(completedFolder, '00.jsonl'),
            `${JSON.stringify({
                ...baseLog,
                timestamp: completedAt,
                isoTime: new Date(completedAt).toISOString(),
                rawUsage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
                status: 'completed'
            })}\n`
        );

        logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
        assert.equal(
            await logger.backfillSessionTitle({ requestId, sessionId: 'session-a', sessionTitle: 'Late title' }),
            true
        );
        await logger.flush();

        const sourceRecord = (await logger.getRequestDetails(sourceDate)).find(log => log.requestId === requestId);
        const completedRecord = (await logger.getRequestDetails(completedDate)).find(
            log => log.requestId === requestId
        );
        assert.equal(sourceRecord?.sessionTitle, 'Late title');
        assert.equal(completedRecord?.status, 'completed');
        assert.equal(completedRecord?.rawUsage?.total_tokens, 12);
    } finally {
        await logger?.dispose();
        restoreHost();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const recoveryPath of ['fast-index', 'cached-stats'] as const) {
    test(`${recoveryPath} repairs a failed index write without rereading raw hours`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'gcmp-index-write-retry-'));
        const restoreHost = mockLoggerHost();
        const { AtomicJsonFile } = await import('../atomicJsonFile');
        const write = AtomicJsonFile.writeJsonAtomically;
        let logger: import('./index').TokenFileLogger | undefined;
        try {
            const { TokenFileLogger } = await import('./index');
            const { LogIndexManager } = await import('./logIndexManager');
            logger = new TokenFileLogger({ globalStorageUri: { fsPath: dir } } as never);
            const { readManager, indexManager, logStatsManager } = logger as unknown as {
                readManager: import('./logReadManager').LogReadManager;
                indexManager: import('./logIndexManager').LogIndexManager;
                logStatsManager: import('./logStatsManager').LogStatsManager;
            };
            const date = DateUtils.getTodayDateString();
            const folder = join(dir, 'usages', date);
            const rawFile = join(folder, '00.jsonl');
            await mkdir(folder, { recursive: true });
            await writeFile(rawFile, `${JSON.stringify(createRequestLog('first'))}\n`);
            const oldTime = new Date(Date.now() - 60_000);
            await utimes(rawFile, oldTime, oldTime);
            assert.equal((await logger.getDateStats(date, true)).total.requests, 1);
            await logger.getIndex();
            const indexPath = indexManager.getIndexPath();
            const internals = indexManager as unknown as { getAllStatsDates(): Promise<string[]> };
            const getAllStatsDates = internals.getAllStatsDates.bind(indexManager);
            let scans = 0;
            internals.getAllStatsDates = async () => {
                scans++;
                return getAllStatsDates();
            };
            let failWrites = true;
            let statsWrites = 0;
            AtomicJsonFile.writeJsonAtomically = async (file, value, serializer) => {
                if (file === indexPath && failWrites) {
                    throw new Error('Injected index write failure');
                }
                if (file === join(folder, 'stats.json')) {
                    statsWrites++;
                }
                return write.call(AtomicJsonFile, file, value, serializer);
            };
            await writeFile(
                rawFile,
                `${await readFile(rawFile, 'utf8')}${JSON.stringify(createRequestLog('second'))}\n`
            );
            assert.equal((await logger.getDateStats(date)).total.requests, 2);
            statsWrites = 0;
            let rawReads = 0;
            const readHourLogs = readManager.readHourLogs.bind(readManager);
            readManager.readHourLogs = async (...args) => {
                rawReads++;
                return readHourLogs(...args);
            };
            if (recoveryPath === 'cached-stats') {
                logStatsManager.setCanWriteStats(() => false);
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal(scans, 0);
                logStatsManager.setCanWriteStats(() => true);
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal(scans, 1);
            }
            failWrites = false;
            if (recoveryPath === 'fast-index') {
                assert.equal((await logger.getIndexFast())[date].total_requests, 2);
            } else {
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                const observer = new LogIndexManager(dir);
                assert.equal((await observer.getIndexFast())[date].total_requests, 2);
            }
            const recoveredScans = scans;
            assert.equal(recoveredScans, recoveryPath === 'fast-index' ? 1 : 2);
            for (let attempt = 0; attempt < 3; attempt++) {
                assert.equal((await logger.getDateStats(date)).total.requests, 2);
                assert.equal((await logger.getIndexFast())[date].total_requests, 2);
            }
            assert.equal(rawReads, 0);
            assert.equal(statsWrites, 0);
            assert.equal(scans, recoveredScans);
        } finally {
            AtomicJsonFile.writeJsonAtomically = write;
            await logger?.dispose();
            restoreHost();
            await rm(dir, { recursive: true, force: true });
        }
    });
}
