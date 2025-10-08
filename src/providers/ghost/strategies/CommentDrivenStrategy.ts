/*---------------------------------------------------------------------------------------------
 *  Comment Driven Strategy - 注释驱动策略
 *  根据注释内容生成代码实现
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';
import { BasePromptStrategy } from './BasePromptStrategy';
import { UseCaseType, type ContextAnalysis } from './PromptStrategy';

/**
 * 注释驱动策略
 */
export class CommentDrivenStrategy extends BasePromptStrategy {
    name = 'Comment Driven';
    type = UseCaseType.COMMENT_DRIVEN;

    /**
     * 高优先级
     */
    getPriority(): number {
        return 8;
    }

    /**
     * 处理注释场景
     */
    canHandle(_context: GhostContext, analysis: ContextAnalysis): boolean {
        return analysis.isInComment;
    }

    /**
     * 获取系统提示词
     */
    getSystemPrompt(): string {
        return `You are a code generation assistant for comment-driven development.

Task: Generate code based on comment descriptions.

Guidelines:
- Read and understand the comment intent
- Generate implementation matching description
- Follow existing code patterns
- Match style and conventions
- Keep implementation concise but complete
- NO markdown formatting or explanations

Comment patterns to handle:
- TODO comments with descriptions
- Function/method documentation
- Step-by-step implementation guides
- Algorithm descriptions
- Feature requirements`;
    }

    /**
     * 获取用户提示词
     */
    getUserPrompt(context: GhostContext): string {
        const { document, position } = context;
        const { comment, contextBefore, contextAfter } = this.extractComment(document, position);

        const { before, after } = this.getSurroundingCode(document, position, 30, 10);

        let prompt = `Language: ${document.languageId}\n\n`;
        prompt += `Comment to implement:\n\`\`\`\n${comment}\n\`\`\`\n\n`;

        if (contextBefore) {
            prompt += `Context before comment:\n${this.formatCodeBlock(contextBefore, document.languageId)}\n\n`;
        }

        if (before) {
            prompt += `Full code before:\n${this.formatCodeBlock(before, document.languageId)}\n\n`;
        }

        if (contextAfter) {
            prompt += `Context after comment:\n${this.formatCodeBlock(contextAfter, document.languageId)}\n\n`;
        }

        if (after) {
            prompt += `Full code after:\n${this.formatCodeBlock(after, document.languageId)}\n\n`;
        }

        prompt += 'Implement the functionality described in the comment. Return ONLY the code, no markdown.';

        return prompt;
    }

    /**
     * 提取注释内容
     */
    private extractComment(document: import('vscode').TextDocument, position: import('vscode').Position): {
        comment: string;
        contextBefore: string;
        contextAfter: string;
    } {
        const currentLine = document.lineAt(position.line);
        const comment = currentLine.text.trim();

        // 获取注释前后各3行作为上下文
        const beforeLines: string[] = [];
        for (let i = Math.max(0, position.line - 3); i < position.line; i++) {
            beforeLines.push(document.lineAt(i).text);
        }

        const afterLines: string[] = [];
        for (let i = position.line + 1; i < Math.min(document.lineCount, position.line + 4); i++) {
            afterLines.push(document.lineAt(i).text);
        }

        return {
            comment,
            contextBefore: beforeLines.join('\n'),
            contextAfter: afterLines.join('\n')
        };
    }
}
