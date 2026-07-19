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
        outputTokens: overrides.outputTokens,
        estimatedCost: overrides.estimatedCost,
        costBreakdown: overrides.costBreakdown
    };
}

test('aggregateLogs tracks native cost split by source currency', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'completed',
            requestId: 'req-usd',
            timestamp: 1000,
            isoTime: '1970-01-01T00:00:01.000Z',
            estimatedInput: 100,
            rawUsage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120
            },
            estimatedCost: 0.12,
            costBreakdown: {
                tokens: [100, 20, 0, 0],
                pricing: [1, 1],
                cost: [0.04, 0.08],
                total: 0.12,
                currencies: {
                    USD: {
                        pricing: [1, 1],
                        cost: [0.04, 0.08],
                        total: 0.12
                    }
                }
            }
        }),
        createLog({
            status: 'completed',
            requestId: 'req-rmb',
            timestamp: 2000,
            isoTime: '1970-01-01T00:00:02.000Z',
            estimatedInput: 120,
            rawUsage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                total_tokens: 150
            },
            estimatedCost: 0.1,
            costBreakdown: {
                tokens: [120, 30, 0, 0],
                pricing: [1, 1],
                cost: [0.04, 0.06],
                total: 0.1,
                currencies: {
                    USD: {
                        pricing: [1, 1],
                        cost: [0.04, 0.06],
                        total: 0.1
                    },
                    RMB: {
                        pricing: [7, 7],
                        cost: [0.28, 0.42],
                        total: 0.7
                    }
                }
            }
        })
    ]);

    assert.deepEqual(stats.total.nativeCosts, {
        totalUsd: 0.12,
        totalRmb: 0.7,
        inputUsd: 0.04,
        inputRmb: 0.28,
        outputUsd: 0.08,
        outputRmb: 0.42,
        cacheReadUsd: 0,
        cacheReadRmb: 0,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    });
});

test('aggregateLogs keeps USD native total when only estimatedCost exists', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'completed',
            estimatedInput: 90,
            rawUsage: {
                prompt_tokens: 90,
                completion_tokens: 10,
                total_tokens: 100
            },
            estimatedCost: 0.12
        })
    ]);

    assert.deepEqual(stats.total.nativeCosts, {
        totalUsd: 0.12,
        totalRmb: 0,
        inputUsd: 0,
        inputRmb: 0,
        outputUsd: 0,
        outputRmb: 0,
        cacheReadUsd: 0,
        cacheReadRmb: 0,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    });
});

test('aggregateLogs provides the cost fields used by date index summaries', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'completed',
            requestId: 'req-index',
            estimatedInput: 100,
            rawUsage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120
            },
            estimatedCost: 0.1,
            costBreakdown: {
                tokens: [100, 20, 0, 0],
                pricing: [1, 1],
                cost: [0.04, 0.06],
                total: 0.1,
                currencies: {
                    USD: {
                        pricing: [1, 1],
                        cost: [0.04, 0.06],
                        total: 0.1
                    },
                    RMB: {
                        pricing: [7, 7],
                        cost: [0.28, 0.42],
                        total: 0.7
                    }
                }
            }
        })
    ]);

    assert.equal(stats.total.actualInput, 100);
    assert.equal(stats.total.cacheTokens, 0);
    assert.equal(stats.total.outputTokens, 20);
    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.estimatedCost, 0.1);
    assert.equal(stats.total.estimatedCostRmb, 0.7);
    assert.equal(stats.total.nativeCosts?.totalUsd, 0);
    assert.equal(stats.total.nativeCosts?.totalRmb, 0.7);
});

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
