/*---------------------------------------------------------------------------------------------
 *  匀速限流间隔换算工具
 *--------------------------------------------------------------------------------------------*/

function intervalFromRate(perUnit: number, windowMs: number): number | undefined {
    if (!Number.isFinite(perUnit) || perUnit <= 0) {
        return undefined;
    }
    const interval = windowMs / perUnit;
    return Number.isFinite(interval) && interval > 0 ? interval : undefined;
}

/**
 * 从每分钟上限换算匀速放行间隔（毫秒）
 */
export function intervalFromPerMinute(perMinute: number): number | undefined {
    return intervalFromRate(perMinute, 60_000);
}

/**
 * 从每秒上限换算匀速放行间隔（毫秒）
 */
export function intervalFromPerSecond(perSecond: number): number | undefined {
    return intervalFromRate(perSecond, 1_000);
}
