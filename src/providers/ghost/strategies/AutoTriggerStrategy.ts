/*---------------------------------------------------------------------------------------------
 *  Auto Trigger Strategy - 自动触发策略
 *  最基础的补全策略，用于一般情况
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from '../types';
import { BasePromptStrategy } from './BasePromptStrategy';
import { UseCaseType, type ContextAnalysis } from './PromptStrategy';

/**
 * 自动触发策略（默认策略）
 */
export class AutoTriggerStrategy extends BasePromptStrategy {
    name = 'Auto Trigger';
    type = UseCaseType.AUTO_TRIGGER;

    /**
     * 优先级最低，作为兜底策略
     */
    getPriority(): number {
        return 1;
    }

    /**
     * 可以处理任何上下文（兜底策略）
     */
    canHandle(_context: GhostContext, _analysis: ContextAnalysis): boolean {
        return true;
    }

    /**
     * 获取系统提示词
     */
    getSystemPrompt(): string {
        return `You are a code completion assistant. Provide minimal, subtle code completions.

Guidelines:
- Generate ONLY the code to insert at cursor
- Keep completions short and obvious
- Match existing code style
- Complete the current expression/statement
- NO explanations or markdown formatting`;
    }

    /**
     * 获取用户提示词
     */
    getUserPrompt(context: GhostContext): string {
        const { document, position } = context;
        const { before, after, currentLine } = this.getSurroundingCode(document, position, 30, 5);

        const textBeforeCursor = currentLine.substring(0, position.character);
        const textAfterCursor = currentLine.substring(position.character);

        let prompt = `Language: ${document.languageId}\n\n`;

        if (before) {
            prompt += `Code before:\n${this.formatCodeBlock(before, document.languageId)}\n\n`;
        }

        prompt += `Current line (cursor at |):\n\`${textBeforeCursor}|${textAfterCursor}\`\n\n`;

        if (after) {
            prompt += `Code after:\n${this.formatCodeBlock(after, document.languageId)}\n\n`;
        }

        prompt += 'Complete at cursor. Return ONLY the code to insert, no markdown.';

        return prompt;
    }
}
