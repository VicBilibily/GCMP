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

/**
 * 永久性错误指示词：消息虽命中限流模式（如 "limit exceeded" / "quota exceeded"），
 * 但包含这些词时属于重试无意义的永久错误，不判为可重试。
 * 覆盖场景：日/月硬配额耗尽、账单/套餐问题、请求超模型上下文限制。
 */
const PERMANENT_ERROR_MESSAGE_PATTERNS = [
    'per day',
    'daily quota',
    'per month',
    'monthly quota',
    'billing',
    'upgrade your plan',
    'context length',
    'maximum context',
    'prompt too long'
];
const PERMANENT_ERROR_MESSAGE_PATTERNS_ZH = ['每日配额', '月度配额', '账单', '升级套餐', '上下文长度', '提示词过长'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasPermanentErrorSignal(error: RetryableErrorLike, deep = 0): boolean {
    if (!isRecord(error) || deep > MAX_RETRY_ERROR_DEPTH) {
        return false;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    if (message) {
        const normalizedMessage = message.toLowerCase();
        if (
            PERMANENT_ERROR_MESSAGE_PATTERNS.some(pattern => normalizedMessage.includes(pattern)) ||
            PERMANENT_ERROR_MESSAGE_PATTERNS_ZH.some(pattern => message.includes(pattern))
        ) {
            return true;
        }
    }

    return (
        (isRecord(error.error) && hasPermanentErrorSignal(error.error, deep + 1)) ||
        (isRecord(error.cause) && hasPermanentErrorSignal(error.cause, deep + 1))
    );
}

export function isRateLimitLikeError(error: RetryableErrorLike, deep = 0): boolean {
    if (!isRecord(error) || deep > MAX_RETRY_ERROR_DEPTH) {
        return false;
    }

    // 永久错误优先级最高：即使 SDK 同时附带 429/status/code/type，也不应进入重试。
    if (hasPermanentErrorSignal(error, deep)) {
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
