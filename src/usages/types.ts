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
}
