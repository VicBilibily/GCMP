/*---------------------------------------------------------------------------------------------
 *  匀速限流间隔换算工具
 *--------------------------------------------------------------------------------------------*/

/**
 * 从每分钟上限换算匀速放行间隔（毫秒）
 */
export function intervalFromPerMinute(perMinute: number): number {
    return 60_000 / perMinute;
}

/**
 * 从每秒上限换算匀速放行间隔（毫秒）
 */
export function intervalFromPerSecond(perSecond: number): number {
    return 1_000 / perSecond;
}
