/*---------------------------------------------------------------------------------------------
 *  共享类型定义
 *  支持多供应商的通用类型定义
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 模型配置接口 - 来自package.json
 */
/**
 * 自动模型配置
 */
export interface AutoModelConfig {
    /** 默认模型（纯文本时使用） */
    default: string;
    /** 视觉模型（包含多模态数据时使用） */
    vision: string;
}

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
    /** 自动模式配置 - 当模型为自动模式时，根据内容自动选择目标模型 */
    autoModel?: AutoModelConfig;
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
