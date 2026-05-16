/**
 * 国际化工具函数
 *
 * 使用方式: t('English text', '中文文本', arg1, arg2)
 * - 根据 vscode.env.language 自动选择语言
 * - {0}, {1} 等占位符会被后续参数替换
 *
 * 示例:
 *   t('Hello {0}', '你好 {0}', userName)  // userName 会替换 {0}
 */

import * as vscode from 'vscode';

/**
 * 检测当前是否中文环境
 */
function isChineseLocale(): boolean {
    try {
        const lang = vscode.env.language.toLowerCase();
        return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
    } catch {
        // vscode context not available, default to English
        return false;
    }
}

/**
 * 国际化文本
 * @param en 英文文本
 * @param zh 中文文本
 * @param args 替换占位符的参数
 */
export function t(en: string, zh: string, ...args: unknown[]): string {
    const text = isChineseLocale() ? zh : en;
    let result = text;
    args.forEach((arg, i) => {
        result = result.replace(`{${i}}`, String(arg));
    });
    return result;
}
