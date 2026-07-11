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

/**
 * 格式化 Token 数量显示（K/M 缩写）
 */
export function formatTokens(tokens: number | undefined | null): string {
    const safeTokens = tokens ?? 0;
    if (safeTokens >= 1000000) {
        return (safeTokens / 1000000).toFixed(1) + 'M';
    } else if (safeTokens >= 1000) {
        return (safeTokens / 1000).toFixed(1) + 'K';
    }
    return safeTokens.toString();
}

/**
 * 格式化预估成本显示
 * @param cost 成本金额 (USD)
 * @param fixedDecimals 固定小数位数，不传则自适应（最多 6 位，去除末尾 0）
 */
export function formatCost(cost: number | undefined | null, fixedDecimals?: number): string {
    if (cost === undefined || cost === null || cost <= 0) {
        return '-';
    }
    const start = fixedDecimals ?? 4;
    let n = start;
    while (n <= 6) {
        const formatted = cost.toFixed(n);
        const frac = formatted.split('.')[1] || '';
        if (/^0+$/.test(frac)) {
            n++;
        } else {
            return `$${formatted}`;
        }
    }
    // 六个0时遵循指定的小数位截断
    return `$${cost.toFixed(start)}`;
}
