import type { SessionRecoverySource } from '../fileLogger/types';
import type { UsagesPendingRecord, UsagesQuery, UsagesQueryResult } from './types';

const MAX_PAGE_SIZE = 100;
const MAX_TRACKED_SESSIONS = 3;
const MAX_TRACKED_RECORDS_PER_SESSION = 100;
const MAX_RECENT_RECORDS = 100;
const MAX_SESSION_ID_LENGTH = 512;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PENDING_RECORDS = 100;
const MAX_PENDING_BYTES = 256 * 1024;
const SESSION_RECOVERY_SOURCES = new Set<SessionRecoverySource>([
    'stateful-marker',
    'trace-bridge',
    'turn-bridge',
    'summary-bridge-exact',
    'summary-bridge-embedded',
    'summary-bridge-truncated',
    'new-uuid'
]);

export function normalizeUsagesQuery(query: UsagesQuery): UsagesQuery | undefined {
    if (!query || typeof query !== 'object' || typeof query.kind !== 'string') {
        return undefined;
    }

    switch (query.kind) {
        case 'dateOverview':
            return isDate(query.date) ? { kind: query.kind, date: query.date } : undefined;
        case 'recordsPage': {
            if (
                !isDate(query.date) ||
                (query.mode !== 'all' && query.mode !== 'session') ||
                !isPositiveInteger(query.page) ||
                !isPositiveInteger(query.pageSize) ||
                query.pageSize > MAX_PAGE_SIZE ||
                (query.mode === 'session' && !isSessionId(query.sessionId))
            ) {
                return undefined;
            }
            return {
                kind: query.kind,
                date: query.date,
                mode: query.mode,
                sessionId: query.mode === 'session' ? query.sessionId : undefined,
                page: query.page,
                pageSize: query.pageSize
            };
        }
        case 'trackRecords':
            if (
                !isDate(query.date) ||
                !Array.isArray(query.sessionIds) ||
                query.sessionIds.length < 2 ||
                query.sessionIds.length > MAX_TRACKED_SESSIONS ||
                !query.sessionIds.every(isSessionId) ||
                new Set(query.sessionIds).size !== query.sessionIds.length ||
                !isPositiveInteger(query.limitPerSession) ||
                query.limitPerSession > MAX_TRACKED_RECORDS_PER_SESSION
            ) {
                return undefined;
            }
            return {
                kind: query.kind,
                date: query.date,
                sessionIds: [...query.sessionIds],
                limitPerSession: query.limitPerSession
            };
        case 'recentRecords':
            return isPositiveInteger(query.limit) && query.limit <= MAX_RECENT_RECORDS ? { ...query } : undefined;
        case 'sessionTitle':
            return isSessionId(query.sessionId) ? { ...query } : undefined;
    }
}

export function isUsagesQueryResult(result: unknown, query: UsagesQuery): result is UsagesQueryResult {
    if (!isRecord(result) || result.kind !== query.kind) {
        return false;
    }

    const value = result.value;
    switch (query.kind) {
        case 'sessionTitle':
            return value === undefined || (typeof value === 'string' && value.length <= 2048);
        case 'recentRecords':
            return Array.isArray(value) && value.length <= query.limit && value.every(isExtendedRecord);
        case 'trackRecords':
            return (
                isRecord(value) &&
                Array.isArray(value.groups) &&
                value.groups.length === query.sessionIds.length &&
                value.groups.every(
                    (group, index) =>
                        isRecord(group) &&
                        group.sessionId === query.sessionIds[index] &&
                        Array.isArray(group.records) &&
                        group.records.length <= query.limitPerSession &&
                        group.records.every(isExtendedRecord)
                )
            );
        case 'recordsPage': {
            if (
                !isRecord(value) ||
                value.mode !== query.mode ||
                value.sessionId !== (query.mode === 'session' ? query.sessionId : undefined) ||
                value.page !== query.page ||
                value.pageSize !== query.pageSize ||
                !isNonNegativeInteger(value.totalItems) ||
                !Array.isArray(value.records) ||
                value.records.length > query.pageSize ||
                !value.records.every(isExtendedRecord) ||
                !isSessionSummary(value.summary) ||
                value.summary.requestCount !== value.totalItems ||
                !isRequestTotals(value.totals) ||
                (value.recoveryDebug !== undefined && !isRecoveryDebugSummary(value.recoveryDebug))
            ) {
                return false;
            }
            const pageStart = (query.page - 1) * query.pageSize;
            return value.records.length <= Math.max(0, value.totalItems - pageStart);
        }
        case 'dateOverview':
            if (
                !isRecord(value) ||
                !isSessionSummary(value.allSummary) ||
                !isRequestTotals(value.allTotals) ||
                !isNativeCostSplitIndex(value.nativeSplitIndex) ||
                !Array.isArray(value.sessionGroups) ||
                !value.sessionGroups.every(isSessionGroupSummary)
            ) {
                return false;
            }
            return (
                value.sessionGroups.reduce((total, group) => total + group.recordCount, 0) ===
                value.allSummary.requestCount
            );
    }
}

function isDate(value: unknown): value is string {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
        return false;
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isSessionId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function normalizeUsagesPendingRecords(value: unknown): UsagesPendingRecord[] | undefined {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > MAX_PENDING_RECORDS) {
        return undefined;
    }
    const records: UsagesPendingRecord[] = [];
    const requestIds = new Set<string>();
    for (const entry of value) {
        const record = normalizePendingRecord(entry);
        if (!record || requestIds.has(record.requestId)) {
            return undefined;
        }
        records.push(record);
        requestIds.add(record.requestId);
    }
    return Buffer.byteLength(JSON.stringify(records), 'utf8') <= MAX_PENDING_BYTES ? records : undefined;
}

function normalizePendingRecord(value: unknown): UsagesPendingRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const entry = value as Record<string, unknown>;
    if (
        entry.status !== 'estimated' ||
        entry.rawUsage !== null ||
        entry.estimatedCost !== undefined ||
        entry.costBreakdown !== undefined ||
        !isNonNegativeFinite(entry.timestamp) ||
        Number.isNaN(new Date(entry.timestamp).getTime()) ||
        entry.isoTime !== new Date(entry.timestamp).toISOString() ||
        !isNonNegativeFinite(entry.estimatedInput)
    ) {
        return undefined;
    }
    for (const key of ['requestId', 'providerKey', 'providerName', 'modelId', 'modelName'] as const) {
        const text = entry[key];
        if (typeof text !== 'string' || !text || text.length > (key === 'requestId' ? 128 : 512)) {
            return undefined;
        }
    }
    const record: UsagesPendingRecord = {
        requestId: entry.requestId as string,
        timestamp: entry.timestamp,
        isoTime: entry.isoTime as string,
        providerKey: entry.providerKey as string,
        providerName: entry.providerName as string,
        modelId: entry.modelId as string,
        modelName: entry.modelName as string,
        estimatedInput: entry.estimatedInput,
        status: 'estimated',
        rawUsage: null
    };
    for (const key of [
        'sessionId',
        'sessionTitle',
        'requestKind',
        'requestInitiator',
        'capturingTokenCorrelationId'
    ] as const) {
        const text = entry[key];
        if (text !== undefined) {
            if (typeof text !== 'string' || text.length > (key === 'sessionTitle' ? 2048 : 512)) {
                return undefined;
            }
            record[key] = text;
        }
    }
    for (const key of [
        'estimatedIncrement',
        'maxInputTokens',
        'telemetryTurn',
        'requestMetricStartTime',
        'streamStartTime',
        'streamEndTime',
        'outputSpeed',
        'outputTokens'
    ] as const) {
        const number = entry[key];
        if (number !== undefined) {
            if (!isNonNegativeFinite(number)) {
                return undefined;
            }
            record[key] = number;
        }
    }
    if (entry.wasThrottled !== undefined) {
        if (typeof entry.wasThrottled !== 'boolean') {
            return undefined;
        }
        record.wasThrottled = entry.wasThrottled;
    }
    if (entry.sessionRecoverySource !== undefined) {
        if (!SESSION_RECOVERY_SOURCES.has(entry.sessionRecoverySource as SessionRecoverySource)) {
            return undefined;
        }
        record.sessionRecoverySource = entry.sessionRecoverySource as SessionRecoverySource;
    }
    if (entry.otelTraceContext !== undefined) {
        const trace = entry.otelTraceContext as Partial<{ traceId: unknown; spanId: unknown }> | null;
        if (
            !trace ||
            typeof trace.traceId !== 'string' ||
            !trace.traceId ||
            trace.traceId.length > 128 ||
            typeof trace.spanId !== 'string' ||
            !trace.spanId ||
            trace.spanId.length > 128
        ) {
            return undefined;
        }
        record.otelTraceContext = { traceId: trace.traceId, spanId: trace.spanId };
    }
    return record;
}

function isNonNegativeFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isOptionalNonNegativeFinite(value: unknown): boolean {
    return value === undefined || isNonNegativeFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown, maxLength = 2048): boolean {
    return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function isExtendedRecord(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    for (const key of ['requestId', 'isoTime', 'providerKey', 'providerName', 'modelId', 'modelName'] as const) {
        if (typeof value[key] !== 'string' || value[key].length === 0) {
            return false;
        }
    }
    if (
        !isNonNegativeFinite(value.timestamp) ||
        !isNonNegativeFinite(value.estimatedInput) ||
        !['estimated', 'completed', 'failed', 'cancelled'].includes(value.status as string) ||
        !(value.rawUsage === null || isRecord(value.rawUsage))
    ) {
        return false;
    }
    for (const key of [
        'actualInput',
        'cacheReadTokens',
        'cacheCreationTokens',
        'outputTokens',
        'totalTokens'
    ] as const) {
        if (!isNonNegativeFinite(value[key])) {
            return false;
        }
    }
    for (const key of [
        'estimatedIncrement',
        'maxInputTokens',
        'telemetryTurn',
        'requestMetricStartTime',
        'streamStartTime',
        'streamEndTime',
        'streamDuration',
        'outputSpeed',
        'estimatedCost'
    ] as const) {
        if (!isOptionalNonNegativeFinite(value[key])) {
            return false;
        }
    }
    for (const key of [
        'sessionId',
        'sessionTitle',
        'requestKind',
        'requestInitiator',
        'capturingTokenCorrelationId',
        'sessionRecoverySource'
    ] as const) {
        if (!isOptionalString(value[key])) {
            return false;
        }
    }
    if (value.wasThrottled !== undefined && typeof value.wasThrottled !== 'boolean') {
        return false;
    }
    if (value.otelTraceContext !== undefined) {
        if (
            !isRecord(value.otelTraceContext) ||
            typeof value.otelTraceContext.traceId !== 'string' ||
            !value.otelTraceContext.traceId ||
            typeof value.otelTraceContext.spanId !== 'string' ||
            !value.otelTraceContext.spanId
        ) {
            return false;
        }
    }
    return value.costBreakdown === undefined || isRecord(value.costBreakdown);
}

function isSessionSummary(value: unknown): value is Record<string, number | undefined> & { requestCount: number } {
    if (!isRecord(value)) {
        return false;
    }
    const requestCount = value.requestCount;
    const completedCount = value.completedCount;
    const failedCount = value.failedCount;
    const cancelledCount = value.cancelledCount;
    if (
        !isNonNegativeInteger(requestCount) ||
        !isNonNegativeInteger(completedCount) ||
        !isNonNegativeInteger(failedCount) ||
        !isNonNegativeInteger(cancelledCount)
    ) {
        return false;
    }
    return (
        isNonNegativeFinite(value.totalTokens) &&
        isOptionalNonNegativeFinite(value.startTime) &&
        isOptionalNonNegativeFinite(value.endTime) &&
        isOptionalNonNegativeFinite(value.avgSpeed) &&
        completedCount + failedCount + cancelledCount <= requestCount
    );
}

function isRequestTotals(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }
    for (const key of ['inputTokens', 'cacheTokens', 'outputTokens', 'totalCost', 'totalCostRmb'] as const) {
        if (!isNonNegativeFinite(value[key])) {
            return false;
        }
    }
    return (
        isOptionalNonNegativeFinite(value.avgLatency) &&
        isOptionalNonNegativeFinite(value.avgDuration) &&
        isNativeCostSplit(value.nativeCosts) &&
        isNonNegativeInteger(value.costedRequests) &&
        isNonNegativeInteger(value.rmbExactRequests)
    );
}

const NATIVE_COST_SPLIT_KEYS = [
    'totalUsd',
    'totalRmb',
    'inputUsd',
    'inputRmb',
    'outputUsd',
    'outputRmb',
    'cacheReadUsd',
    'cacheReadRmb',
    'cacheWriteUsd',
    'cacheWriteRmb'
] as const;

function isNativeCostSplit(value: unknown): boolean {
    return isRecord(value) && NATIVE_COST_SPLIT_KEYS.every(key => isNonNegativeFinite(value[key]));
}

function isRecordMap(value: unknown, validate: (entry: unknown) => boolean): boolean {
    return isRecord(value) && Object.values(value).every(validate);
}

function isNativeCostSplitIndex(value: unknown): boolean {
    return (
        isRecord(value) &&
        isNativeCostSplit(value.total) &&
        isRecordMap(value.providers, isNativeCostSplit) &&
        isRecordMap(value.models, provider => isRecordMap(provider, isNativeCostSplit)) &&
        isRecordMap(value.hours, isNativeCostSplit) &&
        isRecordMap(value.hourProviders, hour => isRecordMap(hour, isNativeCostSplit)) &&
        isRecordMap(value.hourModels, hour => isRecordMap(hour, provider => isRecordMap(provider, isNativeCostSplit)))
    );
}

function isRecoveryDebugSummary(value: unknown): boolean {
    return isRecord(value) && isNonNegativeInteger(value.bridgeCount) && isNonNegativeInteger(value.newUuidCount);
}

function isSessionGroupSummary(value: unknown): value is Record<string, unknown> & { recordCount: number } {
    return (
        isRecord(value) &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        typeof value.displayId === 'string' &&
        value.displayId.length > 0 &&
        isOptionalString(value.title) &&
        isSessionSummary(value.summary) &&
        isRequestTotals(value.totals) &&
        isNonNegativeInteger(value.recordCount) &&
        value.recordCount === value.summary.requestCount &&
        (value.recoveryDebug === undefined || isRecoveryDebugSummary(value.recoveryDebug))
    );
}
