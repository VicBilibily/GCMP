import type { GenericUsageData } from '../usages/fileLogger/types';
import { UsageParser } from '../usages/fileLogger/usageParser';

export interface CopilotUsageData {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: Record<string, number | undefined>;
    completion_tokens_details?: Record<string, number | undefined>;
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

function getNumericField(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toGeminiModalityDetails(value: unknown, prefix = ''): NumericDetails | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const details: NumericDetails = {};
    for (const entry of value) {
        if (!isRecord(entry) || typeof entry.tokenCount !== 'number' || !Number.isFinite(entry.tokenCount)) {
            continue;
        }

        const normalizedModality =
            typeof entry.modality === 'string' && entry.modality.trim() ?
                normalizeDetailKey(entry.modality)
            :   'unknown';
        const detailKey = `${prefix}${normalizedModality}_tokens`;
        details[detailKey] = (details[detailKey] ?? 0) + entry.tokenCount;
    }

    return Object.keys(details).length > 0 ? details : undefined;
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

export function buildCopilotUsageData(rawUsage: unknown): CopilotUsageData | undefined {
    if (!isRecord(rawUsage)) {
        return undefined;
    }

    const parsed = UsageParser.parseRawUsage(rawUsage as GenericUsageData);
    const isOpenAIUsage = typeof rawUsage.prompt_tokens === 'number';
    const geminiThoughtsTokens = getNumericField(rawUsage, 'thoughtsTokenCount') ?? 0;
    const promptTokens = parsed.actualInput;
    const completionTokens = parsed.outputTokens + geminiThoughtsTokens;
    const totalTokens = parsed.totalTokens || promptTokens + completionTokens;

    if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
        return undefined;
    }

    const promptDetails = mergeNumericDetails(
        getFirstDetails(rawUsage, ['prompt_tokens_details', 'input_tokens_details']),
        toNestedNumericDetails(rawUsage.cache_creation, 'cache_creation_'),
        toGeminiModalityDetails(rawUsage.promptTokensDetails),
        toGeminiModalityDetails(rawUsage.cacheTokensDetails, 'cached_'),
        {
            cached_tokens: parsed.cacheReadTokens,
            ...(!isOpenAIUsage && parsed.cacheCreationTokens > 0 ?
                { cache_creation_tokens: parsed.cacheCreationTokens }
            :   {})
        }
    ) ?? { cached_tokens: parsed.cacheReadTokens };

    const completionDetails = mergeNumericDetails(
        getFirstDetails(rawUsage, ['completion_tokens_details', 'output_tokens_details']),
        toGeminiModalityDetails(rawUsage.candidatesTokensDetails),
        geminiThoughtsTokens > 0 ? { reasoning_tokens: geminiThoughtsTokens } : undefined
    );

    const usageData: CopilotUsageData = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        prompt_tokens_details: promptDetails
    };

    if (completionDetails) {
        usageData.completion_tokens_details = completionDetails;
    }

    return usageData;
}
