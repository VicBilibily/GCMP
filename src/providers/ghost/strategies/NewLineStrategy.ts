/*---------------------------------------------------------------------------------------------
 *  New Line Strategy - 新行补全策略
 *  当光标在空行时，提供主动的代码补全
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';
import { BasePromptStrategy } from './BasePromptStrategy';
import { UseCaseType, type ContextAnalysis } from './PromptStrategy';

/**
 * 新行补全策略
 */
export class NewLineStrategy extends BasePromptStrategy {
    name = 'New Line Completion';
    type = UseCaseType.NEW_LINE;

    /**
     * 中等优先级
     */
    getPriority(): number {
        return 5;
    }

    /**
     * 处理空行场景
     */
    canHandle(_context: GhostContext, analysis: ContextAnalysis): boolean {
        return analysis.isNewLine && !analysis.isInComment;
    }

    /**
     * 获取系统提示词
     */
    getSystemPrompt(): string {
        return `You are a proactive code completion assistant for new lines.

Task: Suggest logical next code when user creates a new line.

Guidelines:
- Analyze surrounding code structure
- Consider common patterns for the context
- Be proactive but conservative
- Suggest complete statements (1-3 lines)
- Match existing style and indentation
- NO markdown formatting or explanations

Common patterns:
- After if/else: complete block or add else
- After function signature: add implementation
- After loop: add loop body
- Inside function: add logical next statement
- After variable: initialize or use it`;
    }

    /**
     * 获取用户提示词
     */
    getUserPrompt(context: GhostContext): string {
        const { document, position } = context;
        const { before, after } = this.getSurroundingCode(document, position, 40, 15);

        const lineNumber = position.line + 1;
        const indentation = this.getIndentation(document, position.line);

        let prompt = `Language: ${document.languageId}\n`;
        prompt += `Line ${lineNumber} (empty line, indent: ${indentation.length} spaces)\n\n`;

        // 分析上下文
        prompt += this.analyzeContext(before, after);

        if (before) {
            prompt += `\nCode before:\n${this.formatCodeBlock(before, document.languageId)}\n`;
        }

        prompt += '\nCurrent line: [EMPTY]\n';

        if (after) {
            prompt += `\nCode after:\n${this.formatCodeBlock(after, document.languageId)}\n`;
        }

        prompt += '\nSuggest the most logical code for this position. Return ONLY the code, no markdown.';

        return prompt;
    }

    /**
     * 分析上下文提供提示
     */
    private analyzeContext(before: string, after: string): string {
        let analysis = 'Context analysis:\n';

        const beforeLines = before.trim().split('\n');
        const lastLine = beforeLines[beforeLines.length - 1] || '';

        if (lastLine) {
            if (this.isIncompleteStatement(lastLine)) {
                analysis += '- Previous line is incomplete\n';
            }
            if (/^(if|else if|else)\s*/.test(lastLine.trim())) {
                analysis += '- Inside conditional block\n';
            }
            if (/(for|while|do)\s*\(/.test(lastLine)) {
                analysis += '- Inside loop\n';
            }
            if (/(function|=>\s*{|class)/.test(lastLine)) {
                analysis += '- Inside function/class\n';
            }
            if (/(\/\/|#)/.test(lastLine)) {
                analysis += '- After comment - consider implementing\n';
            }
        }

        const afterLines = after.trim().split('\n');
        const nextLine = afterLines[0] || '';
        if (nextLine && /^}/.test(nextLine.trim())) {
            analysis += '- Before closing brace\n';
        }

        return analysis;
    }
}
