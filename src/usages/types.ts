/*---------------------------------------------------------------------------------------------
 *  使用统计 - 向上层暴露的类型定义
 *--------------------------------------------------------------------------------------------*/

// 重新导出 fileLogger 的类型以便使用
export type {
    FileLoggerProviderStats,
    FileLoggerModelStats,
    TokenUsageStatsFromFile,
    HourlyStats
} from './fileLogger/types';

/**
 * 日期摘要
 */
export interface DateSummary {
    date: string;
    total_input: number;
    total_cache: number;
    total_output: number;
    total_requests: number;
    /** USD 成本合计 */
    total_cost?: number;
    /** RMB 成本合计（无精确定价时按 USD×7 估算） */
    total_cost_rmb?: number;
    /** 原生 USD 成本部分 */
    native_total_cost?: number;
    /** 原生 RMB 成本部分 */
    native_total_cost_rmb?: number;
}
