import type { ExtendedTokenRequestLog } from '../fileLogger/usageParser';
import type { NativeCostSplit, TokenRequestLog } from '../fileLogger/types';

export type UsagesPendingRecord = Omit<TokenRequestLog, 'status' | 'rawUsage' | 'estimatedCost' | 'costBreakdown'> & {
    status: 'estimated';
    rawUsage: null;
};

export interface NativeCostSplitIndex {
    total: NativeCostSplit;
    providers: Record<string, NativeCostSplit>;
    models: Record<string, Record<string, NativeCostSplit>>;
    hours: Record<string, NativeCostSplit>;
    hourProviders: Record<string, Record<string, NativeCostSplit>>;
    hourModels: Record<string, Record<string, Record<string, NativeCostSplit>>>;
}

export interface SessionSummary {
    requestCount: number;
    totalTokens: number;
    startTime?: number;
    endTime?: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    avgSpeed?: number;
}

export interface RequestTotals {
    inputTokens: number;
    cacheTokens: number;
    outputTokens: number;
    avgLatency?: number;
    avgDuration?: number;
    totalCost: number;
    totalCostRmb: number;
    nativeCosts: NativeCostSplit;
    costedRequests: number;
    rmbExactRequests: number;
}

export interface SessionGroup {
    sessionId: string;
    displayId: string;
    title?: string;
    records: ExtendedTokenRequestLog[];
    summary: SessionSummary;
    totals: RequestTotals;
}

export interface SessionRecoveryDebugSummary {
    bridgeCount: number;
    newUuidCount: number;
}

export interface SessionGroupSummary {
    sessionId: string;
    displayId: string;
    title?: string;
    summary: SessionSummary;
    totals: RequestTotals;
    recordCount: number;
    recoveryDebug?: SessionRecoveryDebugSummary;
}

export interface UsagesDateOverview {
    allSummary: SessionSummary;
    allTotals: RequestTotals;
    nativeSplitIndex: NativeCostSplitIndex;
    sessionGroups: SessionGroupSummary[];
    initialRecordsPage?: UsagesRecordsPageResult;
}

export interface UsagesRecordsPageResult {
    mode: 'all' | 'session';
    sessionId?: string;
    page: number;
    pageSize: number;
    totalItems: number;
    records: ExtendedTokenRequestLog[];
    summary: SessionSummary;
    totals: RequestTotals;
    recoveryDebug?: SessionRecoveryDebugSummary;
}

export interface UsagesTrackRecordsResult {
    groups: Array<{ sessionId: string; records: ExtendedTokenRequestLog[] }>;
}

export type UsagesQuery =
    | { kind: 'dateOverview'; date: string }
    | {
          kind: 'recordsPage';
          date: string;
          mode: 'all' | 'session';
          sessionId?: string;
          page: number;
          pageSize: number;
      }
    | { kind: 'trackRecords'; date: string; sessionIds: string[]; limitPerSession: number }
    | { kind: 'recentRecords'; limit: number }
    | { kind: 'sessionTitle'; sessionId: string };

export interface UsagesQueryResultMap {
    dateOverview: UsagesDateOverview;
    recordsPage: UsagesRecordsPageResult;
    trackRecords: UsagesTrackRecordsResult;
    recentRecords: ExtendedTokenRequestLog[];
    sessionTitle: string | undefined;
}

export type UsagesQueryResult = {
    [Kind in keyof UsagesQueryResultMap]: { kind: Kind; value: UsagesQueryResultMap[Kind] };
}[keyof UsagesQueryResultMap];

export type UsagesQueryResultFor<Query extends UsagesQuery> = UsagesQueryResultMap[Query['kind']];
