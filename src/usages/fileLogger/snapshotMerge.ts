export interface SnapshotRequestRecord {
    requestId: string;
    timestamp: number;
    isoTime: string;
    providerKey: string;
    providerName: string;
    modelId: string;
    modelName: string;
    estimatedInput: number;
    rawUsage: Record<string, unknown> | null;
    status: 'estimated' | 'completed' | 'failed' | 'cancelled';
    maxInputTokens?: number;
    requestKind?: string;
    sessionId?: string;
    requestInitiator?: string;
    capturingTokenCorrelationId?: string;
    otelTraceContext?: { traceId: string; spanId: string };
    streamStartTime?: number;
    streamEndTime?: number;
    actualInput?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheCreation?: number;
    streamDuration?: number;
    outputSpeed?: number;
}

export type SnapshotFile = Record<string, SnapshotRequestRecord>;

function getStatusRank(status: SnapshotRequestRecord['status']): number {
    switch (status) {
        case 'completed':
        case 'failed':
        case 'cancelled':
            return 2;
        case 'estimated':
        default:
            return 1;
    }
}

function isSnapshotRequestRecord(value: unknown): value is SnapshotRequestRecord {
    const record = value as Partial<SnapshotRequestRecord> | null;
    return (
        !!record && typeof record === 'object' && typeof record.requestId === 'string' && record.requestId.length > 0
    );
}

export function parseSnapshotFileContent(content: string): SnapshotFile {
    const store: SnapshotFile = {};
    const lines = content.split('\n').filter(line => line.trim());
    for (const line of lines) {
        try {
            const record = JSON.parse(line) as unknown;
            if (isSnapshotRequestRecord(record)) {
                store[record.requestId] = record;
            }
        } catch {
            /* 跳过损坏行 */
        }
    }
    return store;
}

export function stringifySnapshotFile(store: SnapshotFile): string {
    return Object.keys(store)
        .map(requestId => JSON.stringify(store[requestId]))
        .join('\n');
}

export function mergeSnapshotRecord(
    baseRecord: SnapshotRequestRecord,
    overlayRecord: SnapshotRequestRecord
): SnapshotRequestRecord {
    const baseRank = getStatusRank(baseRecord.status);
    const overlayRank = getStatusRank(overlayRecord.status);
    const preferredRecord = overlayRank >= baseRank ? overlayRecord : baseRecord;
    const fallbackRecord = preferredRecord === overlayRecord ? baseRecord : overlayRecord;

    return {
        ...fallbackRecord,
        ...preferredRecord,
        timestamp: Math.min(baseRecord.timestamp, overlayRecord.timestamp),
        isoTime: overlayRecord.timestamp < baseRecord.timestamp ? overlayRecord.isoTime : baseRecord.isoTime,
        status: preferredRecord.status,
        rawUsage: preferredRecord.rawUsage ?? fallbackRecord.rawUsage ?? null,
        streamStartTime: preferredRecord.streamStartTime ?? fallbackRecord.streamStartTime,
        streamEndTime: preferredRecord.streamEndTime ?? fallbackRecord.streamEndTime,
        actualInput: preferredRecord.actualInput ?? fallbackRecord.actualInput,
        outputTokens: preferredRecord.outputTokens ?? fallbackRecord.outputTokens,
        totalTokens: preferredRecord.totalTokens ?? fallbackRecord.totalTokens,
        cacheRead: preferredRecord.cacheRead ?? fallbackRecord.cacheRead,
        cacheCreation: preferredRecord.cacheCreation ?? fallbackRecord.cacheCreation,
        streamDuration: preferredRecord.streamDuration ?? fallbackRecord.streamDuration,
        outputSpeed: preferredRecord.outputSpeed ?? fallbackRecord.outputSpeed
    };
}

export function mergeSnapshotFiles(baseStore: SnapshotFile, overlayStore: SnapshotFile): SnapshotFile {
    const result: SnapshotFile = { ...baseStore };
    for (const [requestId, overlayRecord] of Object.entries(overlayStore)) {
        const baseRecord = result[requestId];
        result[requestId] = baseRecord ? mergeSnapshotRecord(baseRecord, overlayRecord) : { ...overlayRecord };
    }
    return result;
}
