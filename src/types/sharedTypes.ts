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
    /**
     * 上下文窗口大小
     * 用于在模型支持的多个上下文窗口档位之间切换。
     */
    readonly contextSize?: number;
    /**
     * 服务等级（service_tier）
     * 用于 Codex 等订阅选择不同的响应速度等级。
     */
    readonly serviceTier?: string;
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
        /**
         * 模型偏好的编辑工具列表（透传到 VS Code LanguageModelChatCapabilities.editTools）
         * 可选值：'find-replace' | 'multi-find-replace' | 'code-rewrite' | 'apply-patch' (其 V4A diff 仅适配 OpenAI 系列)
         * true 时等价于 ["multi-find-replace", "find-replace", "code-rewrite"]
         * 未设置时由 Copilot 走默认学习机制推断
         */
        editTools?: boolean | string[];
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
     * - boolean-none: 仅当 reasoningEffort 为 none 时传递布尔值 { enable_thinking: false }，否则忽略思考参数
     * - object: 使用对象格式 { thinking: { type: 'enabled' | 'disabled' } }
     * - object-none: 仅当 reasoningEffort 为 none 时传递 object 格式，否则忽略思考参数
     * 默认值为 'boolean'
     */
    thinkingFormat?: 'boolean' | 'boolean-none' | 'object' | 'object-none';
    /**
     * reasoning 参数格式（可选）
     * - flat: 使用平铺格式 { reasoning_effort: '...' }（默认行为）
     * - nested: 使用 OpenAI 新版嵌套格式 { reasoning: { effort: '...' } }
     * 默认值为 'flat'。仅对 openai / openai-sse 模式生效。
     */
    reasoningFormat?: 'flat' | 'nested';
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
     * 默认推理强度（可选）
     * 指定时将作为 reasoningEffort 的默认值，优先级高于"medium 优先 / 数组首项"规则。
     * 该值必须包含在 reasoningEffort 数组中（若数组非空）。
     */
    reasoningDefault?: Required<ModelChatResponseOptions>['reasoningEffort'];
    /**
     * 上下文窗口调节选项列表（可选）
     * 用于 UI 配置选择，按顺序决定可选的上下文窗口大小及默认值。
     */
    contextSize?: Required<ModelChatResponseOptions>['contextSize'][];
    /**
     * 服务等级选项列表（可选）
     * 用于 Codex 等订阅选择不同的响应速度等级。
     * 第一个值作为默认值。
     */
    serviceTier?: string[];
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
    /**
     * 模型特定的代理服务器地址（可选）
     * 如果提供，将覆盖提供商级别的代理设置
     */
    proxy?: string;
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
        editTools?: boolean | string[];
    };
    /** 覆盖baseUrl */
    baseUrl?: string;
    /** 模型的 family 标识（可选） */
    family?: string;
    /** 深度思考模式选项列表（可选） */
    thinking?: ModelConfig['thinking'];
    /** 思考模式参数的传递格式（可选） */
    thinkingFormat?: ModelConfig['thinkingFormat'];
    /** reasoning 参数格式（可选） */
    reasoningFormat?: ModelConfig['reasoningFormat'];
    /** 思维链长度调节选项列表（可选） */
    reasoningEffort?: ModelConfig['reasoningEffort'];
    /** 默认推理强度（可选），优先级高于"medium 优先 / 数组首项"规则 */
    reasoningDefault?: ModelConfig['reasoningDefault'];
    /** 上下文窗口调节选项列表（可选） */
    contextSize?: ModelConfig['contextSize'];
    /** 服务等级选项列表（可选） */
    serviceTier?: ModelConfig['serviceTier'];
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
    /** 模型特定的代理服务器地址（可选） */
    proxy?: string;
}

/**
 * 余额/用量查询接口配置
 * 支持自定义查询端点和返回字段解析路径
 */
export interface UsageComputedField {
    /** 简单数值计算方式 */
    operation: 'sum' | 'subtract';
    /** 参与计算的字段路径 */
    paths: string[];
    /** 缺失路径是否按 0 处理（可选） */
    treatMissingAsZero?: boolean;
}

/** 余额字段来源：直接路径或简单计算 */
export type UsageFieldValueSource = string | UsageComputedField;

/** 响应成功条件：从 JSON 路径取值后与 equals 比较 */
export interface UsageSuccessCondition {
    /** JSON 路径 */
    path: string;
    /** 期望值 */
    equals: string | number | boolean | null;
}

export interface ProviderUsageConfig {
    /** 模式显示名称（可选），用于区分不同套餐/余额来源 */
    displayName?: string;
    /** 查询接口 URL */
    url: string;
    /** HTTP 方法，默认 GET */
    method?: 'GET' | 'POST';
    /** 认证方式，默认 bearer */
    authType?: 'bearer' | 'url_key' | 'none';
    /** 额外请求头（可选，会与 provider customHeader 合并） */
    headers?: Record<string, string>;
    /** 额外查询参数（可选） */
    params?: Record<string, string>;
    /** POST 请求体（仅 POST 生效，可选） */
    body?: Record<string, unknown>;
    /** 业务成功条件（可选，全部满足才视为成功） */
    successConditions?: UsageSuccessCondition[];
    /** 业务失败时用于提取错误消息的字段路径（可选） */
    errorMessagePath?: string;
    /** 返回字段解析路径（dot 表示法） */
    fields: UsageFieldPaths;
    /** 余额单位，默认 USD */
    unit?: string;
}

/**
 * usages 条目的增量覆盖配置。
 * 当同时存在 usage 与 usages 时，usages 中的每个条目会基于 usage 进行智能合并。
 */
export interface ProviderUsageOverrideConfig extends Omit<Partial<ProviderUsageConfig>, 'fields'> {
    /** 返回字段解析路径增量覆盖（可选） */
    fields?: Partial<UsageFieldPaths>;
}

/**
 * 自定义 provider 的多模式余额/用量查询配置
 * key 通常用于区分不同套餐、余额池或查询路径
 */
export type ProviderUsagesConfig = Record<string, ProviderUsageOverrideConfig>;

/**
 * 余额查询返回字段解析路径
 * 用 dot 路径从返回 JSON 中提取对应数值
 */
export interface UsageFieldPaths {
    /** 可用余额/剩余额度 */
    balance: UsageFieldValueSource;
    /** 充值/已付余额（可选） */
    paid?: UsageFieldValueSource;
    /** 赠送余额（可选） */
    granted?: UsageFieldValueSource;
}

/**
 * 提供商级别的重试配置覆盖。
 * 所有字段可选，缺省时按字段类型回退：
 * - enabled / maxAttempts：按 provider 级合并规则回退到预置/全局解析结果
 * - initialDelayMs / maxDelayMs：回退到内置默认值（1000ms / 15000ms）
 *
 * 特殊语义：
 * - maxAttempts = -1：无限重试（仅由 isRetryable 错误判断决定退出）
 * - maxAttempts =  0：在用户 override 路径上表示禁止重试；作为 preset 时不会压低全局次数
 * - enabled = false：禁止重试（与 maxAttempts=0 等效）
 *
 * 与全局 `gcmp.retry.maxAttempts` 不同，此处 **不受 1-10 上限约束**，
 * 允许设置为任意正整数或 -1，以应对特殊场景（如自建网关、需要更长退避的提供商）。
 */
export interface ProviderRetryOverride {
    /** 是否启用重试，缺省时按 provider 级合并规则回退到预置/全局解析结果 */
    enabled?: boolean;
    /**
     * 最大重试次数。
     * -1 表示无限重试；0 在 override 路径表示禁止重试，作为 preset 时不会压低全局次数；正整数表示重试次数上限。
     * 与全局设置不同，此处不受 1-10 上限约束。
     */
    maxAttempts?: number;
    /** 初始重试延迟（毫秒），缺省时回退到内置默认 1000ms */
    initialDelayMs?: number;
    /** 最大重试延迟（毫秒），缺省时回退到内置默认 15000ms */
    maxDelayMs?: number;
}

/**
 * 提供商覆盖配置接口 - 用于用户配置覆盖
 */
export interface ProviderOverride {
    /** 覆盖提供商级别的baseUrl */
    baseUrl?: string;
    /** 提供商级别的自定义HTTP头部（可选） */
    customHeader?: Record<string, string>;
    /** 提供商级别的代理服务器地址（可选） */
    proxy?: string;
    /** 模型覆盖配置列表 */
    models?: ModelOverride[];
    /** 自定义提供商默认/单模式余额/用量查询配置（可选） */
    usage?: ProviderUsageConfig;
    /** 自定义提供商多模式余额/用量查询配置（多个模式时使用，可选；可基于 usage 增量覆盖） */
    usages?: ProviderUsagesConfig;
    /**
     * 提供商级别的重试配置覆盖（可选）。
     * 优先级：providerOverrides.{rootOrExact}["retry.{provider}"] → providerOverrides.{rootOrExact}.retry
     *     → configProviders.{rootOrExact}["retry.{provider}"]（预置）→ configProviders.{rootOrExact}.retry → 全局默认。
     * 设置后将覆盖全局重试行为，且 maxAttempts 不受 1-10 上限约束（支持 -1 无限重试）。
     */
    retry?: ProviderRetryOverride;
    /** 子 provider 级别的重试配置覆盖（可选），键名格式：`retry.${subProvider}` */
    [key: `retry.${string}`]: ProviderRetryOverride | undefined;
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
    /**
     * 提供商级别的代理服务器地址（可选）
     * 如果提供，将作用于该提供商的所有API请求
     * 模型级别的 proxy 会覆盖提供商级别的 proxy
     */
    proxy?: string;
    /**
     * 内置预置重试配置（可选）。
     *
     * 作为「全局 gcmp.retry.*」与「用户 providerOverrides.retry」之间的中间层：
     * 优先级：providerOverrides["retry.{subProvider}"] / providerOverrides.retry
     *     → 此处的 `retry.{subProvider}` / `retry` 预置 → 全局默认。
     *
     * 适用于内置 provider 已知需要特殊重试策略的场景
     * （如某些提供商限流退避建议更长、或对 5xx 不敏感需禁用重试）。
     * 字段语义与 ProviderRetryOverride 基本一致；其中预置路径的 `maxAttempts=0` 不会压低全局次数，
     * 若需强制禁用重试应使用 providerOverrides.retry。
     */
    retry?: ProviderRetryOverride;
    /** 内置子 provider 级别的预置重试配置（可选），键名格式：`retry.${subProvider}` */
    [key: `retry.${string}`]: ProviderRetryOverride | undefined;
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
