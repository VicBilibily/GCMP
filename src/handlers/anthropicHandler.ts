/*---------------------------------------------------------------------------------------------
 *  Anthropic SDK Handler
 *  处理使用 Anthropic SDK 的模型请求
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { apiMessageToAnthropicMessage, convertToAnthropicTools } from './anthropicConverter';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { Logger } from '../utils/logger';
import { ConfigManager } from '../utils/configManager';
import { VersionManager } from '../utils/versionManager';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import { OpenAIHandler } from './openaiHandler';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';

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

    private generateClaudeCodeStyleSessionKey(): string {
        // Claude Code 风格：user_<hash>_account__session_<uuid>
        // - user_<hash>: 64 hex（这里用 sha256(machineId) 生成稳定值）
        // - session_<uuid>: 每个新会话生成一次，后续靠缓存复用
        const userHash = crypto.createHash('sha256').update(vscode.env.machineId).digest('hex');
        const sessionUuid = crypto.randomUUID();
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

        Logger.trace(`${this.displayName} Anthropic 兼容客户端已创建`);
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
                stream: true
            };

            // Anthropic 兼容接口的会话缓存：使用本地 sessionKey 写入 metadata.user_id，
            // 供“客户端传 session”的网关实现粘性会话。
            const statefulMarker = getStatefulMarkerAndIndex(model.id, 'anthropic', messages);
            const sessionId = statefulMarker?.statefulMarker?.sessionId || this.generateClaudeCodeStyleSessionKey();
            createParams.metadata = { user_id: sessionId };

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

            // cache_control 安全网：Anthropic API 上限 4 个，可通过配置调整（0=不限制）
            const cacheLimit = ConfigManager.getConfig().anthropicCacheLimit;
            if (cacheLimit > 0) {
                const cacheCount = (JSON.stringify(createParams).match(/"cache_control"\s*:/g) || []).length;
                if (cacheCount > cacheLimit) {
                    let excess = cacheCount - cacheLimit;
                    for (const msg of createParams.messages) {
                        if (excess <= 0) { break; }
                        if (!Array.isArray(msg.content)) { continue; }
                        for (const block of msg.content) {
                            if (excess <= 0) { break; }
                            const b = block as unknown as Record<string, unknown>;
                            if (Array.isArray(b.content)) {
                                for (const n of b.content as Record<string, unknown>[]) {
                                    if (excess <= 0) { break; }
                                    if (n.cache_control) { delete n.cache_control; excess--; }
                                }
                            }
                            if (excess > 0 && b.cache_control) { delete b.cache_control; excess--; }
                        }
                    }
                    Logger.warn(`[${model.name}] cache_control 超限已修复: ${cacheCount} → ${cacheLimit}`);
                }
            }

            const stream = await client.messages.create(createParams, { signal: abortController.signal });

            // 创建统一的流报告器
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'anthropic',
                progress,
                sessionId
            });

            // 使用完整的流处理函数
            const result = await this.handleAnthropicStream(stream, reporter, token);

            Logger.info(`[${model.name}] Anthropic 请求完成`, result?.usage);

            // === Token 统计: 更新实际 token ===
            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    // 直接传递 SDK 的 Usage 对象，包含流时间信息
                    await usagesManager.updateActualTokens({
                        requestId,
                        rawUsage: result?.usage || {},
                        status: 'completed',
                        streamStartTime: result?.streamStartTime,
                        streamEndTime: result?.streamEndTime
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
        let usage: Anthropic.Messages.Usage | undefined;
        let responseId: string | undefined;
        // 记录流处理的开始时间（在 message_start 事件中设置）
        let streamStartTime = Date.now();
        let streamEndTime: number | undefined = undefined;

        Logger.debug('开始处理 Anthropic 流式响应');

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    Logger.debug('流处理被取消');
                    reporter.flushAll(null);
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

                switch (chunk.type) {
                    case 'message_start':
                        // 消息开始 - 记录流开始时间
                        streamStartTime = Date.now();
                        // 收集初始使用统计
                        if (chunk.message.usage) {
                            usage = chunk.message.usage;
                        }
                        // 获取响应消息ID：message_start.message.id
                        if (!responseId && chunk.message.id) {
                            responseId = chunk.message.id;
                            reporter.setResponseId(responseId);
                            Logger.debug(`收到 Anthropic message id (responseId): ${responseId}`);
                        }
                        break;

                    case 'content_block_start':
                        // 内容块开始
                        if (chunk.content_block.type === 'tool_use') {
                            pendingToolCall = {
                                toolId: chunk.content_block.id,
                                name: chunk.content_block.name,
                                jsonInput: ''
                            };
                        }
                        break;

                    case 'content_block_delta':
                        // 内容块增量更新
                        if (chunk.delta.type === 'text_delta') {
                            // 文本内容增量
                            reporter.reportText(chunk.delta.text);
                        } else if (chunk.delta.type === 'input_json_delta' && pendingToolCall) {
                            // 工具调用参数增量
                            pendingToolCall.jsonInput = (pendingToolCall.jsonInput || '') + chunk.delta.partial_json;

                            // 尝试立即解析并报告工具调用（如果 JSON 已完整）
                            try {
                                const parsedJson = JSON.parse(pendingToolCall.jsonInput);
                                // JSON 解析成功，立即报告工具调用
                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson);
                                Logger.trace(`[${reporter.getModelName()}] 工具调用完成: ${pendingToolCall.name}`);
                                pendingToolCall = undefined; // 清除待处理的工具调用
                            } catch {
                                // JSON 还不完整，继续累积
                            }
                        } else if (chunk.delta.type === 'thinking_delta') {
                            // 思考内容增量
                            const thinkingDelta = chunk.delta.thinking || '';
                            reporter.bufferThinking(thinkingDelta);
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
                                    `[${reporter.getModelName()}] content_block_stop 兜底处理工具调用 (${pendingToolCall.name}): ${jsonInput.substring(0, 100)}${jsonInput.length > 100 ? '...' : ''}`
                                );

                                let parsedJson: Record<string, unknown>;
                                try {
                                    parsedJson = JSON.parse(jsonInput);
                                } catch {
                                    // JSON 解析失败，使用空对象
                                    Logger.warn(`工具调用 JSON 不完整，使用空对象: ${jsonInput}`);
                                    parsedJson = {};
                                }

                                reporter.reportToolCall(pendingToolCall.toolId!, pendingToolCall.name!, parsedJson);
                            } catch (e) {
                                Logger.error(`兜底处理工具调用失败 (${pendingToolCall.name}):`, e);
                            }
                            pendingToolCall = undefined;
                        } else {
                            // 思考块结束时输出剩余思考内容和签名
                            reporter.flushThinking('思考块完成');
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
                        if (responseId) {
                            // 消息停止 - 传递 StatefulMarker
                            reporter.flushAll(null, { sessionId: reporter.getSessionId(), responseId });
                        }
                        Logger.trace('消息流完成');
                        break;
                    }

                    default:
                        // 未知事件类型 - 根据官方建议优雅处理
                        // 可能包括 ping 事件或未来的新事件类型
                        Logger.trace('收到其他事件类型');
                        break;
                }
            }
        } catch (error) {
            Logger.error('处理 Anthropic 流时出错:', error);
            throw error;
        }

        // 记录流处理的结束时间
        streamEndTime ??= Date.now();

        if (usage) {
            const duration = streamEndTime - streamStartTime;
            const speed = duration > 0 ? ((usage.output_tokens / duration) * 1000).toFixed(1) : 'N/A';
            Logger.debug(
                `流处理完成 - 最终使用统计: 输入=${usage.input_tokens}, 输出=${usage.output_tokens}, 耗时=${duration}ms, 速度=${speed} tokens/s`
            );
        }
        return { usage, responseId, streamStartTime, streamEndTime };
    }
}
