import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseStats, NativeCostSplit } from '../../usages/fileLogger/types';
import {
    getCurrencyToggleTitle,
    getNextDisplayCurrency,
    getStatsNativeCostSplit,
    meanWithoutOutliers,
    normalizeDisplayCurrency
} from './utils';

function withLocaleAndState<T>(options: { lang: string; rmbExactRequests?: number }, fn: () => T): T {
    const globals = globalThis as typeof globalThis & {
        document?: unknown;
        window?: unknown;
    };
    const previousDocument = globals.document;
    const previousWindow = globals.window;

    globals.document = { documentElement: { lang: options.lang } } as Document;
    globals.window = {
        usagesState: {
            dateDetails: {
                allTotals: {
                    rmbExactRequests: options.rmbExactRequests ?? 0
                }
            }
        }
    } as Window & typeof globalThis;

    try {
        return fn();
    } finally {
        globals.document = previousDocument;
        globals.window = previousWindow;
    }
}

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

test('normalizeDisplayCurrency downgrades MIXED to USD when current dataset has no exact RMB pricing', () => {
    withLocaleAndState({ lang: 'zh-CN', rmbExactRequests: 0 }, () => {
        assert.equal(normalizeDisplayCurrency('MIXED'), 'USD');
    });
});

test('getNextDisplayCurrency toggles only between USD and RMB when current dataset has no exact RMB pricing', () => {
    withLocaleAndState({ lang: 'zh-CN', rmbExactRequests: 0 }, () => {
        assert.equal(getNextDisplayCurrency('USD'), 'RMB');
        assert.equal(getNextDisplayCurrency('RMB'), 'USD');
        assert.equal(getNextDisplayCurrency('MIXED'), 'RMB');
    });
});

test('getNextDisplayCurrency keeps MIXED cycle when current dataset contains exact RMB pricing', () => {
    withLocaleAndState({ lang: 'zh-CN', rmbExactRequests: 2 }, () => {
        assert.equal(getNextDisplayCurrency('MIXED'), 'USD');
        assert.equal(getNextDisplayCurrency('USD'), 'RMB');
        assert.equal(getNextDisplayCurrency('RMB'), 'MIXED');
    });
});

test('getCurrencyToggleTitle shows both current mode and next target mode', () => {
    withLocaleAndState({ lang: 'zh-CN', rmbExactRequests: 2 }, () => {
        assert.equal(getCurrencyToggleTitle('MIXED'), '当前：分币种显示。点击切换到统一美元显示。');
        assert.equal(getCurrencyToggleTitle('USD'), '当前：统一美元显示。点击切换到统一人民币显示。');
        assert.equal(getCurrencyToggleTitle('RMB'), '当前：统一人民币显示。点击切换到分币种显示。');
    });

    withLocaleAndState({ lang: 'zh-CN', rmbExactRequests: 0 }, () => {
        assert.equal(getCurrencyToggleTitle('MIXED'), '当前：统一美元显示。点击切换到统一人民币显示。');
    });
});
