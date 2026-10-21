import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { DeepSeekBalanceInfo } from './providers/deepseek';
import type { ClinePassLimit } from './providers/clinepass';
import type { QuotaStatusAdapter } from './statusAdapters/types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require(id: string): unknown } };

test('request providers share one completion notification without directly querying balances', async () => {
    for (const provider of ['generic', 'compatible', 'moonshot', 'minimax', 'zhipu']) {
        const source = await readFile(
            new URL(`../providers/${provider === 'generic' ? 'genericModel' : provider}Provider.ts`, import.meta.url),
            'utf8'
        );
        assert.doesNotMatch(source, /\.delayedUpdate\s*\(/);
        if (provider === 'generic') {
            assert.match(source, /notifyRequestCompleted\(effectiveProviderKey\)/);
            assert.match(source, /from '\.\.\/status\/requestCompletion'/);
            assert.doesNotMatch(source, /from '\.\.\/status(?:\/statusBarManager)?'/);
            assert.equal(source.match(/\bnotifyRequestCompleted\s*\(/g)?.length, 1);
        }
    }
});

test('request balance reads only taskbar snapshots for the dispatched credential', async context => {
    const originalRequire = NodeModule.prototype.require;
    const calls: Array<{ id: string; apiKey: string; kind?: string }> = [];
    let deepseek: DeepSeekBalanceInfo[] = [];
    let clinepass: ClinePassLimit[] = [];
    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/providers/deepseek')) {
            return {
                fetchDeepSeekBalances: async (apiKey: string) => {
                    calls.push({ id: 'deepseek', apiKey });
                    return deepseek;
                }
            };
        }
        if (id.endsWith('/providers/moonshot')) {
            return {
                fetchMoonshotBalance: async (apiKey: string) => {
                    calls.push({ id: 'moonshot', apiKey });
                    return { available_balance: 0, cash_balance: -2, voucher_balance: 2 };
                }
            };
        }
        if (id.endsWith('/providers/clinepass')) {
            return {
                fetchClinePassLimits: async (apiKey: string) => {
                    calls.push({ id: 'clinepass', apiKey });
                    return clinepass;
                }
            };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string) => english };
        }
        return originalRequire.call(this, id);
    };
    try {
        const { cacheRequestBalance, cacheRequestBalanceEntry, getCachedRequestBalance } =
            await import('./requestBalance');
        const { deepseekStatusAdapter } = await import('./statusAdapters/deepseek');
        const { moonshotStatusAdapter } = await import('./statusAdapters/moonshot');
        const { clinepassStatusAdapter } = await import('./statusAdapters/clinepass');
        const queryAndCache = async <Data>(provider: string, key: string, adapter: QuotaStatusAdapter<Data>) => {
            const data = await adapter.query(key);
            assert.equal(getCachedRequestBalance(provider, key), undefined);
            cacheRequestBalance(
                provider,
                key,
                adapter.requestBalance?.(data) ?? [],
                Date.now(),
                adapter.requestStatus?.(data)
            );
            return data;
        };
        await context.test('snapshot only returns fresh data for the dispatched credential', () => {
            const provider = 'snapshot-probe';
            assert.equal(getCachedRequestBalance(provider, 'first-key'), undefined);
            cacheRequestBalance(provider, 'first-key', [{ id: 'wallet', balance: 12, currency: 'USD' }]);
            assert.deepEqual(getCachedRequestBalance(provider, 'first-key')?.entries, [
                { id: 'wallet', balance: 12, currency: 'USD' }
            ]);
            assert.equal(getCachedRequestBalance(provider, 'second-key'), undefined);
            cacheRequestBalance(provider, 'second-key', [{ id: 'wallet', balance: 3, currency: 'CNY' }]);
            assert.equal(getCachedRequestBalance(provider, 'first-key')?.entries[0].balance, 12);
            assert.equal(getCachedRequestBalance(provider, 'second-key')?.entries[0].balance, 3);
            cacheRequestBalance(
                provider,
                'stale-key',
                [{ id: 'wallet', balance: 4, currency: 'USD' }],
                Date.now() - 360_000
            );
            assert.equal(getCachedRequestBalance(provider, 'stale-key'), undefined);
            assert.equal(getCachedRequestBalance(provider, ''), undefined);
            const returned = getCachedRequestBalance(provider, 'first-key');
            assert.ok(returned);
            returned.entries[0].balance = -99;
            assert.equal(getCachedRequestBalance(provider, 'first-key')?.entries[0].balance, 12);
        });
        await context.test(
            'DeepSeek status query caches every currency without requesting again on completion',
            async () => {
                deepseek = [
                    { currency: 'CNY', total_balance: '12.5', topped_up_balance: '10', granted_balance: '2.5' },
                    { currency: 'USD', total_balance: '0', topped_up_balance: '-1', granted_balance: '1' }
                ];
                const before = Date.now();
                await queryAndCache('deepseek', 'dispatched-key', deepseekStatusAdapter);
                const value = getCachedRequestBalance('deepseek', 'dispatched-key');
                assert.deepEqual(value?.entries, [
                    { id: 'deepseek', balance: 12.5, currency: 'CNY', paid: 10, granted: 2.5 },
                    { id: 'deepseek', balance: 0, currency: 'USD', paid: -1, granted: 1 }
                ]);
                assert.ok(value && value.queriedAt >= before && value.queriedAt <= Date.now());
                assert.deepEqual(calls.at(-1), { id: 'deepseek', apiKey: 'dispatched-key' });
                const count = calls.length;
                assert.equal(getCachedRequestBalance('deepseek', 'other-key'), undefined);
                assert.equal(getCachedRequestBalance('deepseek', 'dispatched-key')?.entries.length, 2);
                assert.equal(calls.length, count);
            }
        );
        await context.test('Moonshot status query caches zero and negative balances without rounding', async () => {
            const data = await queryAndCache('moonshot', 'moonshot-request-key', moonshotStatusAdapter);
            const value = getCachedRequestBalance('moonshot', 'moonshot-request-key');
            assert.deepEqual(value?.entries, [{ id: 'moonshot', balance: 0, currency: 'CNY', paid: -2, granted: 2 }]);
            assert.equal(calls.at(-1)?.apiKey, 'moonshot-request-key');
            const snapshot = value?.statusSnapshots?.[0];
            assert.equal(snapshot?.provider, 'moonshot');
            assert.deepEqual(snapshot?.data, { balanceInfo: data.balanceInfo });
            assert.deepEqual(Object.keys(snapshot ?? {}).sort(), ['data', 'provider', 'queriedAt', 'version']);
        });
        await context.test(
            'raw status data survives JSON and reproduces summary and tooltip tables offline',
            async () => {
                deepseek = [
                    {
                        currency: 'USD',
                        total_balance: '0.00000000',
                        topped_up_balance: '-1.0000',
                        granted_balance: '1.0000'
                    },
                    {
                        currency: 'CNY',
                        total_balance: '12.50000000',
                        topped_up_balance: '10.0000',
                        granted_balance: '2.50000000'
                    }
                ];
                const data = await queryAndCache('deepseek', 'raw-status-key', deepseekStatusAdapter);
                const expected = structuredClone(data);
                const expectedBalance = { primaryBalance: expected.primaryBalance, allBalances: expected.allBalances };
                const queryCount = calls.length;
                const value = getCachedRequestBalance('deepseek', 'raw-status-key');
                const restored = JSON.parse(JSON.stringify(value)) as typeof value;
                const snapshot = restored?.statusSnapshots?.find(item => item.provider === 'deepseek');
                assert.ok(snapshot?.provider === 'deepseek');
                assert.deepEqual(snapshot.data, expectedBalance);
                assert.equal(snapshot.version, 1);
                assert.equal(snapshot.queriedAt, restored?.queriedAt);
                assert.equal(Reflect.has(snapshot, 'context'), false);
                const replay = { ...snapshot.data, lastUpdated: expected.lastUpdated };
                assert.equal(deepseekStatusAdapter.summary(replay), deepseekStatusAdapter.summary(expected));
                assert.deepEqual(deepseekStatusAdapter.tables(replay), deepseekStatusAdapter.tables(expected));
                data.allBalances[1].total_balance = '999';
                snapshot.data.allBalances[1].total_balance = '888';
                const cached = getCachedRequestBalance('deepseek', 'raw-status-key')?.statusSnapshots?.find(
                    item => item.provider === 'deepseek'
                );
                assert.ok(cached?.provider === 'deepseek');
                assert.deepEqual(cached.data, expectedBalance);
                assert.equal(getCachedRequestBalance('deepseek', 'another-raw-key'), undefined);
                assert.equal(calls.length, queryCount);
            }
        );
        await context.test('ClinePass taskbar results produce quota-only snapshots without another query', async () => {
            clinepass = [
                { type: 'five_hour', percentUsed: 10, resetsAt: '2026-10-21T12:00:00Z' },
                { type: 'weekly', percentUsed: 25 },
                { type: 'monthly', percentUsed: 40 }
            ];
            Reflect.set(clinepass[0], 'apiKey', 'must-not-be-saved');
            const before = Date.now();
            const data = await queryAndCache('clinepass', 'clinepass-request-key', clinepassStatusAdapter);
            const queryCount = calls.length;
            const saved = getCachedRequestBalance('clinepass', 'clinepass-request-key');
            assert.ok(saved);
            assert.deepEqual(saved.entries, []);
            assert.ok(saved.queriedAt >= before && saved.queriedAt <= Date.now());
            const restored = JSON.parse(JSON.stringify(saved)) as typeof saved;
            const snapshot = restored.statusSnapshots?.[0];
            assert.ok(snapshot?.provider === 'clinepass');
            assert.equal(Reflect.has(snapshot, 'context'), false);
            assert.equal(Reflect.has(snapshot.data, 'lastUpdated'), false);
            assert.deepEqual(
                snapshot.data.limits.map(limit => limit.percentUsed),
                [10, 25, 40]
            );
            assert.equal(JSON.stringify(saved).includes('must-not-be-saved'), false);
            data.limits[0].percentUsed = 99;
            snapshot.data.limits[1].percentUsed = 88;
            const cached = getCachedRequestBalance('clinepass', 'clinepass-request-key')?.statusSnapshots?.[0];
            assert.ok(cached?.provider === 'clinepass');
            assert.deepEqual(
                cached.data.limits.map(limit => limit.percentUsed),
                [10, 25, 40]
            );
            assert.equal(getCachedRequestBalance('clinepass', 'another-key'), undefined);
            assert.equal(calls.length, queryCount);
        });
        await context.test('ClinePass rejects invalid quota fields instead of persisting them', async () => {
            for (const invalid of ['type', 'percentUsed', 'resetsAt'] as const) {
                clinepass = [{ type: 'weekly', percentUsed: 10 }];
                Reflect.set(
                    clinepass[0],
                    invalid,
                    invalid === 'type' ? 'unknown'
                    : invalid === 'percentUsed' ? NaN
                    : {}
                );
                await queryAndCache('clinepass', `invalid-clinepass-${invalid}`, clinepassStatusAdapter);
                assert.equal(getCachedRequestBalance('clinepass', `invalid-clinepass-${invalid}`), undefined);
            }
        });
        await context.test('custom entries merge by id and discard unexpected response properties', () => {
            cacheRequestBalanceEntry('custom', 'key', {
                id: 'custom::wallet',
                balance: 1.23456789,
                currency: 'USD',
                items: [{ displayName: 'Tokens', balance: 120, currency: 'Tokens' }],
                ...{ apiKey: 'must-not-be-persisted', headers: { Authorization: 'secret' } }
            });
            cacheRequestBalanceEntry('custom', 'key', { id: 'custom::tokens', balance: 0, currency: 'Tokens' });
            cacheRequestBalanceEntry('custom', 'key', { id: 'custom::tokens', balance: 7, currency: 'Tokens' });
            const value = getCachedRequestBalance('custom', 'key');
            assert.deepEqual(
                value?.entries.map(entry => entry.id),
                ['custom::wallet', 'custom::tokens']
            );
            assert.equal(value?.entries[0].balance, 1.23456789);
            assert.equal(value?.entries[1].balance, 7);
            assert.equal(JSON.stringify(value).includes('must-not-be-persisted'), false);
            assert.equal(JSON.stringify(value).includes('secret'), false);
            assert.equal(getCachedRequestBalance('custom', 'other-key'), undefined);
        });
        await context.test('refreshing one custom entry does not extend another entry lifetime', subcontext => {
            const now = Date.now();
            cacheRequestBalance('partial', 'key', [{ id: 'old', balance: 1, currency: 'USD' }], now - 290_000);
            cacheRequestBalanceEntry('partial', 'key', { id: 'fresh', balance: 2, currency: 'USD' });
            subcontext.mock.method(Date, 'now', () => now + 11_000);
            assert.deepEqual(
                getCachedRequestBalance('partial', 'key')?.entries.map(entry => entry.id),
                ['fresh']
            );
        });
        await context.test('unsupported and missing credentials never fetch', () => {
            const before = calls.length;
            assert.equal(getCachedRequestBalance('unsupported', 'key'), undefined);
            assert.equal(getCachedRequestBalance('deepseek', ''), undefined);
            assert.equal(getCachedRequestBalance('moonshot', ''), undefined);
            assert.equal(calls.length, before);
        });
        await context.test('invalid amounts and currencies do not enter snapshots', () => {
            for (const invalid of [
                { balance: NaN, currency: 'USD' },
                { balance: Infinity, currency: 'USD' },
                { balance: 1, currency: '' },
                { balance: 1, currency: 'USD', granted: Infinity }
            ]) {
                cacheRequestBalance('invalid', 'key', [{ id: 'wallet', ...invalid }]);
                assert.equal(getCachedRequestBalance('invalid', 'key'), undefined);
            }
        });
        await context.test('empty DeepSeek amounts do not become cached zero balances', async () => {
            deepseek = [{ currency: 'USD', total_balance: '', topped_up_balance: '0', granted_balance: '0' }];
            await queryAndCache('deepseek', 'invalid-deepseek-key', deepseekStatusAdapter);
            assert.equal(getCachedRequestBalance('deepseek', 'invalid-deepseek-key'), undefined);
        });
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});
