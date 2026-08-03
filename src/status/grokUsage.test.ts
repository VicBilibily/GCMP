import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGrokBillingUsage, resolveGrokBillingBaseUrl } from './grokUsage';

test('credits billing converts Grok weekly used percent into the remaining quota', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                creditUsagePercent: 37.25,
                subscriptionTier: 'SuperGrok',
                currentPeriod: {
                    type: 'USAGE_PERIOD_TYPE_WEEKLY',
                    start: '2026-07-27T00:00:00.000Z',
                    end: '2026-08-03T00:00:00.000Z'
                },
                billingPeriodStart: '2026-07-27T00:00:00.000Z',
                billingPeriodEnd: '2026-08-03T00:00:00.000Z'
            }
        },
        'credits'
    );

    assert.deepEqual(result, {
        kind: 'usage',
        usage: {
            type: 'weekly',
            usedPercent: 37.25,
            remainingPercent: 62.75,
            resetAt: '2026-08-03T00:00:00.000Z',
            windowMinutes: 10080,
            subscriptionTier: 'SuperGrok'
        }
    });
});

test('credits billing treats an omitted protobuf zero as zero usage only for an exact weekly period', () => {
    const periodStart = '2026-07-27T00:00:00.000Z';
    const periodEnd = '2026-08-03T00:00:00.000Z';
    const result = parseGrokBillingUsage(
        {
            config: {
                currentPeriod: {
                    type: 'USAGE_PERIOD_TYPE_WEEKLY',
                    start: periodStart,
                    end: periodEnd
                },
                billingPeriodStart: periodStart,
                billingPeriodEnd: periodEnd
            }
        },
        'credits'
    );

    assert.deepEqual(result, {
        kind: 'usage',
        usage: {
            type: 'weekly',
            usedPercent: 0,
            remainingPercent: 100,
            resetAt: periodEnd,
            windowMinutes: 10080
        }
    });
});

test('credits billing does not report ambiguous omitted usage as a full weekly quota', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                currentPeriod: {
                    type: 'USAGE_PERIOD_TYPE_WEEKLY',
                    start: '2026-07-01T00:00:00.000Z',
                    end: '2026-07-08T00:00:00.000Z'
                },
                billingPeriodStart: '2026-07-01T00:00:00.000Z',
                billingPeriodEnd: '2026-08-01T00:00:00.000Z'
            }
        },
        'credits'
    );

    assert.deepEqual(result, { kind: 'unavailable' });
});

test('credits billing keeps the subscription tier for a monthly fallback response', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                subscriptionTier: 'SuperGrok',
                isUnifiedBillingUser: true
            }
        },
        'credits'
    );

    assert.deepEqual(result, {
        kind: 'unavailable',
        subscriptionTier: 'SuperGrok'
    });
});

test('unified billing converts string monthly amounts into a remaining percentage', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                monthlyLimit: { val: '200' },
                used: { val: '50' },
                billingPeriodEnd: '2026-08-31T23:59:59.000Z',
                subscriptionTier: 'SuperGrok Heavy'
            }
        },
        'billing'
    );

    assert.deepEqual(result, {
        kind: 'usage',
        usage: {
            type: 'monthly',
            usedPercent: 25,
            remainingPercent: 75,
            resetAt: '2026-08-31T23:59:59.000Z',
            windowMinutes: 43200,
            subscriptionTier: 'SuperGrok Heavy'
        }
    });
});

test('billing rejects malformed numeric fields instead of silently replacing business values', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                creditUsagePercent: '37',
                billingPeriodEnd: '2026-08-03T00:00:00.000Z'
            }
        },
        'credits'
    );

    assert.deepEqual(result, {
        kind: 'invalid',
        error: 'creditUsagePercent must be a finite number'
    });
});

test('billing preserves an overage while flooring the remaining quota at zero', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                monthlyLimit: { val: 100 },
                used: { val: 125 },
                billingPeriodEnd: '2026-08-31T23:59:59.000Z'
            }
        },
        'billing'
    );

    assert.equal(result.kind, 'usage');
    if (result.kind === 'usage') {
        assert.equal(result.usage.usedPercent, 125);
        assert.equal(result.usage.remainingPercent, 0);
    }
});

test('credits billing rejects a negative used percentage', () => {
    const result = parseGrokBillingUsage(
        {
            config: {
                creditUsagePercent: -1,
                billingPeriodEnd: '2026-08-03T00:00:00.000Z'
            }
        },
        'credits'
    );

    assert.deepEqual(result, {
        kind: 'invalid',
        error: 'creditUsagePercent must not be negative'
    });
});

test('billing base URL honors the Grok CLI override and removes trailing slashes', () => {
    assert.equal(
        resolveGrokBillingBaseUrl({ GROK_CLI_CHAT_PROXY_BASE_URL: ' https://proxy.example.test/v2/// ' }),
        'https://proxy.example.test/v2'
    );
    assert.equal(resolveGrokBillingBaseUrl({}), 'https://cli-chat-proxy.grok.com/v1');
});
