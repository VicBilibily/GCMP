import assert from 'node:assert/strict';
import test from 'node:test';

import { UsageParser } from './usageParser';
import {
    mergeSnapshotFiles,
    mergeSnapshotRecord,
    parseSnapshotFileContent,
    stringifySnapshotFile,
    type SnapshotFile,
    type SnapshotRequestRecord
} from './snapshotMerge';

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
        requestInitiator: overrides.requestInitiator,
        capturingTokenCorrelationId: overrides.capturingTokenCorrelationId,
        otelTraceContext: overrides.otelTraceContext,
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
    assert.equal(merged.streamStartTime, 1100, 'overlay 缺失时保留 base 的首流时间');
    assert.equal(merged.streamEndTime, 1600);
    assert.equal(merged.outputSpeed, 83);
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
        'req-1': createRecord({ requestId: 'req-1' }),
        'req-2': createRecord({ requestId: 'req-2', timestamp: 2000 })
    };

    const content = stringifySnapshotFile(store);
    const lines = content.split('\n');

    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => JSON.parse(line).requestId).sort(), ['req-1', 'req-2']);
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
