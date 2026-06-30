/*---------------------------------------------------------------------------------------------
 *  提示词分析器 - analyzePromptParts 独立实现
 *  用于分解提示词各部分的 token 占用
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelThinkingPart,
    LanguageModelTextPart,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { ModelConfig } from '../types/sharedTypes';
import { PromptPartTokens } from '../status/contextUsageStatusBar';
import { Logger } from './logger';
import { sanitizeToolSchemaForSdkMode } from './schemaSanitizer';
import { TokenCounter } from './tokenCounter';
import { decodeStatefulMarker } from '../handlers/statefulMarker';
import { CustomDataPartMimeTypes } from '../handlers/types';

/**
 * 提示词分析器
 * 用于详细分解提示词各个部分的 token 占用
 */
export class PromptAnalyzer {
    static readonly CONVERSATION_COMPRESSION_MARKER =
        'The following is a compressed version of the preceeding history in the current conversation.';
    static readonly CONVERSATION_SUMMARY_TAG = '<conversation-summary>\n';
    static readonly ENVIRONMENT_WORKSPACE_TAG = '</environment_info>\n<workspace_info>';

    /**
     * 类型守卫：检查是否是 LanguageModelTextPart
     * LanguageModelTextPart 有 value 属性
     */
    private static isLanguageModelTextPart(part: unknown): part is LanguageModelTextPart {
        return (
            typeof part === 'object' &&
            part !== null &&
            'value' in part &&
            typeof (part as LanguageModelTextPart).value === 'string'
        );
    }

    /**
     * 类型守卫：检测是否是包含二进制数据的 DataPart，且为图片
     * 结构通常为 { mimeType: string, data: Uint8Array | ArrayBuffer | BufferJson | number[] }
     */
    private static isImageDataPart(part: unknown): part is { mimeType: string; data: unknown } {
        if (!part || typeof part !== 'object') {
            return false;
        }
        const obj = part as Record<string, unknown>;
        return typeof obj.mimeType === 'string' && obj.mimeType.toLowerCase().startsWith('image/') && 'data' in obj;
    }

    /**
     * 分析提示词各部分的 token 占用
     * @param providerKey 提供商标识，用于日志输出
     * @param model 语言模型信息
     * @param messages 消息数组
     * @param options 选项（包含工具定义）
     * @returns 分解后的 token 统计
     */
    static async analyzePromptParts(
        providerKey: string,
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig?: Pick<ModelConfig, 'sdkMode'>,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<PromptPartTokens> {
        const promptParts: PromptPartTokens = {
            systemPrompt: 0,
            availableTools: 0,
            environment: 0,
            userAssistantMessage: 0,
            thinking: 0,
            autoCompressed: 0,
            context: 0
        };

        try {
            const tokenCounter = TokenCounter.getInstance();
            Logger.debug(`[${providerKey}] analyzePromptParts started, message count: ${messages.length}`);

            // ===== 1. 计算系统提示词 =====
            // 根据官方 Anthropic SDK 标准：系统消息 + 包装开销
            let systemText = '';
            let systemMessageCount = 0;
            for (const message of messages) {
                const role = message.role;
                // Logger.debug(`[${providerKey}] 消息角色: ${role}`);
                // role 是 LanguageModelChatMessage.Role 枚举：System=3, User=1, Assistant=2
                if (role === vscode.LanguageModelChatMessageRole.System) {
                    systemMessageCount++;
                    if (typeof message.content === 'string') {
                        systemText += message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                systemText += text;
                            }
                        }
                    }
                }
            }
            Logger.debug(
                `[${providerKey}] Found ${systemMessageCount} system messages, systemText length: ${systemText.length}`
            );
            if (systemText) {
                const systemTokens = await tokenCounter.countTokens(model, systemText);
                Logger.debug(`[${providerKey}] systemTokens: ${systemTokens}`);
                // 官方标准：系统消息包装开销约为 28 tokens
                const systemOverhead = 28;
                promptParts.systemPrompt = systemTokens + systemOverhead;
            }

            // ===== 2. 计算可用工具描述 =====
            // 根据官方标准：基础开销 + 每个工具开销 + 内容 token，最后 * 1.1
            if (options?.tools && Array.isArray(options.tools)) {
                let toolsTokens = 16; // 基础开销
                for (const tool of options.tools) {
                    toolsTokens += 8; // 每个工具的基础开销
                    if ('name' in tool && typeof tool.name === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.name);
                    }
                    if ('description' in tool && typeof tool.description === 'string') {
                        toolsTokens += await tokenCounter.countTokens(model, tool.description);
                    }
                    // 计算工具的 inputSchema（参数定义）
                    if ('inputSchema' in tool && tool.inputSchema) {
                        const schemaJson = JSON.stringify(
                            sanitizeToolSchemaForSdkMode(tool.inputSchema, modelConfig?.sdkMode)
                        );
                        toolsTokens += await tokenCounter.countTokens(model, schemaJson);
                    }
                }
                // 官方 1.1 安全系数（使用 Math.floor 与 countMessagesTokens 保持一致）
                promptParts.availableTools = Math.floor(toolsTokens * 1.1);
            }

            // ===== 3. 检测压缩历史消息 =====
            // 官方实现：当历史过长时，将历史压缩为特殊的 UserMessage
            // 检查是否有 "compressed version" 或 "conversation-summary" 标记
            let compressedHistoryMessage: vscode.LanguageModelChatMessage | undefined;
            for (const message of messages) {
                const role = message.role;
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // 检查消息内容是否包含压缩历史的标记
                    let messageContent = '';
                    if (typeof message.content === 'string') {
                        messageContent = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                messageContent += text;
                            }
                        }
                    }
                    // 检查是否是压缩历史消息（官方标记）
                    if (
                        messageContent.includes(PromptAnalyzer.CONVERSATION_COMPRESSION_MARKER) ||
                        messageContent.includes(PromptAnalyzer.CONVERSATION_SUMMARY_TAG)
                    ) {
                        compressedHistoryMessage = message;
                        break;
                    }
                }
            }

            if (compressedHistoryMessage) {
                // 使用完整的消息体计算 token（包含消息格式开销）
                const compressedTokens = await tokenCounter.countTokens(
                    model,
                    compressedHistoryMessage as unknown as vscode.LanguageModelChatMessage
                );
                promptParts.autoCompressed = compressedTokens;
            }

            // ===== 3.5 检测环境消息 =====
            // 检查是否有包含环境信息的消息（environment_info 和 workspace_info）
            let environmentMessage: vscode.LanguageModelChatMessage | undefined;
            for (const message of messages) {
                const role = message.role;
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // 检查消息内容是否包含环境信息的标记
                    let messageContent = '';
                    if (typeof message.content === 'string') {
                        messageContent = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            const text = this.extractPartText(part as unknown);
                            if (text) {
                                messageContent += text;
                            }
                        }
                    }
                    // 检查是否是环境消息（包含环境标签）
                    if (messageContent.includes(PromptAnalyzer.ENVIRONMENT_WORKSPACE_TAG)) {
                        environmentMessage = message;
                        break;
                    }
                }
            }

            if (environmentMessage) {
                // 使用完整的消息体计算 token（包含消息格式开销）
                const environmentTokens = await tokenCounter.countTokens(
                    model,
                    environmentMessage as unknown as vscode.LanguageModelChatMessage
                );
                promptParts.environment = environmentTokens;
                Logger.debug(`[${providerKey}] Detected environment message, tokens=${environmentTokens}`);
            }

            // ===== 支持增量 token 预估：检测 stateful marker 中的 usage =====
            // 如果上一轮请求的 API 返回了 usage 信息，会记录在 stateful marker 的 usage 字段中。
            // 本轮可以基于该实际 usage 做增量预估：仅计算新增消息的 token，历史部分直接复用 baseline。
            // 这样可以避免不同模型 tokenizer 差异在长上下文中被反复放大。
            let usageBaseline: number | undefined;
            let usageMarkerIndex = -1;
            // 累计标记索引之后的新增消息 token（增量预估的 delta 部分）
            let deltaTokens = 0;

            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                if (message.role === vscode.LanguageModelChatMessageRole.Assistant && Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (
                            typeof part === 'object' &&
                            part !== null &&
                            'mimeType' in part &&
                            (part as { mimeType: string }).mimeType === CustomDataPartMimeTypes.StatefulMarker &&
                            'data' in part
                        ) {
                            const dataPart = part as { data: Uint8Array };
                            try {
                                const decoded = decodeStatefulMarker(dataPart.data);
                                const promptTokens = decoded?.marker?.usage?.prompt_tokens;
                                if (typeof promptTokens === 'number' && promptTokens > 0) {
                                    usageBaseline = promptTokens;
                                    usageMarkerIndex = i;
                                    break;
                                }
                            } catch {
                                // 解码失败，忽略
                            }
                        }
                    }
                    if (usageBaseline !== undefined) {
                        break;
                    }
                }
            }

            if (usageBaseline !== undefined) {
                Logger.debug(
                    `[${providerKey}] Incremental estimation enabled: baseline=${usageBaseline} ` +
                        `(from usage at message ${usageMarkerIndex})`
                );
            }

            // ===== 4. 分析消息：用户、助手、其他角色合并为 userAssistantMessage =====
            // 同时拆分为历史消息和本轮消息

            // 4.1 找到最后一个 user role 且 type=text 的消息索引
            let lastUserTextMessageIndex = -1;
            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                const role = message.role;

                // 只检查 user 角色的消息
                if (role === vscode.LanguageModelChatMessageRole.User) {
                    // 检查是否是 text 类型的消息
                    let isTextMessage = false;

                    if (typeof message.content === 'string') {
                        // 字符串内容就是 text 类型
                        isTextMessage = true;
                    } else if (Array.isArray(message.content)) {
                        // 检查内容数组中是否有 text 类型的 part
                        for (const part of message.content) {
                            // 跳过 thinking part
                            if (part instanceof LanguageModelThinkingPart) {
                                continue;
                            }
                            // 使用类型守卫检查是否是 LanguageModelTextPart
                            // LanguageModelTextPart 有 value 属性
                            if (PromptAnalyzer.isLanguageModelTextPart(part)) {
                                isTextMessage = true;
                                break;
                            }
                        }
                    }

                    if (isTextMessage) {
                        lastUserTextMessageIndex = i;
                        break;
                    }
                }
            }

            Logger.debug(`[${providerKey}] Last user text message index: ${lastUserTextMessageIndex}`);

            // 4.2 遍历所有消息，分别计算历史消息和本轮消息的 token
            let processedMessageCount = 0;
            let skippedMessageCount = 0;
            let historyMessageCount = 0;
            let currentRoundMessageCount = 0;

            for (let i = 0; i < messages.length; i++) {
                const message = messages[i];
                const role = message.role;

                // 跳过系统消息（已在第1步处理）
                if (role === vscode.LanguageModelChatMessageRole.System) {
                    skippedMessageCount++;
                    continue;
                }

                // ===== 检测 thinking 部分（LanguageModelThinkingPart） =====
                let currentMessageThinkingTokens = 0;
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part instanceof LanguageModelThinkingPart) {
                            // thinking part 本身就包含 thinking content，但我们需要计算其 token
                            // 获取 thinking 部分的文本内容
                            const thinkingText = this.extractPartText(part as unknown);
                            if (thinkingText) {
                                const thinkingTokens = await tokenCounter.countTokens(model, thinkingText);
                                promptParts.thinking = (promptParts.thinking || 0) + thinkingTokens;
                                if (lastUserTextMessageIndex !== -1 && i >= lastUserTextMessageIndex) {
                                    currentMessageThinkingTokens += thinkingTokens;
                                }
                                // Logger.debug(
                                //     `[${providerKey}] 检测到 LanguageModelThinkingPart, tokens=${thinkingTokens}`
                                // );
                            }
                        }
                    }
                }

                // 跳过压缩历史消息（已在第3步处理）
                let messageContentForCheck = '';
                if (typeof message.content === 'string') {
                    messageContentForCheck = message.content;
                } else if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part instanceof LanguageModelThinkingPart) {
                            continue;
                        }
                        const text = this.extractPartText(part as unknown);
                        if (text) {
                            messageContentForCheck += text;
                        }
                    }
                }
                if (
                    messageContentForCheck.includes(PromptAnalyzer.CONVERSATION_COMPRESSION_MARKER) ||
                    messageContentForCheck.includes(PromptAnalyzer.CONVERSATION_SUMMARY_TAG)
                ) {
                    // Logger.debug(`[${providerKey}] 跳过压缩历史消息, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }

                // 跳过环境消息（已在第3.5步处理）
                if (messageContentForCheck.includes(PromptAnalyzer.ENVIRONMENT_WORKSPACE_TAG)) {
                    // Logger.debug(`[${providerKey}] 跳过环境消息, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }
                // 本轮图片附件：如果消息 content 中包含图片 DataPart，则单独累计其 token
                // 并且从 currentRoundMessages 中扣除（保证“本轮消息”展示为非图片部分）
                let currentMessageImageTokens = 0;
                if (
                    lastUserTextMessageIndex !== -1 &&
                    i >= lastUserTextMessageIndex &&
                    Array.isArray(message.content)
                ) {
                    for (const part of message.content) {
                        if (PromptAnalyzer.isImageDataPart(part)) {
                            try {
                                currentMessageImageTokens += await tokenCounter.countMessageObjectTokens(
                                    part as unknown as Record<string, unknown>
                                );
                            } catch {
                                // ignore single-part failures; message-level counting already exists
                            }
                        }
                    }
                }

                // 使用与 countMessagesTokens 相同的方式计算消息 token
                // 这样可以确保计算结果一致
                const messageTokens = await tokenCounter.countTokens(
                    model,
                    message as unknown as string | vscode.LanguageModelChatMessage
                );

                // Logger.debug(`[${providerKey}] 处理消息 [${i}] role=${role}, tokens=${messageTokens}`);

                // 增量预估：累计标记索引及之后的消息作为 delta，包括上轮 assistant 回复本身的 token 开销
                if (usageBaseline !== undefined && i >= usageMarkerIndex) {
                    deltaTokens += messageTokens;
                }

                // 按官方标准合并：所有非系统、非压缩的消息都并入 userAssistantMessage
                // 包括：user、assistant、tool、function 等所有对话角色
                if (
                    role === vscode.LanguageModelChatMessageRole.User ||
                    role === vscode.LanguageModelChatMessageRole.Assistant
                ) {
                    promptParts.userAssistantMessage = (promptParts.userAssistantMessage || 0) + messageTokens;
                    processedMessageCount++;

                    // 根据消息索引判断是历史消息还是本轮消息
                    if (lastUserTextMessageIndex !== -1 && i >= lastUserTextMessageIndex) {
                        // 本轮消息
                        const currTextTokens = Math.max(
                            0,
                            messageTokens - currentMessageImageTokens - currentMessageThinkingTokens
                        );
                        promptParts.currentRoundMessages = (promptParts.currentRoundMessages || 0) + currTextTokens;
                        if (currentMessageImageTokens > 0) {
                            promptParts.currentRoundImages =
                                (promptParts.currentRoundImages || 0) + currentMessageImageTokens;
                        }
                        currentRoundMessageCount++;
                        // Logger.trace(
                        //     `[${providerKey}] 消息 [${i}] 归类为本轮消息, 累计 tokens=${promptParts.currentRoundMessages}`
                        // );
                    } else {
                        // 历史消息
                        promptParts.historyMessages = (promptParts.historyMessages || 0) + messageTokens;
                        historyMessageCount++;
                        // Logger.trace(
                        //     `[${providerKey}] 消息 [${i}] 归类为历史消息, 累计 tokens=${promptParts.historyMessages}`
                        // );
                    }
                }
            }
            Logger.debug(
                `[${providerKey}] Message processing completed: processed ${processedMessageCount}, skipped ${skippedMessageCount}, history ${historyMessageCount}, current round ${currentRoundMessageCount}`
            );

            // ===== 5. 计算上下文总占用 =====
            // 支持增量预估模式：如果存在 usage baseline，使用实际 usage 作为历史部分的 baseline，
            // 配合新增消息的 delta，拼出当前总占用。这样不同模型的 tokenizer 差异只影响新增部分，
            // 不会在长上下文中被反复放大。
            let contextTotal: number;
            if (usageBaseline !== undefined) {
                // 增量模式：baseline（来自上一轮 API 实际 usage）+ delta（本轮新增消息）
                contextTotal = usageBaseline + deltaTokens;
                promptParts.requestIncrement = deltaTokens;
                Logger.debug(
                    `[${providerKey}] Incremental context: baseline=${usageBaseline}, delta=${deltaTokens}, total=${contextTotal}`
                );

                // 重新推算 userAssistantMessage：总占用减去其他已知部分
                // 注意：baseline 已包含旧的 system/tools/env，此处使用当前计算的新值做减法，
                // 得到的是"当前消息部分"的近似值。由于 system/tools/env 在会话中通常稳定，此近似足够准确。
                promptParts.userAssistantMessage = Math.max(
                    0,
                    contextTotal -
                        (promptParts.systemPrompt || 0) -
                        (promptParts.availableTools || 0) -
                        (promptParts.environment || 0) -
                        (promptParts.autoCompressed || 0)
                );
            } else {
                // 传统全量模式：逐项累加
                contextTotal =
                    (promptParts.systemPrompt || 0) +
                    (promptParts.availableTools || 0) +
                    (promptParts.environment || 0) +
                    (promptParts.autoCompressed || 0) +
                    (promptParts.userAssistantMessage || 0);
            }
            promptParts.context = contextTotal;
            Logger.debug(
                `[${providerKey}] Token breakdown:\n` +
                    `  System prompt: ${promptParts.systemPrompt} tokens (including 28 wrapper tokens)\n` +
                    `  Available tools: ${promptParts.availableTools} tokens (including 1.1x safety factor)\n` +
                    `  Environment message: ${promptParts.environment} tokens (environment_info and workspace_info)\n` +
                    `  Auto-compressed history: ${promptParts.autoCompressed} tokens\n` +
                    `  Conversation messages: ${promptParts.userAssistantMessage} tokens (user, assistant, and other chat roles)\n` +
                    `    - History messages: ${promptParts.historyMessages} tokens\n` +
                    `    - Thinking content: ${promptParts.thinking} tokens (LanguageModelThinkingPart)\n` +
                    `    - Current round messages: ${promptParts.currentRoundMessages} tokens (starting from the last user text message, excluding images and thinking)\n` +
                    `    - Current round images: ${promptParts.currentRoundImages || 0} tokens\n` +
                    (usageBaseline !== undefined ?
                        `  [Incremental mode] baseline=${usageBaseline}, delta=${deltaTokens}\n`
                    :   '') +
                    `  = Total context: ${promptParts.context} tokens`
            );
            return promptParts;
        } catch (error) {
            Logger.warn(`[${providerKey}] Failed to analyze prompt parts:`, error);
            Logger.debug(
                `[${providerKey}] Current promptParts: systemPrompt=${promptParts.systemPrompt}, availableTools=${promptParts.availableTools}, environment=${promptParts.environment}, userAssistantMessage=${promptParts.userAssistantMessage}, autoCompressed=${promptParts.autoCompressed}, context=${promptParts.context}`
            );
            // 返回零值结构，防止状态栏崩溃
            return promptParts;
        }
    }

    /**
     * 提取消息部分的文本内容
     * @param part 消息部分（可能是字符串或对象）
     * @returns 提取的文本，如果无法提取则返回空字符串
     */
    private static extractPartText(part: unknown): string {
        if (typeof part === 'string') {
            return part;
        }
        if (!part || typeof part !== 'object') {
            return '';
        }

        const partObj = part as Record<string, unknown>;
        // 处理标准的 TextPart / ThinkingPart
        // - TextPart: value: string
        // - ThinkingPart: value: string | string[]
        if ('value' in partObj) {
            const v = partObj.value;
            if (typeof v === 'string') {
                return v;
            }
            if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
                return v.join('');
            }
        }
        // 处理 markdown 内容
        if ('markdown' in partObj && typeof partObj.markdown === 'string') {
            return partObj.markdown;
        }
        // 处理 text 字段
        if ('text' in partObj && typeof partObj.text === 'string') {
            return partObj.text;
        }
        // 处理 data 字段（可能是 Buffer 或其他）
        if ('data' in partObj && partObj.data) {
            if (typeof partObj.data === 'string') {
                return partObj.data;
            }
            if (Buffer.isBuffer(partObj.data)) {
                try {
                    return partObj.data.toString('utf-8');
                } catch {
                    return '';
                }
            }
        }
        return '';
    }
}
