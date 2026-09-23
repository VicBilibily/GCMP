/*---------------------------------------------------------------------------------------------
 *  Gemini 请求构建器
 *
 *  将转换后的 contents / tools 与 VS Code 请求选项组装为 GenerateContentRequest。
 *  本文件不依赖 vscode，可在纯 Node 单元测试中直接使用。
 *--------------------------------------------------------------------------------------------*/

import {
    GeminiContent,
    GeminiGenerateContentRequest,
    GeminiNormalizedUsage,
    GeminiTool,
    GeminiUsageMetadata
} from './geminiTypes';

export interface GeminiThinkingOptions {
    /** VS Code 思考模式 */
    thinking?: 'disabled' | 'enabled' | 'auto' | 'adaptive';
    /** 推理强度 */
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** 子请求（提交、标题生成等）：强制关闭思考 */
    isSubRequest?: boolean;
}

/**
 * 构建 Gemini generationConfig.thinkingConfig
 *
 * - 未显式设置（thinking / reasoningEffort 均为 undefined，且非子请求）：
 *   返回 undefined，请求中完全省略 thinkingConfig 字段——不支持思考的模型
 *   收到该字段会报错（Google API 文档），默认请求不应携带。
 * - 显式启用（thinking 为 enabled/auto/adaptive 或设置了推理强度）：
 *   动态预算，返回思考文本（includeThoughts: true）。
 * - 禁用（子请求、thinking: disabled、effort none/minimal）：
 *   返回 { thinkingBudget: 0 }。仅省略字段并不能关闭模型的内部推理，
 *   官方文档要求以 thinkingBudget 控制推理量；0 表示完全不思考，
 *   避免子请求产生多余的思考 token、延迟和费用。
 */
export function buildGeminiThinkingConfig(options: GeminiThinkingOptions): {
    thinkingBudget?: number;
    includeThoughts?: boolean;
} | undefined {
    const effort = options.reasoningEffort;
    const thinkingDisabled =
        options.isSubRequest === true ||
        options.thinking === 'disabled' ||
        effort === 'none' ||
        effort === 'minimal';

    if (thinkingDisabled) {
        return { thinkingBudget: 0 };
    }

    if (options.thinking === undefined && effort === undefined) {
        // 未显式设置：省略字段，兼容不支持思考的模型
        return undefined;
    }

    // 显式开启思考：动态预算，返回思考文本
    return { includeThoughts: true };
}

/** extraBody 中不允许覆盖的核心请求参数 */
const PROTECTED_BODY_KEYS = new Set([
    'contents',
    'systemInstruction',
    'tools',
    'toolConfig',
    'generationConfig',
    'safetySettings',
    'model'
]);

export interface BuildGeminiRequestParams {
    contents: GeminiContent[];
    systemInstruction?: GeminiContent;
    tools?: GeminiTool[];
    maxOutputTokens: number;
    thinkingOptions?: GeminiThinkingOptions;
    extraBody?: Record<string, unknown>;
}

/**
 * 组装 GenerateContentRequest 请求体
 */
export function buildGeminiRequest(params: BuildGeminiRequestParams): GeminiGenerateContentRequest {
    const request: GeminiGenerateContentRequest = {
        contents: params.contents
    };

    if (params.systemInstruction) {
        request.systemInstruction = params.systemInstruction;
    }

    if (params.tools && params.tools.length > 0) {
        request.tools = params.tools;
    }

    const thinkingConfig = params.thinkingOptions ? buildGeminiThinkingConfig(params.thinkingOptions) : undefined;
    const generationConfig: GeminiGenerateContentRequest['generationConfig'] = {
        maxOutputTokens: params.maxOutputTokens
    };
    if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
    }
    request.generationConfig = generationConfig;

    // 合并 extraBody（过滤掉不允许覆盖的核心参数）
    if (params.extraBody) {
        for (const [key, value] of Object.entries(params.extraBody)) {
            if (PROTECTED_BODY_KEYS.has(key)) {
                continue;
            }
            request[key] = value;
        }
    }

    return request;
}

/**
 * 将 Gemini usageMetadata 归一化为 OpenAI CompletionUsage 形状，
 * 便于复用 calculateCostWithBreakdown / TokenUsagesManager 等现有链路。
 *
 * 注意：Gemini 的 thoughtsTokenCount 是单独计费的输出 token
 * （官方计费说明：thoughts 按输出价格计费），必须计入 completion_tokens，
 * 否则费用估算会低估且与 promptTokenCount 对不上账。
 */
export function normalizeGeminiUsage(usageMetadata: GeminiUsageMetadata | undefined): GeminiNormalizedUsage | undefined {
    if (!usageMetadata) {
        return undefined;
    }

    const promptTokens = usageMetadata.promptTokenCount ?? 0;
    const thinkingTokens = usageMetadata.thoughtsTokenCount ?? 0;
    const completionTokens = (usageMetadata.candidatesTokenCount ?? 0) + thinkingTokens;
    const totalTokens = usageMetadata.totalTokenCount ?? promptTokens + completionTokens;

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        ...(usageMetadata.cachedContentTokenCount !== undefined && {
            prompt_tokens_details: { cached_tokens: usageMetadata.cachedContentTokenCount }
        }),
        ...(thinkingTokens > 0 && {
            completion_tokens_details: { reasoning_tokens: thinkingTokens }
        })
    };
}
