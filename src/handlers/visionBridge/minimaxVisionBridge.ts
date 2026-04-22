/*---------------------------------------------------------------------------------------------
 *  MiniMax 图片桥接处理器
 *  当模型不支持图片输入时，使用 Vision API 将图片转换为文字描述
 *  注：当 MiniMax 模型完善图片支持后，可整体移除此桥接模块
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CancellationToken, LanguageModelChatMessage } from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import { ModelConfig } from '../../types/sharedTypes';
import { Logger, ApiKeyManager } from '../../utils';
import { MiniMaxVisionTool } from './minimaxVision';
import {
    buildVisionBridgeMessages as createVisionBridgeMessages,
    createVisionBridgeToolCallId,
    visionBridgeDefinitions
} from './visionBridge';

/**
 * 图片桥接处理结果
 */
export interface VisionBridgeResult {
    messages: Array<LanguageModelChatMessage>;
}

/**
 * 图片桥接回放事件（内部使用）
 * 用于从消息链中提取已处理的桥接结果
 */
interface ReplayEvent {
    callId: string;
    name: string;
    input: Record<string, unknown>;
    resultParts: vscode.LanguageModelTextPart[];
}

/**
 * MiniMax 图片桥接处理器
 *
 * 将用户消息中的图片通过 MiniMax Vision API 转换为文字描述，
 * 再以 tool_call 消息链的形式注入回对话，使不支持图片的模型也能"理解"图片内容。
 *
 * 当 MiniMax 模型原生支持图片输入后，删除此文件及 provider 中的调用即可。
 */
export class MiniMaxVisionBridge {
    private static readonly definition = visionBridgeDefinitions.minimax;
    private static readonly maxConcurrency = 3;
    private static readonly supportedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

    /**
     * 检查 MIME 类型是否被 MiniMax Vision API 支持
     * 仅支持 JPEG、PNG、WebP，不支持 GIF
     */
    static isImageMimeType(mimeType: string): boolean {
        const normalized = mimeType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mimeType.toLowerCase();
        return MiniMaxVisionBridge.supportedImageTypes.includes(normalized);
    }

    private static previewText(text: string, maxLength = 120): string {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, maxLength)}...`;
    }

    /**
     * 构建图片桥接消息链
     * 将用户问题 + 图片描述注入为 user(question) -> assistant(tool_call) -> user(tool_result) 三条消息
     */
    static buildBridgeMessages(
        messages: Array<LanguageModelChatMessage>,
        lastUserMessageIndex: number,
        originalQuestion: string,
        imageDescriptions: string[]
    ): VisionBridgeResult {
        const callId = createVisionBridgeToolCallId(MiniMaxVisionBridge.definition.toolName);
        const questionText =
            originalQuestion || `请根据图片识别结果，总结这${imageDescriptions.length}张图片的主要内容。`;

        const bridgeResult = createVisionBridgeMessages({
            messages,
            lastUserMessageIndex,
            callId,
            toolName: MiniMaxVisionBridge.definition.toolName,
            questionText,
            imageDescriptions
        });

        const toolInput: Record<string, unknown> = {
            imageCount: imageDescriptions.length,
            question: questionText
        };
        const resultParts = bridgeResult.resultParts;
        const resultText = resultParts.map(part => part.value).join('\n');

        Logger.info(
            `MiniMax 图片桥接: 注入消息链 user(question) -> assistant(tool_call=${MiniMaxVisionBridge.definition.toolName}) -> user(tool_result), callId=${callId}, imageCount=${imageDescriptions.length}, insertIndex=${lastUserMessageIndex}`
        );
        Logger.trace(`MiniMax 图片桥接: tool_input=${JSON.stringify(toolInput)}`);
        Logger.trace(`MiniMax 图片桥接: question预览=${MiniMaxVisionBridge.previewText(questionText)}`);
        Logger.trace(`MiniMax 图片桥接: tool_result预览=${MiniMaxVisionBridge.previewText(resultText, 240)}`);

        return {
            messages: bridgeResult.messages
        };
    }

    /**
     * 预处理消息中的图片（图片桥接功能）
     * 使用 MiniMax Vision API 将图片转换为文字描述后再发送给模型
     * 只处理当前轮次的新消息（最后一条用户消息），历史消息已在上一轮处理过
     *
     * @param messages 原始消息列表
     * @param modelConfig 模型配置
     * @param providerKey 模型对应的 provider key
     * @param token 取消信号，用户取消请求时停止图片预处理
     * @returns 处理后的消息列表
     */
    static async preprocessImages(
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        providerKey: string,
        token: CancellationToken
    ): Promise<VisionBridgeResult> {
        // 只对 Coding Plan 模型启用图片桥接
        if (providerKey !== 'minimax-coding') {
            return { messages };
        }

        // 检查是否有 MiniMax Vision API 密钥
        const hasApiKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        if (!hasApiKey) {
            Logger.debug('MiniMax 图片桥接: 未配置 Coding Plan API 密钥，跳过图片预处理');
            return { messages };
        }

        // 用户取消时快速退出
        if (token.isCancellationRequested) {
            Logger.debug('MiniMax 图片桥接: 请求已取消，跳过图片预处理');
            return { messages };
        }

        const visionTool = new MiniMaxVisionTool();
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
            abortController.abort();
        });

        // 找到最后一条用户消息（当前轮次的新消息）
        let lastUserMessageIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === vscode.LanguageModelChatMessageRole.User) {
                lastUserMessageIndex = i;
                break;
            }
        }

        // 统计需要处理的图片数量（包含所有 image/* 类型，确保 GIF 等不支持格式也进入桥接）
        let totalImages = 0;
        if (lastUserMessageIndex >= 0) {
            const lastUserMessage = messages[lastUserMessageIndex];
            for (const part of lastUserMessage.content) {
                if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
                    totalImages++;
                }
            }
        }

        if (totalImages === 0) {
            return { messages };
        }

        // 只处理最后一条用户消息
        const lastUserMessage = messages[lastUserMessageIndex];

        // 先提取用户原始问题（用于喂给视觉模型的提示词）
        const originalTextParts: string[] = [];
        for (const part of lastUserMessage.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                originalTextParts.push(part.value);
            }
        }
        const originalQuestion = originalTextParts.join('\n').trim();

        // 再处理图片部分：并发调用 Vision，最终按原始顺序拼接结果
        const imageParts: Array<{ imageNumber: number; part: vscode.LanguageModelDataPart }> = [];
        for (const part of lastUserMessage.content) {
            if (token.isCancellationRequested) {
                Logger.debug('MiniMax 图片桥接: 请求已取消，停止图片预处理');
                return { messages };
            }
            if (!(part instanceof vscode.LanguageModelDataPart) || !part.mimeType.startsWith('image/')) {
                continue;
            }
            if (!MiniMaxVisionBridge.isImageMimeType(part.mimeType)) {
                Logger.error(`不支持的图片格式: ${part.mimeType}`);
                throw new Error(`不支持的图片格式: ${part.mimeType}。MiniMax Vision 仅支持 JPEG、PNG、WebP。`);
            }

            imageParts.push({
                imageNumber: imageParts.length + 1,
                part
            });
        }

        const maxConcurrency = Math.min(MiniMaxVisionBridge.maxConcurrency, imageParts.length);
        const queuedCount = imageParts.length - maxConcurrency;
        Logger.info(
            `检测到 ${totalImages} 张图片需要分析，使用 ${maxConcurrency} 并发处理${queuedCount > 0 ? `，其余 ${queuedCount} 张排队` : ''}`
        );

        const imageDescriptions = new Array<string>(imageParts.length);
        const batchStartTime = Date.now();
        let nextIndex = 0;
        let completedCount = 0;
        let successCount = 0;
        let failedCount = 0;

        try {
            const worker = async (workerId: number): Promise<void> => {
                while (nextIndex < imageParts.length) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;

                    const { imageNumber, part } = imageParts[currentIndex];
                    const imageStartTime = Date.now();
                    Logger.info(
                        `开始分析图片 (${imageNumber}/${totalImages}) [worker ${workerId}/${maxConcurrency}]: mimeType=${part.mimeType}, data大小=${part.data.length}字节`
                    );

                    // 带上图片序号（共N张）和用户问题，让视觉模型给出结构化、有针对性的描述
                    const visionPrompt =
                        originalQuestion ?
                            `这是第${imageNumber}张（共${totalImages}张）。用户的问题是：${originalQuestion}\n\n请详细描述这张图片的内容，力求准确完整。`
                        :   `这是第${imageNumber}张（共${totalImages}张）。\n\n请详细描述这张图片的内容，力求准确完整。`;

                    try {
                        const response = await visionTool.understandImage(
                            part.data,
                            part.mimeType,
                            visionPrompt,
                            abortController.signal
                        );
                        imageDescriptions[currentIndex] = response.content;
                        completedCount += 1;
                        successCount += 1;
                        Logger.info(
                            `图片 ${imageNumber}/${totalImages} 转换成功 (耗时 ${Date.now() - imageStartTime}ms, 已完成 ${completedCount}/${totalImages})`
                        );
                    } catch (error) {
                        if (abortController.signal.aborted) {
                            throw error;
                        }
                        imageDescriptions[currentIndex] = '[图片分析失败]';
                        completedCount += 1;
                        failedCount += 1;
                        Logger.error(
                            `图片 ${imageNumber}/${totalImages} 转换失败 (耗时 ${Date.now() - imageStartTime}ms, 已完成 ${completedCount}/${totalImages})`,
                            error instanceof Error ? error : undefined
                        );
                    }
                }
            };

            await Promise.all(Array.from({ length: maxConcurrency }, (_, index) => worker(index + 1)));
        } catch (error) {
            if (abortController.signal.aborted) {
                Logger.debug('MiniMax 图片桥接: 请求已取消');
                return { messages };
            }
            throw error;
        }

        if (imageParts.length > 0) {
            Logger.info(
                `全部 ${imageParts.length} 张图片解析完成 (成功 ${successCount} 张, 失败 ${failedCount} 张, 最大并发 ${maxConcurrency}, 总耗时 ${Date.now() - batchStartTime}ms)`
            );
        }

        return MiniMaxVisionBridge.buildBridgeMessages(
            messages,
            lastUserMessageIndex,
            originalQuestion,
            imageDescriptions
        );
    }

    // ==================== 回放相关逻辑 ====================
    // 当 MiniMax 模型支持视觉识别后，以下代码可一并删除

    /**
     * 从消息链中提取图片桥接回放事件
     * 检测消息链末尾是否符合 user(question) -> assistant(tool_call) -> user(tool_result) 模式
     *
     * @param messages 消息链
     * @returns 回放事件，如果不符合模式则返回 null
     */
    static extractReplayEvent(messages: readonly vscode.LanguageModelChatMessage[]): ReplayEvent | null {
        if (messages.length < 3) {
            return null;
        }

        const questionMessage = messages[messages.length - 3];
        const assistantMessage = messages[messages.length - 2];
        const toolResultMessage = messages[messages.length - 1];

        if (
            questionMessage.role !== vscode.LanguageModelChatMessageRole.User ||
            assistantMessage.role !== vscode.LanguageModelChatMessageRole.Assistant ||
            toolResultMessage.role !== vscode.LanguageModelChatMessageRole.User
        ) {
            return null;
        }

        const hasQuestionText = questionMessage.content.some(
            part => part instanceof vscode.LanguageModelTextPart && part.value.trim().length > 0
        );
        if (!hasQuestionText) {
            return null;
        }

        const toolCallPart = assistantMessage.content.find(
            part =>
                part instanceof vscode.LanguageModelToolCallPart &&
                part.name === MiniMaxVisionBridge.definition.toolName
        ) as vscode.LanguageModelToolCallPart | undefined;
        if (!toolCallPart) {
            return null;
        }

        const toolResultPart = toolResultMessage.content.find(
            part => part instanceof vscode.LanguageModelToolResultPart && part.callId === toolCallPart.callId
        ) as vscode.LanguageModelToolResultPart | undefined;
        if (!toolResultPart) {
            return null;
        }

        const resultParts = toolResultPart.content.map(part =>
            part instanceof vscode.LanguageModelTextPart ? part : new vscode.LanguageModelTextPart(JSON.stringify(part))
        );

        return {
            callId: toolCallPart.callId,
            name: toolCallPart.name,
            input: (toolCallPart.input as Record<string, unknown>) || {},
            resultParts
        };
    }

    /**
     * 回放图片桥接工具结果
     * 用于在 Anthropic SDK 流开始时报告已处理的桥接结果
     *
     * @param messages 消息链
     * @param reportResult 回调函数，用于报告工具结果
     * @returns 是否成功回放
     */
    static replayVisionBridge(
        messages: readonly vscode.LanguageModelChatMessage[],
        reportResult: (callId: string, resultParts: vscode.LanguageModelTextPart[]) => void
    ): boolean {
        const replayEvent = MiniMaxVisionBridge.extractReplayEvent(messages);
        if (!replayEvent) {
            return false;
        }

        Logger.info(`MiniMax 图片桥接回放: ${MiniMaxVisionBridge.definition.label} toolCallId: ${replayEvent.callId}`);
        reportResult(replayEvent.callId, replayEvent.resultParts);
        return true;
    }

    /**
     * 收集历史消息中的工具定义
     * 为历史消息中出现过但当前工具列表不包含的工具调用，创建合成的工具定义。
     * Anthropic API 要求：如果消息历史中包含 tool_use / tool_result，对应的 tool 定义必须出现在 tools 参数中。
     *
     * @param messages 消息链
     * @param existingToolNames 已存在的工具名集合
     * @returns 合成的工具定义数组
     */
    static collectHistoricalToolDefinitions(
        messages: readonly vscode.LanguageModelChatMessage[],
        existingToolNames: Set<string>
    ): Anthropic.Messages.Tool[] {
        const syntheticTools: Anthropic.Messages.Tool[] = [];

        for (const message of messages) {
            if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
                continue;
            }

            for (const part of message.content) {
                if (!(part instanceof vscode.LanguageModelToolCallPart)) {
                    continue;
                }
                if (existingToolNames.has(part.name)) {
                    continue;
                }

                existingToolNames.add(part.name);
                syntheticTools.push({
                    name: part.name,
                    description: `History-only synthetic tool call for ${part.name}`,
                    input_schema: {
                        type: 'object' as const,
                        properties: {},
                        required: []
                    }
                });
            }
        }

        return syntheticTools;
    }
}
