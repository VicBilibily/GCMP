import assert from 'node:assert/strict';
import test from 'node:test';

import type { RetryableError } from '../../utils/retry/retryManager';
import { getAnthropicRetryDelayMs, shouldRetryAnthropicRequest } from './anthropicRetry';

function createError(properties: Partial<RetryableError>): RetryableError {
    return Object.assign(new Error(properties.message ?? 'request failed'), properties);
}

test('retries Anthropic connection errors, timeouts, and all 5xx responses', () => {
    assert.equal(shouldRetryAnthropicRequest(createError({ message: 'Connection error.' }), false), true);
    assert.equal(shouldRetryAnthropicRequest(createError({ message: 'Request timed out.' }), false), true);
    assert.equal(shouldRetryAnthropicRequest(createError({ status: 500 }), false), true);
    assert.equal(shouldRetryAnthropicRequest(createError({ statusCode: 501 }), false), true);
});

test('honors x-should-retry and provider-specific permanent-error policy', () => {
    assert.equal(
        shouldRetryAnthropicRequest(
            createError({ status: 429, headers: new Headers({ 'x-should-retry': 'false' }) }),
            true
        ),
        false
    );
    assert.equal(
        shouldRetryAnthropicRequest(
            createError({ status: 400, headers: new Headers({ 'x-should-retry': 'true' }) }),
            false
        ),
        true
    );

    const permanentError = Object.assign(createError({ status: 429 }), {
        error: { type: 'usage_limit_reached' }
    });
    assert.equal(shouldRetryAnthropicRequest(permanentError, true), true);
    assert.equal(shouldRetryAnthropicRequest(permanentError, false), false);
});

test('parses Anthropic retry-after headers', () => {
    assert.equal(
        getAnthropicRetryDelayMs(
            createError({ headers: new Headers({ 'retry-after-ms': '2500', 'retry-after': '9' }) })
        ),
        2500
    );
    assert.equal(getAnthropicRetryDelayMs(createError({ headers: new Headers({ 'retry-after': '2' }) })), 2000);
    assert.equal(getAnthropicRetryDelayMs(createError({ headers: new Headers({ 'retry-after': '1.5' }) })), 1500);
    assert.equal(getAnthropicRetryDelayMs(createError({ headers: new Headers() })), undefined);
});

test('clamps zero or past retry-after hints to a minimum delay', () => {
    assert.equal(getAnthropicRetryDelayMs(createError({ headers: new Headers({ 'retry-after-ms': '0' }) })), 1000);
    assert.equal(getAnthropicRetryDelayMs(createError({ headers: new Headers({ 'retry-after': '0' }) })), 1000);
    assert.equal(
        getAnthropicRetryDelayMs(createError({ headers: new Headers({ 'retry-after': '2000-01-01T00:00:00Z' }) })),
        1000
    );
});
