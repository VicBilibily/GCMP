/*---------------------------------------------------------------------------------------------
 *  共享类型定义
 *  支持多供应商的通用类型定义
 *--------------------------------------------------------------------------------------------*/

/**
 * 模型配置接口 - 来自package.json
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
     */
    sdkMode?: 'anthropic' | 'openai';
    /**
     * 模型特定的baseUrl（可选）
     * 如果提供，将覆盖供应商级别的baseUrl
     */
    baseUrl?: string;
    /**
     * 模型特定的请求模型名称（可选）
     * 如果提供，将使用此模型名称而不是模型ID发起请求
     */
    model?: string;
    /**
     * 模型特定的自定义HTTP头部（可选）
     * 如果提供，将在API请求中附加这些自定义头部
     */
    customHeader?: Record<string, string>;
    /**
     * 模型特定的供应商标识符（可选）
     * 用于自定义模型，指定该模型使用的供应商进行API密钥查找
     * 如果提供，Handler将优先从此供应商获取API密钥
     */
    provider?: string;
    /**
     * 额外的请求体参数（可选）
     * 如果提供，将在API请求中合并到请求体中
     */
    extraBody?: Record<string, unknown>;
}

/**
 * 模型覆盖配置接口 - 用于用户配置覆盖
 */
export interface ModelOverride {
    id: string;
    /** 覆盖模型名称 */
    model?: string;
    /** 覆盖最大输入token数 */
    maxInputTokens?: number;
    /** 覆盖最大输出token数 */
    maxOutputTokens?: number;
    /** 覆盖SDK模式：openai（OpenAI兼容格式）或 anthropic（Anthropic兼容格式） */
    sdkMode?: 'anthropic' | 'openai';
    /** 合并capabilities（会与原有capabilities合并） */
    capabilities?: {
        toolCalling?: boolean;
        imageInput?: boolean;
    };
    /** 覆盖baseUrl */
    baseUrl?: string;
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
}

/**
 * 供应商覆盖配置接口 - 用于用户配置覆盖
 */
export interface ProviderOverride {
    /** 覆盖供应商级别的baseUrl */
    baseUrl?: string;
    /** 模型覆盖配置列表 */
    models?: ModelOverride[];
}

/**
 * 供应商配置接口 - 来自package.json
 */
export interface ProviderConfig {
    displayName: string;
    baseUrl: string;
    apiKeyTemplate: string;
    models: ModelConfig[];
}

/**
 * 完整的配置提供者结构 - 来自package.json
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
