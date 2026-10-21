import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestStatusData } from '../usages/fileLogger/types';
import {
    cacheRequestBalanceByKeyHash,
    cacheRequestBalanceEntryByKeyHash,
    cacheProviderRequestBalanceEntry,
    getCachedRequestBalanceByKeyHash,
    getCachedRequestBalanceForRequest,
    hashRequestApiKey
} from './requestBalance';

const keyHash = hashRequestApiKey('ordering-test-key');

function moonshotStatus(balance: number): RequestStatusData {
    return {
        provider: 'moonshot',
        data: {
            balanceInfo: { available_balance: balance, cash_balance: balance, voucher_balance: 0 }
        }
    };
}

for (const timing of ['older', 'expired', 'future', 'invalid'] as const) {
    test(`raw status rejects ${timing} data with its original query time`, context => {
        const now = Date.now();
        context.mock.method(Date, 'now', () => now);
        const hash = hashRequestApiKey(`raw-${timing}`);
        const entry = { id: 'moonshot', balance: 20, currency: 'CNY' };
        cacheRequestBalanceByKeyHash('moonshot', hash, [entry], now - 1_000, moonshotStatus(20));
        const queriedAt =
            timing === 'older' ? now - 2_000
            : timing === 'expired' ? now - 360_000
            : timing === 'future' ? now + 1
            : NaN;
        cacheRequestBalanceByKeyHash('moonshot', hash, [{ ...entry, balance: 100 }], queriedAt, moonshotStatus(100));
        const snapshot = getCachedRequestBalanceByKeyHash('moonshot', hash);
        assert.deepEqual(snapshot?.entries, [entry]);
        assert.deepEqual(snapshot?.statusSnapshots, [
            { provider: 'moonshot', data: moonshotStatus(20).data, version: 1, queriedAt: now - 1_000 }
        ]);
    });
}

test('raw status is copied at both cache boundaries and filters unknown properties', () => {
    const hash = hashRequestApiKey('raw-copy');
    const raw = moonshotStatus(20);
    assert.equal(raw.provider, 'moonshot');
    const input = {
        ...raw,
        apiKey: 'secret-key',
        context: { language: 'en', timeZone: 'UTC' },
        data: { ...raw.data, lastUpdated: 'saved display time', headers: { Authorization: 'secret-token' } }
    };
    cacheRequestBalanceByKeyHash(
        'moonshot',
        hash,
        [{ id: 'moonshot', balance: 20, currency: 'CNY' }],
        Date.now(),
        input
    );
    raw.data.balanceInfo.available_balance = 100;
    Reflect.set(raw, 'context', { title: 'Changed title' });
    const first = getCachedRequestBalanceByKeyHash('moonshot', hash);
    const status = first?.statusSnapshots?.[0];
    assert.ok(status?.provider === 'moonshot');
    assert.equal(status.data.balanceInfo.available_balance, 20);
    assert.equal(Reflect.has(status, 'context'), false);
    assert.equal(Reflect.has(status.data, 'lastUpdated'), false);
    status.data.balanceInfo.available_balance = 200;
    Reflect.set(status, 'context', { title: 'Changed result' });
    const second = getCachedRequestBalanceByKeyHash('moonshot', hash);
    const saved = second?.statusSnapshots?.[0];
    assert.ok(saved?.provider === 'moonshot');
    assert.equal(saved.data.balanceInfo.available_balance, 20);
    assert.equal(Reflect.has(saved, 'context'), false);
    assert.equal(JSON.stringify(second).includes('secret'), false);
    assert.equal(getCachedRequestBalanceByKeyHash('deepseek', hash), undefined);
});

test('raw quota without a money balance replaces older account data and expires without renewal', context => {
    let now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const hash = hashRequestApiKey('raw-quota-only');
    cacheRequestBalanceByKeyHash('zhipu', hash, [{ id: 'zhipu', balance: 10, currency: 'CNY' }], now - 1_000);
    const raw: RequestStatusData = {
        provider: 'zhipu',
        data: {
            limits: [{ type: 'TOKENS_LIMIT', unit: 6, percentage: 25, nextResetTime: now + 60_000 }],
            nextResetTime: now + 60_000
        }
    };
    cacheRequestBalanceByKeyHash('zhipu', hash, [], now, raw);
    const snapshot = getCachedRequestBalanceByKeyHash('zhipu', hash);
    assert.deepEqual(snapshot?.entries, []);
    assert.equal(snapshot?.statusSnapshots?.[0].provider, 'zhipu');
    now += 300_001;
    assert.equal(getCachedRequestBalanceByKeyHash('zhipu', hash), undefined);
});

test('compatible raw entries preserve separate query times and credential isolation', context => {
    const startedAt = Date.now();
    let now = startedAt;
    context.mock.method(Date, 'now', () => now);
    const hash = hashRequestApiKey('compatible-raw-key');
    for (const [id, queriedAt] of [
        ['provider::wallet', startedAt - 290_000],
        ['provider::tokens', startedAt]
    ] as const) {
        const entry = {
            id,
            balance: 12.345,
            currency: 'USD',
            items: [{ displayName: 'Tokens', balance: 200, currency: 'Tokens' }]
        };
        cacheRequestBalanceEntryByKeyHash('compatible-raw', hash, entry, queriedAt, {
            provider: 'compatible',
            data: {
                providerId: id,
                providerName: id,
                balanceInfo: entry,
                lastUpdated: new Date(queriedAt).toISOString()
            }
        });
    }
    assert.equal(getCachedRequestBalanceByKeyHash('compatible-raw', hash)?.statusSnapshots?.length, 2);
    assert.equal(getCachedRequestBalanceByKeyHash('compatible-raw', keyHash), undefined);
    now += 11_000;
    const value = getCachedRequestBalanceByKeyHash('compatible-raw', hash);
    assert.deepEqual(
        value?.entries.map(entry => entry.id),
        ['provider::tokens']
    );
    assert.equal(value?.statusSnapshots?.length, 1);
    assert.equal(value?.statusSnapshots?.[0].queriedAt, startedAt);
    const snapshot = value?.statusSnapshots?.[0];
    assert.ok(snapshot?.provider === 'compatible');
    assert.equal(snapshot.data.providerId, 'provider::tokens');
    assert.equal(snapshot.data.balanceInfo.items?.[0].displayName, 'Tokens');
});

for (const order of ['native-first', 'compatible-first', 'native-newer'] as const) {
    test(`native and custom snapshots remain independent with the same entry id: ${order}`, context => {
        const now = Date.now();
        context.mock.method(Date, 'now', () => now);
        const hash = hashRequestApiKey(`mixed-source-${order}`);
        const native = () =>
            cacheRequestBalanceByKeyHash(
                'moonshot',
                hash,
                [{ id: 'moonshot', balance: 20, currency: 'CNY' }],
                order === 'native-newer' ? now : now - 1000,
                moonshotStatus(20)
            );
        const custom = () =>
            cacheRequestBalanceEntryByKeyHash(
                'moonshot',
                hash,
                { id: 'moonshot', balance: 30, currency: 'Tokens' },
                now - 500,
                {
                    provider: 'compatible',
                    data: {
                        providerId: 'moonshot',
                        providerName: 'Custom query',
                        balanceInfo: { balance: 30, currency: 'Tokens' },
                        lastUpdated: new Date(now - 500).toISOString()
                    }
                }
            );
        if (order === 'native-first') {
            native();
            custom();
        } else {
            custom();
            native();
        }
        const saved = getCachedRequestBalanceByKeyHash('moonshot', hash);
        assert.ok(saved);
        assert.deepEqual(saved?.statusSnapshots?.map(status => status.provider).sort(), ['compatible', 'moonshot']);
        assert.deepEqual(saved.entries.map(entry => entry.balance).sort(), [20, 30]);
    });
}

const additionalStatuses: RequestStatusData[] = [
    {
        provider: 'commandcode',
        data: {
            monthlyCredits: 10,
            purchasedCredits: 2,
            freeCredits: 1,
            totalCredits: 13,
            fiveHour: { used: 10, cap: 100, exceeded: false }
        }
    },
    {
        provider: 'minimax-token',
        data: { limits: [{ label: '5h', limitType: '5h', remaining: 90, remainMs: 60000, resetTime: 123456 }] }
    },
    {
        provider: 'kimi',
        data: {
            summary: { period: 'weekly', limit: 100, used: 10, remaining: 90, resetTime: '2026-10-22T00:00:00Z' },
            windows: [{ duration: 5, timeUnit: 'TIME_UNIT_HOUR', detail: { limit: 100, used: 5, remaining: 95 } }],
            parallel: { limit: 10 },
            boosterWallet: {
                balance: { amountLeft: '100000000' },
                topupLimit: { currency: 'USD' },
                status: 'STATUS_ACTIVE',
                monthlyChargeLimitEnabled: true,
                monthlyChargeLimit: { currency: 'USD', priceInCents: '500' },
                monthlyUsed: { currency: 'USD', priceInCents: '100' }
            }
        }
    },
    {
        provider: 'opencode',
        data: {
            windows: [
                {
                    type: 'rolling',
                    usedPercent: 10,
                    remainingPercent: 90,
                    status: 'ok',
                    resetAt: '2026-10-22T00:00:00Z'
                }
            ],
            lastUpdated: 'saved time'
        }
    },
    {
        provider: 'codex',
        data: {
            planType: 'plus',
            codeReviewUsedPercent: 10,
            lastUpdated: 'saved time',
            rateLimit: {
                allowed: true,
                limit_reached: false,
                primary_window: {
                    used_percent: 10,
                    limit_window_seconds: 18000,
                    reset_at: 123456,
                    reset_after_seconds: 60
                }
            }
        }
    },
    {
        provider: 'grok',
        data: {
            usage: {
                type: 'monthly',
                usedPercent: 10,
                remainingPercent: 90,
                windowMinutes: 43200,
                subscriptionTier: 'SuperGrok',
                resetAt: '2026-10-22T00:00:00Z'
            },
            lastUpdated: 'saved time'
        }
    }
];

function corruptNumbers(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'number') {
            Reflect.set(value, key, NaN);
        } else {
            corruptNumbers(child);
        }
    }
}

for (const fixture of additionalStatuses) {
    test(`${fixture.provider} raw snapshots filter unknown fields, copy nested data and reject invalid updates`, context => {
        let now = Date.now();
        context.mock.method(Date, 'now', () => now);
        const status = structuredClone(fixture);
        const hash = hashRequestApiKey(`safe-${status.provider}`);
        Reflect.set(status.data, 'apiKey', 'must-not-persist');
        cacheRequestBalanceByKeyHash(status.provider, hash, [], now, status);
        const original = getCachedRequestBalanceByKeyHash(status.provider, hash);
        assert.ok(original?.statusSnapshots?.length);
        const snapshot = original.statusSnapshots[0];
        if (snapshot.provider === 'commandcode') {
            assert.equal(Reflect.has(snapshot.data.fiveHour!, 'exceeded'), false);
        } else if (snapshot.provider === 'kimi') {
            for (const detail of [snapshot.data.summary, ...snapshot.data.windows.map(window => window.detail)]) {
                assert.equal(Reflect.has(detail, 'limit'), false);
                assert.equal(Reflect.has(detail, 'used'), false);
            }
            assert.equal(snapshot.data.parallel?.limit, 10);
        } else if (snapshot.provider === 'opencode') {
            assert.equal(Reflect.has(snapshot.data.windows[0], 'status'), false);
            assert.equal(snapshot.data.windows[0].usedPercent, 10);
        } else if (snapshot.provider === 'codex') {
            assert.equal(Reflect.has(snapshot.data, 'codeReviewUsedPercent'), false);
            assert.equal(Reflect.has(snapshot.data.rateLimit, 'allowed'), false);
            assert.equal(Reflect.has(snapshot.data.rateLimit, 'limit_reached'), false);
            assert.equal(Reflect.has(snapshot.data.rateLimit.primary_window, 'reset_after_seconds'), false);
        } else if (snapshot.provider === 'grok') {
            assert.equal(Reflect.has(snapshot.data.usage, 'usedPercent'), false);
            assert.equal(Reflect.has(snapshot.data.usage, 'windowMinutes'), false);
        }
        assert.doesNotMatch(JSON.stringify(original), /must-not-persist/);
        corruptNumbers(status.data);
        assert.deepEqual(getCachedRequestBalanceByKeyHash(status.provider, hash), original);
        cacheRequestBalanceByKeyHash(status.provider, hash, [], now, status);
        assert.deepEqual(getCachedRequestBalanceByKeyHash(status.provider, hash), original);
        const returned = getCachedRequestBalanceByKeyHash(status.provider, hash)!;
        corruptNumbers(returned.statusSnapshots?.[0].data);
        assert.deepEqual(getCachedRequestBalanceByKeyHash(status.provider, hash), original);
        now += 300001;
        assert.equal(getCachedRequestBalanceByKeyHash(status.provider, hash), undefined);
    });
}

test('public compatible queries require explicit scope, expire independently and never expose private keys', context => {
    let now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const provider = 'public-cache-boundaries';
    const entry = { id: `${provider}::quota`, balance: 5, currency: 'Tokens' };
    const status: RequestStatusData = {
        provider: 'compatible',
        data: {
            providerId: entry.id,
            providerName: 'Quota',
            balanceInfo: entry,
            lastUpdated: new Date(now).toISOString()
        }
    };
    cacheProviderRequestBalanceEntry(provider, entry, now, status);
    assert.equal(getCachedRequestBalanceForRequest(provider), undefined);
    status.data.queryScope = 'provider';
    cacheProviderRequestBalanceEntry(provider, entry, now - 290000, status);
    assert.equal(getCachedRequestBalanceForRequest(provider)?.entries[0].balance, 5);
    const privateEntry = { ...entry, id: `${provider}::private`, balance: 7 };
    cacheRequestBalanceEntryByKeyHash(provider, keyHash, privateEntry, now);
    assert.deepEqual(
        getCachedRequestBalanceForRequest(provider)?.entries.map(value => value.balance),
        [5]
    );
    assert.deepEqual(
        getCachedRequestBalanceForRequest(provider, keyHash)?.entries.map(value => value.balance),
        [5, 7]
    );
    assert.equal(getCachedRequestBalanceForRequest(provider, 'invalid-hash'), undefined);
    now += 11000;
    assert.equal(getCachedRequestBalanceForRequest(provider), undefined);
    assert.deepEqual(
        getCachedRequestBalanceForRequest(provider, keyHash)?.entries.map(value => value.balance),
        [7]
    );
});

test('non-finite raw business values do not overwrite a valid snapshot', () => {
    const hash = hashRequestApiKey('invalid-raw-value');
    const entry = { id: 'moonshot', balance: 20, currency: 'CNY' };
    cacheRequestBalanceByKeyHash('moonshot', hash, [entry], Date.now(), moonshotStatus(20));
    const before = getCachedRequestBalanceByKeyHash('moonshot', hash);
    cacheRequestBalanceByKeyHash('moonshot', hash, [entry], Date.now(), moonshotStatus(NaN));
    assert.deepEqual(getCachedRequestBalanceByKeyHash('moonshot', hash), before);
});

for (const mode of ['full', 'entry'] as const) {
    for (const timing of ['older', 'expired', 'future', 'invalid'] as const) {
        test(`${mode} balance write rejects ${timing} data without replacing a fresh snapshot`, context => {
            const now = Date.now();
            context.mock.method(Date, 'now', () => now);
            const provider = `ordering-${mode}-${timing}`;
            const original = { id: 'wallet', balance: 20, currency: 'USD' };
            cacheRequestBalanceByKeyHash(provider, keyHash, [original], now - 1_000);
            const queriedAt =
                timing === 'older' ? now - 2_000
                : timing === 'expired' ? now - 360_000
                : timing === 'future' ? now + 1
                : NaN;
            const stale = { ...original, balance: 100 };
            if (mode === 'full') {
                cacheRequestBalanceByKeyHash(provider, keyHash, [stale], queriedAt);
            } else {
                cacheRequestBalanceEntryByKeyHash(provider, keyHash, stale, queriedAt);
            }
            assert.deepEqual(getCachedRequestBalanceByKeyHash(provider, keyHash), {
                queriedAt: now - 1_000,
                entries: [original]
            });
        });
    }
}

test('full balance update keeps newer entry groups while advancing older groups', context => {
    const now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const provider = 'ordering-mixed-groups';
    cacheRequestBalanceByKeyHash(provider, keyHash, [{ id: 'wallet', balance: 1, currency: 'USD' }], now - 3_000);
    cacheRequestBalanceEntryByKeyHash(
        provider,
        keyHash,
        { id: 'credits', balance: 3, currency: 'Points' },
        now - 1_000
    );
    cacheRequestBalanceByKeyHash(
        provider,
        keyHash,
        [
            { id: 'wallet', balance: 2, currency: 'USD' },
            { id: 'credits', balance: 9, currency: 'Points' }
        ],
        now - 2_000
    );
    const snapshot = getCachedRequestBalanceByKeyHash(provider, keyHash);
    assert.equal(snapshot?.queriedAt, now - 1_000);
    assert.deepEqual(snapshot?.entries, [
        { id: 'wallet', balance: 2, currency: 'USD' },
        { id: 'credits', balance: 3, currency: 'Points' }
    ]);
});

test('older full snapshots preserve every currency in a newer entry group', context => {
    const now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const provider = 'ordering-currencies';
    const entries = [
        { id: 'wallet', balance: 20, currency: 'USD' },
        { id: 'wallet', balance: 30, currency: 'CNY' }
    ];
    cacheRequestBalanceByKeyHash(provider, keyHash, entries, now - 1_000);
    cacheRequestBalanceByKeyHash(provider, keyHash, [{ id: 'wallet', balance: 100, currency: 'USD' }], now - 2_000);
    assert.deepEqual(getCachedRequestBalanceByKeyHash(provider, keyHash)?.entries, entries);
});

test('newer full snapshots remove omitted old entries', context => {
    const now = Date.now();
    context.mock.method(Date, 'now', () => now);
    const provider = 'ordering-replacement';
    cacheRequestBalanceByKeyHash(
        provider,
        keyHash,
        [
            { id: 'wallet', balance: 20, currency: 'USD' },
            { id: 'removed', balance: 30, currency: 'USD' }
        ],
        now - 1_000
    );
    const entries = [{ id: 'wallet', balance: 10, currency: 'USD' }];
    cacheRequestBalanceByKeyHash(provider, keyHash, entries, now);
    assert.deepEqual(getCachedRequestBalanceByKeyHash(provider, keyHash)?.entries, entries);
});

test('same-millisecond updates retain arrival order without extending expiry', context => {
    const now = Date.now();
    let clock = now;
    context.mock.method(Date, 'now', () => clock);
    const provider = 'ordering-same-time';
    cacheRequestBalanceByKeyHash(provider, keyHash, [{ id: 'wallet', balance: 0, currency: 'USD' }], now);
    cacheRequestBalanceEntryByKeyHash(provider, keyHash, { id: 'wallet', balance: 7, currency: 'USD' }, now);
    assert.equal(getCachedRequestBalanceByKeyHash(provider, keyHash)?.entries[0].balance, 7);
    clock += 300_001;
    assert.equal(getCachedRequestBalanceByKeyHash(provider, keyHash), undefined);
});
