import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, beforeEach, describe, it } from 'node:test';
import type { JSONSchema7 } from 'json-schema';
import type {
    CustomHeaders,
    ProviderOverride,
    ProviderUsageConfig,
    UsageFieldItemConfig
} from '../../../types/sharedTypes';
import { resolveCustomUsageEntries, resolveUsageConfig } from '../usageConfigResolver';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
const url = 'https://example.test/usage';
let overrides: Record<string, ProviderOverride> = {};
let responseData: unknown = { balance: 25 };
let requests: { url: string; providerKey?: string }[] = [];
let keyLookups: string[] = [];
let CustomUsageQuery: typeof import('../customUsageQuery').CustomUsageQuery;
let compatible: typeof import('../../providers/compatible');
let validateSettings: (value: unknown) => boolean;

before(async () => {
    const originalRequire = NodeModule.prototype.require;
    const logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { Uri: { parse: () => ({}) }, env: { language: 'zh-cn' } };
        }
        if (id.endsWith('/logger') || id.endsWith('/statusLogger')) {
            return { Logger: logger, StatusLogger: logger };
        }
        if (id.endsWith('/l10n')) {
            return {
                t: (_en: string, zh: string, ...args: unknown[]) =>
                    args.reduce<string>((text, value, index) => text.split(`{${index}}`).join(String(value)), zh)
            };
        }
        if (id.endsWith('/knownProviders')) {
            return { InnerProviders: {}, KnownProviders: {}, resolveBuiltinProviderConfig: () => undefined };
        }
        if (id.endsWith('/compatibleModelManager')) {
            return { CompatibleModelManager: { getModels: () => [{ provider: 'review', id: 'name-fixture' }] } };
        }
        if (id.endsWith('/configManager')) {
            return {
                ConfigManager: {
                    getConfigProvider: () => ({}),
                    getProviderOverrides: () => overrides,
                    fetchWithProxy: async (
                        requestUrl: string,
                        _init: RequestInit,
                        options: { providerKey?: string }
                    ) => {
                        requests.push({ url: requestUrl, providerKey: options.providerKey });
                        return new Response(JSON.stringify(responseData), { status: 200 });
                    }
                }
            };
        }
        if (id.endsWith('/apiKeyManager')) {
            return {
                ApiKeyManager: {
                    getApiKey: async (provider: string) => {
                        keyLookups.push(provider);
                        throw new Error('Unexpected API key lookup');
                    },
                    processCustomHeader: (headers: CustomHeaders) => headers
                }
            };
        }
        if (id === '../common') {
            return originalRequire.call(this, '../format');
        }
        return originalRequire.call(this, id);
    };
    try {
        ({ CustomUsageQuery } = await import('../customUsageQuery'));
        compatible = await import('../../providers/compatible');
        const { JsonSchemaProvider } = await import('../../../utils/config/jsonSchemaProvider');
        const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
            compile(schema: JSONSchema7): (value: unknown) => boolean;
        };
        validateSettings = new Ajv({ strict: false, validateFormats: false }).compile(
            JsonSchemaProvider.getSettingsSchema()
        );
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

beforeEach(() => {
    overrides = {};
    responseData = { balance: 25 };
    requests = [];
    keyLookups = [];
});

describe('quota display name affixes', () => {
    const cases: {
        name: string;
        displayName: UsageFieldItemConfig['displayName'];
        value: unknown;
        expected: string | undefined;
    }[] = [
        { name: 'omitted legacy name', displayName: undefined, value: '月度包', expected: undefined },
        { name: 'legacy path', displayName: 'name', value: ' 月度包 ', expected: '月度包' },
        { name: 'legacy literal', displayName: '余额账户', value: '月度包', expected: '余额账户' },
        { name: 'legacy missing path', displayName: 'data.missing', value: '月度包', expected: 'data.missing' },
        { name: 'legacy empty literal', displayName: '', value: '月度包', expected: '' },
        { name: 'legacy numeric value', displayName: 'name', value: 0, expected: '0' },
        { name: 'path-only object', displayName: { path: 'name' }, value: ' 月度包 ', expected: '月度包' },
        {
            name: 'prefix only',
            displayName: { path: 'name', prefix: '套餐：' },
            value: '月度包',
            expected: '套餐：月度包'
        },
        {
            name: 'suffix only',
            displayName: { path: 'name', suffix: '（剩余）' },
            value: '月度包',
            expected: '月度包（剩余）'
        },
        {
            name: 'both affixes',
            displayName: { path: 'name', prefix: '套餐：', suffix: '（剩余）' },
            value: ' 月度包 ',
            expected: '套餐：月度包（剩余）'
        },
        {
            name: 'empty affixes',
            displayName: { path: 'name', prefix: '', suffix: '' },
            value: '月度包',
            expected: '月度包'
        },
        {
            name: 'affix whitespace',
            displayName: { path: 'name', prefix: '  [ ', suffix: ' ]  ' },
            value: ' 月度包 ',
            expected: '  [ 月度包 ]  '
        },
        {
            name: 'literal fallback with affixes',
            displayName: { path: '余额账户', prefix: '[', suffix: ']' },
            value: '月度包',
            expected: '[余额账户]'
        },
        {
            name: 'missing path with affixes',
            displayName: { path: 'data.missing', prefix: '[', suffix: ']' },
            value: '月度包',
            expected: '[data.missing]'
        },
        {
            name: 'empty path with affixes',
            displayName: { path: '', prefix: '[', suffix: ']' },
            value: '月度包',
            expected: '[]'
        },
        {
            name: 'literal affixes are not paths or templates',
            displayName: { path: 'name', prefix: '${name} [*] ', suffix: ' title' },
            value: '月度包',
            expected: '${name} [*] 月度包 title'
        },
        ...[
            ['numeric zero', 0, '[0]'],
            ['numeric value', 12.5, '[12.5]'],
            ['negative value', -2, '[-2]'],
            ['numeric string', ' 0 ', '[0]'],
            ['empty value', '', '[name]'],
            ['blank value', ' \t ', '[name]'],
            ['missing value', undefined, '[name]'],
            ['null value', null, '[name]'],
            ['boolean value', false, '[name]'],
            ['object value', { title: 'ignored' }, '[name]'],
            ['array value', ['ignored'], '[name]'],
            ['infinite value', Infinity, '[name]'],
            ['NaN value', NaN, '[name]']
        ].map(([name, value, expected]) => ({
            name: String(name),
            displayName: { path: 'name', prefix: '[', suffix: ']' },
            value,
            expected: String(expected)
        }))
    ];

    for (const { name, displayName, value, expected } of cases) {
        it(`resolves ${name} without changing the response or configuration`, () => {
            const data = { balance: 25, name: value };
            const usage: ProviderUsageConfig = { url, fields: { balance: 'balance', displayName } };
            const snapshot = structuredClone({ data, usage });
            const items = new CustomUsageQuery().resolveUsageItems(data, usage);
            assert.equal(items.length, 1);
            assert.equal(items[0].displayName, expected);
            assert.equal(items[0].balance, 25);
            assert.equal(items[0].currency, 'USD');
            assert.deepEqual({ data, usage }, snapshot);
        });
    }

    const rows = [
        [
            { name: ' A ', remain: 10 },
            { name: 'B', remain: 20 }
        ],
        [],
        [{ name: 'C', remain: 30 }]
    ];
    const arrayCases: { name: string; data: unknown; fields: UsageFieldItemConfig; expected: string[] }[] = [
        {
            name: 'implicit consecutive arrays',
            data: { items: rows },
            fields: { balance: 'items.remain', displayName: { path: 'items.name', prefix: '[', suffix: ']' } },
            expected: ['[A]', '[B]', '[C]']
        },
        {
            name: 'explicit array context',
            data: { items: rows },
            fields: { arrayPath: 'items', balance: 'remain', displayName: { path: 'name', prefix: '[', suffix: ']' } },
            expected: ['[A]', '[B]', '[C]']
        },
        {
            name: 'explicit consecutive markers',
            data: { items: rows },
            fields: { balance: 'items[][].remain', displayName: { path: 'items[][].name', prefix: '[', suffix: ']' } },
            expected: ['[A]', '[B]', '[C]']
        },
        {
            name: 'root array context',
            data: rows,
            fields: { balance: 'remain', displayName: { path: 'name', prefix: '[', suffix: ']' } },
            expected: ['[A]', '[B]', '[C]']
        },
        {
            name: 'parent context',
            data: { groups: [{ title: '父级', items: rows }] },
            fields: { balance: 'groups.items.remain', displayName: { path: 'title', prefix: '[', suffix: ']' } },
            expected: ['[父级]', '[父级]', '[父级]']
        },
        {
            name: 'response root fallback',
            data: { title: '根级', items: rows },
            fields: { balance: 'items.remain', displayName: { path: 'title', prefix: '[', suffix: ']' } },
            expected: ['[根级]', '[根级]', '[根级]']
        },
        {
            name: 'computed balances',
            data: { items: rows },
            fields: {
                balance: { operation: 'multiply', paths: ['items.remain', 2] },
                displayName: { path: 'items.name', prefix: '[', suffix: ']' }
            },
            expected: ['[A]', '[B]', '[C]']
        },
        {
            name: 'explicit numeric index',
            data: { items: rows },
            fields: {
                balance: 'items[0][1].remain',
                displayName: { path: 'items[0][1].name', prefix: '[', suffix: ']' }
            },
            expected: ['[B]']
        }
    ];
    for (const { name, data, fields, expected } of arrayCases) {
        it(`uses the existing ${name} for the decorated name`, () => {
            const snapshot = structuredClone({ data, fields });
            const items = new CustomUsageQuery().resolveUsageItems(data, { url, fields });
            assert.deepEqual(
                items.map(item => item.displayName),
                expected
            );
            assert.deepEqual({ data, fields }, snapshot);
        });
    }
});

describe('display name configuration inheritance', () => {
    it('inherits the complete name object while merging other field overrides', () => {
        const base: ProviderUsageConfig = {
            url,
            fields: { balance: 'balance', displayName: { path: 'name', prefix: '[', suffix: ']' } }
        };
        const snapshot = structuredClone(base);
        assert.deepEqual(resolveUsageConfig(base, { fields: { unit: '次' } })?.fields, {
            ...base.fields,
            unit: '次'
        });
        assert.deepEqual(base, snapshot);
    });

    it('replaces the complete displayName object without inheriting old affixes', () => {
        assert.deepEqual(
            resolveUsageConfig(
                { url, fields: { balance: 'balance', displayName: { path: 'name', prefix: '[', suffix: ']' } } },
                { fields: { displayName: { path: 'title', suffix: '！' } } }
            )?.fields,
            { balance: 'balance', displayName: { path: 'title', suffix: '！' } }
        );
    });

    for (const [name, displayName, keys] of [
        ['reordered object keys', { suffix: ']', prefix: '[', path: 'name' }, ['wallet']],
        ['different prefix', { path: 'name', prefix: '(', suffix: ']' }, ['default', 'wallet']],
        ['different suffix', { path: 'name', prefix: '[', suffix: ')' }, ['default', 'wallet']]
    ] as const) {
        it(`preserves configuration equivalence for ${name}`, () => {
            const entries = resolveCustomUsageEntries('review', {
                usage: { url, fields: { balance: 'balance', displayName: { path: 'name', prefix: '[', suffix: ']' } } },
                usages: { wallet: { fields: { displayName } } }
            });
            assert.deepEqual(
                entries.map(entry => entry.usageKey),
                [...keys]
            );
        });
    }
});

describe('display name settings schema', () => {
    const cases: { name: string; displayName: unknown; valid: boolean }[] = [
        { name: 'legacy path', displayName: 'name', valid: true },
        { name: 'legacy empty literal', displayName: '', valid: true },
        { name: 'path only', displayName: { path: 'name' }, valid: true },
        { name: 'prefix only', displayName: { path: 'name', prefix: '套餐：' }, valid: true },
        { name: 'suffix only', displayName: { path: 'name', suffix: '（剩余）' }, valid: true },
        { name: 'both affixes', displayName: { path: 'name', prefix: '[', suffix: ']' }, valid: true },
        { name: 'empty path', displayName: { path: '', prefix: '[', suffix: ']' }, valid: true },
        { name: 'empty affixes', displayName: { path: 'name', prefix: '', suffix: '' }, valid: true },
        ...[
            ['null', null],
            ['number', 3],
            ['boolean', true],
            ['array', []],
            ['empty object', {}],
            ['missing path', { prefix: '[' }],
            ['numeric path', { path: 3 }],
            ['null path', { path: null }],
            ['numeric prefix', { path: 'name', prefix: 3 }],
            ['null prefix', { path: 'name', prefix: null }],
            ['boolean suffix', { path: 'name', suffix: false }],
            ['null suffix', { path: 'name', suffix: null }],
            ['unknown property', { path: 'name', template: '{name}' }]
        ].map(([name, displayName]) => ({ name: String(name), displayName, valid: false }))
    ];
    for (const { name, displayName, valid } of cases) {
        it(`${valid ? 'accepts' : 'rejects'} ${name} in complete, array and inherited fields`, () => {
            const fields = { balance: 'balance', displayName };
            for (const override of [
                { usage: { url, fields } },
                { usage: { url, fields: [fields] } },
                { usage: { fields }, usages: { wallet: { url } } },
                { usages: { wallet: { url, fields } } }
            ]) {
                assert.equal(validateSettings({ 'gcmp.providerOverrides': { review: override } }), valid);
            }
        });
    }

    it('keeps the outer mode displayName restricted to strings', () => {
        assert.equal(
            validateSettings({
                'gcmp.providerOverrides': {
                    review: {
                        usage: { url, displayName: { path: 'name', prefix: '[' }, fields: { balance: 'balance' } }
                    }
                }
            }),
            false
        );
    });
});

describe('display name query and formatter chain', () => {
    for (const array of [false, true]) {
        it(`decorates a ${array ? 'fields array' : 'single fields'} response in one anonymous request`, async () => {
            const fields: UsageFieldItemConfig = {
                balance: 'balance',
                displayName: { path: 'name', prefix: '套餐：', suffix: '（剩余）' }
            };
            overrides = { review: { usage: { url, authType: 'none', fields: array ? [fields] : fields } } };
            responseData = { name: ' 月度包 ', balance: 25 };
            const result = await new CustomUsageQuery().queryBalance('review');
            assert.equal(result.items?.[0].displayName, '套餐：月度包（剩余）');
            assert.equal(result.balance, 25);
            assert.deepEqual(requests, [{ url, providerKey: 'review' }]);
            assert.deepEqual(keyLookups, []);
        });
    }

    it('preserves all decorated array labels after inherited configuration and formatting', async () => {
        overrides = {
            review: {
                usage: {
                    authType: 'none',
                    displayName: '账户',
                    unit: 'CNY',
                    fields: { balance: 'items.remain', displayName: { path: 'items.name', prefix: '[', suffix: ']' } }
                },
                usages: { wallet: { url } }
            }
        };
        responseData = {
            items: [
                { name: ' A ', remain: 10 },
                { name: 'B', remain: 20 }
            ]
        };
        assert.equal(validateSettings({ 'gcmp.providerOverrides': overrides }), true);
        const snapshot = structuredClone({ overrides, responseData });
        const result = await compatible.queryCompatibleProviderQuota('review', '', 'fixture');
        assert.deepEqual(
            result.quotaEntries?.map(entry => entry.label),
            ['账户 / [A]', '账户 / [B]']
        );
        assert.deepEqual(
            result.quotaEntries?.map(entry => entry.summary),
            ['¥10.00', '¥20.00']
        );
        assert.equal(result.summary, '2 项余额');
        assert.deepEqual(requests, [{ url, providerKey: 'review' }]);
        assert.deepEqual(keyLookups, []);
        assert.deepEqual({ overrides, responseData }, snapshot);
    });
});
