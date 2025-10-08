/*---------------------------------------------------------------------------------------------
 *  补全优化器 - 去重、语法验证、文本清理
 *--------------------------------------------------------------------------------------------*/

import { Logger } from '../../utils';

export class CompletionOptimizer {
    /**
     * 清理补全结果，移除重复代码
     */
    static cleanCompletion(completion: string, prefix: string, suffix = ''): string {
        let cleaned = completion.trim();

        // 移除代码块标记
        cleaned = cleaned.replace(/^```[\w]*\n?/, '');
        cleaned = cleaned.replace(/\n?```$/, '');
        cleaned = cleaned.replace(/<CURSOR>/g, '');

        const prefixLines = prefix.split('\n');
        const lastPrefixLine = prefixLines[prefixLines.length - 1] || '';
        const prefixEnd = lastPrefixLine.trimEnd();
        const cleanedStart = cleaned.trimStart();

        // 逐字符匹配找出最长公共后缀
        let maxOverlap = 0;
        const maxCheckLength = Math.min(prefixEnd.length, cleanedStart.length, 100);

        for (let i = 1; i <= maxCheckLength; i++) {
            const prefixSuffix = prefixEnd.slice(-i);
            const cleanedPrefix = cleanedStart.slice(0, i);

            if (prefixSuffix === cleanedPrefix) {
                maxOverlap = i;
            }
        }

        if (maxOverlap > 0) {
            cleaned = cleanedStart.slice(maxOverlap).trimStart();
            Logger.trace(`[去重] 移除重复字符（${maxOverlap}字符）`);
        } else {
            cleaned = cleanedStart;
        }

        // 处理 suffix 中的闭合符号
        if (suffix.trim()) {
            const firstSuffixChar = suffix.trimStart()[0];
            if (firstSuffixChar === ')' || firstSuffixChar === ']' || firstSuffixChar === '}') {
                let trimmedCleaned = cleaned.trimEnd();
                if (trimmedCleaned.endsWith(firstSuffixChar)) {
                    trimmedCleaned = trimmedCleaned.slice(0, -1).trimEnd();
                }
                if (firstSuffixChar === ')' && trimmedCleaned.endsWith(';')) {
                    trimmedCleaned = trimmedCleaned.slice(0, -1).trimEnd();
                }
                cleaned = trimmedCleaned;
            }
        }

        return cleaned.trim();
    }

    /**
     * 验证补全内容的语法正确性
     */
    static validateSyntax(completion: string, prefix: string): boolean {
        if (!completion.trim()) {
            return false;
        }

        // 检查括号匹配
        const combined = prefix + completion;
        const stack: string[] = [];
        const openBrackets = new Set(['(', '[', '{']);
        const bracketPairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
        let inString = false;
        let stringChar = '';
        let escaped = false;

        for (const char of combined) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }

            if (char === '"' || char === '\'' || char === '`') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                    stringChar = '';
                }
                continue;
            }

            if (inString) {
                continue;
            }

            if (openBrackets.has(char)) {
                stack.push(char);
            } else if (char in bracketPairs) {
                const expectedOpen = bracketPairs[char];
                if (stack.length === 0 || stack.pop() !== expectedOpen) {
                    Logger.trace(`[语法验证] 括号不匹配: ${char}`);
                    return false;
                }
            }
        }

        return true;
    }
}
