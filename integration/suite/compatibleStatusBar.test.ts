import assert from 'node:assert/strict';

import type { CompatibleProviderBalance } from '../../src/status/compatibleStatusBar';
import { getCompatibleProviderCacheUpdate } from '../../src/status/compatibleStatusBarCache';

function createBalance(providerId: string, timestamp: number, success = true): CompatibleProviderBalance {
    return {
        providerId,
        providerName: providerId,
        balance: timestamp,
        currency: 'USD',
        lastUpdated: new Date(timestamp),
        success
    };
}

suite('compatibleStatusBar provider cache sync', () => {
    test('ignores older provider cache from inter-instance events', () => {
        const existingCache = {
            balance: createBalance('provider-a', 200),
            timestamp: 200
        };

        const update = getCompatibleProviderCacheUpdate(existingCache, createBalance('provider-a', 100), 500);

        assert.equal(update, undefined);
    });

    test('ignores failed provider entries from inter-instance events', () => {
        const update = getCompatibleProviderCacheUpdate(undefined, createBalance('provider-b', 300, false), 500);

        assert.equal(update, undefined);
    });

    test('accepts newer successful provider cache from inter-instance events', () => {
        const update = getCompatibleProviderCacheUpdate(
            { balance: createBalance('provider-c', 100), timestamp: 100 },
            createBalance('provider-c', 300),
            500
        );

        assert.equal(update?.timestamp, 300);
        assert.ok(update?.balance.lastUpdated instanceof Date);
    });

    test('falls back to event timestamp when provider lastUpdated is invalid', () => {
        const update = getCompatibleProviderCacheUpdate(
            undefined,
            {
                ...createBalance('provider-d', 100),
                lastUpdated: new Date(Number.NaN)
            },
            500
        );

        assert.equal(update?.timestamp, 500);
        assert.ok(Number.isNaN(update?.balance.lastUpdated.getTime()));
    });
});
