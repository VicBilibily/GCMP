/*---------------------------------------------------------------------------------------------
 *  统一流式响应报告器
 *  为所有 Handler 提供统一的 progress.report 策略
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { Logger } from '../utils';
import { encodeStatefulMarker, StatefulMarkerContainer } from './statefulMarker';
import { toOptionalStatefulMarkerField } from './statefulMarkerCodec';
import { CustomDataPartMimeTypes } from './types';

/** 思考内容缓冲阈值（字符数） */
const THINKING_BUFFER_LENGTH = 20;
/** 文本内容缓冲阈值（字符数） */
const TEXT_BUFFER_LENGTH = 20;

/**
 * 工具调用缓存结构
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    arguments: string;
}

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

export type StatefulMarkerPartial = Omit<StatefulMarkerContainer, 'extension' | 'provider' | 'modelId' | 'sdkMode'>;

/**
 * 统一流式响应报告器
 *
 * 策略说明：
 * - text: 缓冲累积到 20 字符后批量输出 LanguageModelTextPart
 * - thinking: 缓冲累积到 20 字符后批量输出 LanguageModelThinkingPart
 * - tool_calls: 累积完成后立即输出 LanguageModelToolCallPart（在 accumulateToolCall 中检测完成）
 * - datapart: 在流结束时输出 StatefulMarker DataPart
 */
export class StreamReporter {
    private readonly modelName: string;
    private readonly modelId: string;
    private readonly provider: string;
    private readonly sdkMode: StatefulMarkerContainer['sdkMode'];
    private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart2>;

    // 状态追踪
    private hasReceivedContent = false;
    private hasThinkingContent = false;
    private hasReceivedTextDelta = false; // 标记是否已接收文本增量
    private hasReceivedThinkingDelta = false; // 标记是否已接收思考增量

    // 思维链状态
    private currentThinkingId: string | null = null;
    private thinkingBuffer = '';
    private completeThinkingBuffer = '';

    // 文本缓冲状态
    private textBuffer = '';

    // 工具调用缓存
    private readonly toolCallsBuffer = new Map<number, ToolCallBuffer>();
    private hasToolCalls = false;

    // 会话状态
    private sessionId: string;
    private responseId: string | null = null;

    // Anthropic 特殊：签名缓冲
    private signatureBuffer = '';
    // 签名累积缓冲（独立于 flush，用于 StatefulMarker 持久化）
    private completeSignatureBuffer = '';

    // Gemini 特殊：思维签名
    private thoughtSignature: string | null = null;

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

        // 累积文本内容
        this.textBuffer += content;
        this.hasReceivedContent = true;
        this.hasReceivedTextDelta = true; // 标记已接收文本增量

        // 达到阈值时输出
        if (this.textBuffer.length >= TEXT_BUFFER_LENGTH) {
            this.progress.report(new vscode.LanguageModelTextPart(this.textBuffer));
            this.textBuffer = '';
        }
    }

    /**
     * 直接报告完整的工具调用（用于返回完整 tool call 的场景）
     */
    reportToolCall(callId: string, name: string, args: Record<string, unknown> | object): void {
        // 输出工具调用前，先 flush 剩余 thinking 和文本，并结束思维链
        this.flushThinking('输出工具调用前');
        this.flushText('输出工具调用前');
        this.endThinkingChain();

        // 如果有 thoughtSignature，输出一个带 signature 的空 ThinkingPart（无 ID）
        if (this.thoughtSignature) {
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', undefined, {
                    signature: this.thoughtSignature
                })
            );
            this.thoughtSignature = null; // 清空已使用的 signature
        }

        this.progress.report(new vscode.LanguageModelToolCallPart(callId, name, args));
        this.hasReceivedContent = true;
        this.hasToolCalls = true;

        Logger.info(`[${this.modelName}] 成功处理工具调用: ${name} toolCallId: ${callId}`);
    }

    /**
     * 直接报告完整的工具结果（用于原生 server tool 等场景）
     */
    reportToolResult(callId: string, content: string | vscode.LanguageModelTextPart[]): void {
        this.flushThinking('输出工具结果前');
        this.flushText('输出工具结果前');
        this.endThinkingChain();

        const parts = typeof content === 'string' ? [new vscode.LanguageModelTextPart(content)] : content;
        this.progress.report(new vscode.LanguageModelToolResultPart(callId, parts));
        this.hasReceivedContent = true;
    }

    /**
     * 缓冲思考内容（累积到阈值后输出，用于 delta 事件）
     */
    bufferThinking(content: string): void {
        // 如果当前没有 thinking id，则生成一个
        if (!this.currentThinkingId) {
            this.currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            Logger.trace(`[${this.modelName}] 创建新思维链 ID: ${this.currentThinkingId}`);
        }

        this.thinkingBuffer += content;
        this.completeThinkingBuffer += content;
        this.hasThinkingContent = true;
        this.hasReceivedThinkingDelta = true; // 标记已接收思考增量

        // 达到阈值时输出
        if (this.thinkingBuffer.length >= THINKING_BUFFER_LENGTH) {
            this.progress.report(new vscode.LanguageModelThinkingPart(this.thinkingBuffer, this.currentThinkingId));
            this.thinkingBuffer = '';
        }
    }

    /**
     * 缓冲完整思考内容（用于 done 事件）
     * 仅当未接收过 delta 事件时才输出（避免重复）
     */
    bufferThinkingIfNotDelta(content: string): void {
        if (this.hasReceivedThinkingDelta) {
            return; // 如果已经接收过增量，忽略 done 事件
        }
        this.bufferThinking(content);
    }

    /**
     * 累积工具调用数据（去重处理）
     * 当检测到工具调用完成时，立即报告
     */
    accumulateToolCall(
        index: number,
        id: string | undefined,
        name: string | undefined,
        argsFragment: string | undefined
    ): void {
        // 跳过空值，不创建无效的工具调用缓存
        if (!id && !name && !argsFragment) {
            return;
        }

        // 获取或创建工具调用缓存
        let bufferedTool = this.toolCallsBuffer.get(index);
        if (!bufferedTool) {
            // 工具调用开始前，先 flush 剩余 thinking 和文本，并结束思维链
            this.flushThinking('工具调用开始');
            this.flushText('工具调用开始');
            this.endThinkingChain();

            bufferedTool = { arguments: '' };
            this.toolCallsBuffer.set(index, bufferedTool);
            Logger.trace(`🔧 [${this.modelName}] 工具调用开始: ${name || 'unknown'} (索引: ${index})`);
        }

        // 累积数据
        if (id) {
            bufferedTool.id = id;
        }
        if (name) {
            bufferedTool.name = name;
        }
        if (argsFragment) {
            bufferedTool.arguments = this.deduplicateToolArgs(bufferedTool.arguments, argsFragment);
        }

        // 检测工具调用是否完成（有完整的 JSON）
        if (bufferedTool.name && bufferedTool.arguments) {
            try {
                // 尝试解析参数，如果成功说明工具调用完成
                const args = JSON.parse(bufferedTool.arguments);

                // 确保之前的思考和签名已输出
                this.flushThinking('工具调用完成前');
                if (this.signatureBuffer) {
                    this.flushSignature();
                }

                // 使用 UUID 生成唯一 ID（如果没有 id）
                const toolCallId = bufferedTool.id || crypto.randomUUID();

                // 如果有 thoughtSignature，输出一个带 signature 的空 ThinkingPart
                if (this.thoughtSignature) {
                    this.progress.report(
                        new vscode.LanguageModelThinkingPart('', undefined, {
                            signature: this.thoughtSignature
                        })
                    );
                    this.thoughtSignature = null;
                }

                // 立即报告工具调用
                this.progress.report(new vscode.LanguageModelToolCallPart(toolCallId, bufferedTool.name, args));
                this.hasReceivedContent = true;
                this.hasToolCalls = true;

                // 从缓存中移除已处理的工具调用
                this.toolCallsBuffer.delete(index);

                Logger.info(`[${this.modelName}] 成功处理工具调用: ${bufferedTool.name} toolCallId: ${toolCallId}`);
            } catch {
                // JSON 解析失败，工具调用还未完成，继续累积
                // Logger.trace(`[${this.modelName}] 工具调用参数未完整，继续累积: ${bufferedTool.name}`);
            }
        }
    }

    /**
     * 去重工具调用参数（处理 DeepSeek 等 API 的重复片段）
     */
    private deduplicateToolArgs(existing: string, newArgs: string): string {
        // 完全重复，跳过
        if (existing.endsWith(newArgs)) {
            Logger.trace(`[${this.modelName}] 跳过重复的工具调用参数: "${newArgs}"`);
            return existing;
        }
        // 新数据包含了旧数据（完全重复+新增），只取新增部分
        if (existing.length > 0 && newArgs.startsWith(existing)) {
            return newArgs;
        }
        // 正常累积
        return existing + newArgs;
    }

    /**
     * Anthropic 特殊：缓冲签名内容
     */
    bufferSignature(content: string): void {
        this.signatureBuffer += content;
        this.completeSignatureBuffer += content;
    }

    /**
     * Anthropic 特殊：输出完整签名并关联到当前 thinking
     */
    flushSignature(): void {
        if (this.signatureBuffer && this.currentThinkingId) {
            // 签名作为 metadata 传递，而不是文本内容
            this.progress.report(
                new vscode.LanguageModelThinkingPart('', this.currentThinkingId, {
                    signature: this.signatureBuffer
                })
            );
            Logger.trace(`[${this.modelName}] 输出签名 metadata: ${this.signatureBuffer.length} 字符`);
        }
        this.signatureBuffer = '';
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
        if (this.thinkingBuffer.length > 0 && this.currentThinkingId) {
            this.progress.report(new vscode.LanguageModelThinkingPart(this.thinkingBuffer, this.currentThinkingId));
            // Logger.trace(`[${this.modelName}] ${context}时报告剩余思考内容: ${this.thinkingBuffer.length}字符`);
            // 清空缓冲区
            this.thinkingBuffer = '';
        }
        // 注意：不在这里重置 currentThinkingId，保持思维链连续性
    }

    /**
     * 输出剩余文本内容（公开方法）
     */
    flushText(_context: string): void {
        if (this.textBuffer.length > 0) {
            this.progress.report(new vscode.LanguageModelTextPart(this.textBuffer));
            // Logger.trace(`[${this.modelName}] ${context}时报告剩余文本内容: ${this.textBuffer.length}字符`);
            // 清空缓冲区
            this.textBuffer = '';
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
     * 结束当前思维链（输出空的 ThinkingPart）
     * 公开方法，允许在 Responses API 等场景中手动结束思维链
     */
    endThinkingChain(): void {
        if (this.currentThinkingId) {
            this.progress.report(new vscode.LanguageModelThinkingPart('', this.currentThinkingId));
            Logger.trace(`[${this.modelName}] 结束思维链: ${this.currentThinkingId}`);
            this.currentThinkingId = null;
        }
    }

    /**
     * 输出所有工具调用（备用方法，用于处理流结束时未完成的工具调用）
     * 正常情况下，工具调用会在 accumulateToolCall 中完成时立即报告
     */
    private flushToolCalls(): boolean {
        let toolProcessed = false;
        for (const [toolIndex, bufferedTool] of this.toolCallsBuffer.entries()) {
            if (bufferedTool.name && bufferedTool.arguments) {
                try {
                    const args = JSON.parse(bufferedTool.arguments);
                    // 使用 UUID 生成唯一 ID，避免并行调用时重复
                    const toolCallId = bufferedTool.id || crypto.randomUUID();

                    this.progress.report(new vscode.LanguageModelToolCallPart(toolCallId, bufferedTool.name, args));
                    this.hasToolCalls = true;

                    Logger.info(`[${this.modelName}] 成功处理工具调用: ${bufferedTool.name} toolCallId: ${toolCallId}`);
                    toolProcessed = true;
                } catch (error) {
                    Logger.error(`[${this.modelName}] 无法解析工具调用参数: ${bufferedTool.name} error: ${error}`);
                }
            } else {
                Logger.warn(
                    `[${this.modelName}] 不完整的工具调用 [${toolIndex}]: name=${bufferedTool.name}, args_length=${bufferedTool.arguments.length}`
                );
            }
        }
        return toolProcessed;
    }

    /**
     * 报告 StatefulMarker DataPart
     */
    private reportStatefulMarker(statefulMarkerData?: StatefulMarkerPartial): void {
        const completeThinking = toOptionalStatefulMarkerField(this.completeThinkingBuffer);
        const completeSignature = toOptionalStatefulMarkerField(this.completeSignatureBuffer);
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

    /**
     * 完成流处理，输出所有剩余内容
     * @param finishReason 结束原因
     * @param customStatefulData 自定义的 StatefulMarker 数据（可选，用于 Responses API 等特殊场景）
     * @returns 是否有内容输出
     */
    flushAll(finishReason: string | null, customStatefulData?: StatefulMarkerPartial): boolean {
        if (finishReason) {
            Logger.debug(`[${this.modelName}] 流已结束，原因: ${finishReason}`);
        }

        // 1. 输出剩余思考内容（length 除外）
        if (finishReason !== 'length') {
            this.flushThinking('流结束前');
        }

        // 2. 输出剩余签名（Anthropic 特殊，紧跟在思考内容之后）
        if (this.signatureBuffer) {
            this.flushSignature();
        }

        // 3. 结束思维链（在工具调用之前）
        this.endThinkingChain();

        // 4. 输出剩余文本内容
        this.flushText('流结束前');

        // 5. 处理未完成的工具调用（如果有）
        if (this.toolCallsBuffer.size > 0) {
            Logger.warn(`[${this.modelName}] 流结束时仍有 ${this.toolCallsBuffer.size} 个未完成的工具调用`);
            this.flushToolCalls();
        }

        // 6. 处理 \n 占位符（只有在没有任何内容时才添加）
        if (this.hasThinkingContent && !this.hasReceivedContent) {
            this.progress.report(new vscode.LanguageModelTextPart('\n'));
            Logger.warn(`[${this.modelName}] 消息流结束时只有思考内容没有文本内容，添加了 \\n 占位符作为输出`);
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
}
