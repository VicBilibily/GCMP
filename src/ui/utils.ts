/**
 * UI 工具函数
 */

/**
 * 创建 DOM 元素
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
