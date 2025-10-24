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
     * 模型特定的baseUrl（可选）
     * 如果提供，将覆盖供应商级别的baseUrl
     */
    baseUrl?: string;
    /**
     * 模型特定的请求模型名称（可选）
     * 如果提供，将使用此模型名称而不是模型ID发起请求
     */
    model?: string;
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
    /** 合并capabilities（会与原有capabilities合并） */
    capabilities?: {
        toolCalling?: boolean;
        imageInput?: boolean;
    };
    /** 覆盖baseUrl */
    baseUrl?: string;
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
