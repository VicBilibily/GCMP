/*---------------------------------------------------------------------------------------------
 *  Token文件日志系统 - 类型定义
 *  补充 globalState 存储,提供详细的请求日志记录
 *--------------------------------------------------------------------------------------------*/

/**
 * Token请求日志条目
 * 每行一个JSON对象,记录一次完整的API请求
 */
export interface TokenRequestLog {
    /** 请求ID */
    requestId: string;
    /** 时间戳 (毫秒) */
    timestamp: number;
    /** ISO时间字符串 */
    isoTime: string;
    /** 提供商Key */
    providerKey: string;
    /** 提供商显示名 */
    providerName: string;
    /** 模型ID */
    modelId: string;
    /** 模型名称 */
    modelName: string;
    /** 预估输入token */
    estimatedInput: number;
    /** 原始 usage 对象 (请求完成时存储，支持多种提供商格式) */
    rawUsage: {
        // === OpenAI 格式 ===
        /** OpenAI: 提示token数 */
        prompt_tokens?: number;
        /** OpenAI: 补全token数 */
        completion_tokens?: number;
        /** OpenAI: 总token数 */
        total_tokens?: number;
        /** OpenAI: 提示token详细信息 (缓存相关) */
        prompt_tokens_details?: {
            /** 缓存命中的token数 */
            cached_tokens?: number;
            /** 其他未知字段 */
            [key: string]: number | undefined;
        };
        /** OpenAI: 补全token详细信息 */
        completion_tokens_details?: {
            /** 推理token数 */
            reasoning_tokens?: number;
            /** 其他未知字段 */
            [key: string]: number | undefined;
        };

        // === Anthropic/Claude 格式 ===
        /** Anthropic: 输入token数 (不包含缓存读取) */
        input_tokens?: number;
        /** Anthropic: 输出token数 */
        output_tokens?: number;
        /** Anthropic: 缓存创建的token数 (是input_tokens的子集) */
        cache_creation_input_tokens?: number;
        /** Anthropic: 缓存读取的token数 (不计入input_tokens) */
        cache_read_input_tokens?: number;

        // === 其他可能的字段 ===
        /** 其他未知字段 (保持兼容性) */
        [key: string]: number | undefined | object;
    } | null;
    /** 请求状态 */
    status: 'estimated' | 'completed' | 'failed';
    /** 最大输入token(上下文窗口大小) */
    maxInputTokens?: number;
    /** 请求类型 */
    requestType?: 'chat' | 'completion' | 'fim' | 'nes';
}

/**
 * 文件路径信息
 */
export interface LogFilePath {
    /** 日期字符串 (YYYY-MM-DD) */
    date: string;
    /** 小时 (0-23) */
    hour: number;
    /** 日期文件夹路径 */
    dateFolder: string;
    /** 小时文件名 (HH.jsonl) */
    hourFileName: string;
    /** 完整文件路径 */
    fullPath: string;
}

/**
 * 基础统计数据（通用字段）
 */
export interface BaseStats {
    estimatedInput: number;
    actualInput: number;
    cacheTokens: number;
    outputTokens: number;
    requests: number;
}

/**
 * Token 统计数据（总计）
 * 扩展基础统计，添加完成/失败状态
 */
export interface TokenStats extends BaseStats {
    completedRequests: number;
    failedRequests: number;
}

/**
 * 模型统计
 * 扩展基础统计，添加模型名称
 */
export interface ModelStats extends BaseStats {
    modelName: string;
}

/**
 * 提供商统计
 * 扩展基础统计，添加提供商名称和模型分组
 */
export interface ProviderStats extends BaseStats {
    providerName: string;
    models: Record<string, ModelStats>;
}

/**
 * 每小时统计（用于 hourly）
 * 直接保存 total 的结构，不嵌套
 */
export type HourlyStats = TokenStats;

/**
 * 统计结果(从文件读取后计算)
 * 也是 stats.json 的文件结构
 */
export interface TokenUsageStatsFromFile {
    /** 总计 */
    total: TokenStats;
    /** 按提供商分组 (直接使用 providerId 作为 key) */
    providers: Record<string, ProviderStats>;
    /** 每小时合计 (仅日期统计包含此字段) */
    hourly?: Record<string, HourlyStats>;
}

/**
 * 日期索引条目（用于 index.json）
 */
export interface DateIndexEntry {
    total_input: number;
    total_cache: number;
    total_output: number;
    total_requests: number;
}

/**
 * 日期索引文件结构
 * 用于快速浏览日期列表，无需加载每个日期的完整统计
 */
export interface DateIndex {
    dates: Record<string, DateIndexEntry>;
}
