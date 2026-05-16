/**
 * Webview 端 l10n 工具
 *
 * 扩展宿主在 getWebviewContent() 中注入当前 locale：
 *   window.__L10N_LOCALE__ = vscode.env.language  // 如 'zh-cn', 'en'
 *
 * 判定逻辑与扩展宿主 src/utils/l10n.ts 保持一致：
 * - 中文环境（zh-cn / zh / zh-* 前缀）→ 显示中文
 * - 其他 → 显示英文
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function isChineseLocale(): boolean {
    const lang = ((window as any).__L10N_LOCALE__ || 'en').toLowerCase();
    return lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-');
}

/**
 * 获取本地化文本
 * @param en - 英文文本（同时作为 key）
 * @param zh - 中文文本
 * @param args - 可选的模板参数，替换 {0}, {1}, ...
 * @returns 本地化后的文本
 */
export function t(en: string, zh: string, ...args: string[]): string {
    const text = isChineseLocale() ? zh : en;
    let result = text;
    args.forEach((arg, i) => {
        result = result.replace(`{${i}}`, String(arg));
    });
    return result;
}
