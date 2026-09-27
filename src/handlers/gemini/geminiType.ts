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
    id?: string;
    name: string;
    args?: Record<string, unknown>;
}

export interface GeminiFunctionResponsePart {
    inlineData: GeminiInlineData;
}

export interface GeminiFunctionResponse {
    id?: string;
    name: string;
    response: unknown;
    parts?: GeminiFunctionResponsePart[];
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
    parametersJsonSchema?: Record<string, unknown>;
}

export interface GeminiTool {
    functionDeclarations?: GeminiFunctionDeclaration[];
    [key: string]: unknown;
}

export interface GeminiThinkingConfig {
    includeThoughts?: boolean;
    thinkingBudget?: number;
    thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
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
    systemInstruction?: GeminiContent;
    tools?: GeminiTool[];
    toolConfig?: Record<string, unknown>;
    generationConfig?: GeminiGenerationConfig;
    safetySettings?: unknown[];
    cachedContent?: string;
    serviceTier?: 'unspecified' | 'standard' | 'flex' | 'priority' | string;
    store?: boolean;
    [key: string]: unknown;
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    /** Live 风格通常已包含思考 token；GenerateContent 需结合 candidates/thoughts 字段解析。 */
    responseTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
    thoughtsTokenCount?: number;
    serviceTier?: string;
    trafficType?: string;

    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    cacheTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    toolUsePromptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

export interface GeminiSafetyRating {
    category?: string;
    probability?: string;
    blocked?: boolean;
    [key: string]: unknown;
}

export interface GeminiPromptFeedback {
    blockReason?: string;
    blockReasonMessage?: string;
    safetyRatings?: GeminiSafetyRating[];
}

export interface GeminiCandidate {
    index?: number;
    content?: {
        role?: GeminiRole;
        parts?: GeminiPart[];
    };
    finishReason?: string;
    finishMessage?: string;
    safetyRatings?: GeminiSafetyRating[];
}

export interface GeminiGenerateContentResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: GeminiUsageMetadata;
    promptFeedback?: GeminiPromptFeedback;
    responseId?: string;

    // 某些网关在流中嵌入错误
    error?: {
        message?: string;
        code?: number | string;
        status?: number | string;
        statusCode?: number | string;
        [key: string]: unknown;
    };
}
