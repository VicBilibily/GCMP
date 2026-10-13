import * as fs from 'node:fs/promises';
import { AtomicJsonFile } from '../atomicJsonFile';
import type { DateIndex, TokenUsageStatsFromFile } from '../fileLogger/types';
import { VersionedJsonFile, type JsonFileSnapshot } from './versionedJsonFile';
import { isUsageStatusSourceTotals } from '../status/snapshot';

type SavedStatistics = Pick<TokenUsageStatsFromFile, 'total'> & Partial<Omit<TokenUsageStatsFromFile, 'total'>>;

export const statisticsFiles = new VersionedJsonFile<SavedStatistics>(value => {
    const stats = value as SavedStatistics | null;
    if (!stats || !isUsageStatusSourceTotals(stats.total)) {
        throw new Error('Invalid date stats');
    }
    return stats;
});

export const indexFiles = new VersionedJsonFile<DateIndex>(value => {
    const index = value as DateIndex | null;
    if (!index?.dates || typeof index.dates !== 'object' || Array.isArray(index.dates)) {
        throw new Error('Invalid date index');
    }
    for (const entry of Object.values(index.dates)) {
        if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            ![entry.total_input, entry.total_cache, entry.total_output, entry.total_requests, entry.total_cost].every(
                value => Number.isFinite(value) && value >= 0
            ) ||
            !Number.isSafeInteger(entry.total_requests) ||
            [entry.total_cost_rmb, entry.native_total_cost, entry.native_total_cost_rmb].some(
                value => value !== undefined && (!Number.isFinite(value) || value < 0)
            )
        ) {
            throw new Error('Invalid date index entry');
        }
    }
    return index;
});

export function readStatisticsFile(filePath: string): Promise<JsonFileSnapshot<SavedStatistics>> {
    return statisticsFiles.read(filePath, () =>
        AtomicJsonFile.runExclusive(filePath, () => fs.readFile(filePath, 'utf8'))
    );
}
