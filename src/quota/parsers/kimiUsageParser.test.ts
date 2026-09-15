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
        resetTime: '2026-09-20T16:00:12Z'
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
        resetTime: '2026-09-20T16:00:12Z'
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
        resetTime: '2026-09-20T16:00:13Z'
    });
    assert.equal(result.windows.length, 1);
    assert.equal(result.windows[0].detail.used, 0);
});

test('returns undefined when neither usage nor limit_7d is present', () => {
    assert.equal(
        normalizeKimiUsage({ usages: { limit_5h: { used_ratio: 0, reset_time: '2026-09-15T07:00:13Z' } } }),
        undefined
    );
    assert.equal(normalizeKimiUsage({}), undefined);
    assert.equal(normalizeKimiUsage(null), undefined);
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
