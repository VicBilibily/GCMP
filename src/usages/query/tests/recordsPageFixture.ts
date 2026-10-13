import {
    buildRequestTotals,
    filterRecordsBySession,
    sliceRecordsPage,
    summarizeSessionRecords
} from '../../../ui/usagesView/aggregation';
import { DateUtils } from '../../fileLogger/dateUtils';
import { UsageParser, type ExtendedTokenRequestLog } from '../../fileLogger/usageParser';
import type { UsagesQuery, UsagesRecordsPageResult } from '../types';

export type RecordsPageQuery = Extract<UsagesQuery, { kind: 'recordsPage' }>;

export function recordsPageQuery(pageSize = 3, date = DateUtils.getTodayDateString()): RecordsPageQuery {
    return { kind: 'recordsPage', date, mode: 'all', page: 1, pageSize };
}

export function recordsPageResult(
    query: RecordsPageQuery,
    records: ExtendedTokenRequestLog[] = []
): UsagesRecordsPageResult {
    const source = query.mode === 'session' ? filterRecordsBySession(records, query.sessionId!) : records;
    const page = sliceRecordsPage(source, query.page, query.pageSize);
    return {
        mode: query.mode,
        sessionId: query.mode === 'session' ? query.sessionId : undefined,
        page: query.page,
        pageSize: query.pageSize,
        totalItems: page.totalItems,
        records: page.records,
        summary: summarizeSessionRecords(source),
        totals: buildRequestTotals(source)
    };
}

export function queryRecord(requestId: string): ExtendedTokenRequestLog {
    const timestamp = new Date(`${DateUtils.getTodayDateString()}T10:00:00`).getTime();
    return UsageParser.extendLog({
        requestId,
        timestamp,
        isoTime: new Date(timestamp).toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 10,
        rawUsage: null,
        status: 'estimated'
    });
}
