import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import type { CustomHeaders, ProviderOverride, ProviderUsageConfig } from '../../types/sharedTypes';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

test('custom usage headers apply case-insensitive overrides and null deletions', async () => {
    const originalRequire = NodeModule.prototype.require;
    let overrides: Record<string, ProviderOverride> = {};
    let receivedHeaders = new Headers();

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
                    fetchWithProxy: async (_url: string, init: RequestInit) => {
                        receivedHeaders = new Headers(init.headers);
                        return new Response('{"balance":25}', {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                }
            };
        }
        return originalRequire.call(this, id);
    };

    let CustomUsageQuery: typeof import('./customUsageQuery').CustomUsageQuery;
    try {
        ({ CustomUsageQuery } = await import('./customUsageQuery'));
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

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
