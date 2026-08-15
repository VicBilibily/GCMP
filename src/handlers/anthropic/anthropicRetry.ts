import type { RetryableError } from '../../utils/retry/retryManager';
import { hasPermanentErrorSignal } from '../../utils/retry/retryClassifier';

function getHeader(error: RetryableError, name: string): string | undefined {
    const value = error.headers?.get(name);
    return value === null || value === undefined ? undefined : value;
}

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
        return Math.max(0, retryAfterMs);
    }

    const retryAfter = getHeader(error, 'retry-after');
    if (!retryAfter) {
        return undefined;
    }

    const retryAfterSeconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(retryAfterSeconds)) {
        return Math.max(0, retryAfterSeconds * 1000);
    }

    const retryAt = Date.parse(retryAfter);
    return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}
