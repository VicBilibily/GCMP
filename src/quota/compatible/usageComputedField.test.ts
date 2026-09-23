import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveUsageFieldValue } from './usageComputedField';
import type { UsageComputedField } from '../../types/sharedTypes';

describe('resolveUsageFieldValue', () => {
    const data = {
        data: {
            subscriptions: [
                {
                    subscription: {
                        amount_total: 1200,
                        amount_used: 200
                    }
                }
            ]
        }
    };

    it('resolves direct string path', () => {
        assert.strictEqual(
            resolveUsageFieldValue(data, 'data.subscriptions[0].subscription.amount_total', 'balance'),
            1200
        );
    });

    it('returns undefined when field source is undefined', () => {
        assert.strictEqual(resolveUsageFieldValue(data, undefined, 'balance'), undefined);
    });

    it('keeps flat subtract/divide working (regression)', () => {
        assert.strictEqual(
            resolveUsageFieldValue(
                data,
                {
                    operation: 'subtract',
                    paths: [
                        'data.subscriptions[0].subscription.amount_total',
                        'data.subscriptions[0].subscription.amount_used'
                    ]
                },
                'balance'
            ),
            1000
        );
        assert.strictEqual(
            resolveUsageFieldValue(
                data,
                { operation: 'divide', paths: ['data.subscriptions[0].subscription.amount_total', 500000] },
                'granted'
            ),
            1200 / 500000
        );
    });

    it('computes (a-b)/c with nested subtract inside divide', () => {
        const result = resolveUsageFieldValue(
            data,
            {
                operation: 'divide',
                paths: [
                    {
                        operation: 'subtract',
                        paths: [
                            'data.subscriptions[0].subscription.amount_total',
                            'data.subscriptions[0].subscription.amount_used'
                        ]
                    },
                    500000
                ]
            },
            'balance'
        );
        assert.strictEqual(result, (1200 - 200) / 500000);
    });

    it('sums wildcard array fields before applying the calculation', () => {
        const subscriptions = {
            data: {
                subscriptions: [
                    { subscription: { amount_total: 1200, amount_used: 200 } },
                    { subscription: { amount_total: '800', amount_used: 'invalid' } }
                ]
            }
        };
        const result = resolveUsageFieldValue(
            subscriptions,
            {
                operation: 'divide',
                paths: [
                    {
                        operation: 'subtract',
                        paths: [
                            'data.subscriptions[*].subscription.amount_total',
                            'data.subscriptions[*].subscription.amount_used'
                        ]
                    },
                    100
                ]
            },
            'balance'
        );
        assert.strictEqual(result, (1200 + 800 - 200) / 100);
    });

    it('computes a/(b-c) with nested subtract as divisor', () => {
        const result = resolveUsageFieldValue(
            data,
            {
                operation: 'divide',
                paths: [
                    'data.subscriptions[0].subscription.amount_total',
                    {
                        operation: 'subtract',
                        paths: [
                            'data.subscriptions[0].subscription.amount_total',
                            'data.subscriptions[0].subscription.amount_used'
                        ]
                    }
                ]
            },
            'balance'
        );
        assert.strictEqual(result, 1200 / (1200 - 200));
    });

    it('supports multi-level nesting mixed with constants', () => {
        // ((1200 - 200) * 2) / 500 = 4
        const result = resolveUsageFieldValue(
            data,
            {
                operation: 'divide',
                paths: [
                    {
                        operation: 'multiply',
                        paths: [
                            {
                                operation: 'subtract',
                                paths: [
                                    'data.subscriptions[0].subscription.amount_total',
                                    'data.subscriptions[0].subscription.amount_used'
                                ]
                            },
                            2
                        ]
                    },
                    500
                ]
            },
            'balance'
        );
        assert.strictEqual(result, 4);
    });

    it('applies treatMissingAsZero within nested calculation', () => {
        const partialData = { data: { subscriptions: [{ subscription: { amount_total: 100 } }] } };
        const result = resolveUsageFieldValue(
            partialData,
            {
                operation: 'divide',
                paths: [
                    {
                        operation: 'subtract',
                        paths: [
                            'data.subscriptions[0].subscription.amount_total',
                            'data.subscriptions[0].subscription.amount_used'
                        ],
                        treatMissingAsZero: true
                    },
                    500000
                ]
            },
            'balance'
        );
        assert.strictEqual(result, 100 / 500000);
    });

    it('returns undefined when a nested calculation misses a path', () => {
        const result = resolveUsageFieldValue(
            {},
            {
                operation: 'divide',
                paths: [{ operation: 'subtract', paths: ['a', 'b'] }, 2]
            },
            'balance'
        );
        assert.strictEqual(result, undefined);
    });

    it('throws on invalid nested computed field configuration', () => {
        const invalidConfig = {
            operation: 'divide',
            paths: [{ operation: 'nope', paths: ['a'] }, 2]
        } as unknown as UsageComputedField;
        assert.throws(() => resolveUsageFieldValue(data, invalidConfig, 'balance'), {
            message: 'Invalid usage.fields.balance computed field configuration'
        });
    });

    it('throws on empty nested paths', () => {
        const invalidConfig = {
            operation: 'divide',
            paths: [{ operation: 'subtract', paths: [] }, 2]
        } as unknown as UsageComputedField;
        assert.throws(() => resolveUsageFieldValue(data, invalidConfig, 'balance'), {
            message: 'Invalid usage.fields.balance computed field configuration'
        });
    });

    it('throws on non-finite result (divide by zero)', () => {
        assert.throws(
            () =>
                resolveUsageFieldValue(
                    data,
                    { operation: 'divide', paths: ['data.subscriptions[0].subscription.amount_total', 0] },
                    'balance'
                ),
            { message: 'Invalid usage.fields.balance computed field result' }
        );
    });
});
