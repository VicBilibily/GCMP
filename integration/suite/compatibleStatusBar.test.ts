import assert from 'node:assert/strict';

import { ApiKeyManager } from '../../src/utils/config/apiKeyManager';
import { CompatibleStatusBar, type CompatibleProviderBalance } from '../../src/status/compatibleStatusBar';
import { getCompatibleProviderCacheUpdate } from '../../src/status/compatibleStatusBarCache';
import { getCachedRequestBalance, hashRequestApiKey } from '../../src/quota/requestBalance';
import { BalanceQueryManager } from '../../src/quota/compatible/balanceQueryManager';

class SnapshotStatusBar extends CompatibleStatusBar {
    render(providers: CompatibleProviderBalance[]): { text: string; tooltip: string } {
        const data = { providers, successCount: providers.length, totalCount: providers.length };
        return { text: this.getDisplayText(data), tooltip: this.generateTooltip(data).value };
    }

    receive(provider: CompatibleProviderBalance, timestamp: number): void {
        const data = { providers: [provider], successCount: 1, totalCount: 1 };
        this.lastStatusData = { data, timestamp };
        this.onStatusUpdatedFromEvent(data);
    }
}

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
    for (const authenticated of [true, false]) {
        test(`compatible query captures authentication scope before dispatch: ${authenticated}`, async () => {
            const providerId = `compatible-scope-${authenticated}`;
            const bar = new SnapshotStatusBar();
            const originalRequires = BalanceQueryManager.requiresApiKey;
            const originalQuery = BalanceQueryManager.queryBalance;
            const originalKey = ApiKeyManager.getApiKey;
            const originalHasKey = ApiKeyManager.hasValidApiKey;
            let requiresKey = authenticated;
            let queries = 0;
            Reflect.set(bar, 'getConfiguredProviderEntries', () => [providerId]);
            BalanceQueryManager.requiresApiKey = () => requiresKey;
            BalanceQueryManager.queryBalance = async () => {
                queries++;
                requiresKey = !authenticated;
                return { balance: 5, currency: 'USD' };
            };
            ApiKeyManager.getApiKey = async () => 'scope-test-key';
            ApiKeyManager.hasValidApiKey = async () => true;
            try {
                const query: (manual: boolean) => Promise<{ success: boolean; error?: string }> = Reflect.get(
                    bar,
                    'performApiQuery'
                );
                const result = await query.call(bar, true);
                assert.equal(result.success, true, result.error);
                assert.equal(getCachedRequestBalance(providerId, 'scope-test-key')?.entries[0].balance, 5);
                assert.equal(
                    getCachedRequestBalance(providerId, 'another-key')?.entries[0].balance,
                    authenticated ? undefined : 5
                );
                assert.equal(queries, 1);
            } finally {
                BalanceQueryManager.requiresApiKey = originalRequires;
                BalanceQueryManager.queryBalance = originalQuery;
                ApiKeyManager.getApiKey = originalKey;
                ApiKeyManager.hasValidApiKey = originalHasKey;
                bar.dispose();
            }
        });
    }

    test('explicit provider-scoped queries are available without leaking credential-scoped results', () => {
        const now = Date.now();
        const providerId = 'public-compatible';
        const bar = new SnapshotStatusBar();
        try {
            const publicResult = { ...createBalance(`${providerId}::public`, now), balance: 5 };
            Reflect.set(publicResult, 'requestBalanceScope', 'provider');
            bar.receive(publicResult, now);
            bar.receive(
                {
                    ...createBalance(`${providerId}::private`, now),
                    balance: 3,
                    requestBalanceKeyHash: hashRequestApiKey('private-query-key')
                },
                now
            );
            assert.deepEqual(
                getCachedRequestBalance(providerId, 'other-request-key')?.entries.map(entry => entry.balance),
                [5]
            );
            assert.deepEqual(
                getCachedRequestBalance(providerId, 'private-query-key')
                    ?.entries.map(entry => entry.balance)
                    .sort(),
                [3, 5]
            );
            assert.equal(getCachedRequestBalance('another-public-provider', 'other-request-key'), undefined);
        } finally {
            bar.dispose();
        }
    });

    test('raw compatible data replays text and full tooltip without reading credentials', () => {
        const now = Date.now();
        const providerId = 'compatible-offline-replay';
        const bar = new SnapshotStatusBar();
        const originalGetApiKey = ApiKeyManager.getApiKey;
        let keyReads = 0;
        ApiKeyManager.getApiKey = async () => {
            keyReads++;
            throw new Error('Offline replay must not read credentials');
        };
        try {
            const provider: CompatibleProviderBalance = {
                ...createBalance(providerId, now),
                providerName: 'Original provider',
                balance: 12.345,
                paid: 10,
                granted: 2.345,
                items: [
                    { displayName: 'Wallet', balance: 12.345, currency: 'USD', paid: 10, granted: 2.345 },
                    { displayName: 'Tokens', balance: 123456, currency: 'Tokens' }
                ],
                requestBalanceKeyHash: hashRequestApiKey('offline-compatible-key')
            };
            const expected = bar.render([provider]);
            bar.receive(provider, now);
            const value = getCachedRequestBalance(providerId, 'offline-compatible-key');
            const saved = JSON.parse(JSON.stringify(value)) as typeof value;
            provider.providerName = 'Renamed provider';
            provider.items![0].balance = 999;
            const snapshot = saved?.statusSnapshots?.[0];
            assert.ok(snapshot?.provider === 'compatible');
            assert.equal(Reflect.has(snapshot, 'context'), false);
            const replay = bar.render([
                {
                    providerId: snapshot.data.providerId,
                    providerName: snapshot.data.providerName,
                    ...snapshot.data.balanceInfo,
                    lastUpdated: new Date(snapshot.queriedAt),
                    success: true
                }
            ]);
            assert.deepEqual(replay, expected);
            assert.equal(keyReads, 0);
            assert.equal(JSON.stringify(saved).includes('offline-compatible-key'), false);
            assert.equal(getCachedRequestBalance(providerId, 'different-offline-key'), undefined);
        } finally {
            ApiKeyManager.getApiKey = originalGetApiKey;
            bar.dispose();
        }
    });

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

    test('usage snapshot retains the provider query time instead of the aggregate event time', () => {
        const now = Date.now();
        const providerId = 'snapshot-provider-time';
        const bar = new SnapshotStatusBar();
        const originalGetApiKey = ApiKeyManager.getApiKey;
        let keyReads = 0;
        ApiKeyManager.getApiKey = async () => {
            keyReads++;
            throw new Error('Snapshot restoration must not read the receiver key');
        };
        try {
            bar.receive(
                {
                    ...createBalance(providerId, now - 20_000),
                    balance: 20,
                    requestBalanceKeyHash: hashRequestApiKey('sender-key')
                },
                now
            );
            const saved = getCachedRequestBalance(providerId, 'sender-key');
            assert.equal(saved?.queriedAt, now - 20_000);
            assert.deepEqual(saved?.entries, [{ id: providerId, balance: 20, currency: 'USD' }]);
            assert.equal(saved?.statusSnapshots?.length, 1);
            const status = saved?.statusSnapshots?.[0];
            assert.ok(status?.provider === 'compatible');
            assert.equal(status.version, 1);
            assert.equal(status.queriedAt, now - 20_000);
            assert.deepEqual(status.data, {
                providerId,
                providerName: providerId,
                balanceInfo: { balance: 20, currency: 'USD' }
            });
            assert.equal(Reflect.has(status, 'context'), false);
            assert.equal(getCachedRequestBalance(providerId, 'receiver-key'), undefined);
            assert.equal(keyReads, 0);
        } finally {
            ApiKeyManager.getApiKey = originalGetApiKey;
            bar.dispose();
        }
    });

    test('an older provider broadcast cannot replace a newer usage snapshot', () => {
        const now = Date.now();
        const providerId = 'snapshot-provider-order';
        const bar = new SnapshotStatusBar();
        try {
            bar.receive(
                {
                    ...createBalance(providerId, now - 1_000),
                    balance: 20,
                    requestBalanceKeyHash: hashRequestApiKey('sender-key')
                },
                now
            );
            bar.receive(
                {
                    ...createBalance(providerId, now - 60_000),
                    balance: 100,
                    requestBalanceKeyHash: hashRequestApiKey('sender-key')
                },
                now + 1
            );
            assert.equal(getCachedRequestBalance(providerId, 'sender-key')?.entries[0].balance, 20);
            assert.equal(getCachedRequestBalance(providerId, 'sender-key')?.queriedAt, now - 1_000);
        } finally {
            bar.dispose();
        }
    });

    for (const timing of ['expired', 'invalid', 'future'] as const) {
        test(`${timing} provider query time is not replaced by fresh event time for usage`, () => {
            const now = Date.now();
            const queriedAt =
                timing === 'expired' ? now - 360_000
                : timing === 'future' ? now + 60_000
                : NaN;
            const providerId = `snapshot-provider-${timing}`;
            const bar = new SnapshotStatusBar();
            try {
                bar.receive(
                    {
                        ...createBalance(providerId, queriedAt),
                        balance: 100,
                        requestBalanceKeyHash: hashRequestApiKey('sender-key')
                    },
                    now
                );
                assert.equal(getCachedRequestBalance(providerId, 'sender-key'), undefined);
            } finally {
                bar.dispose();
            }
        });
    }

    test('a legacy provider balance without a full hash is not attributed to a request key', () => {
        const now = Date.now();
        const providerId = 'snapshot-provider-legacy';
        const bar = new SnapshotStatusBar();
        try {
            bar.receive(createBalance(providerId, now), now);
            assert.equal(getCachedRequestBalance(providerId, 'sender-key'), undefined);
        } finally {
            bar.dispose();
        }
    });
});
