type RetryableErrorLike = Record<string, unknown>;

const MAX_RETRY_ERROR_DEPTH = 3;
const RATE_LIMIT_STATUS_CODES = new Set([429, 529]);
const RATE_LIMIT_ERROR_CODES = new Set([
    '429',
    '529',
    'rate_limit_exceeded',
    'rate_limited',
    'too_many_requests',
    'quota_exceeded',
    'resource_exhausted',
    'throttled',
    'throttling'
]);
const RATE_LIMIT_ERROR_TYPES = new Set(['rate_limit_error', 'throttling_error']);
const RATE_LIMIT_MESSAGE_PATTERNS = [
    'rate limit',
    'rate-limited',
    'rate_limited',
    'too many requests',
    'limit exceeded',
    'quota exceeded',
    'resource exhausted',
    'temporarily overloaded',
    'throttled',
    'throttling'
];
const RATE_LIMIT_MESSAGE_PATTERNS_ZH = ['请求过于频繁', '访问量过大', '限流'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function isRateLimitLikeError(error: RetryableErrorLike, deep = 0): boolean {
    if (!isRecord(error) || deep > MAX_RETRY_ERROR_DEPTH) {
        return false;
    }

    if (RATE_LIMIT_STATUS_CODES.has(error.status as number)) {
        return true;
    }

    if (RATE_LIMIT_STATUS_CODES.has(error.statusCode as number)) {
        return true;
    }

    const code =
        typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code).toLowerCase() : '';
    if (code && RATE_LIMIT_ERROR_CODES.has(code)) {
        return true;
    }

    const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
    if (type && RATE_LIMIT_ERROR_TYPES.has(type)) {
        return true;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    if (message) {
        const normalizedMessage = message.toLowerCase();

        if (normalizedMessage.includes('429') || normalizedMessage.includes('529')) {
            return true;
        }

        if (RATE_LIMIT_MESSAGE_PATTERNS.some(pattern => normalizedMessage.includes(pattern))) {
            return true;
        }

        if (RATE_LIMIT_MESSAGE_PATTERNS_ZH.some(pattern => message.includes(pattern))) {
            return true;
        }

        if (normalizedMessage.includes('codex.rate_limits')) {
            return true;
        }

        if (
            normalizedMessage.includes("when snapshot hasn't been set yet") &&
            normalizedMessage.includes("expected 'response.created' event") &&
            normalizedMessage.includes('got response.failed')
        ) {
            return true;
        }
    }

    if (isRecord(error.error) && isRateLimitLikeError(error.error, deep + 1)) {
        return true;
    }

    if (isRecord(error.cause) && isRateLimitLikeError(error.cause, deep + 1)) {
        return true;
    }

    return false;
}
