/**
 * OpenAI API 相关类型定义
 */

/**
 * 聊天完成请求参数接口
 */
export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    max_tokens?: number;
    stream?: boolean;
    stream_options?: { include_usage: boolean };
    temperature?: number;
    top_p?: number;
    tools?: Tool[];
    tool_choice?: string | ToolChoice;
}

/**
 * 聊天消息接口
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content?: string | ChatMessageContent[] | null;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

/**
 * 聊天消息内容接口（支持多模态）
 */
export interface ChatMessageContent {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
    };
}

/**
 * 工具定义接口
 */
export interface Tool {
    type: 'function' | 'builtin_function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

/**
 * 工具选择接口
 */
export interface ToolChoice {
    type: 'function';
    function: {
        name: string;
    };
}

/**
 * 工具调用接口
 */
export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/**
 * 流式响应数据接口
 */
export interface StreamResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: StreamChoice[];
    usage?: Usage;
}

/**
 * 流式选择接口
 */
export interface StreamChoice {
    index: number;
    delta: {
        content?: string;
        tool_calls?: StreamToolCall[];
    };
    finish_reason?: string | null;
}

/**
 * 流式工具调用接口
 */
export interface StreamToolCall {
    index: number;
    id?: string;
    type?: 'function';
    function?: {
        name?: string;
        arguments?: string;
    };
}

/**
 * Token 使用统计接口
 */
export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/**
 * API 错误响应接口
 */
export interface APIError {
    error: {
        message: string;
        type: string;
        param?: string;
        code?: string;
    };
}

/**
 * HTTP 请求选项接口
 */
export interface RequestOptions {
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeout?: number;
}