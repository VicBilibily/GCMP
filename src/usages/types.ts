/*---------------------------------------------------------------------------------------------
 *  使用统计 - 向上层暴露的类型定义
 *--------------------------------------------------------------------------------------------*/

/**
 * 日期统计数据 - 向上层暴露的统计格式
 */
export interface DailyStats {
    date: string;
    providers: Record<string, ProviderStats>;
    lastUpdated: number;
}

/**
 * 供应商统计 - 向上层暴露的统计格式
 */
export interface ProviderStats {
    providerKey: string;
    displayName: string;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalOutputTokens: number;
    totalRequests: number;
    models: Record<string, ModelStats>;
}

/**
 * 模型统计 - 向上层暴露的统计格式
 */
export interface ModelStats {
    modelId: string;
    modelName: string;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalOutputTokens: number;
    totalRequests: number;
}

/**
 * 小时统计数据 - 向上层暴露的统计格式
 */
export interface UsagesHourlyStats {
    hour: string;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalOutputTokens: number;
    totalRequests: number;
    lastUpdated: number;
}

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
