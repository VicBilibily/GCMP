/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API 处理器
 *  专门处理 OpenAI Responses API 的消息转换和请求处理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import OpenAI, { ClientOptions } from 'openai';
import { TokenUsagesManager } from '../usages/usagesManager';
import { Logger, sanitizeToolSchema, isCancellationError } from '../utils';
import { calculateCostWithBreakdown, formatCostBreakdownLog, toNanoAiu, toCostBreakdownLog } from '../utils';
import { t } from '../utils/l10n';
import { ModelChatResponseOptions, ModelConfig, ModelTokenPricing, WebSearchToolConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import { isSubRequest, type RequestKind } from './requestClassifier';
import * as liveMetrics from './liveMetrics';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import type { GenericModelProvider } from '../providers/genericModelProvider';

// 使用 OpenAI SDK 的 Responses API 类型
type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseInputMessageItem = OpenAI.Responses.ResponseInputMessageItem;
type ResponseInputText = OpenAI.Responses.ResponseInputText;
type ResponseInputImage = OpenAI.Responses.ResponseInputImage;
type ResponseReasoningItem = OpenAI.Responses.ResponseReasoningItem;
type ResponseFunctionToolCall = OpenAI.Responses.ResponseFunctionToolCall;
type ResponseFunctionToolCallOutputItem = OpenAI.Responses.ResponseFunctionToolCallOutputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;

/**
 * OpenAI Responses API ThinkingPart 元数据接口
 * 用于在多轮对话中传递加密思考内容 (encrypted_content)
 */
interface OpenAIResponsesThinkingMetadata {
    /** 加密的思考内容，由 OpenAI Responses API 在 include=["reasoning.encrypted_content"] 时返回 */
    redactedData?: string;
    /** 推理项的原始 id，用于回传给 API 重建 reasoning 输入项 */
    reasoningId?: string;
}

/**
 * OpenAI API 错误详情类型
 */
interface APIErrorDetail {
    message?: string;
    code?: string | null;
    type?: string;
    param?: string | null;
}

/**
 * OpenAI APIError 类型（包含 error 属性）
 */
interface APIErrorWithError extends Error {
    error?: APIErrorDetail | string;
    status?: number;
    headers?: Headers;
}

/**
 * OpenAI Responses API 处理器
 * 专门处理 Responses API 的消息转换和请求
 */
export class OpenAIResponsesHandler {
    private handler: OpenAIHandler;
    constructor(
        private providerInstance: GenericModelProvider,
        handler: OpenAIHandler
    ) {
        this.handler = handler;
    }
    private get providerKey(): string {
        return this.providerInstance.provider;
    }
    private get displayName(): string {
        return this.providerInstance.providerConfig.displayName;
    }

    /**
     * 将 vscode 消息转换为 OpenAI Responses API 格式
     * 参照官方 Responses API 规范实现
     * 注意：Responses API 不支持 system 消息，需要通过 instructions 参数传递
     * @param messages vscode 聊天消息数组
     * @param modelConfig 模型配置
     * @returns 包含 system 消息内容和其他消息的对象
     */
    public convertMessagesToOpenAIResponses(
        messages: readonly vscode.LanguageModelChatMessage[],
        modelConfig?: ModelConfig
    ): { systemMessage: string; messages: ResponseInputItem[] } {
        const out: ResponseInputItem[] = [];
        let systemMessage = '';

        for (const message of messages) {
            const role = this.mapRole(message.role);
            const textParts: string[] = [];
            const imageParts: vscode.LanguageModelDataPart[] = [];
            const toolCalls: Array<{ id: string; name: string; args: string }> = [];
            const toolResults: Array<{ callId: string; content: string }> = [];
            const thinkingParts: string[] = [];
            const encryptedReasonings: Array<{ encryptedContent: string; reasoningId?: string }> = []; // 收集加密的思考内容

            // 提取各类内容
            for (const part of message.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    textParts.push(part.value);
                } else if (
                    part instanceof vscode.LanguageModelDataPart &&
                    this.handler.isImageMimeType(part.mimeType)
                ) {
                    if (modelConfig?.capabilities?.imageInput === true) {
                        imageParts.push(part);
                    } else {
                        // 模型不支持图片时，添加占位符
                        textParts.push('[Image]');
                    }
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let args = '{}';
                    try {
                        args = JSON.stringify(part.input ?? {});
                    } catch {
                        args = '{}';
                    }
                    toolCalls.push({ id, name: part.name, args });
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    const callId = part.callId ?? '';
                    const content = this.collectToolResultText(part);
                    toolResults.push({ callId, content });
                } else if (part instanceof vscode.LanguageModelThinkingPart) {
                    // 检查是否包含加密思考内容 (由 include=["reasoning.encrypted_content"] 时返回)
                    const metadata = (part as unknown as { metadata?: OpenAIResponsesThinkingMetadata }).metadata;
                    if (metadata?.redactedData) {
                        encryptedReasonings.push({
                            encryptedContent: metadata.redactedData,
                            reasoningId: metadata.reasoningId
                        });
                    } else {
                        const content = Array.isArray(part.value) ? part.value.join('') : part.value;
                        thinkingParts.push(content);
                    }
                }
            }

            const joinedText = textParts.join('').trim();
            const joinedThinking = thinkingParts.join('').trim();

            // 处理 assistant 消息
            if (role === 'assistant') {
                // 先推送加密思考内容项（reasoning items with encrypted_content）
                // 这些需要在 assistant text 消息之前
                for (const { encryptedContent, reasoningId } of encryptedReasonings) {
                    out.push({
                        type: 'reasoning' as const,
                        // 使用保存的原始 id（官方实现使用 thinkingData.id）
                        id: reasoningId || `rsn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        summary: [],
                        encrypted_content: encryptedContent
                        // 注意：reasoning 输入项不接受 status 字段，API 会报 Unknown parameter 错误
                    } as unknown as ResponseReasoningItem);
                }

                const assistantText = joinedText || joinedThinking;
                if (assistantText) {
                    // Responses API 中，assistant 消息使用 output_text 类型
                    // 注意：在 input 数组中，assistant 消息的 content 必须使用 output_text
                    out.push({
                        type: 'message' as const,
                        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        role: 'assistant' as const,
                        status: 'completed' as const,
                        content: [{ type: 'output_text' as const, text: assistantText }]
                    } as unknown as ResponseInputMessageItem);
                }

                // 添加工具调用
                for (const tc of toolCalls) {
                    // 跳过名称为空的工具调用
                    if (!tc.name || tc.name.trim() === '') {
                        Logger.warn(`${this.displayName} Responses API: skipping tool call with empty name`);
                        continue;
                    }
                    out.push({
                        type: 'function_call' as const,
                        id: `fc_${tc.id}`,
                        call_id: tc.id,
                        name: tc.name,
                        arguments: tc.args,
                        status: 'completed' as const
                    } as unknown as ResponseFunctionToolCall);
                }
            }

            // 处理工具结果
            for (const tr of toolResults) {
                if (!tr.callId) {
                    continue;
                }
                out.push({
                    type: 'function_call_output' as const,
                    id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    call_id: tr.callId,
                    output: tr.content || '',
                    status: 'completed' as const
                } as unknown as ResponseFunctionToolCallOutputItem);
            }

            // 处理 user 消息
            if (role === 'user') {
                const contentArray: Array<ResponseInputText | ResponseInputImage> = [];
                if (joinedText) {
                    contentArray.push({ type: 'input_text' as const, text: joinedText });
                }
                for (const imagePart of imageParts) {
                    const dataUrl = this.handler.createDataUrl(imagePart);
                    contentArray.push({
                        type: 'input_image' as const,
                        image_url: dataUrl,
                        detail: 'auto' as const
                    });
                }
                if (contentArray.length > 0) {
                    out.push({
                        type: 'message' as const,
                        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        role: 'user' as const,
                        status: 'completed' as const,
                        content: contentArray
                    } as unknown as ResponseInputMessageItem);
                }
            }

            // 处理 system 消息
            // 注意：Responses API 不支持在 input 中使用 system 消息
            // system 消息需要通过 instructions 参数传递
            if (role === 'system' && joinedText) {
                systemMessage = joinedText;
            }
        }

        // 根据 Responses API 规范，将最后一个用户消息的状态设置为 incomplete
        // 这表示对话还在继续，等待模型响应
        if (out.length > 0) {
            const lastItem = out[out.length - 1];
            if (lastItem && typeof lastItem === 'object' && 'type' in lastItem) {
                const item = lastItem as unknown as Record<string, unknown>;
                if (item.type === 'message' && item.role === 'user') {
                    item.status = 'incomplete';
                    Logger.trace(`${this.displayName} Responses API: set the last user message status to incomplete`);
                }
            }
        }

        return { systemMessage, messages: out };
    }

    /**
     * 映射 vscode 角色到标准角色
     */
    private mapRole(role: number): 'user' | 'assistant' | 'system' {
        switch (role) {
            case vscode.LanguageModelChatMessageRole.User:
                return 'user';
            case vscode.LanguageModelChatMessageRole.Assistant:
                return 'assistant';
            case vscode.LanguageModelChatMessageRole.System:
                return 'system';
            default:
                return 'user';
        }
    }

    /**
     * 将 vscode 工具转换为 OpenAI Responses API 格式
     * Responses API 的工具格式与 ChatCompletion API 不同
     * ChatCompletion: { type: 'function', function: { name, description, parameters } }
     * Responses API: { type: 'function', name, description, parameters }
     * @param tools vscode 聊天工具数组
     * @returns FunctionTool 数组
     */
    private convertToolsToResponses(tools: readonly vscode.LanguageModelChatTool[]): FunctionTool[] {
        return tools.map(tool => {
            const functionTool: FunctionTool = {
                type: 'function',
                name: tool.name,
                description: tool.description || null,
                parameters: null,
                strict: false
            };

            // 处理参数schema
            if (tool.inputSchema) {
                if (typeof tool.inputSchema === 'object' && tool.inputSchema !== null) {
                    functionTool.parameters = sanitizeToolSchema(tool.inputSchema as Record<string, unknown>);
                } else {
                    // 如果不是对象，提供默认schema
                    functionTool.parameters = {
                        type: 'object',
                        properties: {},
                        required: []
                    };
                }
            } else {
                // 默认schema
                functionTool.parameters = {
                    type: 'object',
                    properties: {},
                    required: []
                };
            }

            return functionTool;
        });
    }

    /**
     * 收集工具结果的文本内容
     *
     * 仅保留有意义的语义内容：文本取 value，图片用 [Image] 占位符。
     * 其他所有 DataPart（cache_control / stateful_marker / thinking / context_management / usage
     * 等扩展内部元数据）一律跳过，不序列化，避免污染请求体和模型上下文。
     */
    public collectToolResultText(part: vscode.LanguageModelToolResultPart): string {
        if (!part.content || part.content.length === 0) {
            return '';
        }

        const texts: string[] = [];
        for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) {
                texts.push(item.value);
            } else if (item instanceof vscode.LanguageModelDataPart && this.handler.isImageMimeType(item.mimeType)) {
                texts.push('[Image]');
            }
            // 其他 DataPart（扩展内部元数据）和其他非文本 part 统一跳过
        }
        return texts.join('\n');
    }

    /**
     * 过滤extraBody中不可修改的核心参数
     * @param extraBody 原始extraBody参数
     * @returns 过滤后的参数，移除了不可修改的核心参数
     */
    private filterExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
        const coreParams = new Set([
            'model', // 模型名称
            'input', // 输入消息
            'stream', // 流式开关
            'tools' // 工具定义
        ]);

        const filtered: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(extraBody)) {
            if (!coreParams.has(key)) {
                filtered[key] = value;
                if (value == null) {
                    filtered[key] = undefined;
                }
            }
        }

        return filtered;
    }

    /**
     * 处理 Responses API 请求 - 使用 OpenAI SDK 流式接口
     * 这是处理 openai-responses 模式的专用方法
     */
    async handleResponsesRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        requestStartTime?: number
    ): Promise<void> {
        Logger.debug(`${model.name} starting ${this.displayName} Responses API request handling`);
        const tokenPricing: ModelTokenPricing | undefined = modelConfig.tokenPricing;

        let reporter: StreamReporter | undefined;

        try {
            const client = await this.handler.createOpenAIClient(modelConfig);
            Logger.info(`🚀 ${model.name} Sending ${this.displayName} Responses API request`);

            // 创建统一的流报告器
            reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.providerKey,
                sdkMode: 'openai-responses',
                progress,
                sessionId,
                requestId,
                requestStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });
            // 局部收窄：try 块内用 const 引用确保 TypeScript 知道非 undefined，
            // 外层 let reporter 供 finally 兜底使用
            const streamReporter = reporter;

            const requestModel = modelConfig.model || modelConfig.id;

            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null;
            let finalUsage: Record<string, unknown> | undefined = undefined;
            // 记录流处理的开始和结束时间（response.created 到达前为 undefined，避免使用进入函数的旧时间）
            let streamStartTime: number | undefined;
            let streamEndTime: number | undefined = undefined;

            // Responses API 专属：按输出项追踪 delta/done 事件，避免跨 item 误去重导致后续文本被吞掉
            const textDeltaKeys = new Set<string>();
            const refusalDeltaKeys = new Set<string>();
            const reasoningTextDeltaKeys = new Set<string>();
            const reasoningSummaryDeltaKeys = new Set<string>();
            const reasoningSummaryItemIds = new Set<string>();

            const getContentEventKey = (itemId?: string, contentIndex?: number): string | undefined => {
                if (!itemId) {
                    return undefined;
                }
                return `${itemId}:${contentIndex ?? -1}`;
            };

            const getSummaryEventKey = (itemId?: string, summaryIndex?: number): string | undefined => {
                if (!itemId) {
                    return undefined;
                }
                return `${itemId}:summary:${summaryIndex ?? -1}`;
            };

            // 工具调用缓冲区 - 使用索引跟踪，支持累积
            const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
            const completedToolCallIndices = new Set<number>();
            // 追踪已通过 delta 计数的工具调用，避免 done/fallback 重复统计
            const deltaCountedToolCallIndices = new Set<number>();
            const toolCallIdToIndex = new Map<string, number>();
            let nextToolCallIndex = 0;

            // 追踪已上报的 web_search_call，避免 done/completed 两处重复上报
            const completedWebSearchCallIds = new Set<string>();

            // 从 web_search_call 的 action 提取语义内容，覆盖 search/open_page/find_in_page 三种动作
            const buildWebSearchCallContent = (item: Record<string, unknown>): string => {
                const action = item.action as Record<string, unknown> | undefined;
                if (!action) {
                    return JSON.stringify({ type: 'web_search_call' });
                }
                const actionType = typeof action.type === 'string' ? action.type : '';
                if (actionType === 'search') {
                    const queries = Array.isArray(action.queries) ? action.queries : undefined;
                    const query = typeof action.query === 'string' ? action.query : undefined;
                    return JSON.stringify({ type: 'web_search_call', action_type: 'search', query, queries });
                }
                if (actionType === 'open_page' && typeof action.url === 'string') {
                    return JSON.stringify({ type: 'web_search_call', action_type: 'open_page', url: action.url });
                }
                if (actionType === 'find_in_page' && typeof action.pattern === 'string') {
                    return JSON.stringify({
                        type: 'web_search_call',
                        action_type: 'find_in_page',
                        pattern: action.pattern
                    });
                }
                return JSON.stringify({ type: 'web_search_call', action_type: actionType || undefined });
            };

            // 获取工具调用索引的辅助函数
            const getToolCallIndex = (callId: string): number => {
                if (!toolCallIdToIndex.has(callId)) {
                    toolCallIdToIndex.set(callId, nextToolCallIndex++);
                }
                return toolCallIdToIndex.get(callId)!;
            };

            try {
                // 准备请求体
                // 将消息转换为 Responses API 格式
                const { systemMessage, messages: responsesMessages } = this.convertMessagesToOpenAIResponses(
                    messages,
                    modelConfig
                );

                // 准备请求体
                const requestBody: Record<string, unknown> = {
                    model: requestModel,
                    input: responsesMessages,
                    stream: true
                };

                const modelId = (modelConfig.model || modelConfig.id).toLowerCase();
                const isGptModel = modelId.includes('gpt');
                const isDoubaoOrVolcengine = modelId.includes('doubao') || modelConfig?.provider === 'volcengine';

                // 仅对 GPT 模型且 extraBody 配置了 reasoning 时自动添加 include
                // extraBody.include 可在后续 Object.assign 中覆盖此值（包括设为 null 来禁用）
                if (isGptModel && !isDoubaoOrVolcengine && modelConfig?.extraBody?.reasoning) {
                    requestBody.include = ['reasoning.encrypted_content'];
                }

                // 使用 statefulMarker 获取会话状态
                const markerAndIndex = getStatefulMarkerAndIndex(model.id, 'openai-responses', messages);
                const statefulMarker = markerAndIndex?.statefulMarker;
                const previousResponseId = statefulMarker?.responseId;
                let sessionExpireAt = statefulMarker?.expireAt;

                // 豆包/火山引擎的 previous_response_id 支持
                if (isDoubaoOrVolcengine) {
                    const extraBody: { caching?: { type?: string } } = modelConfig.extraBody || {};
                    if (extraBody?.caching?.type === 'enabled') {
                        if (previousResponseId) {
                            // 检查缓存是否过期且模型匹配
                            if (
                                sessionExpireAt &&
                                Date.now() < sessionExpireAt - 5 * 60 * 1000 &&
                                statefulMarker.modelId === model.id
                            ) {
                                requestBody.previous_response_id = previousResponseId;
                                Logger.debug(
                                    `🎯 ${model.name} Using Doubao cache previous_response_id: ${previousResponseId}`
                                );

                                // 截断消息数组，只保留最后匹配位置之后的新消息
                                const markerIndex = markerAndIndex?.index ?? -1;
                                const originalMessages = messages as vscode.LanguageModelChatMessage[];
                                if (markerIndex >= 0 && markerIndex < originalMessages.length - 1) {
                                    // 从 markerIndex + 1 开始截断，只发送新的消息
                                    const newMessages = originalMessages.slice(markerIndex + 1);
                                    // 重新转换消息
                                    const { messages: newResponsesMessages } = this.convertMessagesToOpenAIResponses(
                                        newMessages,
                                        modelConfig
                                    );
                                    requestBody.input = newResponsesMessages;
                                    Logger.debug(
                                        `🎯 ${model.name} Truncated messages from ${originalMessages.length} to ${newMessages.length} (skipped the first ${markerIndex + 1} cached messages)`
                                    );
                                }
                            } else {
                                Logger.debug(`🎯 ${model.name} Doubao cache expired, setting a new expire_at`);
                                sessionExpireAt = Date.now() + 1 * 3600 * 1000; // 1小时后过期
                                requestBody.expire_at = Math.floor(sessionExpireAt / 1000);
                            }
                        } else {
                            // 未命中缓存时设置过期时间
                            sessionExpireAt = Date.now() + 1 * 3600 * 1000; // 1小时后过期
                            requestBody.expire_at = Math.floor(sessionExpireAt / 1000);
                        }
                    }
                }
                // GPT/Codex 使用 sessionId 作为 prompt_cache_key
                else {
                    requestBody.prompt_cache_key = sessionId;
                    Logger.debug(`🎯 ${model.name} Using prompt_cache_key: ${sessionId}`);
                }

                const { _options: clientOptions } = client as unknown as { _options: ClientOptions };
                const { defaultHeaders: optHeaders } = clientOptions as { defaultHeaders: Record<string, string> };
                optHeaders['conversation_id'] = optHeaders['session_id'] = sessionId;
                if (this.providerKey === 'codex') {
                    const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth;
                    const accountId = await codexAuth?.getAccountId();
                    if (accountId && accountId.trim()) {
                        optHeaders['chatgpt-account-id'] = accountId.trim();
                    }
                }

                Logger.info(`🎯 ${model.name} Using session_id: ${sessionId}`);

                if (systemMessage) {
                    // 添加 system 消息作为 instructions
                    // Responses API 使用 instructions 参数而不是 system 消息
                    if (modelConfig.useInstructions === true) {
                        requestBody.instructions = systemMessage;
                        Logger.debug(`${this.displayName} Responses API: passing system message via instructions`);
                    } else {
                        requestBody.instructions = undefined;
                        // 部分转发会直接使用 Codex 的 instructions 参数，这里特别在第一条位置插入一条用户消息
                        responsesMessages.unshift({
                            type: 'message' as const,
                            role: 'user' as const,
                            content: [{ type: 'input_text' as const, text: systemMessage }]
                        });
                        Logger.debug(
                            `${this.displayName} Responses API: passing system instructions via a user message in input`
                        );
                    }
                }

                // tools - 转换并添加工具定义
                if (options?.tools && options.tools.length > 0) {
                    if (!isDoubaoOrVolcengine || !requestBody.previous_response_id) {
                        const tools = this.convertToolsToResponses(options.tools);
                        if (tools.length > 0) {
                            requestBody.tools = tools;
                        }
                    }
                }

                // 添加原生 Responses API 工具（web_search）
                // 仅根据模型能力配置（webSearchTool）决定是否注入，不受 provider 缓存过滤影响：
                // web_search 为固定原生工具，续聊时追加同一工具定义不会破坏 previous_response_id 缓存语义；
                // 不支持 web_search 的模型/提供商不会开启 webSearchTool 配置，天然被过滤
                //
                // 配置映射（WebSearchToolConfig -> OpenAI WebSearchTool）：
                // - allowedDomains -> filters.allowed_domains
                // - blockedDomains -> filters.blocked_domains
                // - userLocation   -> user_location（补充 type: 'approximate'）
                // - maxUses：OpenAI Responses API 不支持，忽略
                // 未配置或仅为 true 时，只保留 type 字段，其余字段均不传递（让 API 使用默认值）
                if (modelConfig.webSearchTool) {
                    const raw = modelConfig.webSearchTool;
                    const config: WebSearchToolConfig = typeof raw === 'object' && raw !== null ? raw : {};
                    const webSearchTool: Record<string, unknown> = { type: 'web_search' };
                    // allowedDomains / blockedDomains 合并到同一个 filters 对象
                    const filters: Record<string, unknown> = {};
                    if (config.allowedDomains?.length) {
                        filters.allowed_domains = config.allowedDomains;
                    }
                    if (config.blockedDomains?.length) {
                        filters.blocked_domains = config.blockedDomains;
                    }
                    if (Object.keys(filters).length > 0) {
                        webSearchTool.filters = filters;
                    }
                    if (config.userLocation) {
                        webSearchTool.user_location = {
                            type: 'approximate',
                            ...config.userLocation
                        };
                    }
                    const nativeTools: Array<Record<string, unknown>> = [webSearchTool];
                    const existingTools = requestBody.tools as unknown[] | undefined;
                    if (existingTools) {
                        requestBody.tools = [...existingTools, ...nativeTools];
                    } else {
                        requestBody.tools = nativeTools;
                    }
                    Logger.debug(
                        `${this.displayName} Added native Responses API tools: ${nativeTools.map(t => t.type).join(', ')}`
                    );
                }

                // Process extra configuration parameters from extraBody
                if (modelConfig?.extraBody) {
                    // 过滤掉不可修改的核心参数
                    const filteredExtraBody = this.filterExtraBodyParams(modelConfig.extraBody);
                    Object.assign(requestBody, filteredExtraBody);
                }

                // 根据模型配置设置思考模式和推理长度
                const settings = options.modelConfiguration as ModelChatResponseOptions;
                const customParams = requestBody as unknown as {
                    thinking?: { type: string };
                    reasoning?: { effort: string };
                };
                if (settings) {
                    if (settings.thinking) {
                        const thinking: { type: string } = customParams.thinking || { type: 'disabled' };
                        thinking.type = settings.thinking;
                        customParams.thinking = thinking;
                    }
                    if (settings.reasoningEffort) {
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
                    // 仅在 flex / priority 时传递 service_tier，auto / default 时不传递
                    if (settings.serviceTier) {
                        if (settings.serviceTier === 'flex' || settings.serviceTier === 'priority') {
                            requestBody.service_tier = settings.serviceTier;
                        } else {
                            delete requestBody.service_tier;
                        }
                    }
                }
                // 子请求不启用深度思考模式
                const modelOpts = options.modelOptions as { requestKind?: string };
                const requestKind = modelOpts?.requestKind as RequestKind | undefined;
                if (requestKind && isSubRequest(requestKind)) {
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
                        } else if (modelId.toLowerCase().includes('gpt')) {
                            customParams.reasoning.effort = 'none';
                        }
                    } else if (modelId.toLowerCase().includes('gpt')) {
                        customParams.reasoning = { effort: 'none' };
                    }
                }

                // 调用 Responses API 的流式方法
                const stream = client.responses.stream(requestBody, { signal: abortController.signal });

                // 使用 on(event) 模式处理流事件
                stream
                    .on('event', () => {
                        // 心跳：每个 SSE 事件触发一次实时指标更新，确保首流前 latency 平滑增长
                        streamReporter.heartbeat();
                    })
                    .on('response.created', () => {
                        // 响应开始事件 - 记录流开始时间，同时固定首流延迟（共用时间戳）
                        const now = Date.now();
                        streamStartTime = now;
                        streamReporter.markStreamStarted(now);
                    })
                    .on('response.output_text.delta', event => {
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            textDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            streamReporter.reportText(delta);
                        }
                    })
                    .on('response.output_text.done', event => {
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        // 某些网关只发送最终的 done 事件（没有增量）；去重必须按 output item/content part 粒度处理
                        if (eventKey && textDeltaKeys.has(eventKey)) {
                            return;
                        }
                        const text = event.text || '';
                        if (text) {
                            streamReporter.reportText(text);
                        }
                    })
                    .on('response.output_text.annotation.added', event => {
                        // 处理输出文本中的 URL 引用注解
                        // 官方 Responses API 在 web_search 结果中会附带 url_citation 注解
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const annotation = event.annotation as Record<string, unknown> | undefined;
                        if (annotation?.type === 'url_citation') {
                            const url = typeof annotation.url === 'string' ? annotation.url : '';
                            const title = typeof annotation.title === 'string' ? annotation.title : '';
                            if (url) {
                                const citationContent = JSON.stringify({
                                    type: 'url_citation',
                                    url,
                                    title: title || undefined,
                                    start_index:
                                        typeof annotation.start_index === 'number' ? annotation.start_index : undefined,
                                    end_index:
                                        typeof annotation.end_index === 'number' ? annotation.end_index : undefined
                                });
                                streamReporter.reportToolResult(
                                    `citation_${event.item_id || ''}_${event.annotation_index ?? ''}`,
                                    citationContent
                                );
                                Logger.debug(`${this.displayName} url_citation: ${url}${title ? ` "${title}"` : ''}`);
                            }
                        }
                    })
                    .on('response.refusal.delta', event => {
                        // 处理拒绝增量（当作普通文本）
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            refusalDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            streamReporter.reportText(delta);
                        }
                    })
                    .on('response.refusal.done', event => {
                        // 某些网关只发送 refusal.done，需要按 item/content 粒度兜底输出
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey && refusalDeltaKeys.has(eventKey)) {
                            return;
                        }
                        const refusal = event.refusal || '';
                        if (refusal) {
                            streamReporter.reportText(refusal);
                        }
                    })
                    .on('response.reasoning_text.delta', event => {
                        // 处理思维链文本增量
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        if (eventKey) {
                            reasoningTextDeltaKeys.add(eventKey);
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            streamReporter.bufferThinking(delta);
                        }
                    })
                    .on('response.reasoning_text.done', event => {
                        // 处理思维链文本完成
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const eventKey = getContentEventKey(event.item_id, event.content_index);
                        // 某些网关只发送最终的 done 事件（没有增量）
                        if ((!eventKey || !reasoningTextDeltaKeys.has(eventKey)) && event.text) {
                            streamReporter.bufferThinking(event.text);
                        }
                        streamReporter.flushThinking('reasoning_text 完成');
                        streamReporter.endThinkingChain();
                    })
                    .on('response.reasoning_summary_text.delta', event => {
                        // 处理思维链摘要增量（与官方实现一致：记录展示过摘要防止重复）
                        const eventKey = getSummaryEventKey(event.item_id, event.summary_index);
                        if (eventKey) {
                            reasoningSummaryDeltaKeys.add(eventKey);
                        }
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                        if (token.isCancellationRequested) {
                            abortController.abort();
                            return;
                        }
                        const delta = event.delta;
                        if (delta && typeof delta === 'string') {
                            streamReporter.bufferThinking(delta);
                        }
                    })
                    .on('response.reasoning_summary_text.done', event => {
                        // 处理思维链摘要完成
                        const eventKey = getSummaryEventKey(event.item_id, event.summary_index);
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                        if (token.isCancellationRequested) {
                            return;
                        }
                        // 某些网关只发送最终的 done 事件（没有增量）
                        if ((!eventKey || !reasoningSummaryDeltaKeys.has(eventKey)) && event.text) {
                            streamReporter.bufferThinking(event.text);
                        }
                        streamReporter.flushThinking('reasoning_summary 完成');
                        streamReporter.endThinkingChain();
                    })
                    .on('response.reasoning_summary_part.done', event => {
                        // 推理摘要 part 完成（与官方实现对齐）
                        // 官方在此事件记录摘要已出现，避免 output_item.done 再次带出同一 item 的摘要文本
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                    })
                    .on('response.function_call_arguments.delta', event => {
                        // Tool arguments delta only counts toward live chars/s when it can be mapped
                        // to a stable output item (item_id). If a compatibility gateway omits item_id
                        // and no stable index can be resolved, skip delta counting and let the
                        // done/fallback path count the complete arguments once.
                        // Prefer under-counting to double-counting.
                        if (token.isCancellationRequested) {
                            return;
                        }

                        const itemId = event.item_id;
                        const idx = itemId ? getToolCallIndex(itemId) : undefined;
                        if (idx === undefined) {
                            return;
                        }

                        // 某些兼容网关可能在 output_item.added 已带完整 args 后又补发 delta，
                        // 此时该 call 已 completed，跳过避免重复计数
                        if (completedToolCallIndices.has(idx)) {
                            return;
                        }

                        const delta = typeof event.delta === 'string' ? event.delta : '';
                        if (delta.length > 0) {
                            streamReporter.reportToolArgDelta(delta);
                            deltaCountedToolCallIndices.add(idx);
                        }
                    })
                    .on('response.function_call_arguments.done', event => {
                        if (token.isCancellationRequested) {
                            return;
                        }

                        const itemId = event.item_id;
                        const args = event.arguments || '';

                        if (!itemId) {
                            return;
                        }

                        const idx = getToolCallIndex(itemId);
                        if (completedToolCallIndices.has(idx)) {
                            return;
                        }

                        // 优先复用 added 事件中的 call_id；如果网关没发 added，则退回 item_id 并使用 done 事件中的 name
                        const buf = toolCallBuffers.get(idx);
                        const name = buf?.name || event.name;
                        const callId = buf?.id || itemId;
                        if (!name) {
                            Logger.warn(`Tool call ${itemId} has no name`);
                            return;
                        }

                        // 使用 done 事件的完整参数
                        toolCallBuffers.set(idx, { id: callId, name, args });

                        // 尝试发送工具调用
                        try {
                            const input = JSON.parse(args || '{}');
                            // delta 已逐步计数时跳过 args 字符统计，避免重复计入
                            streamReporter.reportToolCall(callId, name, input, {
                                countArgs: !deltaCountedToolCallIndices.has(idx)
                            });
                            completedToolCallIndices.add(idx);
                        } catch (e) {
                            Logger.warn(`Failed to parse tool call arguments: ${args}`, e);
                        }
                    })
                    .on('response.output_item.added', event => {
                        // 处理输出项添加事件
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const item = event.item;
                        // 官方实现：output_item.added 仅处理 function_call，reasoning 在 output_item.done 中处理
                        if (item && item.type === 'function_call') {
                            const itemId = item.id;
                            if (!itemId) {
                                return;
                            }

                            // call_id 可能不存在，此时使用 itemId
                            const callId = item.call_id || itemId;
                            const name = item.name || '';
                            const args = item.arguments || '';

                            // 使用 item.id 作为索引（delta/done 事件中的 item_id 对应这里）
                            const idx = getToolCallIndex(itemId);
                            if (completedToolCallIndices.has(idx)) {
                                return;
                            }

                            // 如果 call_id 和 item.id 不同，也建立 call_id 的映射
                            if (item.call_id && item.call_id !== itemId) {
                                toolCallIdToIndex.set(item.call_id, idx);
                            }

                            // 初始化或更新工具调用缓冲区
                            // 注意：此时 arguments 可能为空，参数会在后续的 delta/done 事件中累积
                            const buf = toolCallBuffers.get(idx) || { id: callId, name: '', args: '' };
                            buf.id = callId;
                            if (name) {
                                buf.name = name;
                            }
                            // 如果已经有参数（某些情况下），使用它
                            if (args) {
                                buf.args = args;
                            }
                            toolCallBuffers.set(idx, buf);

                            // 只有当参数完整时才发送工具调用
                            // 否则等待后续的 delta/done 事件
                            if (args && name) {
                                try {
                                    const input = JSON.parse(args);
                                    streamReporter.reportToolCall(callId, name, input, {
                                        countArgs: !deltaCountedToolCallIndices.has(idx)
                                    });
                                    completedToolCallIndices.add(idx);
                                } catch (e) {
                                    Logger.warn(`Failed to parse tool call arguments: ${args}`, e);
                                }
                            }
                        }
                    })
                    .on('response.output_item.done', event => {
                        // 处理输出项完成事件（兼容某些网关）
                        if (token.isCancellationRequested) {
                            return;
                        }
                        const item = event.item;
                        // 推理项完成：与官方实现对齐，在 output_item.done 处理 reasoning
                        // 官方对所有 reasoning 项都进入此分支，有加密内容时输出，无加密内容时为 no-op
                        if (item && item.type === 'reasoning') {
                            const reasoningItem = item as unknown as ResponseReasoningItem;
                            if (reasoningItem.encrypted_content) {
                                // 仅当摘要文本未经流式传输时才包含
                                // （参照官方实现: hasReceivedReasoningSummary 为 true 时传 undefined 避免重复）
                                const summaryText =
                                    reasoningItem.id && reasoningSummaryItemIds.has(reasoningItem.id) ?
                                        undefined
                                    :   reasoningItem.summary?.map(s => s.text);
                                streamReporter.reportEncryptedThinking(
                                    reasoningItem.encrypted_content,
                                    reasoningItem.id,
                                    summaryText
                                );
                            }
                            // else: 无加密内容，no-op（与官方 onProgress({ thinking: undefined }) 行为一致）
                        }
                        if (item && typeof item === 'object' && item.type === 'function_call') {
                            const itemObj = item as unknown as Record<string, unknown>;
                            const itemId = typeof itemObj.id === 'string' ? itemObj.id : '';
                            const callId = itemObj.call_id || itemObj.id;
                            const name = typeof itemObj.name === 'string' ? itemObj.name : '';
                            const args = typeof itemObj.arguments === 'string' ? itemObj.arguments : '';

                            if (!itemId || !callId || !name || !args) {
                                return;
                            }

                            const idx = getToolCallIndex(itemId);
                            if (completedToolCallIndices.has(idx)) {
                                return;
                            }

                            try {
                                const input = JSON.parse(args);
                                streamReporter.reportToolCall(callId as string, name, input, {
                                    countArgs: !deltaCountedToolCallIndices.has(idx)
                                });
                                completedToolCallIndices.add(idx);
                            } catch (e) {
                                Logger.warn(`Failed to parse tool call arguments: ${args}`, e);
                            }
                        }
                        // 处理内置 web_search_call：在 output_item.done 上报（此时 item 含完整 action）
                        // 抓包验证：output_item.added 时 item 仅含 id/type/status，无 action；
                        // action（search/open_page/find_in_page）只在 output_item.done 的 item.action 中出现
                        if (item && typeof item === 'object' && item.type === 'web_search_call') {
                            const wsItem = item as unknown as Record<string, unknown>;
                            const wsId = typeof wsItem.id === 'string' ? wsItem.id : '';
                            if (wsId && !completedWebSearchCallIds.has(wsId)) {
                                completedWebSearchCallIds.add(wsId);
                                const content = buildWebSearchCallContent(wsItem);
                                streamReporter.reportToolResult(wsId, content);
                                Logger.debug(`${this.displayName} web_search_call done: ${wsId}`);
                            }
                        }
                    })
                    .on('response.failed', event => {
                        streamEndTime ??= Date.now();
                        const errorMessage =
                            event.response.error?.message || t('Response generation failed', '响应生成失败');
                        Logger.warn(`${model.name} Responses API response.failed: ${errorMessage}`);
                        streamError ??= new Error(errorMessage);
                    })
                    .on('response.completed', event => {
                        streamEndTime = Date.now();

                        // 保存 usage 信息
                        if (event.response.usage) {
                            finalUsage = event.response.usage as unknown as Record<string, unknown>;
                        }

                        // 获取响应对象
                        const response = event.response;
                        const responseId = response?.id;

                        // 处理完整的响应中的工具调用（备用，确保所有工具调用都被处理）
                        if (response && response.output) {
                            const output = response.output;
                            if (Array.isArray(output)) {
                                for (const item of output) {
                                    if (item.type === 'function_call' && item.id && item.name) {
                                        const callId = item.call_id || item.id;
                                        const idx = getToolCallIndex(item.id);
                                        if (completedToolCallIndices.has(idx)) {
                                            continue;
                                        }

                                        try {
                                            const input = JSON.parse(item.arguments || '{}');
                                            streamReporter.reportToolCall(callId, item.name, input, {
                                                countArgs: !deltaCountedToolCallIndices.has(idx)
                                            });
                                            completedToolCallIndices.add(idx);
                                        } catch (e) {
                                            Logger.warn(`Failed to parse tool call arguments: ${item.arguments}`, e);
                                        }
                                    }
                                    // 处理 web_search_call 备用（response.completed 兜底）
                                    if (item.type === 'web_search_call' && item.id) {
                                        const wsItem = item as unknown as Record<string, unknown>;
                                        const wsId = typeof wsItem.id === 'string' ? wsItem.id : '';
                                        if (wsId && !completedWebSearchCallIds.has(wsId)) {
                                            completedWebSearchCallIds.add(wsId);
                                            const content = buildWebSearchCallContent(wsItem);
                                            streamReporter.reportToolResult(wsId, content);
                                            Logger.debug(`${this.displayName} web_search_call completed: ${wsId}`);
                                        }
                                    }
                                }
                            }
                        }

                        if (responseId) {
                            // 流结束，输出所有剩余内容，并将 usage 写入 StatefulMarker usage
                            streamReporter.flushAll(
                                null,
                                {
                                    sessionId,
                                    responseId,
                                    expireAt: sessionExpireAt
                                },
                                finalUsage
                            );
                            Logger.debug(
                                `💾 ${model.name} Passed StatefulMarker: sessionId=${sessionId}, responseId=${responseId}`
                            );
                        } else {
                            streamReporter.flushAll(null, undefined, finalUsage);
                        }
                    })
                    .on('error', error => {
                        // 保存错误，并中止请求
                        if (error instanceof Error) {
                            streamError = error;
                        } else {
                            // ResponseErrorEvent 不是 Error 类型，需要转换
                            const errorMsg =
                                'message' in error ? (error as { message: string }).message : String(error);
                            streamError = new Error(errorMsg);
                        }
                        abortController.abort();
                    });

                // 等待流处理完成
                try {
                    await stream.done();
                } catch (doneError) {
                    // SDK 内部处理器可能在 response.failed 先于 response.created 到达时抛出异常，
                    // 导致我们的 response.failed 处理器未运行、streamError 未被设置
                    if (!streamError) {
                        streamError = doneError instanceof Error ? doneError : new Error(String(doneError));
                    }
                }

                // 记录流结束时间
                streamEndTime ??= Date.now();

                // 检查是否有流错误
                if (streamError) {
                    throw streamError;
                }

                // 客户端成本估算：仅在模型配置了 tokenPricing 时才执行
                // 峰谷定价：用请求开始时间匹配 tier
                // 服务等级计费：传入 serviceTier，让 tier 按 serviceTier 匹配
                let costNanoAiu: number | undefined;
                let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
                if (tokenPricing) {
                    const costAt = requestStartTime ? new Date(requestStartTime) : new Date();
                    const requestServiceTier = (options.modelConfiguration as ModelChatResponseOptions)?.serviceTier;
                    breakdown = calculateCostWithBreakdown(finalUsage, tokenPricing, costAt, requestServiceTier);
                    if (breakdown) {
                        if (breakdown.total > 0) {
                            Logger.debug(formatCostBreakdownLog(streamReporter.getModelName(), breakdown));
                        }
                        costNanoAiu = toNanoAiu(breakdown.total);
                    }
                }
                streamReporter.reportUsage(finalUsage, costNanoAiu);

                // 报告 usage 信息
                Logger.info(`📊 ${model.name} Responses API request completed`, finalUsage);

                // 补齐流开始时间：兼容网关可能未发送 response.created
                streamStartTime ??= streamReporter.getMetricStreamStartTime();

                if (requestId) {
                    try {
                        // === Token 统计: 更新实际 token ===
                        const usagesManager = TokenUsagesManager.instance;
                        await usagesManager.updateActualTokens({
                            requestId,
                            sessionId,
                            rawUsage: finalUsage,
                            status: token.isCancellationRequested ? 'cancelled' : 'completed',
                            streamStartTime,
                            streamEndTime,
                            estimatedCost: breakdown?.total,
                            costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                        });
                    } catch (err) {
                        Logger.warn('Failed to update token stats:', err);
                    }
                }

                Logger.debug(`${model.name} ${this.displayName} Responses API stream completed`);
            } catch (error) {
                if (token.isCancellationRequested || isCancellationError(error)) {
                    Logger.info(`${model.name} Responses API request was cancelled by the user`);
                    // 记录为中止状态，而非错误或完成
                    try {
                        await TokenUsagesManager.instance.updateActualTokens({
                            requestId,
                            sessionId,
                            status: 'cancelled',
                            streamStartTime,
                            streamEndTime: streamEndTime ?? Date.now()
                        });
                    } catch (err) {
                        Logger.warn('Failed to update token stats for cancelled request:', err);
                    }
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} Responses API stream processing error: ${error}`);
                    streamError = error as Error;
                    throw error;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Responses API request completed`);
        } catch (error) {
            if (error instanceof Error) {
                let errorMessage = error.message || t('Unknown error', '未知错误');

                // 尝试从 OpenAI SDK 的 APIError 中提取详细的错误信息
                // APIError 对象有一个 error 属性，其中包含了原始的 API 错误响应
                const apiError = error as APIErrorWithError;
                if (apiError.error && typeof apiError.error === 'object') {
                    const errorDetail = apiError.error as APIErrorDetail;
                    if (errorDetail.message && typeof errorDetail.message === 'string') {
                        errorMessage = errorDetail.message;
                        Logger.debug(
                            `${model.name} Extracted detailed error message from APIError.error: ${errorMessage}`
                        );
                    }
                }

                // 尝试从 error.cause 中提取详细的错误信息
                // APIConnectionError 可能会在 cause 中包含原始错误
                if (error.cause instanceof Error) {
                    const causeMessage = error.cause.message || '';
                    if (causeMessage && causeMessage !== errorMessage) {
                        errorMessage = causeMessage;
                        Logger.debug(
                            `${model.name} Extracted detailed error message from error.cause: ${errorMessage}`
                        );
                        throw error.cause;
                    }
                }

                Logger.error(`${model.name} ${this.displayName} Responses API request failed: ${errorMessage}`);

                // 检查是否为特定的服务器错误
                if (
                    errorMessage.includes('502') ||
                    errorMessage.includes('Bad Gateway') ||
                    errorMessage.includes('500') ||
                    errorMessage.includes('Internal Server Error') ||
                    errorMessage.includes('503') ||
                    errorMessage.includes('Service Unavailable') ||
                    errorMessage.includes('504') ||
                    errorMessage.includes('Gateway Timeout')
                ) {
                    throw new vscode.LanguageModelError(errorMessage);
                }

                throw error;
            }

            if (isCancellationError(error)) {
                // 内层已通过 updateActualTokens 记录为 cancelled，规范化为 CancellationError 后抛出
                throw new vscode.CancellationError();
            } else if (error instanceof vscode.LanguageModelError) {
                throw error;
            } else {
                throw error;
            }
        } finally {
            reporter?.finishMetrics();
        }
    }
}
