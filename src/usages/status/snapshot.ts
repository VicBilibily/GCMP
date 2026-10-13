import type { NativeCostSplit, TokenStats, TokenUsageStatsFromFile } from '../fileLogger/types';
import type { StatsResultSource } from '../fileLogger/refresh/statsRefreshQueue';

export type UsageStatusTotals = Pick<
    TokenStats,
    | 'actualInput'
    | 'cacheTokens'
    | 'outputTokens'
    | 'requests'
    | 'costedRequests'
    | 'rmbExactRequests'
    | 'estimatedCost'
    | 'estimatedCostRmb'
    | 'firstTokenLatency'
    | 'outputSpeeds'
> & { nativeCosts?: Pick<NativeCostSplit, 'totalUsd' | 'totalRmb'> };

export interface UsageStatusStats {
    total: UsageStatusTotals;
    providers: Record<string, UsageStatusTotals & { providerName: string }>;
}

export interface UsageStatusSnapshot {
    date: string;
    authorityTerm: string;
    revision: number;
    stats: UsageStatusStats;
}

export interface LatestUsageStatus {
    readonly stats: UsageStatusStats;
    readonly source: StatsResultSource;
}

export function freezeUsageStatusStats(stats: UsageStatusStats): UsageStatusStats {
    for (const total of [stats.total, ...Object.values(stats.providers)]) {
        if (total.nativeCosts) {
            Object.freeze(total.nativeCosts);
        }
        Object.freeze(total);
    }
    Object.freeze(stats.providers);
    return Object.freeze(stats);
}

const numericFields = [
    'actualInput',
    'cacheTokens',
    'outputTokens',
    'requests',
    'costedRequests',
    'rmbExactRequests',
    'estimatedCost',
    'estimatedCostRmb'
] as const;
const optionalFields = ['firstTokenLatency', 'outputSpeeds'] as const;

function totals(stats: UsageStatusTotals): UsageStatusTotals {
    const result: UsageStatusTotals = {
        actualInput: stats.actualInput ?? 0,
        cacheTokens: stats.cacheTokens ?? 0,
        outputTokens: stats.outputTokens ?? 0,
        requests: stats.requests ?? 0,
        costedRequests: stats.costedRequests ?? 0,
        rmbExactRequests: stats.rmbExactRequests ?? 0,
        estimatedCost: stats.estimatedCost ?? 0,
        estimatedCostRmb: stats.estimatedCostRmb ?? 0
    };
    for (const key of optionalFields) {
        if (stats[key] !== undefined) {
            result[key] = stats[key];
        }
    }
    if (stats.nativeCosts) {
        result.nativeCosts = { totalUsd: stats.nativeCosts.totalUsd, totalRmb: stats.nativeCosts.totalRmb };
    }
    return result;
}

export function projectUsageStatus(stats: TokenUsageStatsFromFile | UsageStatusStats): UsageStatusStats {
    if (!isUsageStatusSource(stats)) {
        throw new Error('Invalid usage status statistics');
    }
    return {
        total: totals(stats.total),
        providers: Object.fromEntries(
            Object.entries(stats.providers)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, provider]) => [key, { ...totals(provider), providerName: provider.providerName }])
        )
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonnegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isUsageStatusSourceTotals(value: unknown): boolean {
    if (
        !isRecord(value) ||
        !['actualInput', 'cacheTokens', 'outputTokens', 'requests'].every(key => isNonnegative(value[key]))
    ) {
        return false;
    }
    return (
        numericFields.every(key => value[key] === undefined || isNonnegative(value[key])) &&
        optionalFields.every(key => value[key] === undefined || isNonnegative(value[key])) &&
        ['requests', 'costedRequests', 'rmbExactRequests'].every(
            key => value[key] === undefined || Number.isSafeInteger(value[key])
        ) &&
        (value.nativeCosts === undefined ||
            (isRecord(value.nativeCosts) &&
                isNonnegative(value.nativeCosts.totalUsd) &&
                isNonnegative(value.nativeCosts.totalRmb)))
    );
}

export function isUsageStatusSource(value: unknown): value is TokenUsageStatsFromFile | UsageStatusStats {
    if (!isRecord(value) || !isUsageStatusSourceTotals(value.total) || !isRecord(value.providers)) {
        return false;
    }
    const entries = Object.entries(value.providers);
    return (
        entries.length <= 128 &&
        entries.every(
            ([key, provider]) =>
                key.length > 0 &&
                key.length <= 128 &&
                isUsageStatusSourceTotals(provider) &&
                isRecord(provider) &&
                typeof provider.providerName === 'string' &&
                provider.providerName.length <= 512
        )
    );
}

function isTotals(value: unknown): value is UsageStatusTotals {
    if (
        !isRecord(value) ||
        !numericFields.every(key => isNonnegative(value[key])) ||
        !optionalFields.every(key => value[key] === undefined || isNonnegative(value[key])) ||
        !['requests', 'costedRequests', 'rmbExactRequests'].every(key => Number.isSafeInteger(value[key]))
    ) {
        return false;
    }
    return (
        value.nativeCosts === undefined ||
        (isRecord(value.nativeCosts) &&
            isNonnegative(value.nativeCosts.totalUsd) &&
            isNonnegative(value.nativeCosts.totalRmb))
    );
}

export function isUsageStatusSnapshot(value: unknown): value is UsageStatusSnapshot {
    if (
        !isRecord(value) ||
        typeof value.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        typeof value.authorityTerm !== 'string' ||
        !value.authorityTerm ||
        value.authorityTerm.length > 160 ||
        !Number.isSafeInteger(value.revision) ||
        (value.revision as number) <= 0 ||
        !isRecord(value.stats) ||
        !isTotals(value.stats.total) ||
        !isRecord(value.stats.providers)
    ) {
        return false;
    }
    const entries = Object.entries(value.stats.providers);
    return (
        entries.length <= 128 &&
        entries.every(
            ([key, provider]) =>
                key.length > 0 &&
                key.length <= 128 &&
                isTotals(provider) &&
                typeof (provider as Record<string, unknown>).providerName === 'string' &&
                ((provider as Record<string, unknown>).providerName as string).length <= 512
        )
    );
}
