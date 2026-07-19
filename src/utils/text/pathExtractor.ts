/**---------------------------------------------------------------------------------------------
 *  字段路径解析器
 *  支持从 JSON 对象中按 dot 路径提取数值
 *--------------------------------------------------------------------------------------------*/

/**
 * 按 dot 路径从对象中取值
 * 支持 "data.balance" / "data[0].credit_balance" / "balance"
 * @param obj 目标对象
 * @param path dot 路径
 * @returns 路径对应的值，不存在时返回 undefined
 */
export function getValueByPath(obj: unknown, path: string): unknown {
    if (obj == null || typeof path !== 'string' || path.trim().length === 0) {
        return undefined;
    }

    const segments = path
        .replace(/\[(\d+)\]/g, '.$1')
        .split('.')
        .filter(s => s.length > 0);

    let current: unknown = obj;
    for (const segment of segments) {
        if (current == null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

/**
 * 按路径取数值，兼容数字和数字字符串
 * @param obj 目标对象
 * @param path dot 路径，未定义时返回 undefined
 * @returns 解析后的有限数字，无法解析时返回 undefined
 */
export function getNumberByPath(obj: unknown, path: string | undefined): number | undefined {
    if (!path) {
        return undefined;
    }

    const value = getValueByPath(obj, path);
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
}
