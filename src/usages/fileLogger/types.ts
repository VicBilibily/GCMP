/*---------------------------------------------------------------------------------------------
 *  Token文件日志系统 - 类型定义
 *  补充 globalState 存储,提供详细的请求日志记录
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * 通用的 Token 使用数据格式 - 支持多个 SDK
 */
export interface GenericUsageData {
    // === OpenAI 格式 ===
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    // === Anthropic/Claude 格式 ===
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    // === Responses API 格式 ===
    input_tokens_details?: {
        cached_tokens?: number;
        [key: string]: number | undefined;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
        [key: string]: number | undefined;
    };

    // === Gemini usageMetadata（HTTP/SSE 网关返回）===
    // 不同网关字段名可能不同：有的用 responseTokenCount，有的用 candidatesTokenCount（都表示输出 token 数）。
    promptTokenCount?: number;
    responseTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    cacheTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    // === 其他字段 ===
    [key: string]: number | undefined | object;
}

/**
 * 原始 Token 使用数据 - 支持多个 SDK 的格式
 * 用于统一处理 Anthropic、OpenAI 等不同供应商的 usage 对象
 */
export type RawUsageData = Anthropic.Messages.Usage | OpenAI.Completions.CompletionUsage | GenericUsageData;

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
    rawUsage: GenericUsageData | null;
    /** 请求状态 */
    status: 'estimated' | 'completed' | 'failed';
    /** 最大输入token(上下文窗口大小) */
    maxInputTokens?: number;
    /** 请求类型 */
    requestType?: 'chat' | 'completion' | 'fim' | 'nes';
    /** 流开始时间 (毫秒时间戳) */
    streamStartTime?: number;
    /** 流结束时间 (毫秒时间戳) */
    streamEndTime?: number;
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
    /** 总输出耗时(毫秒) - 用于计算平均输出速度 */
    totalStreamDuration?: number;
    /** 有效的请求次数(有时间记录的完成请求) - 用于计算平均输出速度和平均首Token延迟 */
    validStreamRequests?: number;
    /** 有时间记录的输出 tokens - 用于计算平均输出速度（避免历史数据影响） */
    validStreamOutputTokens?: number;
    /** 总首Token延迟(毫秒) - 用于计算平均首Token延迟 */
    totalFirstTokenLatency?: number;
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
 * FileLogger 内部使用的模型统计
 * 扩展基础统计，添加模型名称
 */
export interface FileLoggerModelStats extends BaseStats {
    modelName: string;
}

/**
 * FileLogger 内部使用的提供商统计
 * 扩展基础统计，添加提供商名称和模型分组
 * 注意：providerKey 已作为 Record 的 key，无需在对象内重复存储
 */
export interface FileLoggerProviderStats extends TokenStats {
    providerName: string;
    models: Record<string, FileLoggerModelStats>;
}

/**
 * 每小时统计（用于 hourly）
 * 包含总计、提供商和模型的统计信息，用于差分计算的缓存
 */
export interface HourlyStats extends TokenStats {
    /** 日志文件修改时间戳 (用于缓存验证) */
    modifiedTime: number;
    /** 按提供商分组 (直接使用 providerId 作为 key) */
    providers: Record<string, FileLoggerProviderStats>;
}

/**
 * 统计结果(从文件读取后计算)
 * 也是 stats.json 的文件结构
 */
export interface TokenUsageStatsFromFile {
    /** 总计 */
    total: TokenStats;
    /** 按提供商分组 (直接使用 providerId 作为 key) */
    providers: Record<string, FileLoggerProviderStats>;
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
