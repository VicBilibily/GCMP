import type { ModelChatResponseOptions, ModelConfig } from '../types/sharedTypes';
import type {
    GeminiGenerateContentRequest,
    GeminiGenerationConfig,
    GeminiThinkingConfig,
    GeminiTool
} from './geminiType';

const protectedRequestFields = new Set(['contents', 'tools', 'systemInstruction', 'generationConfig', 'serviceTier']);
const unsafeObjectKeys = new Set(['__proto__', 'constructor', 'prototype']);

function mergePlainObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (unsafeObjectKeys.has(key)) {
            continue;
        }
        const current = merged[key];
        if (
            current &&
            value &&
            typeof current === 'object' &&
            typeof value === 'object' &&
            !Array.isArray(current) &&
            !Array.isArray(value)
        ) {
            merged[key] = mergePlainObjects(current as Record<string, unknown>, value as Record<string, unknown>);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function getThinkingLevel(
    settings: Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort'> | undefined
): GeminiThinkingConfig['thinkingLevel'] | undefined {
    if (settings?.thinking === 'disabled') {
        return 'MINIMAL';
    }
    if (!settings?.thinking && !settings?.reasoningEffort) {
        return undefined;
    }

    switch (settings.reasoningEffort) {
        case 'none':
        case 'minimal':
            return 'MINIMAL';
        case 'low':
            return 'LOW';
        case 'medium':
            return 'MEDIUM';
        case 'high':
        case 'xhigh':
        case 'max':
            return 'HIGH';
        default:
            return undefined;
    }
}

function getGeminiModelName(modelConfig: ModelConfig): string {
    return (modelConfig.model || modelConfig.id).replace(/^models\//i, '').toLowerCase();
}

type GeminiThinkingLevel = NonNullable<GeminiThinkingConfig['thinkingLevel']>;

const allGeminiThinkingLevels: readonly GeminiThinkingLevel[] = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

/** 未识别模型不下发 thinkingLevel，避免代理或旧模型拒绝未知字段。 */
function getSupportedThinkingLevels(model: string): readonly GeminiThinkingLevel[] | undefined {
    if (/^gemini-3\.1-flash-lite-image(?:[.-]|$)/.test(model)) {
        return ['MINIMAL', 'HIGH'];
    }
    if (/^gemini-3\.1-flash-lite(?:[.-]|$)/.test(model)) {
        return allGeminiThinkingLevels;
    }
    if (/^gemini-3-pro(?:[.-]|$)/.test(model)) {
        return ['LOW', 'HIGH'];
    }
    if (/^gemini-3\.1-pro(?:[.-]|$)/.test(model)) {
        return ['LOW', 'MEDIUM', 'HIGH'];
    }
    if (/^gemini-3\.[78]-flash(?:[.-]|$)/.test(model)) {
        return ['LOW', 'MEDIUM', 'HIGH'];
    }
    if (/^gemini-3(?:-flash|\.5-flash|\.6-flash)(?:[.-]|$)/.test(model)) {
        return allGeminiThinkingLevels;
    }
    return undefined;
}

function getSupportedThinkingLevel(
    requested: GeminiThinkingLevel | undefined,
    supported: readonly GeminiThinkingLevel[] | undefined
): GeminiThinkingLevel | undefined {
    return requested && supported?.includes(requested) ? requested : undefined;
}

/** reasoningEffort 在 Gemini 3 映射为等级，在 Gemini 2.5 映射为 token budget。 */
function buildThinkingConfig(
    modelConfig: ModelConfig,
    settings: Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort'> | undefined
): GeminiThinkingConfig | undefined {
    if (!settings?.thinking && !settings?.reasoningEffort) {
        return undefined;
    }

    const model = getGeminiModelName(modelConfig);
    const hideThoughts =
        settings.thinking === 'disabled' ||
        settings.reasoningEffort === 'none' ||
        settings.reasoningEffort === 'minimal';

    if (/^gemini-3(?:[.-]|$)/.test(model)) {
        const thinkingLevel = getSupportedThinkingLevel(getThinkingLevel(settings), getSupportedThinkingLevels(model));
        return {
            includeThoughts: !hideThoughts,
            ...(thinkingLevel ? { thinkingLevel } : {})
        };
    }

    if (/^gemini-2\.5-pro(?:[.-]|$)/.test(model)) {
        const requestedBudget = settings.thinking === 'disabled' ? 0 : getThinkingBudget(settings.reasoningEffort);
        return {
            includeThoughts: !hideThoughts,
            ...(requestedBudget !== undefined ? { thinkingBudget: Math.max(128, requestedBudget) } : {})
        };
    }

    if (/^gemini-2\.5-(?:flash|flash-lite)(?:[.-]|$)/.test(model)) {
        const thinkingBudget = settings.thinking === 'disabled' ? 0 : getThinkingBudget(settings.reasoningEffort);
        return {
            includeThoughts: !hideThoughts,
            ...(thinkingBudget !== undefined ? { thinkingBudget } : {})
        };
    }

    return undefined;
}

function getThinkingBudget(reasoningEffort: ModelChatResponseOptions['reasoningEffort']): number | undefined {
    switch (reasoningEffort) {
        case 'none':
        case 'minimal':
            return 0;
        case 'low':
            return 1024;
        case 'medium':
            return 8192;
        case 'high':
        case 'xhigh':
        case 'max':
            return 24576;
        default:
            return undefined;
    }
}

export function buildGeminiEndpoint(baseUrl: string, model: string): string {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const rawModel = model.trim();
    if (
        !normalizedBaseUrl ||
        !rawModel ||
        (!/^[A-Za-z0-9._-]+$/.test(rawModel) && !/^(models|tunedModels)\/[A-Za-z0-9._-]+$/i.test(rawModel))
    ) {
        return '';
    }
    const modelPath = /^(models|tunedModels)\//i.test(rawModel) ? rawModel : `models/${rawModel}`;
    if (normalizedBaseUrl.includes('{model}')) {
        const expanded = normalizedBaseUrl.replace('{model}', modelPath);
        try {
            const url = new URL(expanded);
            url.searchParams.set('alt', 'sse');
            return url.toString();
        } catch {
            return `${expanded}${expanded.includes('?') ? '&' : '?'}alt=sse`;
        }
    }

    try {
        const url = new URL(normalizedBaseUrl);
        let path = url.pathname.replace(/\/+$/, '');
        if (/:(streamGenerateContent|generateContent)$/i.test(path)) {
            url.pathname = path.replace(/:(streamGenerateContent|generateContent)$/i, ':streamGenerateContent');
        } else {
            if (!/\/v1beta$/i.test(path) && !/\/v1beta\//i.test(`${path}/`)) {
                path = `${path}/v1beta`;
            }
            url.pathname = `${path}/${modelPath}:streamGenerateContent`.replace(/\/{2,}/g, '/');
        }
        url.searchParams.set('alt', 'sse');
        return url.toString();
    } catch {
        const versionedBase =
            /\/v1beta(?:\/|$)/i.test(normalizedBaseUrl) ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
        return `${versionedBase}/${modelPath}:streamGenerateContent?alt=sse`;
    }
}

/** Google 原生端点使用 x-goog-api-key，兼容网关统一使用 Bearer。 */
export function buildGeminiAuthHeaders(baseUrl: string, apiKey: string): Record<string, string> {
    try {
        const hostname = new URL(baseUrl).hostname.toLowerCase();
        if (
            hostname === 'generativelanguage.googleapis.com' ||
            hostname.endsWith('.generativelanguage.googleapis.com')
        ) {
            return { 'x-goog-api-key': apiKey };
        }
    } catch {
        // 非法 URL 会在 endpoint 构建阶段被拒绝。
    }
    return { Authorization: `Bearer ${apiKey}` };
}

/** toolMode=required 会转换为 Gemini functionCallingConfig.mode=ANY。 */
export function buildGeminiRequest(
    baseRequest: Pick<GeminiGenerateContentRequest, 'contents' | 'systemInstruction'>,
    modelConfig: ModelConfig,
    settings?: Pick<ModelChatResponseOptions, 'thinking' | 'reasoningEffort' | 'serviceTier'>,
    maxOutputTokens?: number,
    tools?: GeminiTool[],
    toolMode?: 'auto' | 'required'
): GeminiGenerateContentRequest {
    const generationConfig: GeminiGenerationConfig = {};
    if (typeof maxOutputTokens === 'number') {
        generationConfig.maxOutputTokens = maxOutputTokens;
    }

    const request: GeminiGenerateContentRequest = {
        ...baseRequest,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
    };

    const extraBody = modelConfig.extraBody;
    if (extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody)) {
        for (const [key, value] of Object.entries(extraBody)) {
            if (!protectedRequestFields.has(key) && !unsafeObjectKeys.has(key)) {
                request[key] = value;
            }
        }

        const extraGenerationConfig = extraBody.generationConfig;
        if (
            extraGenerationConfig &&
            typeof extraGenerationConfig === 'object' &&
            !Array.isArray(extraGenerationConfig)
        ) {
            request.generationConfig = mergePlainObjects(
                request.generationConfig ?? {},
                extraGenerationConfig as Record<string, unknown>
            ) as GeminiGenerationConfig;
        }
    }

    const thinkingConfig = buildThinkingConfig(modelConfig, settings);
    if (thinkingConfig) {
        request.generationConfig = {
            ...(request.generationConfig ?? {}),
            thinkingConfig
        };
    }

    if (settings?.serviceTier && modelConfig.serviceTier?.includes(settings.serviceTier)) {
        request.serviceTier = settings.serviceTier;
    }

    if (toolMode === 'required' && tools && tools.length > 0) {
        const allowedFunctionNames = tools
            .flatMap(tool => tool.functionDeclarations ?? [])
            .map(declaration => declaration.name)
            .filter(name => typeof name === 'string' && name.length > 0);
        const existingToolConfig =
            request.toolConfig && typeof request.toolConfig === 'object' && !Array.isArray(request.toolConfig) ?
                request.toolConfig
            :   {};
        const existingFunctionCallingConfig =
            (
                existingToolConfig.functionCallingConfig &&
                typeof existingToolConfig.functionCallingConfig === 'object' &&
                !Array.isArray(existingToolConfig.functionCallingConfig)
            ) ?
                (existingToolConfig.functionCallingConfig as Record<string, unknown>)
            :   {};
        request.toolConfig = {
            ...existingToolConfig,
            functionCallingConfig: {
                ...existingFunctionCallingConfig,
                mode: 'ANY',
                ...(allowedFunctionNames.length > 0 ? { allowedFunctionNames } : {})
            }
        };
    }

    return request;
}

export interface GeminiStreamPayload {
    data: string;
    isSse: boolean;
}

/** 增量解析 SSE、JSON Lines、完整 JSON 或数组，并在 EOF 刷出残留。 */
export class GeminiStreamParser {
    private buffer = '';
    private readonly dataLines: string[] = [];
    private mode: 'unknown' | 'sse' | 'json' = 'unknown';

    push(text: string): GeminiStreamPayload[] {
        this.buffer += text;
        if (!this.detectMode(false)) {
            return [];
        }
        return this.mode === 'sse' ? this.drainSse(false) : this.drainJson(false);
    }

    finish(): GeminiStreamPayload[] {
        if (!this.detectMode(true)) {
            this.buffer = '';
            return [];
        }
        return this.mode === 'sse' ? this.drainSse(true) : this.drainJson(true);
    }

    private detectMode(atEof: boolean): boolean {
        if (this.mode !== 'unknown') {
            return true;
        }
        const trimmed = this.buffer.trimStart();
        if (!trimmed) {
            return false;
        }
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            this.mode = 'json';
            return true;
        }
        const lines = this.buffer.split('\n');
        const completeLineCount = atEof ? lines.length : lines.length - 1;
        for (let index = 0; index < completeLineCount; index++) {
            const line = lines[index].replace(/\r$/, '').trimStart();
            if (!line) {
                continue;
            }
            if (line.startsWith('{') || line.startsWith('[')) {
                this.mode = 'json';
                return true;
            }
            if (line.startsWith(':') || /^(?:data|event|id|retry)(?::|$)/.test(line)) {
                this.mode = 'sse';
                return true;
            }
        }
        if (atEof) {
            this.mode = 'json';
            return true;
        }
        return false;
    }

    private drainSse(atEof: boolean): GeminiStreamPayload[] {
        const payloads: GeminiStreamPayload[] = [];
        let lineBreakIndex: number;
        while ((lineBreakIndex = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, lineBreakIndex).replace(/\r$/, '');
            this.buffer = this.buffer.slice(lineBreakIndex + 1);
            this.processSseLine(line, payloads);
        }
        if (atEof && this.buffer.length > 0) {
            this.processSseLine(this.buffer.replace(/\r$/, ''), payloads);
            this.buffer = '';
        }
        if (atEof) {
            this.flushSseEvent(payloads);
        }
        return payloads;
    }

    private processSseLine(line: string, payloads: GeminiStreamPayload[]): void {
        line = line.replace(/^\uFEFF/, '');
        if (line === '') {
            this.flushSseEvent(payloads);
            return;
        }
        if (line.startsWith(':')) {
            return;
        }

        const separator = line.indexOf(':');
        const field = separator >= 0 ? line.slice(0, separator) : line;
        if (field === 'data' || field === 'event' || field === 'id' || field === 'retry') {
            if (field === 'data') {
                const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
                this.dataLines.push(value);
            }
            return;
        }

        const trimmed = line.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            payloads.push({ data: trimmed, isSse: false });
        }
    }

    private drainJson(atEof: boolean): GeminiStreamPayload[] {
        const payloads: GeminiStreamPayload[] = [];
        let cursor = 0;

        while (cursor < this.buffer.length) {
            while (cursor < this.buffer.length && /\s/.test(this.buffer[cursor])) {
                cursor++;
            }
            if (cursor >= this.buffer.length) {
                this.buffer = '';
                return payloads;
            }

            const start = cursor;
            const opening = this.buffer[cursor];
            if (opening !== '{' && opening !== '[') {
                const lineBreakIndex = this.buffer.indexOf('\n', cursor);
                if (lineBreakIndex < 0 && !atEof) {
                    this.buffer = this.buffer.slice(start);
                    return payloads;
                }
                const end = lineBreakIndex >= 0 ? lineBreakIndex : this.buffer.length;
                const data = this.buffer.slice(start, end).trim();
                if (data) {
                    payloads.push({ data, isSse: false });
                }
                cursor = lineBreakIndex >= 0 ? lineBreakIndex + 1 : this.buffer.length;
                continue;
            }

            let depth = 0;
            let inString = false;
            let escaped = false;
            let completed = false;
            for (; cursor < this.buffer.length; cursor++) {
                const char = this.buffer[cursor];
                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (char === '\\') {
                        escaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }
                if (char === '"') {
                    inString = true;
                } else if (char === '{' || char === '[') {
                    depth++;
                } else if (char === '}' || char === ']') {
                    depth--;
                    if (depth === 0) {
                        payloads.push({ data: this.buffer.slice(start, cursor + 1), isSse: false });
                        cursor++;
                        completed = true;
                        break;
                    }
                }
            }

            if (!completed) {
                if (atEof) {
                    const data = this.buffer.slice(start).trim();
                    if (data) {
                        payloads.push({ data, isSse: false });
                    }
                    this.buffer = '';
                } else {
                    this.buffer = this.buffer.slice(start);
                }
                return payloads;
            }
        }

        this.buffer = '';
        return payloads;
    }

    private flushSseEvent(payloads: GeminiStreamPayload[]): void {
        if (this.dataLines.length > 0) {
            payloads.push({ data: this.dataLines.join('\n'), isSse: true });
        }
        this.dataLines.length = 0;
    }
}
