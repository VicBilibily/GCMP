import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

test('CLI provider status requires a non-empty access token', async t => {
    interface CredentialsFixture {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
    }
    let credentials: CredentialsFixture | null = null;
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const source = readFileSync(new URL('./cliHost.ts', import.meta.url), 'utf8');
    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module,
            exports: module.exports,
            require: (id: string): unknown => {
                if (/cliAuthFactory(?:\.ts)?$/.test(id)) {
                    return {
                        CliAuthFactory: {
                            getSupportedCliTypes: () => [
                                { id: 'codex', name: 'Codex CLI' },
                                { id: 'grok', name: 'Grok CLI' }
                            ],
                            getInstance: () => ({ isCliInstalled: async () => true }),
                            loadCredentials: async () => credentials,
                            getCredentialSourceInfo: () => ({ source: 'cli' }),
                            listOAuthCredentials: () => [],
                            isCredentialExpired: () =>
                                Boolean(credentials?.expiry_date && credentials.expiry_date < Date.now())
                        }
                    };
                }
                if (/oauthCredentialStore(?:\.ts)?$/.test(id)) {
                    return {
                        OAuthCredentialStore: {
                            getRoutingSettings: () => ({ mode: 'off', weights: {} }),
                            getCredentialWeight: () => 1
                        }
                    };
                }
                if (/logger(?:\.ts)?$/.test(id)) {
                    return { Logger: { warn: () => undefined } };
                }
                if (/l10n(?:\.ts)?$/.test(id)) {
                    return { t: (english: string) => english };
                }
                throw new Error(`Unexpected dependency: ${id}`);
            }
        },
        { filename: 'cliHost.ts', timeout: 1000 }
    );
    const buildCliProviders = module.exports.buildCliProviders as typeof import('./cliHost').buildCliProviders;
    const cases: Array<{
        name: string;
        credentials: CredentialsFixture | null;
        isAuthenticated: boolean;
        status: RegExp;
    }> = [
        { name: 'no credential', credentials: null, isAuthenticated: false, status: /No credentials found/i },
        {
            name: 'missing access token',
            credentials: { expiry_date: 0 },
            isAuthenticated: false,
            status: /missing.*access token/i
        },
        {
            name: 'empty access token',
            credentials: { access_token: '', expiry_date: 0 },
            isAuthenticated: false,
            status: /missing.*access token/i
        },
        {
            name: 'blank access token',
            credentials: { access_token: ' \t ', expiry_date: 0 },
            isAuthenticated: false,
            status: /missing.*access token/i
        },
        {
            name: 'refresh token only',
            credentials: { refresh_token: 'refresh', expiry_date: 0 },
            isAuthenticated: false,
            status: /missing.*access token/i
        },
        {
            name: 'expired token',
            credentials: { access_token: 'expired', expiry_date: 1 },
            isAuthenticated: false,
            status: /expired/i
        },
        {
            name: 'token with no expiry',
            credentials: { access_token: 'valid', expiry_date: 0 },
            isAuthenticated: true,
            status: /^Valid$/
        },
        {
            name: 'unexpired token',
            credentials: { access_token: 'valid', expiry_date: Date.now() + 3_600_000 },
            isAuthenticated: true,
            status: /^Valid$/
        }
    ];

    for (const scenario of cases) {
        await t.test(scenario.name, async () => {
            credentials = scenario.credentials;
            const providers = await buildCliProviders();

            assert.equal(providers.length, 2);
            for (const provider of providers) {
                assert.equal(provider.loading, false);
                assert.equal(provider.isCliInstalled, true);
                assert.equal(provider.switchMode, 'off');
                assert.equal(provider.isAuthenticated, scenario.isAuthenticated, provider.provider);
                assert.match(provider.statusDetail ?? '', scenario.status, provider.provider);
            }
        });
    }
});
