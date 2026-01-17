/*---------------------------------------------------------------------------------------------
 *  提示词服务
 *  生成完整的 AI 提示词
 *--------------------------------------------------------------------------------------------*/

import { CommitFormat, CommitLanguage } from './types';
import { ConfigManager } from '../utils';
import { getTemplate } from './templates';

/**
 * 提示词服务
 * 负责生成完整的 AI 提示词
 */
export class PromptService {
    /**
     * 生成最终提交消息提示词。
     * 注意：diff 片段、历史上下文等内容已在上游以“单独消息/附件”形式传递，
     * 这里仅生成最终指令（尽量保持简短）。
     */
    static generateCommitPrompt(): string {
        const commit = ConfigManager.getCommitConfig();
        const format = commit.format;
        const customInstructions = commit.customInstructions;
        const language = commit.language;

        // 自定义（custom）模式：以用户指令为主，但仍追加上下文（片段/历史）
        if (format === 'custom' && customInstructions.trim()) {
            return this.generateCustomPrompt(customInstructions);
        }

        // auto：不在扩展侧做任何推断。
        // 上游会把“最近提交历史”以单独的用户消息提供给模型，模型应自行归纳仓库风格。
        if (format === 'auto') {
            return this.generateAutoPrompt(language);
        }

        // custom 但未提供自定义指令：回退为 plain
        const effectiveFormat = format === 'custom' ? 'plain' : format;
        return this.generateStandardPrompt(effectiveFormat, language);
    }

    /**
     * auto 模式：让模型根据“最近提交历史”自行归纳仓库的提交规范，并以同样风格输出。
     * 注意：历史内容由上游以单独消息形式提供。
     */
    private static generateAutoPrompt(language: CommitLanguage): string {
        const fallbackLanguage = language === 'chinese' ? 'Chinese' : 'English';

        let prompt = `Generate a commit message that matches this repository's existing commit message style.

You may be given recent commit history in a previous message.

Rules:
    1. If recent commit history is provided, infer the predominant commit message format/style AND language from it.
    2. If the inferred language is clear, write the commit message in that language.
    3. If the inferred language is mixed or unclear (or no history is provided), write the commit message in ${fallbackLanguage}.
    4. Produce ONE commit message for the current changes using the inferred style.
    5. If the inferred style is mixed or unclear (or no history is provided), fall back to a single plain sentence (no prefixes, no emojis, no issue refs).
    6. Keep it concise (ideally <= 72 characters for the first line).
    7. Output the commit message only.`;

        prompt += `
IMPORTANT: Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * 生成自定义指令提示词
     */
    private static generateCustomPrompt(customInstructions: string): string {
        let prompt = customInstructions;

        prompt += `
Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * 生成标准模板提示词
     */
    private static generateStandardPrompt(format: CommitFormat, language: CommitLanguage): string {
        const languagePrompt = this.getLanguagePrompt(language);
        const template = getTemplate(format);

        let prompt = template;

        // 保持空白符可预测，避免缩进意外渗入提示词内容。
        prompt += `\n\n${languagePrompt}\n`;

        prompt += `
IMPORTANT: Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * 获取语言提示
     */
    static getLanguagePrompt(language: CommitLanguage): string {
        switch (language) {
            case 'chinese':
                // 提示词指令保持英文；仅通过指令要求输出语言发生变化。
                return 'Please write the commit message in Chinese.';
            case 'english':
            default:
                return 'Please write the commit message in English.';
        }
    }

    /**
     * 规范化模型输出的提交消息。
     */
    static normalizeCommitMessage(message: string): string {
        let cleaned = (message ?? '').trim();

        // 仅移除“整体被一个代码围栏（fenced code block）包裹”的情况，避免误删正文中的 ```。
        const fenced = cleaned.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
        if (fenced) {
            cleaned = fenced[1].trim();
        }

        // 移除多余的空行
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned.trim();
    }
}
