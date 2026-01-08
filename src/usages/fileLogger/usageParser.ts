/*---------------------------------------------------------------------------------------------
 *  Token Usage 解析工具
 *  统一解析 OpenAI 和 Anthropic 两种格式的 usage 对象
 *--------------------------------------------------------------------------------------------*/

import type { TokenRequestLog } from './types';

/**
 * 解析后的 token 统计
 */
export interface ParsedUsageTokens {
    /** 实际输入token数 */
    actualInput: number;
    /** 缓存读取token数 */
    cacheReadTokens: number;
    /** 缓存创建token数 */
    cacheCreationTokens: number;
    /** 输出token数 */
    outputTokens: number;
    /** 总token数 */
    totalTokens: number;
}

/**
 * 扩展的 TokenRequestLog，提供向解析后的 token 统计结果
 */
export type ExtendedTokenRequestLog = TokenRequestLog & ParsedUsageTokens;

/**
 * Token Usage 解析工具类
 * 统一处理不同提供商的 usage 对象格式
 */
export class UsageParser {
    /**
     * 从原始 usage 对象解析 token 统计
     * 支持 OpenAI、Anthropic 和 Responses API 三种格式
     */
    static parseRawUsage(rawUsage: TokenRequestLog['rawUsage']): ParsedUsageTokens {
        // 默认值
        const defaultResult: ParsedUsageTokens = {
            actualInput: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            totalTokens: 0
        };

        if (!rawUsage) {
            return defaultResult;
        }

        // 尝试解析 Anthropic/Claude 格式
        if (rawUsage.input_tokens !== undefined && rawUsage.output_tokens !== undefined) {
            const inputTokens = rawUsage.input_tokens || 0;
            const outputTokens = rawUsage.output_tokens || 0;

            // 检查是否有 cached_tokens 字段（Responses API 格式）
            const cachedTokens = rawUsage.input_tokens_details?.cached_tokens || 0;

            // Anthropic 格式
            const cacheReadTokens = rawUsage.cache_read_input_tokens || 0;
            const cacheCreationTokens = rawUsage.cache_creation_input_tokens || 0;

            // 如果有 cached_tokens（Responses API），使用它
            const actualCacheReadTokens = cachedTokens > 0 ? cachedTokens : cacheReadTokens;
            const actualCacheCreationTokens = cachedTokens > 0 ? 0 : cacheCreationTokens;

            const actualInput = inputTokens + actualCacheReadTokens + actualCacheCreationTokens;

            return {
                actualInput,
                cacheReadTokens: actualCacheReadTokens,
                cacheCreationTokens: actualCacheCreationTokens,
                outputTokens,
                totalTokens: rawUsage.total_tokens || 0 || actualInput + outputTokens
            };
        }

        // 尝试解析 OpenAI 格式
        if (rawUsage.prompt_tokens !== undefined) {
            const promptTokens = rawUsage.prompt_tokens || 0;
            const completionTokens = rawUsage.completion_tokens || 0;
            const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;

            // OpenAI: prompt_tokens 包含所有输入，cached_tokens 是其中的缓存命中部分
            // 未命中缓存的输入会被写入缓存（如果启用了缓存功能）
            const cacheCreationTokens = promptTokens - cachedTokens;

            return {
                actualInput: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokens,
                totalTokens: rawUsage.total_tokens || 0 || promptTokens + completionTokens
            };
        }

        // 未知格式，返回默认值
        return defaultResult;
    }

    /**
     * 从 TokenRequestLog 解析 token 统计
     * 如果有 rawUsage 则解析，否则使用 estimatedInput
     */
    static parseFromLog(log: TokenRequestLog): ParsedUsageTokens {
        if (log.rawUsage) {
            return this.parseRawUsage(log.rawUsage);
        }

        // 没有 rawUsage，使用预估的输入
        return {
            actualInput: log.estimatedInput,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            totalTokens: log.estimatedInput
        };
    }

    /**
     * 扩展 TokenRequestLog，添加便捷访问方法
     * 让 UI 代码可以继续使用简单的字段访问
     */
    static extendLog(log: TokenRequestLog): ExtendedTokenRequestLog {
        const parsed = this.parseFromLog(log);
        return { ...log, ...parsed };
    }

    /**
     * 批量扩展 TokenRequestLog 数组
     */
    static extendLogs(logs: TokenRequestLog[]): ExtendedTokenRequestLog[] {
        return logs.map(log => this.extendLog(log));
    }
}
