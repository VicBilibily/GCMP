import type * as vscode from 'vscode';
import type OpenAI from 'openai';
import type { ModelConfig, ModelChatResponseOptions } from '../../../types/sharedTypes';
import { removeNullExtraBodyParams, replaceSessionIdInBody } from '../../../utils/text/formatUtils';
import { shouldDisableThinkingForRequest, type RequestKind } from '../../classification/requestClassifier';
import { getScopedRequestClassification } from '../../classification/requestClassification';
import { preprocessOpenAIChatRequest } from '../openaiChatRequestPreprocessor';
import { applyOpenAIServiceTier } from '../serviceTier';
import type { OpenAIProviderContext } from '../shared/providerContext';
import { filterExtraBodyParams } from '../shared/extraBody';
import type { OpenAIChatMessageConverter } from './messageConverter';

export function filterChatExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
    const coreParams = new Set([
        'model', // 模型名称
        'messages', // 消息数组
        'stream', // 流式开关
        'stream_options', // 流式选项
        'tools' // 工具定义
    ]);
    return filterExtraBodyParams(extraBody, coreParams);
}

/**
 * 解析模型配置的默认 reasoningEffort。
 * 规则必须与 languageModelInfo.ts 中 schema.default 的逻辑保持一致：
 * - 若配置了 reasoningDefault 且包含在 reasoningEffort 数组中，使用该值
 * - 若 reasoningEffort 数组包含 'medium'，默认值为 'medium'
 * - 否则默认值为数组首项
 */
function getReasoningDefault(modelConfig: ModelConfig): string | undefined {
    const efforts = modelConfig.reasoningEffort;
    if (!efforts || efforts.length === 0) {
        return modelConfig.reasoningDefault;
    }
    if (modelConfig.reasoningDefault && efforts.includes(modelConfig.reasoningDefault)) {
        return modelConfig.reasoningDefault;
    }
    if (efforts.includes('medium')) {
        return 'medium';
    }
    return efforts[0];
}

export class OpenAIChatRequestBuilder {
    constructor(
        private readonly providerInstance: Pick<OpenAIProviderContext, 'provider'>,
        private readonly messageConverter: OpenAIChatMessageConverter
    ) {}

    private get provider(): string {
        return this.providerInstance.provider;
    }

    /**
     * 构建聊天完成请求参数（共享方法，供 openai-sse 等自定义处理器复用）
     */
    buildChatCompletionParams(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        sessionId?: string
    ): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
        const requestModel = modelConfig.model || modelConfig.id;
        const createParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
            model: requestModel,
            messages: this.messageConverter.convertMessagesToOpenAI(messages, modelConfig),
            max_tokens: model.maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true }
        };

        // 添加工具支持（如果有）
        if (options.tools && options.tools.length > 0 && modelConfig.capabilities?.toolCalling) {
            createParams.tools = this.messageConverter.convertToolsToOpenAI([...options.tools]);
        }

        // 合并 extraBody 参数（如果有），过滤掉不可修改的核心参数
        let filteredExtraBody: Record<string, unknown> | undefined;
        if (modelConfig.extraBody) {
            filteredExtraBody = filterChatExtraBodyParams(
                replaceSessionIdInBody(modelConfig.extraBody, sessionId ?? '')
            );
            Object.assign(createParams, filteredExtraBody);
        }

        // 根据模型配置设置思考模式和推理长度
        // 注意：extraBody 中可能已注入 thinking/reasoning 等参数，以下逻辑会覆盖它们，
        // 确保 Chat UI 的选择或模型默认值始终生效。
        const settings = options.modelConfiguration as ModelChatResponseOptions;
        applyOpenAIServiceTier(
            createParams as unknown as Record<string, unknown>,
            modelConfig,
            settings,
            this.provider
        );
        const customParams = createParams as unknown as {
            enable_thinking?: boolean;
            thinking?: { type: 'enabled' | 'disabled' };
            reasoning_effort?: string;
            reasoning?: { effort?: string };
        };
        const thinkingFormat = modelConfig.thinkingFormat ?? 'boolean';
        const effortOnly = thinkingFormat === 'effort-only';
        const reasoningFormat = modelConfig.reasoningFormat ?? 'flat';
        if (effortOnly) {
            // effort-only 模式下只保留一种 reasoning 形态
            customParams.thinking = undefined;
            customParams.enable_thinking = undefined;
            if (reasoningFormat === 'nested') {
                delete customParams.reasoning_effort;
            } else {
                delete customParams.reasoning;
            }
        }
        // 解析最终生效的 thinking / reasoningEffort：
        // 优先使用 Chat UI 传入的 settings；若未传入，则回退到模型配置的默认值。
        // 默认值规则必须与 languageModelInfo.ts 中 schema.default 的逻辑保持一致，
        // 否则会出现"UI 显示默认 medium，实际请求却发 low"的不一致。
        const effectiveThinking = settings?.thinking ?? modelConfig.thinking?.[0];
        const effectiveReasoningEffort = settings?.reasoningEffort ?? getReasoningDefault(modelConfig);
        // 注意：仅在 settings 存在时才写入 thinking/effort 参数；settings 缺失时保留 extraBody
        // 注入的原始参数不做任何覆盖，由服务端或 extraBody 配置自行决定思考行为。
        if (settings) {
            if (effectiveThinking && (!thinkingFormat || thinkingFormat === 'boolean' || thinkingFormat === 'object')) {
                if (effectiveThinking === 'enabled') {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = { type: 'enabled' };
                    } else {
                        customParams.enable_thinking = true;
                    }
                } else if (effectiveThinking === 'disabled') {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = { type: 'disabled' };
                    } else {
                        customParams.enable_thinking = false;
                    }
                } else {
                    if (thinkingFormat === 'object') {
                        customParams.thinking = undefined;
                    } else {
                        customParams.enable_thinking = undefined;
                    }
                }
            }
            if (effectiveReasoningEffort) {
                if (effortOnly) {
                    // effort-only 不做 reasoningEffort 值映射，仅保留 reasoning 其余字段
                    if (reasoningFormat === 'nested') {
                        customParams.reasoning = {
                            ...(customParams.reasoning || {}),
                            effort: effectiveReasoningEffort
                        };
                        delete customParams.reasoning_effort;
                    } else {
                        customParams.reasoning_effort = effectiveReasoningEffort;
                        delete customParams.reasoning;
                    }
                    customParams.thinking = undefined;
                    customParams.enable_thinking = undefined;
                } else if (effectiveReasoningEffort === 'none') {
                    if (
                        modelConfig.thinkingFormat === 'effort-none' ||
                        (modelConfig.thinkingFormat === undefined &&
                            effectiveThinking === undefined &&
                            customParams.enable_thinking === undefined)
                    ) {
                        // 缺省格式不代表端点支持 enable_thinking。
                        if (reasoningFormat === 'nested') {
                            customParams.reasoning = { effort: 'none' };
                        } else {
                            customParams.reasoning_effort = 'none';
                        }
                    } else {
                        if (reasoningFormat === 'nested') {
                            customParams.reasoning = undefined;
                        } else {
                            customParams.reasoning_effort = undefined;
                        }
                        if (modelConfig.thinkingFormat === 'object' || modelConfig.thinkingFormat === 'object-none') {
                            customParams.thinking = { type: 'disabled' };
                        } else if (thinkingFormat === 'boolean' || thinkingFormat === 'boolean-none') {
                            customParams.enable_thinking = false;
                        }
                    }
                } else if (reasoningFormat === 'nested') {
                    // OpenAI 新版嵌套格式: { reasoning: { effort: '...' } }
                    if (effectiveReasoningEffort === 'minimal') {
                        customParams.reasoning = { effort: 'low' };
                    } else {
                        customParams.reasoning = { effort: effectiveReasoningEffort };
                    }
                } else {
                    customParams.reasoning_effort = effectiveReasoningEffort;
                    if (modelConfig.thinkingFormat === 'object' && effectiveReasoningEffort !== 'minimal') {
                        customParams.thinking = { type: 'enabled' };
                    }
                }
            }
        }
        const requestKind = (options.modelOptions as { requestKind?: RequestKind })?.requestKind;
        const isDisableThinking =
            !effortOnly &&
            (requestKind === 'git-commit-message' || settings?.thinking) &&
            shouldDisableThinkingForRequest(requestKind, getScopedRequestClassification(options));
        if (isDisableThinking) {
            if (reasoningFormat === 'nested') {
                customParams.reasoning = undefined;
            }
            if (thinkingFormat === 'object' || thinkingFormat === 'object-none') {
                customParams.thinking = { type: 'disabled' };
                customParams.reasoning_effort = undefined;
            } else if (thinkingFormat === 'boolean-none') {
                customParams.enable_thinking = false;
            } else if (thinkingFormat === 'effort-none') {
                // effort-none 模式：子请求通过 effort=none 关闭思考
                if (reasoningFormat === 'nested') {
                    customParams.reasoning = { effort: 'none' };
                } else {
                    customParams.reasoning_effort = 'none';
                }
            } else {
                if (customParams.enable_thinking) {
                    customParams.enable_thinking = false;
                }
            }
            if (customParams.thinking === undefined && customParams.reasoning_effort) {
                let effort: 'none' | 'minimal' | undefined;
                if (modelConfig.reasoningEffort?.includes('none')) {
                    effort = 'none';
                } else if (modelConfig.reasoningEffort?.includes('minimal')) {
                    effort = 'minimal';
                }
                if (effort && modelConfig.reasoningEffort?.indexOf(effort) === 0) {
                    customParams.enable_thinking = undefined;
                    customParams.reasoning_effort = effort;
                }
            }
        }

        preprocessOpenAIChatRequest(
            createParams.messages as unknown as { tool_calls?: { function?: { arguments?: unknown } }[] }[],
            createParams.tools as unknown as { function?: { parameters?: unknown } }[] | undefined
        );

        removeNullExtraBodyParams(createParams, filteredExtraBody);

        return createParams;
    }
}
