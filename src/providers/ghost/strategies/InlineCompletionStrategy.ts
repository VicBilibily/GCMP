/*---------------------------------------------------------------------------------------------
 *  Inline Completion Strategy - 行内补全策略
 *  当光标在代码行中间时，补全当前表达式或语句
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';
import { BasePromptStrategy } from './BasePromptStrategy';
import { UseCaseType, type ContextAnalysis } from './PromptStrategy';

/**
 * 行内补全策略
 */
export class InlineCompletionStrategy extends BasePromptStrategy {
    name = 'Inline Completion';
    type = UseCaseType.INLINE_COMPLETION;

    /**
     * 中等优先级
     */
    getPriority(): number {
        return 4;
    }

    /**
     * 处理行内编辑场景
     */
    canHandle(_context: GhostContext, analysis: ContextAnalysis): boolean {
        return analysis.isInlineEdit && !analysis.isInComment;
    }

    /**
     * 获取系统提示词
     */
    getSystemPrompt(): string {
        return `You are a code completion assistant for inline completions.

Task: Complete partial statements and expressions.

Guidelines:
- Complete the current statement/expression
- Analyze partial code before cursor
- Maintain consistency with context
- Use appropriate types and values
- Consider common patterns
- NO markdown formatting or explanations

Focus on:
- Method calls and property access
- Variable assignments
- Conditional expressions
- Function parameters
- String/template literals`;
    }

    /**
     * 获取用户提示词
     */
    getUserPrompt(context: GhostContext): string {
        const { document, position } = context;
        const currentLine = document.lineAt(position.line).text;
        const beforeCursor = currentLine.substring(0, position.character);
        const afterCursor = currentLine.substring(position.character);

        const { before, after } = this.getSurroundingCode(document, position, 30, 5);

        // 分析补全类型
        const completionType = this.analyzeCompletionType(beforeCursor);

        let prompt = `Language: ${document.languageId}\n`;
        prompt += `Completion type: ${completionType}\n\n`;

        if (before) {
            prompt += `Code before:\n${this.formatCodeBlock(before, document.languageId)}\n\n`;
        }

        prompt += 'Current line:\n';
        prompt += `Before cursor: \`${beforeCursor}\`\n`;
        prompt += `After cursor: \`${afterCursor}\`\n\n`;

        if (after) {
            prompt += `Code after:\n${this.formatCodeBlock(after, document.languageId)}\n\n`;
        }

        prompt += `Complete the ${completionType} at cursor. Return ONLY the code to insert, no markdown.`;

        return prompt;
    }

    /**
     * 分析补全类型
     */
    private analyzeCompletionType(beforeCursor: string): string {
        const trimmed = beforeCursor.trim();

        if (/\.\s*\w*$/.test(trimmed)) {
            return 'property/method access';
        }
        if (/\(\s*[^)]*$/.test(trimmed)) {
            return 'function call';
        }
        if (/^(const|let|var)\s+\w+\s*=\s*/.test(trimmed)) {
            return 'variable assignment';
        }
        if (/(if|while|for)\s*\([^)]*$/.test(trimmed)) {
            return 'conditional expression';
        }
        if (/return\s+.*$/.test(trimmed)) {
            return 'return statement';
        }
        if (/(import|require|from)\s+.*$/.test(trimmed)) {
            return 'import statement';
        }
        if (/['"`][^'"`]*$/.test(trimmed)) {
            return 'string literal';
        }

        return 'expression';
    }
}
