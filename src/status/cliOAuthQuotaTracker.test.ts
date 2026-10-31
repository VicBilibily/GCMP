import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    OAuthCredentialEntry,
    OAuthCredentialRoutingSettings,
    OAuthCredentialSelection
} from '../cli/auth/oauthCredentialStore';
import type { MultiKeySectionLabels } from './multiKeyQuotaTracker';
import {
    collectCliOAuthQuotaStatus,
    isCliOAuthQuotaEnabled,
    isCliOAuthQuotaStatusCurrent,
    renderCliOAuthQuotaSection,
    type CliOAuthQuotaSource
} from './cliOAuthQuotaTracker';

interface FakeQuota {
    remaining: number;
}

const labels: MultiKeySectionLabels = {
    nameColumn: 'NAME',
    usageColumn: 'USAGE',
    notConfigured: 'NO TOKEN',
    queryFailed: 'FAILED',
    staleResult: 'STALE'
};

function credential(name: string, options: Partial<OAuthCredentialEntry> = {}): OAuthCredentialEntry {
    return {
        name,
        fileName: `${name}.json`,
        filePath: `C:/oauth/${name}.json`,
        hasAccessToken: true,
        ...options
    };
}

function createSource(credentials: OAuthCredentialEntry[], activeName = 'a') {
    const routing: OAuthCredentialRoutingSettings = { mode: 'balance', weights: {}, generation: 3 };
    const selection: OAuthCredentialSelection = { name: activeName, generation: 5 };
    const source: CliOAuthQuotaSource = {
        getRoutingSettings: () => routing,
        listCredentials: () => credentials,
        getActiveSelection: () => selection
    };
    return { source, routing, selection, credentials };
}

test('CLI OAuth multi-quota is enabled only for balance mode with multiple accounts', () => {
    const fixture = createSource([credential('a'), credential('b')]);
    assert.equal(isCliOAuthQuotaEnabled(fixture.source), true);
    fixture.routing.mode = 'failover';
    assert.equal(isCliOAuthQuotaEnabled(fixture.source), false);
    fixture.routing.mode = 'balance';
    fixture.credentials.pop();
    assert.equal(isCliOAuthQuotaEnabled(fixture.source), false);
});

test('collects named account quotas, reuses active query and records missing or failed accounts', async () => {
    const fixture = createSource([
        credential('a', { label: 'Primary' }),
        credential('b'),
        credential('c', { hasAccessToken: false })
    ]);
    const queried: string[] = [];
    const status = await collectCliOAuthQuotaStatus(
        fixture.source,
        {
            async query(name) {
                queried.push(name);
                if (name === 'b') {
                    return { success: false, error: 'rejected' };
                }
                return { success: true, data: { remaining: 25 }, requestBalanceKeyHash: `hash-${name}` };
            },
            summary: data => `${data.remaining}%`
        },
        {
            credentialName: 'a',
            result: { success: true, data: { remaining: 80 }, requestBalanceKeyHash: 'hash-a' }
        }
    );

    assert.deepEqual(queried, ['b']);
    assert.deepEqual(
        status?.entries.map(entry => [entry.configId, entry.label, entry.isActive, entry.status]),
        [
            ['a', 'Primary', true, 'success'],
            ['b', 'b', false, 'error'],
            ['c', 'c', false, 'missing-key']
        ]
    );
    assert.equal(status?.entries[0].data?.remaining, 80);
    assert.equal(status?.entries[0].requestBalanceKeyHash, 'hash-a');
});

test('keeps collecting other accounts when the active account query failed', async () => {
    const fixture = createSource([credential('a'), credential('b')]);
    const queried: string[] = [];
    const status = await collectCliOAuthQuotaStatus(
        fixture.source,
        {
            async query(name) {
                queried.push(name);
                return { success: true, data: { remaining: 45 } };
            },
            summary: data => `${data.remaining}%`
        },
        {
            credentialName: 'a',
            result: { success: false, error: 'active account rejected' }
        }
    );

    assert.deepEqual(queried, ['b']);
    assert.deepEqual(
        status?.entries.map(entry => entry.status),
        ['error', 'success']
    );
});

test('discards collection when active selection or account list changes during queries', async t => {
    await t.test('active selection changes', async () => {
        const fixture = createSource([credential('a'), credential('b')]);
        const status = await collectCliOAuthQuotaStatus(fixture.source, {
            async query() {
                fixture.selection.name = 'b';
                fixture.selection.generation++;
                return { success: true, data: { remaining: 50 } };
            },
            summary: data => `${data.remaining}%`
        });
        assert.equal(status, undefined);
    });

    await t.test('account is added during query', async () => {
        const fixture = createSource([credential('a'), credential('b')]);
        const status = await collectCliOAuthQuotaStatus(fixture.source, {
            async query() {
                fixture.credentials.push(credential('c'));
                return { success: true, data: { remaining: 50 } };
            },
            summary: data => `${data.remaining}%`
        });
        assert.equal(status, undefined);
    });
});

test('cached quota snapshot is invalidated by routing or credential changes', async () => {
    const fixture = createSource([credential('a'), credential('b')]);
    const status = await collectCliOAuthQuotaStatus(fixture.source, {
        async query() {
            return { success: true, data: { remaining: 60 } };
        },
        summary: data => `${data.remaining}%`
    });
    assert.equal(isCliOAuthQuotaStatusCurrent(status, fixture.source), true);
    fixture.routing.generation++;
    assert.equal(isCliOAuthQuotaStatusCurrent(status, fixture.source), false);
});

test('cached quota snapshot is invalidated when a token changes at the same credential path and expiry', async () => {
    const fixture = createSource([
        credential('a', { expiryDate: 100, accessTokenHash: 'token-a' }),
        credential('b', { expiryDate: 200, accessTokenHash: 'token-b' })
    ]);
    const status = await collectCliOAuthQuotaStatus(fixture.source, {
        async query() {
            return { success: true, data: { remaining: 60 } };
        },
        summary: data => `${data.remaining}%`
    });

    fixture.credentials[0].accessTokenHash = 'replacement-token-a';
    assert.equal(isCliOAuthQuotaStatusCurrent(status, fixture.source), false);
});

test('marks a result stale when its credential expiry differs from the roster snapshot', async () => {
    const fixture = createSource([credential('a', { expiryDate: 100 }), credential('b')]);
    const status = await collectCliOAuthQuotaStatus(
        fixture.source,
        {
            async query() {
                return { success: true, data: { remaining: 40 }, credentialExpiryDate: 90 };
            },
            summary: data => `${data.remaining}%`
        },
        {
            credentialName: 'a',
            result: { success: true, data: { remaining: 80 }, credentialExpiryDate: 90 }
        }
    );
    assert.equal(status?.entries[0].status, 'stale');
    assert.equal(status?.entries[0].data, undefined);
});

test('marks a result stale when its token differs from the roster snapshot', async () => {
    const fixture = createSource([
        credential('a', { accessTokenHash: 'current-token-hash' }),
        credential('b', { accessTokenHash: 'other-token-hash' })
    ]);
    const status = await collectCliOAuthQuotaStatus(fixture.source, {
        async query() {
            return {
                success: true,
                data: { remaining: 40 },
                requestBalanceKeyHash: 'replaced-token-hash'
            };
        },
        summary: data => `${data.remaining}%`
    });

    assert.equal(status?.entries[0].status, 'stale');
    assert.equal(status?.entries[0].data, undefined);
});

test('renders active account emphasis and quota summaries using the shared multi-key table', async () => {
    const fixture = createSource([credential('a', { label: 'Work' }), credential('b')]);
    const query = {
        async query() {
            return { success: true, data: { remaining: 60 } };
        },
        summary: (data: FakeQuota) => `${data.remaining}%`
    };
    const status = await collectCliOAuthQuotaStatus(fixture.source, query);
    const rendered = renderCliOAuthQuotaSection(status, fixture.source, query, labels);
    assert.match(rendered, /\*\*Work\*\* \| \*\*60%\*\*/);
    assert.match(rendered, /\| b \| 60% \|/);
});
