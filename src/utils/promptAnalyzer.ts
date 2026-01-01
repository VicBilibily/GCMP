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
import { PromptPartTokens } from '../status/contextUsageStatusBar';
import { TokenCounter, Logger } from './index';

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
            Logger.debug(`[${providerKey}] analyzePromptParts 开始，消息数量: ${messages.length}`);

            // ===== 1. 计算系统提示词 =====
            // 根据官方 Anthropic SDK 标准：系统消息 + 包装开销
            let systemText = '';
            let systemMessageCount = 0;
            for (const message of messages) {
                const role = message.role;
                Logger.debug(`[${providerKey}] 消息角色: ${role}`);
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
                `[${providerKey}] 找到 ${systemMessageCount} 条系统消息, systemText length: ${systemText.length}`
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
                        const schemaJson = JSON.stringify(tool.inputSchema);
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
                Logger.debug(`[${providerKey}] 检测到环境消息, tokens=${environmentTokens}`);
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

            Logger.debug(`[${providerKey}] 最后一个 user text 消息索引: ${lastUserTextMessageIndex}`);

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
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part instanceof LanguageModelThinkingPart) {
                            // thinking part 本身就包含 thinking content，但我们需要计算其 token
                            // 获取 thinking 部分的文本内容
                            const thinkingText = this.extractPartText(part as unknown);
                            if (thinkingText) {
                                const thinkingTokens = await tokenCounter.countTokens(model, thinkingText);
                                promptParts.thinking = (promptParts.thinking || 0) + thinkingTokens;
                                Logger.debug(
                                    `[${providerKey}] 检测到 LanguageModelThinkingPart, tokens=${thinkingTokens}`
                                );
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
                    Logger.debug(`[${providerKey}] 跳过压缩历史消息, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }

                // 跳过环境消息（已在第3.5步处理）
                if (messageContentForCheck.includes(PromptAnalyzer.ENVIRONMENT_WORKSPACE_TAG)) {
                    Logger.debug(`[${providerKey}] 跳过环境消息, content length: ${messageContentForCheck.length}`);
                    skippedMessageCount++;
                    continue;
                }

                // 使用与 countMessagesTokens 相同的方式计算消息 token
                // 这样可以确保计算结果一致
                const messageTokens = await tokenCounter.countTokens(
                    model,
                    message as unknown as string | vscode.LanguageModelChatMessage
                );

                Logger.debug(`[${providerKey}] 处理消息 [${i}] role=${role}, tokens=${messageTokens}`);

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
                        promptParts.currentRoundMessages = (promptParts.currentRoundMessages || 0) + messageTokens;
                        currentRoundMessageCount++;
                        Logger.trace(
                            `[${providerKey}] 消息 [${i}] 归类为本轮消息, 累计 tokens=${promptParts.currentRoundMessages}`
                        );
                    } else {
                        // 历史消息
                        promptParts.historyMessages = (promptParts.historyMessages || 0) + messageTokens;
                        historyMessageCount++;
                        Logger.trace(
                            `[${providerKey}] 消息 [${i}] 归类为历史消息, 累计 tokens=${promptParts.historyMessages}`
                        );
                    }
                }
            }
            Logger.debug(
                `[${providerKey}] 消息处理完成: 处理 ${processedMessageCount} 条, 跳过 ${skippedMessageCount} 条, 历史消息 ${historyMessageCount} 条, 本轮消息 ${currentRoundMessageCount} 条`
            );

            // ===== 5. 计算上下文总占用 =====
            // context = systemPrompt + availableTools + environment + userAssistantMessage + thinking + autoCompressed
            const contextTotal =
                (promptParts.systemPrompt || 0) +
                (promptParts.availableTools || 0) +
                (promptParts.environment || 0) +
                (promptParts.autoCompressed || 0) +
                (promptParts.thinking || 0) +
                (promptParts.userAssistantMessage || 0);
            promptParts.context = contextTotal;
            Logger.debug(
                `[${providerKey}] Token 分解统计:\n` +
                    `  系统提示词: ${promptParts.systemPrompt} tokens (含 28 包装开销)\n` +
                    `  可用工具: ${promptParts.availableTools} tokens (含 1.1x 安全系数)\n` +
                    `  环境消息: ${promptParts.environment} tokens (environment_info 和 workspace_info)\n` +
                    `  自动压缩: ${promptParts.autoCompressed} tokens (压缩历史消息体)\n` +
                    `  思考过程: ${promptParts.thinking} tokens (LanguageModelThinkingPart)\n` +
                    `  对话消息: ${promptParts.userAssistantMessage} tokens (用户、助手及其他对话角色)\n` +
                    `    - 历史消息: ${promptParts.historyMessages} tokens (本轮对话之前的所有消息)\n` +
                    `    - 本轮消息: ${promptParts.currentRoundMessages} tokens (从最后一个 user text 消息开始)\n` +
                    `  = 总占用: ${promptParts.context} tokens`
            );
            return promptParts;
        } catch (error) {
            Logger.warn(`[${providerKey}] 分析提示词部分失败:`, error);
            Logger.debug(
                `[${providerKey}] 当前 promptParts: systemPrompt=${promptParts.systemPrompt}, availableTools=${promptParts.availableTools}, environment=${promptParts.environment}, userAssistantMessage=${promptParts.userAssistantMessage}, autoCompressed=${promptParts.autoCompressed}, context=${promptParts.context}`
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
        // 处理标准的 TextPart
        if ('value' in partObj && typeof partObj.value === 'string') {
            return partObj.value;
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
