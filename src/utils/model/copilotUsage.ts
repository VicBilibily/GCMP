import type { GenericUsageData } from '../../usages/fileLogger/types';
import { UsageParser } from '../../usages/fileLogger/usageParser';

export interface CopilotUsageData {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: Record<string, number | undefined>;
    completion_tokens_details?: Record<string, number | undefined>;
    /**
     * 预估计费信息（与 Copilot 官方 API 的 copilot_usage.total_nano_aiu 对齐）。
     * 可选：仅当 handler 提供了客户端估算成本时才会填充。
     */
    copilot_usage?: { total_nano_aiu: number };
}

type NumericDetails = Record<string, number | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumericDetails(value: unknown): NumericDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const details = Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => typeof entryValue === 'number' && Number.isFinite(entryValue))
    ) as NumericDetails;

    return Object.keys(details).length > 0 ? details : undefined;
}

function normalizeDetailKey(key: string): string {
    return key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function toNestedNumericDetails(value: unknown, prefix: string): NumericDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const details: NumericDetails = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (typeof entryValue !== 'number' || !Number.isFinite(entryValue)) {
            continue;
        }

        details[`${prefix}${normalizeDetailKey(key)}`] = entryValue;
    }

    return Object.keys(details).length > 0 ? details : undefined;
}

function mergeNumericDetails(...values: Array<NumericDetails | undefined>): NumericDetails | undefined {
    const merged: NumericDetails = {};

    for (const value of values) {
        if (!value) {
            continue;
        }

        for (const [key, entryValue] of Object.entries(value)) {
            if (typeof entryValue === 'number' && Number.isFinite(entryValue)) {
                merged[key] = entryValue;
            }
        }
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
}

function getFirstDetails(rawUsage: Record<string, unknown>, keys: readonly string[]): NumericDetails | undefined {
    for (const key of keys) {
        const details = toNumericDetails(rawUsage[key]);
        if (details) {
            return details;
        }
    }

    return undefined;
}

export function buildCopilotUsageData(
    rawUsage: unknown,
    /** 客户端估算的成本（nano-AIU），由 handler 通过 pricing 计算后传入 */
    nanoAiu?: number
): CopilotUsageData | undefined {
    if (!isRecord(rawUsage)) {
        return undefined;
    }

    const parsed = UsageParser.parseRawUsage(rawUsage as GenericUsageData);
    const isOpenAIUsage = typeof rawUsage.prompt_tokens === 'number';
    const promptTokens = parsed.actualInput;
    const completionTokens = parsed.outputTokens;
    const totalTokens = parsed.totalTokens || promptTokens + completionTokens;

    if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
        return undefined;
    }

    const promptDetails = mergeNumericDetails(
        getFirstDetails(rawUsage, ['prompt_tokens_details', 'input_tokens_details']),
        toNestedNumericDetails(rawUsage.cache_creation, 'cache_creation_'),
        {
            cached_tokens: parsed.cacheReadTokens,
            ...(!isOpenAIUsage && parsed.cacheCreationTokens > 0 ?
                { cache_creation_tokens: parsed.cacheCreationTokens }
            :   {})
        }
    ) ?? { cached_tokens: parsed.cacheReadTokens };

    const completionDetails = mergeNumericDetails(
        getFirstDetails(rawUsage, ['completion_tokens_details', 'output_tokens_details'])
    );

    const usageData: CopilotUsageData = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: promptDetails
    };

    if (typeof nanoAiu === 'number' && nanoAiu >= 0) {
        usageData.copilot_usage = { total_nano_aiu: nanoAiu };
    }

    if (completionDetails) {
        usageData.completion_tokens_details = completionDetails;
    }

    return usageData;
}
