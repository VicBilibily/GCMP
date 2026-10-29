import OpenAI from 'openai';
import { Logger } from '../../../utils/runtime/logger';
import type { RequestDiagnostics } from '../../../utils/net/requestDiagnostics';

interface ParsedSSEChoice {
    message?: Record<string, unknown>;
    delta?: Record<string, unknown>;
    finish_reason?: unknown;
    index?: number | null;
}
interface ParsedSSEResponsePayload {
    object?: string;
    output?: unknown[];
}
interface ParsedSSEItemPayload {
    type?: string;
    content?: unknown[];
}
interface ParsedSSEChunk {
    choices?: ParsedSSEChoice[];
    type?: string;
    response?: ParsedSSEResponsePayload;
    item?: ParsedSSEItemPayload;
    output_index?: number | null;
}
function normalizeResponsesOutput(response?: ParsedSSEResponsePayload): boolean {
    if (!response) {
        return false;
    }

    let modified = false;
    if (!Array.isArray(response.output)) {
        response.output = [];
        modified = true;
    }

    for (const outputItem of response.output) {
        if (!outputItem || typeof outputItem !== 'object') {
            continue;
        }

        const item = outputItem as ParsedSSEItemPayload;
        if (item.type === 'message' && !Array.isArray(item.content)) {
            item.content = [];
            modified = true;
        }
    }

    return modified;
}

export class OpenAIResponsePreprocessor {
    constructor(private readonly getDisplayName: () => string) {}

    private get displayName(): string {
        return this.getDisplayName();
    }

    /**
     * 兼容部分网关在 JSON 字符串字面量中直接输出控制字符，导致 OpenAI SDK 的 SSE JSON.parse 提前失败。
     * 仅在字符串上下文中转义 U+0000-U+001F，不改动正常 JSON 结构。
     */
    private escapeControlCharsInJsonString(input: string): { text: string; changed: boolean } {
        let changed = false;
        let inString = false;
        let isEscaped = false;
        let output = '';

        for (const char of input) {
            if (!inString) {
                if (char === '"') {
                    inString = true;
                }
                output += char;
                continue;
            }

            if (isEscaped) {
                output += char;
                isEscaped = false;
                continue;
            }

            if (char === '\\') {
                output += char;
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
                output += char;
                continue;
            }

            const code = char.charCodeAt(0);
            if (code <= 0x1f) {
                changed = true;
                switch (char) {
                    case '\b':
                        output += '\\b';
                        break;
                    case '\f':
                        output += '\\f';
                        break;
                    case '\n':
                        output += '\\n';
                        break;
                    case '\r':
                        output += '\\r';
                        break;
                    case '\t':
                        output += '\\t';
                        break;
                    default:
                        output += `\\u${code.toString(16).padStart(4, '0')}`;
                        break;
                }
                continue;
            }

            output += char;
        }

        return { text: output, changed };
    }

    private createErrorResponse(response: Response, text: string): Response {
        let payload: unknown = text;
        try {
            payload = JSON.parse(text);
        } catch {
            // 非 JSON 错误保留原始文本。
        }

        const record =
            payload && typeof payload === 'object' && !Array.isArray(payload) ?
                (payload as Record<string, unknown>)
            :   {};
        const { error: nestedError, ...outerDetails } = record;
        const nestedDetails =
            nestedError && typeof nestedError === 'object' && !Array.isArray(nestedError) ?
                (nestedError as Record<string, unknown>)
            :   {};
        const message = [
            typeof nestedError === 'string' ? nestedError : undefined,
            nestedDetails.message,
            outerDetails.message,
            typeof payload === 'string' ? payload : undefined,
            text
        ].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        const error = {
            ...outerDetails,
            ...nestedDetails,
            message: message ?? `HTTP ${response.status} ${response.statusText}`
        };
        const init = { status: response.status, statusText: response.statusText, headers: response.headers };
        if (!response.ok) {
            return new Response(JSON.stringify({ error }), init);
        }

        const apiError = OpenAI.APIError.generate(response.status, { error }, undefined, response.headers);
        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(apiError);
                }
            }),
            init
        );
    }

    /**
     * 预处理 SSE 响应，修复非标准格式
     * 修复部分模型输出 "data:" 后不带空格的问题
     */
    async preprocessSSEResponse(response: Response, diagnostics?: RequestDiagnostics): Promise<Response> {
        let contentType = response.headers.get('Content-Type');
        let streamCancelled = false;

        // HTTP 错误交由 SDK 解析，避免被 fetch 异常路径误判为连接超时。
        if (!response.ok && response.status >= 400) {
            return this.createErrorResponse(response, await response.text());
        }

        // 如果返回 application/json，业务错误不能进入 SDK 的 fetch 超时判定。
        if (contentType && contentType.includes('application/json') && response.body) {
            return this.createErrorResponse(response, await response.text());
        }
        if (response?.url?.endsWith('/responses') && !contentType && response.body) {
            // 缺少 Content-Type 时先探测前缀，避免将正常 SSE 整体缓冲。
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const bufferedChunks: Uint8Array[] = [];
            let bufferedLength = 0;
            let sniffedText = '';
            let streamEndedDuringProbe = false;

            const looksLikeSSEPrefix = (text: string): boolean => {
                const trimmed = text.trimStart();
                return /^(data|event|id|retry):|^:/.test(trimmed);
            };

            try {
                while (bufferedLength < 512) {
                    const { done, value } = await reader.read();
                    if (done) {
                        streamEndedDuringProbe = true;
                        break;
                    }
                    if (!value || value.length === 0) {
                        continue;
                    }
                    diagnostics?.data();
                    bufferedChunks.push(value);
                    bufferedLength += value.length;
                    sniffedText += decoder.decode(value, { stream: true });

                    const trimmed = sniffedText.trimStart();
                    if (trimmed.startsWith('{') || looksLikeSSEPrefix(trimmed)) {
                        break;
                    }
                }
                sniffedText += decoder.decode();
            } finally {
                reader.releaseLock();
            }

            const trimmedText = sniffedText.trimStart();
            if (trimmedText.startsWith('{') || trimmedText.startsWith('[')) {
                if (!streamEndedDuringProbe) {
                    const remainingReader = response.body.getReader();
                    try {
                        while (true) {
                            const { done, value } = await remainingReader.read();
                            if (done) {
                                break;
                            }
                            if (!value || value.length === 0) {
                                continue;
                            }
                            diagnostics?.data();
                            bufferedChunks.push(value);
                            sniffedText += decoder.decode(value, { stream: true });
                        }
                        sniffedText += decoder.decode();
                    } finally {
                        remainingReader.releaseLock();
                    }
                }

                return this.createErrorResponse(response, sniffedText);
            }

            const clonedHeaders = new Headers(response.headers);
            if (looksLikeSSEPrefix(trimmedText)) {
                clonedHeaders.set('Content-Type', 'text/event-stream');
                contentType = 'text/event-stream';
            }

            const remainingReader = response.body.getReader();
            const prependBufferedStream = new ReadableStream<Uint8Array>(
                {
                    start(controller) {
                        for (const chunk of bufferedChunks) {
                            controller.enqueue(chunk);
                        }
                    },
                    async pull(controller) {
                        try {
                            while (true) {
                                const { done, value } = await remainingReader.read();
                                if (done) {
                                    remainingReader.releaseLock();
                                    controller.close();
                                    break;
                                }
                                if (value) {
                                    diagnostics?.data();
                                    controller.enqueue(value);
                                    break;
                                }
                            }
                        } catch (error) {
                            if (!streamCancelled) {
                                diagnostics?.error(error, true);
                                controller.error(error);
                            }
                            remainingReader.releaseLock();
                        }
                    },
                    cancel(reason) {
                        streamCancelled = true;
                        void remainingReader.cancel(reason).catch(() => undefined);
                        remainingReader.releaseLock();
                    }
                },
                { highWaterMark: 0 }
            );

            response = new Response(prependBufferedStream, {
                status: response.status,
                statusText: response.statusText,
                headers: clonedHeaders
            });
        }
        if (!contentType || !contentType.includes('text/event-stream') || !response.body) {
            // 只处理 SSE 响应，其他类型直接返回原始 response
            return response;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const displayName = this.displayName;
        const escapeControlCharsInJsonString = this.escapeControlCharsInJsonString.bind(this);
        // 跟踪已见的 content_part.added，用于在缺失时自动注入
        const addedContentParts = new Set<string>();
        const processSSELine = (line: string): string => {
            const trimmedLine = line.trimStart();
            if (
                !trimmedLine.startsWith('data:') &&
                !trimmedLine.startsWith('event:') &&
                !trimmedLine.startsWith('id:') &&
                !trimmedLine.startsWith('retry:') &&
                !trimmedLine.startsWith(':') &&
                (trimmedLine.startsWith('{') || trimmedLine.startsWith('['))
            ) {
                const malformedSSEError = new Error(trimmedLine);
                malformedSSEError.name = 'SSEFatalError';
                throw malformedSSEError;
            }

            const normalizedLine = line.replace(/^data:([^\s])/g, 'data: $1');
            if (!normalizedLine.startsWith('data:')) {
                // 过滤 keepalive 心跳与 codex.rate_limits 的 event 行：后者 data 行会被清空，
                // 残留 event 行会让 SDK 组合出空 data 事件并在 JSON.parse('') 时抛错
                // 上游兼容服务可能发送无空格的紧凑格式（如 "event:keepalive"），用正则容忍任意空白。
                const trimmedEventLine = normalizedLine.trimStart();
                if (
                    /^event:\s*keepalive/.test(trimmedEventLine) ||
                    /^event:\s*codex\.rate_limits/.test(trimmedEventLine)
                ) {
                    return '';
                }
                return normalizedLine;
            }

            const dataMatch = normalizedLine.match(/^data:\s?(.*)$/s);
            if (!dataMatch) {
                return normalizedLine;
            }

            const jsonStr = dataMatch[1];
            if (!jsonStr || jsonStr === '[DONE]') {
                return normalizedLine;
            }

            let candidateJson = jsonStr;
            try {
                let obj: ParsedSSEChunk;
                try {
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                } catch (parseError) {
                    const escaped = escapeControlCharsInJsonString(candidateJson);
                    if (!escaped.changed) {
                        throw parseError;
                    }
                    candidateJson = escaped.text;
                    obj = JSON.parse(candidateJson) as ParsedSSEChunk;
                    Logger.debug(
                        `${displayName} SSE event contained unescaped control characters; auto-fixed and continued parsing`
                    );
                }

                if (obj.type === 'codex.rate_limits') {
                    // rate_limits 是 Codex 的配额状态告知事件，并非"本次请求被拒绝"的信号：
                    // 即使 limit_reached=true / allowed=false，后端仍可能接受并完成当前请求
                    // （紧随其后出现 response.created 即为接受）。仅记录状态后透传，
                    // 真正的拒绝由后续 response.failed 或 HTTP 429 + usage_limit_reached 表达。
                    const rateLimits = (
                        obj as ParsedSSEChunk & {
                            rate_limits?: { allowed?: boolean; limit_reached?: boolean; used_percent?: number };
                        }
                    ).rate_limits;
                    if (rateLimits?.allowed === false || rateLimits?.limit_reached === true) {
                        Logger.warn(
                            `${displayName} received codex.rate_limits (limit_reached=${rateLimits?.limit_reached}, allowed=${rateLimits?.allowed}, used_percent=${rateLimits?.used_percent ?? 'n/a'}); continuing current response`
                        );
                    }
                    return '';
                }

                // 过滤网关 keepalive 心跳事件，避免 SDK ResponseStream 的 _accumulateResponse 在
                // response.created 之前收到 keepalive 时抛出异常
                if (obj.type === 'keepalive') {
                    return '';
                }

                let objModified = false;

                //#region OpenAI Chat Completion 兼容性处理
                if (obj && Array.isArray(obj.choices)) {
                    for (const ch of obj.choices) {
                        if (ch && ch.message && (!ch.delta || Object.keys(ch.delta).length === 0)) {
                            ch.delta = ch.message;
                            delete ch.message;
                            objModified = true;
                        }
                    }
                }

                if (obj.choices && obj.choices.length > 0) {
                    for (let choiceIndex = obj.choices.length - 1; choiceIndex >= 0; choiceIndex--) {
                        const choice = obj.choices[choiceIndex];
                        if (choice?.finish_reason) {
                            if (!choice.delta || Object.keys(choice.delta).length === 0) {
                                Logger.trace(
                                    `preprocessSSEResponse received finish_reason only (choice ${choiceIndex}); added empty content to delta`
                                );
                                choice.delta = { role: 'assistant', content: '' };
                                objModified = true;
                            }
                            if (!choice.delta.role) {
                                choice.delta.role = 'assistant';
                                objModified = true;
                            }
                        }
                        if (choice?.delta && Object.keys(choice.delta).length === 0) {
                            if (choice?.finish_reason) {
                                continue;
                            }
                            Logger.trace(`preprocessSSEResponse removed invalid delta (choice ${choiceIndex})`);
                            obj.choices.splice(choiceIndex, 1);
                            objModified = true;
                        }
                    }

                    if (obj.choices.length === 1) {
                        for (const choice of obj.choices) {
                            if (choice.index == null || choice.index !== 0) {
                                choice.index = 0;
                                objModified = true;
                            }
                        }
                    }
                }
                //#endregion

                //#region OpenAI Response 事件兼容性处理
                if (
                    (obj.type === 'response.created' ||
                        obj.type === 'response.completed' ||
                        obj.type === 'response.failed' ||
                        obj.type === 'response.incomplete') &&
                    obj.response?.object === 'response'
                ) {
                    if (normalizeResponsesOutput(obj.response)) {
                        objModified = true;
                    }
                } else if (
                    (obj.type === 'response.output_item.added' || obj.type === 'response.output_item.done') &&
                    obj.item?.type === 'message' &&
                    !Array.isArray(obj.item.content)
                ) {
                    obj.item.content = [];
                    objModified = true;
                } else if (obj.type === 'response.content_part.added' && obj.output_index == null) {
                    obj.output_index = 0;
                    objModified = true;
                }
                //#endregion

                // #region 注入缺失的 response.content_part.added 事件
                // 某些兼容网关只发送 output_text.delta 而不发送 content_part.added，
                // 导致 OpenAI SDK 的 ResponseStream.#accumulateResponse 找不到 content[index]。
                let injectedContentPart: string | undefined;
                if (obj.type === 'response.content_part.added') {
                    const ev = obj as unknown as Record<string, unknown>;
                    if (ev.item_id != null && ev.content_index != null) {
                        addedContentParts.add(`${ev.item_id}:${ev.content_index}`);
                    }
                } else if (obj.type === 'response.output_text.delta' || obj.type === 'response.reasoning_text.delta') {
                    const ev = obj as unknown as Record<string, unknown>;
                    const key = `${ev.item_id}:${ev.content_index}`;
                    if (!addedContentParts.has(key)) {
                        const isReasoning = obj.type === 'response.reasoning_text.delta';
                        const syntheticEvent: Record<string, unknown> = {
                            type: 'response.content_part.added',
                            item_id: ev.item_id,
                            output_index: ev.output_index,
                            content_index: ev.content_index,
                            part:
                                isReasoning ?
                                    { type: 'reasoning_text', text: '' }
                                :   { type: 'output_text', text: '', annotations: [] },
                            sequence_number: ((ev.sequence_number as number) ?? 0) - 0.5
                        };
                        injectedContentPart = `data: ${JSON.stringify(syntheticEvent)}`;
                        addedContentParts.add(key);
                        Logger.debug(`${displayName} injected missing response.content_part.added for ${key}`);
                    }
                }
                // #endregion

                const resultLine =
                    objModified || candidateJson !== jsonStr || jsonStr.includes('\n') ?
                        `data: ${JSON.stringify(obj)}`
                    :   normalizedLine;

                return injectedContentPart ? `${injectedContentPart}\n\n${resultLine}` : resultLine;
            } catch (parseError) {
                if (parseError instanceof Error && parseError.name === 'SSEFatalError') {
                    throw parseError;
                }
                Logger.trace(`JSON parsing failed: ${parseError}`);
                return normalizedLine;
            }
        };

        const processSSEEvent = (lines: readonly string[]): string => {
            const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
            if (data.length === 0) {
                return lines.join('\n');
            }
            const combinedLine = `data: ${data.join('\n')}`;
            const processed = processSSELine(combinedLine);
            if (!processed) {
                return '';
            }
            if (processed === combinedLine) {
                return lines.map(line => line.replace(/^data:([^\s])/g, 'data: $1')).join('\n');
            }
            let replacedData = false;
            return lines
                .flatMap(line => {
                    if (!line.startsWith('data:')) {
                        return [line];
                    }
                    if (replacedData) {
                        return [];
                    }
                    replacedData = true;
                    return [processed];
                })
                .join('\n');
        };

        // 行缓冲区：用于累积不完整的 SSE 行
        let lineBuffer = '';
        let eventLines: string[] = [];
        let skipLineFeed = false;
        let pendingLines: string[] = [];
        let pendingLineIndex = 0;
        let malformedJsonStreamBuffer = '';
        let isMalformedJsonStream = false;

        const transformedStream = new ReadableStream<Uint8Array>(
            {
                async pull(controller) {
                    try {
                        while (true) {
                            if (pendingLineIndex < pendingLines.length) {
                                while (pendingLineIndex < pendingLines.length) {
                                    const line = pendingLines[pendingLineIndex++];
                                    if (line.length === 0) {
                                        const processed = processSSEEvent(eventLines);
                                        eventLines = [];
                                        if (processed) {
                                            controller.enqueue(encoder.encode(`${processed}\n\n`));
                                            return;
                                        }
                                    } else {
                                        const normalized = line.startsWith('data:') ? line : processSSELine(line);
                                        if (normalized) {
                                            eventLines.push(normalized);
                                        }
                                    }
                                }
                            }

                            const { done, value } = await reader.read();
                            if (done) {
                                if (isMalformedJsonStream) {
                                    throw new Error(malformedJsonStreamBuffer.trim() || lineBuffer.trim());
                                }
                                // 流结束时，处理缓冲区剩余的内容
                                if (lineBuffer.trim().length > 0) {
                                    Logger.trace(
                                        `Stream ended, processing remaining buffered content: ${lineBuffer.length} chars`
                                    );
                                    const normalized =
                                        lineBuffer.startsWith('data:') ? lineBuffer : processSSELine(lineBuffer);
                                    if (normalized) {
                                        eventLines.push(normalized);
                                    }
                                }
                                const remaining = processSSEEvent(eventLines);
                                eventLines = [];
                                if (remaining) {
                                    for (const frame of remaining.split('\n\n')) {
                                        const data = frame
                                            .split('\n')
                                            .filter(line => line.startsWith('data:'))
                                            .map(line => line.slice(5).replace(/^ /, ''))
                                            .join('\n');
                                        if (data && data !== '[DONE]') {
                                            JSON.parse(data);
                                        }
                                    }
                                    controller.enqueue(encoder.encode(`${remaining}\n\n`));
                                }
                                reader.releaseLock();
                                controller.close();
                                return;
                            }

                            if (!value?.length) {
                                continue;
                            }
                            diagnostics?.data();
                            const chunk = decoder.decode(value, { stream: true });

                            if (isMalformedJsonStream) {
                                malformedJsonStreamBuffer += chunk;
                                continue;
                            }

                            // 将新内容追加到缓冲区
                            lineBuffer += chunk;
                            if (!lineBuffer) {
                                continue;
                            }
                            if (skipLineFeed && lineBuffer.startsWith('\n')) {
                                lineBuffer = lineBuffer.slice(1);
                            }
                            skipLineFeed = lineBuffer.endsWith('\r');

                            const trimmedBuffer = lineBuffer.trimStart();
                            if (
                                trimmedBuffer.length > 0 &&
                                !trimmedBuffer.startsWith('data:') &&
                                !trimmedBuffer.startsWith('event:') &&
                                !trimmedBuffer.startsWith('id:') &&
                                !trimmedBuffer.startsWith('retry:') &&
                                !trimmedBuffer.startsWith(':') &&
                                (trimmedBuffer.startsWith('{') || trimmedBuffer.startsWith('['))
                            ) {
                                isMalformedJsonStream = true;
                                malformedJsonStreamBuffer = lineBuffer;
                                lineBuffer = '';
                                continue;
                            }

                            // 按行分割，保留最后一行（可能不完整）
                            pendingLines = lineBuffer.split(/\r\n|\r|\n/);
                            // 保留最后一个元素（可能是不完整的行）
                            const lastLine = pendingLines.pop() || '';
                            lineBuffer = lastLine;
                            pendingLineIndex = 0;
                        }
                    } catch (error) {
                        if (!streamCancelled) {
                            diagnostics?.error(error, true);
                            // 确保错误能够被正确传播
                            controller.error(error);
                        }
                        reader.releaseLock();
                    }
                },
                cancel(reason) {
                    streamCancelled = true;
                    eventLines = [];
                    pendingLines = [];
                    lineBuffer = '';
                    // 当流被取消时，确保释放 reader
                    void reader.cancel(reason).catch(() => undefined);
                    reader.releaseLock();
                }
            },
            { highWaterMark: 0 }
        );

        return new Response(transformedStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }
}
