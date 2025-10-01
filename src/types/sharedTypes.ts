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
 * API密钥验证结果
 */
export interface ApiKeyValidation {
    isValid: boolean;
    error?: string;
    isEmpty?: boolean;
}

/**
 * 扩展VS Code原生LanguageModelChatInformation，添加自定义headers支持
 */
declare module 'vscode' {
    interface LanguageModelChatInformation {
        /** 模型特定的自定义请求头 */
        customHeaders?: Record<string, string>;
    }
}
