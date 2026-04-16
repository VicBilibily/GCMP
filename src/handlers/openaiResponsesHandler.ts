/*---------------------------------------------------------------------------------------------
 *  OpenAI Responses API 处理器
 *  专门处理 OpenAI Responses API 的消息转换和请求处理
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import OpenAI, { ClientOptions } from 'openai';
import { TokenUsagesManager } from '../usages/usagesManager';
import { Logger, sanitizeToolSchemaForTarget } from '../utils';
import { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type { CommitChatModelOptions } from '../commit';

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
                        Logger.warn(`${this.displayName} Responses API: 跳过名称为空的工具调用`);
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
                    Logger.trace(`${this.displayName} Responses API: 将最后一个用户消息状态设置为 incomplete`);
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
                    functionTool.parameters = sanitizeToolSchemaForTarget(
                        tool.inputSchema as Record<string, unknown>,
                        'openai'
                    );
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
                // 工具结果中的图片添加占位符
                texts.push('[Image]');
            } else if (item && typeof item === 'object') {
                // 尝试转换为字符串
                try {
                    const str = JSON.stringify(item);
                    if (str && str !== '{}') {
                        texts.push(str);
                    }
                } catch {
                    // 忽略无法序列化的对象
                }
            }
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
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        Logger.debug(`${model.name} 开始处理 ${this.displayName} Responses API 请求`);

        try {
            const client = await this.handler.createOpenAIClient(modelConfig);
            Logger.info(`🚀 ${model.name} 发送 ${this.displayName} Responses API 请求`);

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.providerKey,
                sdkMode: 'openai-responses',
                progress
            });

            const requestModel = modelConfig.model || modelConfig.id;

            // 将 vscode.CancellationToken 转换为 AbortSignal
            const abortController = new AbortController();
            const cancellationListener = token.onCancellationRequested(() => abortController.abort());
            let streamError: Error | null = null;
            let finalUsage: Record<string, unknown> | undefined = undefined;
            // 记录流处理的开始和结束时间
            let streamStartTime = Date.now();
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
            const toolCallIdToIndex = new Map<string, number>();
            let nextToolCallIndex = 0;

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
                const sessionId = statefulMarker?.sessionId || crypto.randomUUID();
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
                                    `🎯 ${model.name} 使用豆包缓存 previous_response_id: ${previousResponseId}`
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
                                        `🎯 ${model.name} 截断消息，从 ${originalMessages.length} 条减少到 ${newMessages.length} 条（跳过前 ${markerIndex + 1} 条已缓存消息）`
                                    );
                                }
                            } else {
                                Logger.debug(`🎯 ${model.name} 豆包缓存已过期，设置新的 expire_at`);
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
                    Logger.debug(`🎯 ${model.name} 使用 prompt_cache_key: ${sessionId}`);
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

                Logger.info(`🎯 ${model.name} 使用 session_id: ${sessionId}`);

                if (systemMessage) {
                    // 添加 system 消息作为 instructions
                    // Responses API 使用 instructions 参数而不是 system 消息
                    if (modelConfig.useInstructions === true) {
                        requestBody.instructions = systemMessage;
                        Logger.debug(`${this.displayName} Responses API: 使用 instructions 参数传递 system 消息`);
                    } else {
                        requestBody.instructions = undefined;
                        // 部分转发会直接使用 Codex 的 instructions 参数，这里特别在第一条位置插入一条用户消息
                        responsesMessages.unshift({
                            type: 'message' as const,
                            role: 'user' as const,
                            content: [{ type: 'input_text' as const, text: systemMessage }]
                        });
                        Logger.debug(`${this.displayName} Responses API: 在输入消息中使用 用户消息 传递 系统消息 指令`);
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
                    } else if (settings.reasoningEffort) {
                        const thinking: { type: string } = customParams.thinking || { type: 'enabled' };
                        thinking.type = 'enabled';
                        const reasoning = customParams.reasoning || { effort: 'medium' };
                        reasoning.effort = settings.reasoningEffort as string;
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
                // 如果处于提交模式，模型支持思考的，不使用思考模式
                const modelOpts = options.modelOptions as CommitChatModelOptions;
                if (modelOpts?.commit) {
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
                        } else if (modelId.toLowerCase().includes('gpt-5')) {
                            customParams.reasoning.effort = 'none';
                        }
                    }
                }

                // 调用 Responses API 的流式方法
                const stream = client.responses.stream(requestBody, { signal: abortController.signal });

                // 使用 on(event) 模式处理流事件
                stream
                    .on('response.created', () => {
                        // 响应开始事件 - 记录流开始时间
                        streamStartTime = Date.now();
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
                            reporter.reportText(delta);
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
                            reporter.reportText(text);
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
                            reporter.reportText(delta);
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
                            reporter.reportText(refusal);
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
                            reporter.bufferThinking(delta);
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
                            reporter.bufferThinking(event.text);
                        }
                        reporter.flushThinking('reasoning_text 完成');
                        reporter.endThinkingChain();
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
                            reporter.bufferThinking(delta);
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
                            reporter.bufferThinking(event.text);
                        }
                        reporter.flushThinking('reasoning_summary 完成');
                        reporter.endThinkingChain();
                    })
                    .on('response.reasoning_summary_part.done', event => {
                        // 推理摘要 part 完成（与官方实现对齐）
                        // 官方在此事件记录摘要已出现，避免 output_item.done 再次带出同一 item 的摘要文本
                        if (event.item_id) {
                            reasoningSummaryItemIds.add(event.item_id);
                        }
                    })
                    .on('response.function_call_arguments.delta', () => {
                        // SDK 会在 done 事件中提供完整的 arguments，这里不需要处理
                        if (token.isCancellationRequested) {
                            return;
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
                            Logger.warn(`工具调用 ${itemId} 没有名称`);
                            return;
                        }

                        // 使用 done 事件的完整参数
                        toolCallBuffers.set(idx, { id: callId, name, args });

                        // 尝试发送工具调用
                        try {
                            const input = JSON.parse(args || '{}');
                            reporter.reportToolCall(callId, name, input);
                            completedToolCallIndices.add(idx);
                        } catch (e) {
                            Logger.warn(`解析工具调用参数失败: ${args}`, e);
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
                                    reporter.reportToolCall(callId, name, input);
                                    completedToolCallIndices.add(idx);
                                } catch (e) {
                                    Logger.warn(`解析工具调用参数失败: ${args}`, e);
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
                                    reasoningItem.id && reasoningSummaryItemIds.has(reasoningItem.id)
                                        ? undefined
                                        : reasoningItem.summary?.map(s => s.text);
                                reporter.reportEncryptedThinking(
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
                                reporter.reportToolCall(callId as string, name, input);
                                completedToolCallIndices.add(idx);
                            } catch (e) {
                                Logger.warn(`解析工具调用参数失败: ${args}`, e);
                            }
                        }
                    })
                    .on('response.completed', event => {
                        streamEndTime = Date.now();

                        // 保存 usage 信息
                        if (event.response.usage) {
                            finalUsage = event.response.usage as unknown as Record<string, unknown>;
                        }

                        // 获取响应对象
                        const response = event.response;
                        const responseId = response?.id as string | undefined;

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
                                            reporter.reportToolCall(callId, item.name, input);
                                            completedToolCallIndices.add(idx);
                                        } catch (e) {
                                            Logger.warn(`解析工具调用参数失败: ${item.arguments}`, e);
                                        }
                                    }
                                }
                            }
                        }

                        if (responseId) {
                            // 流结束，输出所有剩余内容和 StatefulMarker
                            reporter.flushAll(null, {
                                sessionId,
                                responseId,
                                expireAt: sessionExpireAt
                            });
                            Logger.debug(
                                `💾 ${model.name} 传递 StatefulMarker: sessionId=${sessionId}，responseId=${responseId}`
                            );
                        } else {
                            reporter.flushAll(null);
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
                await stream.done();

                // 记录流结束时间
                streamEndTime ??= Date.now();

                // 检查是否有流错误
                if (streamError) {
                    throw streamError;
                }

                // 报告 usage 信息
                Logger.info(`📊 ${model.name} Responses API 请求完成`, finalUsage);

                if (requestId) {
                    try {
                        // === Token 统计: 更新实际 token ===
                        const usagesManager = TokenUsagesManager.instance;
                        await usagesManager.updateActualTokens({
                            requestId,
                            rawUsage: finalUsage || {},
                            status: 'completed',
                            streamStartTime,
                            streamEndTime
                        });
                    } catch (err) {
                        Logger.warn('更新Token统计失败:', err);
                    }
                }

                Logger.debug(`${model.name} ${this.displayName} Responses API 流处理完成`);
            } catch (error) {
                if (
                    token.isCancellationRequested ||
                    error instanceof vscode.CancellationError ||
                    error instanceof OpenAI.APIUserAbortError ||
                    (error instanceof Error && error.name === 'AbortError')
                ) {
                    Logger.info(`${model.name} Responses API 请求被用户取消`);
                    throw new vscode.CancellationError();
                } else {
                    Logger.error(`${model.name} Responses API 流处理错误: ${error}`);
                    streamError = error as Error;
                    throw error;
                }
            } finally {
                cancellationListener.dispose();
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Responses API 请求完成`);
        } catch (error) {
            if (error instanceof Error) {
                let errorMessage = error.message || '未知错误';

                // 尝试从 OpenAI SDK 的 APIError 中提取详细的错误信息
                // APIError 对象有一个 error 属性，其中包含了原始的 API 错误响应
                const apiError = error as APIErrorWithError;
                if (apiError.error && typeof apiError.error === 'object') {
                    const errorDetail = apiError.error as APIErrorDetail;
                    if (errorDetail.message && typeof errorDetail.message === 'string') {
                        errorMessage = errorDetail.message;
                        Logger.debug(`${model.name} 从 APIError.error 中提取到详细错误信息: ${errorMessage}`);
                    }
                }

                // 尝试从 error.cause 中提取详细的错误信息
                // APIConnectionError 可能会在 cause 中包含原始错误
                if (error.cause instanceof Error) {
                    const causeMessage = error.cause.message || '';
                    if (causeMessage && causeMessage !== errorMessage) {
                        errorMessage = causeMessage;
                        Logger.debug(`${model.name} 从 error.cause 中提取到详细错误信息: ${errorMessage}`);
                        throw error.cause;
                    }
                }

                Logger.error(`${model.name} ${this.displayName} Responses API 请求失败: ${errorMessage}`);

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

            if (error instanceof vscode.CancellationError) {
                throw error;
            } else if (error instanceof vscode.LanguageModelError) {
                throw error;
            } else {
                throw error;
            }
        }
    }
}
