import * as vscode from 'vscode';
import OpenAI from 'openai';

import { ModelChatResponseOptions, ModelConfig, NativeToolConfig } from '../../types/sharedTypes';
import { Logger } from '../../utils/runtime/logger';
import { isSubRequest, type RequestKind } from '../requestClassifier';
import { canDisableThinking } from '../thinkingSupport';
import { mergeNativeToolConfigs } from '../nativeToolUtils';
import { OpenAIResponsesMessageConverter } from './openaiResponsesMessageConverter';
import { preprocessOpenAIResponsesInputItems } from './openaiResponsesInputPreprocessor';
import { ENCRYPTED_REASONING_INCLUDE, isEncryptedReasoningEnabled } from './encryptedReasoning';
import { applyOpenAIServiceTier } from './serviceTier';

interface OpenAIResponsesRequestBuilderParams {
    model: vscode.LanguageModelChatInformation;
    modelConfig: ModelConfig;
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.ProvideLanguageModelChatResponseOptions;
    sessionId: string;
}

interface OpenAIResponsesRequestBuilderResult {
    requestBody: Record<string, unknown>;
}

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;

export function initializeResponsesRequestBody(params: {
    requestModel: string;
    input: ResponseInputItem[];
    sessionId: string;
    extraBody?: Record<string, unknown>;
}): Record<string, unknown> {
    const { requestModel, input, sessionId, extraBody } = params;
    const requestBody: Record<string, unknown> = {
        model: requestModel,
        input,
        stream: true,
        prompt_cache_key: sessionId
    };

    // extraBody 显式定义 include（含 null/[]）时视为用户接管该字段，不再自动注入加密思考项；
    // 例如多资源 Azure 中转场景可通过 { include: null } 关闭密文下发，避免跨资源校验失败。
    // 回放侧（input 是否携带密文 reasoning 项）使用同一判定，见 isEncryptedReasoningEnabled。
    const hasCustomInclude = extraBody != null && 'include' in extraBody;
    if (!hasCustomInclude && isEncryptedReasoningEnabled({ requestModel, extraBody })) {
        requestBody.include = [ENCRYPTED_REASONING_INCLUDE];
    }

    return requestBody;
}

export function applyResponsesSystemMessage(params: {
    requestBody: Record<string, unknown>;
    responsesMessages: ResponseInputItem[];
    systemMessage: string;
    useInstructions?: boolean;
}): void {
    const { requestBody, responsesMessages, systemMessage, useInstructions } = params;
    if (!systemMessage) {
        return;
    }

    if (useInstructions === true) {
        requestBody.instructions = systemMessage;
        return;
    }

    requestBody.instructions = undefined;
    responsesMessages.unshift({
        type: 'message' as const,
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: systemMessage }]
    } as unknown as ResponseInputItem);
}

export class OpenAIResponsesRequestBuilder {
    constructor(
        private readonly displayName: string,
        private readonly messageConverter: OpenAIResponsesMessageConverter,
        private readonly providerKey?: string
    ) {}

    build(params: OpenAIResponsesRequestBuilderParams): OpenAIResponsesRequestBuilderResult {
        const { model, modelConfig, messages, options, sessionId } = params;
        const requestModel = modelConfig.model || modelConfig.id;
        const requestKind = (options.modelOptions as { requestKind?: string } | undefined)?.requestKind as
            | RequestKind
            | undefined;
        const disableThinkingByRequestKind = requestKind !== undefined && isSubRequest(requestKind);
        const { systemMessage, messages: responsesMessages } = this.messageConverter.convertMessagesToOpenAIResponses(
            messages,
            modelConfig
        );

        const requestBody = initializeResponsesRequestBody({
            requestModel,
            input: responsesMessages,
            sessionId,
            extraBody: modelConfig.extraBody
        });
        Logger.debug(`🎯 ${model.name} Using prompt_cache_key: ${sessionId}`);

        const modelId = requestModel.toLowerCase();

        applyResponsesSystemMessage({
            requestBody,
            responsesMessages,
            systemMessage,
            useInstructions: modelConfig.useInstructions
        });
        if (systemMessage) {
            Logger.debug(
                modelConfig.useInstructions === true ?
                    `${this.displayName} Responses API: passing system message via instructions`
                :   `${this.displayName} Responses API: passing system instructions via a user message in input`
            );
        }
        this.applyDeclaredTools(requestBody, options);
        if (!disableThinkingByRequestKind) {
            this.applyNativeTools(requestBody, modelConfig);
        }
        this.applyExtraBody(requestBody, modelConfig);
        this.applyModelSettings(requestBody, model, modelConfig, modelId, options, requestKind);
        this.preprocessInputAndTools(requestBody);

        return { requestBody };
    }
    private applyDeclaredTools(
        requestBody: Record<string, unknown>,
        options: vscode.ProvideLanguageModelChatResponseOptions
    ): void {
        if (!options?.tools || options.tools.length === 0) {
            return;
        }

        const tools = this.messageConverter.convertToolsToResponses(options.tools);
        if (tools.length > 0) {
            requestBody.tools = tools;
        }
    }

    private applyNativeTools(requestBody: Record<string, unknown>, modelConfig: ModelConfig): void {
        const merged = mergeNativeToolConfigs(modelConfig.nativeTools, modelConfig.webSearchTool);
        if (merged.length === 0) {
            return;
        }

        const nativeToolEntries = merged.map(cfg => this.buildNativeToolEntry(cfg));
        const existingTools = requestBody.tools as unknown[] | undefined;
        if (existingTools) {
            requestBody.tools = [...existingTools, ...nativeToolEntries];
        } else {
            requestBody.tools = nativeToolEntries;
        }

        Logger.debug(
            `${this.displayName} Added native Responses API tools: ${nativeToolEntries.map(tool => tool.type).join(', ')}`
        );
    }

    private buildNativeToolEntry(cfg: NativeToolConfig): Record<string, unknown> {
        const entry: Record<string, unknown> = { ...cfg };
        if (cfg.type !== 'web_search') {
            return entry;
        }

        delete entry.maxUses;
        delete entry.allowedDomains;
        delete entry.blockedDomains;
        delete entry.userLocation;

        const filters: Record<string, unknown> = {};
        if (cfg.allowedDomains?.length) {
            filters.allowed_domains = cfg.allowedDomains;
        }
        if (cfg.blockedDomains?.length) {
            filters.blocked_domains = cfg.blockedDomains;
        }
        if (Object.keys(filters).length > 0) {
            entry.filters = filters;
        }
        if (cfg.userLocation) {
            entry.user_location = {
                type: 'approximate',
                ...cfg.userLocation
            };
        }

        return entry;
    }

    private applyExtraBody(requestBody: Record<string, unknown>, modelConfig: ModelConfig): void {
        if (!modelConfig?.extraBody) {
            return;
        }

        const filteredExtraBody = this.messageConverter.filterExtraBodyParams(modelConfig.extraBody);
        Object.assign(requestBody, filteredExtraBody);
    }

    private applyModelSettings(
        requestBody: Record<string, unknown>,
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        modelId: string,
        options: vscode.ProvideLanguageModelChatResponseOptions,
        requestKind?: RequestKind
    ): void {
        const settings = options.modelConfiguration as ModelChatResponseOptions;
        const customParams = requestBody as unknown as {
            thinking?: { type: string };
            enable_thinking?: boolean;
            reasoning?: { effort: string };
            reasoning_effort?: string;
        };

        applyOpenAIServiceTier(requestBody, modelConfig, settings, this.providerKey);

        const effortOnly = modelConfig.thinkingFormat === 'effort-only';
        if (effortOnly) {
            // effort-only 模式下不允许 thinking / enable_thinking 参数
            customParams.thinking = undefined;
            customParams.enable_thinking = undefined;
            delete customParams.reasoning_effort;
        }
        if (settings) {
            if (settings.thinking && !effortOnly) {
                const thinking: { type: string } = customParams.thinking || { type: 'disabled' };
                thinking.type = settings.thinking;
                customParams.thinking = thinking;
            }
            if (settings.reasoningEffort) {
                if (effortOnly) {
                    // effort-only 不做 reasoningEffort 值映射，仅保留 reasoning 其余字段
                    customParams.reasoning = {
                        ...(customParams.reasoning || {}),
                        effort: settings.reasoningEffort
                    };
                    delete customParams.reasoning_effort;
                } else {
                    const thinking: { type: string } = customParams.thinking || { type: 'enabled' };
                    thinking.type = 'enabled';
                    const reasoning = customParams.reasoning || { effort: 'medium' };
                    reasoning.effort = settings.reasoningEffort;
                    if (settings.reasoningEffort === 'minimal' || settings.reasoningEffort === 'none') {
                        thinking.type = 'disabled';
                    }
                    customParams.thinking = thinking;
                    customParams.reasoning = reasoning;
                    if (model.id.toLowerCase().includes('gpt')) {
                        customParams.thinking = undefined;
                    }
                }
            }
        }

        if (effortOnly || !requestKind || !isSubRequest(requestKind)) {
            return;
        }

        if (!canDisableThinking(modelConfig)) {
            // 模型不支持关闭思考（如 GLM-5.3）：省略思考参数，由服务端默认行为接管
            customParams.thinking = undefined;
            customParams.reasoning = undefined;
            return;
        }

        if (customParams.thinking) {
            customParams.thinking.type = 'disabled';
        }
        if (customParams.reasoning) {
            let effort: 'none' | 'minimal' | undefined;
            if (modelConfig.reasoningEffort?.includes('none')) {
                effort = 'none';
            } else if (modelConfig.reasoningEffort?.includes('minimal')) {
                effort = 'minimal';
            }
            if (effort) {
                customParams.reasoning.effort = effort;
            } else if (modelId.includes('gpt')) {
                customParams.reasoning.effort = 'none';
            }
        } else if (modelId.includes('gpt')) {
            customParams.reasoning = { effort: 'none' };
        }
    }

    private preprocessInputAndTools(requestBody: Record<string, unknown>): void {
        if (!Array.isArray(requestBody.input)) {
            return;
        }

        preprocessOpenAIResponsesInputItems(
            requestBody.input as Record<string, unknown>[],
            Array.isArray(requestBody.tools) ? (requestBody.tools as Record<string, unknown>[]) : undefined
        );
    }
}
