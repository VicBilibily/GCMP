import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyNativeCostSplit } from '../fileLogger/nativeCostSplit';
import type { UsagesPendingRecord, UsagesQuery } from './types';
import { isUsagesQueryResult, normalizeUsagesPendingRecords, normalizeUsagesQuery } from './validation';

test('normalizes bounded usages queries', () => {
    assert.deepEqual(normalizeUsagesQuery({ kind: 'dateOverview', date: '2026-09-24' }), {
        kind: 'dateOverview',
        date: '2026-09-24'
    });
    assert.deepEqual(
        normalizeUsagesQuery({
            kind: 'recordsPage',
            date: '2026-09-24',
            mode: 'all',
            sessionId: 'ignored',
            page: 2,
            pageSize: 20
        }),
        {
            kind: 'recordsPage',
            date: '2026-09-24',
            mode: 'all',
            sessionId: undefined,
            page: 2,
            pageSize: 20
        }
    );
    assert.deepEqual(
        normalizeUsagesQuery({
            kind: 'trackRecords',
            date: '2026-09-24',
            sessionIds: ['a', 'b', 'c'],
            limitPerSession: 10
        }),
        {
            kind: 'trackRecords',
            date: '2026-09-24',
            sessionIds: ['a', 'b', 'c'],
            limitPerSession: 10
        }
    );
});

test('rejects malformed or unbounded usages queries', () => {
    const invalid: UsagesQuery[] = [
        { kind: 'dateOverview', date: '2026-02-30' },
        { kind: 'recordsPage', date: '2026-09-24', mode: 'session', page: 1, pageSize: 20 },
        { kind: 'recordsPage', date: '2026-09-24', mode: 'all', page: 0, pageSize: 20 },
        { kind: 'recordsPage', date: '2026-09-24', mode: 'all', page: 1, pageSize: 101 },
        {
            kind: 'trackRecords',
            date: '2026-09-24',
            sessionIds: ['a', 'a'],
            limitPerSession: 10
        },
        {
            kind: 'trackRecords',
            date: '2026-09-24',
            sessionIds: ['a', 'b', 'c', 'd'],
            limitPerSession: 10
        },
        { kind: 'recentRecords', limit: 101 },
        { kind: 'sessionTitle', sessionId: 'x'.repeat(513) }
    ];

    for (const query of invalid) {
        assert.equal(normalizeUsagesQuery(query), undefined);
    }
});

function pendingRecord(requestId = 'pending-1'): UsagesPendingRecord {
    const timestamp = new Date('2026-09-25T10:00:00Z').getTime();
    return {
        requestId,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'model',
        modelName: 'Model',
        estimatedInput: 10,
        estimatedIncrement: 2,
        maxInputTokens: 1000,
        rawUsage: null,
        status: 'estimated',
        sessionId: 'session-a',
        sessionTitle: '正式标题',
        sessionRecoverySource: 'new-uuid',
        requestKind: 'main-agent',
        requestInitiator: 'core',
        capturingTokenCorrelationId: 'correlation',
        otelTraceContext: { traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef' },
        telemetryTurn: 2,
        requestMetricStartTime: timestamp,
        wasThrottled: true,
        streamStartTime: timestamp + 250,
        outputTokens: 25,
        outputSpeed: 12.5
    };
}

test('pending normalization keeps only supported fields and copies mutable metadata', () => {
    const record = pendingRecord();
    const normalized = normalizeUsagesPendingRecords([{ ...record, extra: { ignored: true } }]);
    assert.deepEqual(normalized, [record]);
    assert.notEqual(normalized?.[0], record);
    assert.notEqual(normalized?.[0].otelTraceContext, record.otelTraceContext);
    assert.deepEqual(normalizeUsagesPendingRecords(undefined), []);
    assert.deepEqual(normalizeUsagesPendingRecords([]), []);
});

for (const [field, invalidValue] of [
    ['requestId', ''],
    ['requestId', 'x'.repeat(129)],
    ['timestamp', Number.NaN],
    ['timestamp', Number.POSITIVE_INFINITY],
    ['timestamp', 9e15],
    ['isoTime', 'not-a-date'],
    ['providerKey', null],
    ['providerName', {}],
    ['modelId', 'x'.repeat(513)],
    ['estimatedInput', -1],
    ['status', 'completed'],
    ['rawUsage', {}],
    ['estimatedCost', 1],
    ['costBreakdown', {}],
    ['sessionId', 'x'.repeat(513)],
    ['sessionTitle', 'x'.repeat(2049)],
    ['sessionRecoverySource', 'unknown'],
    ['otelTraceContext', null],
    ['otelTraceContext', { traceId: 'trace' }],
    ['outputSpeed', -1],
    ['streamStartTime', '100'],
    ['wasThrottled', 'true']
] as const) {
    test(`pending normalization rejects invalid ${field}: ${String(invalidValue).slice(0, 40)}`, () => {
        assert.equal(normalizeUsagesPendingRecords([{ ...pendingRecord(), [field]: invalidValue }]), undefined);
    });
}

test('pending limits reject duplicates, count overflow and UTF-8 byte overflow without truncation', () => {
    assert.equal(normalizeUsagesPendingRecords(null), undefined);
    assert.equal(normalizeUsagesPendingRecords({}), undefined);
    assert.equal(normalizeUsagesPendingRecords([pendingRecord(), pendingRecord()]), undefined);
    assert.equal(
        normalizeUsagesPendingRecords(Array.from({ length: 101 }, (_, index) => pendingRecord(`${index}`))),
        undefined
    );
    assert.equal(
        normalizeUsagesPendingRecords(Array.from({ length: 100 }, (_, index) => pendingRecord(`${index}`)))?.length,
        100
    );
    assert.equal(
        normalizeUsagesPendingRecords(
            Array.from({ length: 100 }, (_, index) => ({
                ...pendingRecord(`${index}`),
                sessionTitle: '题'.repeat(2000)
            }))
        ),
        undefined
    );
});

test('accepts bounded results that match their original queries', () => {
    const record = {
        ...pendingRecord(),
        actualInput: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 25,
        totalTokens: 35
    };
    const summary = {
        requestCount: 1,
        totalTokens: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0
    };
    const totals = {
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        totalCostRmb: 0,
        nativeCosts: createEmptyNativeCostSplit(),
        costedRequests: 0,
        rmbExactRequests: 0
    };
    const nativeSplitIndex = {
        total: createEmptyNativeCostSplit(),
        providers: {},
        models: {},
        hours: {},
        hourProviders: {},
        hourModels: {}
    };

    assert.equal(
        isUsagesQueryResult({ kind: 'recentRecords', value: [record] }, { kind: 'recentRecords', limit: 1 }),
        true
    );
    assert.equal(
        isUsagesQueryResult(
            {
                kind: 'recordsPage',
                value: {
                    mode: 'all',
                    page: 1,
                    pageSize: 20,
                    totalItems: 1,
                    records: [record],
                    summary,
                    totals
                }
            },
            { kind: 'recordsPage', date: '2026-09-25', mode: 'all', page: 1, pageSize: 20 }
        ),
        true
    );
    assert.equal(
        isUsagesQueryResult(
            {
                kind: 'trackRecords',
                value: {
                    groups: [
                        { sessionId: 'session-a', records: [record] },
                        { sessionId: 'session-b', records: [] }
                    ]
                }
            },
            {
                kind: 'trackRecords',
                date: '2026-09-25',
                sessionIds: ['session-a', 'session-b'],
                limitPerSession: 1
            }
        ),
        true
    );
    assert.equal(
        isUsagesQueryResult(
            {
                kind: 'dateOverview',
                value: {
                    allSummary: summary,
                    allTotals: totals,
                    nativeSplitIndex,
                    sessionGroups: [
                        {
                            sessionId: 'session-a',
                            displayId: 'session',
                            summary,
                            totals,
                            recordCount: 1
                        }
                    ]
                }
            },
            { kind: 'dateOverview', date: '2026-09-25' }
        ),
        true
    );
    assert.equal(
        isUsagesQueryResult(
            { kind: 'sessionTitle', value: 'Resolved title' },
            { kind: 'sessionTitle', sessionId: 'session-a' }
        ),
        true
    );
});

test('rejects malformed records and results that do not match their original queries', () => {
    assert.equal(
        isUsagesQueryResult({ kind: 'recentRecords', value: [{}] }, { kind: 'recentRecords', limit: 1 }),
        false
    );
    assert.equal(
        isUsagesQueryResult(
            {
                kind: 'recordsPage',
                value: {
                    mode: 'all',
                    page: 2,
                    pageSize: 20,
                    totalItems: 0,
                    records: [],
                    summary: {
                        requestCount: 0,
                        totalTokens: 0,
                        completedCount: 0,
                        failedCount: 0,
                        cancelledCount: 0
                    },
                    totals: {}
                }
            },
            { kind: 'recordsPage', date: '2026-09-25', mode: 'all', page: 1, pageSize: 20 }
        ),
        false
    );
    assert.equal(
        isUsagesQueryResult(
            {
                kind: 'dateOverview',
                value: {
                    allSummary: {
                        requestCount: 1,
                        totalTokens: 0,
                        completedCount: 0,
                        failedCount: 0,
                        cancelledCount: 0
                    },
                    allTotals: {},
                    nativeSplitIndex: {},
                    sessionGroups: []
                }
            },
            { kind: 'dateOverview', date: '2026-09-25' }
        ),
        false
    );
});
