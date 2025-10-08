/*---------------------------------------------------------------------------------------------
 *  Ghost Prompt Builder - 构建 AI 提示词
 *  使用策略模式根据上下文智能构建提示
 *--------------------------------------------------------------------------------------------*/

import type { GhostContext } from './types';
import { PromptStrategyManager } from './strategies/PromptStrategyManager';

/**
 * Ghost 提示词构建器
 * 使用策略管理器智能选择和构建提示
 */
export class GhostPromptBuilder {
    private static strategyManager = new PromptStrategyManager();

    /**
     * 构建系统提示词
     * @deprecated 使用 buildPrompts 替代
     */
    public static buildSystemPrompt(): string {
        // 兜底系统提示词
        return `You are an expert code completion assistant. Generate relevant code completions based on the context provided.

Rules:
1. Generate ONLY the code that should be inserted at the cursor position
2. Match the existing code style and indentation
3. Do NOT include any explanations or comments unless they are part of the code
4. Keep completions concise and relevant
5. For multi-line completions, ensure proper indentation
6. Generate syntactically correct code`;
    }

    /**
     * 构建用户提示词
     * @deprecated 使用 buildPrompts 替代
     */
    public static buildUserPrompt(context: GhostContext): string {
        const { document, position } = context;

        // 获取当前行
        const currentLine = document.lineAt(position.line);
        const textBeforeCursor = currentLine.text.substring(0, position.character);
        const textAfterCursor = currentLine.text.substring(position.character);

        // 获取前面的上下文（最多50行）
        const startLine = Math.max(0, position.line - 50);
        const precedingLines: string[] = [];
        for (let i = startLine; i < position.line; i++) {
            precedingLines.push(document.lineAt(i).text);
        }

        // 获取后面的上下文（最多10行）
        const endLine = Math.min(document.lineCount - 1, position.line + 10);
        const followingLines: string[] = [];
        for (let i = position.line + 1; i <= endLine; i++) {
            followingLines.push(document.lineAt(i).text);
        }

        // 构建提示词
        let prompt = `Language: ${document.languageId}\n`;
        prompt += `File: ${document.fileName}\n\n`;

        if (precedingLines.length > 0) {
            prompt += 'Preceding code:\n```' + document.languageId + '\n';
            prompt += precedingLines.join('\n');
            prompt += '\n```\n\n';
        }

        prompt += 'Current line (cursor at |):\n';
        prompt += '```' + document.languageId + '\n';
        prompt += `${textBeforeCursor}|${textAfterCursor}\n`;
        prompt += '```\n\n';

        if (followingLines.length > 0) {
            prompt += 'Following code:\n```' + document.languageId + '\n';
            prompt += followingLines.join('\n');
            prompt += '\n```\n\n';
        }

        prompt += 'Generate the most appropriate code completion for the cursor position. ';
        prompt += 'Return ONLY the code to be inserted, without any markdown formatting or explanations.';

        return prompt;
    }

    /**
     * 构建提示词（推荐使用）
     * 使用策略管理器智能选择和构建
     */
    public static buildPrompts(context: GhostContext): {
        systemPrompt: string;
        userPrompt: string;
        strategyName: string;
    } {
        const { systemPrompt, userPrompt, strategy } = this.strategyManager.buildPrompts(context);

        return {
            systemPrompt,
            userPrompt,
            strategyName: strategy.name
        };
    }

    /**
     * 获取策略管理器（用于调试）
     */
    public static getStrategyManager(): PromptStrategyManager {
        return this.strategyManager;
    }
}
