import assert from 'node:assert/strict';
import test from 'node:test';

import { isRateLimitLikeError } from './retryClassifier';

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
