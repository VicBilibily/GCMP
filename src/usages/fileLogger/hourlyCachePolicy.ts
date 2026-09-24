export interface HourlyStatsReuseInput {
    cachedModifiedTime?: number;
    sourceModifiedTime: number;
    isVersionCompatible: boolean;
}

/**
 * stats.json 的 hourly 缓存复用规则：
 * - 仅在当前 stats 版本仍兼容时复用；
 * - 仅在缓存的 modifiedTime 不早于源 jsonl mtime 时复用。
 */
export function canReuseHourlyStatsCache(input: HourlyStatsReuseInput): boolean {
    return (
        input.isVersionCompatible &&
        input.cachedModifiedTime !== undefined &&
        input.cachedModifiedTime >= input.sourceModifiedTime
    );
}

/**
 * 每小时 request details 缓存复用规则：
 * - 仅当缓存 mtime 与源文件 mtime 完全一致时复用。
 */
export function canReuseHourlyDetailsCache(
    cachedModifiedTime: number | undefined,
    sourceModifiedTime: number
): boolean {
    return cachedModifiedTime !== undefined && cachedModifiedTime === sourceModifiedTime;
}
