import assert from 'node:assert/strict';
import test from 'node:test';

import { hasPermanentErrorSignal, isRateLimitLikeError } from './retryClassifier';

test('treats codex.rate_limits responses event as retryable', () => {
    assert.equal(
        isRateLimitLikeError({ message: 'Unexpected codex.rate_limits event returned instead of chat content' }),
        true
    );
});

test('detects retryable codex.rate_limits event through nested cause chain', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Compatible Provider request processing failed',
            cause: { message: 'Unexpected codex.rate_limits event returned instead of chat content' }
        }),
        true
    );
});

test('does not treat unrelated content mismatch as retryable', () => {
    assert.equal(isRateLimitLikeError({ message: 'Unexpected event returned instead of chat content' }), false);
});

test('treats responses snapshot bootstrap mismatch as retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: "When snapshot hasn't been set yet, expected 'response.created' event, got response.failed"
        }),
        true
    );
});

test('detects responses snapshot bootstrap mismatch through nested cause chain', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Compatible Provider request processing failed',
            cause: {
                message:
                    "Error: When snapshot hasn't been set yet, expected 'response.created' event, got response.failed"
            }
        }),
        true
    );
});

test('treats too many requests message as retryable', () => {
    assert.equal(isRateLimitLikeError({ message: 'Too many requests, please try again later.' }), true);
});

test('treats resource exhausted error code as retryable', () => {
    assert.equal(isRateLimitLikeError({ code: 'resource_exhausted', message: 'RESOURCE_EXHAUSTED' }), true);
});

test('treats rate_limit_error type as retryable', () => {
    assert.equal(isRateLimitLikeError({ type: 'rate_limit_error', message: 'provider rejected request' }), true);
});

test('treats nested quota exceeded error as retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Compatible Provider request processing failed',
            error: { code: 'quota_exceeded', message: 'Quota exceeded for this minute.' }
        }),
        true
    );
});

test('does not treat daily quota exhaustion as retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: "Quota exceeded for quota metric 'generate-requests' and limit 'Requests per day'"
        }),
        false
    );
});

test('does not treat billing limit message as retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Usage limit exceeded, please check your billing details or upgrade your plan'
        }),
        false
    );
});

test('does not treat context length limit as retryable', () => {
    assert.equal(
        isRateLimitLikeError({ message: 'Request exceeds the maximum context length limit of this model' }),
        false
    );
});

test('permanent quota message overrides HTTP 429 status', () => {
    assert.equal(
        isRateLimitLikeError({
            status: 429,
            code: 'quota_exceeded',
            message: "Quota exceeded for quota metric 'generate-requests' and limit 'Requests per day'"
        }),
        false
    );
});

test('nested permanent error overrides outer retryable status', () => {
    assert.equal(
        isRateLimitLikeError({
            statusCode: 429,
            cause: { message: 'Request exceeds the maximum context length limit of this model' }
        }),
        false
    );
});

test('ClinePass weekly cap error is not retryable (nested code + 429 message)', () => {
    assert.equal(
        isRateLimitLikeError({
            error: {
                code: 'INFERENCE_CAP_ERROR',
                message:
                    'Error 429: You have reached your weekly Clinepass limit. The limit resets in 15h 26m, please try again later.'
            }
        }),
        false
    );
});

test('weekly limit message without error code is not retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Error 429: You have reached your weekly limit. The limit resets in 2h 10m.'
        }),
        false
    );
});

// 以下用例对照 cline/cline ClineError.getErrorType 的真实错误样例：带结构化错误码的不可重试错误

test('Cline spend limit exceeded (org budget cap) is not retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            message: 'Spend limit reached.',
            status: 429,
            code: 'SPEND_LIMIT_EXCEEDED',
            details: { code: 'SPEND_LIMIT_EXCEEDED', message: 'Spend limit reached.' }
        }),
        false
    );
});

test('details.code alone still marks spend cap as permanent', () => {
    const error = {
        status: 429,
        message: 'Request rejected by upstream gateway',
        details: { code: 'SPEND_LIMIT_EXCEEDED' }
    };
    assert.equal(hasPermanentErrorSignal(error), true);
    assert.equal(isRateLimitLikeError(error), false);
});

test('Cline insufficient credits (balance) is not retryable', () => {
    assert.equal(
        isRateLimitLikeError({
            code: 'insufficient_credits',
            message: 'You have run out of credits.',
            details: { current_balance: 0 }
        }),
        false
    );
});

test('details.current_balance=0 alone still marks balance exhaustion as permanent', () => {
    const error = {
        status: 429,
        message: 'Request rejected by upstream gateway',
        details: { current_balance: 0 }
    };
    assert.equal(hasPermanentErrorSignal(error), true);
    assert.equal(isRateLimitLikeError(error), false);
});

test('positive current_balance does not trigger permanent error by itself', () => {
    const error = {
        status: 429,
        message: 'Too many requests',
        details: { current_balance: 12.5 }
    };
    assert.equal(hasPermanentErrorSignal(error), false);
    assert.equal(isRateLimitLikeError(error), true);
});

// code 在传递链中丢失、只剩消息文案时的兜底：周期词与配额词之间夹带品牌词也要命中

test('ClinePass weekly cap message-only (code lost in transit) is permanent', () => {
    const error = {
        message:
            'Error 429: You have reached your weekly Clinepass limit. The limit resets in 5h 7m, please try again later.'
    };
    assert.equal(hasPermanentErrorSignal(error), true);
    assert.equal(isRateLimitLikeError(error), false);
});

test('daily/monthly limit message-only variants are permanent', () => {
    assert.equal(isRateLimitLikeError({ message: 'Error 429: daily limit reached, try again tomorrow' }), false);
    assert.equal(isRateLimitLikeError({ message: 'You have exceeded your monthly quota for this model' }), false);
    assert.equal(isRateLimitLikeError({ message: '已达到本周每周限额，请下周再试' }), false);
});

test('transient rate limit with try-again-later wording stays retryable', () => {
    // 无周期词的普通过载提示仍属可重试（守卫不得扩大误伤）
    assert.equal(isRateLimitLikeError({ message: 'Rate limit exceeded, please try again later.' }), true);
    assert.equal(hasPermanentErrorSignal({ message: 'Rate limit exceeded, please try again later.' }), false);
});

// 以下用例对照 ChatGPT Codex 套餐用量限额的真实错误样例（resets_in_seconds 以天计，重试无意义）

test('ChatGPT Codex usage_limit_reached (nested error.type + 429) is not retryable', () => {
    const error = {
        status: 429,
        message: 'Connection error.',
        error: {
            type: 'usage_limit_reached',
            message: 'The usage limit has been reached',
            plan_type: 'plus',
            resets_in_seconds: 512095
        }
    };
    assert.equal(hasPermanentErrorSignal(error), true);
    assert.equal(isRateLimitLikeError(error), false);
});

test('usage limit message-only (structured fields lost) is permanent', () => {
    const error = { message: 'The usage limit has been reached' };
    assert.equal(hasPermanentErrorSignal(error), true);
    assert.equal(isRateLimitLikeError(error), false);
});

test('usage_limit_reached as top-level code is permanent', () => {
    assert.equal(isRateLimitLikeError({ status: 429, code: 'usage_limit_reached', message: 'rejected' }), false);
});
