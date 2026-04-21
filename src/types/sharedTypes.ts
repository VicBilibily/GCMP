/*---------------------------------------------------------------------------------------------
 *  共享类型定义
 *  支持多提供商的通用类型定义
 *--------------------------------------------------------------------------------------------*/

export interface ModelChatResponseOptions {
    /**
     * 深度思考模式
     * - disabled: 强制关闭深度思考能力，模型不输出思维链内容
     * - enabled: 强制开启深度思考能力，模型强制输出思维链内容
     * - auto: 模型自行判断是否需要进行深度思考
     * - adaptive: 模型根据上下文自适应调整深度思考模式
     */
    readonly thinking?: 'disabled' | 'enabled' | 'auto' | 'adaptive';
    /**
     * 思维链长度调节
     * - none: 关闭思考，直接回答
     * - minimal: 关闭思考，直接回答
     * - low: 轻量思考，侧重快速响应
     * - medium: 均衡模式，兼顾速度与深度
     * - high: 深度分析，处理复杂问题
     * - xhigh: 最大推理深度，速度较慢
     * - max: 绝对最高能力，对 token 消耗没有限制
     */
    readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * 模型配置接口
 */
export interface ModelConfig {
    id: string;
    name: string;
    tooltip: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    version?: string;
    capabilities: {
        toolCalling: boolean;
        imageInput: boolean;
    };
    /**
     * SDK模式选择（可选）
     * - "anthropic": 使用 Anthropic SDK
     * - "openai": 使用 OpenAI SDK（默认）
     * - "openai-sse": 使用 OpenAI SSE 兼容模式（自定义实现流式响应处理）
     * - "openai-responses": 使用 OpenAI Responses API（使用 Responses API 进行请求响应处理）
     * - "gemini-sse": 使用 Gemini HTTP SSE 兼容模式（自定义实现流式响应处理）
     */
    sdkMode?: 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses' | 'gemini-sse';
    /**
     * 模型特定的baseUrl（可选）
     * 如果提供，将覆盖提供商级别的baseUrl
     */
    baseUrl?: string;
    /**
     * 自定义 API 端点路径（可选）
     * 用于替换默认附加到 baseUrl 后的路径（如 /chat/completions、/responses）。
     * - 相对路径（如 /custom/path）：与 baseUrl 拼接使用
     * - 完整 URL（如 https://api.example.com/custom）：直接作为请求地址
     * 仅对 openai、openai-sse、openai-responses 模式生效。
     */
    endpoint?: string;
    /**
     * 模型特定的请求模型名称（可选）
     * 如果提供，将使用此模型名称而不是模型ID发起请求
     */
    model?: string;
    /**
     * 模型的 family 标识（可选）
     * 用于确定模型使用的编辑工具模式
     * 如果未设置，将根据 sdkMode 自动推断默认值：
     * - anthropic → claude-sonnet-4.6
     * - openai/openai-sse: id/model 包含 gpt → gpt-5.2，否则 → claude-sonnet-4.6
     * - openai-responses → gpt-5.2
     * - gemini-sse → gemini-3-pro
     */
    family?: string;
    /**
     * 深度思考模式选项列表（可选）
     * 用于 UI 配置选择，决定用户可选择的思考模式范围：
     * - disabled: 强制关闭深度思考能力，模型不输出思维链内容
     * - enabled: 强制开启深度思考能力，模型强制输出思维链内容
     * - auto: 模型自行判断是否需要进行深度思考
     */
    thinking?: Required<ModelChatResponseOptions>['thinking'][];
    /**
     * 思考模式参数的传递格式（可选）
     * - boolean: 使用布尔值格式 { enable_thinking: true/false }
     * - object: 使用对象格式 { thinking: { type: 'enabled' | 'disabled' } }
     * 默认值为 'boolean'
     */
    thinkingFormat?: 'boolean' | 'object';
    /**
     * 思维链长度调节选项列表（可选）
     * 用于 UI 配置选择，平衡不同场景对效果、时延、成本的需求：
     * - none: 关闭思考，直接回答
     * - minimal: 关闭思考，直接回答
     * - low: 轻量思考，侧重快速响应
     * - medium: 均衡模式，兼顾速度与深度
     * - high: 深度分析，处理复杂问题
     */
    reasoningEffort?: Required<ModelChatResponseOptions>['reasoningEffort'][];
    /**
     * 模型特定的自定义HTTP头部（可选）
     * 如果提供，将在API请求中附加这些自定义头部
     */
    customHeader?: Record<string, string>;
    /**
     * 模型特定的提供商标识符（可选）
     * 用于自定义模型，指定该模型使用的提供商进行API密钥查找
     * 如果提供，Handler将优先从此提供商获取API密钥
     */
    provider?: string;
    /**
     * 额外的请求体参数（可选）
     * 如果提供，将在API请求中合并到请求体中
     */
    extraBody?: Record<string, unknown>;
    /**
     * 是否在 Responses API 中使用 instructions 参数（可选）
     *  - 默认值为 false，表示使用 用户消息 传递 系统消息 指令
     *  - 当设置为 true 时，使用 instructions 参数传递系统指令
     */
    useInstructions?: boolean;
    /**
     * 是否启用 Anthropic 原生 web_search 工具（可选）
     * 仅对 sdkMode=anthropic 的模型生效。
     */
    webSearchTool?: boolean;
}

/**
 * 模型覆盖配置接口 - 用于用户配置覆盖
 */
export interface ModelOverride {
    id: string;
    /** 覆盖显示名称（主要用于新增模型） */
    name?: string;
    /** 覆盖描述（主要用于新增模型） */
    tooltip?: string;
    /** 覆盖模型名称 */
    model?: string;
    /** 覆盖最大输入token数 */
    maxInputTokens?: number;
    /** 覆盖最大输出token数 */
    maxOutputTokens?: number;
    /** 覆盖SDK模式 */
    sdkMode?: ModelConfig['sdkMode'];
    /** 合并capabilities（会与原有capabilities合并） */
    capabilities?: {
        toolCalling?: boolean;
        imageInput?: boolean;
    };
    /** 覆盖baseUrl */
    baseUrl?: string;
    /** 模型的 family 标识（可选） */
    family?: string;
    /** 深度思考模式选项列表（可选） */
    thinking?: ModelConfig['thinking'];
    /** 思考模式参数的传递格式（可选） */
    thinkingFormat?: ModelConfig['thinkingFormat'];
    /** 思维链长度调节选项列表（可选） */
    reasoningEffort?: ModelConfig['reasoningEffort'];
    /**
     * 模型特定的自定义HTTP头部（可选）
     * 如果提供，将在API请求中附加这些自定义头部
     */
    customHeader?: Record<string, string>;
    /**
     * 额外的请求体参数（可选）
     * 如果提供，将在API请求中合并到请求体中
     */
    extraBody?: Record<string, unknown>;
    /** 是否在 Responses API 中使用 instructions 参数（仅 sdkMode=openai-responses 生效） */
    useInstructions?: boolean;
    /** 是否启用 Anthropic 原生 web_search 工具（仅 sdkMode=anthropic 生效） */
    webSearchTool?: boolean;
}

/**
 * 提供商覆盖配置接口 - 用于用户配置覆盖
 */
export interface ProviderOverride {
    /** 覆盖提供商级别的baseUrl */
    baseUrl?: string;
    /** 提供商级别的自定义HTTP头部（可选） */
    customHeader?: Record<string, string>;
    /** 模型覆盖配置列表 */
    models?: ModelOverride[];
}

/**
 * 提供商配置接口
 */
export interface ProviderConfig {
    displayName: string;
    baseUrl: string;
    apiKeyTemplate: string;
    codingKeyTemplate?: string;
    tokenKeyTemplate?: string;
    models: ModelConfig[];
    /**
     * 提供商级别的自定义HTTP头部（可选）
     * 如果提供，将在该提供商的所有API请求中附加这些自定义头部
     * 模型级别的 customHeader 会覆盖提供商级别的同名头部
     */
    customHeader?: Record<string, string>;
}

/**
 * 完整的配置提供者结构
 */
export type ConfigProvider = Record<string, ProviderConfig>;

/**
 * 用户配置覆盖接口 - 来自VS Code设置
 */
export type UserConfigOverrides = Record<string, ProviderOverride>;

/**
 * API密钥验证结果
 */
export interface ApiKeyValidation {
    isValid: boolean;
    error?: string;
    isEmpty?: boolean;
}
