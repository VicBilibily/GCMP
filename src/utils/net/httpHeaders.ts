/*---------------------------------------------------------------------------------------------
 *  HTTP 请求头小工具（无 vscode 依赖）
 *  User-Agent 大小写归一、按需写入，供各 handler / provider 复用
 *--------------------------------------------------------------------------------------------*/

import type { CustomHeaderValue, CustomHeaders } from '../../types/sharedTypes';

function getUserAgentHeaderEntry(headers?: CustomHeaders): CustomHeaderValue | undefined {
    if (!headers) {
        return undefined;
    }
    let userAgent: CustomHeaderValue | undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'user-agent') {
            userAgent = value;
        }
    }
    return userAgent;
}

/** 读取最后一个 user-agent（不区分大小写）；无则 undefined */
export function getUserAgentHeaderValue(headers?: CustomHeaders): string | undefined {
    if (!headers) {
        return undefined;
    }
    const userAgent = getUserAgentHeaderEntry(headers);
    return typeof userAgent === 'string' ? userAgent : undefined;
}

/** 按层合并 header，后层按名称大小写不敏感地覆盖前层。 */
export function mergeCustomHeaders(...headerLayers: Array<CustomHeaders | undefined>): CustomHeaders {
    const mergedHeaders: CustomHeaders = {};
    for (const headerLayer of headerLayers) {
        for (const [key, value] of Object.entries(headerLayer ?? {})) {
            for (const existingKey of Object.keys(mergedHeaders)) {
                if (existingKey.toLowerCase() === key.toLowerCase()) {
                    delete mergedHeaders[existingKey];
                }
            }
            mergedHeaders[key] = value;
        }
    }
    return mergedHeaders;
}

/** 提取模型请求中可删除的 header 标记，并排除受保护的 Content-Type。 */
export function getCustomHeaderDeletionMarkers(...headerLayers: Array<CustomHeaders | undefined>): CustomHeaders {
    return Object.fromEntries(
        Object.entries(preserveRequiredHeaders(mergeCustomHeaders(...headerLayers))).filter(
            ([, value]) => value === null
        )
    );
}

function isRequiredHeader(headerName: string): boolean {
    return headerName.toLowerCase() === 'content-type';
}

/** 移除必要请求 header 的 null 删除标记。 */
export function preserveRequiredHeaders(headers?: CustomHeaders): CustomHeaders {
    return Object.fromEntries(
        Object.entries(headers ?? {}).filter(([key, value]) => value !== null || !isRequiredHeader(key))
    );
}

/** 判断指定 header 是否存在大小写不敏感的 null 删除标记。 */
export function hasCustomHeaderDeletion(headers: CustomHeaders | undefined, headerName: string): boolean {
    let value: CustomHeaderValue | undefined;
    for (const [key, headerValue] of Object.entries(headers ?? {})) {
        if (key.toLowerCase() === headerName.toLowerCase()) {
            value = headerValue;
        }
    }
    return value === null;
}

/** 将可空自定义 header 应用到实际请求 header，并删除 null 标记对应的现有值。 */
export function applyCustomHeaders(headers: Record<string, string>, customHeaders?: CustomHeaders): void {
    if (!customHeaders) {
        return;
    }

    const mergedHeaders = mergeCustomHeaders(headers, preserveRequiredHeaders(customHeaders));
    for (const key of Object.keys(headers)) {
        delete headers[key];
    }
    for (const [key, value] of Object.entries(mergedHeaders)) {
        if (value !== null) {
            headers[key] = value;
        }
    }
}

/**
 * 将 User-Agent 规范为单一 `User-Agent` 键（后者覆盖前者），去掉其它大小写重复项
 */
export function canonicalizeUserAgentHeader(headers: CustomHeaders): void {
    const userAgent = getUserAgentHeaderEntry(headers);
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
export function withUserAgentHeader(headers: CustomHeaders | undefined, userAgent: string): CustomHeaders {
    const next: CustomHeaders = { ...(headers ?? {}) };
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
export function ensureUserAgentHeader(headers: CustomHeaders | undefined, fallback: string): CustomHeaders {
    const existing = getUserAgentHeaderEntry(headers);
    if (existing === null) {
        return { ...(headers ?? {}) };
    }
    if (typeof existing === 'string' && existing.trim()) {
        const next: CustomHeaders = { ...(headers ?? {}) };
        canonicalizeUserAgentHeader(next);
        return next;
    }
    return withUserAgentHeader(headers, fallback);
}
