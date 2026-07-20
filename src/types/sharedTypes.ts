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
     */
    sdkMode?: 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses';
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
     * - effort-none: 当 reasoningEffort 为 none 时直接传递 { reasoning_effort: 'none' }，忽略思考参数
     * 默认值为 'boolean'
     */
    thinkingFormat?: 'boolean' | 'boolean-none' | 'object' | 'object-none' | 'effort-none';
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
     * 是否启用模型的联网搜索原生工具（可选）
     * - sdkMode=anthropic: 使用 Anthropic web_search_20250305 工具
     * - sdkMode=openai-responses: 使用 Responses API web_search 工具
     * 为 true 时使用默认配置，也可传入详细配置对象。
     */
    webSearchTool?: boolean | WebSearchToolConfig;
    /**
     * 额外原生工具箱（可选）。
     * 补充注入 OpenAI Responses API 内置工具（如 web_extractor）。
     * 重复配置时以 nativeTools 为准；webSearchTool 仍独立保留，两者叠加注入。
     * 仅 sdkMode=openai-responses 生效；anthropic 模式仅取其中的 web_search 项。
     */
    nativeTools?: NativeToolConfig[];
    /**
     * 模型特定的代理服务器地址（可选）
     * 如果提供，将覆盖提供商级别的代理设置
     */
    proxy?: string;
    /**
     * Token 定价，用于客户端成本估算和模型选择器展示。
     * 主价格字段单位为 USD / 百万 token，可通过 rmb 字段同时提供 RMB 辅助定价。
     * 内部计算仍以 USD 为准；UI 可按语言环境显示 USD / RMB / MIXED，rmb 可用于精确 RMB 展示与分币种聚合。
     * pricing 字段支持数组简写（默认 USD）或双币映射 { "USD": [...], "RMB": [...] }。
     *
     * 字段映射到 VS Code LanguageModelChatInformation 的 cost 槽位：
     * - inputPrice     → inputCost（非缓存输入，即 cache miss）
     * - cacheReadPrice → cacheCost（缓存命中读取）
     * - outputPrice    → outputCost
     * - cacheWritePrice → cacheWriteCost（缓存写入定价，各 provider 计费规则不同）
     */
    tokenPricing?: ModelTokenPricing;
}

/**
 * 配置层允许的 Token 定价输入。
 *
 * - 运行时内部统一使用对象形式 `ModelTokenPricing`
 * - 用户配置/自定义模型允许使用数组简写 `[input, output, cacheRead?, cacheWrite?]`
 * - 也允许直接使用顶层双币映射 `{ "USD": [...], "RMB": [...] }`
 * - 对象形式仅保留 `{ pricing, tiers? }` 这一种 canonical 写法
 * - `pricing` 数组本身同时承载 input / output / cacheRead / cacheWrite，不再支持额外的 cache 价格配置字段
 */

/** 定价数组简写形式：[input, output, cacheRead?, cacheWrite?] */
export type PricingArray = [number, number] | [number, number, number] | [number, number, number, number];

/**
 * 双币定价映射 — pricing 字段的扩展形式。
 * 键为币种（"USD" / "RMB"），值为该币种下的定价数组。
 * 至少需要一个币种，两个都提供时支持双币同时定价。
 *
 * 示例：
 * - `{ "USD": [0.14, 0.28, 0.0028] }` — 仅 USD
 * - `{ "RMB": [1, 2, 0.02] }` — 仅 RMB
 * - `{ "USD": [0.14, 0.28, 0.0028], "RMB": [1, 2, 0.02] }` — 双币
 */
export interface DualCurrencyPricingMap {
    USD?: PricingArray;
    RMB?: PricingArray;
}

/** pricing 字段的合法输入：数组简写（默认 USD）或双币映射 */
export type PricingInput = PricingArray | DualCurrencyPricingMap;

/**
 * 共用定价字段 — 被 ModelTokenPricing 和 PricingTier 继承，减少重复定义。
 * 所有主价格字段（inputPrice/outputPrice 等）单位为 USD / 百万 token。
 * 可通过 rmb 字段同时提供 RMB 定价。
 */
export interface PricingFields {
    /** 原始数组输入（保留用于多参数传递检查），仅当配置使用数组简写时存在 */
    pricing?: PricingArray;
    /** 输入 token 单价（cache miss），USD / 百万 token */
    inputPrice: number;
    /** 输出 token 单价，USD / 百万 token */
    outputPrice: number;
    /** 缓存读取 token 单价（cache hit），USD / 百万 token */
    cacheReadPrice?: number;
    /** 缓存写入 token 单价，USD / 百万 token（通常高于 inputPrice） */
    cacheWritePrice?: number;
    /**
     * RMB 定价（可选）。结构与 USD 定价对应，单位为 RMB / 百万 token。
     * 若提供，内部计算仍以 USD 为准；UI 可在支持的场景下使用它做精确 RMB 展示与分币种聚合。
     */
    rmb?: PricingFieldsRmb;
    /**
     * 原生定价币种；仅在配置归一化阶段写入，表示主价格是否由 RMB 派生。
     * 常规显式 USD 配置无需填写，缺省视为 USD。
     */
    nativeCurrency?: 'USD' | 'RMB';
}

/**
 * RMB 定价字段 — 与 USD PricingFields 对应，但不含 rmb 嵌套（避免递归）。
 * 所有价格单位为 RMB / 百万 token。
 */
export interface PricingFieldsRmb {
    /** 输入 token 单价（cache miss），RMB / 百万 token */
    inputPrice: number;
    /** 输出 token 单价，RMB / 百万 token */
    outputPrice: number;
    /** 缓存读取 token 单价（cache hit），RMB / 百万 token */
    cacheReadPrice?: number;
    /** 缓存写入 token 单价，RMB / 百万 token */
    cacheWritePrice?: number;
}

/** tier 匹配条件字段（与价格字段解耦，供完整对象与 pricing 简写共用） */
export interface PricingTierMatchFields {
    /** cron 表达式（5 字段：分 时 日 月 周），定义该档位的生效时段 */
    cron?: string;
    /** 时区，IANA 时区名（如 "Asia/Shanghai"） */
    timezone?: string;
    /** 服务等级匹配条件（如 priority） */
    serviceTier?: string;
    /** 最小输入 token 数阈值；按实际输入 token 数判断 */
    contextSizeMin?: number;
}

/**
 * tier 的 pricing 合法输入：
 * - PricingArray：直接给出该 tier 的 USD 价格
 * - DualCurrencyPricingMap：直接给出该 tier 的 USD/RMB 价格
 * - number：相对顶层静态单档的倍率（同时作用于 USD 与 RMB）
 */
export type PricingTierInputValue = PricingInput | number;

/**
 * tier 对象配置输入：价格统一通过 pricing 定义，匹配条件仍通过 cron / serviceTier / contextSizeMin 等字段表达。
 */
export interface PricingTierShorthandInput extends PricingTierMatchFields {
    /** 定价：数组简写（USD）/ 双币映射 / 顶层倍率 */
    pricing: PricingTierInputValue;
}

export type PricingTierInput = PricingTierShorthandInput;

/**
 * 顶层对象配置输入：仅通过 pricing 字段定义主价格。
 * pricing 支持数组简写（默认 USD）或双币映射 { "USD": [...], "RMB": [...] }。
 */
export interface PricingShorthandInput {
    /** 定价：数组简写 [input, output, cacheRead?, cacheWrite?]（USD）或双币映射 { "USD": [...], "RMB": [...] } */
    pricing: PricingInput;
    /** 峰谷分档定价（可选），允许 tier 使用完整对象或 pricing 简写 */
    tiers?: PricingTierInput[];
}

export type ModelTokenPricingInput = PricingShorthandInput | PricingArray | DualCurrencyPricingMap | ModelTokenPricing;

/**
 * Token 定价信息。
 *
 * 所有价格均为客户端估算用，实际计费以 API 提供商账单为准。
 * 主价格字段（inputPrice/outputPrice 等）单位为 USD / 百万 token。
 * 可通过 rmb 字段同时提供 RMB 定价；内部计算统一以 USD 为准。
 * UI 可按语言环境显示 USD / RMB / MIXED，并在支持的场景下使用精确 RMB 定价。
 *
 * 支持两种定价模式：
 * 1. 静态单档：直接用 `inputPrice`/`outputPrice` 等字段，适用于无峰谷差异的模型。
 *    该档位同时作为 VS Code 模型选择器的展示值（因为 VS Code API 只接受静态数值）。
 * 2. 峰谷分档：配置 `tiers` 后，`calculateCost` 会按请求发生时间匹配生效 tier，
 *    未匹配到任何 tier 时回退到静态单档。静态单档的值建议填"基础档/默认档"，
 *    便于模型选择器展示一个合理的默认价格。
 */
export interface ModelTokenPricing extends PricingFields {
    /** 输入 token 单价（cache miss），USD / 百万 token。同时作为模型选择器展示值与默认回退价 */
    inputPrice: number;
    /** 输出 token 单价，USD / 百万 token。同时作为模型选择器展示值与默认回退价 */
    outputPrice: number;
    /**
     * 峰谷分档定价（可选）。
     * 配置后，`calculateCost` 会按请求发生时间匹配 tier；
     * 未匹配到任何 tier 时回退到上方的静态单档。
     * 数组顺序即匹配优先级，首个匹配成功的 tier 生效。
     */
    tiers?: PricingTier[];
}

/**
 * 峰谷定价的一个时段档位。
 *
 * 通过 cron 表达式定义生效时段，配合时区判断请求是否落入该档。
 * cron 语义采用 5 字段标准格式：分 时 日 月 周（与 unix cron 一致，不含秒）。
 * 注意：cron 是"精确匹配时间点"语义，若要表达一个时段（如工作日 9:00-23:59 峰时），
 * 应使用范围/通配写法，例如 "* 9-23 * * 1-5" 表示工作日 9-23 点每分钟都命中。
 *
 * 可选的 serviceTier 字段用于"按服务等级计费"场景：当该字段非空时，只有用户在 Chat UI
 * 选择了匹配的 serviceTier 才命中此 tier；为空则不限制 serviceTier。这样同一个模型可以
 * 同时配置"峰谷分档"和"服务等级分档"，匹配规则：cron 命中 且（tier 未限定 serviceTier
 * 或 tier.serviceTier === 请求的 serviceTier）。
 *
 * 示例：
 * - "* 9-23 * * 1-5" = 工作日 9:00-23:59 每分钟生效（峰时）
 * - "* 0-23 * * 0,6" = 周末全天每分钟生效（谷时）
 * - "0 9 * * 1-5"   = 仅工作日 9:00 整点命中（通常不是想要的时段表达）
 * - cron="* * * * *", serviceTier="priority" = 仅当用户选了 priority 时生效
 * - contextSizeMin=512001 = 仅当实际消耗的输入 token 数达到 512001 时生效
 */

export interface PricingTier extends PricingFields, PricingTierMatchFields {}

/**
 * 联网搜索原生工具详细配置
 */
export interface WebSearchToolConfig {
    /** 最大搜索次数，默认 5 */
    maxUses?: number;
    /** 域名白名单 */
    allowedDomains?: string[];
    /** 域名黑名单 */
    blockedDomains?: string[];
    /** 用户近似位置 */
    userLocation?: {
        city?: string;
        region?: string;
        country?: string;
        timezone?: string;
    };
}

/**
 * 原生工具类型（OpenAI Responses API 内置工具等）。
 * 常见值：web_search（联网搜索）、web_extractor（网页内容提取）。
 * 不限定枚举，允许任意字符串以兼容未来新增的内置工具。
 */
export type NativeToolType = string;

/**
 * 原生工具配置项。type 为必填，其余字段为已知常用选项，允许传入 provider 特有的额外属性。
 */
export interface NativeToolConfig {
    type: NativeToolType;
    /** 最大搜索次数，默认 5（仅 anthropic 模式生效） */
    maxUses?: number;
    /** 域名白名单（仅 web_search 生效） */
    allowedDomains?: string[];
    /** 域名黑名单（仅 web_search 生效） */
    blockedDomains?: string[];
    /** 用户近似位置（仅 web_search 生效） */
    userLocation?: {
        city?: string;
        region?: string;
        country?: string;
        timezone?: string;
    };
    /** 允许 provider 特有的额外选项透传 */
    [key: string]: unknown;
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
    /** 是否启用模型的联网搜索原生工具（anthropic / openai-responses 均支持）。支持布尔值或详细配置对象（两模式均支持对象配置） */
    webSearchTool?: boolean | WebSearchToolConfig;
    /** 额外原生工具箱。覆盖目标模型的 nativeTools 字段；重复配置时以新值为准。仅 openai-responses 生效，anthropic 仅取 web_search 项 */
    nativeTools?: NativeToolConfig[];
    /** 模型特定的代理服务器地址（可选） */
    proxy?: string;
    /**
     * Token 定价覆盖（USD / 每百万 token），用于客户端成本估算和模型选择器展示。
     * 若提供，将完全替换对应模型的内置定价。
     */
    tokenPricing?: ModelTokenPricingInput;
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
