/*---------------------------------------------------------------------------------------------
 *  共享类型定义
 *  支持多供应商的通用类型定义
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 供应商配置接口
 */
export interface ProviderConfig {
    name: string;
    displayName: string;
    apiKeyTemplate: string;
    baseUrl: string;
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
