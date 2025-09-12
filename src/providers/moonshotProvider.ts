import * as vscode from 'vscode';
import { BaseModelProvider } from './baseProvider';
import { ProviderConfig } from '../types/sharedTypes';

/**
 * 月之暗面供应商配置
 */
const MOONSHOT_PROVIDER_CONFIG: ProviderConfig = {
    name: 'moonshot',
    displayName: 'MoonshotAI',
    apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    baseUrl: 'https://api.moonshot.cn/v1'
};

/**
 * 月之暗面模型定义
 * 基于月之暗面官方API模型配置，专注于K2系列模型
 */
const MOONSHOT_MODELS: vscode.LanguageModelChatInformation[] = [
    // Kimi-K2-0905-Preview - 最新版本，具备更强的Agentic Coding能力
    {
        id: 'kimi-k2-0905-preview',
        name: 'Kimi-K2-0905-Preview',
        tooltip: '月之暗面 Kimi-K2-0905-Preview - 更强的Agentic Coding能力，更突出的前端代码美观度和实用性，256K上下文',
        family: 'kimi-k2',
        maxInputTokens: 256000,
        maxOutputTokens: 8192,
        version: 'kimi-k2-0905-preview',
        capabilities: {
            toolCalling: true,
            imageInput: false
        }
    },
    // Kimi-K2-Turbo-Preview - 高速版本，输出速度每秒60-100 tokens
    {
        id: 'kimi-k2-turbo-preview',
        name: 'Kimi-K2-Turbo-Preview',
        tooltip: '月之暗面 Kimi-K2-Turbo-Preview - 高速版本模型，输出速度60-100 tokens/秒，256K上下文',
        family: 'kimi-k2',
        maxInputTokens: 256000,
        maxOutputTokens: 8192,
        version: 'kimi-k2-turbo-preview',
        capabilities: {
            toolCalling: true,
            imageInput: false
        }
    },
    // Kimi-K2-0711-Preview - 基础版本
    {
        id: 'kimi-k2-0711-preview',
        name: 'Kimi-K2-0711-Preview',
        tooltip: '月之暗面 Kimi-K2-0711-Preview - K2系列基础版本，128K上下文',
        family: 'kimi-k2',
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        version: 'kimi-k2-0711-preview',
        capabilities: {
            toolCalling: true,
            imageInput: false
        }
    }
];

/**
 * 月之暗面模型供应商类
 * 继承BaseModelProvider，提供月之暗面特定的实现
 */
export class MoonshotChatModelProvider extends BaseModelProvider {
    static providerConfig = MOONSHOT_PROVIDER_CONFIG;
    static models = MOONSHOT_MODELS;

    constructor() {
        super();
    }
}
