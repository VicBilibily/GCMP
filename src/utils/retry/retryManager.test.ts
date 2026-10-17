import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

const logs: string[] = [];
let managerModule: Promise<typeof import('./retryManager')> | undefined;

function loadRetryManager() {
    if (managerModule) {
        return managerModule;
    }
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === '../runtime/logger') {
            const log = (message: string) => logs.push(message);
            return { Logger: { trace: log, debug: log, info: log, warn: log, error: log } };
        }
        if (id === '../runtime/l10n') {
            return { t: (english: string) => english };
        }
        return originalRequire.call(this, id);
    };
    managerModule = import('./retryManager').finally(() => {
        NodeModule.prototype.require = originalRequire;
    });
    return managerModule;
}

for (const code of [
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT'
]) {
    test(`network classification recognizes structured ${code} without a matching message`, async () => {
        const { RetryManager } = await loadRetryManager();
        const error = Object.assign(new Error('transport failed'), { code });
        assert.equal(RetryManager.isNetworkError(error), true);
        assert.equal(RetryManager.isNetworkError(new Error('Connection error.', { cause: error })), true);
    });
}

test('network classification recognizes an unwrapped socket close', async () => {
    const { RetryManager } = await loadRetryManager();
    assert.equal(RetryManager.isNetworkError(new Error('other side closed')), true);
    assert.equal(RetryManager.isNetworkError(new Error('the other side closed my account')), false);
});

test('network classification retains cancellation and permanent error vetoes throughout the chain', async () => {
    const { RetryManager } = await loadRetryManager();
    for (const cancellation of [
        Object.assign(new Error('terminated'), { name: 'AbortError' }),
        Object.assign(new Error('terminated'), { code: 'UND_ERR_ABORTED' }),
        Object.assign(new Error('terminated'), { code: 'ABORT_ERR' })
    ]) {
        assert.equal(RetryManager.isNetworkError(cancellation), false);
        assert.equal(RetryManager.isNetworkError(new Error('fetch failed', { cause: cancellation })), false);
    }
    const permanent = Object.assign(new Error('terminated'), {
        cause: { code: 'UND_ERR_SOCKET', error: { type: 'usage_limit_reached' } }
    });
    assert.equal(RetryManager.isNetworkError(permanent), false);
});

test('network classification does not reinterpret an HTTP business error as a transport failure', async () => {
    const { RetryManager } = await loadRetryManager();
    for (const status of [400, 401, 403, 499]) {
        assert.equal(RetryManager.isNetworkError(Object.assign(new Error('terminated'), { status })), false);
    }
    assert.equal(
        RetryManager.isNetworkError(Object.assign(new Error('the agent canceled the request'), { status: 499 })),
        false
    );
});

test('network classification handles cyclic and plain-object causes', async () => {
    const { RetryManager } = await loadRetryManager();
    const error = new Error('Connection error.');
    const cause = { code: 'UND_ERR_SOCKET', cause: error };
    error.cause = cause;
    assert.equal(RetryManager.isNetworkError(error), true);
    error.cause = error;
    assert.equal(RetryManager.isNetworkError(error), false);
});

test('network failure before output uses the existing retry budget and preserves the last error', async () => {
    const { RetryManager } = await loadRetryManager();
    const manager = new RetryManager({ enabled: true, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 });
    const error = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    let attempts = 0;
    await assert.rejects(
        manager.executeWithRetry(
            async () => {
                attempts++;
                throw error;
            },
            RetryManager.isNetworkError,
            'test'
        ),
        caught => caught === error
    );
    assert.equal(attempts, 2);
});

test('network retry stays disabled when configured and keeps a zero retry budget', async () => {
    const { RetryManager } = await loadRetryManager();
    const error = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    for (const config of [
        { enabled: false, maxAttempts: 3 },
        { enabled: true, maxAttempts: 0 }
    ]) {
        let attempts = 0;
        const manager = new RetryManager({ ...config, initialDelayMs: 0 });
        await assert.rejects(
            manager.executeWithRetry(
                async () => {
                    attempts++;
                    throw error;
                },
                RetryManager.isNetworkError,
                'test'
            ),
            caught => caught === error
        );
        assert.equal(attempts, 1);
    }
});

test('cancellation after scheduling a retry prevents the next transport attempt', async () => {
    const { RetryManager } = await loadRetryManager();
    const manager = new RetryManager({ maxAttempts: 2, initialDelayMs: 1000 });
    let cancelled = false;
    let attempts = 0;
    await assert.rejects(
        manager.executeWithRetry(
            async () => {
                attempts++;
                throw new Error('other side closed');
            },
            RetryManager.isNetworkError,
            'test',
            {
                shouldCancel: () => cancelled,
                onRetryScheduled: () => {
                    cancelled = true;
                }
            }
        ),
        error => error instanceof Error && error.name === 'Canceled'
    );
    assert.equal(attempts, 1);
});

test('network classification conservatively rejects chains beyond its inspection budget', async () => {
    const { RetryManager } = await loadRetryManager();
    let error = new Error('terminated');
    for (let index = 0; index < 100; index++) {
        error = new Error('terminated', { cause: error });
    }
    assert.equal(RetryManager.isNetworkError(error), false);
});
