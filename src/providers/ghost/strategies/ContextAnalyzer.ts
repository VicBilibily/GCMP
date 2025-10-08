/*---------------------------------------------------------------------------------------------
 *  Context Analyzer - 上下文分析器
 *  分析代码上下文，智能判断补全场景
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GhostContext } from '../types';
import { UseCaseType, type ContextAnalysis } from './PromptStrategy';

/**
 * 上下文分析器
 * 负责分析光标位置、代码结构等，智能判断补全场景
 */
export class ContextAnalyzer {
    /**
     * 分析给定上下文
     */
    public analyze(context: GhostContext): ContextAnalysis {
        const { document, position } = context;
        const line = document.lineAt(position.line);
        const cursorLine = line.text;
        const cursorPosition = position.character;

        // 基础分析
        const isInComment = this.isInComment(document, position);
        const isNewLine = this.isNewLine(cursorLine, cursorPosition);
        const isInlineEdit = this.isInlineEdit(cursorLine, cursorPosition);
        const hasSelection = false; // InlineCompletionItemProvider 不处理选中文本

        // 确定使用场景
        const useCase = this.determineUseCase({
            isInComment,
            isNewLine,
            isInlineEdit,
            cursorLine,
            cursorPosition,
            hasSelection
        });

        return {
            useCase,
            isInComment,
            isNewLine,
            isInlineEdit,
            cursorLine,
            cursorPosition,
            hasSelection
        };
    }

    /**
     * 确定使用场景
     */
    private determineUseCase(analysis: Omit<ContextAnalysis, 'useCase'>): UseCaseType {
        // 优先级 1: 注释驱动
        if (analysis.isInComment) {
            return UseCaseType.COMMENT_DRIVEN;
        }

        // 优先级 2: 新行补全
        if (analysis.isNewLine) {
            return UseCaseType.NEW_LINE;
        }

        // 优先级 3: 行内补全
        if (analysis.isInlineEdit) {
            return UseCaseType.INLINE_COMPLETION;
        }

        // 默认: 自动触发
        return UseCaseType.AUTO_TRIGGER;
    }

    /**
     * 检查是否在注释中
     */
    private isInComment(document: vscode.TextDocument, position: vscode.Position): boolean {
        const line = document.lineAt(position.line).text;
        const beforeCursor = line.substring(0, position.character);

        // 检查单行注释
        const singleLinePatterns = [
            /\/\//, // JavaScript/TypeScript
            /#/,    // Python/Shell
            /--/    // SQL/Lua
        ];

        for (const pattern of singleLinePatterns) {
            if (pattern.test(beforeCursor)) {
                return true;
            }
        }

        // 检查多行注释（需要向前扫描）
        // 简化版：检查光标前是否有未闭合的 /* */
        const textBefore = document.getText(new vscode.Range(
            new vscode.Position(Math.max(0, position.line - 10), 0),
            position
        ));

        const multiLineStart = textBefore.lastIndexOf('/*');
        const multiLineEnd = textBefore.lastIndexOf('*/');

        if (multiLineStart !== -1 && (multiLineEnd === -1 || multiLineStart > multiLineEnd)) {
            return true;
        }

        return false;
    }

    /**
     * 检查是否为新行（空行）
     */
    private isNewLine(cursorLine: string, cursorPosition: number): boolean {
        // 光标前的文本去除空白后为空
        const beforeCursor = cursorLine.substring(0, cursorPosition).trim();
        return beforeCursor.length === 0;
    }

    /**
     * 检查是否为行内编辑
     */
    private isInlineEdit(cursorLine: string, cursorPosition: number): boolean {
        // 光标前有内容且不为纯空白
        const beforeCursor = cursorLine.substring(0, cursorPosition).trim();
        return beforeCursor.length > 0;
    }

    /**
     * 检查是否为不完整语句
     */
    public isIncompleteStatement(line: string): boolean {
        const trimmed = line.trim();

        // 检查常见的不完整模式
        const incompletePatterns = [
            // 控制结构未闭合
            /^(if|else if|while|for|switch|try|catch)\s*\(.*\)\s*$/,
            // 声明未闭合
            /^(function|class|interface|type|enum)\s+\w+.*[^{]$/,
            // 操作符结尾
            /[,+\-*/=|&]\s*$/,
            // 变量声明未赋值
            /^(const|let|var)\s+\w+\s*=\s*$/,
            // 属性访问不完整
            /\.\s*$/,
            // 左括号未闭合
            /\(\s*$/,
            // 方法链未完成
            /^\s*\.\w*$/,
            // 箭头函数不完整
            /=>\s*$/,
            // 对象字面量不完整
            /:\s*$/
        ];

        return incompletePatterns.some(pattern => pattern.test(trimmed));
    }

    /**
     * 检查是否在特定代码块内
     */
    public isInsideCodeBlock(document: vscode.TextDocument, position: vscode.Position): {
        inFunction: boolean;
        inClass: boolean;
        inLoop: boolean;
        indentLevel: number;
    } {
        const currentLine = position.line;
        const currentIndent = this.getIndentLevel(document.lineAt(currentLine).text);

        let inFunction = false;
        let inClass = false;
        let inLoop = false;

        // 向前扫描找到上下文
        for (let i = currentLine - 1; i >= Math.max(0, currentLine - 50); i--) {
            const line = document.lineAt(i).text;
            const lineIndent = this.getIndentLevel(line);

            // 只检查缩进级别小于或等于当前的行
            if (lineIndent < currentIndent) {
                if (/^(function|async\s+function|\w+\s*\([^)]*\)\s*{|\([^)]*\)\s*=>)/.test(line.trim())) {
                    inFunction = true;
                }
                if (/^class\s+\w+/.test(line.trim())) {
                    inClass = true;
                }
                if (/^(for|while|do)\s*\(/.test(line.trim())) {
                    inLoop = true;
                }

                // 找到外层结构就停止
                if (lineIndent === 0) {
                    break;
                }
            }
        }

        return {
            inFunction,
            inClass,
            inLoop,
            indentLevel: currentIndent
        };
    }

    /**
     * 获取缩进级别
     */
    private getIndentLevel(line: string): number {
        const match = line.match(/^(\s*)/);
        if (!match) {
            return 0;
        }
        const spaces = match[1];
        // 假设 1 个 tab = 4 个空格
        return spaces.replace(/\t/g, '    ').length / 4;
    }

    /**
     * 分析光标周围的代码模式
     */
    public analyzeCodePattern(document: vscode.TextDocument, position: vscode.Position): {
        hasOpenBracket: boolean;
        hasOpenParen: boolean;
        hasOpenBrace: boolean;
        lastCharacter: string;
        isAfterDot: boolean;
        isAfterArrow: boolean;
        isAfterComma: boolean;
    } {
        const line = document.lineAt(position.line).text;
        const beforeCursor = line.substring(0, position.character);

        const lastCharacter = beforeCursor.trim().slice(-1);

        return {
            hasOpenBracket: this.hasUnclosed(beforeCursor, '[', ']'),
            hasOpenParen: this.hasUnclosed(beforeCursor, '(', ')'),
            hasOpenBrace: this.hasUnclosed(beforeCursor, '{', '}'),
            lastCharacter,
            isAfterDot: /\.$/.test(beforeCursor.trim()),
            isAfterArrow: /(=>|->)$/.test(beforeCursor.trim()),
            isAfterComma: /,$/.test(beforeCursor.trim())
        };
    }

    /**
     * 检查是否有未闭合的括号
     */
    private hasUnclosed(text: string, open: string, close: string): boolean {
        let count = 0;
        for (const char of text) {
            if (char === open) {
                count++;
            } else if (char === close) {
                count--;
            }
        }
        return count > 0;
    }
}
