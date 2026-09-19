import assert from 'node:assert/strict';
import test from 'node:test';

import { isKimiMonthlyCapEnabled, normalizeKimiUsage } from './kimiUsageParser';

/** 2026-09 新版接口真实响应样例 */
const NEW_FORMAT_SAMPLE = {
    usage: {
        limit: '100',
        used: '17',
        remaining: '83',
        resetTime: '2026-09-20T16:00:13.115806Z'
    },
    limits: [
        {
            window: {
                duration: 300,
                timeUnit: 'TIME_UNIT_MINUTE'
            },
            detail: {
                limit: '100',
                remaining: '100',
                resetTime: '2026-09-15T07:00:13.115806Z'
            }
        }
    ],
    booster_wallet: {
        balance: { amountLeft: '3395052800' },
        status: 'STATUS_ACTIVE',
        topupLimit: { currency: 'CNY', priceInCents: '300000' },
        monthlyChargeLimit: { currency: 'CNY', priceInCents: '0' },
        monthlyUsed: { currency: 'CNY', priceInCents: '0' }
    },
    usages: {
        limit_5h: {
            used_ratio: 0,
            reset_time: '2026-09-15T07:00:13Z'
        },
        limit_7d: {
            used_ratio: 0.168292,
            reset_time: '2026-09-20T16:00:12Z'
        }
    }
};

test('new format: summary prefers usages.limit_7d ratio over legacy usage', () => {
    const result = normalizeKimiUsage(NEW_FORMAT_SAMPLE);

    assert.ok(result);
    assert.deepEqual(result.summary, {
        limit: 100,
        used: 17,
        remaining: 83,
        resetTime: '2026-09-20T16:00:12Z',
        period: 'weekly'
    });
});

test('new format: does not duplicate the 5h window already present in limits', () => {
    const result = normalizeKimiUsage(NEW_FORMAT_SAMPLE);

    assert.ok(result);
    assert.equal(result.windows.length, 1);
    assert.deepEqual(result.windows[0], {
        duration: 300,
        timeUnit: 'TIME_UNIT_MINUTE',
        detail: {
            limit: 100,
            used: 0,
            remaining: 100,
            resetTime: '2026-09-15T07:00:13.115806Z'
        }
    });
});

test('usages-only response synthesizes summary and the 5h window', () => {
    const result = normalizeKimiUsage({
        usages: {
            limit_5h: { used_ratio: 0.5, reset_time: '2026-09-15T07:00:13Z' },
            limit_7d: { used_ratio: 0.168292, reset_time: '2026-09-20T16:00:12Z' }
        }
    });

    assert.ok(result);
    assert.deepEqual(result.summary, {
        limit: 100,
        used: 17,
        remaining: 83,
        resetTime: '2026-09-20T16:00:12Z',
        period: 'weekly'
    });
    assert.deepEqual(result.windows, [
        {
            duration: 300,
            timeUnit: 'TIME_UNIT_MINUTE',
            detail: { limit: 100, used: 50, remaining: 50, resetTime: '2026-09-15T07:00:13Z' }
        }
    ]);
});

test('legacy response without usages keeps usage/limits behavior', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        limits: [
            {
                window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
                detail: { limit: '100', used: '0', remaining: '100', resetTime: '2026-09-15T07:00:13Z' }
            }
        ]
    });

    assert.ok(result);
    assert.deepEqual(result.summary, {
        limit: 100,
        used: 17,
        remaining: 83,
        resetTime: '2026-09-20T16:00:13Z',
        period: 'weekly'
    });
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].detail.used, 0);
});

/** 2026-09 新会员体系真实响应样例：仅 5 小时 + 月度额度，无 usage/limit_7d/booster_wallet */
const NEW_MEMBER_SAMPLE = {
    limits: [
        {
            window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: { limit: '100', remaining: '100', resetTime: '2026-09-19T06:56:01.705898Z' }
        }
    ],
    usages: {
        limit_5h: { used_ratio: 0, reset_time: '2026-09-19T06:56:01Z' },
        limit_month_total: { used_ratio: 0, reset_time: '2026-10-20T00:00:00Z' },
        limit_month_code: { used_ratio: 0, reset_time: '2026-10-20T00:00:00Z' }
    }
};

test('new membership: monthly code quota becomes the summary and total is ignored', () => {
    const result = normalizeKimiUsage(NEW_MEMBER_SAMPLE);

    assert.ok(result);
    assert.deepEqual(result.summary, {
        limit: 100,
        used: 0,
        remaining: 100,
        resetTime: '2026-10-20T00:00:00Z',
        period: 'monthly'
    });
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].duration, 300);
});

test('new membership: limit_month_total alone is not treated as quota data', () => {
    assert.equal(
        normalizeKimiUsage({
            usages: {
                limit_5h: { used_ratio: 0, reset_time: '2026-09-19T06:56:01Z' },
                limit_month_total: { used_ratio: 0, reset_time: '2026-10-20T00:00:00Z' }
            }
        }),
        undefined
    );
});

test('new membership: monthly code quota alone can be the summary', () => {
    const result = normalizeKimiUsage({
        usages: {
            limit_5h: { used_ratio: 0.4, reset_time: '2026-09-19T06:56:01Z' },
            limit_month_code: { used_ratio: 0.25, reset_time: '2026-10-20T00:00:00Z' }
        }
    });

    assert.ok(result);
    assert.deepEqual(result.summary, {
        limit: 100,
        used: 25,
        remaining: 75,
        resetTime: '2026-10-20T00:00:00Z',
        period: 'monthly'
    });
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].duration, 300);
});

test('new membership: malformed monthly windows fall back to legacy usage', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        usages: {
            limit_month_code: { used_ratio: null }
        }
    });

    assert.ok(result);
    assert.equal(result.summary.period, 'weekly');
    assert.equal(result.summary.remaining, 83);
});

test('returns undefined when neither usage nor limit_7d is present', () => {
    assert.equal(
        normalizeKimiUsage({ usages: { limit_5h: { used_ratio: 0, reset_time: '2026-09-15T07:00:13Z' } } }),
        undefined
    );
    assert.equal(normalizeKimiUsage({}), undefined);
    assert.equal(normalizeKimiUsage(null), undefined);
});

test('limits entries missing window or detail are skipped instead of crashing', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        limits: [
            null,
            {},
            { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' } },
            { detail: { limit: '100', remaining: '90' } },
            { window: { timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '90' } },
            {
                window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
                detail: { limit: '100', remaining: '90', resetTime: '2026-09-19T06:00:00Z' }
            }
        ]
    });

    assert.ok(result);
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].detail.remaining, 90);
});

test('malformed limits container is ignored instead of crashing', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        limits: { unexpected: true }
    });

    assert.ok(result);
    assert.deepEqual(result.windows, []);
});

test('usage without resetTime is ignored in favor of ratio windows', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83' },
        usages: { limit_7d: { used_ratio: 0.2, reset_time: '2026-09-20T16:00:12Z' } }
    });

    assert.ok(result);
    assert.equal(result.summary.remaining, 80);
    assert.equal(result.summary.resetTime, '2026-09-20T16:00:12Z');
});

test('usage without resetTime alone yields undefined', () => {
    assert.equal(normalizeKimiUsage({ usage: { limit: '100', remaining: '83' } }), undefined);
});

test('new membership without the limits field still works via usages', () => {
    const result = normalizeKimiUsage({
        usages: {
            limit_5h: { used_ratio: 0.1, reset_time: '2026-09-19T06:56:01Z' },
            limit_month_code: { used_ratio: 0.3, reset_time: '2026-10-20T00:00:00Z' }
        }
    });

    assert.ok(result);
    assert.equal(result.summary.period, 'monthly');
    assert.equal(result.summary.remaining, 70);
    assert.deepEqual(result.windows, [
        {
            duration: 300,
            timeUnit: 'TIME_UNIT_MINUTE',
            detail: { limit: 100, used: 10, remaining: 90, resetTime: '2026-09-19T06:56:01Z' }
        }
    ]);
});

test('malformed ratio windows are ignored and fall back to legacy fields', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        usages: {
            limit_5h: { used_ratio: 1.5, reset_time: '2026-09-15T07:00:13Z' },
            limit_7d: { used_ratio: 'not-a-number' }
        }
    });

    assert.ok(result);
    assert.equal(result.summary.remaining, 83);
    assert.equal(result.summary.resetTime, '2026-09-20T16:00:13Z');
    assert.equal(result.windows.length, 0);
});

test('null ratio windows are ignored instead of treated as zero usage', () => {
    const result = normalizeKimiUsage({
        usage: { limit: '100', used: '17', remaining: '83', resetTime: '2026-09-20T16:00:13Z' },
        usages: {
            limit_5h: { used_ratio: null, reset_time: '2026-09-15T07:00:13Z' },
            limit_7d: { used_ratio: null, reset_time: '2026-09-20T16:00:12Z' }
        }
    });

    assert.ok(result);
    assert.equal(result.summary.remaining, 83);
    assert.equal(result.summary.resetTime, '2026-09-20T16:00:13Z');
    assert.equal(result.windows.length, 0);
});

test('monthly cap falls back to amount comparison when the enabled flag is removed', () => {
    assert.equal(isKimiMonthlyCapEnabled(undefined, { priceInCents: '0' }), false);
    assert.equal(isKimiMonthlyCapEnabled(undefined, { priceInCents: '300000' }), true);
    assert.equal(isKimiMonthlyCapEnabled(undefined, { priceInCents: 'not-a-number' }), false);
    assert.equal(isKimiMonthlyCapEnabled(undefined, undefined), false);
});

test('monthly cap honors the explicit legacy flag when present', () => {
    assert.equal(isKimiMonthlyCapEnabled(true, { priceInCents: '0' }), true);
    assert.equal(isKimiMonthlyCapEnabled(false, { priceInCents: '300000' }), false);
});
