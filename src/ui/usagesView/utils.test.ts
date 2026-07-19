import assert from 'node:assert/strict';
import test from 'node:test';

import type { BaseStats, NativeCostSplit } from '../../usages/fileLogger/types';
import { calculateCostWithBreakdown, toCostBreakdownLog } from '../../utils/pricing/costCalculator';
import {
    buildCostBreakdownTitle,
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

test('buildCostBreakdownTitle renders tier, pricing, per-part billing and total', () => {
    withLocaleAndState({ lang: 'zh-CN' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [12000, 3000, 8000, 0],
                pricing: [2, 8, 0.2],
                cost: [0.024, 0.024, 0.0016],
                total: 0.0496,
                activeTier: '* 9-23 * * 1-5',
                currencies: { USD: { pricing: [2, 8, 0.2], cost: [0.024, 0.024, 0.0016], total: 0.0496 } }
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /档位：\* 9-23 \* \* 1-5/);
        assert.match(title, /单价：in \$2 · out \$8 · cacheRead \$0\.2 \/ 1M tokens/);
        assert.match(title, /计费：input 12,000 × \$2\/1M = \$0\.024000/);
        assert.match(title, /output 3,000 × \$8\/1M = \$0\.024000/);
        assert.match(title, /cacheRead 8,000 × \$0\.2\/1M = \$0\.001600/);
        assert.doesNotMatch(title, /cacheWrite/);
        assert.match(title, /合计：\$0\.049600/);
    });
});

test('buildCostBreakdownTitle falls back to static tier label and uses RMB currency in RMB view', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: {
                    USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 },
                    RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 }
                }
            },
            'RMB'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Tier: static \(no tier matched\)/);
        assert.match(title, /in ¥7 · out ¥14/);
        assert.match(title, /Total: ¥0\.014000/);
    });
});

test('buildCostBreakdownTitle returns undefined when breakdown is missing', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        assert.equal(buildCostBreakdownTitle(undefined, 'USD'), undefined);
    });
});

test('buildCostBreakdownTitle falls back to top-level pricing when currencies is absent (legacy logs)', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [2000, 1000, 0, 0],
                pricing: [1.5, 3],
                cost: [0.003, 0.003],
                total: 0.006
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in \$1\.5 · out \$3 \/ 1M tokens/);
        assert.match(title, /Total: \$0\.006000/);
    });
});

test('buildCostBreakdownTitle converts from USD when RMB view has no RMB pricing', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: { USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 } }
            },
            'RMB'
        );

        assert.ok(title !== undefined);
        // 计算过程保持 USD 原生口径，合计后换算为 RMB
        assert.match(title, /Pricing: in \$1 · out \$2/);
        assert.match(title, /input 1,000 × \$1\/1M = \$0\.001000/);
        assert.match(title, /output 500 × \$2\/1M = \$0\.001000/);
        assert.match(title, /Total: \$0\.002000 × 7 = ¥0\.014000/);
    });
});

test('buildCostBreakdownTitle prefers RMB pricing process in MIXED view', () => {
    withLocaleAndState({ lang: 'zh-CN' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: {
                    USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 },
                    RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 }
                }
            },
            'MIXED'
        );

        assert.ok(title !== undefined);
        assert.doesNotMatch(title, /换算|converted/);
        assert.match(title, /单价：in ¥7 · out ¥14/);
        assert.match(title, /合计：¥0\.014000/);
    });
});

test('buildCostBreakdownTitle converts from USD in MIXED view when RMB pricing is absent', () => {
    withLocaleAndState({ lang: 'zh-CN' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: { USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 } }
            },
            'MIXED'
        );

        assert.ok(title !== undefined);
        // MIXED 合计不换算：无原生 RMB 定价时全程 USD
        assert.match(title, /单价：in \$1 · out \$2/);
        assert.match(title, /合计：\$0\.002000/);
        assert.doesNotMatch(title, /¥/);
    });
});

test('buildCostBreakdownTitle uses USD for dual-currency model in English MIXED view', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: {
                    USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 },
                    RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 }
                }
            },
            'MIXED'
        );

        assert.ok(title !== undefined);
        // 英文 MIXED 优先 USD，全程 $ 无换算
        assert.match(title, /Pricing: in \$1 · out \$2/);
        assert.match(title, /Total: \$0\.002000/);
        assert.doesNotMatch(title, /¥/);
    });
});

test('buildCostBreakdownTitle renders cacheWrite billing line when cache write tokens and price exist', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [5000, 1000, 2000, 3000],
                pricing: [2, 8, 0.2, 2.5],
                cost: [0, 0.008, 0.0004, 0.0075],
                total: 0.0159
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in \$2 · out \$8 · cacheRead \$0\.2 · cacheWrite \$2\.5/);
        assert.match(title, /cacheRead 2,000 × \$0\.2\/1M = \$0\.000400/);
        assert.match(title, /cacheWrite 3,000 × \$2\.5\/1M = \$0\.007500/);
    });
});

test('buildCostBreakdownTitle shows cache price but hides billing line when cache tokens are zero', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2, 0.1, 1.5],
                cost: [0.001, 0.001],
                total: 0.002
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in \$1 · out \$2 · cacheRead \$0\.1 · cacheWrite \$1\.5/);
        assert.doesNotMatch(title, /Billing:[\s\S]*cacheRead/);
        assert.doesNotMatch(title, /Billing:[\s\S]*cacheWrite/);
    });
});

test('buildCostBreakdownTitle uses native RMB pricing directly in RMB view without conversion note', () => {
    withLocaleAndState({ lang: 'zh-CN' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [7, 14],
                cost: [0.007, 0.007],
                total: 0.014,
                currencies: {
                    USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 },
                    RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 }
                }
            },
            'RMB'
        );

        assert.ok(title !== undefined);
        assert.doesNotMatch(title, /换算|converted/);
        assert.match(title, /单价：in ¥7 · out ¥14/);
        assert.match(title, /合计：¥0\.014000/);
    });
});

test('buildCostBreakdownTitle uses USD for dual-currency model in USD view without conversion', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [1, 2],
                cost: [0.001, 0.001],
                total: 0.002,
                currencies: {
                    USD: { pricing: [1, 2], cost: [0.001, 0.001], total: 0.002 },
                    RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 }
                }
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in \$1 · out \$2/);
        assert.match(title, /Total: \$0\.002000/);
        assert.doesNotMatch(title, /¥/);
    });
});

test('buildCostBreakdownTitle converts from RMB in USD view when only RMB pricing exists', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const title = buildCostBreakdownTitle(
            {
                tokens: [1000, 500, 0, 0],
                pricing: [7, 14],
                cost: [0.007, 0.007],
                total: 0.014,
                // 类型上 currencies.USD 必填；此处模拟写入端 USD 定价缺失（0 值）的极端场景
                currencies: { RMB: { pricing: [7, 14], cost: [0.007, 0.007], total: 0.014 } } as {
                    USD: { pricing: [number, number]; cost: [number, number]; total: number };
                    RMB: { pricing: [number, number]; cost: [number, number]; total: number };
                }
            },
            'USD'
        );

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in ¥7 · out ¥14/);
        assert.match(title, /input 1,000 × ¥7\/1M = ¥0\.007000/);
        assert.match(title, /output 500 × ¥14\/1M = ¥0\.007000/);
        assert.match(title, /Total: ¥0\.014000 ÷ 7 = \$0\.002000/);
    });
});

test('RMB-only production chain keeps native RMB process in USD tooltip', () => {
    withLocaleAndState({ lang: 'en' }, () => {
        const breakdown = calculateCostWithBreakdown(
            { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
            { pricing: { RMB: [7, 14] } }
        );

        assert.ok(breakdown !== undefined);
        const log = toCostBreakdownLog(breakdown);
        assert.deepEqual(log.nativeCurrencies, ['RMB']);
        const title = buildCostBreakdownTitle(log, 'USD');

        assert.ok(title !== undefined);
        assert.match(title, /Pricing: in ¥7 · out ¥14/);
        assert.match(title, /input 1,000 × ¥7\/1M = ¥0\.007000/);
        assert.match(title, /output 500 × ¥14\/1M = ¥0\.007000/);
        assert.match(title, /Total: ¥0\.014000 ÷ 7 = \$0\.002000/);
    });
});
