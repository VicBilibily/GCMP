/**
 * Model Editor 前端 l10n
 *
 * 后端在 getWebviewContent() 中注入当前 locale：
 *   window.__VS_CODE_LOCALE__ = vscode.env.language
 *
 * 判定逻辑与扩展宿主 src/utils/l10n.ts 保持一致
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function isChineseLocale(): boolean {
    const lang = ((window as any).__VS_CODE_LOCALE__ || 'en').toLowerCase();
    return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
}

/**
 * 获取本地化文本
 * @param en 英文文本（同时作为 key）
 * @param zh 中文文本
 * @param args 可选模板参数，替换 {0}, {1}, ...
 */
export function t(en: string, zh: string, ...args: unknown[]): string {
    const text = isChineseLocale() ? zh : en;
    let result = text;
    args.forEach((arg, i) => {
        result = result.replace(`{${i}}`, String(arg));
    });
    return result;
}
