import assert from 'node:assert/strict';
import test from 'node:test';

import { StatsCalculator } from './statsCalculator';
import type { TokenRequestLog } from './types';
import type {
    RequestClassificationMetadata,
    RequestContinuity
} from '../../handlers/classification/requestClassification';

const classification: RequestClassificationMetadata = {
    version: 1,
    requestOrigin: 'copilot-sdk',
    agentRole: 'undetermined',
    evidence: {
        origin: { level: 'signature', ruleId: 'sdk-identity' },
        purpose: { level: 'unknown' },
        role: { level: 'unknown' }
    }
};
const continuity: RequestContinuity = { version: 1, scope: 'chain', source: 'marker' };

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    test(`raw ${status} merge preserves estimated classification and continuity`, () => {
        const estimated = { ...createLog(), requestClassification: classification, requestContinuity: continuity };
        const terminal = createLog({
            status,
            timestamp: 2000,
            rawUsage: { prompt_tokens: 80, completion_tokens: 20 },
            estimatedCost: 0.125
        });
        const merged = StatsCalculator.mergeLogsByRequestId([estimated, terminal]).get('req-1')!;
        assert.deepEqual(merged.requestClassification, classification);
        assert.deepEqual(merged.requestContinuity, continuity);
        assert.equal(merged.timestamp, estimated.timestamp);
        assert.equal(merged.status, status);
        assert.deepEqual(merged.rawUsage, terminal.rawUsage);
        assert.equal(merged.estimatedCost, 0.125);
    });
}

test('raw merge upgrades an old writer record without changing request kind or initiator', () => {
    const estimated = createLog({ requestKind: 'background', requestInitiator: 'core' });
    const terminal = {
        ...createLog({ status: 'completed', rawUsage: { prompt_tokens: 80, completion_tokens: 20 } }),
        requestClassification: classification,
        requestContinuity: continuity
    };
    const merged = StatsCalculator.mergeLogsByRequestId([estimated, terminal]).get('req-1')!;
    assert.deepEqual(merged.requestClassification, classification);
    assert.deepEqual(merged.requestContinuity, continuity);
    assert.equal(merged.requestKind, 'background');
    assert.equal(merged.requestInitiator, 'core');
});

for (const level of ['heuristic', 'signature', 'contract'] as const) {
    test(`raw merge selects kind and purpose together with ${level} incoming evidence`, () => {
        const estimated = {
            ...createLog({ requestKind: 'main-agent' }),
            requestClassification: {
                ...classification,
                evidence: {
                    ...classification.evidence,
                    purpose: { level: 'signature' as const, ruleId: 'main-purpose' }
                }
            }
        };
        const terminal = {
            ...createLog({
                status: 'completed',
                timestamp: 2000,
                requestKind: 'chat-title',
                rawUsage: { prompt_tokens: 80, completion_tokens: 20 },
                estimatedCost: 0.125
            }),
            requestClassification: {
                ...classification,
                evidence: { ...classification.evidence, purpose: { level, ruleId: 'title-purpose' } }
            }
        };
        const before = structuredClone([estimated, terminal]);
        const merged = StatsCalculator.mergeLogsByRequestId([estimated, terminal]).get('req-1')!;
        assert.equal(
            merged.requestKind,
            level === 'signature' ? 'unclassified'
            : level === 'contract' ? 'chat-title'
            : 'main-agent'
        );
        assert.deepEqual(
            merged.requestClassification?.evidence.purpose,
            level === 'signature' ?
                { level: 'unknown', conflictLevel: 'signature', reasonCode: 'classification-conflict' }
            :   (level === 'contract' ? terminal : estimated).requestClassification.evidence.purpose
        );
        assert.equal(merged.timestamp, 1000);
        assert.equal(merged.status, 'completed');
        assert.equal(merged.estimatedCost, 0.125);
        assert.deepEqual(merged.rawUsage, terminal.rawUsage);
        assert.deepEqual([estimated, terminal], before);
    });
}

test('raw metadata without kind preserves the existing kind and purpose pair', () => {
    const estimated = { ...createLog({ requestKind: 'main-agent' }), requestClassification: classification };
    const terminal = {
        ...createLog({ status: 'completed' }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level: 'contract' as const, ruleId: 'orphan-purpose' } }
        }
    };
    const merged = StatsCalculator.mergeLogsByRequestId([estimated, terminal]).get('req-1')!;
    assert.equal(merged.requestKind, 'main-agent');
    assert.deepEqual(merged.requestClassification?.evidence.purpose, classification.evidence.purpose);
});

test('raw serialized signature conflict rejects equal/weaker evidence and accepts contract commit', () => {
    const first = {
        ...createLog({ requestKind: 'main-agent' }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level: 'signature' as const, ruleId: 'main-purpose' } }
        }
    };
    const second = { ...first, requestKind: 'chat-title' };
    const conflicted = StatsCalculator.mergeLogsByRequestId([first, second]).get('req-1')!;
    assert.equal(conflicted.requestKind, 'unclassified');
    assert.deepEqual(conflicted.requestClassification?.evidence.purpose, {
        level: 'unknown',
        conflictLevel: 'signature',
        reasonCode: 'classification-conflict'
    });
    const restored = JSON.parse(JSON.stringify(conflicted)) as TokenRequestLog;
    for (const level of ['unknown', 'heuristic', 'signature'] as const) {
        const update = {
            ...first,
            requestClassification: {
                ...classification,
                evidence: { ...classification.evidence, purpose: { level, ruleId: 'repeated-main' } }
            }
        };
        for (const logs of [
            [restored, update],
            [update, restored]
        ]) {
            const merged = StatsCalculator.mergeLogsByRequestId(logs).get('req-1')!;
            assert.equal(merged.requestKind, 'unclassified');
            assert.deepEqual(merged.requestClassification, conflicted.requestClassification);
        }
    }
    const third = {
        ...createLog({ requestKind: 'git-commit-message', status: 'completed', estimatedCost: 0.5 }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level: 'contract' as const, ruleId: 'commit-purpose' } }
        }
    };
    const merged = StatsCalculator.mergeLogsByRequestId([restored, third]).get('req-1')!;
    assert.equal(merged.requestKind, 'git-commit-message');
    assert.deepEqual(merged.requestClassification, third.requestClassification);
    assert.equal(merged.status, 'completed');
    assert.equal(merged.estimatedCost, 0.5);
});

test('raw contract commit wins over signature main/title in all orders and merge groups', () => {
    const [first, second, third] = (
        [
            ['main-agent', 'signature', 'main-purpose'],
            ['chat-title', 'signature', 'title-purpose'],
            ['git-commit-message', 'contract', 'commit-purpose']
        ] as const
    ).map(([requestKind, level, ruleId]) => ({
        ...createLog({ requestKind }),
        requestClassification: {
            ...classification,
            evidence: { ...classification.evidence, purpose: { level, ruleId } }
        }
    }));
    const before = structuredClone([first, second, third]);
    for (const [a, b, c] of [
        [first, second, third],
        [first, third, second],
        [second, first, third],
        [second, third, first],
        [third, first, second],
        [third, second, first]
    ]) {
        const ab = StatsCalculator.mergeLogsByRequestId([a, b]).get('req-1')!;
        const bc = StatsCalculator.mergeLogsByRequestId([b, c]).get('req-1')!;
        const restoredAB = JSON.parse(JSON.stringify(ab)) as TokenRequestLog;
        const restoredBC = JSON.parse(JSON.stringify(bc)) as TokenRequestLog;
        for (const logs of [
            [a, b, c],
            [ab, c],
            [a, bc],
            [restoredAB, c],
            [a, restoredBC]
        ]) {
            const merged = StatsCalculator.mergeLogsByRequestId(logs).get('req-1')!;
            assert.equal(merged.requestKind, 'git-commit-message');
            assert.deepEqual(merged.requestClassification, third.requestClassification);
        }
    }
    assert.deepEqual([first, second, third], before);
});

test('raw classification conflict does not overwrite stronger role evidence', () => {
    const reliable: RequestClassificationMetadata = {
        ...classification,
        agentRole: 'main',
        evidence: { ...classification.evidence, role: { level: 'contract', ruleId: 'explicit-main' } }
    };
    const weaker: RequestClassificationMetadata = {
        ...classification,
        agentRole: 'subagent',
        evidence: { ...classification.evidence, role: { level: 'heuristic', ruleId: 'weak-role' } }
    };
    const merged = StatsCalculator.mergeLogsByRequestId([
        { ...createLog(), requestClassification: reliable },
        { ...createLog({ status: 'completed', estimatedCost: 0.5 }), requestClassification: weaker }
    ]).get('req-1')!;
    assert.equal(merged.requestClassification?.agentRole, 'main');
    assert.equal(merged.requestClassification?.evidence.role.level, 'contract');
    assert.equal(merged.status, 'completed');
    assert.equal(merged.estimatedCost, 0.5);
});

for (const badMetadata of [null, { version: 2 }, { ...classification, requestOrigin: 'future-origin' }]) {
    test(`raw reader drops unsupported metadata ${JSON.stringify(badMetadata)} but keeps costs`, () => {
        const log = {
            ...createLog({
                status: 'completed',
                rawUsage: { prompt_tokens: 80, completion_tokens: 20 },
                estimatedCost: 0.5
            }),
            requestClassification: badMetadata,
            requestContinuity: { version: 1, scope: 'future-scope', source: 'marker' }
        } as unknown as TokenRequestLog;
        const merged = StatsCalculator.mergeLogsByRequestId([log]).get('req-1')!;
        assert.equal(merged.requestClassification, undefined);
        assert.equal(merged.requestContinuity, undefined);
        const legacy = { ...log, requestClassification: undefined, requestContinuity: undefined };
        assert.deepEqual(StatsCalculator.aggregateLogs([log]), StatsCalculator.aggregateLogs([legacy]));
        const preserved = StatsCalculator.mergeLogsByRequestId([
            { ...createLog(), requestClassification: classification, requestContinuity: continuity },
            log
        ]).get('req-1')!;
        assert.deepEqual(preserved.requestClassification, classification);
        assert.deepEqual(preserved.requestContinuity, continuity);
    });
}

function createLog(overrides: Partial<TokenRequestLog> = {}): TokenRequestLog {
    return {
        requestId: overrides.requestId ?? 'req-1',
        timestamp: overrides.timestamp ?? 1000,
        isoTime: overrides.isoTime ?? '1970-01-01T00:00:01.000Z',
        providerKey: overrides.providerKey ?? 'provider',
        providerName: overrides.providerName ?? 'Provider',
        apiKeyHash: overrides.apiKeyHash,
        apiKeyName: overrides.apiKeyName,
        modelId: overrides.modelId ?? 'model',
        modelName: overrides.modelName ?? 'Model',
        estimatedInput: overrides.estimatedInput ?? 80,
        rawUsage: overrides.rawUsage ?? null,
        status: overrides.status ?? 'estimated',
        maxInputTokens: overrides.maxInputTokens,
        requestKind: overrides.requestKind,
        sessionId: overrides.sessionId,
        sessionRecoverySource: overrides.sessionRecoverySource,
        sessionTitle: overrides.sessionTitle,
        requestInitiator: overrides.requestInitiator,
        capturingTokenCorrelationId: overrides.capturingTokenCorrelationId,
        otelTraceContext: overrides.otelTraceContext,
        telemetryTurn: overrides.telemetryTurn,
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

for (const duration of [1, 3, 14, 99]) {
    test(`aggregateLogs includes a single-token request completed in ${duration}ms`, () => {
        const stats = StatsCalculator.aggregateLogs([
            createLog({
                status: 'completed',
                rawUsage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
                streamStartTime: 1200,
                streamEndTime: 1200 + duration
            })
        ]);
        const speed = (1 / duration) * 1000;
        assert.equal(stats.providers.provider.models.model.outputSpeeds, speed);
    });
}

test('aggregateLogs counts failed request actual usage when rawUsage exists', () => {
    const stats = StatsCalculator.aggregateLogs([
        createLog({
            status: 'failed',
            estimatedInput: 90,
            rawUsage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120
            },
            estimatedCost: 0.1
        })
    ]);

    assert.equal(stats.total.requests, 1);
    assert.equal(stats.total.failedRequests, 1);
    assert.equal(stats.total.estimatedInput, 90);
    assert.equal(stats.total.actualInput, 100);
    assert.equal(stats.total.outputTokens, 20);
    assert.equal(stats.total.estimatedCost, 0.1);

    const provider = stats.providers.provider;
    assert.ok(provider);
    assert.equal(provider.failedRequests, 1);
    assert.equal(provider.actualInput, 100);
    assert.equal(provider.outputTokens, 20);

    const model = provider.models.model;
    assert.ok(model);
    assert.equal(model.requests, 1);
    assert.equal(model.actualInput, 100);
    assert.equal(model.outputTokens, 20);
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

    // 模型维度必须同步计入，保证 provider 合计与 models 求和一致
    const model = provider.models.model;
    assert.ok(model);
    assert.equal(model.requests, 1);
    assert.equal(model.estimatedInput, 90);
    assert.equal(model.actualInput, 90);
    assert.equal(model.outputTokens, 0);
});

test('mergeLogsByRequestId keeps late session title backfill metadata', () => {
    const merged = StatsCalculator.mergeLogsByRequestId([
        createLog({
            requestId: 'req-session-title',
            timestamp: 1000,
            isoTime: '1970-01-01T00:00:01.000Z',
            requestKind: 'main-agent',
            sessionId: 'session-1',
            sessionRecoverySource: 'summary-bridge-exact',
            telemetryTurn: 3
        }),
        createLog({
            requestId: 'req-session-title',
            timestamp: 1500,
            isoTime: '1970-01-01T00:00:01.500Z',
            status: 'completed',
            rawUsage: {
                prompt_tokens: 80,
                completion_tokens: 20,
                total_tokens: 100
            }
        }),
        createLog({
            requestId: 'req-session-title',
            timestamp: 2000,
            isoTime: '1970-01-01T00:00:02.000Z',
            status: 'completed',
            sessionId: 'session-1',
            sessionTitle: '新的会话标题',
            outputSpeed: 12.5,
            outputTokens: 20,
            streamStartTime: 1600,
            streamEndTime: 1900
        })
    ]);

    const record = merged.get('req-session-title');
    assert.ok(record);
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.sessionRecoverySource, 'summary-bridge-exact');
    assert.equal(record.sessionTitle, '新的会话标题');
    assert.equal(record.requestKind, 'main-agent');
    assert.equal(record.telemetryTurn, 3);
    assert.equal(record.outputSpeed, 12.5);
    assert.equal(record.outputTokens, 20);
    assert.equal(record.streamStartTime, 1600);
    assert.equal(record.streamEndTime, 1900);
});

for (const status of ['completed', 'failed', 'cancelled'] as const) {
    test(`mergeLogsByRequestId uses the ${status} request key identity`, () => {
        const merged = StatsCalculator.mergeLogsByRequestId([
            createLog({
                requestId: `req-key-${status}`,
                status: 'estimated',
                apiKeyHash: 'old-hash',
                apiKeyName: 'Old name'
            }),
            createLog({
                requestId: `req-key-${status}`,
                timestamp: 2000,
                isoTime: '1970-01-01T00:00:02.000Z',
                status,
                apiKeyHash: 'terminal-hash',
                apiKeyName: 'Terminal name'
            })
        ]).get(`req-key-${status}`);

        assert.equal(merged?.apiKeyHash, 'terminal-hash');
        assert.equal(merged?.apiKeyName, 'Terminal name');
    });
}

test('mergeLogsByRequestId does not retain a stale request key identity', () => {
    const merged = StatsCalculator.mergeLogsByRequestId([
        createLog({ apiKeyHash: 'old-hash', apiKeyName: 'Old name' }),
        createLog({ timestamp: 2000, isoTime: '1970-01-01T00:00:02.000Z', status: 'completed' })
    ]).get('req-1');

    assert.ok(merged);
    assert.equal(merged.apiKeyHash, undefined);
    assert.equal(merged.apiKeyName, undefined);
});

test('mergeLogsByRequestId keeps late chat-title session reassignment', () => {
    const merged = StatsCalculator.mergeLogsByRequestId([
        createLog({
            requestId: 'req-chat-title',
            timestamp: 1000,
            isoTime: '1970-01-01T00:00:01.000Z',
            requestKind: 'chat-title',
            sessionId: 'temp-session',
            sessionRecoverySource: 'new-uuid'
        }),
        createLog({
            requestId: 'req-chat-title',
            timestamp: 1500,
            isoTime: '1970-01-01T00:00:01.500Z',
            status: 'completed',
            rawUsage: {
                prompt_tokens: 120,
                completion_tokens: 8,
                total_tokens: 128
            }
        }),
        createLog({
            requestId: 'req-chat-title',
            timestamp: 2000,
            isoTime: '1970-01-01T00:00:02.000Z',
            status: 'completed',
            rawUsage: {
                prompt_tokens: 120,
                completion_tokens: 8,
                total_tokens: 128
            },
            sessionId: 'main-session',
            sessionTitle: '查询 Vue 3.6 最新动态'
        })
    ]);

    const record = merged.get('req-chat-title');
    assert.ok(record);
    assert.equal(record.requestKind, 'chat-title');
    assert.equal(record.sessionId, 'main-session');
    assert.equal(record.sessionRecoverySource, 'new-uuid');
    assert.equal(record.sessionTitle, '查询 Vue 3.6 最新动态');
    assert.equal(record.rawUsage?.total_tokens, 128);
});
