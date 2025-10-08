/*---------------------------------------------------------------------------------------------
 *  智能触发检测器
 *  参考 Cometix-Tab 的智能编辑检测系统
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EditOperation, TriggerCheckResult } from './types';
import { Logger } from '../../utils';

/**
 * 智能触发检测器
 * 分析用户编辑模式，动态调整触发策略
 */
export class SmartTriggerDetector {
    private static instance: SmartTriggerDetector;
    private documentStates = new Map<string, {
        lastEdit: number;
        lastOperation: EditOperation;
        editCount: number;
        completionCount: number;
        acceptCount: number;
    }>();

    private constructor() { }

    static getInstance(): SmartTriggerDetector {
        if (!SmartTriggerDetector.instance) {
            SmartTriggerDetector.instance = new SmartTriggerDetector();
        }
        return SmartTriggerDetector.instance;
    }

    /**
     * 检测当前编辑操作类型
     */
    detectEditOperation(
        document: vscode.TextDocument,
        changes: readonly vscode.TextDocumentContentChangeEvent[]
    ): EditOperation {
        if (changes.length === 0) {
            return EditOperation.Unknown;
        }

        const change = changes[0];
        const text = change.text;
        const rangeLength = change.rangeLength;

        // 粘贴操作：大量文本插入
        if (text.length > 50 || text.includes('\n')) {
            return EditOperation.Paste;
        }

        // 删除操作
        if (rangeLength > 0 && text.length === 0) {
            return EditOperation.Delete;
        }

        // 撤销操作（通过检测大范围变化）
        if (rangeLength > 10 && text.length > 10) {
            return EditOperation.Undo;
        }

        // 正常输入
        return EditOperation.Typing;
    }

    /**
     * 判断是否应该触发补全
     */
    shouldTriggerCompletion(
        document: vscode.TextDocument,
        position: vscode.Position
    ): TriggerCheckResult {
        const uri = document.uri.toString();
        const state = this.documentStates.get(uri) || {
            lastEdit: 0,
            lastOperation: EditOperation.Unknown,
            editCount: 0,
            completionCount: 0,
            acceptCount: 0
        };

        const now = Date.now();

        // 基础检查
        const currentLine = document.lineAt(position.line);
        const textBeforeCursor = currentLine.text.substring(0, position.character);
        const textAfterCursor = currentLine.text.substring(position.character);

        // 1. 检查是否在字符串或注释中
        if (this.isInStringOrComment(textBeforeCursor)) {
            return {
                shouldTrigger: false,
                reason: '在字符串或注释中',
                debounceTime: 300
            };
        }

        // 2. 检查是否为有意义的补全位置
        if (!this.isMeaningfulPosition(textBeforeCursor, textAfterCursor)) {
            return {
                shouldTrigger: false,
                reason: '不是有意义的补全位置',
                debounceTime: 300
            };
        }

        // 3. 根据最近的操作类型调整防抖时间
        let debounceTime = 150; // 默认防抖时间
        let confidence = 0.5;

        switch (state.lastOperation) {
            case EditOperation.Typing:
                // 正常输入：短防抖，高置信度
                debounceTime = 100;
                confidence = 0.8;
                break;

            case EditOperation.Paste:
                // 粘贴后：较长防抖，低置信度
                debounceTime = 500;
                confidence = 0.3;
                break;

            case EditOperation.Delete:
                // 删除后：较长防抖，低置信度
                debounceTime = 300;
                confidence = 0.4;
                break;

            case EditOperation.Undo:
                // 撤销后：很长防抖，很低置信度
                debounceTime = 800;
                confidence = 0.2;
                break;

            default:
                debounceTime = 200;
                confidence = 0.5;
        }

        // 4. 根据接受率动态调整
        if (state.completionCount > 5) {
            const acceptRate = state.acceptCount / state.completionCount;
            if (acceptRate > 0.7) {
                // 高接受率：更激进
                debounceTime = Math.max(50, debounceTime * 0.7);
                confidence = Math.min(1.0, confidence * 1.2);
            } else if (acceptRate < 0.3) {
                // 低接受率：更保守
                debounceTime = Math.min(1000, debounceTime * 1.3);
                confidence = Math.max(0.1, confidence * 0.8);
            }
        }

        // 5. 检查触发字符
        const lastChar = textBeforeCursor.trim().slice(-1);
        const triggerChars = ['.', '(', '[', '{', ':', '<', '=', ','];

        if (triggerChars.includes(lastChar)) {
            // 触发字符：立即触发
            debounceTime = Math.min(50, debounceTime);
            confidence = Math.min(1.0, confidence * 1.5);
        }

        // 更新状态
        state.lastEdit = now;
        state.editCount++;
        this.documentStates.set(uri, state);

        return {
            shouldTrigger: true,
            reason: `编辑操作: ${state.lastOperation}, 置信度: ${confidence.toFixed(2)}`,
            debounceTime,
            confidence
        };
    }

    /**
     * 记录补全指标
     */
    recordCompletionMetrics(
        document: vscode.TextDocument,
        responseTime: number,
        accepted: boolean
    ): void {
        const uri = document.uri.toString();
        const state = this.documentStates.get(uri);

        if (state) {
            state.completionCount++;
            if (accepted) {
                state.acceptCount++;
            }
            this.documentStates.set(uri, state);

            Logger.trace(`[补全指标] 文档: ${uri.split('/').pop()}, 响应时间: ${responseTime}ms, 接受: ${accepted}, 接受率: ${(state.acceptCount / state.completionCount * 100).toFixed(1)}%`);
        }
    }

    /**
     * 更新编辑操作
     */
    updateEditOperation(document: vscode.TextDocument, operation: EditOperation): void {
        const uri = document.uri.toString();
        const state = this.documentStates.get(uri) || {
            lastEdit: Date.now(),
            lastOperation: operation,
            editCount: 0,
            completionCount: 0,
            acceptCount: 0
        };

        state.lastOperation = operation;
        state.lastEdit = Date.now();
        this.documentStates.set(uri, state);
    }

    /**
     * 检查是否在字符串或注释中
     */
    private isInStringOrComment(textBeforeCursor: string): boolean {
        // 简单检查：未闭合的引号
        const singleQuotes = (textBeforeCursor.match(/'/g) || []).length;
        const doubleQuotes = (textBeforeCursor.match(/"/g) || []).length;
        const backQuotes = (textBeforeCursor.match(/`/g) || []).length;

        // 奇数个引号表示在字符串中
        if (singleQuotes % 2 === 1 || doubleQuotes % 2 === 1 || backQuotes % 2 === 1) {
            return true;
        }

        // 检查是否在注释中
        if (textBeforeCursor.includes('//') || textBeforeCursor.includes('/*')) {
            return true;
        }

        return false;
    }

    /**
     * 检查是否为有意义的补全位置
     */
    private isMeaningfulPosition(textBeforeCursor: string, textAfterCursor: string): boolean {
        const trimmedBefore = textBeforeCursor.trim();
        const trimmedAfter = textAfterCursor.trim();

        // 空行或行末 - 好的补全位置
        if (trimmedBefore.length === 0 || trimmedAfter.length === 0) {
            return true;
        }

        // 在标点符号后 - 好的补全位置
        const lastChar = trimmedBefore.slice(-1);
        const goodChars = ['.', '(', '[', '{', ':', '<', '=', ',', ';', '+', '-', '*', '/'];

        if (goodChars.includes(lastChar)) {
            return true;
        }

        // 在单词中间 - 可能的补全位置
        const wordPattern = /\w$/;
        if (wordPattern.test(trimmedBefore) && /^\w/.test(trimmedAfter)) {
            return true;
        }

        return true; // 默认允许
    }

    /**
     * 清理过期状态
     */
    cleanup(): void {
        const now = Date.now();
        const maxAge = 5 * 60 * 1000; // 5分钟

        for (const [uri, state] of this.documentStates.entries()) {
            if (now - state.lastEdit > maxAge) {
                this.documentStates.delete(uri);
            }
        }
    }
}
