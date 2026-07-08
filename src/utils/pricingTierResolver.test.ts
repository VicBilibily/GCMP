import assert from 'node:assert/strict';
import test from 'node:test';

import { collectInvalidTierCrons, parseCron, resolveActiveTier } from './pricingTierResolver';
import type { ModelTokenPricing } from '../types/sharedTypes';

// ============= parseCron =============

test('parseCron: parses 5-field expression into sets', () => {
    const parsed = parseCron('0 9 * * 1-5');
    assert.equal(parsed.minute.size, 1);
    assert.ok(parsed.minute.has(0));
    assert.ok(parsed.hour.has(9));
    assert.equal(parsed.hour.size, 1);
    // day-of-month: * → 1..31
    assert.equal(parsed.dayOfMonth.size, 31);
    // month: * → 1..12
    assert.equal(parsed.month.size, 12);
    // day-of-week: 1-5
    assert.equal(parsed.dayOfWeek.size, 5);
    assert.ok(parsed.dayOfWeek.has(1));
    assert.ok(parsed.dayOfWeek.has(5));
});

test('parseCron: normalizes 7 to 0 (Sunday)', () => {
    const parsed = parseCron('0 0 * * 7');
    assert.ok(parsed.dayOfWeek.has(0));
    assert.ok(!parsed.dayOfWeek.has(7));
});

test('parseCron: supports list, range, and step', () => {
    const parsed = parseCron('0,30 8-20/2 * * *');
    assert.ok(parsed.minute.has(0));
    assert.ok(parsed.minute.has(30));
    assert.equal(parsed.minute.size, 2);
    // 8-20/2 → 8,10,12,14,16,18,20
    assert.deepEqual(
        Array.from(parsed.hour).sort((a, b) => a - b),
        [8, 10, 12, 14, 16, 18, 20]
    );
});

test('parseCron: supports */n step', () => {
    const parsed = parseCron('*/15 * * * *');
    assert.deepEqual(
        Array.from(parsed.minute).sort((a, b) => a - b),
        [0, 15, 30, 45]
    );
});

test('parseCron: throws on wrong field count', () => {
    assert.throws(() => parseCron('0 9 * *'), /must have 5 fields/);
    assert.throws(() => parseCron('0 9 * * 1-5 extra'), /must have 5 fields/);
});

test('parseCron: throws on out-of-range value', () => {
    assert.throws(() => parseCron('60 9 * * *'), /out of bounds/);
    assert.throws(() => parseCron('0 24 * * *'), /out of bounds/);
});

test('parseCron: throws on empty field', () => {
    // 连续空格经 split(/\s+/) 后会产生空字符串段，表现为字段数不足
    assert.throws(() => parseCron('0  * * *'), /must have 5 fields/);
});

test('parseCron: combined range and single values in one field', () => {
    // "1-5,10,15-20" → {1,2,3,4,5,10,15,16,17,18,19,20}
    const parsed = parseCron('0 1-5,10,15-20 * * *');
    const hours = Array.from(parsed.hour).sort((a, b) => a - b);
    assert.deepEqual(hours, [1, 2, 3, 4, 5, 10, 15, 16, 17, 18, 19, 20]);
});

test('parseCron: step on range', () => {
    // "0-10/3" → 0,3,6,9
    const parsed = parseCron('0-10/3 0 * * *');
    const minutes = Array.from(parsed.minute).sort((a, b) => a - b);
    assert.deepEqual(minutes, [0, 3, 6, 9]);
});

test('parseCron: throws on zero step', () => {
    assert.throws(() => parseCron('*/0 * * * *'), /step must be positive/);
    assert.throws(() => parseCron('0-5/0 * * * *'), /step must be positive/);
});

test('parseCron: throws on inverted range', () => {
    assert.throws(() => parseCron('5-0 * * * *'), /out of bounds or inverted/);
});

test('collectInvalidTierCrons: reports invalid cron expressions for pre-validation', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 1,
        outputPrice: 2,
        tiers: [
            { cron: 'not a cron', inputPrice: 3, outputPrice: 4 },
            { cron: '* 9-23 * * 1-5', inputPrice: 5, outputPrice: 6 }
        ]
    };

    assert.deepEqual(collectInvalidTierCrons(pricing), ['not a cron']);
});

test('collectInvalidTierCrons: omitted cron uses default all-time expression', () => {
    const pricing: ModelTokenPricing = {
        inputPrice: 1,
        outputPrice: 2,
        tiers: [{ inputPrice: 3, outputPrice: 4 }]
    };

    assert.deepEqual(collectInvalidTierCrons(pricing), []);
});

// ============= resolveActiveTier =============

test('resolveActiveTier: returns undefined when no tiers configured', () => {
    const pricing: ModelTokenPricing = { inputPrice: 1, outputPrice: 2 };
    assert.equal(resolveActiveTier(pricing, new Date('2026-07-06T09:30:00Z')), undefined);
    assert.equal(resolveActiveTier(undefined, new Date()), undefined);
});

test('resolveActiveTier: matches weekday peak tier on a Monday morning (default Beijing time)', () => {
    // 2026-07-06T01:30:00Z = 北京时间周一 09:30（+8），命中 "* 9-23 * * 1-5"
    // 未配置 timezone，默认按北京时间匹配
    const mondayMorningBeijing = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }, // 工作日 9-23 点峰时
            { cron: '* 0-23 * * 0,6', inputPrice: 0.07, outputPrice: 0.14 } // 周末全天谷时
        ]
    };
    const tier = resolveActiveTier(pricing, mondayMorningBeijing);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
    assert.equal(tier.cron, '* 9-23 * * 1-5');
});

test('resolveActiveTier: matches weekend off-peak tier on a Saturday (default Beijing time)', () => {
    // 2026-07-04T02:00:00Z = 北京时间周六 10:00，命中周末谷时
    const saturdayBeijing = new Date('2026-07-04T02:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 },
            { cron: '* 0-23 * * 0,6', inputPrice: 0.07, outputPrice: 0.14 }
        ]
    };
    const tier = resolveActiveTier(pricing, saturdayBeijing);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.07);
    assert.equal(tier.cron, '* 0-23 * * 0,6');
});

test('resolveActiveTier: falls back to undefined when no tier matches (default Beijing time)', () => {
    // 2026-07-07T19:00:00Z = 北京时间周三 03:00，不在 9-23 峰时，也不在周末
    const wedEarlyBeijing = new Date('2026-07-07T19:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 },
            { cron: '* 0-23 * * 0,6', inputPrice: 0.07, outputPrice: 0.14 }
        ]
    };
    assert.equal(resolveActiveTier(pricing, wedEarlyBeijing), undefined);
});

test('resolveActiveTier: first matching tier wins (priority order)', () => {
    // 任意时刻都命中第一条 "* * * * *"
    const t = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', inputPrice: 99, outputPrice: 99 }, // always matches, should win
            { cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }
        ]
    };
    const tier = resolveActiveTier(pricing, t);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 99);
});

test('resolveActiveTier: skips tier with invalid cron', () => {
    const t = new Date('2026-07-06T09:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [
            { cron: 'not a cron', inputPrice: 99, outputPrice: 99 }, // invalid, skipped
            { cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }
        ]
    };
    const tier = resolveActiveTier(pricing, t);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
});

test('resolveActiveTier: respects explicit timezone overriding default Beijing time', () => {
    // 2026-07-06T03:00:00Z = 北京时间 11:00（命中峰时），但显式设 UTC 后 = 03:00（不命中）
    const t = new Date('2026-07-06T03:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', timezone: 'UTC', inputPrice: 0.28, outputPrice: 0.56 }]
    };
    assert.equal(resolveActiveTier(pricing, t), undefined);

    // 同一时刻、同一 cron，但用默认时区（北京时间）应命中
    const pricingBeijing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
    };
    const tier = resolveActiveTier(pricingBeijing, t);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
});

test('resolveActiveTier: invalid timezone falls back to Beijing time', () => {
    // 2026-07-06T01:30:00Z = 北京时间 09:30，命中 "* 9-23 * * 1-5"
    const t = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', timezone: 'Invalid/Timezone', inputPrice: 0.28, outputPrice: 0.56 }]
    };

    // 非法时区 → 回退北京时间 → 09:30 命中 9-23
    const tier = resolveActiveTier(pricing, t);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
});

test('resolveActiveTier: tier with empty serviceTier string treats as no filter', () => {
    const t = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', serviceTier: '', inputPrice: 0.21, outputPrice: 0.42 }]
    };

    // 空字符串 → falsy → 不限制 serviceTier → 命中
    const tier = resolveActiveTier(pricing, t, 'default');
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.21);
});

// ============= DeepSeek 风格：不限工作日 + 分段时段列表 =============
// cron "* 9-11,14-17 * * *" 覆盖每天 9:00-11:59 与 14:00-17:59（午休 12:00-13:59 落谷时）

test('resolveActiveTier: DeepSeek-style cron matches peak on a weekday morning', () => {
    // 2026-07-06T01:30:00Z = 北京时间周一 09:30，命中 "* 9-11,14-17 * * *"
    const mondayPeak = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-11,14-17 * * *', inputPrice: 0.21, outputPrice: 0.42 }]
    };
    const tier = resolveActiveTier(pricing, mondayPeak);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.21);
    assert.equal(tier.cron, '* 9-11,14-17 * * *');
});

test('resolveActiveTier: DeepSeek-style cron matches peak on a weekend morning (no weekday constraint)', () => {
    // 2026-07-04T01:30:00Z = 北京时间周六 09:30，不限工作日 → 仍命中峰时
    const saturdayPeak = new Date('2026-07-04T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-11,14-17 * * *', inputPrice: 0.21, outputPrice: 0.42 }]
    };
    const tier = resolveActiveTier(pricing, saturdayPeak);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.21);
});

test('resolveActiveTier: DeepSeek-style cron matches afternoon peak segment (14-17)', () => {
    // 2026-07-06T07:30:00Z = 北京时间周一 15:30，命中下午峰段 14-17
    const afternoonPeak = new Date('2026-07-06T07:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-11,14-17 * * *', inputPrice: 0.21, outputPrice: 0.42 }]
    };
    const tier = resolveActiveTier(pricing, afternoonPeak);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.21);
});

test('resolveActiveTier: DeepSeek-style cron falls back during lunch break (12:00-13:59)', () => {
    // 2026-07-06T05:00:00Z = 北京时间周一 13:00，午休时段，无 tier 命中
    const lunchBreak = new Date('2026-07-06T05:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-11,14-17 * * *', inputPrice: 0.21, outputPrice: 0.42 }]
    };
    assert.equal(resolveActiveTier(pricing, lunchBreak), undefined);
});

test('resolveActiveTier: DeepSeek-style cron falls back outside peak hours', () => {
    // 2026-07-06T10:00:00Z = 北京时间周一 18:00，峰时已结束（17:59 为最后一分钟）
    const afterPeak = new Date('2026-07-06T10:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-11,14-17 * * *', inputPrice: 0.21, outputPrice: 0.42 }]
    };
    assert.equal(resolveActiveTier(pricing, afterPeak), undefined);
});

// ============= 按服务等级计费（serviceTier 匹配） =============

test('resolveActiveTier: tier with serviceTier only matches when request tier equals', () => {
    // cron 始终命中（* * * * *），但 tier 限定了 serviceTier="priority"
    const peakTime = new Date('2026-07-06T01:30:00Z'); // 北京时间 09:30
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }]
    };

    // 请求选了 priority → 命中
    const matched = resolveActiveTier(pricing, peakTime, 'priority');
    assert.ok(matched);
    assert.equal(matched.inputPrice, 0.07);
    assert.equal(matched.serviceTier, 'priority');

    // 请求未选 priority → 不命中，回退 undefined
    assert.equal(resolveActiveTier(pricing, peakTime, 'default'), undefined);
    assert.equal(resolveActiveTier(pricing, peakTime, undefined), undefined);
});

test('resolveActiveTier: tier without serviceTier matches regardless of request tier', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* * * * *', inputPrice: 0.21, outputPrice: 0.42 }] // 无 serviceTier 限定
    };

    // 无论请求的 serviceTier 是什么，都命中
    assert.ok(resolveActiveTier(pricing, peakTime, 'priority'));
    assert.ok(resolveActiveTier(pricing, peakTime, 'default'));
    assert.ok(resolveActiveTier(pricing, peakTime, undefined));
});

test('resolveActiveTier: serviceTier-filtered tier and unfiltered tier coexist (priority first wins)', () => {
    const peakTime = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14, // 静态单档（default 价）
        outputPrice: 0.28,
        tiers: [
            { cron: '* * * * *', serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }, // priority 专属价
            { cron: '* 9-23 * * *', inputPrice: 0.21, outputPrice: 0.42 } // 峰时价（无 serviceTier 限定）
        ]
    };

    // 请求 priority：命中第一条
    const priorityTier = resolveActiveTier(pricing, peakTime, 'priority');
    assert.ok(priorityTier);
    assert.equal(priorityTier.inputPrice, 0.07);
    assert.equal(priorityTier.serviceTier, 'priority');

    // 请求 default：第一条被 serviceTier 过滤掉，命中第二条峰时价
    const defaultTier = resolveActiveTier(pricing, peakTime, 'default');
    assert.ok(defaultTier);
    assert.equal(defaultTier.inputPrice, 0.21);
    assert.equal(defaultTier.serviceTier, undefined);
});

test('resolveActiveTier: omitted cron defaults to all-time match', () => {
    const t = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ serviceTier: 'priority', inputPrice: 0.07, outputPrice: 0.14 }]
    };

    // 无 cron → 默认全时段 → priority 命中
    const tier = resolveActiveTier(pricing, t, 'priority');
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.07);
    assert.equal(tier.cron, undefined);
});

test('resolveActiveTier: omitted cron with contextSizeMin works', () => {
    // 无 cron，仅靠 contextSizeMin 过滤（contextSizeMin 在 costCalculator 层处理）
    const t = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ contextSizeMin: 512001, inputPrice: 0.28, outputPrice: 0.56 }]
    };

    // resolveActiveTier 不做 contextSizeMin 过滤 → cron 默认全时段 → 命中
    const tier = resolveActiveTier(pricing, t);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
});

// ============= resolvePricingBreakdown 基本行为 =============
// resolvePricingBreakdown 位于 costCalculator.ts，此处验证其基础回退语义

test('resolveActiveTier with undefined pricing returns undefined', () => {
    assert.equal(resolveActiveTier(undefined), undefined);
});

test('resolveActiveTier with no tiers returns undefined', () => {
    const pricing: ModelTokenPricing = { inputPrice: 1, outputPrice: 2, cacheReadPrice: 0.1 };
    assert.equal(resolveActiveTier(pricing), undefined);
});

test('resolveActiveTier with matching tier returns tier pricing', () => {
    const mondayMorningBeijing = new Date('2026-07-06T01:30:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        cacheReadPrice: 0.0028,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
    };
    const tier = resolveActiveTier(pricing, mondayMorningBeijing);
    assert.ok(tier);
    assert.equal(tier.inputPrice, 0.28);
    assert.equal(tier.outputPrice, 0.56);
});

test('resolveActiveTier falls back to undefined when no tier matches', () => {
    const wedEarlyBeijing = new Date('2026-07-07T19:00:00Z');
    const pricing: ModelTokenPricing = {
        inputPrice: 0.14,
        outputPrice: 0.28,
        tiers: [{ cron: '* 9-23 * * 1-5', inputPrice: 0.28, outputPrice: 0.56 }]
    };
    assert.equal(resolveActiveTier(pricing, wedEarlyBeijing), undefined);
});
