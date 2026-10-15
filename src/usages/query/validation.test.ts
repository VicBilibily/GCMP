import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeWebViewMessage } from '../../ui/configSetManager/types';
import type { SlotState, WebViewMessage } from '../../ui/configSetManager/types';
import { getBalanceWeight, isValidBalanceWeight } from '../../utils/config/balanceWeight';
import { initCards, renderAddForm, renderEditForm, renderSlotCards } from '../../ui/configSetManager/components/cards';
import { state, type State } from '../../ui/configSetManager/components/state';
import { createEmptyNativeCostSplit } from '../fileLogger/nativeCostSplit';
import type { UsagesPendingRecord, UsagesQuery } from './types';
import { isUsagesQueryResult, normalizeUsagesPendingRecords, normalizeUsagesQuery } from './validation';
import { recordsPageQuery, recordsPageResult } from './tests/recordsPageFixture';
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

test('pending classification whitelist deep copies evidence and does not forward secrets', () => {
    const record = { ...pendingRecord(), requestClassification: classification, requestContinuity: continuity };
    const input = {
        ...record,
        apiKey: 'top-level-secret',
        requestClassification: {
            ...classification,
            apiKey: 'classification-secret',
            evidence: {
                ...classification.evidence,
                origin: { ...classification.evidence.origin, prompt: 'prompt-secret' }
            }
        },
        requestContinuity: { ...continuity, token: 'continuity-secret' }
    };
    const normalized = normalizeUsagesPendingRecords([input]);
    assert.deepEqual(normalized, [record]);
    assert.notEqual(normalized?.[0].requestClassification, classification);
    assert.notEqual(
        normalized?.[0].requestClassification?.evidence.origin,
        input.requestClassification.evidence.origin
    );
    assert.notEqual(normalized?.[0].requestContinuity, input.requestContinuity);
    assert.doesNotMatch(JSON.stringify(normalized), /secret/);
});

for (const badMetadata of [null, { version: 2 }, { ...classification, requestOrigin: 'future-origin' }]) {
    test(`pending and query validation locally degrade metadata ${JSON.stringify(badMetadata)}`, () => {
        const bad = {
            ...pendingRecord(),
            requestKind: 'future-kind',
            requestClassification: badMetadata,
            requestContinuity: { ...continuity, scope: 'future-scope' }
        };
        const pending = normalizeUsagesPendingRecords([bad]);
        assert.equal(pending?.length, 1);
        assert.equal(pending?.[0].requestClassification, undefined);
        assert.equal(pending?.[0].requestContinuity, undefined);
        assert.equal(pending?.[0].requestKind, 'future-kind');
        assert.equal(pending?.[0].estimatedInput, 10);
        const query = recordsPageQuery(1);
        const record = {
            ...pendingRecord(),
            status: 'completed' as const,
            rawUsage: { prompt_tokens: 10, completion_tokens: 5 },
            estimatedCost: 0.125,
            actualInput: 10,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 5,
            totalTokens: 15
        };
        const result = {
            kind: 'recordsPage',
            value: {
                ...recordsPageResult(query, [record]),
                records: [
                    {
                        ...record,
                        ...bad,
                        status: record.status,
                        rawUsage: record.rawUsage,
                        estimatedCost: record.estimatedCost
                    }
                ]
            }
        };
        assert.equal(isUsagesQueryResult(result, query), true);
        assert.equal(result.value.records[0].requestClassification, undefined);
        assert.equal(result.value.records[0].requestContinuity, undefined);
        assert.equal(result.value.records[0].estimatedCost, 0.125);
        assert.equal(result.value.records[0].totalTokens, 15);
    });
}

test('query validation preserves valid classification payload without changing totals', () => {
    const query = recordsPageQuery(1);
    const record = {
        ...pendingRecord(),
        requestClassification: classification,
        requestContinuity: continuity,
        actualInput: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 25,
        totalTokens: 35
    };
    const result = { kind: 'recordsPage', value: recordsPageResult(query, [record]) };
    assert.equal(isUsagesQueryResult(result, query), true);
    assert.deepEqual(result.value.records[0].requestClassification, classification);
    assert.deepEqual(result.value.records[0].requestContinuity, continuity);
});

test('SDK session bridge survives pending and query transport without extending the strict recovery enum', () => {
    const record = pendingRecord();
    delete record.sessionRecoverySource;
    record.requestKind = 'summarization';
    record.requestContinuity = { version: 1, scope: 'chain', source: 'sdk-session' };
    assert.deepEqual(normalizeUsagesPendingRecords(JSON.parse(JSON.stringify([record])) as unknown), [record]);
    const query = recordsPageQuery(1);
    const result = {
        kind: 'recordsPage',
        value: recordsPageResult(query, [
            {
                ...record,
                actualInput: 10,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 5,
                totalTokens: 15
            }
        ])
    };
    assert.equal(isUsagesQueryResult(result, query), true);
    assert.equal(result.value.records[0].sessionRecoverySource, undefined);
    assert.deepEqual(result.value.records[0].requestContinuity, record.requestContinuity);
    const future = normalizeUsagesPendingRecords([
        { ...record, requestContinuity: { ...record.requestContinuity, source: 'future-session' } }
    ]);
    assert.equal(future?.length, 1);
    assert.equal(future?.[0].requestKind, 'summarization');
    assert.equal(future?.[0].requestContinuity, undefined);
});

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
    for (const pageSize of [1, 100]) {
        const query = recordsPageQuery(pageSize);
        assert.deepEqual(normalizeUsagesQuery(query), { ...query, sessionId: undefined });
    }
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
        { kind: 'recordsPage', date: '2026-09-24', mode: 'all', page: 1, pageSize: 0 },
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
        apiKeyHash: 'a'.repeat(64),
        apiKeyName: '主要 Key',
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
    assert.deepEqual(normalizeUsagesPendingRecords(normalized), normalized);
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
    ['apiKeyHash', null],
    ['apiKeyHash', 1],
    ['apiKeyHash', 'a'.repeat(63)],
    ['apiKeyHash', 'a'.repeat(65)],
    ['apiKeyHash', 'z'.repeat(64)],
    ['apiKeyName', null],
    ['apiKeyName', {}],
    ['apiKeyName', 'x'.repeat(8193)],
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
    ['streamStartTime', -1],
    ['wasThrottled', 'true']
] as const) {
    test(`pending normalization rejects invalid ${field}: ${String(invalidValue).slice(0, 40)}`, () => {
        assert.equal(normalizeUsagesPendingRecords([{ ...pendingRecord(), [field]: invalidValue }]), undefined);
    });
}

test('pending key identity survives JSON transport without exposing unsupported secret fields', () => {
    const record = pendingRecord();
    const serialized = JSON.stringify([{ ...record, apiKey: 'fake-raw-key' }]);
    const normalized = normalizeUsagesPendingRecords(JSON.parse(serialized) as unknown);
    assert.deepEqual(normalized, [record]);
    assert.equal(JSON.stringify(normalized).includes('fake-raw-key'), false);
    assert.deepEqual(normalizeUsagesPendingRecords(normalized), normalized);
});

test('pending key metadata remains optional and accepts bounded names', () => {
    const legacy = pendingRecord();
    delete legacy.apiKeyHash;
    delete legacy.apiKeyName;
    assert.deepEqual(normalizeUsagesPendingRecords([legacy]), [legacy]);
    const unnamed = { ...legacy, apiKeyHash: 'b'.repeat(64) };
    assert.deepEqual(normalizeUsagesPendingRecords([unnamed]), [unnamed]);
    const longName = { ...pendingRecord(), apiKeyName: 'x'.repeat(2048) };
    assert.deepEqual(normalizeUsagesPendingRecords([longName]), [longName]);
});

for (const length of [2049, 8192]) {
    test(`configuration names of ${length} characters survive pending and result validation`, () => {
        const message = sanitizeWebViewMessage({
            command: 'edit',
            slot: 'test',
            id: 'primary',
            label: '名'.repeat(length)
        });
        assert.ok(message?.command === 'edit');
        const record = { ...pendingRecord(), apiKeyName: message.label };
        assert.deepEqual(normalizeUsagesPendingRecords(JSON.parse(JSON.stringify([record])) as unknown), [record]);
        const query = recordsPageQuery(1);
        assert.equal(
            isUsagesQueryResult(
                {
                    kind: 'recordsPage',
                    value: recordsPageResult(query, [
                        {
                            ...record,
                            actualInput: 10,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            outputTokens: 25,
                            totalTokens: 35
                        }
                    ])
                },
                query
            ),
            true
        );
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
    assert.equal(
        normalizeUsagesPendingRecords(
            Array.from({ length: 100 }, (_, index) => ({
                ...pendingRecord(`${index}`),
                apiKeyName: '名'.repeat(2000)
            }))
        ),
        undefined
    );
});

for (const [field, invalidValue] of [
    ['apiKeyHash', null],
    ['apiKeyHash', 1],
    ['apiKeyHash', 'a'.repeat(63)],
    ['apiKeyHash', 'a'.repeat(65)],
    ['apiKeyHash', 'z'.repeat(64)],
    ['apiKeyName', null],
    ['apiKeyName', {}],
    ['apiKeyName', 'x'.repeat(8193)]
] as const) {
    test(`remote query results reject invalid ${field}: ${String(invalidValue).slice(0, 40)}`, () => {
        const validRecord = {
            ...pendingRecord(),
            actualInput: 10,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 25,
            totalTokens: 35
        };
        const query = recordsPageQuery(1);
        assert.equal(
            isUsagesQueryResult(
                {
                    kind: 'recordsPage',
                    value: {
                        ...recordsPageResult(query, [validRecord]),
                        records: [{ ...validRecord, [field]: invalidValue }]
                    }
                },
                query
            ),
            false
        );
    });
}

test('query totals validate average output duration', () => {
    const query: UsagesQuery = { kind: 'recordsPage', date: '2026-09-26', mode: 'all', page: 1, pageSize: 20 };
    const result = {
        kind: 'recordsPage',
        value: {
            mode: 'all',
            page: 1,
            pageSize: 20,
            totalItems: 0,
            records: [],
            summary: { requestCount: 0, totalTokens: 0, completedCount: 0, failedCount: 0, cancelledCount: 0 },
            totals: {
                inputTokens: 0,
                cacheTokens: 0,
                outputTokens: 0,
                avgOutputDuration: 2000,
                totalCost: 0,
                totalCostRmb: 0,
                nativeCosts: createEmptyNativeCostSplit(),
                costedRequests: 0,
                rmbExactRequests: 0
            }
        }
    };
    assert.equal(isUsagesQueryResult(result, query), true);
    assert.equal(isUsagesQueryResult(JSON.parse(JSON.stringify(result)), query), true);
    for (const [field, value] of [
        ['avgOutputDuration', -1],
        ['avgOutputDuration', Number.NaN],
        ['avgOutputDuration', Number.POSITIVE_INFINITY],
        ['avgOutputDuration', '2000']
    ] as const) {
        assert.equal(
            isUsagesQueryResult(
                { ...result, value: { ...result.value, totals: { ...result.value.totals, [field]: value } } },
                query
            ),
            false,
            `${field}: ${String(value)}`
        );
    }
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

    const boundedPageQuery = recordsPageQuery(1);
    assert.equal(
        isUsagesQueryResult(
            { kind: 'recordsPage', value: recordsPageResult(boundedPageQuery, [record]) },
            boundedPageQuery
        ),
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
                    ],
                    initialRecordsPage: {
                        mode: 'all',
                        page: 1,
                        pageSize: 20,
                        totalItems: 1,
                        records: [record],
                        summary,
                        totals
                    }
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
    const record = {
        ...pendingRecord(),
        actualInput: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 25,
        totalTokens: 35
    };
    const query = recordsPageQuery(1);
    assert.equal(
        isUsagesQueryResult(
            { kind: 'recordsPage', value: { ...recordsPageResult(query, [record]), records: [{}] } },
            query
        ),
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
                    allTotals: {
                        inputTokens: 0,
                        cacheTokens: 0,
                        outputTokens: 0,
                        totalCost: 0,
                        totalCostRmb: 0,
                        nativeCosts: createEmptyNativeCostSplit(),
                        costedRequests: 0,
                        rmbExactRequests: 0
                    },
                    nativeSplitIndex: {
                        total: createEmptyNativeCostSplit(),
                        providers: {},
                        models: {},
                        hours: {},
                        hourProviders: {},
                        hourModels: {}
                    },
                    sessionGroups: [],
                    initialRecordsPage: {
                        mode: 'all',
                        page: 1,
                        pageSize: 20,
                        totalItems: 2,
                        records: [record],
                        summary: {
                            requestCount: 2,
                            totalTokens: 0,
                            completedCount: 0,
                            failedCount: 0,
                            cancelledCount: 0
                        },
                        totals: {
                            inputTokens: 0,
                            cacheTokens: 0,
                            outputTokens: 0,
                            totalCost: 0,
                            totalCostRmb: 0,
                            nativeCosts: createEmptyNativeCostSplit(),
                            costedRequests: 0,
                            rmbExactRequests: 0
                        }
                    }
                }
            },
            { kind: 'dateOverview', date: '2026-09-25' }
        ),
        false
    );
});

test('balance weight defaults to one and accepts integer boundaries without coercion', () => {
    assert.equal(getBalanceWeight({}), 1);
    assert.equal(isValidBalanceWeight(undefined), true);
    for (const balanceWeight of [0, 1, 50, 100]) {
        assert.equal(isValidBalanceWeight(balanceWeight), true);
        assert.equal(getBalanceWeight({ balanceWeight }), balanceWeight);
        for (const command of ['add', 'edit'] as const) {
            const message = sanitizeWebViewMessage({
                command,
                slot: 'slot',
                id: 'id',
                label: 'Name',
                apiKey: ' key ',
                balanceWeight
            });
            assert.ok(message?.command === command);
            assert.equal(message.balanceWeight, balanceWeight);
            assert.equal(message.apiKey, 'key');
        }
    }
    for (const command of ['add', 'edit'] as const) {
        const message = sanitizeWebViewMessage({ command, slot: 'slot', id: 'id', label: 'Name', apiKey: 'key' });
        assert.ok(message?.command === command);
        assert.equal(message.balanceWeight, undefined);
    }
});

for (const value of [-1, 0.5, 101, Number.NaN, Infinity, -Infinity, '0', '', null, true, [], {}]) {
    test(`balance weight rejects invalid persisted values and messages: ${String(value)}`, () => {
        assert.equal(isValidBalanceWeight(value), false);
        assert.throws(
            () => getBalanceWeight({ balanceWeight: value } as unknown as { balanceWeight?: number }),
            RangeError
        );
        for (const command of ['add', 'edit'] as const) {
            assert.equal(
                sanitizeWebViewMessage({
                    command,
                    slot: 'slot',
                    id: 'id',
                    label: 'Name',
                    apiKey: 'key',
                    balanceWeight: value
                }),
                undefined
            );
        }
    });
}

test('weight form inputs preserve drafts, reject invalid numbers and submit numeric weights in both locales', () => {
    class Element {
        className = '';
        textContent = '';
        value = '';
        type = '';
        min = '';
        max = '';
        step = '';
        title = '';
        innerHTML = '';
        required = false;
        disabled = false;
        children: Element[] = [];
        listeners = new Map<string, () => void>();
        constructor(readonly tag: string) {}
        get valueAsNumber(): number {
            return this.value === '' ? Number.NaN : Number(this.value);
        }
        appendChild(child: Element): Element {
            this.children.push(child);
            return child;
        }
        addEventListener(event: string, callback: () => void): void {
            this.listeners.set(event, callback);
        }
        fire(event: string): void {
            this.listeners.get(event)?.();
        }
        all(): Element[] {
            return [this, ...this.children.flatMap(child => child.all())];
        }
    }
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedState = { ...state };
    const posts: WebViewMessage[] = [];
    const bar = new Element('div');
    const dom = {
        documentElement: { lang: 'zh-cn' },
        createElement: (tag: string) => new Element(tag),
        querySelector: () => bar
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: dom });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { vscode: { postMessage: (message: WebViewMessage) => posts.push(message) } }
    });
    let renders = 0;
    initCards({
        render: () => {
            renders++;
        },
        renderDeleteDialog() {},
        renderDeactivateDialog() {}
    });
    const slot: SlotState = {
        slot: 'slot',
        displayName: 'Slot',
        isMain: true,
        hasSite: false,
        switchMode: 'off',
        hasUsage: false,
        rows: []
    };
    const weightInput = (panel: Element): Element => {
        const input = panel.all().find(node => node.type === 'number');
        assert.ok(input);
        assert.deepEqual([input.min, input.max, input.step, input.required], ['0', '100', '1', true]);
        const field = panel.all().find(node => node.className === 'csm-field' && node.children.includes(input));
        assert.ok(field);
        assert.equal(field.children[0].textContent, dom.documentElement.lang === 'en' ? 'Weight' : '权重');
        assert.equal(
            input.title,
            dom.documentElement.lang === 'en' ?
                'Weight only applies to failover and load balancing. A weight of 0 excludes this configuration from new automatic assignments.'
            :   '权重仅在故障切换和负载均衡模式下生效。权重为 0 时，该配置不参与新的自动分配。'
        );
        const hint = field.children[2];
        assert.equal(hint?.className, 'csm-field-hint');
        assert.equal(hint.textContent, input.title);
        return input;
    };
    try {
        for (const locale of ['zh-cn', 'en']) {
            dom.documentElement.lang = locale;
            state.busy = false;
            state.addFormDraft = null;
            state.editFormDraft = null;
            posts.length = 0;
            let panel = renderAddForm(slot, undefined) as unknown as Element;
            assert.equal(weightInput(panel).value, '1');
            const inputs = panel.all().filter(node => node.tag === 'input');
            inputs[0].value = 'New';
            inputs[0].fire('input');
            inputs[1].value = 'key';
            inputs[1].fire('input');
            weightInput(panel).value = '0';
            weightInput(panel).fire('input');
            panel = renderAddForm(slot, undefined) as unknown as Element;
            assert.equal(weightInput(panel).value, '0');
            panel
                .all()
                .filter(node => node.tag === 'button')
                .at(-1)
                ?.fire('click');
            assert.ok(posts[0]?.command === 'add');
            assert.equal(posts[0].balanceWeight, 0);
            assert.equal((state as State).addFormDraft?.balanceWeight, '0');
            const row = { id: 'id', label: 'Old', isActive: true, balanceWeight: 0 };
            state.busy = false;
            panel = renderEditForm(slot, row) as unknown as Element;
            assert.equal(weightInput(panel).value, '0');
            assert.equal(
                weightInput(renderEditForm(slot, { ...row, balanceWeight: undefined }) as unknown as Element).value,
                '1'
            );
            for (const invalid of ['', '-1', '0.5', '101', 'NaN', 'Infinity']) {
                weightInput(panel).value = invalid;
                weightInput(panel).fire('input');
                panel
                    .all()
                    .filter(node => node.tag === 'button')
                    .at(-1)
                    ?.fire('click');
                assert.equal(posts.length, 1);
                assert.equal(state.busy, false);
            }
            panel = renderEditForm(slot, row) as unknown as Element;
            assert.equal(weightInput(panel).value, 'Infinity');
            weightInput(panel).value = '100';
            weightInput(panel).fire('input');
            panel = renderEditForm(slot, row) as unknown as Element;
            assert.equal(weightInput(panel).value, '100');
            panel
                .all()
                .filter(node => node.tag === 'button')
                .at(-1)
                ?.fire('click');
            assert.ok(posts[1]?.command === 'edit');
            assert.equal(posts[1].balanceWeight, 100);
            for (const switchMode of ['off', 'failover', 'balance'] as const) {
                state.editFormKey = null;
                for (const balanceWeight of [undefined, 0, 1, 100]) {
                    for (const isActive of [false, true]) {
                        const card = renderSlotCards({
                            ...slot,
                            switchMode,
                            rows: [{ ...row, balanceWeight, isActive }]
                        }) as unknown as Element;
                        const head = card.all().find(node => node.className === 'csm-config-card-head');
                        assert.ok(head);
                        const badges = head.children.find(node => node.className === 'csm-config-card-actions');
                        const weight = card.all().find(node => node.className.includes('csm-config-card-weight'));
                        if (balanceWeight === undefined) {
                            assert.equal(weight, undefined);
                            assert.equal(
                                card.all().some(node => /weight|权重/i.test(node.textContent)),
                                false
                            );
                        } else {
                            assert.ok(weight);
                            assert.ok(badges?.children.includes(weight));
                            assert.equal(weight.textContent, `${locale === 'en' ? 'Weight' : '权重'} ${balanceWeight}`);
                            if (balanceWeight === 0) {
                                assert.match(
                                    weight.title,
                                    locale === 'en' ?
                                        /excluded from failover and load balancing/
                                    :   /不参与故障切换和负载均衡/
                                );
                            }
                        }
                        const activeBadge = head
                            .all()
                            .find(node => node.textContent === (locale === 'en' ? 'In use' : '使用中'));
                        assert.equal(!!activeBadge, isActive);
                        if (activeBadge) {
                            assert.equal(badges?.children.at(-1), activeBadge);
                        }
                        assert.equal(
                            card
                                .all()
                                .some(
                                    node =>
                                        node.className === 'csm-config-meta-label' &&
                                        /weight|权重/i.test(node.textContent)
                                ),
                            false
                        );
                    }
                }
            }
        }
        assert.equal(renders, 4);
    } finally {
        Object.assign(state, savedState);
        initCards({ render() {}, renderDeleteDialog() {}, renderDeactivateDialog() {} });
        for (const [name, descriptor] of [
            ['document', documentDescriptor],
            ['window', windowDescriptor]
        ] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    }
});
