import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

function loadQuotaModule(fileName: string, dependencies: Record<string, unknown>): Record<string, unknown> {
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const source = readFileSync(new URL(fileName, import.meta.url), 'utf8');
    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module,
            exports: module.exports,
            process,
            Buffer,
            URL,
            URLSearchParams,
            AbortController,
            setTimeout,
            clearTimeout,
            require: (id: string): unknown => {
                const dependency = Object.entries(dependencies).find(([pattern]) => new RegExp(pattern).test(id));
                if (!dependency) {
                    throw new Error(`Unexpected dependency: ${id}`);
                }
                return dependency[1];
            }
        },
        { filename: fileName, timeout: 1000 }
    );
    return module.exports;
}

test('Codex usage marks plain-text 401/403 as authorization rejection only', async t => {
    let responseStatus = 401;
    const codexUsage = loadQuotaModule('codexQuota.ts', {
        'providers/config': { configProviders: { codex: {} } },
        'runtime/statusLogger': { StatusLogger: { debug: () => undefined } },
        'runtime/logger': { Logger: { error: () => undefined, warn: () => undefined } },
        cliUserAgent: { getCodexTuiUserAgentFromHeader: () => 'fixture-agent' },
        httpHeaders: { ensureUserAgentHeader: () => ({ 'User-Agent': 'fixture-agent' }) },
        metadataResolver: { withCodexCliMetadata: (config: unknown) => config },
        cliAuthFactory: {
            CliAuthFactory: {
                getInstance: () => ({}),
                ensureAuthenticated: async () => ({ access_token: 'token', account_id: 'account' })
            }
        },
        codexCliAuth: { CodexCliAuth: class {} },
        l10n: { t: (english: string) => english },
        types: { isCliAuthorizationRejectedStatus: (status: number) => status === 401 || status === 403 },
        configManager: {
            ConfigManager: {
                applyProviderOverrides: () => ({ customHeader: {} }),
                fetchWithProxy: async () => ({
                    ok: false,
                    status: responseStatus,
                    text: async () => 'Unauthorized'
                })
            }
        },
        format: {
            formatCompactCountdown: () => '',
            formatLocaleDateTime: () => '',
            formatQuotaDateForSlot: () => ''
        },
        requestBalance: { hashRequestApiKey: () => 'hash' }
    });
    const queryCodexUsage = codexUsage.queryCodexUsage as () => Promise<{
        authenticationRejected?: boolean;
        error?: string;
    }>;

    for (const status of [401, 403, 500]) {
        await t.test(`HTTP ${status}`, async () => {
            responseStatus = status;
            const result = await queryCodexUsage();
            assert.equal(Boolean(result.authenticationRejected), status === 401 || status === 403);
            assert.match(result.error ?? '', /Query failed/);
        });
    }
});

test('Grok usage marks 401/403 as authorization rejection but not rate limits', async t => {
    let responseStatus = 403;
    const grokUsage = loadQuotaModule('grokQuota.ts', {
        configManager: {
            ConfigManager: {
                fetchWithProxy: async () => ({
                    ok: false,
                    status: responseStatus,
                    statusText: 'fixture',
                    text: async () => 'rejected'
                })
            }
        },
        'runtime/logger': { Logger: { error: () => undefined } },
        'runtime/statusLogger': { StatusLogger: { debug: () => undefined } },
        cliAuthFactory: {
            CliAuthFactory: { ensureAuthenticated: async () => ({ access_token: 'token' }) }
        },
        l10n: { t: (english: string) => english },
        types: { isCliAuthorizationRejectedStatus: (status: number) => status === 401 || status === 403 },
        grokUsageParser: {
            parseGrokBillingUsage: () => ({ kind: 'unavailable' }),
            resolveGrokBillingBaseUrl: () => 'https://example.test'
        },
        format: { formatCompactCountdown: () => '', formatQuotaDateForSlot: () => '' },
        requestBalance: { hashRequestApiKey: () => 'hash' }
    });
    const queryGrokUsage = grokUsage.queryGrokUsage as (lastUpdated: string) => Promise<{
        authenticationRejected?: boolean;
        error?: string;
    }>;

    for (const status of [401, 403, 429]) {
        await t.test(`HTTP ${status}`, async () => {
            responseStatus = status;
            const result = await queryGrokUsage('now');
            assert.equal(Boolean(result.authenticationRejected), status === 401 || status === 403);
            assert.ok(result.error);
        });
    }
});
