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
    /** 流耗时(毫秒) */
    streamDuration?: number;
    /** 首个实际输出延迟(毫秒) */
    firstTokenLatency?: number;
    /** 平均每个输出 token 的耗时(毫秒/token) */
    timePerOutputToken?: number;
    /** output 表示真实输出时间，stream 表示旧记录按协议流时间近似 */
    timingSource?: 'output' | 'stream';
    /** 输出速度(tokens/s) */
    outputSpeed?: number;
}

/**
 * 扩展的 TokenRequestLog，提供向解析后的 token 统计结果
 */
export type ExtendedTokenRequestLog = TokenRequestLog & ParsedUsageTokens;

interface UsageTimingInput {
    timestamp: number;
    /** 当前 attempt 实际发起上游请求的时间戳，缺失时回退到日志创建时间。 */
    requestMetricStartTime?: number;
    streamStartTime?: number;
    streamEndTime?: number;
    /** 包含文本、思考和工具参数等实际模型输出。 */
    firstOutputTime?: number;
    lastOutputTime?: number;
    /** 非思考内容的实际输出时间。 */
    firstContentOutputTime?: number;
    lastContentOutputTime?: number;
}

/**
 * Token Usage 解析工具类
 * 统一处理不同提供商的 usage 对象格式
 */
export class UsageParser {
    static parseTiming(log: UsageTimingInput, outputTokens: number): Partial<ParsedUsageTokens> {
        const result: Partial<ParsedUsageTokens> = {
            streamDuration: undefined,
            firstTokenLatency: undefined,
            timePerOutputToken: undefined,
            timingSource: undefined,
            outputSpeed: undefined
        };

        const streamStartTime = log.streamStartTime ?? log.timestamp;
        if (
            log.streamEndTime !== undefined &&
            Number.isFinite(streamStartTime) &&
            Number.isFinite(log.streamEndTime) &&
            log.streamEndTime >= streamStartTime
        ) {
            result.streamDuration = log.streamEndTime - streamStartTime;
        }

        const hasOutputStart = log.firstOutputTime !== undefined && Number.isFinite(log.firstOutputTime);
        const metricStartTime = log.requestMetricStartTime ?? log.timestamp;
        const latencyStart = hasOutputStart ? log.firstOutputTime : log.streamStartTime;
        if (
            latencyStart !== undefined &&
            Number.isFinite(latencyStart) &&
            Number.isFinite(metricStartTime) &&
            latencyStart >= metricStartTime
        ) {
            result.firstTokenLatency = latencyStart - metricStartTime;
            result.timingSource = hasOutputStart ? 'output' : 'stream';
        }

        const duration = result.streamDuration;
        if (outputTokens > 0 && duration !== undefined && duration > 0) {
            result.timePerOutputToken = duration / outputTokens;
            result.outputSpeed = (outputTokens / duration) * 1000;
        }

        return result;
    }

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

        const hasGeminiUsage = [
            rawUsage.promptTokenCount,
            rawUsage.responseTokenCount,
            rawUsage.candidatesTokenCount,
            rawUsage.thoughtsTokenCount,
            rawUsage.totalTokenCount,
            rawUsage.cachedContentTokenCount,
            rawUsage.toolUsePromptTokenCount
        ].some(value => value !== undefined);
        if (hasGeminiUsage) {
            const promptTokens =
                typeof rawUsage.promptTokenCount === 'number' && Number.isFinite(rawUsage.promptTokenCount) ?
                    Math.max(0, rawUsage.promptTokenCount)
                :   0;
            const responseTokens =
                typeof rawUsage.responseTokenCount === 'number' && Number.isFinite(rawUsage.responseTokenCount) ?
                    Math.max(0, rawUsage.responseTokenCount)
                :   undefined;
            const candidateTokens =
                typeof rawUsage.candidatesTokenCount === 'number' && Number.isFinite(rawUsage.candidatesTokenCount) ?
                    Math.max(0, rawUsage.candidatesTokenCount)
                :   0;
            const toolUsePromptTokens =
                (
                    typeof rawUsage.toolUsePromptTokenCount === 'number' &&
                    Number.isFinite(rawUsage.toolUsePromptTokenCount)
                ) ?
                    Math.max(0, rawUsage.toolUsePromptTokenCount)
                :   0;
            const actualInput = promptTokens + toolUsePromptTokens;
            const thoughtsTokens =
                typeof rawUsage.thoughtsTokenCount === 'number' && Number.isFinite(rawUsage.thoughtsTokenCount) ?
                    Math.max(0, rawUsage.thoughtsTokenCount)
                :   0;
            const outputTokens = responseTokens ?? candidateTokens + thoughtsTokens;
            const cacheReadTokens =
                (
                    typeof rawUsage.cachedContentTokenCount === 'number' &&
                    Number.isFinite(rawUsage.cachedContentTokenCount)
                ) ?
                    Math.min(actualInput, Math.max(0, rawUsage.cachedContentTokenCount))
                :   0;
            const reportedTotal =
                typeof rawUsage.totalTokenCount === 'number' && Number.isFinite(rawUsage.totalTokenCount) ?
                    Math.max(0, rawUsage.totalTokenCount)
                :   0;
            return {
                actualInput,
                cacheReadTokens,
                cacheCreationTokens: Math.max(0, actualInput - cacheReadTokens),
                outputTokens,
                totalTokens: reportedTotal || actualInput + outputTokens
            };
        }

        // 尝试解析 Anthropic/Claude 格式 / Responses API 格式
        if (rawUsage.input_tokens !== undefined && rawUsage.output_tokens !== undefined) {
            const inputTokens = rawUsage.input_tokens || 0;
            const outputTokens = rawUsage.output_tokens || 0;

            // 检查是否有 cached_tokens 字段
            const cachedTokens = rawUsage.input_tokens_details?.cached_tokens || rawUsage.cached_tokens || 0;

            // Anthropic 格式
            const cacheReadTokens = rawUsage.cache_read_input_tokens || 0;
            const cacheCreationTokens = rawUsage.cache_creation_input_tokens || 0;

            // Responses 只看 input_tokens_details 是否存在，不能用 cached_tokens 真值判断。
            const isResponsesApi = rawUsage.input_tokens_details !== undefined;
            const actualCacheReadTokens = isResponsesApi ? cachedTokens : cacheReadTokens;
            const actualCacheCreationTokens = isResponsesApi ? 0 : cacheCreationTokens;

            // Responses API: actualInput = inputTokens (已包含 cached_tokens)
            // Anthropic API: actualInput = inputTokens + cacheReadTokens + cacheCreationTokens
            const actualInput =
                isResponsesApi ? inputTokens : inputTokens + actualCacheReadTokens + actualCacheCreationTokens;

            return {
                actualInput,
                cacheReadTokens: actualCacheReadTokens,
                cacheCreationTokens: actualCacheCreationTokens,
                outputTokens,
                totalTokens: rawUsage.total_tokens || actualInput + outputTokens
            };
        }

        // 尝试解析 OpenAI 格式
        if (rawUsage.prompt_tokens !== undefined) {
            const promptTokens = typeof rawUsage.prompt_tokens === 'number' ? rawUsage.prompt_tokens : 0;
            const completionTokens = typeof rawUsage.completion_tokens === 'number' ? rawUsage.completion_tokens : 0;
            const totalTokens = typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : 0;

            const rawCachedTokens =
                typeof rawUsage.prompt_tokens_details?.cached_tokens === 'number' ?
                    rawUsage.prompt_tokens_details.cached_tokens
                :   0;

            // 标准 OpenAI 口径：prompt_tokens 通常已包含 cached_tokens。
            // 部分 OpenAI-compatible 网关（例如 Hyper）可能将 prompt_tokens 仅作为新增/未缓存输入，
            // 而 total_tokens 仍包含缓存输入。因此 total_tokens - completion_tokens 只能作为补充候选值。
            const inputFromTotal =
                totalTokens > 0 && totalTokens >= completionTokens ? totalTokens - completionTokens : 0;

            const actualInput = Math.max(promptTokens, inputFromTotal);

            // 防御异常数据：禁止缓存读取 token 为负数或超过实际输入。
            const cacheReadTokens = Math.min(Math.max(0, rawCachedTokens), actualInput);

            // OpenAI-compatible usage 没有 Anthropic 风格的 cache_creation_input_tokens 字段，
            // 此处 cacheCreationTokens 仅用于 usage 日志展示（非 costCalculator 计费依据，
            // costCalculator 通过 getExplicitCacheWriteTokens 只读 Anthropic 专有字段）。
            // 将"非缓存的 input"记为 cacheCreationTokens 以避免负值统计。
            const cacheCreationTokens = Math.max(0, actualInput - cacheReadTokens);

            const calculatedTotalTokens = actualInput + completionTokens;
            const finalTotalTokens = Math.max(totalTokens, calculatedTotalTokens);

            return {
                actualInput,
                outputTokens: completionTokens,
                totalTokens: finalTotalTokens,
                cacheCreationTokens,
                cacheReadTokens
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
        let result: ParsedUsageTokens;

        if (log.rawUsage) {
            result = this.parseRawUsage(log.rawUsage);
        } else {
            // 没有 rawUsage，使用预估的输入
            result = {
                actualInput: log.estimatedInput,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                totalTokens: log.estimatedInput
            };
        }

        const timing = this.parseTiming(log, result.outputTokens);
        // 在途尚无实际 usage，不能用零输出 token 覆盖 tracker 的估算。
        if (log.status === 'estimated' && !log.rawUsage && log.outputSpeed !== undefined) {
            timing.outputSpeed = log.outputSpeed;
            timing.timePerOutputToken = log.outputSpeed > 0 ? 1000 / log.outputSpeed : undefined;
        }
        return { ...result, ...timing };
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
