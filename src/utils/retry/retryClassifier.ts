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
 * 覆盖场景：日/周/月硬配额耗尽、账单/套餐问题、请求超模型上下文限制。
 */
const PERMANENT_ERROR_MESSAGE_PATTERNS = [
    'per day',
    'per week',
    'per month',
    'billing',
    'upgrade your plan',
    'context length',
    'maximum context',
    'prompt too long'
];
const PERMANENT_ERROR_MESSAGE_PATTERNS_ZH = ['账单', '升级套餐', '上下文长度', '提示词过长'];

/**
 * 周期配额正则（结构化 code 在传递链丢失、只剩消息文案时的兜底）：
 * 容忍周期词与配额词之间夹带品牌/修饰词（如 "weekly Clinepass limit"），
 * 同时覆盖 "daily limit" / "monthly quota" 等无需专有模式的通用措辞。
 */
const PERMANENT_ERROR_MESSAGE_REGEXES = [
    /\b(daily|weekly|monthly)\b[^.。]{0,40}?\b(limit|quota|cap)\b/i,
    /(每日|每周|每月|月度).{0,8}(配额|限额|上限)/,
    // ChatGPT Codex 用量限额文案（结构化 type 丢失、只剩 message 时的兜底）
    /\busage\s+limit\s+(has\s+been\s+)?reached\b/i
];

/**
 * 永久性错误码：与消息文案无关的结构化标识，命中即判不可重试。
 * 对照 cline/cline ClineErrorType（仅 RateLimit 可重试）：
 * - inference_cap_error：ClinePass 推理限额（周/月配额耗尽，重置周期以小时/天计）
 * - spend_limit_exceeded：Cline 组织强制预算上限（429）
 * - insufficient_credits：Cline 按量计费余额不足
 * - usage_limit_reached：ChatGPT Codex 套餐用量限额（附 resets_in_seconds，重置以天计）
 * Cline 的 403 类错误（未订阅/组织限制）不命中任何可重试路径，无需专有消息模式兜底。
 */
const PERMANENT_ERROR_CODES = new Set([
    'inference_cap_error',
    'spend_limit_exceeded',
    'insufficient_credits',
    'usage_limit_reached'
]);

/**
 * 永久性错误类型：上游 body 的 error.type（如 ChatGPT Codex 的 usage_limit_reached），
 * SDK 传递链上 code 可能被丢弃而 type 保留在 error.error.type，需单独检查。
 */
const PERMANENT_ERROR_TYPES = new Set(['usage_limit_reached']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function hasBalanceDepletedSignal(error: RetryableErrorLike): boolean {
    const currentBalance = error.current_balance;
    return typeof currentBalance === 'number' && Number.isFinite(currentBalance) && currentBalance <= 0;
}

/**
 * 永久错误信号检测（重试无意义：周期配额耗尽/余额不足/账单问题/超上下文等）。
 * 导出给 RetryManager 的 isServerError/isNetworkError 共用：
 * 永久错误即使文案命中过载提示（如 "please try again later"）也不得重试。
 */
export function hasPermanentErrorSignal(error: RetryableErrorLike, deep = 0): boolean {
    if (!isRecord(error) || deep > MAX_RETRY_ERROR_DEPTH) {
        return false;
    }

    const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
    if (code && PERMANENT_ERROR_CODES.has(code)) {
        return true;
    }

    const type = typeof error.type === 'string' ? error.type.toLowerCase() : '';
    if (type && PERMANENT_ERROR_TYPES.has(type)) {
        return true;
    }

    if (hasBalanceDepletedSignal(error)) {
        return true;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    if (message) {
        const normalizedMessage = message.toLowerCase();
        if (
            PERMANENT_ERROR_MESSAGE_PATTERNS.some(pattern => normalizedMessage.includes(pattern)) ||
            PERMANENT_ERROR_MESSAGE_PATTERNS_ZH.some(pattern => message.includes(pattern)) ||
            PERMANENT_ERROR_MESSAGE_REGEXES.some(pattern => pattern.test(message))
        ) {
            return true;
        }
    }

    return (
        (isRecord(error.error) && hasPermanentErrorSignal(error.error, deep + 1)) ||
        (isRecord(error.cause) && hasPermanentErrorSignal(error.cause, deep + 1)) ||
        (isRecord(error.details) && hasPermanentErrorSignal(error.details, deep + 1))
    );
}

export interface RateLimitClassifyOptions {
    /** 跳过永久错误信号否决：Compatible 网关透传的单账号套餐限额可经重试切换上游路由恢复 */
    skipPermanentCheck?: boolean;
}

export function isRateLimitLikeError(error: RetryableErrorLike, deep = 0, options?: RateLimitClassifyOptions): boolean {
    if (!isRecord(error) || deep > MAX_RETRY_ERROR_DEPTH) {
        return false;
    }

    // 永久错误优先级最高：即使 SDK 同时附带 429/status/code/type，也不应进入重试。
    if (!options?.skipPermanentCheck && hasPermanentErrorSignal(error, deep)) {
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

    if (isRecord(error.error) && isRateLimitLikeError(error.error, deep + 1, options)) {
        return true;
    }

    if (isRecord(error.cause) && isRateLimitLikeError(error.cause, deep + 1, options)) {
        return true;
    }

    return false;
}
