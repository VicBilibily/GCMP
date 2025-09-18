/*---------------------------------------------------------------------------------------------
 *  共享类型定义
 *  支持多供应商的通用类型定义
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 模型配置接口 - 来自package.json
 */
/**
 * 模型配置接口 - 来自package.json
 */
export interface ModelConfig {
    id: string;
    name: string;
    tooltip: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    version: string;
    capabilities: {
        toolCalling: boolean;
        imageInput: boolean;
    };
    /** 是否启用kiloCode支持 */
    kiloCode?: boolean;
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
 * kiloCode请求头配置 - 来自package.json
 */
export type KiloCodeHeaders = Record<string, string>;

/**
 * Kilo Code 扩展版本信息
 */
export interface KiloCodeVersionInfo {
    /** 扩展版本号 */
    version: string;
    /** 显示名称 */
    displayName?: string;
    /** 最后更新时间戳 */
    lastUpdated: number;
    /** 数据来源 */
    source: 'marketplace' | 'fallback';
}

/**
 * 版本缓存配置
 */
export interface VersionCacheConfig {
    /** 缓存过期时间（毫秒），默认24小时 */
    expiration: number;
    /** 缓存键名 */
    cacheKey: string;
}

/**
 * Handler接口定义
 */
export interface ModelHandler {
    readonly provider: string;

    handleRequest(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>,
        token: vscode.CancellationToken
    ): Promise<void>;

    dispose(): void;
}

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
