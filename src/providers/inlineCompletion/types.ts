/*---------------------------------------------------------------------------------------------
 *  内联补全类型定义
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 补全请求上下文
 */
export interface CompletionContext {
    /** 光标前的代码 */
    prefix: string;
    /** 光标后的代码 */
    suffix: string;
    /** 当前行文本 */
    currentLine: string;
    /** 当前行光标前的文本 */
    textBeforeCursor: string;
    /** 当前行光标后的文本 */
    textAfterCursor: string;
    /** 文件导入语句 */
    imports?: string;
    /** 当前作用域（函数/类签名） */
    currentScope?: string;
    /** 文档注释 */
    documentation?: string;
    /** 语言ID */
    languageId: string;
    /** 文档URI */
    documentUri: string;
    /** 光标位置 */
    position: vscode.Position;
}

/**
 * 补全响应
 */
export interface CompletionResponse {
    /** 补全文本 */
    text: string;
    /** 补全范围（可选，用于范围替换） */
    range?: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    /** 光标位置预测（可选） */
    cursorPosition?: {
        line: number;
        column: number;
    };
    /** 绑定ID（用于追踪） */
    bindingId?: string;
}

/**
 * 编辑操作类型
 */
export enum EditOperation {
    Typing = 'typing',
    Paste = 'paste',
    Undo = 'undo',
    Delete = 'delete',
    Unknown = 'unknown'
}

/**
 * 触发检查结果
 */
export interface TriggerCheckResult {
    /** 是否应该触发 */
    shouldTrigger: boolean;
    /** 理由 */
    reason: string;
    /** 防抖时间（毫秒） */
    debounceTime: number;
    /** 置信度（0-1） */
    confidence?: number;
}

/**
 * 补全配置
 */
export interface InlineCompletionConfig {
    /** 是否启用 */
    enabled: boolean;
    /** 提供商ID */
    provider: string;
    /** 模型名称 */
    model: string;
    /** 最大补全长度 */
    maxCompletionLength: number;
    /** 上下文行数 */
    contextLines: number;
    /** 防抖延迟（毫秒） */
    debounceDelay: number;
    /** 温度参数 */
    temperature: number;
    /** 最小请求间隔（毫秒） */
    minRequestInterval: number;
    /** 是否启用智能触发 */
    enableSmartTrigger: boolean;
    /** 是否启用多文件上下文 */
    enableMultiFileContext: boolean;
}

/**
 * 补全提供商接口
 */
export interface ICompletionProvider {
    /**
     * 请求补全
     */
    requestCompletion(context: CompletionContext, config: InlineCompletionConfig, token: vscode.CancellationToken): Promise<CompletionResponse | null>;

    /**
     * 获取提供商ID
     */
    getProviderId(): string;

    /**
     * 获取支持的模型列表
     */
    getSupportedModels(): string[];
}
