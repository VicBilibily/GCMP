/*---------------------------------------------------------------------------------------------
 *  OpenAI Special 模式处理器
 *  处理非标准 OpenAI 流格式（openai-special 模式）
 *  直接解析原始 SSE 流，不使用 OpenAI SDK
 *  参考实现：https://github.com/JohnnyZ93/oai-compatible-copilot/blob/main/src/provider.ts
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger, VersionManager, ApiKeyManager } from '../utils';
import { ModelConfig } from '../types/sharedTypes';

/**
 * 工具调用缓存结构
 */
interface ToolCallBuffer {
    id?: string;
    name?: string;
    args: string;
}

/**
 * OpenAI Special 模式处理器
 * 用于处理非标准的 OpenAI 兼容 API 流格式
 */
export class OpenAISpecialHandler {
    // 工具调用缓存 - 用于处理分块的工具调用数据
    private toolCallBuffers = new Map<number, ToolCallBuffer>();
    // 已完成的工具调用索引集合
    private completedToolCallIndices = new Set<number>();
    // 是否已发送 begin-tool-calls 提示
    private emittedBeginToolCallsHint = false;
    // 是否已发送助手文本
    private hasEmittedAssistantText = false;
    // XML think 块解析状态
    private xmlThinkActive = false;
    private xmlThinkDetectionAttempted = false;
    // 当前思考内容 ID
    private currentThinkingId: string | null = null;
    // 工具调用去重集合
    private emittedTextToolCallKeys = new Set<string>();
    private emittedTextToolCallIds = new Set<string>();
    // 思考内容缓冲 - 用于批量刷新思考内容以优化性能
    private thinkingBuffer: string = '';
    // 思考内容刷新计时器 - 80ms 延迟缓冲
    private thinkingFlushTimer: NodeJS.Timeout | null = null;

    constructor(private displayName: string) {
        // displayName 用于日志输出
    }

    /**
     * 处理 openai-special 模式的请求
     * 直接从原始流中读取和解析非标准格式，并提供给 Copilot 使用
     * 不通过 OpenAI SDK，而是手动处理流解析
     * 支持 thinking、tool_calls 等多种格式
     */
    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        _messages: readonly vscode.LanguageModelChatMessage[],
        baseURL: string,
        requestBody: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        providerKey?: string
    ): Promise<void> {
        // 清理状态
        this.toolCallBuffers.clear();
        this.completedToolCallIndices.clear();
        this.emittedBeginToolCallsHint = false;
        this.hasEmittedAssistantText = false;
        this.xmlThinkActive = false;
        this.xmlThinkDetectionAttempted = false;
        this.currentThinkingId = null;
        this.emittedTextToolCallKeys.clear();
        this.emittedTextToolCallIds.clear();
        // 清理思考内容缓冲和计时器
        this.thinkingBuffer = '';
        if (this.thinkingFlushTimer) {
            clearTimeout(this.thinkingFlushTimer);
            this.thinkingFlushTimer = null;
        }

        // 获取 API Key
        // 优先级：传入的 providerKey -> modelConfig.provider -> 'openai'
        const effectiveProviderKey = modelConfig.provider || providerKey || 'openai';
        const currentApiKey = await ApiKeyManager.getApiKey(effectiveProviderKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }

        // 构建请求头
        const defaultHeaders: Record<string, string> = {
            Authorization: `Bearer ${currentApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': VersionManager.getUserAgent('OpenAI')
        };

        const processedCustomHeader = ApiKeyManager.processCustomHeader(modelConfig?.customHeader, currentApiKey);
        if (Object.keys(processedCustomHeader).length > 0) {
            Object.assign(defaultHeaders, processedCustomHeader);
            Logger.trace(`${model.name} 应用自定义头部: ${JSON.stringify(modelConfig.customHeader)}`);
        }

        Logger.debug(`[${model.name}] 发送 ${this.displayName} openai-special API 请求`);

        // 发送请求
        const response = await fetch(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers: defaultHeaders,
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${this.displayName} API 错误: [${response.status}] ${response.statusText}\n${errorText}`);
        }

        // 处理流响应
        const contentType = response.headers.get('Content-Type');
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            // 不是 SSE 流，获取响应内容用于错误诊断
            const errorContent = await response.text();
            const errorMsg = `响应不是 SSE 流格式。Content-Type: ${contentType}\n响应内容: ${errorContent.slice(0, 500)}`;
            Logger.error(`[${model.name}] ${errorMsg}`);
            throw new Error(errorMsg);
        }

        await this.processStreamingResponse(response.body, progress, token, model);

        Logger.debug(`✅ ${model.name} ${this.displayName} openai-special 解析完成`);
    }

    /**
     * 处理 SSE 流响应
     * 按照 oai-compatible-copilot 的方式直接解析原始 SSE 流
     */
    private async processStreamingResponse(
        responseBody: ReadableStream<Uint8Array>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        model: vscode.LanguageModelChatInformation
    ): Promise<void> {
        const reader = responseBody.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (!token.isCancellationRequested) {
                const { done, value } = await reader.read();
                if (done) {
                    // 流正常结束，刷新所有缓冲的内容
                    await this.flushToolCallBuffers(progress, false);
                    this.flushThinkingBuffer(progress, true);
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data:')) {
                        continue;
                    }

                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        // 流结束，刷新缓冲的工具调用和思考内容
                        await this.flushToolCallBuffers(progress, false);
                        this.flushThinkingBuffer(progress, true);
                        Logger.debug(`[${model.name}] 收到流结束标记`);
                        continue;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        Logger.trace(`[${model.name}] Chunk: ${JSON.stringify(parsed)}`);
                        await this.processDelta(parsed, progress, model);
                    } catch {
                        // 静默忽略格式错误的 SSE 行
                        Logger.trace(`[${model.name}] 解析 JSON 失败: ${data.slice(0, 100)}`);
                    }
                }
            }
        } finally {
            reader.releaseLock();
            // 清理所有状态
            this.toolCallBuffers.clear();
            this.completedToolCallIndices.clear();
            this.emittedBeginToolCallsHint = false;
            this.hasEmittedAssistantText = false;
            this.xmlThinkActive = false;
            this.xmlThinkDetectionAttempted = false;
            this.currentThinkingId = null;
            this.emittedTextToolCallKeys.clear();
            this.emittedTextToolCallIds.clear();
            // 清理思考内容缓冲和计时器
            this.thinkingBuffer = '';
            if (this.thinkingFlushTimer) {
                clearTimeout(this.thinkingFlushTimer);
                this.thinkingFlushTimer = null;
            }
        }
    }

    /**
     * 处理单个 delta（choice）
     * 提取思考内容、文本内容、工具调用等信息
     * 参考 oai-compatible-copilot 的 processDelta 实现
     * @returns 是否发送了任何内容
     */
    private async processDelta(
        delta: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        model: vscode.LanguageModelChatInformation
    ): Promise<boolean> {
        let emitted = false;
        const choice = (delta.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) {
            return false;
        }

        const deltaObj = choice.delta as Record<string, unknown> | undefined;

        // 处理思考内容（支持多种格式）
        try {
            const maybeThinking =
                (choice as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.thinking ??
                (deltaObj as Record<string, unknown> | undefined)?.reasoning_content;

            // 处理 reasoning_details 数组（OpenRouter/Claude 格式）
            const maybeReasoningDetails =
                (deltaObj as Record<string, unknown>)?.reasoning_details ??
                (choice as Record<string, unknown>)?.reasoning_details;

            if (maybeReasoningDetails && Array.isArray(maybeReasoningDetails) && maybeReasoningDetails.length > 0) {
                // 优先处理 details 数组而不是简单的 reasoning
                const details = maybeReasoningDetails as Array<Record<string, unknown>>;
                // 按索引排序以保持顺序（防止乱序块）
                const sortedDetails = details.sort((a, b) => ((a.index as number) ?? 0) - ((b.index as number) ?? 0));

                for (const detail of sortedDetails) {
                    let extractedText = '';
                    if (detail.type === 'reasoning.summary') {
                        extractedText = ((detail as Record<string, unknown>).summary as string) || '';
                    } else if (detail.type === 'reasoning.text') {
                        extractedText = ((detail as Record<string, unknown>).text as string) || '';
                    } else if (detail.type === 'reasoning.encrypted') {
                        extractedText = '[REDACTED]'; // 根据文档
                    } else {
                        extractedText = JSON.stringify(detail); // 未知类型的回退
                    }

                    if (extractedText) {
                        if (!this.currentThinkingId) {
                            this.currentThinkingId = this.generateThinkingId();
                        }
                        Logger.trace(`🧠 接收到推理详情: ${extractedText.length}字符`);
                        this.bufferThinkingContent(extractedText, {
                            format: detail.format,
                            type: detail.type,
                            index: detail.index
                        });
                        emitted = true;
                    }
                }
                // 如果有 details，跳过简单的 thinking 处理
            } else if (maybeThinking !== undefined && maybeThinking !== null) {
                let text = '';
                let metadata: Record<string, unknown> | undefined;
                if (maybeThinking && typeof maybeThinking === 'object') {
                    const mt = maybeThinking as Record<string, unknown>;
                    text = typeof mt['text'] === 'string' ? (mt['text'] as string) : JSON.stringify(mt);
                    metadata = mt['metadata'] ? (mt['metadata'] as Record<string, unknown>) : undefined;
                } else if (typeof maybeThinking === 'string') {
                    text = maybeThinking;
                }

                if (text) {
                    if (!this.currentThinkingId) {
                        this.currentThinkingId = this.generateThinkingId();
                    }
                    Logger.trace(`🧠 接收到思考内容: ${text.length}字符`);
                    this.bufferThinkingContent(text, metadata);
                    emitted = true;
                }
            }
        } catch (e) {
            Logger.warn(`[${model.name}] 处理思考内容失败: ${e}`);
        }

        // 处理文本内容
        if (deltaObj?.content) {
            const content = String(deltaObj.content);

            // 处理 XML think 块或文本内容（互斥）
            const xmlRes = this.processXmlThinkBlocks(content, progress);
            if (xmlRes.emittedAny) {
                // XML think 块已处理
                emitted = true;
            } else {
                // 检查是否有可见内容
                const hasVisibleContent = content.trim().length > 0;

                // 如果有可见内容且有活跃的思考序列，先刷新思考缓冲
                if (hasVisibleContent && this.currentThinkingId) {
                    try {
                        this.flushThinkingBuffer(progress, true);
                    } catch (e) {
                        Logger.warn(`[${model.name}] 刷新思考缓冲失败: ${e}`);
                    } finally {
                        this.currentThinkingId = null;
                    }
                }

                // 处理文本内容
                const res = this.processTextContent(content, progress);
                if (res.emittedText) {
                    this.hasEmittedAssistantText = true;
                    emitted = true;
                }
            }
        }

        // 处理工具调用
        if (deltaObj?.tool_calls && Array.isArray(deltaObj.tool_calls)) {
            const toolCalls = deltaObj.tool_calls as Array<Record<string, unknown>>;

            // 如果工具调用出现在文本后，发送一个空格来刷新缓冲区
            if (!this.emittedBeginToolCallsHint && this.hasEmittedAssistantText && toolCalls.length > 0) {
                progress.report(new vscode.LanguageModelTextPart(' '));
                this.emittedBeginToolCallsHint = true;
            }

            for (const tc of toolCalls) {
                const idx = (tc.index as number) ?? 0;

                // 忽略已完成的工具调用索引
                if (this.completedToolCallIndices.has(idx)) {
                    continue;
                }

                const buf = this.toolCallBuffers.get(idx) ?? { args: '' };

                if (tc.id && typeof tc.id === 'string') {
                    buf.id = tc.id as string;
                }

                const func = tc.function as Record<string, unknown> | undefined;
                if (func?.name && typeof func.name === 'string') {
                    buf.name = func.name as string;
                }
                if (typeof func?.arguments === 'string') {
                    buf.args += func.arguments as string;
                }

                this.toolCallBuffers.set(idx, buf);

                Logger.debug(
                    `[${model.name}] 累积工具调用 [${idx}]: id=${buf.id}, name=${buf.name}, args_len=${buf.args.length}`
                );

                // 尝试立即发送（如果参数已完整）
                await this.tryEmitBufferedToolCall(idx, progress, model.name);
            }
        }

        // 检查 finish_reason
        const finish = (choice.finish_reason as string | undefined) ?? undefined;
        if (finish === 'tool_calls' || finish === 'stop') {
            Logger.debug(`[${model.name}] 流已结束，原因: ${finish}`);
            // 刷新所有缓冲的工具调用，tool_calls 时抛异常
            const throwOnInvalid = finish === 'tool_calls';
            await this.flushToolCallBuffers(progress, throwOnInvalid);
        }

        return emitted;
    }

    /**
     * 处理 XML <think> 块
     */
    private processXmlThinkBlocks(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>
    ): { emittedAny: boolean } {
        // 如果已检查且未找到，跳过处理
        if (this.xmlThinkDetectionAttempted && !this.xmlThinkActive) {
            return { emittedAny: false };
        }

        const THINK_START = '<think>';
        const THINK_END = '</think>';

        let data = input;
        let emittedAny = false;

        while (data.length > 0) {
            if (!this.xmlThinkActive) {
                // 查找 think 开始标签
                const startIdx = data.indexOf(THINK_START);
                if (startIdx === -1) {
                    // 未找到开始标签，标记为已检查并跳过
                    this.xmlThinkDetectionAttempted = true;
                    data = '';
                    break;
                }

                // 找到开始标签
                this.xmlThinkActive = true;
                this.currentThinkingId = this.generateThinkingId();

                // 跳过开始标签并继续处理
                data = data.slice(startIdx + THINK_START.length);
                continue;
            }

            // 在 think 块内，查找结束标签
            const endIdx = data.indexOf(THINK_END);
            if (endIdx === -1) {
                // 未找到结束标签，发送当前内容作为思考部分
                const thinkContent = data.trim();
                if (thinkContent) {
                    progress.report(
                        new vscode.LanguageModelThinkingPart(thinkContent, this.currentThinkingId || undefined)
                    );
                    emittedAny = true;
                }
                data = '';
                break;
            }

            // 找到结束标签，发送最后的思考部分
            const thinkContent = data.slice(0, endIdx);
            if (thinkContent) {
                progress.report(
                    new vscode.LanguageModelThinkingPart(thinkContent, this.currentThinkingId || undefined)
                );
                emittedAny = true;
            }

            // 重置状态并继续处理剩余数据
            this.xmlThinkActive = false;
            this.currentThinkingId = null;
            data = data.slice(endIdx + THINK_END.length);
        }

        return { emittedAny };
    }

    /**
     * 处理文本内容
     */
    private processTextContent(
        input: string,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>
    ): { emittedText: boolean; emittedAny: boolean } {
        let emittedText = false;

        if (input && input.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(input));
            emittedText = true;
        }

        return { emittedText, emittedAny: emittedText };
    }

    /**
     * 尝试解析 JSON 对象
     */
    private tryParseJSON(str: string): { ok: boolean; value?: unknown; error?: string } {
        if (!str || str.trim().length === 0) {
            return { ok: false, error: '空字符串' };
        }

        try {
            const value = JSON.parse(str);
            return { ok: true, value };
        } catch {
            return { ok: false };
        }
    }

    /**
     * 尝试立即发送缓冲的工具调用（如果参数已完整）
     */
    private async tryEmitBufferedToolCall(
        index: number,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        modelName: string
    ): Promise<void> {
        const buf = this.toolCallBuffers.get(index);
        if (!buf) {
            return;
        }

        if (!buf.name) {
            return;
        }

        const canParse = this.tryParseJSON(buf.args);
        if (!canParse.ok) {
            // 如果解析失败，记录错误但不立即返回，让流继续接收更多数据
            Logger.trace(`[${modelName}] 工具调用 [${index}] 参数暂未完整: ${canParse.error || '未知错误'}`);
            return;
        }

        const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
        const parameters = canParse.value as Record<string, unknown>;
        const name = buf.name;

        // 工具调用去重逻辑
        try {
            const canonical = JSON.stringify(parameters);
            const key = `${name}:${canonical}`;

            // 基于索引的去重
            const idKey = `${name}:${index}`;
            if (this.emittedTextToolCallIds.has(idKey)) {
                this.toolCallBuffers.delete(index);
                this.completedToolCallIndices.add(index);
                return;
            }

            // 基于内容的去重
            if (this.emittedTextToolCallKeys.has(key)) {
                this.toolCallBuffers.delete(index);
                this.completedToolCallIndices.add(index);
                return;
            }

            // 标记为已发送
            this.emittedTextToolCallIds.add(idKey);
            this.emittedTextToolCallKeys.add(key);
        } catch {
            // 忽略序列化错误
        }

        progress.report(new vscode.LanguageModelToolCallPart(id, name, parameters));
        Logger.info(`[${modelName}] ✅ 工具调用已发送: ${name}`);

        this.toolCallBuffers.delete(index);
        this.completedToolCallIndices.add(index);
    }

    /**
     * 刷新所有缓冲的工具调用
     */
    private async flushToolCallBuffers(
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        throwOnInvalid: boolean
    ): Promise<void> {
        if (this.toolCallBuffers.size === 0) {
            return;
        }

        Logger.debug(`刷新 ${this.toolCallBuffers.size} 个缓冲的工具调用`);

        for (const [idx, buf] of Array.from(this.toolCallBuffers.entries())) {
            const parsed = this.tryParseJSON(buf.args);

            if (!parsed.ok) {
                if (throwOnInvalid) {
                    Logger.error(`无法解析工具调用参数: name=${buf.name}, args=${buf.args.slice(0, 200)}`);
                    throw new Error('Invalid JSON for tool call');
                }
                // 不抛异常时，静默跳过
                continue;
            }

            const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
            const name = buf.name ?? 'unknown_tool';
            const parameters = parsed.value as Record<string, unknown>;

            // 工具调用去重逻辑
            try {
                const canonical = JSON.stringify(parameters);
                const key = `${name}:${canonical}`;

                // 基于索引的去重
                const idKey = `${name}:${idx}`;
                if (this.emittedTextToolCallIds.has(idKey)) {
                    this.toolCallBuffers.delete(idx);
                    this.completedToolCallIndices.add(idx);
                    continue;
                }

                // 基于内容的去重
                if (this.emittedTextToolCallKeys.has(key)) {
                    this.toolCallBuffers.delete(idx);
                    this.completedToolCallIndices.add(idx);
                    continue;
                }

                // 标记为已发送
                this.emittedTextToolCallIds.add(idKey);
                this.emittedTextToolCallKeys.add(key);
            } catch {
                // 忽略序列化错误
            }

            progress.report(new vscode.LanguageModelToolCallPart(id, name, parameters));
            Logger.info(`✅ 工具调用已发送: ${name}`);

            this.toolCallBuffers.delete(idx);
            this.completedToolCallIndices.add(idx);
        }
    }

    /**
     * 生成思考内容 ID
     */
    private generateThinkingId(): string {
        return `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * 缓冲思考内容，使用 80ms 延迟批量刷新以优化性能
     * 同步 provider.ts 的思考内容缓冲策略
     */
    private bufferThinkingContent(content: string, _metadata?: Record<string, unknown>): void {
        if (!content) {
            return;
        }

        // 累积思考文本
        this.thinkingBuffer += content;

        // 清除现有的计时器
        if (this.thinkingFlushTimer) {
            clearTimeout(this.thinkingFlushTimer);
        }

        // 安排延迟刷新（80ms）以批量处理多个小块
        this.thinkingFlushTimer = setTimeout(() => {
            this.thinkingFlushTimer = null;
            // 注意: 这里无法访问 progress，所以在实际刷新时由 flushThinkingBuffer 处理
        }, 80);
    }

    /**
     * 刷新思考内容缓冲到 progress
     * 同步 provider.ts 的实现方式
     */
    private flushThinkingBuffer(
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        immediate: boolean = false
    ): void {
        if (this.thinkingBuffer && this.currentThinkingId) {
            progress.report(new vscode.LanguageModelThinkingPart(this.thinkingBuffer, this.currentThinkingId));
        }

        // 清除计时器
        if (this.thinkingFlushTimer) {
            clearTimeout(this.thinkingFlushTimer);
            this.thinkingFlushTimer = null;
        }

        // 重置缓冲区
        if (!immediate) {
            // 如果非立即刷新，安排延迟清空以便继续累积
            this.thinkingFlushTimer = setTimeout(() => {
                this.thinkingFlushTimer = null;
                this.thinkingBuffer = '';
            }, 80);
        } else {
            // 立即清空
            this.thinkingBuffer = '';
        }
    }
}
