import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderData } from '../types';
import { buildProviderStatsTotalNativeSplit } from './providerStats';

function createProvider(overrides: Partial<ProviderData>): ProviderData {
    return {
        providerKey: overrides.providerKey ?? 'provider',
        providerName: overrides.providerName ?? 'Provider',
        models: overrides.models ?? {},
        estimatedInput: overrides.estimatedInput ?? 0,
        actualInput: overrides.actualInput ?? 0,
        cacheTokens: overrides.cacheTokens ?? 0,
        outputTokens: overrides.outputTokens ?? 0,
        requests: overrides.requests ?? 0,
        costedRequests: overrides.costedRequests ?? 0,
        rmbExactRequests: overrides.rmbExactRequests ?? 0,
        completedRequests: overrides.completedRequests ?? 0,
        failedRequests: overrides.failedRequests ?? 0,
        cancelledRequests: overrides.cancelledRequests ?? 0,
        firstTokenLatency: overrides.firstTokenLatency ?? 0,
        outputSpeeds: overrides.outputSpeeds ?? 0,
        estimatedCost: overrides.estimatedCost ?? 0,
        estimatedCostRmb: overrides.estimatedCostRmb ?? 0,
        inputCost: overrides.inputCost ?? 0,
        inputCostRmb: overrides.inputCostRmb ?? 0,
        outputCost: overrides.outputCost ?? 0,
        outputCostRmb: overrides.outputCostRmb ?? 0,
        cacheReadCost: overrides.cacheReadCost ?? 0,
        cacheReadCostRmb: overrides.cacheReadCostRmb ?? 0,
        cacheWriteCost: overrides.cacheWriteCost ?? 0,
        cacheWriteCostRmb: overrides.cacheWriteCostRmb ?? 0,
        nativeCosts: overrides.nativeCosts
    };
}

test('buildProviderStatsTotalNativeSplit sums displayed provider native costs instead of stale total index', () => {
    globalThis.window = {
        usagesState: {
            dateDetails: {
                nativeSplitIndex: {
                    total: {
                        totalUsd: 0.00001,
                        totalRmb: 0.06,
                        inputUsd: 0.00001,
                        inputRmb: 0.05,
                        outputUsd: 0,
                        outputRmb: 0.01,
                        cacheReadUsd: 0,
                        cacheReadRmb: 0.001,
                        cacheWriteUsd: 0,
                        cacheWriteRmb: 0
                    },
                    providers: {},
                    models: {},
                    hours: {},
                    hourProviders: {},
                    hourModels: {}
                }
            }
        }
    } as unknown as typeof window;

    const total = buildProviderStatsTotalNativeSplit([
        createProvider({
            providerKey: 'codex',
            nativeCosts: {
                totalUsd: 8.27,
                totalRmb: 0,
                inputUsd: 2.14,
                inputRmb: 0,
                outputUsd: 1.85,
                outputRmb: 0,
                cacheReadUsd: 4.28,
                cacheReadRmb: 0,
                cacheWriteUsd: 0,
                cacheWriteRmb: 0
            }
        }),
        createProvider({
            providerKey: 'deepseek',
            nativeCosts: {
                totalUsd: 0,
                totalRmb: 0.06,
                inputUsd: 0,
                inputRmb: 0.05,
                outputUsd: 0,
                outputRmb: 0.01,
                cacheReadUsd: 0,
                cacheReadRmb: 0.001,
                cacheWriteUsd: 0,
                cacheWriteRmb: 0
            }
        })
    ]);

    assert.deepEqual(total, {
        totalUsd: 8.27,
        totalRmb: 0.06,
        inputUsd: 2.14,
        inputRmb: 0.05,
        outputUsd: 1.85,
        outputRmb: 0.01,
        cacheReadUsd: 4.28,
        cacheReadRmb: 0.001,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    });
});

test('buildProviderStatsTotalNativeSplit falls back to provider index split when provider native costs are absent', () => {
    globalThis.window = {
        usagesState: {
            dateDetails: {
                nativeSplitIndex: {
                    total: {
                        totalUsd: 0,
                        totalRmb: 0,
                        inputUsd: 0,
                        inputRmb: 0,
                        outputUsd: 0,
                        outputRmb: 0,
                        cacheReadUsd: 0,
                        cacheReadRmb: 0,
                        cacheWriteUsd: 0,
                        cacheWriteRmb: 0
                    },
                    providers: {
                        fallback: {
                            totalUsd: 1.23,
                            totalRmb: 0,
                            inputUsd: 0.5,
                            inputRmb: 0,
                            outputUsd: 0.25,
                            outputRmb: 0,
                            cacheReadUsd: 0.48,
                            cacheReadRmb: 0,
                            cacheWriteUsd: 0,
                            cacheWriteRmb: 0
                        }
                    },
                    models: {},
                    hours: {},
                    hourProviders: {},
                    hourModels: {}
                }
            }
        }
    } as unknown as typeof window;

    const total = buildProviderStatsTotalNativeSplit([createProvider({ providerKey: 'fallback' })]);

    assert.deepEqual(total, {
        totalUsd: 1.23,
        totalRmb: 0,
        inputUsd: 0.5,
        inputRmb: 0,
        outputUsd: 0.25,
        outputRmb: 0,
        cacheReadUsd: 0.48,
        cacheReadRmb: 0,
        cacheWriteUsd: 0,
        cacheWriteRmb: 0
    });
});
