/*---------------------------------------------------------------------------------------------
 *  Ghost Inline Completion - Type Definitions
 *  使用 InlineCompletionItemProvider 实现智能代码补全
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Ghost 配置选项
 */
export interface GhostConfig {
    /** 模型 ID */
    modelId: string;
    /** 是否显示状态栏 */
    showStatusBar: boolean;
}

/**
 * Ghost 补全上下文
 */
export interface GhostContext {
    /** 当前文档 */
    document: vscode.TextDocument;
    /** 光标位置 */
    position: vscode.Position;
    /** 触发方式 */
    triggerKind: vscode.InlineCompletionTriggerKind;
}

/**
 * API 使用信息
 */
export interface ApiUsage {
    /** 输入 tokens */
    inputTokens: number;
    /** 输出 tokens */
    outputTokens: number;
    /** 成本（人民币） */
    cost: number;
}

/**
 * 流式数据块
 */
export interface StreamChunk {
    /** 类型 */
    type: 'text' | 'usage';
    /** 文本内容 */
    text?: string;
    /** 使用信息 */
    usage?: ApiUsage;
}

/**
 * 代码建议
 */
export interface CodeSuggestion {
    /** 建议的代码文本 */
    text: string;
    /** 插入位置 */
    range?: vscode.Range;
}
