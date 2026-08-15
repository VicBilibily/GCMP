import assert from 'node:assert/strict';

import type Anthropic from '@anthropic-ai/sdk';

import { AnthropicHandler } from '../../src/handlers/anthropicHandler';
import type { GenericModelProvider } from '../../src/providers/genericModelProvider';
import type { ModelConfig } from '../../src/types/sharedTypes';
import { getAnthropicRetryDelayMs, shouldRetryAnthropicRequest } from '../../src/handlers/anthropic/anthropicRetry';
import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { RetryManager } from '../../src/utils/retry/retryManager';

interface AnthropicHandlerTestAccess {
    createAnthropicClient(modelConfig?: ModelConfig): Promise<Anthropic>;
}

suite('Anthropic cancellation', () => {
    test('禁用 SDK 内部重试，由外层重试链统一处理', async () => {
        const originalGetApiKey = ApiKeyManager.getApiKey;
        ApiKeyManager.getApiKey = async () => 'test-api-key';

        try {
            const providerInstance = {
                provider: 'anthropic-test',
                providerConfig: {
                    displayName: 'Anthropic Test',
                    baseUrl: 'http://127.0.0.1'
                }
            } as unknown as GenericModelProvider;
            const handler = new AnthropicHandler(providerInstance) as unknown as AnthropicHandlerTestAccess;
            const client = await handler.createAnthropicClient({
                id: 'test-model',
                name: 'Test Model',
                tooltip: 'Test Model',
                maxInputTokens: 1024,
                maxOutputTokens: 128,
                capabilities: {
                    toolCalling: false,
                    imageInput: false
                },
                sdkMode: 'anthropic',
                provider: 'anthropic-test',
                baseUrl: 'http://127.0.0.1',
                proxy: 'noproxy'
            });

            assert.equal(client.maxRetries, 0);
        } finally {
            ApiKeyManager.getApiKey = originalGetApiKey;
        }
    });

    test('Retry-After 等待可在取消后及时结束', async () => {
        const retryManager = new RetryManager({
            enabled: true,
            maxAttempts: 3,
            initialDelayMs: 25,
            maxDelayMs: 100
        });
        let cancelled = false;
        let attempts = 0;
        let scheduledDelayMs: number | undefined;
        const retryError = Object.assign(new Error('rate limited'), {
            status: 429,
            headers: new Headers({ 'retry-after': '2' })
        });
        const cancellationTimer = setTimeout(() => {
            cancelled = true;
        }, 50);
        const startedAt = Date.now();

        try {
            await assert.rejects(
                retryManager.executeWithRetry(
                    async () => {
                        attempts++;
                        throw retryError;
                    },
                    error => shouldRetryAnthropicRequest(error, false),
                    'Anthropic Test',
                    {
                        shouldCancel: () => cancelled,
                        getRetryDelayMs: getAnthropicRetryDelayMs,
                        onRetryScheduled: (_attempt, _maxAttempts, delayMs) => {
                            scheduledDelayMs = delayMs;
                        }
                    }
                ),
                error => error instanceof Error && error.name === 'Canceled'
            );
        } finally {
            clearTimeout(cancellationTimer);
        }

        assert.equal(attempts, 1);
        assert.equal(scheduledDelayMs, 100);
        assert.ok(Date.now() - startedAt < 1000);
    });
});
