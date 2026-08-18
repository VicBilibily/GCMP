import type { RetryableError } from '../../utils/retry/retryManager';
import { hasPermanentErrorSignal } from '../../utils/retry/retryClassifier';

function getHeader(error: RetryableError, name: string): string | undefined {
    const value = error.headers?.get(name);
    return value === null || value === undefined ? undefined : value;
}

/** 服务端提示重试延迟的最小值：避免 retry-after: 0 造成紧重试循环 */
const MIN_SERVER_RETRY_DELAY_MS = 1_000;

function getStatus(error: RetryableError): number | undefined {
    return error.status ?? error.statusCode;
}

function isAnthropicConnectionError(error: RetryableError): boolean {
    return error.message === 'Connection error.' || error.message === 'Request timed out.';
}

export function shouldRetryAnthropicRequest(error: RetryableError, fallback: boolean): boolean {
    const shouldRetryHeader = getHeader(error, 'x-should-retry');
    if (shouldRetryHeader === 'false') {
        return false;
    }
    if (fallback) {
        return true;
    }
    if (hasPermanentErrorSignal(error as unknown as Record<string, unknown>)) {
        return false;
    }
    if (shouldRetryHeader === 'true') {
        return true;
    }

    const status = getStatus(error);
    return (
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500) ||
        isAnthropicConnectionError(error)
    );
}

export function getAnthropicRetryDelayMs(error: RetryableError): number | undefined {
    const retryAfterMs = Number.parseFloat(getHeader(error, 'retry-after-ms') ?? '');
    if (Number.isFinite(retryAfterMs)) {
        return Math.max(MIN_SERVER_RETRY_DELAY_MS, retryAfterMs);
    }

    const retryAfter = getHeader(error, 'retry-after');
    if (!retryAfter) {
        return undefined;
    }

    const retryAfterSeconds = /^\d+$/.test(retryAfter.trim()) ? Number.parseInt(retryAfter.trim(), 10) : NaN;
    if (Number.isFinite(retryAfterSeconds)) {
        return Math.max(MIN_SERVER_RETRY_DELAY_MS, retryAfterSeconds * 1000);
    }

    const retryAt = Date.parse(retryAfter);
    return Number.isFinite(retryAt) ? Math.max(MIN_SERVER_RETRY_DELAY_MS, retryAt - Date.now()) : undefined;
}
