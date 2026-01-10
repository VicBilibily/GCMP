/*---------------------------------------------------------------------------------------------
 *  Gemini HTTP Handler
 *  纯 fetch + 自定义流解析（兼容 SSE data: 与 JSON 行流），不依赖 Google SDK
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { Logger } from '../utils/logger';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import type { GenericUsageData, RawUsageData } from '../usages/fileLogger/types';
import { convertMessagesToGemini, convertToolsToGemini } from './geminiConverter';
import type {
    GeminiGenerationConfig,
    GeminiGenerateContentRequest,
    GeminiGenerateContentResponse,
    GeminiPart,
    GeminiTool
} from './geminiType';

export class GeminiHandler {
    constructor(
        public readonly provider: string,
        private readonly providerConfig?: ProviderConfig
    ) {}

    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    /**
     * 规范化 baseUrl：去除首尾空白与末尾 `/`。
     * 用途：避免后续拼接路径时出现 `//` 或空字符串导致的 URL 构建失败。
     */
    private normalizeBaseUrl(baseUrl: string | undefined): string {
        const v = typeof baseUrl === 'string' ? baseUrl.trim() : '';
        return v.endsWith('/') ? v.slice(0, -1) : v;
    }

    /**
     * 构建 Gemini `:streamGenerateContent` SSE endpoint（仅流式路径）。
     *
     * 关键兼容点：
     * - baseUrl 可能是：域名根、带 /v1beta 前缀、甚至完整的 `:generateContent/:streamGenerateContent` 端点。
     * - 流式模式会自动加 `alt=sse`（兼容官方与第三方 Gemini 网关）。
     */
    private buildEndpoint(baseUrl: string, modelId: string, stream: boolean): string {
        const normalized = this.normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return '';
        }

        const method = stream ? 'streamGenerateContent' : 'generateContent';

        try {
            const u0 = new URL(normalized);
            let basePath = (u0.pathname || '').replace(/\/+$/, '') || '/';

            // If configured as a full endpoint, keep it (only switch method based on stream).
            if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
                u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
                if (stream) {
                    u0.searchParams.set('alt', 'sse');
                }
                return u0.toString();
            }

            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }

            // If base already contains a version segment, don't append again.
            if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
                basePath = this.joinPathPrefix(basePath, '/v1beta');
            }

            u0.pathname = this.joinPathPrefix(basePath, `/${modelPath}:${method}`);
            if (stream) {
                u0.searchParams.set('alt', 'sse');
            }
            return u0.toString();
        } catch {
            // Non-URL baseUrl (best-effort fallback)
            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }
            const suffix = stream ? ':streamGenerateContent' : ':generateContent';
            const join = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
            const url = `${join}/v1beta/${modelPath}${suffix}`;
            return stream ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url;
        }
    }

    private joinPathPrefix(basePath: string, nextPath: string): string {
        const a = basePath || '';
        const b = nextPath || '';
        const aTrim = a.endsWith('/') ? a.slice(0, -1) : a;
        const bTrim = b.startsWith('/') ? b : `/${b}`;
        return `${aTrim || ''}${bTrim}`;
    }

    private normalizeGeminiModelPath(modelId: string): string {
        const raw = (modelId || '').trim();
        if (!raw) {
            return 'models/gemini-2.0-flash';
        }

        if (raw.includes('..') || raw.includes('?') || raw.includes('&') || raw.includes('#')) {
            return '';
        }

        // Accept user-provided "models/..." or "tunedModels/..."
        if (/^(models|tunedModels)\//i.test(raw)) {
            return raw;
        }

        // If user accidentally passes a full path like "/v1beta/models/xxx", try to recover the tail.
        const m = raw.match(/\b(models|tunedModels)\/[A-Za-z0-9._-]+/i);
        if (m && typeof m[0] === 'string' && m[0]) {
            return m[0];
        }

        return `models/${raw}`;
    }

    private isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    }

    private async getApiKey(modelConfig?: ModelConfig): Promise<string> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`缺少 ${this.displayName} API密钥`);
        }
        return currentApiKey;
    }

    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        const apiKey = await this.getApiKey(modelConfig);

        // Gemini HTTP 模式强制要求在 modelInfo 指定 baseUrl（第三方网关入口）。
        const baseUrl = modelConfig.baseUrl;

        // 合并提供商级别 & 模型级别 customHeader，并用 ${APIKEY} 替换
        const mergedCustomHeader = {
            ...(this.providerConfig?.customHeader || {}),
            ...(modelConfig.customHeader || {})
        };
        // 默认使用扩展内置存储的 apiKey 注入鉴权头；同时允许用户通过 customHeader 覆盖鉴权方式。
        const processedHeaders = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

        // 用途：将 VS Code 的 messages / tools 转换为 Gemini HTTP API 可接受的结构。
        const { contents, systemInstruction } = convertMessagesToGemini(messages, modelConfig);
        const tools: GeminiTool[] = convertToolsToGemini(options.tools);

        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        const modelId = modelConfig.model || model.id;
        const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
        if (!normalizedBaseUrl) {
            throw new Error('Gemini 模式需要在 modelInfo 中指定 baseUrl');
        }

        // 允许用户通过 extraBody 注入 Gemini 的请求体字段（与 OpenAI/Anthropic 的 extraBody 一致扩展点）
        const extraBody = this.isRecord(modelConfig.extraBody) ? modelConfig.extraBody : undefined;

        const generationConfig: GeminiGenerationConfig = {
            maxOutputTokens: model.maxOutputTokens
        };
        if (modelConfig.outputThinking === true) {
            generationConfig.thinkingConfig = { includeThoughts: true };
        }

        // 用途：组装 Gemini 的请求体（contents / systemInstruction / tools / generationConfig）。
        const requestBody: GeminiGenerateContentRequest = {
            contents,
            ...(systemInstruction ? { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            generationConfig
        };

        if (extraBody) {
            for (const [k, v] of Object.entries(extraBody)) {
                if (v !== undefined) {
                    (requestBody as Record<string, unknown>)[k] = v;
                }
            }
        }

        Logger.info(`🚀 ${model.name} 发送 ${this.displayName} Gemini HTTP 请求 (model=${modelId})`);

        let hasText = false;
        let hasThinking = false;
        let hasToolCall = false;
        let rawUsage: RawUsageData | undefined;

        try {
            // 用途：构建第三方 Gemini 网关可用的流式 SSE endpoint。
            const endpoint = this.buildEndpoint(normalizedBaseUrl, modelId, true);
            if (!endpoint) {
                throw new Error('无法构建 Gemini 请求地址（请检查 baseUrl / model 配置）');
            }

            // 用途：发起 fetch 请求并以 SSE/行流方式读取增量内容（包含 thinking / tool call / usage）。
            const result = await this.processStream(
                model,
                modelConfig,
                endpoint,
                apiKey,
                processedHeaders,
                requestBody,
                progress,
                token,
                v => {
                    rawUsage = v;
                }
            );
            hasText = result.hasText;
            hasThinking = result.hasThinking;
            hasToolCall = result.hasToolCall;

            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    await usagesManager.updateActualTokens({
                        requestId,
                        rawUsage,
                        status: token.isCancellationRequested ? 'failed' : 'completed'
                    });
                } catch (err) {
                    Logger.warn('更新Token统计失败:', err);
                }
            }

            if (hasThinking && !hasText && !hasToolCall) {
                progress.report(new vscode.LanguageModelTextPart('<think/>'));
            }

            Logger.debug(`✅ ${model.name} ${this.displayName} Gemini HTTP 请求完成`);
        } catch (error) {
            Logger.error(`[${model.name}] Gemini HTTP error:`, error);

            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    await usagesManager.updateActualTokens({ requestId, status: 'failed' });
                } catch (err) {
                    Logger.warn('更新Token统计失败:', err);
                }
            }

            throw error;
        } finally {
            cancelSub.dispose();
        }
    }

    /**
     * 发起 Gemini HTTP 请求，并用 read stream 的方式解析 SSE/行流增量输出。
     *
     * 输出内容包含：
     * - 文本：LanguageModelTextPart
     * - thinking：LanguageModelThinkingPart（受 outputThinking 控制）
     * - 工具调用：LanguageModelToolCallPart
     * - usage：原样透传 usageMetadata 供后续统计解析
     */
    private async processStream(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        url: string,
        apiKey: string,
        headers: Record<string, string>,
        requestBody: GeminiGenerateContentRequest,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        onUsage: (usage: RawUsageData) => void
    ): Promise<{ hasText: boolean; hasThinking: boolean; hasToolCall: boolean }> {
        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        // 默认使用扩展内置存储的 apiKey 注入鉴权头（允许 customHeader 覆盖鉴权头）：
        // - 兼容第三方网关：Authorization / X-API-Key / API-Key
        // - 兼容部分 Gemini 网关：X-Goog-Api-Key
        const defaultAuthHeaders: Record<string, string> = {
            Authorization: `Bearer ${apiKey}`,
            'X-API-Key': apiKey,
            'API-Key': apiKey,
            'X-Goog-Api-Key': apiKey
        };

        const finalHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            ...defaultAuthHeaders,
            ...headers
        };

        const requestUrl = url;

        // 用途：执行 fetch（POST JSON body）并挂载取消信号。
        const response = await fetch(requestUrl, {
            method: 'POST',
            headers: finalHeaders,
            body: JSON.stringify(requestBody),
            signal: abortController.signal
        });

        // 用途：非 2xx 直接提取可读错误信息并抛出。
        if (!response.ok) {
            const text = await response.text();
            const message = this.extractErrorMessage(text, response.status, response.statusText);
            throw new Error(message);
        }

        // 用途：SSE/行流响应必须存在 response.body。
        if (!response.body) {
            throw new Error('响应体为空');
        }

        // 用途：读取 Web ReadableStream，逐块 decode 并按行切分。
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        let hasText = false;
        let hasThinking = false;
        let hasToolCall = false;

        let pendingThinkingSignature: string | undefined;

        // 用途：处理一行 SSE/行流。
        // 关键兼容点：
        // - 标准 SSE：`data: {json}` 或 `data: [DONE]`
        // - 类 SSE/网关实现：可能直接输出 JSON 行（不带 data:）
        // - 这里按“行”解析，因此若网关把 JSON 拆成多行，仍可能需要后续增强（目前按现有兼容策略）。
        const processRawLine = (rawLine: string): void => {
            const line = rawLine.trim();
            if (!line) {
                return;
            }

            // 解析 SSE `data:` 前缀（不存在则当作纯 JSON 行）。
            const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!payload) {
                return;
            }
            if (payload === '[DONE]') {
                return;
            }

            // 关键说明：网关可能夹杂非 JSON 行/心跳，解析失败直接忽略。
            const chunk = this.safeJsonParse(payload);
            if (!chunk) {
                return;
            }

            // 关键说明：Gemini stream 的每行 chunk 都是一个（部分字段可选的）GenerateContentResponse。
            const event = chunk as GeminiGenerateContentResponse;
            if (event.error?.message) {
                throw new Error(event.error.message);
            }

            // 用途：把 Gemini 增量 chunk 转为 VS Code 的增量 response parts（文本/思考/tool）。
            const res = this.processGeminiEvent(event, modelConfig, progress, onUsage, pendingThinkingSignature);
            hasText = hasText || res.hasText;
            hasThinking = hasThinking || res.hasThinking;
            hasToolCall = hasToolCall || res.hasToolCall;
            pendingThinkingSignature = res.pendingThinkingSignature;
        };

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                // 按 \n 切分：处理完整行，保留末尾残片到下一轮 chunk。
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const rawLine of lines) {
                    processRawLine(rawLine);
                }
            }

            if (buffer.trim()) {
                processRawLine(buffer);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${model.name}] 用户取消了请求`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            cancelSub.dispose();
            reader.releaseLock();
        }

        return { hasText, hasThinking, hasToolCall };
    }

    /**
     * 处理单个 Gemini stream event（一个 JSON chunk）。
     *
     * 解析流程：
     * 1) candidates[0].content.parts[]：按 part 类型分别输出文本 / thinking / functionCall。
     * 2) thoughtSignature：用于把“思考段”与后续 tool call 关联（VS Code thinking signature）。
     * 3) usageMetadata：原样透传给 usage logger。
     */
    private processGeminiEvent(
        event: GeminiGenerateContentResponse,
        modelConfig: ModelConfig,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        onUsage: (usage: RawUsageData) => void,
        pendingThinkingSignature: string | undefined = undefined
    ): { hasText: boolean; hasThinking: boolean; hasToolCall: boolean; pendingThinkingSignature?: string } {
        let hasText = false;
        let hasThinking = false;
        let hasToolCall = false;

        // 关键说明：流式场景通常只关心第一候选，其他候选（如有）暂不输出。
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        const cand = candidates.length > 0 ? candidates[0] : undefined;
        const parts = Array.isArray(cand?.content?.parts) ? (cand?.content?.parts as GeminiPart[]) : [];

        for (const part of parts) {
            // 解析 thoughtSignature：用于把“即将输出的 thinking”与后续 tool call 关联。
            if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
                pendingThinkingSignature = part.thoughtSignature;
            }

            // 解析 thinking：受 outputThinking 控制是否向 UI 输出。
            if (part.thought === true && typeof part.text === 'string' && part.text) {
                if (modelConfigShouldOutputThinking(modelConfig, true)) {
                    progress.report(new vscode.LanguageModelThinkingPart(part.text));
                }
                hasThinking = true;
                continue;
            }

            // 解析普通文本：直接增量输出。
            if (typeof part.text === 'string' && part.text) {
                progress.report(new vscode.LanguageModelTextPart(part.text));
                hasText = true;
                continue;
            }

            // 解析工具调用：生成一个 ToolCallPart（callId 由扩展生成）。
            if (part.functionCall && typeof part.functionCall.name === 'string' && part.functionCall.name) {
                // 关键说明：如果 tool call 前有 pendingThinkingSignature，需要先 flush 一个空的 thinking part 来“关闭思考块”。
                if (pendingThinkingSignature && modelConfigShouldOutputThinking(modelConfig, true)) {
                    progress.report(
                        new vscode.LanguageModelThinkingPart('', undefined, {
                            signature: pendingThinkingSignature
                        })
                    );
                    pendingThinkingSignature = undefined;
                    hasThinking = true;
                }

                const callId = `tool_call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const args =
                    part.functionCall.args && typeof part.functionCall.args === 'object'
                        ? (part.functionCall.args as Record<string, unknown>)
                        : {};
                progress.report(new vscode.LanguageModelToolCallPart(callId, part.functionCall.name, args));
                hasToolCall = true;
                continue;
            }
        }

        if (event.usageMetadata) {
            // 用途：usage 原样记录。
            // 关键说明：不同 Gemini 网关返回的 usage 字段可能不完全一致，原样保留便于后续统计解析/调试。
            onUsage(event.usageMetadata as GenericUsageData);
        }

        return { hasText, hasThinking, hasToolCall, pendingThinkingSignature };
    }

    /**
     * 安全 JSON 解析：解析失败返回 null（用于忽略心跳/噪声行）。
     */
    private safeJsonParse(text: string): unknown | null {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private extractErrorMessage(bodyText: string, status: number, statusText: string): string {
        let msg = `API请求失败: ${status} ${statusText}`;
        const parsed = this.safeJsonParse(bodyText);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const err = (parsed as { error?: unknown }).error;
            if (err && typeof err === 'object' && 'message' in err) {
                const m = (err as { message?: unknown }).message;
                if (typeof m === 'string' && m.trim()) {
                    msg = m;
                }
            }
        }
        if (!parsed && bodyText.trim()) {
            msg = `${msg} - ${bodyText}`;
        }
        return msg;
    }
}

function modelConfigShouldOutputThinking(modelConfig: ModelConfig, defaultValue: boolean): boolean {
    if (modelConfig.outputThinking === false) {
        return false;
    }
    return defaultValue;
}
