import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiKeyFailoverError } from './apiKeyFailoverClassifier';

test('counts every HTTP error toward API key failover', () => {
    for (const status of [400, 401, 403, 404, 408, 413, 422, 429, 500, 503, 529]) {
        assert.equal(isApiKeyFailoverError({ status }), true, `HTTP ${status}`);
        assert.equal(isApiKeyFailoverError({ statusCode: status }), true, `statusCode ${status}`);
    }
});

test('counts network, quota, request-shape, and unknown errors toward API key failover', () => {
    for (const error of [
        { code: 'ECONNRESET', message: 'socket terminated' },
        { message: 'Maximum context length exceeded' },
        { type: 'invalid_request_error', message: 'invalid model' },
        new Error('令牌额度不足：最低需预扣 ¥0.394818，令牌剩余额度 ¥0.379634。'),
        new Error('Connection error.', { cause: { status: 400, message: '令牌额度不足' } }),
        { status: 500, error: { code: 'quota_exceeded' } },
        { status: 429, cause: { code: 'ECONNRESET', message: 'socket hang up' } },
        new Error('unrecognized upstream failure')
    ]) {
        assert.equal(isApiKeyFailoverError(error), true);
    }
});

test('does not count cancellation errors even when wrapped with HTTP failures', () => {
    for (const name of ['Canceled', 'CancellationError', 'AbortError']) {
        const cancellation = Object.assign(new Error('request cancelled'), { name });
        assert.equal(isApiKeyFailoverError(cancellation), false);
        assert.equal(isApiKeyFailoverError({ status: 429, cause: cancellation }), false);
        assert.equal(isApiKeyFailoverError({ status: 503, error: cancellation }), false);
    }
    assert.equal(isApiKeyFailoverError({ constructor: { name: 'APIUserAbortError' } }), false);
});

test('counts non-Error thrown values toward API key failover', () => {
    for (const error of [undefined, null, false, 0, 'upstream failure', {}]) {
        assert.equal(isApiKeyFailoverError(error), true);
    }
});
