/*---------------------------------------------------------------------------------------------
 *  Base Prompt Strategy - 提示词策略基类
 *  提供策略的通用功能
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { GhostContext } from '../types';
import type { PromptStrategy, ContextAnalysis } from './PromptStrategy';

/**
 * 提示词策略抽象基类
 */
export abstract class BasePromptStrategy implements PromptStrategy {
    abstract name: string;
    abstract type: import('./PromptStrategy').UseCaseType;

    abstract canHandle(context: GhostContext, analysis: ContextAnalysis): boolean;
    abstract getSystemPrompt(): string;
    abstract getUserPrompt(context: GhostContext): string;
    abstract getPriority(): number;

    /**
     * 获取周围代码
     */
    protected getSurroundingCode(
        document: vscode.TextDocument,
        position: vscode.Position,
        linesBefore = 50,
        linesAfter = 10
    ): { before: string; after: string; currentLine: string } {
        const currentLineNum = position.line;
        const startLine = Math.max(0, currentLineNum - linesBefore);
        const endLine = Math.min(document.lineCount - 1, currentLineNum + linesAfter);

        const beforeLines: string[] = [];
        const afterLines: string[] = [];
        const currentLine = document.lineAt(currentLineNum).text;

        // 获取前面的行
        for (let i = startLine; i < currentLineNum; i++) {
            beforeLines.push(document.lineAt(i).text);
        }

        // 获取后面的行
        for (let i = currentLineNum + 1; i <= endLine; i++) {
            afterLines.push(document.lineAt(i).text);
        }

        return {
            before: beforeLines.join('\n'),
            after: afterLines.join('\n'),
            currentLine
        };
    }

    /**
     * 格式化代码块
     */
    protected formatCodeBlock(code: string, language: string): string {
        return `\`\`\`${language}\n${code}\n\`\`\``;
    }

    /**
     * 获取缩进字符串
     */
    protected getIndentation(document: vscode.TextDocument, line: number): string {
        const lineText = document.lineAt(line).text;
        const match = lineText.match(/^(\s*)/);
        return match ? match[1] : '';
    }

    /**
     * 检查是否为不完整语句
     */
    protected isIncompleteStatement(line: string): boolean {
        const trimmed = line.trim();
        const incompletePatterns = [
            /^(if|else if|while|for|switch|try|catch)\s*\(.*\)\s*$/,
            /^(function|class|interface|type|enum)\s+\w+.*[^{]$/,
            /[,+\-*/=|&]\s*$/,
            /^(const|let|var)\s+\w+\s*=\s*$/,
            /\.\s*$/,
            /\(\s*$/,
            /=>\s*$/,
            /:\s*$/
        ];
        return incompletePatterns.some(pattern => pattern.test(trimmed));
    }
}
