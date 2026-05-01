/*---------------------------------------------------------------------------------------------
 *  SDK ProviderOptions 构建器
 *  根据模型的 thinkingMode 和 SDK 类型构建对应的 providerOptions
 *--------------------------------------------------------------------------------------------*/

import type { SdkClientType } from '../aiSdkProvider';

/** providerOptions 的值类型——各 SDK 的专有参数集合 */
type ProviderOptionsMap = Record<string, Record<string, unknown>>;

/**
 * 按 SDK 类型构建 reasoningEffort / thinking / thinkingLevel 模式的 providerOptions
 *
 * @param effectiveSdkType 实际使用的 SDK 类型（考虑 aihubmix → openai-compatible 映射后的值）
 * @param thinkingMode 模型的思考模式：'reasoningEffort' | 'thinking' | 'thinkingLevel' | undefined
 * @param reasoningEffort 用户配置的推理强度
 * @param thinking 用户配置的思考开关
 * @param thinkingLevel 用户配置的思考级别（Gemini 3）
 * @returns 构建好的 providerOptions 对象
 */
export function buildProviderOptions(
    effectiveSdkType: SdkClientType,
    thinkingMode: string | undefined,
    reasoningEffort: string | undefined,
    thinking: string | undefined,
    thinkingLevel: string | undefined
): ProviderOptionsMap {
    const providerOptions: ProviderOptionsMap = {};

    if (thinkingMode === 'reasoningEffort' && reasoningEffort) {
        buildReasoningEffortOptions(providerOptions, effectiveSdkType, reasoningEffort);
    } else if (thinkingMode === 'thinking' && thinking) {
        buildThinkingOptions(providerOptions, effectiveSdkType, thinking);
    } else if (thinkingMode === 'thinkingLevel' && thinkingLevel) {
        buildThinkingLevelOptions(providerOptions, effectiveSdkType, thinkingLevel);
    }

    return providerOptions;
}

/** reasoningEffort 模式：各 SDK 对应的参数映射 */
function buildReasoningEffortOptions(
    providerOptions: ProviderOptionsMap,
    sdkType: SdkClientType,
    reasoningEffort: string
): void {
    switch (sdkType) {
        case 'openai':
            providerOptions.openai = { ...providerOptions.openai, reasoningEffort };
            break;
        case 'xai':
            providerOptions.xai = { ...providerOptions.xai, reasoningEffort };
            break;
        case 'anthropic':
            // Claude 新模型（Opus 4.5/4.6/4.7, Sonnet 4.6, Mythos）使用 effort 参数
            // AI SDK anthropic d.ts 暂未原生支持 effort，透传至 providerOptions
            providerOptions.anthropic = {
                ...providerOptions.anthropic,
                thinking: { type: 'enabled', budgetTokens: 10000 }
                // effort 通过 fetch 拦截器注入 body.output_config.effort
            };
            break;
        case 'openai-compatible':
            providerOptions.openaiCompatible = {
                ...providerOptions.openaiCompatible,
                reasoningEffort
            };
            break;
        case 'deepinfra':
            providerOptions.deepinfra = {
                ...providerOptions.deepinfra,
                reasoningEffort
            };
            break;
    }
}

/** thinking 模式：各 SDK 对应的参数映射 */
function buildThinkingOptions(
    providerOptions: ProviderOptionsMap,
    sdkType: SdkClientType,
    configThinking: string
): void {
    switch (sdkType) {
        case 'anthropic':
            providerOptions.anthropic = {
                ...providerOptions.anthropic,
                thinking:
                    configThinking === 'disabled' ? { type: 'disabled' } : { type: 'enabled', budgetTokens: 10000 }
            };
            break;
        case 'google':
            providerOptions.google = {
                ...providerOptions.google,
                thinkingConfig: configThinking === 'disabled' ? { thinkingBudget: 0 } : { thinkingBudget: 10000, includeThoughts: true }
            };
            break;
        case 'openai-compatible':
            // qwen/glm/kimi/minimax/ernie/deepseek-r1/v3 等
            // openai-compatible SDK 无原生 thinking 支持，
            // 通过 providerOptions 透传，由底层 API 按需处理
            providerOptions.openaiCompatible = {
                ...providerOptions.openaiCompatible,
                include_reasoning: configThinking !== 'disabled'
            };
            break;
        case 'openai':
        case 'openrouter':
        case 'deepinfra':
        case 'perplexity':
        case 'xai':
            // 这些 SDK 路径不预期出现 thinking 模式，
            // 但兜底通过 include_reasoning 透传
            providerOptions.openai = {
                ...providerOptions.openai,
                include_reasoning: configThinking !== 'disabled'
            };
            break;
    }
}

/** thinkingLevel 模式：Gemini 3 的思考级别参数 */
function buildThinkingLevelOptions(
    providerOptions: ProviderOptionsMap,
    sdkType: SdkClientType,
    thinkingLevel: string
): void {
    switch (sdkType) {
        case 'google':
            providerOptions.google = {
                ...providerOptions.google,
                thinkingConfig: {
                    thinkingLevel
                }
            };
            break;
        default:
            // 非 Google SDK 不应出现 thinkingLevel 模式，兜底忽略
            break;
    }
}
