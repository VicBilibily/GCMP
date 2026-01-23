/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用 Anthropic SDK 的模型请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, convertToAnthropicTools } from './anthropicConverter';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { PromptCacheManager } from './promptCacheManager';

/**
 * Anthropic 兼容处理器类
 * 接收完整的提供商配置，使用 Anthropic SDK 处理流式聊天完成
 */
export class AnthropicHandler {
    constructor(
        public readonly provider: string,
        private readonly providerConfig?: ProviderConfig
    ) {
        // provider 和 providerConfig 由调用方传入
        // displayName 和 baseURL 从 providerConfig 获取
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }
    private get baseURL(): string | undefined {
        return this.providerConfig?.baseUrl;
    }

    private resolveStickySessionKey(messages: readonly vscode.LanguageModelChatMessage[]): string {
        const cacheManager = PromptCacheManager.getInstance();
        const sessionHit = cacheManager.findByKind('anthropic-session', messages, 10);
        return sessionHit?.sessionId || this.generateClaudeCodeStyleSessionKey();
    }

    private generateClaudeCodeStyleSessionKey(): string {
        // Claude Code 风格：user_<hash>_account__session_<uuid>
        // - user_<hash>: 64 hex（这里用 sha256(machineId) 生成稳定值）
        // - session_<uuid>: 每个新会话生成一次，后续靠缓存复用
        let userHash = '';
        try {
            userHash = crypto.createHash('sha256').update(vscode.env.machineId).digest('hex');
        } catch {
            userHash = crypto.randomBytes(32).toString('hex');
        }
        const sessionUuid =
            typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        return `user_${userHash}_account__session_${sessionUuid}`;
    }

    /**
     * 创建 Anthropic 客户端
     * 每次都创建新的客户端实例，与 OpenAIHandler 保持一致
     */
    private async createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }

        // 使用模型配置的 baseUrl 或提供商默认的 baseURL
        let baseUrl = modelConfig?.baseUrl || this.baseURL;
        if (providerKey === 'minimax-coding') {
            // 针对 MiniMax 国际站进行 baseUrl 覆盖设置
            const endpoint = ConfigManager.getMinimaxEndpoint();
            if (baseUrl && endpoint === 'minimax.io') {
                baseUrl = baseUrl.replace('api.minimaxi.com', 'api.minimax.io');
            }
        }
        if (providerKey === 'zhipu') {
            // 针对智谱AI国际站进行 baseUrl 覆盖设置
            const endpoint = ConfigManager.getZhipuEndpoint();
            if (baseUrl && endpoint === 'api.z.ai') {
                baseUrl = baseUrl.replace('open.bigmodel.cn', 'api.z.ai');
            }
        }
        Logger.debug(`[${this.displayName}] 创建新的 Anthropic 客户端 (baseUrl: ${baseUrl})`);

        // 构建默认头部，包含提供商级别和模型级别的 customHeader
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent(this.provider)
        };

        // 合并提供商级别和模型级别的 customHeader
        // 模型级别的 customHeader 会覆盖提供商级别的同名头部
        const mergedCustomHeader = {
            ...this.providerConfig?.customHeader,
            ...modelConfig?.customHeader
        };

        // 处理合并后的 customHeader
        const processedCustomHeader = ApiKeyManager.processCustomHeader(mergedCustomHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.debug(`${this.displayName} 应用自定义头部: ${JSON.stringify(mergedCustomHeader)}`);
        }

        const client = new Anthropic({
            apiKey: currentApiKey,
            baseURL: baseUrl,
            authToken: currentApiKey, // 解决 Minimax 报错： Please carry the API secret key in the 'Authorization' field of the request header
            defaultHeaders: defaultHeaders
        });

        Logger.info(`${this.displayName} Anthropic 兼容客户端已创建`);
        return client;
    }

    /**
     * 处理 Anthropic SDK 请求
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        // 将 vscode.CancellationToken 转换为 AbortSignal
        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        try {
            const client = await this.createAnthropicClient(modelConfig);
            const { messages: anthropicMessages, system } = apiMessageToAnthropicMessage(modelConfig, messages);

            // 准备工具定义
            const tools: Anthropic.Messages.Tool[] = options.tools ? convertToAnthropicTools([...options.tools]) : [];

            // 使用模型配置中的 model 字段，如果没有则使用 model.id
            const modelId = modelConfig.model || model.id;

            const createParams: Anthropic.MessageCreateParamsStreaming = {
                model: modelId,
                max_tokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens),
                messages: anthropicMessages,
                stream: true,
                temperature: ConfigManager.getTemperature(),
                top_p: ConfigManager.getTopP()
            };

            // Anthropic 兼容接口的会话缓存：使用本地 sessionKey 写入 metadata.user_id，
            // 供“客户端传 session”的网关实现粘性会话。
            createParams.metadata = { user_id: this.resolveStickySessionKey(messages) };

            // 合并 extraBody 参数（如果有）
            if (modelConfig.extraBody) {
                // 过滤掉不可修改的核心参数
                const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
                Object.assign(createParams, filteredExtraBody);
                if (Object.keys(filteredExtraBody).length > 0) {
                    Logger.trace(`${model.name} 合并了 extraBody 参数: ${JSON.stringify(filteredExtraBody)}`);
                }
            }

            // 添加系统消息（如果有）
            if (system.text) {
                createParams.system = [system];
            }

            // 添加工具（如果有）
            if (tools.length > 0) {
                createParams.tools = tools;
            }

            Logger.debug(
                `[${model.name}] 发送 Anthropic API 请求，包含 ${anthropicMessages.length} 条消息，使用模型: ${modelId}`
            );

            const stream = await client.messages.create(createParams, { signal: abortController.signal });

            // 使用完整的流处理函数
            const result = await this.handleAnthropicStream(stream, progress, token, modelConfig);
            Logger.info(`[${model.name}] Anthropic 请求完成`, result?.usage);

            // 保存“客户端会话键”缓存：用本轮助手输出的摘要作为匹配锚点，供下一轮对话复用 metadata.user_id。
            const keyToCache = createParams.metadata?.user_id;
            if (typeof keyToCache === 'string' && keyToCache && result?.assistantSummary && result?.responseId) {
                // message_start.message.id 作为 messageId（用于追踪/诊断）
                const cacheManager = PromptCacheManager.getInstance();
                cacheManager.saveSessionCache(result.responseId, keyToCache, result.assistantSummary);
            }

            // === Token 统计: 更新实际 token ===
            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    // 直接传递 SDK 的 Usage 对象
                    await usagesManager.updateActualTokens({
                        requestId,
                        rawUsage: result?.usage || {},
                        status: 'completed'
                    });
                } catch (err) {
                    Logger.warn('更新Token统计失败:', err);
                }
            }
        } catch (error) {
            if (
                token.isCancellationRequested ||
                error instanceof Anthropic.APIUserAbortError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                Logger.info(`[${model.name}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }

            Logger.error(`[${model.name}] Anthropic SDK error:`, error);

            // 提供详细的错误信息
            let errorMessage = `[${model.name}] Anthropic API调用失败`;
            if (error instanceof Error) {
                if (error.message.includes('401')) {
                    errorMessage += ': API密钥无效，请检查配置';
                } else if (error.message.includes('429')) {
                    errorMessage += ': 请求频率限制，请稍后重试';
                } else if (error.message.includes('500')) {
                    errorMessage += ': 服务器错误，请稍后重试';
                } else {
                    errorMessage += `: ${error.message}`;
                }
            }

            progress.report(new vscode.LanguageModelTextPart(errorMessage));
            throw error;
        } finally {
            cancellationListener.dispose();
        }
    }

    /**
     * 处理 Anthropic 流式响应
     * 参照官方文档：https://docs.anthropic.com/en/api/messages-streaming
     * 参照官方实现：https://github.com/microsoft/vscode-copilot-chat/blob/main/src/extension/byok/vscode-node/anthropicProvider.ts
     */
    private async handleAnthropicStream(
        stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        _modelConfig?: ModelConfig
    ): Promise<{
        usage?: Anthropic.Messages.Usage;
        responseId?: string;
        assistantSummary?: string;
    }> {
        let pendingToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        // let pendingServerToolCall: { toolId?: string; name?: string; jsonInput?: string; type?: string } | undefined; // 暂不支持 web_search
        let pendingThinking: { thinking?: string; signature?: string } | undefined;
        let pendingRedactedThinking: { data: string } | undefined;
        let usage: Anthropic.Messages.Usage | undefined;

        // message_start 会包含 message.id。
        // 这里把它作为 responseId 记录，便于后续追踪/诊断。
        let responseId: string | undefined;

        // 构建用于缓存匹配的助手摘要：只需要能和后续 messages 里的 assistant 摘要对齐即可。
        const summaryLines: string[] = [];
        const seenToolIds = new Set<string>();
        // 一次响应可能包含多个 text/thinking content_block。
        // 为了能在后续 messages 摘要里匹配到，我们按“块”为单位收集并截断。
        type SummaryBlockType = 'text' | 'thinking' | null;
        let activeSummaryBlock: SummaryBlockType = null;
        let currentTextSummary = '';
        let currentThinkingSummary = '';
        const appendToCurrentTextSummary = (delta: string): void => {
            if (!delta) {
                return;
            }
            if (currentTextSummary.length >= 200) {
                return;
            }
            currentTextSummary = (currentTextSummary + delta).slice(0, 200);
        };
        const appendToCurrentThinkingSummary = (delta: string): void => {
            if (!delta) {
                return;
            }
            if (currentThinkingSummary.length >= 200) {
                return;
            }
            currentThinkingSummary = (currentThinkingSummary + delta).slice(0, 200);
        };
        const flushActiveSummaryBlock = (): void => {
            if (activeSummaryBlock === 'text') {
                const text = currentTextSummary.trim();
                if (text.length > 0) {
                    summaryLines.push(`assistant:text:${text}`);
                }
                currentTextSummary = '';
            } else if (activeSummaryBlock === 'thinking') {
                const thinking = currentThinkingSummary.trim();
                if (thinking.length > 0) {
                    summaryLines.push(`assistant:thinking:${thinking}`);
                }
                currentThinkingSummary = '';
            }
            activeSummaryBlock = null;
        };

        // 思考内容缓存的最大长度，达到这个范围时报告
        const MAX_THINKING_BUFFER_LENGTH = 20;
        // 当前正在输出的思维链 ID
        let currentThinkingId: string | null = null;
        // 追踪是否有输出过有效的文本内容
        let hasOutputContent = false;
        // 标记是否输出了 thinking 内容
        let hasThinkingContent = false;

        Logger.debug('开始处理 Anthropic 流式响应');

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    Logger.debug('流处理被取消');
                    // 使用统一方法处理剩余思考内容
                    this.reportRemainingThinkingContent(progress, pendingThinking, currentThinkingId, '流取消');
                    break;
                }

                // 处理特殊类型 - web_search_tool_result (暂不支持)
                /*
                if (
                    chunk.type === 'content_block_start' &&
                    'content_block' in chunk &&
                    chunk.content_block.type === 'web_search_tool_result'
                ) {
                    if (!pendingServerToolCall || !pendingServerToolCall.toolId) {
                        Logger.warn('收到web_search_tool_result但没有待处理的服务器工具调用');
                        continue;
                    }

                    const resultBlock = chunk.content_block as Anthropic.Messages.WebSearchToolResultBlock;
                    // 处理web搜索中的潜在错误
                    if (!Array.isArray(resultBlock.content)) {
                        Logger.error(
                            `Web搜索错误: ${(resultBlock.content as Anthropic.Messages.WebSearchToolResultError).error_code}`
                        );
                        continue;
                    }

                    const results = resultBlock.content.map((result: Anthropic.Messages.WebSearchResultBlock) => ({
                        type: 'web_search_result',
                        url: result.url,
                        title: result.title,
                        page_age: result.page_age,
                        encrypted_content: result.encrypted_content
                    }));

                    // 根据Anthropic的web_search_tool_result规范格式化
                    const toolResult = {
                        type: 'web_search_tool_result',
                        tool_use_id: pendingServerToolCall.toolId,
                        content: results
                    };

                    const searchResults = JSON.stringify(toolResult, null, 2);

                    // 向用户报告搜索结果
                    progress.report(
                        new vscode.LanguageModelToolResultPart(pendingServerToolCall.toolId!, [
                            new vscode.LanguageModelTextPart(searchResults)
                        ])
                    );

                    pendingServerToolCall = undefined;
                    continue;
                }
                */

                // 处理不同的事件类型
                switch (chunk.type) {
                    case 'message_start':
                        // 消息开始 - 收集初始使用统计
                        if (chunk.message.usage) {
                            usage = chunk.message.usage;
                        }
                        // 获取响应消息ID：message_start.message.id
                        if (!responseId) {
                            responseId = chunk.message.id;
                            Logger.debug(`收到 Anthropic message id (responseId): ${responseId}`);
                        }
                        break;

                    case 'content_block_start':
                        // 内容块开始
                        if (chunk.content_block.type === 'tool_use') {
                            // 新块开始前，先把上一块的摘要落盘（正常情况下上一块会先 stop，但这里做一下健壮性处理）
                            flushActiveSummaryBlock();

                            // 在工具调用开始前，使用统一方法处理剩余思考内容
                            this.reportRemainingThinkingContent(
                                progress,
                                pendingThinking,
                                currentThinkingId,
                                '工具调用开始'
                            );
                            // 清空 pendingThinking 内容和ID，避免重复处理
                            if (pendingThinking) {
                                pendingThinking.thinking = '';
                            }
                            currentThinkingId = null;

                            pendingToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: ''
                            };

                            // 工具调用摘要（用于后续匹配缓存）
                            if (chunk.content_block.id && chunk.content_block.name) {
                                const toolId = chunk.content_block.id;
                                if (!seenToolIds.has(toolId)) {
                                    seenToolIds.add(toolId);
                                    summaryLines.push(`assistant:tool_call:${toolId}:${chunk.content_block.name}`);
                                }
                            }
                            Logger.trace(`工具调用开始: ${chunk.content_block.name}`);
                        } else if (chunk.content_block.type === 'thinking') {
                            flushActiveSummaryBlock();
                            activeSummaryBlock = 'thinking';
                            currentThinkingSummary = '';
                            // 标记思考块开始
                            pendingThinking = {
                                thinking: '',
                                signature: ''
                            };
                            // 生成思考块ID
                            currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                            // 标记已输出 thinking 内容
                            hasThinkingContent = true;
                            Logger.trace('思考块开始 (流式输出)');
                        } else if (chunk.content_block.type === 'text') {
                            flushActiveSummaryBlock();
                            activeSummaryBlock = 'text';
                            currentTextSummary = '';

                            // 在文本块开始前，使用统一方法处理剩余思考内容
                            this.reportRemainingThinkingContent(
                                progress,
                                pendingThinking,
                                currentThinkingId,
                                '文本块开始'
                            );
                            // 清空 pendingThinking 内容和ID，避免重复处理
                            if (pendingThinking) {
                                pendingThinking.thinking = '';
                            }
                            currentThinkingId = null;
                            Logger.trace('文本块开始');
                        } /* else if (chunk.content_block.type === 'server_tool_use') {
                            // 处理服务器端工具使用（例如 web_search）(暂不支持)
                            pendingServerToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: '',
                                type: chunk.content_block.name
                            };
                            progress.report(new vscode.LanguageModelTextPart('\n'));
                            Logger.trace(`服务器工具调用开始: ${chunk.content_block.name}`);
                        } */ else if (chunk.content_block.type === 'redacted_thinking') {
                            const redactedBlock = chunk.content_block as Anthropic.Messages.RedactedThinkingBlock;
                            pendingRedactedThinking = {
                                data: redactedBlock.data
                            };
                            Logger.trace('加密思考块开始');
                        }
                        break;

                    case 'content_block_delta':
                        // 内容块增量更新
                        if (chunk.delta.type === 'text_delta') {
                            // 文本内容增量
                            progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
                            // 缓存摘要文本（按块最多 200 字符）
                            if (activeSummaryBlock === 'text') {
                                appendToCurrentTextSummary(chunk.delta.text);
                            }
                            // 标记已有输出内容
                            hasOutputContent = true;
                        } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                            // 工具调用参数增量
                            pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;
                            // 尝试解析累积的JSON，看是否完整
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput);
                                progress.report(
                                    new vscode.LanguageModelToolCallPart(
                                        pendingToolCall.toolId!,
                                        pendingToolCall.name!,
                                        parsedJson
                                    )
                                );
                                pendingToolCall = undefined;
                            } catch {
                                // JSON尚未完整，继续累积
                            }
                            // 工具调用也算作输出内容
                            hasOutputContent = true;
                        } /* else if (chunk.delta.type === 'input_json_delta' && pendingServerToolCall) {
                            // 服务器工具调用参数增量 (暂不支持)
                            pendingServerToolCall.jsonInput =
                                (pendingServerToolCall.jsonInput || '') + chunk.delta.partial_json;
                        } */ else if (chunk.delta.type === 'thinking_delta') {
                            // 思考内容增量 - 只累积到 pendingThinking，用缓冲机制报告
                            const thinkingDelta = chunk.delta.thinking || '';

                            // 同时用于缓存摘要（按块最多 200 字符），确保 think-only 响应也能命中会话。
                            if (activeSummaryBlock === 'thinking') {
                                appendToCurrentThinkingSummary(thinkingDelta);
                            }

                            if (pendingThinking) {
                                // 累积到 pendingThinking
                                pendingThinking.thinking = (pendingThinking.thinking || '') + thinkingDelta;

                                // 用 pendingThinking 的内容作为缓冲进行报告
                                const currentThinkingContent = pendingThinking.thinking || '';

                                // 当内容达到最大长度时报告
                                if (currentThinkingContent.length >= MAX_THINKING_BUFFER_LENGTH) {
                                    if (!currentThinkingId) {
                                        currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                                    }
                                    try {
                                        progress.report(
                                            new vscode.LanguageModelThinkingPart(
                                                currentThinkingContent,
                                                currentThinkingId
                                            )
                                        );
                                        // 清空 pendingThinking 的内容，避免重复报告
                                        pendingThinking.thinking = '';
                                    } catch (e) {
                                        Logger.trace(`报告思考内容失败: ${String(e)}`);
                                    }
                                }
                            }
                        } else if (chunk.delta.type === 'signature_delta') {
                            // 累积签名
                            if (pendingThinking) {
                                pendingThinking.signature =
                                    (pendingThinking.signature || '') + (chunk.delta.signature || '');
                            }
                        } /* else if (chunk.delta.type === 'citations_delta') {
                            // 处理引用增量
                            if ('citation' in chunk.delta) {
                                const citation = chunk.delta
                                    .citation as Anthropic.Messages.CitationsWebSearchResultLocation;
                                if (citation.type === 'web_search_result_location') {
                                    // 根据Anthropic规范格式化引用
                                    const citationData = {
                                        type: 'web_search_result_location',
                                        url: citation.url,
                                        title: citation.title,
                                        encrypted_index: citation.encrypted_index,
                                        cited_text: citation.cited_text
                                    };

                                    // 将引用格式化为可读的块引用和源链接
                                    const referenceText = `\n> "${citation.cited_text}" — [来源](${citation.url})\n\n`;

                                    // 向用户报告格式化的引用文本
                                    progress.report(new vscode.LanguageModelTextPart(referenceText));

                                    // 以正确格式存储引用数据，用于多轮对话
                                    progress.report(
                                        new vscode.LanguageModelToolResultPart('citation', [
                                            new vscode.LanguageModelTextPart(JSON.stringify(citationData, null, 2))
                                        ])
                                    );
                                }
                            }
                        } */
                        break;

                    case 'content_block_stop':
                        // 内容块停止
                        if (pendingToolCall) {
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput || '{}');
                                progress.report(
                                    new vscode.LanguageModelToolCallPart(
                                        pendingToolCall.toolId!,
                                        pendingToolCall.name!,
                                        parsedJson
                                    )
                                );
                                Logger.debug(`工具调用完成: ${pendingToolCall.name}`);
                            } catch (e) {
                                Logger.error(`解析工具调用 JSON 失败 (${pendingToolCall.name}):`, e);
                            }
                            pendingToolCall = undefined;
                        } else if (pendingThinking) {
                            // 处理思考块结束 - 统一处理思考内容和签名信息
                            let hasReportedContent = false;

                            // 如果有思考内容，先报告并可能添加签名元数据
                            const finalThinkingContent = pendingThinking.thinking || '';
                            if (finalThinkingContent.length > 0 && currentThinkingId) {
                                const finalThinkingPart = new vscode.LanguageModelThinkingPart(
                                    finalThinkingContent,
                                    currentThinkingId
                                );

                                // 如果有签名，添加到元数据中
                                if (pendingThinking.signature) {
                                    finalThinkingPart.metadata = {
                                        signature: pendingThinking.signature,
                                        _completeThinking: finalThinkingContent
                                    };
                                }

                                progress.report(finalThinkingPart);
                                // 结束当前思维链
                                progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingId));
                                hasReportedContent = true;
                            }

                            // 如果只有签名但没有思考内容，创建一个包含签名元数据的空思考部分
                            if (!hasReportedContent && pendingThinking.signature) {
                                const signaturePart = new vscode.LanguageModelThinkingPart('');
                                signaturePart.metadata = {
                                    signature: pendingThinking.signature,
                                    _completeThinking: finalThinkingContent
                                };
                                progress.report(signaturePart);
                            }

                            pendingThinking = undefined;
                            Logger.debug('思考块完成');
                        } else if (pendingRedactedThinking) {
                            pendingRedactedThinking = undefined;
                            Logger.debug('加密思考块完成');
                        }

                        // 结束一个 content_block 时，把对应的摘要写入 summaryLines。
                        flushActiveSummaryBlock();
                        break;

                    case 'message_delta':
                        // 消息增量 - 更新使用统计
                        if (chunk.usage) {
                            // 部分 Claude 网关只会在 message_delta（通常伴随 stop_reason）里返回 usage。
                            // 此时 message_start 不包含 usage，所以这里需要支持 usage 的延迟初始化。
                            if (!usage) {
                                usage = chunk.usage as unknown as Anthropic.Messages.Usage;
                            } else {
                                // 合并 MessageDeltaUsage 增量到当前 Usage
                                usage = {
                                    ...usage,
                                    input_tokens: chunk.usage.input_tokens ?? usage.input_tokens,
                                    output_tokens: chunk.usage.output_tokens ?? usage.output_tokens,
                                    cache_read_input_tokens:
                                        chunk.usage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
                                    cache_creation_input_tokens:
                                        chunk.usage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens
                                } as Anthropic.Messages.Usage;
                            }
                        }
                        break;

                    case 'message_stop':
                        // 消息停止 - 使用统一方法处理剩余思考内容
                        this.reportRemainingThinkingContent(progress, pendingThinking, currentThinkingId, '消息流结束');
                        // 清空 pendingThinking 内容和ID，避免重复处理
                        if (pendingThinking) {
                            pendingThinking.thinking = '';
                        }
                        currentThinkingId = null;
                        // 只有在输出了 thinking 内容但没有输出 content 时才添加 <think/> 占位符
                        if (hasThinkingContent && !hasOutputContent) {
                            progress.report(new vscode.LanguageModelTextPart('<think/>'));
                            Logger.warn('消息流结束时只有思考内容没有文本内容，添加了 <think/> 占位符作为输出');

                            // 我们人为输出了文本占位符，摘要也要包含它，便于后续命中。
                            summaryLines.push('assistant:text:<think/>');
                        }
                        Logger.trace('消息流完成');
                        break;

                    default:
                        // 未知事件类型 - 根据官方建议优雅处理
                        // 可能包括 ping 事件或未来的新事件类型
                        Logger.trace('收到其他事件类型');
                        break;
                }
            }
        } catch (error) {
            Logger.error('处理 Anthropic 流时出错:', error);
            // 错误处理逻辑移到 finally 块中统一处理
            throw error;
        } finally {
            // 统一处理未报告的思考内容（包括正常完成、错误、取消等情况）
            this.reportRemainingThinkingContent(progress, pendingThinking, currentThinkingId, '流处理结束');
        }

        if (usage) {
            Logger.debug(`流处理完成 - 最终使用统计: 输入=${usage.input_tokens}, 输出=${usage.output_tokens}`);
        }

        // 兜底：如果最后一个块没有正常 stop（例如取消/异常），这里补一次 flush。
        flushActiveSummaryBlock();

        const assistantSummary = summaryLines.join('\n');

        return { usage, responseId, assistantSummary };
    }

    /**
     * 统一处理剩余思考内容的报告
     */
    private reportRemainingThinkingContent(
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        pendingThinking: { thinking?: string; signature?: string } | undefined,
        currentThinkingId: string | null,
        context: string
    ): void {
        const thinkingContent = pendingThinking?.thinking || '';
        if (thinkingContent.length > 0 && currentThinkingId) {
            try {
                progress.report(new vscode.LanguageModelThinkingPart(thinkingContent, currentThinkingId));
                Logger.trace(`${context}时报告剩余思考内容: ${thinkingContent.length}字符`);
                // 结束当前思维链
                progress.report(new vscode.LanguageModelThinkingPart('', currentThinkingId));
            } catch (e) {
                Logger.trace(`${context}时报告思考内容失败: ${String(e)}`);
            }
        }
    }
}
