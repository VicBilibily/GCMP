/*---------------------------------------------------------------------------------------------
 *  多天长周期用量分析 - 类型定义
 *--------------------------------------------------------------------------------------------*/

// ============= 单日聚合统计 =============

/** 多日聚合后的单日统计 */
export interface MultiDayDateStats {
    date: string;
    dayOfWeek: number; // 0=周日
    isWeekend: boolean;
    totalInput: number;
    totalCache: number;
    totalOutput: number;
    totalTokens: number;
    totalRequests: number;
    completedRequests: number;
    failedRequests: number;
    failureRate: number;
    cacheHitRate: number;
    providers: Record<string, MultiDayProviderStats>;
}

/** 提供商在多日视图中的统计 */
export interface MultiDayProviderStats {
    providerKey: string;
    providerName: string;
    totalInput: number;
    totalCache: number;
    totalOutput: number;
    totalTokens: number;
    totalRequests: number;
    avgSpeed: number;
    avgLatency: number;
    models: Record<string, MultiDayModelStats>;
}

/** 模型在多日视图中的统计 */
export interface MultiDayModelStats {
    modelName: string;
    totalInput: number;
    totalCache: number;
    totalOutput: number;
    totalTokens: number;
    totalRequests: number;
    avgSpeed: number;
    avgLatency: number;
}

// ============= 趋势序列 =============

export interface TrendSeries {
    dates: string[];
    totalTokens: number[];
    inputTokens: number[];
    outputTokens: number[];
    cacheTokens: number[];
    requests: number[];
    failureRate: number[];
    cacheHitRate: number[];
    movingAvg7Day?: number[];
}

// ============= 聚合结果（v4.0 精简版） =============

export interface MultiDayAnalysisResult {
    dateFrom: string;
    dateTo: string;
    dayCount: number;
    /** 部分日期 stats.json 读取失败，结果不完整 */
    missingDates: string[];
    dates: MultiDayDateStats[];
    trendSeries: TrendSeries;
    summary: {
        totalTokens: number;
        totalInput: number;
        totalCache: number;
        totalOutput: number;
        totalRequests: number;
        successRate: number;
        dailyAvgTokens: number;
        /** 最活跃提供商 */
        topProvider: { key: string; name: string; share: number } | null;
        /** 最活跃模型 */
        topModel: { id: string; name: string; share: number } | null;
        /** 环比变化（与上一等长周期对比） */
        tokensChangePct: number | null;
    };
    providerRanking: Array<{
        key: string;
        name: string;
        totalInput: number;
        totalCache: number;
        totalOutput: number;
        totalTokens: number;
        share: number;
    }>;
    modelRanking: Array<{
        id: string;
        name: string;
        providerName: string;
        modelName: string;
        totalInput: number;
        totalCache: number;
        totalOutput: number;
        totalRequests: number;
        totalTokens: number;
    }>;
}
