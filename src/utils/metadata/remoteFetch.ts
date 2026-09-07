/*---------------------------------------------------------------------------------------------
 *  远程文本下载（宿主层共享）
 *  走代理感知 fetch：10 秒超时取消、content-length 预检、流式累计字节超限中止
 *  失败仅 warn 并返回 undefined，错误向上传播由调用方统一捕获
 *--------------------------------------------------------------------------------------------*/

import { Buffer } from 'node:buffer';
import { ConfigManager } from '../config/configManager';
import { Logger } from '../runtime/logger';

const FETCH_TIMEOUT_MS = 10_000;

export async function fetchRemoteText(url: string, maxBytes: number, logTag: string): Promise<string | undefined> {
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await ConfigManager.fetchWithProxy(url, { signal: abortController.signal });
        if (!response.ok) {
            Logger.warn(`${logTag} Fetch failed: HTTP ${response.status} (${url})`);
            return undefined;
        }
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            Logger.warn(`${logTag} Fetch response exceeds ${maxBytes} bytes (${url})`);
            return undefined;
        }
        if (!response.body) {
            return '';
        }
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                totalBytes += value.byteLength;
                if (totalBytes > maxBytes) {
                    await reader.cancel().catch(() => undefined);
                    Logger.warn(`${logTag} Fetch response exceeds ${maxBytes} bytes (${url})`);
                    return undefined;
                }
                chunks.push(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
        }
        return Buffer.concat(chunks, totalBytes).toString('utf8');
    } finally {
        clearTimeout(timeoutId);
    }
}
