import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseStats, NativeCostSplit } from '../../usages/fileLogger/types';
import { getStatsNativeCostSplit, meanWithoutOutliers } from './utils';

function createNativeCostSplit(overrides: Partial<NativeCostSplit> = {}): NativeCostSplit {
    return {
        totalUsd: overrides.totalUsd ?? 0,
        totalRmb: overrides.totalRmb ?? 0,
        inputUsd: overrides.inputUsd ?? 0,
        inputRmb: overrides.inputRmb ?? 0,
        outputUsd: overrides.outputUsd ?? 0,
        outputRmb: overrides.outputRmb ?? 0,
        cacheReadUsd: overrides.cacheReadUsd ?? 0,
        cacheReadRmb: overrides.cacheReadRmb ?? 0,
        cacheWriteUsd: overrides.cacheWriteUsd ?? 0,
        cacheWriteRmb: overrides.cacheWriteRmb ?? 0
    };
}

function createBaseStats(nativeCosts?: NativeCostSplit): BaseStats {
    return {
        estimatedInput: 0,
        actualInput: 0,
        cacheTokens: 0,
        outputTokens: 0,
        requests: 0,
        costedRequests: 0,
        rmbExactRequests: 0,
        estimatedCost: 0,
        estimatedCostRmb: 0,
        inputCost: 0,
        inputCostRmb: 0,
        outputCost: 0,
        outputCostRmb: 0,
        cacheReadCost: 0,
        cacheReadCostRmb: 0,
        cacheWriteCost: 0,
        cacheWriteCostRmb: 0,
        nativeCosts
    };
}

test('meanWithoutOutliers returns median when MAD collapses with extreme outlier', () => {
    assert.equal(meanWithoutOutliers([100, 100, 5000]), 100);
    assert.equal(meanWithoutOutliers([100, 100, 100, 5000]), 100);
});

test('meanWithoutOutliers still downweights outliers when MAD is non-zero', () => {
    const result = meanWithoutOutliers([100, 101, 102, 5000]);

    assert.notEqual(result, undefined);
    assert.ok(result! > 100);
    assert.ok(result! < 103);
});

test('getStatsNativeCostSplit prefers record-derived fallback over stale cached split', () => {
    const cached = createNativeCostSplit({
        totalUsd: 8.33,
        totalRmb: 0.06,
        cacheReadUsd: 0,
        cacheReadRmb: 0.001
    });
    const fallback = createNativeCostSplit({
        totalUsd: 8.33,
        totalRmb: 0.06,
        cacheReadUsd: 4.28,
        cacheReadRmb: 0.001
    });

    const result = getStatsNativeCostSplit(createBaseStats(cached), fallback);

    assert.deepEqual(result, fallback);
});

test('getStatsNativeCostSplit still falls back to cached split when record-derived split is absent', () => {
    const cached = createNativeCostSplit({
        totalUsd: 1.23,
        cacheReadUsd: 0.48
    });

    const result = getStatsNativeCostSplit(createBaseStats(cached), undefined);

    assert.deepEqual(result, cached);
});
