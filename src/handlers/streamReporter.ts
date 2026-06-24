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
import { LiveMetricsTracker } from './liveMetricsTracker';
import type { LiveStreamMetricEvent } from './liveMetrics';
import { TokenCounter } from '../utils/tokenCounter';
import type { TikTokenizer } from '@microsoft/tiktokenizer';

const USAGE_DATA_ENCODER = new TextEncoder();

/**
 * 将字符串序列化为工具参数 JSON（用于完整 tool call 路径的字符与 token 统计）
 */
function stringifyToolArgs(args: Record<string, unknown> | object): string | undefined {
    try {
        return JSON.stringify(args) ?? undefined;
    } catch {
        return undefined;
    }
}

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
    /** 请求 ID（可选，用于实时指标） */
    requestId?: string;
    /** 请求开始时间戳（可选，用于实时指标） */
    requestStartTime?: number;
    /** 实时指标回调（可选） */
    onLiveMetrics?: (event: LiveStreamMetricEvent) => void;
    /**
     * 共享的 tokenizer 实例（可选）。注入后会用于实时估算输出 token 数。
     * 失败/未注入时降级为只统计字符数，不影响 chars/s 速度统计。
     */
    tokenizer?: TikTokenizer;
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
 * - accumulateToolCall 首次创建某 index 的 buffer 时立即 flushThinking + endThinkingChain + flushText
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
    private readonly tracker: LiveMetricsTracker;

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

    /**
     * 安全获取共享 tokenizer 实例。未初始化或加载失败时返回 undefined，
     * 所有 token 估算降级为只统计字符数。
     */
    private static tryGetSharedTokenizer(): TikTokenizer | undefined {
        try {
            return TokenCounter.getSharedTokenizer();
        } catch {
            return undefined;
        }
    }

    constructor(options: StreamReporterOptions) {
        this.modelName = options.modelName;
        this.modelId = options.modelId;
        this.provider = options.provider;
        this.sdkMode = options.sdkMode;
        this.progress = options.progress;
        this.sessionId = options.sessionId || crypto.randomUUID();
        this.tracker = new LiveMetricsTracker({
            requestId: options.requestId,
            requestStartTime: options.requestStartTime,
            providerName: options.provider,
            modelName: options.modelName,
            onLiveMetrics: options.onLiveMetrics,
            // 共享 tokenizer 由 tracker 内部按阈值批量 encode，避免每个 chunk 都触发计算
            tokenizer: options.tokenizer ?? StreamReporter.tryGetSharedTokenizer()
        });
    }

    /**
     * 标记流已开始（由 handler 在设置 streamStartTime 的同一时刻调用，共用同一个时间戳）。
     * 详见 LiveMetricsTracker.markStreamStarted。
     */
    markStreamStarted(streamStartTime: number): void {
        this.tracker.markStreamStarted(streamStartTime);
    }

    /**
     * 获取已记录的流开始时间（只读，不触发指标事件）。
     */
    getMetricStreamStartTime(): number | undefined {
        return this.tracker.getMetricStreamStartTime();
    }

    /**
     * 心跳：触发受节流的轻量刷新（不固定首流时间）。
     */
    heartbeat(): void {
        this.tracker.heartbeat();
    }

    /**
     * 结束实时指标上报（幂等）。
     */
    finishMetrics(): void {
        this.tracker.finishMetrics();
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

        // 实时指标：传原始文本给 tracker，由其按阈值批量 encode（避免每个 chunk 都触发计算）
        this.tracker.reportOutput(content);

        if (this.textBuffer.shouldFlush()) {
            const part = this.textBuffer.flush();
            if (part) {
                this.progress.report(part);
            }
        }
    }

    /**
     * 直接报告完整的工具调用（用于返回完整 tool call 的场景）
     * @param options.countArgs 是否统计 args 字符到 live chars/s（默认 true）
     *   Anthropic handler 因已通过 reportToolArgDelta 统计，应传 false 避免双计数
     */
    reportToolCall(
        callId: string,
        name: string,
        args: Record<string, unknown> | object,
        options: { countArgs?: boolean } = {}
    ): void {
        this.prepareForToolCall();

        // 完整 tool arguments 也是 provider 实际回传的一部分；
        // 用于不提供 argument delta、只提供完整 tool call 的 provider/SDK 路径。
        const argsJson = stringifyToolArgs(args);
        if ((options.countArgs ?? true) && argsJson) {
            this.tracker.reportOutput(argsJson);
        }
        // 补回 name + id + type + JSON 结构开销，让预估 token 接近 provider 实际计费值
        // （countArgs=false 时 args 已通过 reportToolArgDelta 累计，这里只补非 args 部分）
        if (argsJson) {
            this.tracker.reportToolCallOverhead(this.sdkMode, name, argsJson);
        }

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
        this.endThinkingChain();
        this.flushText('Before reporting tool result');

        const parts = typeof content === 'string' ? [new vscode.LanguageModelTextPart(content)] : content;
        this.progress.report(new vscode.LanguageModelToolResultPart(callId, parts));
        this.hasReceivedContent = true;
    }

    /**
     * 上报工具调用参数增量（仅更新速度统计，不触发 progress.report）
     * 适用于 handler 自行管理 tool call 缓冲的场景（如 Anthropic handler 的 input_json_delta）
     * 只用于 provider raw tool-argument delta；不要用于本地 tool result 或工具执行输出
     *
     * @param deltaText 增量原始文本（用于同步 encode 估算 token）
     */
    reportToolArgDelta(deltaText: string): void {
        this.tracker.reportOutput(deltaText);
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
        // 实时指标：传原始文本给 tracker，由其按阈值批量 encode
        this.tracker.reportOutput(content);

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
 * - 首次为某 index 创建工具调用 buffer 时：flushThinking + endThinkingChain + flushText
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

        // 首次为该 index 创建工具调用 buffer 时，flush 剩余 thinking，结束思维链，再输出文本
        // 必须在 endThinkingChain 之后再 flushText，否则 TextPart 会在 thinking chain 仍 active 时被报告，
        // 导致 VS Code 将文本归入 thinking fold 内部（表现为内容被折叠、下方出现空框）
        if (isNew) {
            this.flushThinking('Before tool call start');
            this.endThinkingChain();
            this.flushText('Before tool call start');
        }

        // tool argument delta 是 provider 实际回传的一部分，计入 token 估算
        if (argsFragment) {
            this.tracker.reportOutput(argsFragment);
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

        // 补回 name + id + type + JSON 结构开销：args 已通过 argsFragment 分片累计，
        // 这里只补非 args 部分，让预估 token 接近 provider 实际计费值
        const completedArgsJson = stringifyToolArgs(completed.args);
        if (completedArgsJson) {
            this.tracker.reportToolCallOverhead(this.sdkMode, completed.name, completedArgsJson);
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
                // 同步补回 name + id + type + JSON 结构开销，与正常完成路径保持一致
                const flushArgsJson = stringifyToolArgs(tool.args);
                if (flushArgsJson) {
                    this.tracker.reportToolCallOverhead(this.sdkMode, tool.name, flushArgsJson);
                }
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

        // 8. 结束实时指标上报
        this.finishMetrics();

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
     *
     * completeThinking / completeSignature 通过 base64url 编码安全传递，
     * 避免 VS Code 聊天历史序列化管道因特殊字符（\n, \\, \", 等）导致的截断。
     * 详见 statefulMarkerCodec.ts 的 JSON_PAYLOAD_PREFIX 说明。
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
