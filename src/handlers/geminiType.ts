/*---------------------------------------------------------------------------------------------
 *  Gemini (Generative Language) HTTP Types
 *  为第三方 Gemini 网关提供类型定义（不依赖 Google SDK）
 *--------------------------------------------------------------------------------------------*/

export type GeminiRole = 'user' | 'model';

export interface GeminiInlineData {
    mimeType: string;
    data: string; // base64 编码
}

export interface GeminiFileData {
    mimeType: string;
    fileUri: string;
}

export interface GeminiFunctionCall {
    name: string;
    args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
    name: string;
    response: Record<string, unknown>;
}

export interface GeminiPart {
    text?: string;
    inlineData?: GeminiInlineData;
    fileData?: GeminiFileData;

    // 思考/追踪字段
    thought?: boolean;
    thoughtSignature?: string;
    // 部分网关/CLI 使用 snake_case
    thought_signature?: string;

    functionCall?: GeminiFunctionCall;
    functionResponse?: GeminiFunctionResponse;
}

export interface GeminiContent {
    role: GeminiRole;
    parts: GeminiPart[];
}

export interface GeminiSchema {
    // Google 风格的 schema：type 枚举为 STRING/NUMBER/INTEGER/BOOLEAN/OBJECT/ARRAY
    type?: string;
    format?: string;
    description?: string;
    nullable?: boolean;

    enum?: unknown[];

    properties?: Record<string, GeminiSchema>;
    required?: string[];
    items?: GeminiSchema;
    [key: string]: unknown;
}

export interface GeminiFunctionDeclaration {
    name: string;
    description?: string;
    parameters?: GeminiSchema;
}

export interface GeminiTool {
    functionDeclarations: GeminiFunctionDeclaration[];
}

export interface GeminiThinkingConfig {
    includeThoughts?: boolean;
}

export interface GeminiGenerationConfig {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    candidateCount?: number;
    stopSequences?: string[];
    thinkingConfig?: GeminiThinkingConfig;
    [key: string]: unknown;
}

export interface GeminiGenerateContentRequest {
    contents: GeminiContent[];
    systemInstruction?: string | GeminiContent;
    tools?: GeminiTool[];
    generationConfig?: GeminiGenerationConfig;
    [key: string]: unknown;
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    // 不同的网关 / API 版本可能使用任一字段名
    responseTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;

    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    cacheTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

export interface GeminiCandidate {
    index?: number;
    content?: {
        role?: GeminiRole;
        parts?: GeminiPart[];
    };
    finishReason?: string;
}

export interface GeminiGenerateContentResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    responseId?: string;

    // 某些网关在流中嵌入错误
    error?: {
        message?: string;
        code?: number | string;
        status?: string;
        [key: string]: unknown;
    };
}
