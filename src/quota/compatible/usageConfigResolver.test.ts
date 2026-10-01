import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import type { JSONSchema7 } from 'json-schema';
import type { ProviderUsageOverrideConfig } from '../../types/sharedTypes';
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

    it('supports multiple fields array in usage config', () => {
        const resolved = resolveUsageConfig(undefined, {
            url: 'https://api.example.com/balance',
            fields: [
                {
                    displayName: 'Tokens',
                    balance: 'data.token_balance',
                    unit: 'Tokens'
                },
                {
                    displayName: 'data.vip_name',
                    balance: 'data.vip_balance',
                    paid: 'data.vip_paid'
                }
            ]
        });

        assert.deepStrictEqual(resolved?.fields, [
            {
                displayName: 'Tokens',
                balance: 'data.token_balance',
                unit: 'Tokens'
            },
            {
                displayName: 'data.vip_name',
                balance: 'data.vip_balance',
                paid: 'data.vip_paid'
            }
        ]);
    });

    it('rejects fields array if any item lacks balance', () => {
        const resolved = resolveUsageConfig(undefined, {
            url: 'https://api.example.com/balance',
            fields: [
                { displayName: 'Item 1', balance: 'data.b1' },
                { displayName: 'Item 2' } as unknown as { balance: string }
            ]
        });

        assert.strictEqual(resolved, undefined);
    });

    it('inherits a complete fields array and replaces it as a whole when overridden', () => {
        const base = {
            url: 'https://example.test/usage',
            fields: [{ balance: 'first' }, { balance: 'second' }]
        };
        assert.deepStrictEqual(resolveUsageConfig(base, { unit: 'Tokens' })?.fields, base.fields);
        assert.deepStrictEqual(resolveUsageConfig(base, { fields: [{ balance: 'replacement' }] })?.fields, [
            { balance: 'replacement' }
        ]);
    });

    it('merges partial shared fields and request options into a complete query', () => {
        const shared: ProviderUsageOverrideConfig = {
            authType: 'none',
            method: 'POST',
            headers: { 'X-Shared': 'shared' },
            params: { region: 'global' },
            body: { account: 'shared' },
            fields: { paid: 'paid', unit: 'CNY' }
        };
        const resolved = resolveUsageConfig(shared, {
            url: 'https://example.test/wallet',
            headers: { 'X-Mode': 'wallet' },
            params: { plan: 'wallet' },
            body: { mode: 'wallet' },
            fields: { balance: 'balance' }
        });

        assert.equal(resolved?.url, 'https://example.test/wallet');
        assert.equal(resolved?.authType, 'none');
        assert.equal(resolved?.method, 'POST');
        assert.deepStrictEqual(resolved?.headers, { 'X-Shared': 'shared', 'X-Mode': 'wallet' });
        assert.deepStrictEqual(resolved?.params, { region: 'global', plan: 'wallet' });
        assert.deepStrictEqual(resolved?.body, { account: 'shared', mode: 'wallet' });
        assert.deepStrictEqual(resolved?.fields, { paid: 'paid', unit: 'CNY', balance: 'balance' });
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
                balance: !Array.isArray(entry.usageConfig.fields) ? entry.usageConfig.fields.balance : undefined
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
                balance: !Array.isArray(entry.usageConfig.fields) ? entry.usageConfig.fields.balance : undefined
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
                balance: !Array.isArray(entry.usageConfig.fields) ? entry.usageConfig.fields.balance : undefined
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

describe('explicit default usage', () => {
    it('prefers an explicit default and keeps other named modes without duplicate IDs', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: { url: 'https://example.test/shared', fields: { balance: 'balance' } },
            usages: {
                default: { displayName: '钱包', url: 'https://example.test/wallet' },
                other: { url: 'https://example.test/other' }
            }
        });

        assert.deepStrictEqual(
            entries.map(entry => [entry.id, entry.usageConfig.url]),
            [
                ['review::default', 'https://example.test/wallet'],
                ['review::other', 'https://example.test/other']
            ]
        );
        assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
        assert.equal(entries[0].usageConfig.displayName, '钱包');
    });

    it('keeps the implicit default when an explicit default cannot resolve', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: {
                url: 'https://example.test/shared',
                fields: [{ balance: 'first' }, { balance: 'second' }]
            },
            usages: { default: { fields: { displayName: 'incomplete replacement' } } }
        });

        assert.deepStrictEqual(
            entries.map(entry => [entry.id, entry.usageConfig.url]),
            [['review::default', 'https://example.test/shared']]
        );
    });

    it('resolves an explicit default with partial shared request options', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: { authType: 'none', unit: 'CNY' },
            usages: { default: { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
        });

        assert.equal(entries.length, 1);
        assert.equal(entries[0].id, 'review::default');
        assert.equal(entries[0].usageConfig.authType, 'none');
        assert.equal(entries[0].usageConfig.unit, 'CNY');
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

    for (const [provider, key] of [
        ['review::team', 'wallet'],
        ['review', 'team::wallet'],
        ['review%3A%3Ateam', 'wallet%25'],
        ['review::team::local', 'wallet::daily'],
        ['评审提供商', '钱包'],
        ['review%broken', 'wallet%broken']
    ]) {
        it(`round-trips the provider ${provider} and usage key ${key}`, () => {
            const [entry] = resolveCustomUsageEntries(provider, {
                usages: { [key]: { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
            });
            assert.equal(entry.baseProviderId, provider);
            assert.equal(entry.usageKey, key);
            assert.deepStrictEqual(parseCustomUsageTarget(entry.id), { baseProviderId: provider, usageKey: key });
        });
    }

    it('avoids collisions between provider and usage key separators', () => {
        const first = resolveCustomUsageEntries('review::team', {
            usages: { wallet: { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
        });
        const second = resolveCustomUsageEntries('review', {
            usages: { 'team::wallet': { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
        });
        assert.notEqual(first[0].id, second[0].id);
    });
});

describe('shared usage defaults', () => {
    const cases: {
        name: string;
        usage: ProviderUsageOverrideConfig;
        wallet: ProviderUsageOverrideConfig;
    }[] = [
        {
            name: 'request defaults without url or fields',
            usage: { authType: 'none', unit: 'CNY' },
            wallet: { url: 'https://example.test/wallet', fields: { balance: 'balance' } }
        },
        {
            name: 'shared url without fields',
            usage: { url: 'https://example.test/wallet', authType: 'none', unit: 'CNY' },
            wallet: { fields: { balance: 'balance' } }
        },
        {
            name: 'shared fields without url',
            usage: { fields: { balance: 'balance' }, authType: 'none', unit: 'CNY' },
            wallet: { url: 'https://example.test/wallet' }
        },
        {
            name: 'partial shared fields completed by a named mode',
            usage: { fields: { paid: 'paid' }, authType: 'none', unit: 'CNY' },
            wallet: { url: 'https://example.test/wallet', fields: { balance: 'balance' } }
        }
    ];

    for (const { name, usage, wallet } of cases) {
        it(`preserves ${name} through provider merging`, () => {
            const merged = mergeProviderUsageOverride(undefined, { usage, usages: { wallet } });
            const entries = resolveCustomUsageEntries('review', merged);

            assert.deepStrictEqual(
                entries.map(entry => entry.usageKey),
                ['wallet']
            );
            assert.equal(entries[0].usageConfig.url, 'https://example.test/wallet');
            assert.equal(entries[0].usageConfig.authType, 'none');
            assert.equal(entries[0].usageConfig.unit, 'CNY');
            assert.deepStrictEqual(entries[0].usageConfig.fields, { ...usage.fields, balance: 'balance' });
        });
    }

    it('preserves partial built-in defaults when only usages are overridden', () => {
        const merged = mergeProviderUsageOverride(
            {
                usage: { authType: 'none', headers: { 'X-Shared': 'builtin' }, unit: 'CNY' }
            },
            {
                usages: { wallet: { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
            }
        );
        const entries = resolveCustomUsageEntries('review', merged);

        assert.deepStrictEqual(
            entries.map(entry => entry.usageKey),
            ['wallet']
        );
        assert.equal(entries[0].usageConfig.authType, 'none');
        assert.equal(entries[0].usageConfig.unit, 'CNY');
        assert.deepStrictEqual(entries[0].usageConfig.headers, { 'X-Shared': 'builtin' });
    });

    it('merges built-in and user shared defaults before applying named overrides', () => {
        const merged = mergeProviderUsageOverride(
            {
                usage: {
                    authType: 'none',
                    method: 'POST',
                    headers: { 'X-Shared': 'builtin' },
                    params: { region: 'global' },
                    body: { account: 'builtin' },
                    successConditions: [{ path: 'code', equals: 0 }],
                    errorMessagePath: 'message',
                    fields: { paid: 'paid' },
                    unit: 'CNY'
                },
                usages: { wallet: { url: 'https://example.test/wallet', fields: { balance: 'balance' } } }
            },
            {
                usage: { headers: { 'X-Shared': 'user' }, params: { region: 'local' }, body: { account: 'user' } },
                usages: {
                    wallet: { displayName: '钱包', headers: { 'X-Mode': 'wallet' }, fields: { granted: 'granted' } }
                }
            }
        );
        const entries = resolveCustomUsageEntries('review', merged);

        assert.deepStrictEqual(
            entries.map(entry => entry.usageKey),
            ['wallet']
        );
        assert.deepStrictEqual(entries[0].usageConfig, {
            displayName: '钱包',
            url: 'https://example.test/wallet',
            method: 'POST',
            authType: 'none',
            headers: { 'X-Shared': 'user', 'X-Mode': 'wallet' },
            params: { region: 'local' },
            body: { account: 'user' },
            successConditions: [{ path: 'code', equals: 0 }],
            errorMessagePath: 'message',
            fields: { paid: 'paid', balance: 'balance', granted: 'granted' },
            unit: 'CNY'
        });
    });

    it('does not resolve incomplete defaults with absent or empty usages', () => {
        for (const usages of [undefined, {}]) {
            const merged = mergeProviderUsageOverride(undefined, { usage: { authType: 'none' }, usages });
            assert.deepStrictEqual(resolveCustomUsageEntries('review', merged), []);
        }
    });

    it('keeps a complete default query when usages is empty', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: { url: 'https://example.test/wallet', fields: { balance: 'balance' } },
            usages: {}
        });
        assert.deepStrictEqual(
            entries.map(entry => entry.usageKey),
            ['default']
        );
    });
});

describe('usage query equivalence', () => {
    it('ignores key order inside nested request bodies', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: {
                url: 'https://example.test/wallet',
                body: { filter: { region: 'global', plan: 'wallet' } },
                fields: { balance: 'balance' }
            },
            usages: { wallet: { body: { filter: { plan: 'wallet', region: 'global' } } } }
        });
        assert.deepStrictEqual(
            entries.map(entry => entry.usageKey),
            ['wallet']
        );
    });

    it('ignores key order in replacement field arrays and computed fields', () => {
        const entries = resolveCustomUsageEntries('review', {
            usage: {
                url: 'https://example.test/wallet',
                fields: [{ displayName: '钱包', balance: { operation: 'subtract', paths: ['total', 'used'] } }]
            },
            usages: {
                wallet: {
                    fields: [{ balance: { paths: ['total', 'used'], operation: 'subtract' }, displayName: '钱包' }]
                }
            }
        });
        assert.deepStrictEqual(
            entries.map(entry => entry.usageKey),
            ['wallet']
        );
    });

    const differences: { name: string; usage: ProviderUsageOverrideConfig; wallet: ProviderUsageOverrideConfig }[] = [
        {
            name: 'nested value differences',
            usage: { body: { filter: { plan: 'wallet' } }, fields: { balance: 'balance' } },
            wallet: { body: { filter: { plan: 'other' } } }
        },
        {
            name: 'computed operand order',
            usage: { fields: { balance: { operation: 'subtract', paths: ['total', 'used'] } } },
            wallet: { fields: { balance: { operation: 'subtract', paths: ['used', 'total'] } } }
        },
        {
            name: 'quota array order',
            usage: { fields: [{ balance: 'first' }, { balance: 'second' }] },
            wallet: { fields: [{ balance: 'second' }, { balance: 'first' }] }
        }
    ];
    for (const { name, usage, wallet } of differences) {
        it(`preserves separate default queries for ${name}`, () => {
            const entries = resolveCustomUsageEntries('review', {
                usage: { url: 'https://example.test/wallet', ...usage },
                usages: { wallet }
            });
            assert.deepStrictEqual(
                entries.map(entry => entry.usageKey),
                ['default', 'wallet']
            );
        });
    }
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

it('usage schema validates conditional requirements and complete replacement arrays', async context => {
    const require = createRequire(import.meta.url);
    const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { Uri: { parse: () => ({}) } };
        }
        if (id.endsWith('/l10n')) {
            return { t: (english: string) => english };
        }
        if (
            id.endsWith('/configManager') ||
            id.endsWith('/logger') ||
            id.endsWith('/knownProviders') ||
            id.endsWith('/compatibleModelManager')
        ) {
            return {};
        }
        return originalRequire.call(this, id);
    };
    let schemaModule: typeof import('../../utils/config/jsonSchemaProvider');
    try {
        schemaModule = await import('../../utils/config/jsonSchemaProvider');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
    const createItem: (requireCoreFields: boolean) => JSONSchema7 = Reflect.get(
        schemaModule.JsonSchemaProvider,
        'createUsageItemSchema'
    );
    const createComputed: () => JSONSchema7 = Reflect.get(
        schemaModule.JsonSchemaProvider,
        'createUsageComputedFieldSchema'
    );
    const Ajv = require('ajv') as new () => {
        compile(schema: JSONSchema7): (value: unknown) => boolean;
    };
    const validate = new Ajv().compile({
        ...createItem.call(schemaModule.JsonSchemaProvider, false),
        definitions: { usageComputedField: createComputed.call(schemaModule.JsonSchemaProvider) }
    });

    assert.equal(validate({ fields: { displayName: 'renamed' } }), true);
    assert.equal(validate({ fields: [{ displayName: 'renamed' }] }), false);
    assert.equal(validate({ fields: [{ balance: 'first' }, { displayName: 'missing' }] }), false);
    assert.equal(validate({ fields: [] }), false);
    assert.equal(validate({ fields: [{ balance: 'first' }, { balance: 'second' }] }), true);

    const createProvider: (displayName: string) => JSONSchema7 = Reflect.get(
        schemaModule.JsonSchemaProvider,
        'createCustomProviderSchema'
    );
    const validateProvider = new Ajv().compile({
        ...createProvider.call(schemaModule.JsonSchemaProvider, 'Review'),
        definitions: { usageComputedField: createComputed.call(schemaModule.JsonSchemaProvider) }
    });
    const complete = { url: 'https://example.test/wallet', fields: { balance: 'balance' } };
    const cases: { name: string; value: unknown; valid: boolean }[] = [
        { name: 'provider without usage', value: {}, valid: true },
        { name: 'complete single usage', value: { usage: complete }, valid: true },
        { name: 'single usage without url', value: { usage: { fields: complete.fields } }, valid: false },
        { name: 'single usage without fields', value: { usage: { url: complete.url } }, valid: false },
        { name: 'single usage with request defaults only', value: { usage: { authType: 'none' } }, valid: false },
        {
            name: 'single usage without balance',
            value: { usage: { ...complete, fields: { paid: 'paid' } } },
            valid: false
        },
        {
            name: 'complete named mode without shared defaults',
            value: { usages: { wallet: complete } },
            valid: true
        },
        {
            name: 'incomplete named mode without defaults',
            value: { usages: { wallet: { fields: complete.fields } } },
            valid: false
        },
        {
            name: 'shared request defaults without url or fields',
            value: { usage: { authType: 'none' }, usages: { wallet: complete } },
            valid: true
        },
        {
            name: 'shared url inherited by a mode',
            value: { usage: { url: complete.url }, usages: { wallet: { fields: complete.fields } } },
            valid: true
        },
        {
            name: 'shared fields inherited by a mode',
            value: { usage: { fields: complete.fields }, usages: { wallet: { url: complete.url } } },
            valid: true
        },
        {
            name: 'partial shared fields completed by a mode',
            value: { usage: { fields: { paid: 'paid' } }, usages: { wallet: complete } },
            valid: true
        },
        {
            name: 'complete shared defaults inherited by an empty mode',
            value: { usage: complete, usages: { wallet: {} } },
            valid: true
        },
        {
            name: 'mode without a url to inherit',
            value: { usage: { authType: 'none' }, usages: { wallet: { fields: complete.fields } } },
            valid: false
        },
        {
            name: 'mode without fields to inherit',
            value: { usage: { authType: 'none' }, usages: { wallet: { url: complete.url } } },
            valid: false
        },
        {
            name: 'mode without a balance to inherit',
            value: { usage: { url: complete.url, fields: { paid: 'paid' } }, usages: { wallet: {} } },
            valid: false
        },
        {
            name: 'empty usages cannot relax usage requirements',
            value: { usage: { authType: 'none' }, usages: {} },
            valid: false
        },
        {
            name: 'empty usages with a complete usage remains invalid',
            value: { usage: complete, usages: {} },
            valid: false
        },
        {
            name: 'invalid url in shared defaults',
            value: { usage: { url: 'not-a-url' }, usages: { wallet: complete } },
            valid: false
        },
        {
            name: 'incomplete shared replacement array',
            value: { usage: { fields: [{ paid: 'paid' }] }, usages: { wallet: complete } },
            valid: false
        },
        {
            name: 'incomplete named replacement array',
            value: { usage: complete, usages: { wallet: { fields: [{ paid: 'paid' }] } } },
            valid: false
        },
        {
            name: 'multiple modes each supply the missing core fields',
            value: {
                usage: { headers: { 'X-Shared': 'shared' } },
                usages: { wallet: complete, other: { ...complete, fields: [{ balance: 'other' }] } }
            },
            valid: true
        },
        {
            name: 'all modes must supply a missing url',
            value: { usage: { fields: complete.fields }, usages: { wallet: complete, other: {} } },
            valid: false
        },
        {
            name: 'all modes must supply missing fields',
            value: { usage: { url: complete.url }, usages: { wallet: complete, other: {} } },
            valid: false
        },
        {
            name: 'a named array replaces partial shared fields',
            value: {
                usage: { fields: { paid: 'paid' } },
                usages: { wallet: { ...complete, fields: [{ balance: 'balance' }] } }
            },
            valid: true
        },
        {
            name: 'one shared field supports partial object overrides',
            value: {
                usage: { ...complete, fields: [{ balance: 'balance' }] },
                usages: { wallet: { fields: { displayName: '钱包' } } }
            },
            valid: true
        },
        {
            name: 'multiple shared fields can be inherited without an override',
            value: {
                usage: { ...complete, fields: [{ balance: 'first' }, { balance: 'second' }] },
                usages: { wallet: {} }
            },
            valid: true
        },
        {
            name: 'multiple shared fields cannot fill a partial object override',
            value: {
                usage: { ...complete, fields: [{ balance: 'first' }, { balance: 'second' }] },
                usages: { wallet: { fields: { displayName: '钱包' } } }
            },
            valid: false
        },
        {
            name: 'a complete object can replace multiple shared fields',
            value: {
                usage: { ...complete, fields: [{ balance: 'first' }, { balance: 'second' }] },
                usages: { wallet: { fields: { balance: 'balance' } } }
            },
            valid: true
        }
    ];
    for (const { name, value, valid } of cases) {
        await context.test(name, () => assert.equal(validateProvider(value), valid));
    }
});
