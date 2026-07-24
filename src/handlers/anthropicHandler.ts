/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用 Anthropic SDK 的模型请求
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { addCacheControlBreakpoints } from './anthropicCacheControl';
import { apiMessageToAnthropicMessage, convertToAnthropicTools } from './anthropicConverter';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { Logger } from '../utils/runtime/logger';
import { ConfigManager } from '../utils/config/configManager';
import { redactHeaders } from '../utils/net/proxyAgent';
import { isCancellationError } from '../utils/text/cancellationError';
import {
    calculateCostWithBreakdown,
    formatCostBreakdownLog,
    toNanoAiu,
    toCostBreakdownLog
} from '../utils/pricing/costCalculator';
import { VersionManager } from '../utils/runtime/versionManager';
import { createOpenCodeHeaders } from '../utils/text/formatUtils';
import { TokenUsagesManager } from '../usages/usagesManager';
import { t } from '../utils/runtime/l10n';
import type { ModelChatResponseOptions, ModelConfig, NativeToolConfig, ProviderConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { StreamReporter } from './streamReporter';
import { mergeNativeToolConfigs } from './nativeToolUtils';
import * as liveMetrics from './liveMetrics';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import { isSubRequest, type RequestKind } from './requestClassifier';
import { applyAnthropicThinkingConfiguration } from './anthropicThinkingConfig';

/**
 * Anthropic 兼容处理器类
 * 接收完整的提供商配置，使用 Anthropic SDK 处理流式聊天完成
 */
export class AnthropicHandler {
    constructor(private readonly providerInstance: GenericModelProvider) {
        // providerInstance 提供动态获取 providerConfig 和 providerKey 的能力
    }
    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }
    private get baseURL(): string | undefined {
        return this.providerConfig?.baseUrl;
    }

    private createAnthropicWebSearchTool(config: NativeToolConfig): Anthropic.Messages.WebSearchTool20250305 {
        const tool: Anthropic.Messages.WebSearchTool20250305 = {
            name: 'web_search',
            type: 'web_search_20250305'
        };

        if (config.maxUses !== undefined) {
            tool.max_uses = config.maxUses;
        }

        if (config.allowedDomains?.length) {
            tool.allowed_domains = config.allowedDomains;
        }
        if (config.blockedDomains?.length) {
            tool.blocked_domains = config.blockedDomains;
        }
        if (config.userLocation) {
            tool.user_location = {
                type: 'approximate',
                ...config.userLocation
            };
        }

        return tool;
    }

    private formatWebSearchToolResult(resultBlock: Anthropic.Messages.WebSearchToolResultBlock): string {
        if (!Array.isArray(resultBlock.content)) {
            return JSON.stringify(
                {
                    type: 'web_search_tool_result_error',
                    tool_use_id: resultBlock.tool_use_id,
                    error: resultBlock.content.error_code
                },
                null,
                2
            );
        }
        return JSON.stringify(
            {
                type: 'web_search_tool_result',
                tool_use_id: resultBlock.tool_use_id,
                content: resultBlock.content.map(result => ({
                    type: 'web_search_result',
                    url: result.url,
                    title: result.title,
                    page_age: result.page_age,
                    encrypted_content: result.encrypted_content
                }))
            },
            null,
            2
        );
    }
    private formatCitationDelta(citation: Anthropic.Messages.CitationsDelta['citation']): string | undefined {
        if (citation.type !== 'web_search_result_location') {
            return undefined;
        }
        return JSON.stringify(
            {
                type: 'web_search_result_location',
                url: citation.url,
                title: citation.title,
                cited_text: citation.cited_text,
                encrypted_index: citation.encrypted_index
            },
            null,
            2
        );
    }

    private _userHash?: string;
    private get userHash(): string {
        if (!this._userHash) {
            this._userHash = crypto.createHash('sha256').update(vscode.env.machineId).digest('hex');
        }
        return this._userHash;
    }

    /**
     * 创建 Anthropic 客户端
     * 每次都创建新的客户端实例，与 OpenAIHandler 保持一致
     */
    private async createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(t('Missing {0} API key', '缺少 {0} API 密钥', this.displayName));
        }

        // 使用模型配置的 baseUrl 或提供商默认的 baseURL
        let baseUrl = modelConfig?.baseUrl || this.baseURL;
        if (providerKey === 'minimax-token') {
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
        if (providerKey === 'xiaomimimo-token') {
            // 针对 Xiaomi MiMo Token Plan 接入点切换
            const endpoint = ConfigManager.getXiaomimimoEndpoint();
            if (baseUrl && endpoint && endpoint !== 'cn') {
                baseUrl = baseUrl.replace('token-plan-cn', `token-plan-${endpoint}`);
            }
        }
        Logger.debug(`[${this.displayName}] Creating new Anthropic client (baseUrl: ${baseUrl})`);

        // 构建默认头部，包含提供商级别和模型级别的 customHeader
        const defaultHeaders: Record<string, string> = {
            'User-Agent': VersionManager.getUserAgent(this.provider),
            // 'User-Agent': 'claude-cli/2.1.108 (external, cli)',
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
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
            Logger.debug(
                `${this.displayName} applying custom headers: ${JSON.stringify(redactHeaders(mergedCustomHeader))}`
            );
        }

        const proxyUrl = ConfigManager.resolveProxyForModel(modelConfig, this.provider);
        const client = new Anthropic({
            apiKey: currentApiKey,
            baseURL: baseUrl,
            authToken: currentApiKey, // 解决 Minimax 报错： Please carry the API secret key in the 'Authorization' field of the request header
            defaultHeaders: defaultHeaders,
            fetch: ConfigManager.createProxyAwareFetch({ proxyUrl }) as typeof fetch
        });

        Logger.trace(`${this.displayName} Anthropic-compatible client created`);
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
        requestId: string,
        sessionId: string,
        token: vscode.CancellationToken,
        requestStartTime?: number
    ): Promise<void> {
        // 将 vscode.CancellationToken 转换为 AbortSignal
        const abortController = new AbortController();
        const cancellationListener = token.onCancellationRequested(() => abortController.abort());

        let reporter: StreamReporter | undefined;

        try {
            const client = await this.createAnthropicClient(modelConfig);
            const { messages: anthropicMessages, system } = apiMessageToAnthropicMessage(modelConfig, messages);

            // 准备工具定义
            const tools: Anthropic.Messages.ToolUnion[] =
                options.tools ? convertToAnthropicTools([...options.tools]) : [];
            // 合并 nativeTools 中的 web_search 项与 webSearchTool，去重（nativeTools 优先）
            // Anthropic 仅支持 web_search，其他工具类型（如 web_extractor）忽略
            if (!tools.some(tool => tool.name === 'web_search')) {
                const wsConfig = mergeNativeToolConfigs(modelConfig.nativeTools, modelConfig.webSearchTool).find(
                    tool => tool.type === 'web_search'
                );
                if (wsConfig) {
                    tools.push(this.createAnthropicWebSearchTool(wsConfig));
                }
            }

            // 使用模型配置中的 model 字段，如果没有则使用 model.id
            const modelId = modelConfig.model || modelConfig.id;

            const createParams: Anthropic.MessageCreateParamsStreaming = {
                model: modelId,
                max_tokens: model.maxOutputTokens,
                messages: anthropicMessages,
                stream: true
            };

            createParams.metadata = { user_id: `user_${this.userHash}_account__session_${sessionId}` };

            // 合并 extraBody 参数（如果有）
            if (modelConfig.extraBody) {
                // 过滤掉不可修改的核心参数
                const filteredExtraBody = OpenAIHandler.filterExtraBodyParams(modelConfig.extraBody);
                Object.assign(createParams, filteredExtraBody);
                if (Object.keys(filteredExtraBody).length > 0) {
                    // 仅记录键名，避免泄露用户自定义参数值（可能含内部系统 ID 或临时凭证）
                    Logger.trace(`${model.name} merged extraBody keys: ${Object.keys(filteredExtraBody).join(', ')}`);
                }
            }

            // 根据模型配置设置思考模式和推理长度
            const settings = options.modelConfiguration as ModelChatResponseOptions;
            applyAnthropicThinkingConfiguration(createParams, settings, modelConfig);
            // 子请求（提交、标题生成、终端解释等）关闭思考
            const requestKind = (options.modelOptions as { requestKind?: RequestKind })?.requestKind;
            if (requestKind && isSubRequest(requestKind)) {
                applyAnthropicThinkingConfiguration(createParams, undefined, modelConfig, { disableThinking: true });
            }

            // 仅在 flex / priority 时传递 service_tier，auto / default 时不传递
            if (settings?.serviceTier) {
                if (settings.serviceTier === 'flex' || settings.serviceTier === 'priority') {
                    createParams.service_tier = settings.serviceTier as 'auto' | 'standard_only';
                } else {
                    delete createParams.service_tier;
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

            // 注入缓存断点：VS Code 1.130 起上游不再对第三方 vendor 模型下发
            // cache_control DataPart，需自行给 tools/system 稳定前缀打断点（#314）
            addCacheControlBreakpoints(tools, {
                messages: anthropicMessages,
                system: system.text ? system : undefined
            });

            Logger.debug(
                `[${model.name}] Sending Anthropic API request with ${anthropicMessages.length} messages, model: ${modelId}`
            );

            // const cacheCount = (JSON.stringify(createParams).match(/"cache_control"\s*:/g) || []).length;
            // Logger.warn(`[${model.name}] cache_control 数量: ${cacheCount}`);

            // opencode 专有：传递请求级跟踪标识头
            const anthropicStreamOptions: Record<string, unknown> = { signal: abortController.signal };
            if (this.provider === 'opencode') {
                anthropicStreamOptions.headers = createOpenCodeHeaders(requestId, sessionId);
            }

            // 提前创建 reporter，使实时 TTFT 从 provider 请求处理起点开始滚动；
            // 该起点不等同于严格的网络请求发出时刻。
            reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'anthropic',
                progress,
                sessionId,
                requestId,
                requestStartTime,
                onLiveMetrics: event => liveMetrics.emitLiveMetrics(event)
            });
            // 局部收窄：try 块内用 const 引用确保 TypeScript 知道非 undefined，
            // 外层 let reporter 供 finally 兜底使用
            const streamReporter = reporter;

            const stream = await client.messages.create(createParams, anthropicStreamOptions);

            // 使用完整的流处理函数
            const result = await this.handleAnthropicStream(stream, streamReporter, token);

            // 客户端成本估算：仅在模型配置了 tokenPricing 时才执行
            // 峰谷定价：用请求开始时间匹配 tier，确保整条流式响应按同一档位计费
            // 服务等级计费：传入 settings.serviceTier，让 tier 按 serviceTier 匹配
            let costNanoAiu: number | undefined;
            let breakdown: ReturnType<typeof calculateCostWithBreakdown> | undefined;
            if (modelConfig.tokenPricing) {
                const costAt = requestStartTime ? new Date(requestStartTime) : new Date();
                breakdown = calculateCostWithBreakdown(
                    result?.usage,
                    modelConfig.tokenPricing,
                    costAt,
                    settings?.serviceTier
                );
                if (breakdown) {
                    if (breakdown.total > 0) {
                        Logger.debug(formatCostBreakdownLog(model.name, breakdown));
                    }
                    costNanoAiu = toNanoAiu(breakdown.total);
                }
            }
            streamReporter.reportUsage(result?.usage, costNanoAiu);

            Logger.info(`[${model.name}] Anthropic request completed`, result?.usage);

            // === Token 统计: 更新实际 token ===
            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    // 直接传递 SDK 的 Usage 对象，包含流时间信息
                    await usagesManager.updateActualTokens({
                        requestId,
                        sessionId,
                        rawUsage: result?.usage,
                        status: token.isCancellationRequested ? 'cancelled' : 'completed',
                        streamStartTime: result?.streamStartTime,
                        streamEndTime: result?.streamEndTime,
                        estimatedCost: breakdown?.total,
                        costBreakdown: breakdown ? toCostBreakdownLog(breakdown) : undefined
                    });
                } catch (err) {
                    Logger.warn('Failed to update token stats:', err);
                }
            }
        } catch (error) {
            if (token.isCancellationRequested || isCancellationError(error)) {
                Logger.info(`[${model.name}] Request was cancelled by the user`);
                // 记录为中止状态，而非错误或完成
                if (requestId) {
                    try {
                        await TokenUsagesManager.instance.updateActualTokens({
                            requestId,
                            sessionId,
                            status: 'cancelled'
                        });
                    } catch (err) {
                        Logger.warn('Failed to update token stats for cancelled request:', err);
                    }
                }
                throw new vscode.CancellationError();
            }

            Logger.error(`[${model.name}] Anthropic SDK error:`, error);

            // // 提供详细的错误信息
            // let errorMessage = `[${model.name}] Anthropic API调用失败`;
            // if (error instanceof Error) {
            //     if (error.message.includes('401')) {
            //         errorMessage += ': API密钥无效，请检查配置';
            //     } else if (error.message.includes('429')) {
            //         errorMessage += ': 请求频率限制，请稍后重试';
            //     } else if (error.message.includes('500')) {
            //         errorMessage += ': 服务器错误，请稍后重试';
            //     } else {
            //         errorMessage += `: ${error.message}`;
            //     }
            // }

            // progress.report(new vscode.LanguageModelTextPart(errorMessage));
            throw error;
        } finally {
            reporter?.finishMetrics();
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
        reporter: StreamReporter,
        token: vscode.CancellationToken
    ): Promise<{
        usage?: Anthropic.Messages.Usage;
        responseId?: string;
        streamStartTime?: number;
        streamEndTime?: number;
    }> {
        let pendingToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        let pendingServerToolCall: { toolId?: string; name?: string; jsonInput?: string } | undefined;
        const completedServerToolCalls = new Map<string, { toolId?: string; name?: string; jsonInput?: string }>();
        let usage: Anthropic.Messages.Usage | undefined;
        let responseId: string | undefined;
        // 记录流处理的开始时间（message_start 到达前为 undefined，避免使用进入函数的旧时间）
        let streamStartTime: number | undefined;
        let streamEndTime: number | undefined = undefined;

        Logger.debug('Starting Anthropic stream response processing');

        try {
            for await (const chunk of stream) {
                // 心跳：触发实时指标更新（不固定首流延迟）
                reporter.heartbeat();

                if (token.isCancellationRequested) {
                    Logger.debug('Stream processing cancelled');
                    throw new vscode.CancellationError();
                }

                switch (chunk.type) {
                    case 'message_start': {
                        // 消息开始 - 记录流开始时间，同时固定首流延迟（共用时间戳）
                        const now = Date.now();
                        streamStartTime = now;
                        reporter.markStreamStarted(now);
                        // 收集初始使用统计
                        if (chunk.message.usage) {
                            usage = chunk.message.usage;
                        }
                        // 获取响应消息ID：message_start.message.id
                        if (!responseId && chunk.message.id) {
                            responseId = chunk.message.id;
                            reporter.setResponseId(responseId);
                            Logger.debug(`Received Anthropic message id (responseId): ${responseId}`);
                        }
                        break;
                    }

                    case 'content_block_start':
                        // 内容块开始
                        if (chunk.content_block.type === 'tool_use') {
                            pendingToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: ''
                            };
                        } else if (chunk.content_block.type === 'server_tool_use') {
                            pendingServerToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: JSON.stringify(chunk.content_block.input ?? {})
                            };
                        } else if (chunk.content_block.type === 'web_search_tool_result') {
                            const serverToolCall =
                                completedServerToolCalls.get(chunk.content_block.tool_use_id) ?? pendingServerToolCall;
                            if (!serverToolCall?.toolId) {
                                Logger.warn('Received web_search_tool_result but no corresponding server_tool_use');
                                break;
                            }

                            const searchResults = this.formatWebSearchToolResult(chunk.content_block);
                            // Logger.trace(
                            //     `[${reporter.getModelName()}] 收到原生 web_search_tool_result: ${searchResults}`
                            // );
                            if (!Array.isArray(chunk.content_block.content)) {
                                Logger.warn(
                                    `[${reporter.getModelName()}] web_search_tool_result returned error: ${chunk.content_block.content.error_code}`
                                );
                                completedServerToolCalls.delete(chunk.content_block.tool_use_id);
                                if (pendingServerToolCall?.toolId === chunk.content_block.tool_use_id) {
                                    pendingServerToolCall = undefined;
                                }
                                break;
                            }

                            reporter.reportToolResult(serverToolCall.toolId, searchResults);
                            completedServerToolCalls.delete(chunk.content_block.tool_use_id);
                            if (pendingServerToolCall?.toolId === chunk.content_block.tool_use_id) {
                                pendingServerToolCall = undefined;
                            }
                        }
                        break;

                    case 'content_block_delta':
                        // 内容块增量更新
                        if (chunk.delta.type === 'text_delta') {
                            // 文本内容增量
                            reporter.reportText(chunk.delta.text);
                        } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                            // 工具调用参数增量
                            const partialJson = chunk.delta.partial_json ?? '';
                            pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + partialJson;

                            // tool argument delta 是 provider 实际回传的一部分，即使 Chat 面板隐藏也应计入 token 估算
                            reporter.reportToolArgDelta(partialJson);

                            // 尝试立即解析并报告工具调用（如果 JSON 已完整）
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput);
                                // JSON 解析成功，立即报告工具调用（countArgs: false，已通过 reportToolArgDelta 统计）
                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson, {
                                    countArgs: false
                                });
                                Logger.trace(
                                    `[${reporter.getModelName()}] Tool call completed: ${pendingToolCall.name}`
                                );
                                pendingToolCall = undefined; // 清除待处理的工具调用
                            } catch {
                                // JSON 还不完整，继续累积
                            }
                        } else if (chunk.delta.type === 'input_json_delta' && pendingServerToolCall) {
                            const partialJson = chunk.delta.partial_json ?? '';
                            pendingServerToolCall.jsonInput = (pendingServerToolCall.jsonInput || '') + partialJson;
                            // tool argument delta 是 provider 实际回传的一部分
                            reporter.reportToolArgDelta(partialJson);
                        } else if (chunk.delta.type === 'thinking_delta') {
                            // 思考内容增量
                            const thinkingDelta = chunk.delta.thinking || '';
                            reporter.bufferThinking(thinkingDelta);
                        } else if (chunk.delta.type === 'citations_delta') {
                            if (!('citation' in chunk.delta)) {
                                break;
                            }

                            const citationContent = this.formatCitationDelta(chunk.delta.citation);
                            if (citationContent) {
                                // Logger.trace(
                                //     `[${reporter.getModelName()}] 收到 web_search citation: ${citationContent}`
                                // );
                                reporter.reportToolResult('citation', citationContent);
                            }
                        } else if (chunk.delta.type === 'signature_delta') {
                            // 累积签名
                            const signatureDelta = chunk.delta.signature || '';
                            reporter.bufferSignature(signatureDelta);
                        }
                        break;

                    case 'content_block_stop':
                        // 内容块停止（兜底处理）
                        if (pendingToolCall) {
                            // 如果还有未处理的工具调用，尝试最后一次解析
                            try {
                                const jsonInput = pendingToolCall.jsonInput || '{}';
                                Logger.trace(
                                    `[${reporter.getModelName()}] Fallback tool call handling on content_block_stop (${pendingToolCall.name}): ${jsonInput}`
                                );

                                let parsedJson: Record<string, unknown>;
                                try {
                                    parsedJson = JSON.parse(jsonInput);
                                } catch {
                                    // JSON 解析失败，使用空对象
                                    Logger.warn(`Tool call JSON is incomplete, using an empty object: ${jsonInput}`);
                                    parsedJson = {};
                                }

                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson, {
                                    countArgs: false
                                });
                            } catch (e) {
                                Logger.error(`Fallback tool call handling failed (${pendingToolCall.name}):`, e);
                            }
                            pendingToolCall = undefined;
                        } else if (pendingServerToolCall) {
                            const jsonInput = pendingServerToolCall.jsonInput || '{}';
                            Logger.trace(
                                `[${reporter.getModelName()}] server_tool_use completed (${pendingServerToolCall.name || 'web_search'}): ${jsonInput}`
                            );
                            if (pendingServerToolCall.toolId) {
                                completedServerToolCalls.set(pendingServerToolCall.toolId, pendingServerToolCall);
                            }
                            pendingServerToolCall = undefined;
                        } else {
                            // 思考块结束时输出剩余思考内容和签名
                            reporter.flushThinking('Thinking block completed');
                            reporter.flushSignature();
                        }
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
                                    ...Object.assign(usage || {}, chunk.usage),
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

                    case 'message_stop': {
                        streamEndTime = Date.now();
                        // 即便没有 responseId，也输出 StatefulMarker（仅携带 sessionId），usage 写入 marker.usage
                        reporter.flushAll(
                            null,
                            responseId ? { sessionId: reporter.getSessionId(), responseId } : undefined,
                            usage
                        );
                        Logger.trace('Message stream completed');
                        break;
                    }

                    default:
                        // 未知事件类型 - 根据官方建议优雅处理
                        // 可能包括 ping 事件或未来的新事件类型
                        Logger.trace(`Received other event type: ${(chunk as { type: string }).type}`);
                        break;
                }
            }
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }
            Logger.error('Error processing Anthropic stream:', error);
            throw error;
        }

        // 流结束后补检：工具调用执行期间用户可能已取消
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // 记录流处理的结束时间
        streamEndTime ??= Date.now();

        // 补齐流开始时间：兼容网关可能未发送 message_start
        streamStartTime ??= reporter.getMetricStreamStartTime();

        if (usage && streamStartTime !== undefined) {
            const duration = streamEndTime - streamStartTime;
            const speed = duration > 0 ? ((usage.output_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.debug(
                `Stream processing completed - final usage stats: input=${usage.input_tokens}, output=${usage.output_tokens}, duration=${duration}ms, speed=${speed} tokens/s`
            );
        }
        return { usage, responseId, streamStartTime, streamEndTime };
    }
}
