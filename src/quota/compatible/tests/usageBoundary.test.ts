import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { before, beforeEach, describe, it } from 'node:test';
import type { JSONSchema7 } from 'json-schema';
import type { ConfigProvider, CustomHeaders, ProviderConfig, ProviderOverride } from '../../../types/sharedTypes';
import type { ConfigUsageState, HostMessage, PanelContext } from '../../../ui/configSetManager/types';
import type { KnownProviderConfig } from '../../../utils/config/knownProviders';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
const url = 'https://example.test/wallet';
const fields = { balance: 'balance' };
let overrides: Record<string, ProviderOverride> = {};
let configuredProviders: ConfigProvider = {};
const knownProviders: Record<string, KnownProviderConfig> = {};
let models = [{ provider: 'review', id: 'fixture-model' }];
let savedKey: string | undefined;
let queryCalls: { slot: string; apiKey: string }[] = [];
let requestUrls: string[] = [];
let requestHeaders: Headers[] = [];
let requestProviderIds: (string | undefined)[] = [];
let keyLookups: string[] = [];
let responseData: unknown = { balance: 25, remaining: 10 };
const responsesByUrl = new Map<string, unknown>();
let manager: typeof import('../balanceQueryManager').BalanceQueryManager;
let CustomUsageQuery: typeof import('../customUsageQuery').CustomUsageQuery;
let compatible: typeof import('../../providers/compatible');
let JsonSchemaProvider: typeof import('../../../utils/config/jsonSchemaProvider').JsonSchemaProvider;
let sanitizeConfigForLogging: typeof import('../../../utils/net/proxyAgent').sanitizeConfigForLogging;
let HarRecorder: typeof import('../../../utils/net/harRecorder').HarRecorder;
let UsageHost: typeof import('../../../ui/configSetManager/usageHost').UsageHost;

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
                t: (en: string, zh: string, ...args: unknown[]) =>
                    args.reduce<string>((text, value, index) => text.split(`{${index}}`).join(String(value)), zh || en)
            };
        }
        if (id.endsWith('/knownProviders')) {
            return {
                InnerProviders: {},
                KnownProviders: knownProviders,
                resolveBuiltinProviderConfig: () => undefined
            };
        }
        if (id.endsWith('/compatibleModelManager')) {
            return { CompatibleModelManager: { getModels: () => models } };
        }
        if (id.endsWith('/configManager')) {
            return {
                ConfigManager: {
                    getConfigProvider: () => configuredProviders,
                    applyProviderOverrides: (_provider: string, config: ProviderConfig) => config,
                    getProviderOverrides: () => overrides,
                    fetchWithProxy: async (
                        requestUrl: string,
                        init: RequestInit,
                        options: { providerKey?: string }
                    ) => {
                        requestUrls.push(requestUrl);
                        requestHeaders.push(new Headers(init.headers));
                        requestProviderIds.push(options.providerKey);
                        const data = responsesByUrl.has(requestUrl) ? responsesByUrl.get(requestUrl) : responseData;
                        return new Response(JSON.stringify(data), { status: 200 });
                    }
                }
            };
        }
        if (id.endsWith('/apiKeyManager')) {
            return {
                ApiKeyManager: {
                    getApiKey: async (provider: string) => {
                        keyLookups.push(provider);
                        if (savedKey !== undefined) {
                            return savedKey;
                        }
                        throw new Error('Unexpected global API key lookup');
                    },
                    processCustomHeader: (headers: CustomHeaders) => headers
                }
            };
        }
        if (id.endsWith('/configSetStore')) {
            return {
                ConfigSetStore: {
                    list: () => [{ id: 'fixture', label: 'Fixture' }],
                    getActiveId: () => 'fixture',
                    getApiKey: async () => savedKey
                }
            };
        }
        if (id.endsWith('/configSetCommands')) {
            return {
                listSlots: (provider: string) => [{ slot: provider, displayName: provider, isMain: true }],
                getSiteOwnerProvider: () => undefined,
                readCurrentSite: () => undefined
            };
        }
        if (id.endsWith('/gistSyncService')) {
            return { getKeyDisplayName: (value: string) => value };
        }
        if (id === '../../quota/providerQuota') {
            return {
                isQuotaSupportedSlot: (slot: string) =>
                    slot === 'moonshot' || manager.hasHandler(slot) || manager.hasCustomUsageEntries(slot),
                getQuotaMetricType: () => 'balance',
                getQuotaMetricLabel: () => '余额',
                resolveQuotaSite: (_slot: string, site: string | undefined) => site,
                formatQuotaLastUpdated: (date: Date) => date.toISOString(),
                queryProviderQuota: async (
                    slot: string,
                    apiKey: string,
                    _site: string | undefined,
                    updated: string
                ) => {
                    queryCalls.push({ slot, apiKey });
                    return compatible.queryCompatibleProviderQuota(slot, apiKey, updated);
                }
            };
        }
        if (id.endsWith('/codexQuota') || id.endsWith('/grokQuota') || id.endsWith('/chatgptPlanType')) {
            return {};
        }
        if (id === '../common') {
            return originalRequire.call(this, '../format');
        }
        return originalRequire.call(this, id);
    };
    try {
        ({ BalanceQueryManager: manager } = await import('../balanceQueryManager'));
        ({ CustomUsageQuery } = await import('../customUsageQuery'));
        compatible = await import('../../providers/compatible');
        ({ JsonSchemaProvider } = await import('../../../utils/config/jsonSchemaProvider'));
        ({ sanitizeConfigForLogging } = await import('../../../utils/net/proxyAgent'));
        ({ HarRecorder } = await import('../../../utils/net/harRecorder'));
        ({ UsageHost } = await import('../../../ui/configSetManager/usageHost'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

beforeEach(() => {
    overrides = {};
    configuredProviders = {};
    for (const key of Object.keys(knownProviders)) {
        delete knownProviders[key];
    }
    models = [{ provider: 'review', id: 'fixture-model' }];
    savedKey = undefined;
    queryCalls = [];
    requestUrls = [];
    requestHeaders = [];
    requestProviderIds = [];
    keyLookups = [];
    responseData = { balance: 25, remaining: 10 };
    responsesByUrl.clear();
});

function createHost() {
    const messages: HostMessage[] = [];
    let finish!: (state: ConfigUsageState) => void;
    const finished = new Promise<ConfigUsageState>(resolve => {
        finish = resolve;
    });
    const context: PanelContext = {
        post(message) {
            messages.push(message);
            if (message.command === 'configUsages') {
                const result = message.configUsages.find(state => state.id === 'fixture');
                if (
                    result &&
                    !result.loading &&
                    !result.queued &&
                    (result.summary !== undefined || result.error !== undefined)
                ) {
                    finish(result);
                }
            }
        },
        async sendStates() {},
        async refreshCliProviders() {},
        async refreshCliUsage() {},
        isAlive: () => true
    };
    return { host: new UsageHost(context), messages, finished };
}

describe('legacy scalar quota presentation', () => {
    for (const displayName of [undefined, '余额账户']) {
        it(`preserves ${displayName ? 'configured' : 'unnamed'} labels and tables despite root metadata`, async () => {
            overrides = {
                review: {
                    usage: {
                        url,
                        authType: 'none',
                        unit: 'CNY',
                        displayName,
                        fields: { balance: 'balance', paid: 'paid', granted: 'granted' }
                    }
                }
            };
            responseData = {
                balance: 25,
                paid: 20,
                granted: 5,
                name: '服务元数据',
                id: 'account-id',
                plan: 'test-plan'
            };
            const result = await compatible.queryCompatibleProviderQuota('review', '', 'fixture');
            assert.equal(result.summary, displayName ? '1 项余额' : '¥25.00');
            assert.equal(result.quotaEntries?.length, 1);
            assert.equal(result.quotaEntries?.[0].label, displayName);
            assert.equal(result.quotaEntries?.[0].summary, '¥25.00');
            assert.deepEqual(result.quotaEntries?.[0].tables?.[0].rows, [['¥20.00', '¥5.00', '¥25.00']]);
            assert.deepEqual(result.tables, displayName ? undefined : result.quotaEntries?.[0].tables);
            assert.equal(result.lastUpdated, 'fixture');
            assert.deepEqual(requestUrls, [url]);
            assert.deepEqual(requestProviderIds, ['review']);
            assert.deepEqual(keyLookups, []);
        });
    }
});

describe('consecutive array quota parsing', () => {
    const rows = [
        [
            { name: 'A', remain: 10 },
            { name: 'B', remain: 20 }
        ],
        [],
        [{ name: 'C', remain: 30 }]
    ];
    for (const depth of [2, 3]) {
        const data = depth === 2 ? rows : [rows];
        for (const computed of [false, true]) {
            for (const [name, root, arrayPath, balance] of [
                ['implicit path', false, undefined, 'items.remain'],
                ['explicit arrayPath', false, 'items', 'remain'],
                ['root relative path', true, undefined, 'remain'],
                ['root arrayPath', true, '', 'remain'],
                ['explicit markers', false, undefined, `items${'[]'.repeat(depth)}.remain`],
                ['wildcard sum', false, undefined, `items${'[*]'.repeat(depth)}.remain`],
                ['numeric indices', false, undefined, `items${'[0]'.repeat(depth)}.remain`]
            ] as const) {
                it(`parses ${depth} array levels with ${name}${computed ? ' and calculation' : ''}`, async () => {
                    overrides = {
                        review: {
                            usage: {
                                url,
                                authType: 'none',
                                unit: 'CNY',
                                fields: {
                                    arrayPath,
                                    balance: computed ? { operation: 'multiply', paths: [balance, 2] } : balance
                                }
                            }
                        }
                    };
                    responseData = root ? data : { items: data };
                    const snapshot = structuredClone(responseData);
                    const expected =
                        name === 'wildcard sum' ? [60]
                        : name === 'numeric indices' ? [10]
                        : [10, 20, 30];
                    const result = await manager.queryBalance('review');
                    assert.deepEqual(
                        result.items?.map(item => item.balance),
                        expected.map(value => value * (computed ? 2 : 1))
                    );
                    assert.ok(result.items?.every(item => item.currency === 'CNY'));
                    assert.deepEqual(responseData, snapshot);
                    assert.deepEqual(requestUrls, [url]);
                    assert.deepEqual(requestProviderIds, ['review']);
                    assert.deepEqual(keyLookups, []);
                });
            }
        }
    }

    it('preserves normal quotas alongside consecutive arrays in a single response', async () => {
        overrides = {
            review: {
                usage: {
                    url,
                    authType: 'none',
                    unit: 'CNY',
                    fields: [
                        { displayName: '现金钱包', balance: 'balance' },
                        { arrayPath: 'items', balance: 'remain' }
                    ]
                }
            }
        };
        responseData = { balance: 77, items: rows };
        const result = await compatible.queryCompatibleProviderQuota('review', '', 'fixture');
        assert.equal(result.summary, '4 项余额');
        assert.deepEqual(
            result.quotaEntries?.map(entry => [entry.label, entry.summary]),
            [
                ['现金钱包', '¥77.00'],
                ['A', '¥10.00'],
                ['B', '¥20.00'],
                ['C', '¥30.00']
            ]
        );
        assert.deepEqual(requestUrls, [url]);
        assert.deepEqual(requestProviderIds, ['review']);
        assert.deepEqual(keyLookups, []);
    });
});

describe('usage configuration log redaction', () => {
    for (const name of [
        'X-Access-Token',
        'x_access_token',
        'X-Goog-Api-Key',
        'X-APIKEY',
        'api_key',
        'APIKEY',
        'X-AuthToken',
        'prefix-api-key-suffix'
    ]) {
        it(`redacts ${name} consistently in all header containers and HAR records`, () => {
            const headers = {
                [name]: 'fixture-not-a-real-credential',
                Accept: 'application/json',
                'X-Trace': 'visible',
                'X-Token-Count': '25',
                'X-Api-Keyboard': 'visible'
            };
            const original = {
                providerOverrides: {
                    review: {
                        customHeader: headers,
                        usage: { url, fields, authType: 'none', headers },
                        usages: { wallet: { headers } }
                    }
                }
            };
            const snapshot = structuredClone(original);
            const sanitized = sanitizeConfigForLogging(original).providerOverrides.review;
            const expected = { ...headers, [name]: '***' };
            assert.deepEqual(sanitized.customHeader, expected);
            assert.deepEqual(sanitized.usage.headers, expected);
            assert.deepEqual(sanitized.usages.wallet.headers, expected);
            assert.deepEqual(original, snapshot);

            const recorder = HarRecorder.getInstance() as unknown as {
                sanitizeHeaders(headers: { name: string; value: string }[]): { name: string; value: string }[];
            };
            assert.deepEqual(
                recorder.sanitizeHeaders(Object.entries(headers).map(([name, value]) => ({ name, value }))),
                Object.entries(expected).map(([name, value]) => ({ name, value }))
            );
        });
    }

    it('redacts shared and named usage headers without changing the original configuration', () => {
        const original = {
            providerOverrides: {
                review: {
                    customHeader: { Authorization: 'Bearer fixture-provider' },
                    usage: { headers: { Authorization: 'Bearer fixture-shared', 'X-Trace': 'visible' } },
                    usages: {
                        wallet: { headers: { 'x-api-key': 'fixture-key', Cookie: 'fixture-cookie' } },
                        search: { headers: { 'Proxy-Authorization': 'fixture-proxy', 'X-Request': 'visible' } }
                    }
                }
            }
        };
        const snapshot = structuredClone(original);
        const sanitized = sanitizeConfigForLogging(original);

        assert.equal(sanitized.providerOverrides.review.customHeader.Authorization, '***');
        assert.deepEqual(sanitized.providerOverrides.review.usage.headers, {
            Authorization: '***',
            'X-Trace': 'visible'
        });
        assert.deepEqual(sanitized.providerOverrides.review.usages.wallet.headers, {
            'x-api-key': '***',
            Cookie: '***'
        });
        assert.deepEqual(sanitized.providerOverrides.review.usages.search.headers, {
            'Proxy-Authorization': '***',
            'X-Request': 'visible'
        });
        assert.deepEqual(original, snapshot);
    });

    it('redacts usage headers in configuration arrays', () => {
        const sanitized = sanitizeConfigForLogging([
            { usage: { headers: { 'X-Auth-Token': 'fixture-token', Accept: 'application/json' } } },
            { usages: { wallet: { headers: { 'set-cookie': 'fixture-cookie' } } } }
        ]);

        assert.deepEqual(sanitized[0].usage?.headers, { 'X-Auth-Token': '***', Accept: 'application/json' });
        assert.deepEqual(sanitized[1].usages?.wallet.headers, { 'set-cookie': '***' });
    });

    it('preserves recursive credential redaction inside non-sensitive header metadata', () => {
        const sanitized = sanitizeConfigForLogging({
            headers: { 'X-Metadata': { apiKey: 'fixture-key', proxy: 'http://user:password@proxy.example:8080' } }
        });

        assert.equal(sanitized.headers['X-Metadata'].apiKey, '***');
        assert.equal(sanitized.headers['X-Metadata'].proxy, 'http://proxy.example:8080/');
    });
});

describe('literal provider names in settings schema', () => {
    const names = [
        'review[local]',
        'review(local)',
        'review.foo',
        'review+',
        'review*',
        'review$',
        'review^local',
        'review?',
        'review{2}',
        'review|alt',
        'review\\path'
    ];
    const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
        compile(schema: JSONSchema7): (value: unknown) => boolean;
    };

    for (const name of names) {
        it(`keeps usage requirements active for ${name}`, () => {
            models = [{ provider: name, id: 'fixture-model' }];
            const schema = JsonSchemaProvider.getSettingsSchema();
            const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
            const setting = schema.properties?.['gcmp.providerOverrides'];
            assert.ok(setting && typeof setting === 'object');
            const patterns = Object.keys(setting.patternProperties ?? {}).filter(pattern =>
                new RegExp(pattern, 'u').test(name)
            );
            assert.equal(patterns.length, 1);
            for (const other of ['reviewXfoo', 'review', 'alt', 'reviewlocal', 'reviewpath', 'review[local]suffix']) {
                assert.equal(
                    patterns.some(pattern => new RegExp(pattern, 'u').test(other)),
                    false
                );
            }

            assert.equal(validate({ 'gcmp.providerOverrides': { [name]: { usage: { authType: 'none' } } } }), false);
            assert.equal(
                validate({ 'gcmp.providerOverrides': { [name]: { usage: { url, fields, authType: 'none' } } } }),
                true
            );
            assert.equal(
                validate({
                    'gcmp.providerOverrides': {
                        [name]: { usage: { authType: 'none' }, usages: { wallet: { url, fields } } }
                    }
                }),
                true
            );
        });
    }

    it('escapes built-in and known provider patterns as well as custom names', () => {
        configuredProviders = {
            'builtin[local]': {
                displayName: 'Builtin',
                baseUrl: 'https://example.test',
                apiKeyTemplate: '${APIKEY}',
                models: [
                    {
                        id: 'fixture-model',
                        name: 'Fixture',
                        tooltip: 'Fixture',
                        maxInputTokens: 1024,
                        maxOutputTokens: 512,
                        capabilities: { toolCalling: true, imageInput: false }
                    }
                ]
            }
        };
        knownProviders['known(local)'] = { displayName: 'Known' };
        const schema = JsonSchemaProvider.getSettingsSchema();
        const setting = schema.properties?.['gcmp.providerOverrides'];
        assert.ok(setting && typeof setting === 'object');
        const patterns = Object.keys(setting.patternProperties ?? {});
        const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);

        for (const name of ['builtin[local]', 'known(local)']) {
            const matches = patterns.filter(pattern => new RegExp(pattern).test(name));
            assert.equal(matches.length, 1);
            assert.equal(validate({ 'gcmp.providerOverrides': { [name]: { customHeader: 42 } } }), false);
            assert.equal(
                validate({ 'gcmp.providerOverrides': { [name]: { customHeader: { 'X-Trace': 'visible' } } } }),
                true
            );
        }
    });
});

describe('API key requirements for custom usage providers', () => {
    it('does not require a key for a base provider when all named modes inherit none', () => {
        overrides = {
            review: { usage: { authType: 'none' }, usages: { wallet: { url, fields }, search: { url, fields } } }
        };
        assert.equal(manager.requiresApiKey('review'), false);
        assert.equal(manager.requiresApiKey('review::wallet'), false);
        assert.equal(manager.requiresApiKey('review::search'), false);
    });

    it('requires a key for mixed modes while keeping the anonymous entry queryable', () => {
        overrides = {
            review: {
                usage: { authType: 'none' },
                usages: { wallet: { url, fields }, search: { url, fields, authType: 'bearer' } }
            }
        };
        assert.equal(manager.requiresApiKey('review'), true);
        assert.equal(manager.requiresApiKey('review::wallet'), false);
        assert.equal(manager.requiresApiKey('review::search'), true);
    });

    it('keeps unknown targets and dedicated handlers key-protected', () => {
        overrides = { aihubmix: { usage: { url, fields, authType: 'none' } } };
        models = [{ provider: 'aihubmix', id: 'fixture-model' }];
        assert.equal(manager.requiresApiKey('unknown'), true);
        assert.equal(manager.requiresApiKey('review::missing'), true);
        assert.equal(manager.requiresApiKey('aihubmix'), true);
    });

    it('queries an explicit default only once through the registered provider path', async () => {
        overrides = {
            review: {
                usage: { url: 'https://example.test/shared', fields, authType: 'none' },
                usages: { default: { url, fields: { balance: 'remaining' } } }
            }
        };
        const result = await compatible.queryCompatibleProviderQuota('review', '', 'fixture');

        assert.deepEqual(requestUrls, [url]);
        assert.equal(result.quotaEntries?.length, 1);
        assert.equal(result.quotaEntries?.[0].summary, '$10.00');
    });
});

describe('custom usage target boundaries', () => {
    for (const provider of ['review-team', 'review::team', 'review::team::local', 'review%3A%3Ateam']) {
        it(`queries a schema-valid provider ${provider} without inventing a zero balance`, async () => {
            models = [{ provider, id: 'fixture-model' }];
            overrides = { [provider]: { usage: { url, fields, authType: 'none', unit: 'CNY' } } };
            const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
                compile(schema: JSONSchema7): (value: unknown) => boolean;
            };
            const validate = new Ajv({ strict: false, validateFormats: false }).compile(
                JsonSchemaProvider.getSettingsSchema()
            );
            assert.equal(validate({ 'gcmp.providerOverrides': overrides }), true);
            assert.equal(manager.hasCustomUsageEntries(provider), true);
            assert.equal(manager.requiresApiKey(provider), false);
            assert.equal(manager.getBaseProviderId(provider), provider);
            const entries = manager.getRegisteredProvidersForBaseProvider(provider);
            assert.equal(entries.length, 1);
            assert.equal(manager.getBaseProviderId(entries[0]), provider);
            assert.equal(manager.requiresApiKey(entries[0]), false);

            const result = await compatible.queryCompatibleProviderQuota(provider, '', 'fixture');
            assert.deepEqual(requestUrls, [url]);
            assert.deepEqual(requestProviderIds, [provider]);
            assert.equal(result.quotaEntries?.[0].summary, '¥25.00');
            assert.deepEqual(keyLookups, []);

            assert.equal((await new CustomUsageQuery().queryBalance(provider)).balance, 25);
            assert.deepEqual(requestUrls, [url, url]);
            assert.deepEqual(requestProviderIds, [provider, provider]);
        });
    }

    it('keeps delimiter-containing provider and usage keys distinct across request contexts', async () => {
        models = [
            { provider: 'review', id: 'fixture-model' },
            { provider: 'review::team', id: 'fixture-model' }
        ];
        overrides = {
            review: {
                usage: { authType: 'none' },
                usages: { 'team::wallet': { url: `${url}/first`, fields, displayName: 'First' } }
            },
            'review::team': {
                customHeader: { 'X-Trace': 'second-provider' },
                usage: { authType: 'none' },
                usages: { wallet: { url: `${url}/second`, fields, displayName: 'Second' } }
            }
        };
        const entries = models.map(model => manager.getRegisteredProvidersForBaseProvider(model.provider)[0]);
        assert.equal(new Set(entries).size, 2);
        assert.deepEqual(
            entries.map(entry => manager.getBaseProviderId(entry)),
            ['review', 'review::team']
        );
        for (const provider of models.map(model => model.provider)) {
            const result = await compatible.queryCompatibleProviderQuota(provider, '', 'fixture');
            assert.equal(result.quotaEntries?.length, 1);
            assert.equal(result.quotaEntries?.[0].summary, '$25.00');
        }
        assert.deepEqual(requestUrls, [`${url}/first`, `${url}/second`]);
        assert.deepEqual(requestProviderIds, ['review', 'review::team']);
        assert.equal(requestHeaders[0].has('X-Trace'), false);
        assert.equal(requestHeaders[1].get('X-Trace'), 'second-provider');
    });

    it('looks up bearer credentials using the original provider name', async () => {
        const provider = 'review::team';
        models = [{ provider, id: 'fixture-model' }];
        overrides = {
            [provider]: { customHeader: { 'X-Trace': 'provider' }, usage: { url, fields, authType: 'bearer' } }
        };
        savedKey = 'fixture-not-a-real-key';
        const [entry] = manager.getRegisteredProvidersForBaseProvider(provider);
        assert.equal(manager.requiresApiKey(entry), true);
        assert.equal((await manager.queryBalance(entry)).balance, 25);
        assert.deepEqual(keyLookups, [provider]);
        assert.deepEqual(requestProviderIds, [provider]);
        assert.equal(requestHeaders[0].get('Authorization'), `Bearer ${savedKey}`);
        assert.equal(requestHeaders[0].get('X-Trace'), 'provider');
    });

    for (const target of ['unknown', 'review::missing']) {
        it(`rejects unregistered target ${target} without returning a fake balance`, async () => {
            overrides = { review: { usage: { url, fields, authType: 'none' } } };
            await assert.rejects(manager.queryBalance(target), /No balance query handler/);
            assert.deepEqual(requestUrls, []);
        });
    }
});

describe('overlapping base providers and usage entries', () => {
    const child = 'review::team';
    function configure(parentAuth: 'none' | 'bearer' = 'bearer', childAuth: 'none' | 'bearer' = 'none'): void {
        models = [
            { provider: 'review', id: 'fixture-parent' },
            { provider: child, id: 'fixture-child' }
        ];
        overrides = {
            review: {
                customHeader: { 'X-Trace': 'parent' },
                usage: { authType: parentAuth },
                usages: { team: { url: `${url}/parent`, fields, unit: 'CNY' } }
            },
            [child]: {
                customHeader: { 'X-Trace': 'child' },
                usage: { url: `${url}/child`, fields, authType: childAuth, unit: 'CNY' }
            }
        };
        responsesByUrl.set(`${url}/parent`, { balance: 300 });
        responsesByUrl.set(`${url}/child`, { balance: 25 });
    }

    it('distinguishes the raw base provider from an explicitly selected entry', () => {
        configure();
        const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
            compile(schema: JSONSchema7): (value: unknown) => boolean;
        };
        assert.equal(
            new Ajv({ strict: false, validateFormats: false }).compile(JsonSchemaProvider.getSettingsSchema())({
                'gcmp.providerOverrides': overrides
            }),
            true
        );
        assert.equal(manager.getBaseProviderId(child), child);
        assert.equal(manager.getBaseProviderId(child, 'entry'), 'review');
        assert.equal(manager.requiresApiKey(child), false);
        assert.equal(manager.requiresApiKey(child, 'entry'), true);
        assert.deepEqual(manager.getRegisteredProvidersForBaseProvider(child), ['review%3A%3Ateam::default']);
    });

    it('queries both identities with their own URL, headers and credentials', async () => {
        configure();
        savedKey = 'fixture-parent-key';
        assert.equal((await manager.queryBalance(child)).balance, 25);
        assert.equal((await manager.queryBalance(child, undefined, 'entry')).balance, 300);
        assert.deepEqual(requestUrls, [`${url}/child`, `${url}/parent`]);
        assert.deepEqual(requestProviderIds, [child, 'review']);
        assert.deepEqual(keyLookups, ['review']);
        assert.equal(requestHeaders[0].has('Authorization'), false);
        assert.equal(requestHeaders[0].get('X-Trace'), 'child');
        assert.equal(requestHeaders[1].get('Authorization'), `Bearer ${savedKey}`);
        assert.equal(requestHeaders[1].get('X-Trace'), 'parent');
    });

    it('keeps direct raw-provider queries separate from an explicit usage key', async () => {
        configure();
        savedKey = 'fixture-parent-key';
        const query = new CustomUsageQuery();
        assert.equal((await query.queryBalance(child)).balance, 25);
        assert.equal((await query.queryBalance('review', undefined, 'team')).balance, 300);
        assert.deepEqual(requestProviderIds, [child, 'review']);
        assert.deepEqual(keyLookups, ['review']);
    });

    it('formats both base providers without redirecting the parent entry to the child', async () => {
        configure();
        const parent = await compatible.queryCompatibleProviderQuota('review', 'fixture-parent-key', 'fixture');
        const childQuota = await compatible.queryCompatibleProviderQuota(child, '', 'fixture');
        assert.equal(parent.quotaEntries?.[0].summary, '¥300.00');
        assert.equal(childQuota.quotaEntries?.[0].summary, '¥25.00');
        assert.deepEqual(requestProviderIds, ['review', child]);
    });

    it('keeps an anonymous parent entry independent of its bearer-authenticated child', async () => {
        configure('none', 'bearer');
        assert.equal(manager.requiresApiKey(child), true);
        assert.equal(manager.requiresApiKey(child, 'entry'), false);
        assert.equal((await manager.queryBalance(child, undefined, 'entry')).balance, 300);
        assert.equal((await manager.queryBalance(child, 'fixture-child-key')).balance, 25);
        assert.deepEqual(requestProviderIds, ['review', child]);
        assert.equal(requestHeaders[0].has('Authorization'), false);
        assert.equal(requestHeaders[1].get('Authorization'), 'Bearer fixture-child-key');
    });

    for (const usages of [undefined, { first: { url, fields }, second: { url, fields } }]) {
        it(`does not fall back to the parent when the child has ${usages ? 'multiple' : 'incomplete'} usages`, async () => {
            configure();
            overrides[child] = { usage: { authType: 'none' }, usages };
            savedKey = 'fixture-parent-key';
            assert.equal(manager.getBaseProviderId(child), child);
            assert.equal(manager.isCustomProviderWithUsage(child), false);
            await assert.rejects(manager.queryBalance(child), /No balance query handler/);
            assert.deepEqual(requestUrls, []);
            assert.deepEqual(keyLookups, []);
        });
    }

    for (const action of ['load', 'refresh'] as const) {
        it(
            `${action} queries an anonymous child even when the parent entry needs a key`,
            { timeout: 2_000 },
            async () => {
                configure();
                const { host, finished } = createHost();
                try {
                    if (action === 'load') {
                        await host.handleLoadProviderUsage(child, true);
                    } else {
                        await host.handleRefreshConfigUsage(child, 'fixture');
                    }
                    assert.equal((await finished).error, undefined);
                    assert.deepEqual(requestUrls, [`${url}/child`]);
                    assert.deepEqual(requestProviderIds, [child]);
                    assert.deepEqual(keyLookups, []);
                } finally {
                    host.dispose();
                }
            }
        );
    }
});

describe('empty usage keys', () => {
    for (const authType of ['none', 'bearer', 'url_key'] as const) {
        it(`keeps schema, registration and ${authType} queries consistent`, async () => {
            overrides = { review: { usages: { '': { url, fields, authType, unit: 'CNY' } } } };
            const Ajv = require('ajv') as new (options: { strict: boolean; validateFormats: boolean }) => {
                compile(schema: JSONSchema7): (value: unknown) => boolean;
            };
            assert.equal(
                new Ajv({ strict: false, validateFormats: false }).compile(JsonSchemaProvider.getSettingsSchema())({
                    'gcmp.providerOverrides': overrides
                }),
                true
            );
            assert.deepEqual(manager.getRegisteredProvidersForBaseProvider('review'), ['review::']);
            assert.equal(manager.getBaseProviderId('review::', 'entry'), 'review');
            assert.equal(manager.requiresApiKey('review'), authType !== 'none');
            assert.equal(manager.requiresApiKey('review::', 'entry'), authType !== 'none');
            const key = authType === 'none' ? '' : 'fixture-empty-key';
            const result = await compatible.queryCompatibleProviderQuota('review', key, 'fixture');
            assert.equal(result.quotaEntries?.[0].summary, '¥25.00');
            assert.deepEqual(requestProviderIds, ['review']);
            assert.deepEqual(keyLookups, []);
        });
    }

    it('queries an empty key alongside a named mode without losing either entry', async () => {
        overrides = {
            review: { usage: { authType: 'none' }, usages: { '': { url, fields }, wallet: { url, fields } } }
        };
        assert.deepEqual(manager.getRegisteredProvidersForBaseProvider('review'), ['review::', 'review::wallet']);
        const result = await compatible.queryCompatibleProviderQuota('review', '', 'fixture');
        assert.equal(result.quotaEntries?.length, 2);
        assert.deepEqual(requestProviderIds, ['review', 'review']);
    });

    for (const action of ['load', 'refresh'] as const) {
        it(`${action} queries an anonymous empty-key mode`, { timeout: 2_000 }, async () => {
            overrides = { review: { usages: { '': { url, fields, authType: 'none' } } } };
            const { host, finished } = createHost();
            try {
                if (action === 'load') {
                    await host.handleLoadProviderUsage('review', true);
                } else {
                    await host.handleRefreshConfigUsage('review', 'fixture');
                }
                assert.equal((await finished).error, undefined);
                assert.deepEqual(requestUrls, [url]);
                assert.deepEqual(requestProviderIds, ['review']);
            } finally {
                host.dispose();
            }
        });
    }
});

describe('blank balance response boundaries', () => {
    for (const blank of ['', '  ', '\t', '\r\n', '\u00a0']) {
        it(`falls back to paid plus granted for ${JSON.stringify(blank)}`, async () => {
            overrides = {
                review: {
                    usage: { url, authType: 'none', fields: { balance: 'balance', paid: 'paid', granted: 'granted' } }
                }
            };
            responseData = { balance: blank, paid: 30, granted: 20 };
            const result = await manager.queryBalance('review::default');
            assert.equal(result.balance, 50);
            assert.equal(result.paid, 30);
            assert.equal(result.granted, 20);
            assert.equal(result.items?.length, 1);
            assert.deepEqual(requestUrls, [url]);
        });

        it(`rejects ${JSON.stringify(blank)} when no fallback is available`, async () => {
            overrides = { review: { usage: { url, fields, authType: 'none' } } };
            responseData = { balance: blank };
            await assert.rejects(manager.queryBalance('review::default'), /Failed to extract balance/);
            assert.deepEqual(requestUrls, [url]);
        });
    }

    for (const zero of [0, '0', ' 0 ']) {
        it(`preserves the actual zero value ${JSON.stringify(zero)}`, async () => {
            overrides = {
                review: {
                    usage: { url, authType: 'none', fields: { balance: 'balance', paid: 'paid', granted: 'granted' } }
                }
            };
            responseData = { balance: zero, paid: 30, granted: 20 };
            assert.equal((await manager.queryBalance('review::default')).balance, 0);
            assert.deepEqual(requestUrls, [url]);
        });
    }

    it('skips blank array items while retaining valid zero and fallback items', async () => {
        overrides = {
            review: {
                usage: {
                    url,
                    authType: 'none',
                    fields: { arrayPath: 'items', balance: 'balance', paid: 'paid', granted: 'granted' }
                }
            }
        };
        responseData = {
            items: [{ balance: '' }, { balance: ' ', paid: 30, granted: 20 }, { balance: '0' }, { balance: '25' }]
        };
        const result = await manager.queryBalance('review::default');
        assert.deepEqual(
            result.items?.map(item => item.balance),
            [50, 0, 25]
        );
        assert.deepEqual(requestUrls, [url]);
    });

    it('honors treatMissingAsZero for blank computed operands', async () => {
        const query = new CustomUsageQuery();
        const data = { balance: '', paid: 30, granted: 20 };
        const computed = { operation: 'sum' as const, paths: ['balance', 5] };
        assert.deepEqual(query.resolveUsageItems(data, { url, fields: { balance: computed } }), []);
        assert.equal(
            query.resolveUsageItems(data, { url, fields: { balance: computed, paid: 'paid', granted: 'granted' } })[0]
                .balance,
            50
        );
        assert.equal(
            query.resolveUsageItems(data, { url, fields: { balance: { ...computed, treatMissingAsZero: true } } })[0]
                .balance,
            5
        );
        assert.equal(
            query.resolveUsageItems(
                { items: [{ balance: '' }, { balance: '25' }] },
                { url, fields: { balance: 'items[*].balance' } }
            )[0].balance,
            25
        );
    });
});

describe('anonymous usage queries in the configuration panel', () => {
    const cases: { name: string; override: ProviderOverride; requiresKey: boolean; requests: number }[] = [
        {
            name: 'single anonymous mode',
            override: { usage: { url, fields, authType: 'none' } },
            requiresKey: false,
            requests: 1
        },
        {
            name: 'shared anonymous authentication',
            override: { usage: { authType: 'none' }, usages: { wallet: { url, fields }, search: { url, fields } } },
            requiresKey: false,
            requests: 2
        },
        { name: 'default bearer authentication', override: { usage: { url, fields } }, requiresKey: true, requests: 0 },
        {
            name: 'URL key authentication',
            override: { usage: { url, fields, authType: 'url_key' } },
            requiresKey: true,
            requests: 0
        },
        {
            name: 'mixed authentication modes',
            override: {
                usage: { authType: 'none' },
                usages: { wallet: { url, fields }, search: { url, fields, authType: 'bearer' } }
            },
            requiresKey: true,
            requests: 0
        }
    ];
    for (const action of ['load', 'refresh'] as const) {
        for (const { name, override, requiresKey, requests } of cases) {
            it(`${action} handles ${name} without a saved key`, { timeout: 2_000 }, async () => {
                overrides = { review: override };
                const { host, finished } = createHost();
                try {
                    if (action === 'load') {
                        await host.handleLoadProviderUsage('review', true);
                    } else {
                        await host.handleRefreshConfigUsage('review', 'fixture');
                    }
                    const result = await finished;
                    assert.equal(requestUrls.length, requests);
                    if (requiresKey) {
                        assert.match(result.error ?? '', /API Key/);
                        assert.equal(queryCalls.length, 0);
                    } else {
                        assert.equal(result.error, undefined);
                        assert.equal(result.usageEntries?.length, requests);
                        assert.deepEqual(queryCalls, [{ slot: 'review', apiKey: '' }]);
                    }
                } finally {
                    host.dispose();
                }
            });
        }

        it(`${action} still requires a key for a dedicated quota slot`, { timeout: 2_000 }, async () => {
            const { host, finished } = createHost();
            try {
                if (action === 'load') {
                    await host.handleLoadProviderUsage('moonshot', true);
                } else {
                    await host.handleRefreshConfigUsage('moonshot', 'fixture');
                }
                assert.match((await finished).error ?? '', /API Key/);
                assert.equal(queryCalls.length, 0);
            } finally {
                host.dispose();
            }
        });
    }

    it('passes a saved configuration key through unchanged', { timeout: 2_000 }, async () => {
        overrides = { review: { usage: { url, fields } } };
        savedKey = 'fixture-saved-key';
        const { host, finished } = createHost();
        try {
            await host.handleRefreshConfigUsage('review', 'fixture');
            assert.equal((await finished).error, undefined);
            assert.deepEqual(queryCalls, [{ slot: 'review', apiKey: savedKey }]);
            assert.equal(requestUrls.length, 1);
        } finally {
            host.dispose();
        }
    });
});
