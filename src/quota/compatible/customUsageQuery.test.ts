import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { before } from 'node:test';

import type { CustomHeaders, ProviderOverride, ProviderUsageConfig } from '../../types/sharedTypes';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

let overrides: Record<string, ProviderOverride> = {};
let receivedHeaders = new Headers();
let receivedRequestUrl = '';
let receivedRequestInit: RequestInit = {};
let responseData: unknown = { balance: 25 };
let requestCount = 0;
let CustomUsageQuery: typeof import('./customUsageQuery').CustomUsageQuery;

before(async () => {
    const originalRequire = NodeModule.prototype.require;

    NodeModule.prototype.require = function (id: string): unknown {
        if (id.endsWith('/statusLogger')) {
            return { StatusLogger: { debug() {} } };
        }
        if (id.endsWith('/logger')) {
            return { Logger: { error() {} } };
        }
        if (id.endsWith('/apiKeyManager')) {
            return {
                ApiKeyManager: {
                    processCustomHeader: (headers: CustomHeaders, apiKey: string): CustomHeaders =>
                        Object.fromEntries(
                            Object.entries(headers).map(([key, value]) => [
                                key,
                                value === null ? null : value.replace(/\$\{\s*APIKEY\s*\}/gi, apiKey)
                            ])
                        )
                }
            };
        }
        if (id.endsWith('/knownProviders')) {
            return {
                resolveBuiltinProviderConfig: (providerId: string): ProviderOverride | undefined =>
                    providerId === 'review' ?
                        {
                            customHeader: {
                                'X-Inherited': 'builtin',
                                'X-Builtin': 'builtin'
                            }
                        }
                    :   undefined
            };
        }
        if (id.endsWith('/configManager')) {
            return {
                ConfigManager: {
                    getProviderOverrides: () => overrides,
                    fetchWithProxy: async (url: string, init: RequestInit) => {
                        requestCount++;
                        receivedRequestUrl = url;
                        receivedRequestInit = init;
                        receivedHeaders = new Headers(init.headers);
                        return new Response(JSON.stringify(responseData), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                }
            };
        }
        return originalRequire.call(this, id);
    };

    try {
        ({ CustomUsageQuery } = await import('./customUsageQuery'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
});

test('custom usage headers apply case-insensitive overrides and null deletions', async () => {
    for (const authType of ['bearer', 'none', 'url_key'] as const satisfies readonly NonNullable<
        ProviderUsageConfig['authType']
    >[]) {
        overrides = {
            compatible: {
                customHeader: {
                    'X-Inherited': 'compatible',
                    'X-Removed': 'compatible'
                }
            },
            review: {
                customHeader: {
                    'x-inherited': null,
                    'x-removed': null,
                    authorization: null
                },
                usage: {
                    url: 'https://example.test/balance',
                    authType,
                    headers: { 'x-builtin': 'usage' },
                    fields: { balance: 'balance' }
                }
            }
        };

        const result = await new CustomUsageQuery().queryBalance('review', 'review-key');

        assert.equal(result.balance, 25);
        assert.equal(receivedHeaders.has('x-inherited'), false);
        assert.equal(receivedHeaders.has('x-removed'), false);
        assert.equal(receivedHeaders.get('x-builtin'), 'usage');
        assert.equal(receivedHeaders.get('content-type'), 'application/json');
        assert.equal(receivedHeaders.get('authorization'), authType === 'bearer' ? 'Bearer review-key' : null);
    }
});

test('queryBalance inherits shared request defaults without shared url or fields', async () => {
    overrides = {
        review: {
            usage: {
                authType: 'none',
                method: 'POST',
                headers: { 'X-Shared': 'shared' },
                params: { region: 'global' },
                body: { account: 'shared' },
                successConditions: [{ path: 'code', equals: 0 }],
                errorMessagePath: 'message',
                unit: 'CNY'
            },
            usages: {
                wallet: {
                    url: 'https://example.test/wallet',
                    headers: { 'X-Mode': 'wallet' },
                    params: { plan: 'wallet' },
                    body: { mode: 'wallet' },
                    fields: { balance: 'balance', paid: 'paid', granted: 'granted' }
                }
            }
        }
    };
    responseData = { code: 0, balance: 50, paid: 30, granted: 20 };
    requestCount = 0;

    const result = await new CustomUsageQuery().queryBalance('review::wallet', 'review-key');

    assert.equal(requestCount, 1);
    assert.equal(receivedRequestUrl, 'https://example.test/wallet?region=global&plan=wallet');
    assert.equal(receivedRequestInit.method, 'POST');
    assert.equal(receivedRequestInit.body, JSON.stringify({ account: 'shared', mode: 'wallet' }));
    assert.equal(receivedHeaders.get('X-Shared'), 'shared');
    assert.equal(receivedHeaders.get('X-Mode'), 'wallet');
    assert.equal(receivedHeaders.has('Authorization'), false);
    assert.equal(result.balance, 50);
    assert.equal(result.currency, 'CNY');
    assert.equal(result.paid, 30);
    assert.equal(result.granted, 20);

    responseData = { code: 1, message: 'shared query rejected', balance: 50 };
    await assert.rejects(new CustomUsageQuery().queryBalance('review::wallet'), /shared query rejected/);
    assert.equal(requestCount, 2);
});

test('queryBalance does not request an incomplete shared usage or named mode', async () => {
    const cases: ProviderOverride['usages'][] = [
        undefined,
        {},
        { wallet: { fields: { balance: 'balance' } } },
        { wallet: { url: 'https://example.test/wallet' } }
    ];
    for (const usages of cases) {
        overrides = { review: { usage: { authType: 'none' }, usages } };
        requestCount = 0;
        const target = usages && 'wallet' in usages ? 'review::wallet' : 'review';

        await assert.rejects(new CustomUsageQuery().queryBalance(target), /No usage configuration found/);
        assert.equal(requestCount, 0);
    }
});

test('queryBalance uses the explicit default endpoint instead of the shared default', async () => {
    overrides = {
        review: {
            usage: {
                url: 'https://example.test/shared',
                authType: 'none',
                fields: { balance: 'balance' }
            },
            usages: { default: { url: 'https://example.test/wallet', fields: { balance: 'remaining' } } }
        }
    };
    responseData = { balance: 99, remaining: 25 };
    requestCount = 0;

    const result = await new CustomUsageQuery().queryBalance('review::default');

    assert.equal(requestCount, 1);
    assert.equal(receivedRequestUrl, 'https://example.test/wallet');
    assert.equal(result.balance, 25);
});

test('queryBalance parses multiple arrays in one HTTP response without additional requests', async () => {
    overrides = {
        review: {
            usage: {
                url: 'https://example.test/usage',
                authType: 'none',
                fields: [{ balance: 'items[].remain' }, { arrayPath: 'extras', balance: 'remain' }]
            }
        }
    };
    responseData = { items: [{ remain: 10 }, { remain: 20 }], extras: [{ remain: 30 }] };
    requestCount = 0;
    const result = await new CustomUsageQuery().queryBalance('review');
    assert.equal(requestCount, 1);
    assert.equal(result.balance, 10);
    assert.deepEqual(
        result.items?.map(item => item.balance),
        [10, 20, 30]
    );
});

test('resolveUsageItems supports multiple fields array with displayName path resolution and literal fallback', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        code: 0,
        data: {
            vip_title: '钻石会员',
            tokens: 150000,
            points: 88.5,
            cash: 20
        }
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        unit: 'USD',
        fields: [
            {
                displayName: 'data.vip_title',
                balance: 'data.tokens',
                unit: 'Tokens'
            },
            {
                displayName: '点数账户',
                balance: 'data.points',
                unit: 'Points'
            },
            {
                displayName: 'data.missing_key',
                balance: 'data.cash',
                unit: 'CNY'
            }
        ]
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 3);
    assert.deepStrictEqual(items[0], {
        displayName: '钻石会员',
        balance: 150000,
        currency: 'Tokens',
        paid: undefined,
        granted: undefined
    });
    assert.deepStrictEqual(items[1], {
        displayName: '点数账户',
        balance: 88.5,
        currency: 'Points',
        paid: undefined,
        granted: undefined
    });
    assert.deepStrictEqual(items[2], {
        displayName: 'data.missing_key',
        balance: 20,
        currency: 'CNY',
        paid: undefined,
        granted: undefined
    });
});

test('resolveUsageItems splits array into multiple quotas via arrayPath', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        limits: [
            { model: 'gpt-4o', remaining: 500, paid: 400, granted: 100 },
            { model: 'claude-3-5-sonnet', remaining: 200, paid: 200, granted: 0 }
        ]
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        unit: '次',
        fields: [
            {
                arrayPath: 'limits',
                displayName: 'model',
                balance: 'remaining',
                paid: 'paid',
                granted: 'granted'
            }
        ]
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 2);
    assert.deepStrictEqual(items[0], {
        displayName: 'gpt-4o',
        balance: 500,
        currency: '次',
        paid: 400,
        granted: 100
    });
    assert.deepStrictEqual(items[1], {
        displayName: 'claude-3-5-sonnet',
        balance: 200,
        currency: '次',
        paid: 200,
        granted: 0
    });
});

test('resolveUsageItems splits multiple arrays into multiple quotas', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        packages: [{ pkg_name: '月度基础包', left: 1000 }],
        extra_addons: [
            { name: '联网搜索包', count: 50 },
            { name: '代码解释器包', count: 20 }
        ]
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        fields: [
            {
                arrayPath: 'packages',
                displayName: 'pkg_name',
                balance: 'left',
                unit: 'Tokens'
            },
            {
                arrayPath: 'extra_addons',
                displayName: 'name',
                balance: 'count',
                unit: '次'
            }
        ]
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 3);
    assert.equal(items[0].displayName, '月度基础包');
    assert.equal(items[0].balance, 1000);
    assert.equal(items[0].currency, 'Tokens');

    assert.equal(items[1].displayName, '联网搜索包');
    assert.equal(items[1].balance, 50);
    assert.equal(items[1].currency, '次');

    assert.equal(items[2].displayName, '代码解释器包');
    assert.equal(items[2].balance, 20);
    assert.equal(items[2].currency, '次');
});

test('resolveUsageItems splits [] in balance and displayName', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        models: [
            { id: 'm1', quota: 10 },
            { id: 'm2', quota: 20 }
        ]
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        unit: 'USD',
        fields: {
            displayName: 'models[].id',
            balance: 'models[].quota'
        }
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 2);
    assert.equal(items[0].displayName, 'm1');
    assert.equal(items[0].balance, 10);
    assert.equal(items[1].displayName, 'm2');
    assert.equal(items[1].balance, 20);
});

test('resolveUsageItems handles root array automatically', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = [
        { title: 'Free Tier', remain: 5 },
        { title: 'Pro Tier', remain: 50 }
    ];

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        unit: '次',
        fields: {
            displayName: 'title',
            balance: 'remain'
        }
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 2);
    assert.equal(items[0].displayName, 'Free Tier');
    assert.equal(items[0].balance, 5);
    assert.equal(items[1].displayName, 'Pro Tier');
    assert.equal(items[1].balance, 50);
});

test('resolveUsageItems automatically detects array in balance path without arrayPath configuration', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        data: {
            items: [
                { model: 'model-a', remain: 100 },
                { model: 'model-b', remain: 200 }
            ]
        }
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        unit: 'USD',
        fields: {
            displayName: 'data.items.model',
            balance: 'data.items.remain'
        }
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 2);
    assert.equal(items[0].displayName, 'model-a');
    assert.equal(items[0].balance, 100);
    assert.equal(items[1].displayName, 'model-b');
    assert.equal(items[1].balance, 200);
});

test('resolveUsageItems automatically splits multiple arrays via path traversal without arrayPath', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const query = new CustomUsageQuery();

    const data = {
        monthly_plans: [{ name: '月卡', left: 10 }],
        extra_addons: [
            { name: '流量包', left: 100 },
            { name: '算力包', left: 200 }
        ]
    };

    const usageConfig: ProviderUsageConfig = {
        url: 'https://api.example.com/usage',
        fields: [
            {
                displayName: 'name',
                balance: 'monthly_plans.left',
                unit: '次'
            },
            {
                displayName: 'name',
                balance: 'extra_addons.left',
                unit: 'MB'
            }
        ]
    };

    const items = query.resolveUsageItems(data, usageConfig);
    assert.equal(items.length, 3);
    assert.equal(items[0].displayName, '月卡');
    assert.equal(items[0].balance, 10);
    assert.equal(items[0].currency, '次');

    assert.equal(items[1].displayName, '流量包');
    assert.equal(items[1].balance, 100);
    assert.equal(items[1].currency, 'MB');

    assert.equal(items[2].displayName, '算力包');
    assert.equal(items[2].balance, 200);
    assert.equal(items[2].currency, 'MB');
});

const indexedData = { data: { items: [{ remain: 10 }, { remain: 20 }] } };
const nestedData = {
    groups: [
        {
            limits: [
                { name: 'A', remain: 10 },
                { name: 'B', remain: 20 }
            ]
        },
        { limits: [{ name: 'C', remain: 30 }] }
    ]
};

const pathCases: Array<{
    name: string;
    data: unknown;
    fields: ProviderUsageConfig['fields'];
    balances: number[];
    names?: string[];
}> = [
    { name: 'numeric bracket index', data: indexedData, fields: { balance: 'data.items[0].remain' }, balances: [10] },
    { name: 'numeric dot index', data: indexedData, fields: { balance: 'data.items.1.remain' }, balances: [20] },
    { name: 'root index', data: indexedData.data.items, fields: { balance: '[0].remain' }, balances: [10] },
    { name: 'out-of-range index', data: indexedData, fields: { balance: 'data.items[2].remain' }, balances: [] },
    { name: 'wildcard sum', data: indexedData, fields: { balance: 'data.items[*].remain' }, balances: [30] },
    { name: 'root wildcard sum', data: indexedData.data.items, fields: { balance: '[*].remain' }, balances: [30] },
    { name: 'empty wildcard sum', data: { items: [] }, fields: { balance: 'items[*].remain' }, balances: [0] },
    {
        name: 'computed wildcard sum',
        data: indexedData,
        fields: { balance: { operation: 'multiply', paths: ['data.items[*].remain', 2] } },
        balances: [60]
    },
    {
        name: 'nested implicit arrays',
        data: nestedData,
        fields: { balance: 'groups.limits.remain', displayName: 'groups.limits.name' },
        balances: [10, 20, 30],
        names: ['A', 'B', 'C']
    },
    {
        name: 'nested explicit arrays',
        data: nestedData,
        fields: { balance: 'groups[].limits[].remain', displayName: 'groups[].limits[].name' },
        balances: [10, 20, 30],
        names: ['A', 'B', 'C']
    },
    {
        name: 'nested arrays below arrayPath',
        data: nestedData,
        fields: { arrayPath: 'groups', balance: 'limits.remain', displayName: 'limits.name' },
        balances: [10, 20, 30],
        names: ['A', 'B', 'C']
    },
    {
        name: 'nested arrayPath',
        data: nestedData,
        fields: { arrayPath: 'groups.limits', balance: 'remain', displayName: 'name' },
        balances: [10, 20, 30],
        names: ['A', 'B', 'C']
    },
    {
        name: 'nested indexed array',
        data: nestedData,
        fields: { balance: 'groups[0].limits.remain' },
        balances: [10, 20]
    },
    {
        name: 'index inside split array',
        data: nestedData,
        fields: { balance: 'groups[].limits[0].remain' },
        balances: [10, 30]
    },
    {
        name: 'sum inside split array',
        data: nestedData,
        fields: { balance: 'groups[].limits[*].remain' },
        balances: [30, 30]
    },
    {
        name: 'numeric array with configured computation',
        data: { values: [10, 20] },
        fields: { arrayPath: 'values', balance: { operation: 'multiply', paths: [2, 3] } },
        balances: [6, 6]
    },
    {
        name: 'numeric array self value',
        data: { values: [10, 20] },
        fields: { balance: 'values[]' },
        balances: [10, 20]
    },
    { name: 'empty split array', data: { values: [] }, fields: { balance: 'values[].remain' }, balances: [] }
];

for (const { name, data, fields, balances, names } of pathCases) {
    test(`resolveUsageItems preserves ${name}`, async () => {
        const { CustomUsageQuery } = await import('./customUsageQuery');
        const items = new CustomUsageQuery().resolveUsageItems(data, { url: 'https://example.test/usage', fields });
        assert.deepEqual(
            items.map(item => item.balance),
            balances
        );
        if (names) {
            assert.deepEqual(
                items.map(item => item.displayName),
                names
            );
        }
    });
}

test('split fields resolve nested calculations per operand, including root values', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const data = {
        scale: 2,
        items: [
            { remain: 10, paidA: 6, paidB: 4, grants: [{ value: 3 }] },
            { remain: 20, paidA: 12, paidB: 8, grants: [{ value: 5 }, { value: 1 }] }
        ]
    };
    const items = new CustomUsageQuery().resolveUsageItems(data, {
        url: 'https://example.test/usage',
        fields: {
            balance: 'items[].remain',
            paid: {
                operation: 'multiply',
                paths: [{ operation: 'sum', paths: ['items[].paidA', 'items[].paidB'] }, 'scale']
            },
            granted: { operation: 'sum', paths: ['items[].grants[*].value'] }
        }
    });
    assert.deepEqual(
        items.map(item => item.paid),
        [20, 40]
    );
    assert.deepEqual(
        items.map(item => item.granted),
        [3, 6]
    );
});

test('computed balance automatically splits its operand array', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const items = new CustomUsageQuery().resolveUsageItems(
        {
            items: [
                { total: 100, used: 10 },
                { total: 200, used: 50 }
            ]
        },
        {
            url: 'https://example.test/usage',
            fields: { balance: { operation: 'subtract', paths: ['items.total', 'items.used'] } }
        }
    );
    assert.deepEqual(
        items.map(item => item.balance),
        [90, 150]
    );
});

test('missing displayName preserves the complete original pattern and whitespace', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const displayName = '  groups[].limits[].missing  ';
    const items = new CustomUsageQuery().resolveUsageItems(nestedData, {
        url: 'https://example.test/usage',
        fields: { balance: 'groups[].limits[].remain', displayName }
    });
    assert.deepEqual(
        items.map(item => item.displayName),
        [displayName, displayName, displayName]
    );
});

test('split displayName can resolve a root value', async () => {
    const { CustomUsageQuery } = await import('./customUsageQuery');
    const items = new CustomUsageQuery().resolveUsageItems(
        { title: 'Shared', items: [{ remain: 10 }, { remain: 20 }] },
        { url: 'https://example.test/usage', fields: { balance: 'items[].remain', displayName: 'title' } }
    );
    assert.deepEqual(
        items.map(item => item.displayName),
        ['Shared', 'Shared']
    );
});

const arrayTargetCases: Array<{
    name: string;
    data: unknown;
    fields: ProviderUsageConfig['fields'];
    balances: number[];
}> = [
    {
        name: 'missing target',
        data: { balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'object target',
        data: { packages: { balance: 77 }, balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'null target',
        data: { packages: null, balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'number target',
        data: { packages: 77, balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'string target',
        data: { packages: 'plan', balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'indexed object target',
        data: { packages: [{ balance: 77 }], balance: 99 },
        fields: { arrayPath: 'packages[0]', balance: 'balance' },
        balances: []
    },
    {
        name: 'out-of-range target',
        data: { packages: [{ balance: 77 }], balance: 99 },
        fields: { arrayPath: 'packages[1]', balance: 'balance' },
        balances: []
    },
    {
        name: 'invalid target with constant computation',
        data: { balance: 99 },
        fields: { arrayPath: 'packages', balance: { operation: 'multiply', paths: [2, 3] } },
        balances: []
    },
    {
        name: 'invalid target with paid and granted fallback',
        data: { paid: 40, granted: 10 },
        fields: { arrayPath: 'packages', balance: 'missing', paid: 'paid', granted: 'granted' },
        balances: []
    },
    {
        name: 'nested target with missing and non-array branches',
        data: {
            balance: 99,
            groups: [{ balance: 88 }, { limits: { balance: 77 } }, { limits: [{ balance: 10 }, { balance: 20 }] }]
        },
        fields: { arrayPath: 'groups.limits', balance: 'balance' },
        balances: [10, 20]
    },
    {
        name: 'nested explicit target with missing and non-array branches',
        data: {
            balance: 99,
            groups: [{ balance: 88 }, { limits: { balance: 77 } }, { limits: [{ balance: 10 }, { balance: 20 }] }]
        },
        fields: { arrayPath: 'groups[].limits[]', balance: 'balance' },
        balances: [10, 20]
    },
    {
        name: 'empty target',
        data: { packages: [], balance: 99 },
        fields: { arrayPath: 'packages', balance: 'balance' },
        balances: []
    },
    {
        name: 'nested explicit array target',
        data: nestedData,
        fields: { arrayPath: 'groups[].limits[]', balance: 'remain' },
        balances: [10, 20, 30]
    },
    {
        name: 'array below an explicit index',
        data: nestedData,
        fields: { arrayPath: 'groups[1].limits', balance: 'remain' },
        balances: [30]
    },
    {
        name: 'root computation after a valid array target',
        data: { scale: 2, packages: [{ remain: 10 }, { remain: 20 }] },
        fields: { arrayPath: 'packages', balance: { operation: 'multiply', paths: ['remain', 'scale'] } },
        balances: [20, 40]
    },
    ...['', '.', '$', '@'].flatMap(arrayPath => [
        {
            name: `valid root alias ${JSON.stringify(arrayPath)}`,
            data: indexedData.data.items,
            fields: { arrayPath, balance: 'remain' },
            balances: [10, 20]
        },
        {
            name: `invalid root alias ${JSON.stringify(arrayPath)}`,
            data: { remain: 99 },
            fields: { arrayPath, balance: 'remain' },
            balances: []
        }
    ])
];

for (const { name, data, fields, balances } of arrayTargetCases) {
    test(`explicit arrayPath validates ${name}`, () => {
        const items = new CustomUsageQuery().resolveUsageItems(data, { url: 'https://example.test/usage', fields });
        assert.deepEqual(
            items.map(item => item.balance),
            balances
        );
    });
}

test('queryBalance rejects an invalid explicit array target without accepting root balance', async () => {
    overrides = {
        review: {
            usage: {
                url: 'https://example.test/usage',
                authType: 'none',
                fields: { arrayPath: 'packages', balance: 'balance' }
            }
        }
    };
    responseData = { balance: 99 };
    requestCount = 0;
    await assert.rejects(new CustomUsageQuery().queryBalance('review'), /Failed to extract balance/);
    assert.equal(requestCount, 1);
});

test('queryBalance skips invalid array fields and preserves other quotas from the same response', async () => {
    overrides = {
        review: {
            usage: {
                url: 'https://example.test/usage',
                authType: 'none',
                fields: [
                    { arrayPath: 'packages', balance: 'balance' },
                    { displayName: '现金钱包', balance: 'balance', unit: 'CNY' }
                ]
            }
        }
    };
    responseData = { balance: 99 };
    requestCount = 0;
    const result = await new CustomUsageQuery().queryBalance('review');
    assert.deepEqual(result.items, [
        { displayName: '现金钱包', balance: 99, currency: 'CNY', paid: undefined, granted: undefined }
    ]);
    assert.equal(requestCount, 1);
});

for (const metadataKey of ['name', 'model', 'title', 'id', 'type', 'plan']) {
    test(`queryBalance preserves unnamed scalar results with root ${metadataKey}`, async () => {
        overrides = {
            review: {
                usage: {
                    url: 'https://example.test/usage',
                    authType: 'none',
                    fields: { balance: 'balance', paid: 'paid', granted: 'granted' }
                }
            }
        };
        responseData = { balance: 50, paid: 30, granted: 20, [metadataKey]: 'response metadata' };
        requestCount = 0;
        const result = await new CustomUsageQuery().queryBalance('review');
        assert.deepEqual(result, {
            balance: 50,
            currency: 'USD',
            paid: 30,
            granted: 20,
            items: [{ displayName: undefined, balance: 50, currency: 'USD', paid: 30, granted: 20 }]
        });
        assert.equal(requestCount, 1);
    });
}

const constantUsageFields: ProviderUsageConfig['fields'][] = [
    { balance: { operation: 'sum', paths: [100] } },
    { balance: { operation: 'subtract', paths: [150, { operation: 'multiply', paths: [5, 10] }] } }
];
const constantResponseCases: Array<{ name: string; data: unknown }> = [
    { name: 'empty array', data: [] },
    { name: 'single-item array', data: [{ name: 'A' }] },
    { name: 'multiple-item array', data: [{ name: 'A' }, { name: 'B' }] }
];

for (const [calculation, fields] of constantUsageFields.entries()) {
    for (const { name, data } of constantResponseCases) {
        test(`queryBalance keeps constant calculation ${calculation + 1} scalar for a ${name}`, async () => {
            overrides = {
                review: { usage: { url: 'https://example.test/usage', authType: 'none', fields } }
            };
            responseData = data;
            requestCount = 0;
            const result = await new CustomUsageQuery().queryBalance('review');
            assert.equal(result.balance, 100);
            assert.deepEqual(result.items, [
                { displayName: undefined, balance: 100, currency: 'USD', paid: undefined, granted: undefined }
            ]);
            assert.equal(requestCount, 1);
        });
    }
}

for (const [displayName, expected] of [
    ['name', 'response metadata'],
    ['固定名称', '固定名称']
]) {
    test(`resolveUsageItems preserves explicit scalar displayName ${displayName}`, () => {
        const items = new CustomUsageQuery().resolveUsageItems(
            { name: 'response metadata', balance: 50 },
            { url: 'https://example.test/usage', fields: { balance: 'balance', displayName } }
        );
        assert.equal(items[0].displayName, expected);
        assert.equal(items[0].balance, 50);
    });
}

for (const arrayPath of ['', '.', '$', '@']) {
    test(`resolveUsageItems preserves explicit root constant selection ${JSON.stringify(arrayPath)}`, () => {
        const usageConfig: ProviderUsageConfig = {
            url: 'https://example.test/usage',
            fields: { arrayPath, balance: { operation: 'sum', paths: [100] } }
        };
        const query = new CustomUsageQuery();
        const items = query.resolveUsageItems([{ name: 'A' }, { name: 'B' }], usageConfig);
        assert.deepEqual(
            items.map(item => [item.displayName, item.balance]),
            [
                ['A', 100],
                ['B', 100]
            ]
        );
        assert.deepEqual(query.resolveUsageItems([], usageConfig), []);
    });
}

test('resolveUsageItems preserves explicit constant field entries for an empty response array', () => {
    const items = new CustomUsageQuery().resolveUsageItems([], {
        url: 'https://example.test/usage',
        fields: [
            { displayName: '钱包', balance: { operation: 'sum', paths: [100] }, unit: 'CNY' },
            { displayName: '套餐', balance: { operation: 'sum', paths: [25] }, unit: '次' }
        ]
    });
    assert.deepEqual(
        items.map(item => [item.displayName, item.balance, item.currency]),
        [
            ['钱包', 100, 'CNY'],
            ['套餐', 25, '次']
        ]
    );
});
