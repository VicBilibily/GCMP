/*---------------------------------------------------------------------------------------------
 *  HTTP 请求头小工具（无 vscode 依赖）
 *  User-Agent 大小写归一、按需写入，供各 handler / provider 复用
 *--------------------------------------------------------------------------------------------*/

/** 读取最后一个 user-agent（不区分大小写）；无则 undefined */
export function getUserAgentHeaderValue(headers?: Record<string, string>): string | undefined {
    if (!headers) {
        return undefined;
    }
    let userAgent: string | undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'user-agent') {
            userAgent = value;
        }
    }
    return userAgent;
}

/**
 * 将 User-Agent 规范为单一 `User-Agent` 键（后者覆盖前者），去掉其它大小写重复项
 */
export function canonicalizeUserAgentHeader(headers: Record<string, string>): void {
    const userAgent = getUserAgentHeaderValue(headers);
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'user-agent' && key !== 'User-Agent') {
            delete headers[key];
        }
    }
    if (userAgent !== undefined) {
        headers['User-Agent'] = userAgent;
    }
}

/** 写入 User-Agent 并清除其它大小写重复项，返回新对象 */
export function withUserAgentHeader(
    headers: Record<string, string> | undefined,
    userAgent: string
): Record<string, string> {
    const next: Record<string, string> = { ...(headers ?? {}) };
    for (const key of Object.keys(next)) {
        if (key.toLowerCase() === 'user-agent') {
            delete next[key];
        }
    }
    next['User-Agent'] = userAgent;
    return next;
}

/**
 * 已有非空 User-Agent（如 providerOverrides）则只规范大小写；否则写入 fallback
 */
export function ensureUserAgentHeader(
    headers: Record<string, string> | undefined,
    fallback: string
): Record<string, string> {
    const existing = getUserAgentHeaderValue(headers)?.trim();
    if (existing) {
        const next: Record<string, string> = { ...(headers ?? {}) };
        canonicalizeUserAgentHeader(next);
        return next;
    }
    return withUserAgentHeader(headers, fallback);
}
