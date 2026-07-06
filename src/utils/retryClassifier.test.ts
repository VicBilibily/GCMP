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
