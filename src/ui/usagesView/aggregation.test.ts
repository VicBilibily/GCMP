/**
 * UsagesView 聚合模块测试（扩展侧与 WebView 共享的纯逻辑）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtendedTokenRequestLog } from '../../usages/fileLogger/usageParser';
import {
    buildRequestTotals,
    buildSessionGroupSummaries,
    filterRecordsBySession,
    sliceRecordsPage
} from './aggregation';

function createRecord(overrides: Partial<ExtendedTokenRequestLog> = {}): ExtendedTokenRequestLog {
    return {
        requestId: `req_${overrides.timestamp ?? 0}`,
        timestamp: 1000,
        isoTime: '2026-08-13T00:00:00.000Z',
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'model-a',
        modelName: 'Model A',
        estimatedInput: 100,
        rawUsage: null,
        status: 'completed',
        actualInput: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        totalTokens: 150,
        ...overrides
    } as ExtendedTokenRequestLog;
}

const TRACE_CONTEXT = { traceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', spanId: 'span-1' };
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('output duration totals fall back to protocol time for zero or incomplete windows', () => {
    const totals = buildRequestTotals([
        createRecord({ firstOutputTime: 1500, lastOutputTime: 1500, timePerOutputToken: 100 }),
        createRecord({ firstOutputTime: 1500, lastOutputTime: 3500, timePerOutputToken: 10 }),
        createRecord({ status: 'estimated', firstOutputTime: 1500, lastOutputTime: 9500 }),
        createRecord({ firstOutputTime: 1500, streamDuration: 5000 }),
        createRecord({ lastOutputTime: 3500, streamDuration: 5000 }),
        createRecord({ firstOutputTime: 3500, lastOutputTime: 1500, streamDuration: 5000 })
    ]);
    assert.equal(totals.avgOutputDuration, 5000);
});

test('legacy output duration contributes to totals without replacing actual output windows', () => {
    const totals = buildRequestTotals([
        createRecord({ firstOutputTime: 1500, lastOutputTime: 3500, streamDuration: 9000 }),
        createRecord({ streamDuration: 4000 }),
        createRecord({ streamDuration: Number.POSITIVE_INFINITY }),
        createRecord({ streamDuration: -1 })
    ]);
    assert.equal(totals.avgOutputDuration, 3000);
});

test('failed and cancelled records with actual usage contribute their output durations', () => {
    const records = (['failed', 'cancelled'] as const).map((status, index) =>
        createRecord({
            status,
            rawUsage: { completion_tokens: 10 },
            firstOutputTime: 1500,
            lastOutputTime: 3500 + index * 2000
        })
    );
    assert.equal(buildRequestTotals(records).avgOutputDuration, 3000);
    assert.equal(buildRequestTotals([]).avgOutputDuration, undefined);
});

test('buildSessionGroupSummaries groups by normalized sessionId without records', () => {
    const records = [
        createRecord({
            timestamp: 3000,
            sessionId: SESSION_ID,
            otelTraceContext: TRACE_CONTEXT,
            sessionTitle: '会话标题'
        }),
        createRecord({ timestamp: 2000, sessionId: SESSION_ID, otelTraceContext: TRACE_CONTEXT }),
        createRecord({ timestamp: 1000, sessionId: 'other', otelTraceContext: { ...TRACE_CONTEXT, traceId: 'cccc' } })
    ];

    const summaries = buildSessionGroupSummaries(records);

    // 按 endTime 倒序
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].sessionId, SESSION_ID);
    assert.equal(summaries[0].displayId, SESSION_ID.slice(0, 7));
    assert.equal(summaries[0].title, '会话标题');
    assert.equal(summaries[0].recordCount, 2);
    assert.equal(summaries[0].summary.requestCount, 2);
    // 摘要不含明细记录
    assert.ok(!('records' in summaries[0]));
});

test('buildSessionGroupSummaries computes recoveryDebug per group', () => {
    const sessionA = createRecord({ sessionId: SESSION_ID, otelTraceContext: TRACE_CONTEXT });
    const records = [
        sessionA,
        createRecord({
            requestId: 'req_2',
            timestamp: 2000,
            sessionId: SESSION_ID,
            otelTraceContext: TRACE_CONTEXT,
            sessionRecoverySource: 'trace-bridge'
        })
    ];

    const summaries = buildSessionGroupSummaries(records);
    assert.deepEqual(summaries[0].recoveryDebug, { bridgeCount: 1, newUuidCount: 0 });
});

test('sliceRecordsPage returns correct page slices', () => {
    const records = Array.from({ length: 25 }, (_, i) => createRecord({ timestamp: 1000 + i }));

    const firstPage = sliceRecordsPage(records, 1, 20);
    assert.equal(firstPage.records.length, 20);
    assert.equal(firstPage.totalItems, 25);
    assert.equal(firstPage.records[0].timestamp, 1000);
    assert.equal(firstPage.records[19].timestamp, 1019);

    const secondPage = sliceRecordsPage(records, 2, 20);
    assert.equal(secondPage.records.length, 5);
    assert.equal(secondPage.records[0].timestamp, 1020);
});

test('sliceRecordsPage handles out-of-range pages and empty input', () => {
    const records = Array.from({ length: 10 }, (_, i) => createRecord({ timestamp: i }));

    const outOfRange = sliceRecordsPage(records, 99, 20);
    assert.deepEqual(outOfRange.records, []);
    assert.equal(outOfRange.totalItems, 10);

    const empty = sliceRecordsPage([], 1, 20);
    assert.deepEqual(empty.records, []);
    assert.equal(empty.totalItems, 0);
});

test('filterRecordsBySession matches the same normalized grouping', () => {
    const records = [
        createRecord({ sessionId: SESSION_ID, otelTraceContext: TRACE_CONTEXT, timestamp: 1 }),
        createRecord({ sessionId: SESSION_ID, otelTraceContext: TRACE_CONTEXT, timestamp: 2 }),
        // 无 trace 上下文 → 归为 unknown，不属于该会话
        createRecord({ sessionId: SESSION_ID, timestamp: 3 }),
        createRecord({ sessionId: 'other', otelTraceContext: { ...TRACE_CONTEXT, traceId: 'cccc' }, timestamp: 4 })
    ];

    const filtered = filterRecordsBySession(records, SESSION_ID);
    assert.equal(filtered.length, 2);
    assert.deepEqual(
        filtered.map(r => r.timestamp),
        [1, 2]
    );
});
