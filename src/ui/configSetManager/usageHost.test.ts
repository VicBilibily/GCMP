import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

test('CLI usage refresh queries each named account independently', async () => {
    const queriedNames: Array<string | undefined> = [];
    const messages: Array<{
        command: string;
        provider?: string;
        credentialName?: string;
        usage?: {
            loading: boolean;
            summary?: string;
            error?: string;
            credentialAuthenticated?: boolean;
            authenticationRejected?: boolean;
        };
    }> = [];
    let credentialNames = ['work', 'personal'];
    let quotaError: string | undefined;
    const module: { exports: Record<string, unknown> } = { exports: {} };
    const source = readFileSync(new URL('./usageHost.ts', import.meta.url), 'utf8');
    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module,
            exports: module.exports,
            require: (id: string): unknown => {
                if (id === 'vscode') {
                    return { env: { language: 'en-US' } };
                }
                if (/cliAuthFactory(?:\.ts)?$/.test(id)) {
                    return { CliAuthFactory: { listOAuthCredentials: () => credentialNames.map(name => ({ name })) } };
                }
                if (/codexQuota(?:\.ts)?$/.test(id)) {
                    return {
                        queryCodexUsage: async (name?: string) => {
                            queriedNames.push(name);
                            if (quotaError) {
                                return {
                                    success: false,
                                    error: quotaError,
                                    authenticationRejected: quotaError === 'Authorization rejected'
                                };
                            }
                            return { success: true, data: { planType: 'plus', email: `${name}@example.com` } };
                        },
                        buildCodexUsageSummary: () => '80%',
                        buildCodexUsageTable: () => ({ columns: ['Window'], rows: [['Weekly', '80%']] })
                    };
                }
                if (/chatgptPlanType(?:\.ts)?$/.test(id)) {
                    return { formatChatGPTPlanType: (value: string) => value };
                }
                if (/grokQuota(?:\.ts)?$/.test(id)) {
                    return {
                        queryGrokUsage: async () => ({ success: false }),
                        buildGrokUsageSummary: () => '',
                        buildGrokUsageTable: () => ({ columns: [], rows: [] })
                    };
                }
                if (/providerQuota(?:\.ts)?$/.test(id)) {
                    return {
                        queryProviderQuota: async () => undefined,
                        isQuotaSupportedSlot: () => false,
                        getQuotaMetricType: () => 'usage',
                        getQuotaMetricLabel: () => 'Usage',
                        resolveQuotaSite: () => undefined,
                        formatQuotaLastUpdated: () => ''
                    };
                }
                if (/balanceQueryManager(?:\.ts)?$/.test(id)) {
                    return { BalanceQueryManager: { requiresApiKey: () => false } };
                }
                if (/configSetStore(?:\.ts)?$/.test(id)) {
                    return { ConfigSetStore: {} };
                }
                if (/configSetCommands(?:\.ts)?$/.test(id)) {
                    return { listSlots: () => [] };
                }
                if (/gistSyncService(?:\.ts)?$/.test(id)) {
                    return { getKeyDisplayName: (key: string) => key };
                }
                if (/l10n(?:\.ts)?$/.test(id)) {
                    return { t: (english: string) => english };
                }
                throw new Error(`Unexpected dependency: ${id}`);
            }
        },
        { filename: 'usageHost.ts', timeout: 1000 }
    );

    const UsageHost = module.exports.UsageHost as new (context: {
        post: (message: unknown) => void;
        isAlive: () => boolean;
    }) => { refreshCliUsage: (provider: string, credentialName?: string) => Promise<void> };
    assert.equal(typeof UsageHost, 'function');
    const host = new UsageHost({
        post: message => messages.push(message as (typeof messages)[number]),
        isAlive: () => true
    });

    await host.refreshCliUsage('codex');
    assert.deepEqual(queriedNames, ['work', 'personal']);
    const completed = messages.filter(message => message.command === 'cliUsage' && !message.usage?.loading);
    assert.deepEqual(
        completed.map(message => message.credentialName),
        ['work', 'personal']
    );
    assert.deepEqual(
        completed.map(message => message.usage?.summary),
        ['80%', '80%']
    );
    assert.deepEqual(
        completed.map(message => message.usage?.credentialAuthenticated),
        [true, true]
    );

    queriedNames.length = 0;
    messages.length = 0;
    await host.refreshCliUsage('codex', 'personal');
    assert.deepEqual(queriedNames, ['personal']);
    assert.deepEqual(
        messages.filter(message => message.command === 'cliUsage').map(message => message.credentialName),
        ['personal', 'personal']
    );

    queriedNames.length = 0;
    messages.length = 0;
    quotaError = 'Credential expired';
    await host.refreshCliUsage('codex', 'personal');
    const accountFailure = messages.find(
        message => message.command === 'cliUsage' && message.credentialName === 'personal' && !message.usage?.loading
    );
    assert.equal(accountFailure?.usage?.error, 'Credential expired');
    assert.equal(accountFailure?.usage?.credentialAuthenticated, undefined);
    assert.equal(accountFailure?.usage?.authenticationRejected, undefined);

    queriedNames.length = 0;
    messages.length = 0;
    quotaError = 'Authorization rejected';
    await host.refreshCliUsage('codex', 'personal');
    const rejectedAccount = messages.find(
        message => message.command === 'cliUsage' && message.credentialName === 'personal' && !message.usage?.loading
    );
    assert.equal(rejectedAccount?.usage?.authenticationRejected, true);

    queriedNames.length = 0;
    messages.length = 0;
    quotaError = 'network unavailable';
    await host.refreshCliUsage('codex', 'personal');
    const rejectedAccountAfterNetworkError = messages.find(
        message => message.command === 'cliUsage' && message.credentialName === 'personal' && !message.usage?.loading
    );
    assert.equal(rejectedAccountAfterNetworkError?.usage?.authenticationRejected, undefined);

    queriedNames.length = 0;
    messages.length = 0;
    quotaError = undefined;
    credentialNames = [];
    await host.refreshCliUsage('codex');
    assert.deepEqual(queriedNames, [undefined]);
    assert.deepEqual(
        messages.filter(message => message.command === 'cliUsage').map(message => message.credentialName),
        [undefined, undefined]
    );
});
