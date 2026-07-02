import assert from 'node:assert/strict';
import test from 'node:test';

import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';

function createLog(overrides: Partial<TokenRequestLog> = {}): TokenRequestLog {
    return {
        requestId: overrides.requestId ?? 'req-1',
        timestamp: overrides.timestamp ?? 1000,
        isoTime: overrides.isoTime ?? '1970-01-01T00:00:01.000Z',
        providerKey: overrides.providerKey ?? 'provider',
        providerName: overrides.providerName ?? 'Provider',
        modelId: overrides.modelId ?? 'model',
        modelName: overrides.modelName ?? 'Model',
        estimatedInput: overrides.estimatedInput ?? 80,
        rawUsage: overrides.rawUsage ?? null,
        status: overrides.status ?? 'estimated',
        maxInputTokens: overrides.maxInputTokens,
        requestKind: overrides.requestKind,
        sessionId: overrides.sessionId,
        requestInitiator: overrides.requestInitiator,
        capturingTokenCorrelationId: overrides.capturingTokenCorrelationId,
        otelTraceContext: overrides.otelTraceContext,
        streamStartTime: overrides.streamStartTime,
        streamEndTime: overrides.streamEndTime,
        outputSpeed: overrides.outputSpeed,
        outputTokens: overrides.outputTokens
    };
}

test('aggregateLogs counts cancelled request actual usage when rawUsage exists', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'cancelled',
            estimatedInput: 90,
            rawUsage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
                prompt_tokens_details: {
                    cached_tokens: 30
                }
            },
            streamStartTime: 1200,
            streamEndTime: 2200
        })
    ]);

    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.completedRequests, 0);
    assert.equal(stats.total.failedRequests, 0);
    assert.equal(stats.total.cancelledRequests, 1);
    assert.equal(stats.total.estimatedInput, 90);
    assert.equal(stats.total.actualInput, 100);
    assert.equal(stats.total.cacheTokens, 30);
    assert.equal(stats.total.outputTokens, 20);

    const provider = stats.providers.provider;
    assert.ok(provider);
    assert.equal(provider.cancelledRequests, 1);
    assert.equal(provider.actualInput, 100);
    assert.equal(provider.outputTokens, 20);

    const model = provider.models.model;
    assert.ok(model);
    assert.equal(model.requests, 1);
    assert.equal(model.actualInput, 100);
    assert.equal(model.cacheTokens, 30);
    assert.equal(model.outputTokens, 20);
    assert.equal(model.firstTokenLatency, 200);
    assert.equal(model.outputSpeeds, 20);
});

test('aggregateLogs keeps cancelled request without rawUsage out of actual token totals', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'cancelled',
            estimatedInput: 90,
            rawUsage: null
        })
    ]);

    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.cancelledRequests, 1);
    assert.equal(stats.total.estimatedInput, 0);
    assert.equal(stats.total.actualInput, 0);
    assert.equal(stats.total.outputTokens, 0);

    const provider = stats.providers.provider;
    assert.ok(provider);
    assert.equal(provider.requests, 1);
    assert.equal(provider.cancelledRequests, 1);
    assert.deepEqual(provider.models, {});
});

test('aggregateLogs ignores empty rawUsage payload on cancelled request', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'cancelled',
            estimatedInput: 90,
            rawUsage: {}
        })
    ]);

    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.cancelledRequests, 1);
    assert.equal(stats.total.estimatedInput, 0);
    assert.equal(stats.total.actualInput, 0);
    assert.equal(stats.total.outputTokens, 0);

    const provider = stats.providers.provider;
    assert.ok(provider);
    assert.equal(provider.requests, 1);
    assert.equal(provider.cancelledRequests, 1);
    assert.deepEqual(provider.models, {});
});

test('aggregateLogs falls back to estimated input when completed request has empty rawUsage payload', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'completed',
            estimatedInput: 90,
            rawUsage: {}
        })
    ]);

    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.completedRequests, 1);
    assert.equal(stats.total.estimatedInput, 90);
    assert.equal(stats.total.actualInput, 90);
    assert.equal(stats.total.outputTokens, 0);

    const provider = stats.providers.provider;
    assert.ok(provider);
    assert.equal(provider.requests, 1);
    assert.equal(provider.completedRequests, 1);
    assert.equal(provider.actualInput, 90);
    assert.deepEqual(provider.models, {});
});
