import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { BalanceAffinityCache } from '../../utils/config/failover/balanceAffinityCache';
import {
    isOAuthAccountFailure,
    OAuthCredentialRouter,
    type OAuthCredentialRouterDependencies
} from './oauthCredentialRouter';
import { getMarkerBalanceCredential } from '../../handlers/stateful/statefulMarkerRecovery';
import type {
    OAuthCredentialEntry,
    OAuthCredentialRoutingSettings,
    OAuthCredentialSelection
} from './oauthCredentialStore';

interface TestAccount extends OAuthCredentialEntry {
    token: string | null;
}

function createFixture(mode: OAuthCredentialRoutingSettings['mode'], accounts: TestAccount[]) {
    const settings: OAuthCredentialRoutingSettings = { mode, weights: {}, generation: 0 };
    const selection: OAuthCredentialSelection = { name: accounts[0]?.name, generation: 1 };
    const synced: string[] = [];
    const store = {
        getRoutingSettings: () => ({ ...settings, weights: { ...settings.weights } }),
        getCredentialWeight: (_provider: string, name: string) =>
            Object.hasOwn(settings.weights, name) ? (settings.weights[name] ?? 1) : 1,
        getActiveCredentialSelection: () => ({ ...selection }),
        listCredentials: () => accounts,
        setActiveCredentialIfCurrent: async (_provider: string, expected: OAuthCredentialSelection, name: string) => {
            if (selection.name !== expected.name || selection.generation !== expected.generation) {
                return undefined;
            }
            selection.name = name;
            selection.generation++;
            return { ...selection };
        }
    };
    const router = new OAuthCredentialRouter({
        store: store as unknown as OAuthCredentialRouterDependencies['store'],
        authenticator: {
            ensureAuthenticatedForOAuthCredential: async (_provider, name) => {
                const account = accounts.find(candidate => candidate.name === name);
                return account?.token ? { access_token: account.token } : null;
            }
        },
        apiKeySync: {
            setApiKeyForActiveCliCredential: async (_provider, current, key) => {
                if (selection.name !== current.name || selection.generation !== current.generation) {
                    return false;
                }
                synced.push(key);
                return true;
            }
        },
        balanceAffinity: BalanceAffinityCache.instance
    });
    return { router, selection, settings, synced };
}

function account(name: string, token: string | null = `token-${name}`): TestAccount {
    return {
        name,
        fileName: `codex-${name}.json`,
        filePath: `C:/oauth/codex-${name}.json`,
        hasAccessToken: true,
        token
    };
}

test('OAuth account failure classifier only accepts account rejection or explicit quota exhaustion', () => {
    assert.equal(isOAuthAccountFailure({ status: 401 }), true);
    assert.equal(isOAuthAccountFailure({ response: { status: 403 } }), true);
    assert.equal(isOAuthAccountFailure({ error: { code: 'usage_limit_reached' } }), true);
    assert.equal(isOAuthAccountFailure({ message: 'weekly quota exhausted' }), true);
    assert.equal(isOAuthAccountFailure({ status: 429, message: 'too many requests' }), false);
    assert.equal(isOAuthAccountFailure({ status: 500 }), false);
    assert.equal(isOAuthAccountFailure(new Error('network disconnected')), false);
});

test('balance mode uses weighted stable session affinity', async () => {
    const accounts = [account('a'), account('b')];
    const fixture = createFixture('balance', accounts);
    fixture.settings.weights.b = 3;
    fixture.router.clearBalanceAffinity('codex');

    const first = await fixture.router.captureAttempt('codex', 'session-one');
    const repeat = await fixture.router.captureAttempt('codex', 'session-one');
    assert.equal(repeat?.credentialName, first?.credentialName);

    let weightedAccountCount = 0;
    for (let index = 0; index < 100; index++) {
        const attempt = await fixture.router.captureAttempt('codex', `session-${index}`);
        if (attempt?.credentialName === 'b') {
            weightedAccountCount++;
        }
    }
    assert.ok(weightedAccountCount > 60 && weightedAccountCount < 90, `weighted count: ${weightedAccountCount}`);
});

test('balance mode honors zero weight for prototype-named manual credentials', async () => {
    const fixture = createFixture('balance', [account('__proto__'), account('manual account')]);
    Object.defineProperty(fixture.settings.weights, '__proto__', {
        value: 0,
        enumerable: true,
        configurable: true,
        writable: true
    });
    fixture.router.clearBalanceAffinity('codex');

    const attempt = await fixture.router.captureAttempt('codex', 'manual-name-session');

    assert.equal(attempt?.credentialName, 'manual account');
    fixture.router.clearBalanceAffinity('codex');
});

test('balance mode ignores cached affinity from an older routing generation', async () => {
    const provider = 'codex';
    const balanceKey = 'settings-changed-session';
    const fixture = createFixture('balance', [account('a'), account('b')]);
    const weights = { a: 1, b: 7 };
    const digest = createHash('sha256').update(`${provider}\u0000${balanceKey}`).digest();
    const expectedName = digest.readUInt32BE(0) % 8 < weights.a ? 'a' : 'b';
    const staleName = expectedName === 'a' ? 'b' : 'a';
    const staleIdentity = createHash('sha256')
        .update(`oauth-credential\u0000${provider}\u0000${staleName}`)
        .digest('hex');

    fixture.router.clearBalanceAffinity(provider);
    BalanceAffinityCache.instance.remember(provider, balanceKey, staleIdentity, fixture.settings.generation);
    fixture.settings.weights = weights;
    fixture.settings.generation += 1;

    const attempt = await fixture.router.captureAttempt(provider, balanceKey);
    assert.equal(attempt?.credentialName, expectedName);
    fixture.router.clearBalanceAffinity(provider);
});

test('enabled routing with no usable OAuth accounts falls back to the default credential path', async () => {
    const fixture = createFixture('balance', []);
    const insufficientFailover = createFixture('failover', [account('only')]);

    assert.equal(await fixture.router.captureAttempt('codex', 'session-without-oauth'), undefined);
    assert.equal(await insufficientFailover.router.captureAttempt('codex', 'session-with-one-account'), undefined);
});

test('failover skips unusable accounts and switches active only after authentication succeeds', async () => {
    const fixture = createFixture('failover', [account('a'), account('b', null), account('c')]);
    const attempt = await fixture.router.captureAttempt('codex', 'session-one');
    assert.equal(attempt?.credentialName, 'a');
    const attempted = new Set([attempt!.identity]);

    const decision = await fixture.router.handleFailure('codex', attempt!, { status: 401 }, attempted, 'session-one');
    assert.deepEqual(decision, { handled: true, shouldRetry: true });
    assert.equal(fixture.selection.name, 'c');
    assert.deepEqual(fixture.synced, ['token-a', 'token-c']);
});

test('failover recaptures the latest active account after a concurrent change during authentication', async () => {
    const fixture = createFixture('failover', [account('a', null), account('b'), account('c')]);
    const dependencies = (fixture.router as unknown as { dependencies: OAuthCredentialRouterDependencies })
        .dependencies;
    dependencies.authenticator.ensureAuthenticatedForOAuthCredential = async (_provider, name) => {
        if (name === 'a') {
            return null;
        }
        if (name === 'b') {
            fixture.selection.name = 'c';
            fixture.selection.generation++;
        }
        return { access_token: `token-${name}` };
    };

    const attempt = await fixture.router.captureAttempt('codex', 'session-one');

    assert.ok(attempt);
    assert.equal(attempt.credentialName, 'c');
    assert.equal(attempt.selection.name, 'c');
    assert.equal(fixture.selection.name, 'c');
    assert.deepEqual(fixture.synced, ['token-c']);
});

test('failover refreshes candidates when a new account is selected during authentication', async () => {
    const accounts = [account('a'), account('b')];
    const fixture = createFixture('failover', accounts);
    const dependencies = (fixture.router as unknown as { dependencies: OAuthCredentialRouterDependencies })
        .dependencies;
    const authenticated: string[] = [];
    dependencies.authenticator.ensureAuthenticatedForOAuthCredential = async (_provider, name) => {
        authenticated.push(name);
        if (name === 'a' && !accounts.some(candidate => candidate.name === 'c')) {
            accounts.push(account('c'));
            fixture.selection.name = 'c';
            fixture.selection.generation++;
        }
        return { access_token: `token-${name}` };
    };

    const attempt = await fixture.router.captureAttempt('codex', 'session-one');

    assert.ok(attempt);
    assert.equal(attempt.credentialName, 'c');
    assert.equal(attempt.selection.name, 'c');
    assert.equal(fixture.selection.name, 'c');
    assert.deepEqual(authenticated, ['a', 'c']);
    assert.deepEqual(fixture.synced, ['token-c']);
});

test('failover refreshes candidates when authentication fails after a concurrent account switch', async () => {
    const accounts = [account('a'), account('b')];
    const fixture = createFixture('failover', accounts);
    const dependencies = (fixture.router as unknown as { dependencies: OAuthCredentialRouterDependencies })
        .dependencies;
    const authenticated: string[] = [];
    dependencies.authenticator.ensureAuthenticatedForOAuthCredential = async (_provider, name) => {
        authenticated.push(name);
        if (name === 'a') {
            accounts.push(account('c'));
            fixture.selection.name = 'c';
            fixture.selection.generation++;
            return null;
        }
        return name === 'c' ? { access_token: 'token-c' } : null;
    };

    const attempt = await fixture.router.captureAttempt('codex', 'session-one');

    assert.ok(attempt);
    assert.equal(attempt.credentialName, 'c');
    assert.equal(attempt.selection.name, 'c');
    assert.deepEqual(authenticated, ['a', 'c']);
    assert.deepEqual(fixture.synced, ['token-c']);
});

test('failover does not dispatch an account selected away during authentication', async () => {
    const fixture = createFixture('failover', [account('a'), account('b')]);
    const dependencies = (fixture.router as unknown as { dependencies: OAuthCredentialRouterDependencies })
        .dependencies;
    dependencies.authenticator.ensureAuthenticatedForOAuthCredential = async (_provider, name) => {
        if (name === 'a') {
            fixture.selection.name = 'b';
            fixture.selection.generation++;
        }
        return { access_token: `token-${name}` };
    };

    const attempt = await fixture.router.captureAttempt('codex', 'session-one');

    assert.equal(attempt?.credentialName, 'b');
    assert.equal(attempt?.selection.name, 'b');
    assert.deepEqual(fixture.synced, ['token-b']);
});

test('balance account failure moves only that session to another account', async () => {
    const fixture = createFixture('balance', [account('a'), account('b')]);
    fixture.router.clearBalanceAffinity('codex');
    const attempt = await fixture.router.captureAttempt('codex', 'session-one');
    const attempted = new Set([attempt!.identity]);

    const decision = await fixture.router.handleFailure('codex', attempt!, { status: 403 }, attempted, 'session-one');
    const next = await fixture.router.captureAttempt('codex', 'session-one');
    assert.deepEqual(decision, { handled: true, shouldRetry: true });
    assert.notEqual(next?.credentialName, attempt?.credentialName);
    assert.equal(fixture.selection.name, 'a');
});

test('balance affinity can be restored from a stateful marker after account rejection', async () => {
    const fixture = createFixture('balance', [account('a'), account('b')]);
    const provider = 'codex';
    const balanceKey = 'session-one';
    fixture.router.clearBalanceAffinity(provider);
    const initial = await fixture.router.captureAttempt(provider, balanceKey);
    assert.ok(initial);
    const decision = await fixture.router.handleFailure(
        provider,
        initial,
        { status: 401 },
        new Set([initial.identity]),
        balanceKey
    );
    assert.deepEqual(decision, { handled: true, shouldRetry: true });

    const moved = await fixture.router.captureAttempt(provider, balanceKey);
    assert.ok(moved);
    assert.notEqual(moved.credentialName, initial.credentialName);
    assert.match(moved.identity, /^[a-f0-9]{64}$/);

    fixture.router.clearBalanceAffinity(provider);
    const recoveredCredentialId = getMarkerBalanceCredential(
        {
            extension: 'vicanent.gcmp',
            sessionId: 'session-id',
            provider,
            modelId: 'model',
            sdkMode: 'openai',
            balanceAffinity: { slot: provider, balanceKey, credentialId: moved.identity }
        },
        {
            sessionId: 'session-id',
            provider,
            modelId: 'model',
            sdkMode: 'openai',
            balanceKey
        }
    );
    assert.equal(recoveredCredentialId, moved.identity);
    const restored = await fixture.router.captureAttempt(provider, balanceKey, recoveredCredentialId);
    assert.equal(restored?.credentialName, moved.credentialName);
    fixture.router.clearBalanceAffinity(provider);
});

test('concurrent active change is not overwritten by an old failure', async () => {
    const fixture = createFixture('failover', [account('a'), account('b'), account('c')]);
    const attempt = await fixture.router.captureAttempt('codex', 'session-one');
    const attempted = new Set([attempt!.identity]);
    fixture.selection.name = 'c';
    fixture.selection.generation++;

    const decision = await fixture.router.handleFailure('codex', attempt!, { status: 401 }, attempted, 'session-one');
    assert.deepEqual(decision, { handled: true, shouldRetry: true });
    assert.equal(fixture.selection.name, 'c');
    assert.deepEqual(fixture.synced, ['token-a']);
});
