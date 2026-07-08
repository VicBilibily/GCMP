import assert from 'node:assert/strict';
import test from 'node:test';

import {
    calculateCost,
    calculateCostWithBreakdown,
    formatCost,
    formatCostBreakdownLog,
    resolvePricingBreakdown,
    toNanoAiu
} from './costCalculator';
import { normalizeTokenPricing } from './pricingTierResolver';
import type { ModelTokenPricing } from '../types/sharedTypes';

function assertClose(actual: number, expected: number, message?: string): void {
    assert.ok(Math.abs(actual - expected) < 1e-12, message ?? `expected ${actual} to equal ${expected}`);
}

test('calculateCostWithBreakdown: OpenAI-compatible usage charges uncached input + cached read + output', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028
    };

    const breakdown = calculateCostWithBreakdown(
        {
            prompt_tokens: 150,
            completion_tokens: 30,
            total_tokens: 180,
            prompt_tokens_details: {
                cached_tokens: 45
            }
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.inputTokens, 105);
    assert.equal(breakdown.outputTokens, 30);
    assert.equal(breakdown.cacheReadTokens, 45);
    assert.equal(breakdown.cacheCreationTokens, 0);
    assertClose(breakdown.inputCost, (105 / 1_000_000) * 0.14);
    assertClose(breakdown.outputCost, (30 / 1_000_000) * 0.28);
    assertClose(breakdown.cacheReadCost, (45 / 1_000_000) * 0.0028);
    assertClose(breakdown.cacheWriteCost, 0);
    assertClose(breakdown.total, (105 * 0.14 + 30 * 0.28 + 45 * 0.0028) / 1_000_000);
    assertClose(
        calculateCost(
            {
                prompt_tokens: 150,
                completion_tokens: 30,
                total_tokens: 180,
                prompt_tokens_details: {
                    cached_tokens: 45
                }
            },
            pricing
        ),
        breakdown.total
    );
});

test('calculateCostWithBreakdown: Responses API usage does not double-charge cached input', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 1,
        outputPrice: 2,
        cacheReadPrice: 0.25,
        cacheWritePrice: 8
    };

    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 150,
            output_tokens: 25,
            total_tokens: 175,
            input_tokens_details: {
                cached_tokens: 60
            }
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.inputTokens, 90);
    assert.equal(breakdown.outputTokens, 25);
    assert.equal(breakdown.cacheReadTokens, 60);
    assert.equal(breakdown.cacheCreationTokens, 0);
    assertClose(breakdown.inputCost, (90 / 1_000_000) * 1);
    assertClose(breakdown.outputCost, (25 / 1_000_000) * 2);
    assertClose(breakdown.cacheReadCost, (60 / 1_000_000) * 0.25);
    assertClose(breakdown.cacheWriteCost, 0);
});

test('calculateCostWithBreakdown: Anthropic usage separately charges cache write tokens when explicitly provided', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 3,
        outputPrice: 15,
        cacheReadPrice: 0.3,
        cacheWritePrice: 3.75
    };

    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.inputTokens, 100);
    assert.equal(breakdown.outputTokens, 50);
    assert.equal(breakdown.cacheReadTokens, 20);
    assert.equal(breakdown.cacheCreationTokens, 10);
    assertClose(breakdown.inputCost, (100 / 1_000_000) * 3);
    assertClose(breakdown.outputCost, (50 / 1_000_000) * 15);
    assertClose(breakdown.cacheReadCost, (20 / 1_000_000) * 0.3);
    assertClose(breakdown.cacheWriteCost, (10 / 1_000_000) * 3.75);
});

test('calculateCostWithBreakdown: Gemini usageMetadata charges uncached prompt tokens and cached reads', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        cacheWritePrice: 99
    };

    const breakdown = calculateCostWithBreakdown(
        {
            promptTokenCount: 90,
            responseTokenCount: 35,
            totalTokenCount: 125,
            cachedContentTokenCount: 20
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.inputTokens, 70);
    assert.equal(breakdown.outputTokens, 35);
    assert.equal(breakdown.cacheReadTokens, 20);
    assert.equal(breakdown.cacheCreationTokens, 0);
    assertClose(breakdown.cacheWriteCost, 0);
    assertClose(breakdown.total, (70 * 0.14 + 35 * 0.28 + 20 * 0.0028) / 1_000_000);
});

test('calculateCostWithBreakdown: nested anthropic cache_creation details are treated as explicit cache write tokens', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.1,
        outputPrice: 0.2,
        cacheWritePrice: 0.4
    };

    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 6,
            output_tokens: 30,
            cache_creation: {
                ephemeral_5m_input_tokens: 27217,
                ephemeral_1h_input_tokens: 3
            }
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.inputTokens, 6);
    assert.equal(breakdown.cacheCreationTokens, 27220);
    assertClose(breakdown.cacheWriteCost, (27220 / 1_000_000) * 0.4);
});

test('calculateCost helpers handle missing inputs and formatting thresholds', () => {
    assert.equal(calculateCost(undefined, undefined), 0);
    assert.equal(calculateCostWithBreakdown(undefined, undefined), undefined);
    assert.equal(formatCost(0.00005), '~0');
    assert.equal(formatCost(0.004321), '0.0043');
    assert.equal(formatCost(1.2345), '1.23');
    assert.equal(toNanoAiu(0), undefined);
    assert.equal(toNanoAiu(-1), undefined);
    assert.equal(toNanoAiu(4e-10), 1);
    assert.equal(toNanoAiu(1.2e-9), 2);
});

// ============= 峰谷分档定价 =============

test('calculateCostWithBreakdown: applies matching peak tier pricing', () => {
    // 2026-07-06T01:30:00Z = 北京时间周一 09:30，命中 "* 9-23 * * 1-5"（工作日 9-23 点峰时）
    const mondayPeakBeijing = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14, // 静态单档（基础档）
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        pricing,
        mondayPeakBeijing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, '* 9-23 * * 1-5');
    assertClose(breakdown.inputCost, (100 / 1_000_000) * 0.28);
    assertClose(breakdown.outputCost, (50 / 1_000_000) * 0.56);
    assertClose(breakdown.total, (100 * 0.28 + 50 * 0.56) / 1_000_000);
});

test('calculateCostWithBreakdown: falls back to static single-tier when no tier matches', () => {
    // 2026-07-07T19:00:00Z = 北京时间周三 03:00，无 tier 命中（不在 9-23 峰时段）
    const wedEarlyBeijing = new Date('2026-07-07T19:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        pricing,
        wedEarlyBeijing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, undefined);
    assertClose(breakdown.inputCost, (100 / 1_000_000) * 0.14);
    assertClose(breakdown.outputCost, (50 / 1_000_000) * 0.28);
});

test('calculateCostWithBreakdown: tier inherits cacheReadPrice from static when tier omits it', () => {
    // 北京时间周一峰时
    const mondayPeakBeijing = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }] // tier 未覆盖 cacheReadPrice
    };

    const breakdown = calculateCostWithBreakdown(
        {
            prompt_tokens: 150,
            completion_tokens: 30,
            total_tokens: 180,
            prompt_tokens_details: { cached_tokens: 45 }
        },
        pricing,
        mondayPeakBeijing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.cacheReadTokens, 45);
    // cacheReadPrice 回退静态 0.0028
    assertClose(breakdown.cacheReadCost, (45 / 1_000_000) * 0.0028);
});

test('calculateCost: defaults to current time when at omitted (no tiers)', () => {
    // 无 tiers 时不需要时间参数
    const pricing: ModelTokenPricing = { inputPrice: 0.14, outputPrice: 0.28 };
    const cost = calculateCost({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, pricing);
    assertClose(cost, (100 * 0.14 + 50 * 0.28) / 1_000_000);
});

// ============= DeepSeek Flash 端到端：峰谷定价 + 分段时段 + 不限工作日 =============

test('DeepSeek-V4-Flash: peak tier applies during weekday morning (Beijing 09:30)', () => {
    // 2026-07-06T01:30:00Z = 北京时间周一 09:30，命中峰时
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [
            {
                cron: '* 9-11,14-17 * * *',
                inputPrice: 0.21,
                outputPrice: 0.42,
                cacheReadPrice: 0.0042
            }
        ]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        peakTime
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, '* 9-11,14-17 * * *');
    assertClose(breakdown.inputCost, (1000 / 1_000_000) * 0.21);
    assertClose(breakdown.outputCost, (500 / 1_000_000) * 0.42);
});

test('DeepSeek-V4-Flash: peak tier applies on weekend (no weekday constraint)', () => {
    // 2026-07-04T01:30:00Z = 北京时间周六 09:30，不限工作日 → 命中峰时
    const weekendPeak = new Date('2026-07-04T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [
            {
                cron: '* 9-11,14-17 * * *',
                inputPrice: 0.21,
                outputPrice: 0.42,
                cacheReadPrice: 0.0042
            }
        ]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        weekendPeak
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, '* 9-11,14-17 * * *');
    assertClose(breakdown.inputCost, (1000 / 1_000_000) * 0.21);
});

test('DeepSeek-V4-Flash: off-peak (lunch break) falls back to static pricing', () => {
    // 2026-07-06T05:00:00Z = 北京时间周一 13:00，午休时段，回退静态单档
    const lunchBreak = new Date('2026-07-06T05:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [
            {
                cron: '* 9-11,14-17 * * *',
                inputPrice: 0.21,
                outputPrice: 0.42,
                cacheReadPrice: 0.0042
            }
        ]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        lunchBreak
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, undefined);
    assertClose(breakdown.inputCost, (1000 / 1_000_000) * 0.14);
    assertClose(breakdown.outputCost, (500 / 1_000_000) * 0.28);
    // cacheReadPrice 也回退静态
    assertClose(breakdown.cacheReadCost, 0); // 无 cached_tokens
});

test('DeepSeek-V4-Flash: afternoon peak segment (14-17) applies', () => {
    // 2026-07-06T07:30:00Z = 北京时间周一 15:30，命中下午峰段
    const afternoonPeak = new Date('2026-07-06T07:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [
            {
                cron: '* 9-11,14-17 * * *',
                inputPrice: 0.21,
                outputPrice: 0.42,
                cacheReadPrice: 0.0042
            }
        ]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        afternoonPeak
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, '* 9-11,14-17 * * *');
    assertClose(breakdown.outputCost, (500 / 1_000_000) * 0.42);
});

// ============= 按服务等级计费（serviceTier 匹配） =============

test('calculateCostWithBreakdown: serviceTier-filtered tier applies when request tier matches', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }]
    };

    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        peakTime,
        'priority'
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, '* * * * *');
    assert.equal(breakdown.activeTierServiceTier, 'priority');
    assertClose(breakdown.inputCost, (1000 / 1_000_000) * 0.07);
    assertClose(breakdown.outputCost, (500 / 1_000_000) * 0.14);
});

test('calculateCostWithBreakdown: serviceTier-filtered tier skipped when request tier differs', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }]
    };

    // 请求 default → priority tier 不命中 → 回退静态单档
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        peakTime,
        'default'
    );

    assert.ok(breakdown);
    assert.equal(breakdown.activeTierCron, undefined);
    assert.equal(breakdown.activeTierServiceTier, undefined);
    assertClose(breakdown.inputCost, (1000 / 1_000_000) * 0.14);
});

test('calculateCostWithBreakdown: priority tier and peak tier coexist', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z'); // 北京时间 09:30
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 },
            { cron: '* 9-23 * * *', inputPrice: 0.21, outputPrice: 0.42 }
        ]
    };

    // 请求 priority → 命中第一条（priority 专属价）
    const priorityBreakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        peakTime,
        'priority'
    );
    assert.ok(priorityBreakdown);
    assert.equal(priorityBreakdown.activeTierServiceTier, 'priority');
    assertClose(priorityBreakdown.inputCost, (1000 / 1_000_000) * 0.07);

    // 请求 default → 第一条被过滤，命中第二条峰时价
    const defaultBreakdown = calculateCostWithBreakdown(
        { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        pricing,
        peakTime,
        'default'
    );
    assert.ok(defaultBreakdown);
    assert.equal(defaultBreakdown.activeTierServiceTier, undefined);
    assertClose(defaultBreakdown.inputCost, (1000 / 1_000_000) * 0.21);
});

// ============= 按上下文窗口阶梯计费（contextSizeMin 匹配） =============

test('calculateCostWithBreakdown: contextSizeMin tier applies when actual input tokens are large enough', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };

    // input tokens = 600K → >= 512001 → 命中 tier
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 600000, completion_tokens: 500, total_tokens: 600500 },
        pricing,
        peakTime
    );
    assert.ok(breakdown);
    assertClose(breakdown.inputCost, (600000 / 1_000_000) * 0.28);
});

test('calculateCostWithBreakdown: contextSizeMin tier skipped when actual input tokens are too small', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };

    // input tokens = 300K → < 512001 → 回退静态单档
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 300000, completion_tokens: 500, total_tokens: 300500 },
        pricing,
        peakTime
    );
    assert.ok(breakdown);
    assertClose(breakdown.inputCost, (300000 / 1_000_000) * 0.14);
});

test('calculateCostWithBreakdown: contextSizeMin + serviceTier combined (by actual input)', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', serviceTier: 'priority', contextSizeMin: 512001, inputPrice: 0.35, outputPrice: 0.7 }
        ]
    };

    // priority + 600K input → 命中
    const hit = calculateCostWithBreakdown(
        { prompt_tokens: 600000, completion_tokens: 500, total_tokens: 600500 },
        pricing,
        peakTime,
        'priority'
    );
    assert.ok(hit);
    assertClose(hit.inputCost, (600000 / 1_000_000) * 0.35);

    // priority + 300K input → contextSizeMin 不够，回退静态
    const missInput = calculateCostWithBreakdown(
        { prompt_tokens: 300000, completion_tokens: 500, total_tokens: 300500 },
        pricing,
        peakTime,
        'priority'
    );
    assert.ok(missInput);
    assertClose(missInput.inputCost, (300000 / 1_000_000) * 0.14);

    // default + 600K input → serviceTier 不匹配，回退静态
    const missTier = calculateCostWithBreakdown(
        { prompt_tokens: 600000, completion_tokens: 500, total_tokens: 600500 },
        pricing,
        peakTime,
        'default'
    );
    assert.ok(missTier);
    assertClose(missTier.inputCost, (600000 / 1_000_000) * 0.14);
});

test('MiniMax M3: priority × >512K → highest tier', () => {
    // minimax.json M3 PayGo（无 cron，默认全时段）
    const pricing: ModelTokenPricing = {
        inputPrice: 0.3,
        outputPrice: 1.2,
        cacheReadPrice: 0.06,
        tiers: [
            {
                serviceTier: 'priority',
                contextSizeMin: 512001,
                inputPrice: 0.9,
                outputPrice: 3.6,
                cacheReadPrice: 0.18
            },
            { serviceTier: 'priority', inputPrice: 0.45, outputPrice: 1.8, cacheReadPrice: 0.09 },
            { serviceTier: 'default', contextSizeMin: 512001, inputPrice: 0.6, outputPrice: 2.4, cacheReadPrice: 0.12 }
        ]
    };
    const peakTime = new Date('2026-07-06T01:30:00Z');

    // priority + input=600K (Anthropic: input_tokens不含缓存) → >= 512001 → tier 0
    const breakdown = calculateCostWithBreakdown(
        { input_tokens: 600000, output_tokens: 500, cache_read_input_tokens: 10000 },
        pricing,
        peakTime,
        'priority'
    );
    assert.ok(breakdown);
    assert.equal(breakdown.activeTierServiceTier, 'priority');
    assert.equal(breakdown.effectiveInputPrice, 0.9);
    assert.equal(breakdown.effectiveOutputPrice, 3.6);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.18);
    // Anthropic: actualInput = input_tokens + cacheReadTokens = 600000+10000=610000
    // uncached input = 600000, cached = 10000
    assertClose(breakdown.inputCost, (600000 / 1_000_000) * 0.9);
    assertClose(breakdown.cacheReadCost, (10000 / 1_000_000) * 0.18);
});

test('MiniMax M3: priority × ≤512K → mid tier', () => {
    // 同 minimax.json M3 PayGo（无 cron）
    const pricing: ModelTokenPricing = {
        inputPrice: 0.3,
        outputPrice: 1.2,
        cacheReadPrice: 0.06,
        tiers: [
            {
                serviceTier: 'priority',
                contextSizeMin: 512001,
                inputPrice: 0.9,
                outputPrice: 3.6,
                cacheReadPrice: 0.18
            },
            { serviceTier: 'priority', inputPrice: 0.45, outputPrice: 1.8, cacheReadPrice: 0.09 },
            { serviceTier: 'default', contextSizeMin: 512001, inputPrice: 0.6, outputPrice: 2.4, cacheReadPrice: 0.12 }
        ]
    };
    const peakTime = new Date('2026-07-06T01:30:00Z');

    // priority + input=300K → tier 0 不满足 contextSizeMin → 命中 tier 1
    const breakdown = calculateCostWithBreakdown(
        { input_tokens: 300000, output_tokens: 200 },
        pricing,
        peakTime,
        'priority'
    );
    assert.ok(breakdown);
    assert.equal(breakdown.activeTierServiceTier, 'priority');
    assert.equal(breakdown.effectiveInputPrice, 0.45);
    assert.equal(breakdown.effectiveOutputPrice, 1.8);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.09);
    assertClose(breakdown.inputCost, (300000 / 1_000_000) * 0.45);
    assertClose(breakdown.outputCost, (200 / 1_000_000) * 1.8);
});

test('MiniMax M3: default × >512K → default high tier', () => {
    // 同 minimax.json M3 PayGo（无 cron）
    const pricing: ModelTokenPricing = {
        inputPrice: 0.3,
        outputPrice: 1.2,
        cacheReadPrice: 0.06,
        tiers: [
            {
                serviceTier: 'priority',
                contextSizeMin: 512001,
                inputPrice: 0.9,
                outputPrice: 3.6,
                cacheReadPrice: 0.18
            },
            { serviceTier: 'priority', inputPrice: 0.45, outputPrice: 1.8, cacheReadPrice: 0.09 },
            { serviceTier: 'default', contextSizeMin: 512001, inputPrice: 0.6, outputPrice: 2.4, cacheReadPrice: 0.12 }
        ]
    };
    const peakTime = new Date('2026-07-06T01:30:00Z');

    // default + input=600K → 前两个 tier 被 serviceTier 过滤，命中 tier 2
    const breakdown = calculateCostWithBreakdown(
        { input_tokens: 600000, output_tokens: 500 },
        pricing,
        peakTime,
        'default'
    );
    assert.ok(breakdown);
    assert.equal(breakdown.activeTierServiceTier, 'default');
    assert.equal(breakdown.effectiveInputPrice, 0.6);
    assert.equal(breakdown.effectiveOutputPrice, 2.4);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.12);
    assertClose(breakdown.inputCost, (600000 / 1_000_000) * 0.6);
});

test('MiniMax M3: default × ≤512K → static fallback', () => {
    // 同 minimax.json M3 PayGo（无 cron）
    const pricing: ModelTokenPricing = {
        inputPrice: 0.3,
        outputPrice: 1.2,
        cacheReadPrice: 0.06,
        tiers: [
            {
                serviceTier: 'priority',
                contextSizeMin: 512001,
                inputPrice: 0.9,
                outputPrice: 3.6,
                cacheReadPrice: 0.18
            },
            { serviceTier: 'priority', inputPrice: 0.45, outputPrice: 1.8, cacheReadPrice: 0.09 },
            { serviceTier: 'default', contextSizeMin: 512001, inputPrice: 0.6, outputPrice: 2.4, cacheReadPrice: 0.12 }
        ]
    };
    const peakTime = new Date('2026-07-06T01:30:00Z');

    // default + input=300K → 所有 tier 都不满足 → 回退静态
    const breakdown = calculateCostWithBreakdown(
        { input_tokens: 300000, output_tokens: 200 },
        pricing,
        peakTime,
        'default'
    );
    assert.ok(breakdown);
    assert.equal(breakdown.activeTierServiceTier, undefined);
    assert.equal(breakdown.effectiveInputPrice, 0.3);
    assert.equal(breakdown.effectiveOutputPrice, 1.2);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.06);
    assertClose(breakdown.inputCost, (300000 / 1_000_000) * 0.3);
    assertClose(breakdown.outputCost, (200 / 1_000_000) * 1.2);
});

test('calculateCostWithBreakdown: contextSizeMin boundary — exact match at threshold', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };

    // input = 512001 → 刚好 >= → 命中
    const hit = calculateCostWithBreakdown(
        { prompt_tokens: 512001, completion_tokens: 100, total_tokens: 512101 },
        pricing,
        peakTime
    );
    assert.ok(hit);
    assertClose(hit.inputCost, (512001 / 1_000_000) * 0.28);

    // input = 512000 → 刚好 < → 回退静态
    const miss = calculateCostWithBreakdown(
        { prompt_tokens: 512000, completion_tokens: 100, total_tokens: 512100 },
        pricing,
        peakTime
    );
    assert.ok(miss);
    assertClose(miss.inputCost, (512000 / 1_000_000) * 0.14);
});

test('calculateCostWithBreakdown: contextSizeMin with cached tokens — raw prompt_tokens counts toward threshold', () => {
    // OpenAI prompt_tokens 包含 cached tokens，actualInput=raw prompt_tokens=550K
    // 550K >= 512001 → tier 命中，cached 部分按 cacheReadPrice 计费
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [{ cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };

    const breakdown = calculateCostWithBreakdown(
        {
            prompt_tokens: 550000,
            completion_tokens: 100,
            total_tokens: 550100,
            prompt_tokens_details: { cached_tokens: 50000 }
        },
        pricing,
        peakTime
    );
    assert.ok(breakdown);
    // raw prompt_tokens=550K >= 512001 → tier 命中
    assert.equal(breakdown.activeTierCron, '* * * * *');
    // input 部分: (550000-50000)=500000 非缓存 → 500000/1M*0.28=0.14
    assertClose(breakdown.inputCost, (500000 / 1_000_000) * 0.28);
    // cached 部分: 50000/1M*0.0028=0.00014
    assertClose(breakdown.cacheReadCost, (50000 / 1_000_000) * 0.0028);
});

test('calculateCostWithBreakdown: multiple contextSizeMin tiers — first matching wins', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 },
            { cron: '* * * * *', contextSizeMin: 100000, inputPrice: 0.21, outputPrice: 0.42 }
        ]
    };

    // input=600K → 两条都满足 → 第一条命中
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 600000, completion_tokens: 100, total_tokens: 600100 },
        pricing,
        peakTime
    );
    assert.ok(breakdown);
    assertClose(breakdown.inputCost, (600000 / 1_000_000) * 0.28);

    // input=200K → 只满足第二条 → 第二条命中
    const mid = calculateCostWithBreakdown(
        { prompt_tokens: 200000, completion_tokens: 100, total_tokens: 200100 },
        pricing,
        peakTime
    );
    assert.ok(mid);
    assertClose(mid.inputCost, (200000 / 1_000_000) * 0.21);

    // input=50K → 都不满足 → 回退静态
    const fallback = calculateCostWithBreakdown(
        { prompt_tokens: 50000, completion_tokens: 100, total_tokens: 50100 },
        pricing,
        peakTime
    );
    assert.ok(fallback);
    assertClose(fallback.inputCost, (50000 / 1_000_000) * 0.14);
});

// ============= formatCostBreakdownLog =============

test('formatCostBreakdownLog: formats a complete breakdown with tier info', () => {
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        {
            inputPrice: 0.14,
            outputPrice: 0.28,
            tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
        },
        new Date('2026-07-06T01:30:00Z')
    );
    assert.ok(breakdown);

    const log = formatCostBreakdownLog('TestModel', breakdown);
    assert.ok(log.includes('[TestModel] Cost breakdown:'));
    assert.ok(log.includes('pricing  input=$0.28 output=$0.56'));
    assert.ok(log.includes('tier     * 9-23 * * 1-5'));
    assert.ok(log.includes('usage   input=100 output=50'));
    assert.ok(log.includes('subtotal input=$'));
    assert.ok(log.includes('total=$'));
    assert.ok(log.includes('nano-AIU'));
});

test('formatCostBreakdownLog: omits cache fields when not priced', () => {
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        { inputPrice: 0.14, outputPrice: 0.28 },
        new Date()
    );
    assert.ok(breakdown);

    const log = formatCostBreakdownLog('M', breakdown);
    // 无 cacheRead/cacheWrite 价格 → 不应出现这些字段
    assert.ok(!log.includes('cacheRead='));
    assert.ok(!log.includes('cacheWrite='));
});

test('formatCostBreakdownLog: includes serviceTier when active', () => {
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        {
            inputPrice: 0.14,
            outputPrice: 0.28,
            tiers: [{ cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }]
        },
        new Date(),
        'priority'
    );
    assert.ok(breakdown);

    const log = formatCostBreakdownLog('M', breakdown);
    assert.ok(log.includes('(serviceTier: priority)'));
});

// ============= resolvePricingBreakdown 直测（contextSizeMin 回退逻辑） =============

test('resolvePricingBreakdown: falls back to second tier when first fails contextSizeMin', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 },
            { cron: '* * * * *', contextSizeMin: 100000, inputPrice: 0.21, outputPrice: 0.42 }
        ]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    // actualInput=200K → 第一条不满足，命中第二条
    const result = resolvePricingBreakdown(pricing, at, undefined, 200000);
    assert.ok(result);
    assert.ok(result.activeTier);
    assert.equal(result.activeTier.inputPrice, 0.21);
    assert.equal(result.effectivePricing.inputPrice, 0.21);
});

test('resolvePricingBreakdown: returns static fallback when no tier satisfies contextSizeMin', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 },
            { cron: '* * * * *', contextSizeMin: 100000, inputPrice: 0.21, outputPrice: 0.42 }
        ]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    // actualInput=50K → 两条都不满足 → 回退静态
    const result = resolvePricingBreakdown(pricing, at, undefined, 50000);
    assert.ok(result);
    assert.equal(result.activeTier, undefined);
    assert.equal(result.effectivePricing.inputPrice, 0.14);
});

test('resolvePricingBreakdown: contextSizeMin check skipped when tier has no contextSizeMin', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', inputPrice: 0.28, outputPrice: 0.56 }]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    // tier 无 contextSizeMin → 直接命中
    const result = resolvePricingBreakdown(pricing, at, undefined, 100);
    assert.ok(result);
    assert.ok(result.activeTier);
    assert.equal(result.effectivePricing.inputPrice, 0.28);
});

test('resolvePricingBreakdown: returns undefined when pricing is undefined', () => {
    assert.equal(resolvePricingBreakdown(undefined, new Date(), undefined, 100), undefined);
});

test('resolvePricingBreakdown: contextSizeInputOnly excludes cacheRead from threshold', () => {
    // raw prompt=550K, cacheRead=50K → uncached=500K
    // contextSizeMin=512001, contextSizeInputOnly=true → 500K < 512001 → 不命中 → 回退静态
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            {
                cron: '* * * * *',
                contextSizeMin: 512001,
                contextSizeInputOnly: true,
                inputPrice: 0.28,
                outputPrice: 0.56
            }
        ]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    const result = resolvePricingBreakdown(pricing, at, undefined, 550000, 50000);
    assert.ok(result);
    assert.equal(result.activeTier, undefined);
    assert.equal(result.effectivePricing.inputPrice, 0.14);
});

test('resolvePricingBreakdown: contextSizeInputOnly false (default) includes cache in threshold', () => {
    // raw prompt=550K, cacheRead=50K → 默认口径=550K
    // contextSizeMin=512001 → 550K >= 512001 → 命中
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    const result = resolvePricingBreakdown(pricing, at, undefined, 550000, 50000);
    assert.ok(result);
    assert.ok(result.activeTier);
    assert.equal(result.effectivePricing.inputPrice, 0.28);
});

test('resolvePricingBreakdown: omitted cron with contextSizeInputOnly works', () => {
    // 无 cron，仅靠 contextSizeMin + contextSizeInputOnly 判断
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ contextSizeMin: 512001, contextSizeInputOnly: true, inputPrice: 0.28, outputPrice: 0.56 }]
    };
    const at = new Date('2026-07-06T01:30:00Z');

    // raw=550K, cacheRead=50K → uncached=500K < 512001 → 不命中
    const result = resolvePricingBreakdown(pricing, at, undefined, 550000, 50000);
    assert.ok(result);
    assert.equal(result.activeTier, undefined);
    assert.equal(result.effectivePricing.inputPrice, 0.14);
});

// ============= toNanoAiu 大数值边界 =============

test('toNanoAiu: large cost values', () => {
    assert.equal(toNanoAiu(1), 1_000_000_000);
    assert.equal(toNanoAiu(0.000001), 1000);
    // 0.000000001 = 1e-9 → ceil(1) = 1
    assert.equal(toNanoAiu(1e-9), 1);
    // 0.0000000009 = 9e-10 → ceil(0.9) = 1
    assert.equal(toNanoAiu(9e-10), 1);
});

// ============= Cubence GPT-5.4 端到端：contextSizeInputOnly 按非缓存 input 阶梯计费 =============

test('Cubence GPT-5.4: tier applies when non-cached input >= 272K', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadPrice: 0.25,
        tiers: [
            {
                contextSizeMin: 272001,
                contextSizeInputOnly: true,
                inputPrice: 5,
                outputPrice: 22.5,
                cacheReadPrice: 0.5
            }
        ]
    };

    // Responses API: input_tokens=300K, cached=20K → non-cached=280K >= 272001 → 命中 tier
    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 300000,
            output_tokens: 5000,
            input_tokens_details: { cached_tokens: 20000 }
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.effectiveInputPrice, 5);
    assert.equal(breakdown.effectiveOutputPrice, 22.5);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.5);
    assertClose(breakdown.inputCost, (280000 / 1_000_000) * 5);
    assertClose(breakdown.outputCost, (5000 / 1_000_000) * 22.5);
    assertClose(breakdown.cacheReadCost, (20000 / 1_000_000) * 0.5);
});

test('Cubence GPT-5.4: falls back to static when non-cached input < 272K', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadPrice: 0.25,
        tiers: [
            {
                contextSizeMin: 272001,
                contextSizeInputOnly: true,
                inputPrice: 5,
                outputPrice: 22.5,
                cacheReadPrice: 0.5
            }
        ]
    };

    // input_tokens=200K, cached=30K → non-cached=170K < 272001 → 回退静态
    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 200000,
            output_tokens: 3000,
            input_tokens_details: { cached_tokens: 30000 }
        },
        pricing
    );

    assert.ok(breakdown);
    assert.equal(breakdown.effectiveInputPrice, 2.5);
    assert.equal(breakdown.effectiveOutputPrice, 15);
    assert.equal(breakdown.effectiveCacheReadPrice, 0.25);
    assertClose(breakdown.inputCost, (170000 / 1_000_000) * 2.5);
    assertClose(breakdown.outputCost, (3000 / 1_000_000) * 15);
    assertClose(breakdown.cacheReadCost, (30000 / 1_000_000) * 0.25);
});

test('Cubence GPT-5.4: without contextSizeInputOnly, raw tokens count toward threshold', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadPrice: 0.25,
        tiers: [
            {
                contextSizeMin: 272001,
                inputPrice: 5,
                outputPrice: 22.5,
                cacheReadPrice: 0.5
            }
        ]
    };

    // 默认 contextSizeInputOnly=false → raw=250K < 272K → 回退
    const miss = calculateCostWithBreakdown(
        { input_tokens: 250000, output_tokens: 2000, input_tokens_details: { cached_tokens: 50000 } },
        pricing
    );
    assert.ok(miss);
    assert.equal(miss.effectiveInputPrice, 2.5);

    // raw=280K >= 272K → 命中（即使 non-cached=230K）
    const hit = calculateCostWithBreakdown(
        { input_tokens: 280000, output_tokens: 2000, input_tokens_details: { cached_tokens: 50000 } },
        pricing
    );
    assert.ok(hit);
    assert.equal(hit.effectiveInputPrice, 5);
});

// ============= formatCostBreakdownLog 边界 =============

test('formatCostBreakdownLog: zero-cost breakdown shows 0 nano-AIU', () => {
    const breakdown = calculateCostWithBreakdown(
        { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        { inputPrice: 0.14, outputPrice: 0.28 }
    );
    assert.ok(breakdown);
    const log = formatCostBreakdownLog('M', breakdown);
    assert.ok(log.includes('0 nano-AIU'));
});

// ============= 数组简写形式 tokenPricing =============

test('normalizeTokenPricing: 2-element array becomes object without cache prices', () => {
    const result = normalizeTokenPricing([2.5, 15]);
    assert.deepEqual(result, { inputPrice: 2.5, outputPrice: 15 });
});

test('normalizeTokenPricing: 3-element array sets cacheReadPrice', () => {
    const result = normalizeTokenPricing([2.5, 15, 0.25]);
    assert.deepEqual(result, { inputPrice: 2.5, outputPrice: 15, cacheReadPrice: 0.25 });
});

test('normalizeTokenPricing: 4-element array sets all prices', () => {
    const result = normalizeTokenPricing([2.5, 15, 0.25, 99]);
    assert.deepEqual(result, { inputPrice: 2.5, outputPrice: 15, cacheReadPrice: 0.25, cacheWritePrice: 99 });
});

test('normalizeTokenPricing: invalid array lengths return undefined', () => {
    assert.equal(normalizeTokenPricing([]), undefined);
    assert.equal(normalizeTokenPricing([1]), undefined);
    assert.equal(normalizeTokenPricing([1, 2, 3, 4, 5]), undefined);
});

test('normalizeTokenPricing: non-numeric elements return undefined', () => {
    assert.equal(normalizeTokenPricing(['a', 15]), undefined);
    assert.equal(normalizeTokenPricing([2.5, 'b']), undefined);
    assert.equal(normalizeTokenPricing([2.5, 15, 'c']), undefined);
});

test('normalizeTokenPricing: object passes through unchanged', () => {
    const obj: ModelTokenPricing = { inputPrice: 1, outputPrice: 2 };
    assert.equal(normalizeTokenPricing(obj), obj);
});

test('normalizeTokenPricing: undefined / null return undefined', () => {
    assert.equal(normalizeTokenPricing(undefined), undefined);
    assert.equal(normalizeTokenPricing(null), undefined);
});

test('normalizeTokenPricing: invalid object shape returns undefined', () => {
    assert.equal(normalizeTokenPricing({ cacheReadPrice: 1 }), undefined);
    assert.equal(normalizeTokenPricing({ inputPrice: '2.5', outputPrice: 15 }), undefined);
});

test('calculateCostWithBreakdown: array form [input, output] works like object', () => {
    // 数组 [2.5, 15] 应等价于 { inputPrice: 2.5, outputPrice: 15 }
    const arrayPricing: [number, number] = [2.5, 15];
    const objectPricing: ModelTokenPricing = { inputPrice: 2.5, outputPrice: 15 };

    const usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
    const arrayResult = calculateCostWithBreakdown(usage, arrayPricing);
    const objectResult = calculateCostWithBreakdown(usage, objectPricing);

    assert.ok(arrayResult);
    assert.ok(objectResult);
    assertClose(arrayResult.total, objectResult.total);
    assertClose(arrayResult.inputCost, objectResult.inputCost);
    assertClose(arrayResult.outputCost, objectResult.outputCost);
});

test('calculateCostWithBreakdown: Cubence array form [2.5, 15, 0.25] with tiers via object', () => {
    // 使用数组作为静态单档 + 对象 tiers 组合
    const pricing = {
        inputPrice: 2.5,
        outputPrice: 15,
        cacheReadPrice: 0.25,
        tiers: [
            {
                contextSizeMin: 272001,
                contextSizeInputOnly: true,
                inputPrice: 5,
                outputPrice: 22.5,
                cacheReadPrice: 0.5
            }
        ]
    };

    const breakdown = calculateCostWithBreakdown(
        {
            input_tokens: 300000,
            output_tokens: 5000,
            input_tokens_details: { cached_tokens: 20000 }
        },
        pricing
    );
    assert.ok(breakdown);
    assert.equal(breakdown.effectiveInputPrice, 5);
    assert.equal(breakdown.effectiveOutputPrice, 22.5);
    assertClose(breakdown.inputCost, (280000 / 1_000_000) * 5);
    assertClose(breakdown.cacheReadCost, (20000 / 1_000_000) * 0.5);
});
