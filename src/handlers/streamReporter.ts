/*---------------------------------------------------------------------------------------------
 *  统一流式响应报告器
 *  为所有 Handler 提供统一的 progress.report 策略
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { buildCopilotUsageData } from '../utils/copilotUsage';
import { Logger } from '../utils';
import { encodeStatefulMarker, StatefulMarkerContainer } from './statefulMarker';
import { toOptionalStatefulMarkerField } from './statefulMarkerCodec';
import { CustomDataPartMimeTypes } from './types';
import { TextBuffer, ThinkingBuffer, SignatureBuffer, ToolCallAccumulator } from './buffers';

const USAGE_DATA_ENCODER = new TextEncoder();

export type StatefulMarkerPartial = Omit<StatefulMarkerContainer, 'extension' | 'provider' | 'modelId' | 'sdkMode'>;

/**
 * StreamReporter 配置选项
 */
export interface StreamReporterOptions {
    /** 模型显示名称 */
    modelName: string;
    /** 模型 ID */
    modelId: string;
    /** 提供商名称 */
    provider: string;
    /** SDK 模式 */
    sdkMode: StatefulMarkerContainer['sdkMode'];
    /** Progress 报告器 */
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
    /** 会话 ID（可选，如果不提供则自动生成） */
    sessionId?: string;
}

/**
 * 统一流式响应报告器
 *
 * 架构说明：
 * StreamReporter 自身只负责"协调调度"和"最终输出"，具体的内容累积逻辑委托给
 * src/handlers/buffers/ 下的四个专用 Buffer 类：
 * - TextBuffer: 文本内容缓冲，达到阈值后输出 LanguageModelTextPart
 * - ThinkingBuffer: 思考链缓冲，管理 thinking id 生命周期，输出 LanguageModelThinkingPart
 * - SignatureBuffer: 签名缓冲，累积 signature 供 StatefulMarker 持久化
 * - ToolCallAccumulator: 工具调用分片累积，检测完整 JSON 后输出 CompletedToolCall
 *
 * 核心流程：
 * 1. Handler 持续调用 bufferThinking / reportText / accumulateToolCall / bufferSignature 等方法
 * 2. 各 Buffer 内部累积内容，达到阈值或条件时由 StreamReporter 调用 progress.report 输出
 * 3. 遇到工具调用开始时，先 flush 剩余 thinking/text 并结束当前思维链
 * 4. 流结束时调用 flushAll，依次输出剩余 thinking、signature、结束思维链、剩余 text、未完成 tool call、占位符和 StatefulMarker
 *
 * 关键实现约定：
 * - 文本/思考缓冲阈值均为 20 字符
 * - accumulateToolCall 首次创建某 index 的 buffer 时立即 flushThinking + flushText + endThinkingChain
 * - 工具调用完成时只 flushThinking + flushSignature + thoughtSignature，不主动 endThinkingChain
 * - flushSignature 输出"空文本 + signature"的 ThinkingPart，不消费 thinking buffer 内容
 * - flushAll 中 signature 紧跟 thinking 输出，在 endThinkingChain 之前
 * - 仅有 thinking 没有 text 时输出 \n```\n```\n\n 占位符
 */
export class StreamReporter {
    private readonly modelName: string;
    private readonly modelId: string;
    private readonly provider: string;
    private readonly sdkMode: StatefulMarkerContainer['sdkMode'];
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart2>;

    private readonly textBuffer = new TextBuffer();
    private readonly thinkingBuffer = new ThinkingBuffer();
    private readonly signatureBuffer = new SignatureBuffer();
    private readonly toolCallAccumulator = new ToolCallAccumulator();

    private readonly sessionId: string;
    private responseId: string | null = null;
    private thoughtSignature: string | null = null;
    private hasToolCalls = false;
    private hasReceivedContent = false;
    private hasThinkingContent = false;

    constructor(options: StreamReporterOptions) {
        this.modelName = options.modelName;
        this.modelId = options.modelId;
        this.provider = options.provider;
        this.sdkMode = options.sdkMode;
        this.progress = options.progress;
        this.sessionId = options.sessionId || crypto.randomUUID();
    }

    /**
     * 设置响应 ID（从首个 chunk 的 id 字段提取）
     */
    setResponseId(id: string): void {
        if (!this.responseId) {
            this.responseId = id;
        }
    }

    /**
     * 报告文本内容（累积到阈值后输出，用于 delta 事件）
     */
    reportText(content: string): void {
        // 输出 content 前，先 flush 剩余 thinking 并结束思维链
        this.flushThinking('输出 content 前');
        this.endThinkingChain();

        this.textBuffer.append(content);
        this.hasReceivedContent = true;

        if (this.textBuffer.shouldFlush()) {
            const part = this.textBuffer.flush();
            if (part) {
                this.progress.report(part);
            }
        }
    }

    /**
     * 直接报告完整的工具调用（用于返回完整 tool call 的场景）
     */
    reportToolCall(callId: string, name: string, args: Record<string, unknown> | object): void {
        this.prepareForToolCall();
        this.progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
        this.hasReceivedContent = true;
        this.hasToolCalls = true;

        Logger.info(`[${this.modelName}] Successfully processed tool call: ${name} toolCallId: ${callId}`);
    }

    /**
     * 直接报告完整的工具结果（用于原生 server tool 等场景）
     */
    reportToolResult(callId: string, content: string | vscode.LanguageModelTextPart[]): void {
        this.flushThinking('Before reporting tool result');
        this.flushText('Before reporting tool result');
        this.endThinkingChain();

        const parts = typeof content === 'string' ? [new vscode.LanguageModelTextPart(content)] : content;
        this.progress.report(new vscode.LanguageModelToolResultPart(callId, parts));
        this.hasReceivedContent = true;
    }

    /**
     * 上报 Copilot 可识别的 usage DataPart，用于更新上下文窗口 token 统计。
     */
    reportUsage(rawUsage: unknown): void {
        const usageData = buildCopilotUsageData(rawUsage);
        if (!usageData) {
            return;
        }

        this.progress.report(
            new vscode.LanguageModelDataPart(
                USAGE_DATA_ENCODER.encode(JSON.stringify(usageData)),
                CustomDataPartMimeTypes.Usage
            )
        );
    }

    /**
     * 缓冲思考内容（累积到阈值后输出，用于 delta 事件）
     */
    bufferThinking(content: string): void {
        this.thinkingBuffer.append(content);
        this.hasThinkingContent = true;

        if (this.thinkingBuffer.shouldFlush()) {
            const part = this.thinkingBuffer.flush();
            if (part) {
                this.progress.report(part);
            }
        }
    }

    /**
     * 缓冲完整思考内容（用于 done 事件）
     * 仅当未接收过 delta 事件时才输出（避免重复）
     */
    bufferThinkingIfNotDelta(content: string): void {
        this.thinkingBuffer.appendIfNotDelta(content);
        this.hasThinkingContent = true;

        if (this.thinkingBuffer.shouldFlush()) {
            const part = this.thinkingBuffer.flush();
            if (part) {
                this.progress.report(part);
            }
        }
    }

    /**
     * 累积工具调用数据（去重处理）
     * 当检测到工具调用完成时，立即报告
     *
     * 关键实现约定：
     * - 首次为某 index 创建工具调用 buffer 时：flushThinking + flushText + endThinkingChain
     * - 工具完成时：flushText + flushThinking + flushSignature + thoughtSignature
     *   （不调用 endThinkingChain，思维链的结束留给后续 reportText / flushAll 处理）
     */
    accumulateToolCall(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined
    ): void {
        const { isNew, completed } = this.toolCallAccumulator.accumulate(index, id, name, argsFragment);

        // 首次为该 index 创建工具调用 buffer 时，flush 剩余 thinking 和文本，并结束思维链
        if (isNew) {
            this.flushThinking('Before tool call start');
            this.flushText('Before tool call start');
            this.endThinkingChain();
        }

        if (!completed) {
            return;
        }

        // 工具调用完成，确保之前的思考和签名已输出（此时思维链应已结束，但为安全起见再 flush 一次）
        this.flushText('Before tool call completion');
        this.flushThinking('Before tool call completion');
        this.flushSignature();

        // 如果有 thoughtSignature，输出一个带 signature 的空 ThinkingPart（无 ID）
        if (this.thoughtSignature) {
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', undefined, {
                    signature: this.thoughtSignature
                })
            );
            this.thoughtSignature = null;
        }

        this.progress.report(
            new vscode.LanguageModelToolCallPart(completed.toolCallId, completed.name, completed.args)
        );
        this.hasReceivedContent = true;
        this.hasToolCalls = true;

        Logger.info(
            `[${this.modelName}] Successfully processed tool call: ${completed.name} toolCallId: ${completed.toolCallId}`
        );
    }

    /**
     * Anthropic 特殊：缓冲签名内容
     */
    bufferSignature(content: string): void {
        this.signatureBuffer.append(content);
    }

    /**
     * Anthropic 特殊：输出完整签名并关联到当前 thinking
     *
     * 输出空文本 + signature metadata 的 ThinkingPart，不消费 thinking buffer 内容
     * （签名独立于思考文本输出）。
     */
    flushSignature(): void {
        if (!this.signatureBuffer.hasPending || !this.thinkingBuffer.isActive) {
            return;
        }
        const signature = this.signatureBuffer.take();
        const part = this.thinkingBuffer.buildSignaturePart(signature);
        if (part) {
            this.progress.report(part);
            Logger.trace(`[${this.modelName}] Reported signature metadata: ${signature.length} chars`);
        }
    }

    /**
     * Gemini 特殊：设置思维签名（用于关联 tool call）
     */
    setThoughtSignature(signature: string): void {
        this.thoughtSignature = signature;
    }

    /**
     * 输出剩余思考内容（公开方法）
     */
    flushThinking(_context: string): void {
        const part = this.thinkingBuffer.flush();
        if (part) {
            this.progress.report(part);
        }
    }

    /**
     * 输出剩余文本内容（公开方法）
     */
    flushText(_context: string): void {
        const part = this.textBuffer.flush();
        if (part) {
            this.progress.report(part);
        }
    }

    /**
     * 结束当前思维链（输出空的 ThinkingPart）
     * 公开方法，允许在 Responses API / Gemini 等场景中手动结束思维链
     */
    endThinkingChain(): void {
        const chainId = this.thinkingBuffer.activeId;
        const part = this.thinkingBuffer.endChain();
        if (part) {
            this.progress.report(part);
            Logger.trace(`[${this.modelName}] Ended thinking chain: ${chainId}`);
        }
    }

    /**
     * OpenAI Responses API 专用：输出加密思考内容
     * 同时作为占位符显示给用户，并将 encryptedContent 存入 metadata 供下轮对话传回
     * @param encryptedContent 加密内容 (encrypted_content)
     * @param reasoningId 推理项的原始 id，官方实现必须保留此 id 用于回传 (extractThinkingData)
     * @param summaryText 摘要文本，仅当未经流式传输时传入避免重复（默认显示为占位）
     */
    reportEncryptedThinking(encryptedContent: string, reasoningId?: string, summaryText?: string[]): void {
        if (!encryptedContent) {
            return;
        }
        // 确保先结束之前的思维链
        this.flushThinking('encrypted thinking');
        this.endThinkingChain();
        // 占位符文本 + redactedData + reasoningId metadata 合并输出一个 ThinkingPart
        // id 使用 undefined（不加入 streaming chain），reasoningId 仅存于 metadata 用于重建
        const text = summaryText?.join('\n') || '';
        this.progress.report(
            new vscode.LanguageModelThinkingPart(text, undefined, {
                redactedData: encryptedContent,
                reasoningId: reasoningId
            })
        );
        this.hasThinkingContent = true;
    }

    /**
     * 完成流处理，输出所有剩余内容
     * @param finishReason 结束原因
     * @param customStatefulData 自定义的 StatefulMarker 数据（可选，用于 Responses API 等特殊场景）
     * @returns 是否有内容输出
     */
    flushAll(finishReason: string | null, customStatefulData?: StatefulMarkerPartial): boolean {
        if (finishReason) {
            Logger.debug(`[${this.modelName}] Stream finished, reason: ${finishReason}`);
        }

        // 1. 输出剩余思考内容（length 除外）
        if (finishReason !== 'length') {
            this.flushThinking('Before stream end');
        }

        // 2. 输出剩余签名（Anthropic 特殊，紧跟在思考内容之后）
        if (this.signatureBuffer.hasPending) {
            this.flushSignature();
        }

        // 3. 结束思维链（在工具调用之前）
        this.endThinkingChain();

        // 4. 输出剩余文本内容
        this.flushText('Before stream end');

        // 5. 处理未完成的工具调用（如果有）
        if (this.toolCallAccumulator.hasPending) {
            Logger.warn(
                `[${this.modelName}] Stream ended with ${this.toolCallAccumulator.pendingCount} unfinished tool calls`
            );
            for (const tool of this.toolCallAccumulator.flushAll()) {
                this.progress.report(new vscode.LanguageModelToolCallPart(tool.toolCallId, tool.name, tool.args));
                this.hasToolCalls = true;
            }
        }

        // 6. 处理 \n 占位符（只有在没有任何内容时才添加）
        if (this.hasThinkingContent && !this.hasReceivedContent) {
            this.progress.report(new vscode.LanguageModelTextPart('\n```\n```\n\n'));
            Logger.warn(
                `[${this.modelName}] Stream ended with thinking content only and no text content; added placeholder output`
            );
        }

        // 7. 报告 StatefulMarker
        this.reportStatefulMarker(customStatefulData);

        return this.hasReceivedContent;
    }

    /**
     * 获取是否已接收到内容
     */
    get hasContent(): boolean {
        return this.hasReceivedContent;
    }

    /**
     * 获取会话 ID
     */
    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * 获取响应 ID
     */
    getResponseId(): string | null {
        return this.responseId;
    }

    /**
     * 获取模型名称
     */
    getModelName(): string {
        return this.modelName;
    }

    // ---- 私有辅助方法 ----

    private prepareForToolCall(): void {
        this.flushThinking('Before tool call');
        this.flushText('Before tool call');
        this.endThinkingChain();

        if (this.thoughtSignature) {
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', undefined, {
                    signature: this.thoughtSignature
                })
            );
            this.thoughtSignature = null;
        }
    }

    /**
     * 报告 StatefulMarker DataPart
     */
    private reportStatefulMarker(statefulMarkerData?: StatefulMarkerPartial): void {
        const completeThinking = toOptionalStatefulMarkerField(this.thinkingBuffer.completeContent);
        const completeSignature = toOptionalStatefulMarkerField(this.signatureBuffer.completeContent);
        const marker = encodeStatefulMarker(this.modelId, {
            ...Object.assign(
                {
                    sessionId: this.sessionId,
                    responseId: this.responseId
                },
                statefulMarkerData
            ),
            completeThinking,
            completeSignature,
            hasToolCalls: this.hasToolCalls,
            provider: this.provider,
            modelId: this.modelId,
            sdkMode: this.sdkMode
        });
        this.progress.report(new vscode.LanguageModelDataPart(marker, CustomDataPartMimeTypes.StatefulMarker));
    }
}
