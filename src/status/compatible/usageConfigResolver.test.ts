import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    CUSTOM_USAGE_ENTRY_SEPARATOR,
    mergeProviderUsageOverride,
    parseCustomUsageTarget,
    resolveCustomUsageEntries,
    resolveUsageConfig
} from './usageConfigResolver';

describe('resolveUsageConfig', () => {
    it('returns single usage config as-is when no base usage exists', () => {
        const resolved = resolveUsageConfig(undefined, {
            url: 'https://api.example.com/balance',
            authType: 'bearer',
            fields: { balance: 'data.balance' },
            unit: 'USD'
        });

        assert.deepStrictEqual(resolved, {
            url: 'https://api.example.com/balance',
            authType: 'bearer',
            fields: { balance: 'data.balance' },
            unit: 'USD',
            displayName: undefined,
            method: undefined,
            headers: undefined,
            params: undefined,
            body: undefined,
            successConditions: undefined,
            errorMessagePath: undefined
        });
    });

    it('merges usage defaults into usages override', () => {
        const resolved = resolveUsageConfig(
            {
                url: 'https://api.example.com/balance/default',
                authType: 'url_key',
                headers: { 'X-App': 'gcmp' },
                params: { region: 'global' },
                fields: { balance: 'data.balance', paid: 'data.paid' },
                unit: 'USD'
            },
            {
                displayName: 'Pro',
                url: 'https://api.example.com/balance/pro',
                headers: { 'X-Plan': 'pro' },
                fields: { granted: 'data.granted' }
            }
        );

        assert.deepStrictEqual(resolved, {
            displayName: 'Pro',
            url: 'https://api.example.com/balance/pro',
            method: undefined,
            authType: 'url_key',
            headers: { 'X-App': 'gcmp', 'X-Plan': 'pro' },
            params: { region: 'global' },
            body: undefined,
            successConditions: undefined,
            errorMessagePath: undefined,
            fields: {
                balance: 'data.balance',
                paid: 'data.paid',
                granted: 'data.granted'
            },
            unit: 'USD'
        });
    });

    it('returns undefined when merged config still lacks required fields', () => {
        const resolved = resolveUsageConfig(undefined, {
            headers: { 'X-Test': '1' }
        });

        assert.strictEqual(resolved, undefined);
    });

    it('preserves computed balance field options', () => {
        const resolved = resolveUsageConfig(undefined, {
            url: 'https://api.example.com/credits',
            fields: {
                balance: {
                    operation: 'subtract',
                    paths: ['data.total_credits', 'data.total_usage'],
                    treatMissingAsZero: true
                }
            },
            unit: 'USD'
        });

        assert.deepStrictEqual(resolved, {
            url: 'https://api.example.com/credits',
            fields: {
                balance: {
                    operation: 'subtract',
                    paths: ['data.total_credits', 'data.total_usage'],
                    treatMissingAsZero: true
                }
            },
            unit: 'USD',
            displayName: undefined,
            method: undefined,
            authType: undefined,
            headers: undefined,
            params: undefined,
            body: undefined,
            successConditions: undefined,
            errorMessagePath: undefined
        });
    });
});

describe('resolveCustomUsageEntries', () => {
    it('uses usage as default entry when only usage exists', () => {
        const entries = resolveCustomUsageEntries('NekoCode', {
            usage: {
                url: 'https://api.example.com/balance',
                fields: { balance: 'data.balance' },
                unit: 'CNY'
            }
        });

        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].id, `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}default`);
        assert.strictEqual(entries[0].usageConfig.url, 'https://api.example.com/balance');
    });

    it('supports a single usages item without usage defaults', () => {
        const entries = resolveCustomUsageEntries('NekoCode', {
            usages: {
                pro: {
                    url: 'https://api.example.com/balance/pro',
                    fields: { balance: 'data.balance' }
                }
            }
        });

        assert.deepStrictEqual(
            entries.map(entry => ({
                id: entry.id,
                url: entry.usageConfig.url,
                balance: entry.usageConfig.fields.balance
            })),
            [
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}pro`,
                    url: 'https://api.example.com/balance/pro',
                    balance: 'data.balance'
                }
            ]
        );
    });

    it('intelligently merges usage defaults into usages entries when both exist', () => {
        const entries = resolveCustomUsageEntries('NekoCode', {
            usage: {
                url: 'https://api.example.com/balance/default',
                authType: 'url_key',
                fields: { balance: 'data.balance' },
                unit: 'CNY'
            },
            usages: {
                pro: {
                    displayName: 'Pro',
                    url: 'https://api.example.com/balance/pro'
                },
                plus: {
                    displayName: 'Plus',
                    fields: { balance: 'payload.remaining' }
                }
            }
        });

        assert.deepStrictEqual(
            entries.map(entry => ({
                id: entry.id,
                url: entry.usageConfig.url,
                balance: entry.usageConfig.fields.balance
            })),
            [
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}default`,
                    url: 'https://api.example.com/balance/default',
                    balance: 'data.balance'
                },
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}pro`,
                    url: 'https://api.example.com/balance/pro',
                    balance: 'data.balance'
                },
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}plus`,
                    url: 'https://api.example.com/balance/default',
                    balance: 'payload.remaining'
                }
            ]
        );
    });

    it('omits default usage entry when a usages item resolves to the same config', () => {
        const entries = resolveCustomUsageEntries('NekoCode', {
            usage: {
                url: 'https://api2.nekoapi.ai/v1/usage',
                fields: { balance: 'balance' }
            },
            usages: {
                pay: {
                    displayName: '余额',
                    url: 'https://api2.nekoapi.ai/v1/usage'
                },
                sub: {
                    displayName: '订阅',
                    url: 'https://api2.nekoapi.ai/v1/user/balance',
                    fields: { balance: 'balance' }
                }
            }
        });

        assert.deepStrictEqual(
            entries.map(entry => ({
                id: entry.id,
                displayName: entry.usageConfig.displayName,
                url: entry.usageConfig.url,
                balance: entry.usageConfig.fields.balance
            })),
            [
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}pay`,
                    displayName: '余额',
                    url: 'https://api2.nekoapi.ai/v1/usage',
                    balance: 'balance'
                },
                {
                    id: `NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}sub`,
                    displayName: '订阅',
                    url: 'https://api2.nekoapi.ai/v1/user/balance',
                    balance: 'balance'
                }
            ]
        );
    });
});

describe('parseCustomUsageTarget', () => {
    it('parses usage entry ids and base provider ids', () => {
        assert.deepStrictEqual(parseCustomUsageTarget(`NekoCode${CUSTOM_USAGE_ENTRY_SEPARATOR}pro`), {
            baseProviderId: 'NekoCode',
            usageKey: 'pro'
        });
        assert.deepStrictEqual(parseCustomUsageTarget('NekoCode'), { baseProviderId: 'NekoCode' });
    });
});

describe('mergeProviderUsageOverride', () => {
    it('merges built-in usage defaults with provider overrides', () => {
        const merged = mergeProviderUsageOverride(
            {
                usage: {
                    url: 'https://api.example.com/default',
                    successConditions: [{ path: 'code', equals: 0 }],
                    errorMessagePath: 'msg',
                    fields: { balance: 'data.balance', paid: 'data.paid' },
                    unit: 'USD'
                },
                usages: {
                    pro: {
                        url: 'https://api.example.com/pro',
                        fields: { granted: 'data.granted' }
                    }
                }
            },
            {
                usages: {
                    pro: {
                        displayName: 'Pro',
                        fields: { balance: 'data.remaining' }
                    }
                }
            }
        );

        assert.deepStrictEqual(merged, {
            baseUrl: undefined,
            customHeader: undefined,
            proxy: undefined,
            models: undefined,
            usage: {
                url: 'https://api.example.com/default',
                method: undefined,
                authType: undefined,
                headers: undefined,
                params: undefined,
                body: undefined,
                successConditions: [{ path: 'code', equals: 0 }],
                errorMessagePath: 'msg',
                fields: { balance: 'data.balance', paid: 'data.paid' },
                unit: 'USD',
                displayName: undefined
            },
            usages: {
                pro: {
                    url: 'https://api.example.com/pro',
                    displayName: 'Pro',
                    fields: {
                        granted: 'data.granted',
                        balance: 'data.remaining'
                    },
                    headers: undefined,
                    params: undefined,
                    body: undefined
                }
            }
        });
    });
});
