/*---------------------------------------------------------------------------------------------
 *  Gemini API 类型定义（Google Generative Language API）
 *
 *  仅包含 GCMP Gemini 兼容处理器实际使用的字段子集，
 *  结构对齐 https://ai.google.dev/api/generate-content
 *  本文件不依赖 vscode，可在纯 Node 单元测试中直接使用。
 *--------------------------------------------------------------------------------------------*/

/** Gemini 内容角色 */
export type GeminiRole = 'user' | 'model' | 'system';

/** Gemini Part：text / thought / inlineData / functionCall / functionResponse */
export interface GeminiPart {
    text?: string;
    /** thought: true 表示该 text 是思维链内容 */
    thought?: boolean;
    /** 思维链签名（多轮回传思考内容时随 part 携带） */
    thoughtSignature?: string;
    inlineData?: {
        mimeType: string;
        data: string; // base64
    };
    functionCall?: {
        name: string;
        args?: Record<string, unknown>;
        /** 可选。调用的唯一 id；若存在，functionResponse.id 必须与之匹配 */
        id?: string;
    };
    functionResponse?: {
        name: string;
        /** 可选。对应 functionCall 的 id（多调用/同名调用时区分结果归属） */
        id?: string;
        response: {
            name: string;
            content: unknown;
        };
    };
}

export interface GeminiContent {
    role?: GeminiRole;
    parts?: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
}

export interface GeminiTool {
    functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiThinkingConfig {
    thinkingBudget?: number;
    includeThoughts?: boolean;
}

export interface GeminiGenerationConfig {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    thinkingConfig?: GeminiThinkingConfig;
    [key: string]: unknown;
}

/** GenerateContent 请求体 */
export interface GeminiGenerateContentRequest {
    contents: GeminiContent[];
    systemInstruction?: GeminiContent;
    tools?: GeminiTool[];
    toolConfig?: Record<string, unknown>;
    generationConfig?: GeminiGenerationConfig;
    safetySettings?: { category: string; threshold: string }[];
    [key: string]: unknown;
}

/** GenerateContent 响应中的 usageMetadata */
export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
}

export interface GeminiCandidate {
    content?: GeminiContent;
    finishReason?: string;
    index?: number;
}

/** GenerateContent 响应 / 流式 chunk（结构相同） */
export interface GeminiGenerateContentResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    modelVersion?: string;
    responseId?: string;
    error?: {
        code?: number | string;
        message?: string;
        status?: string;
    };
}

/**
 * 归一化后的 usage（对齐 OpenAI CompletionUsage 形状），
 * 便于复用 calculateCostWithBreakdown / TokenUsagesManager 等现有链路。
 */
export interface GeminiNormalizedUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
