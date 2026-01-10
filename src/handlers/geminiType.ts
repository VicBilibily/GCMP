/*---------------------------------------------------------------------------------------------
 *  Gemini (Generative Language) HTTP Types
 *  为第三方 Gemini 网关提供类型定义（不依赖 Google SDK）
 *--------------------------------------------------------------------------------------------*/

export type GeminiRole = 'user' | 'model';

export interface GeminiInlineData {
    mimeType: string;
    data: string; // base64
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

    // Thinking/trace fields (gateway-specific)
    thought?: boolean;
    thoughtSignature?: string;

    functionCall?: GeminiFunctionCall;
    functionResponse?: GeminiFunctionResponse;
}

export interface GeminiContent {
    role: GeminiRole;
    parts: GeminiPart[];
}

export interface GeminiSchema {
    // Google style schema: type enum is STRING/NUMBER/INTEGER/BOOLEAN/OBJECT/ARRAY
    type?: string;
    format?: string;
    description?: string;
    nullable?: boolean;

    enum?: unknown[];

    properties?: Record<string, GeminiSchema>;
    required?: string[];
    items?: GeminiSchema;

    // best-effort constraints
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

    // allow gateways to accept extra fields
    [key: string]: unknown;
}

export interface GeminiGenerateContentRequest {
    contents: GeminiContent[];
    systemInstruction?: string | GeminiContent;
    tools?: GeminiTool[];
    generationConfig?: GeminiGenerationConfig;

    // allow gateways to accept extra fields
    [key: string]: unknown;
}

export interface GeminiUsageMetadata {
    promptTokenCount?: number;
    // Different gateways / API versions may use either field name
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

    // some gateways embed error in-stream
    error?: {
        message?: string;
        code?: number | string;
        status?: string;
        [key: string]: unknown;
    };
}

export interface GeminiErrorResponse {
    error: {
        message?: string;
        code?: number;
        status?: string;
        details?: unknown;
        [key: string]: unknown;
    };
}
