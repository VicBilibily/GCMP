/**
 * Auxiliary Model Settings UI 工具函数
 */

export function createElement(
    tag: string,
    className: string = '',
    attributes: Record<string, unknown> = {}
): HTMLElement {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    Object.assign(element, attributes);
    return element;
}

export function t(en: string, zh: string, ...args: unknown[]): string {
    const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
    let text = lang === 'zh-cn' || lang === 'zh' || lang.startsWith('zh-') ? zh : en;
    args.forEach((arg, i) => {
        text = text.replace(`{${i}}`, String(arg));
    });
    return text;
}
