import assert from 'node:assert/strict';
import test from 'node:test';
import { isCredentialExpiryDateExpired, sanitizeWebViewMessage, type CliProviderOption } from './types';
import { applyDefaultCliUsage, mergeCliUsageState } from './components/usage';

test('treats missing, zero, and invalid expiry as unknown', () => {
    assert.equal(isCredentialExpiryDateExpired(undefined), false);
    assert.equal(isCredentialExpiryDateExpired(0), false);
    assert.equal(isCredentialExpiryDateExpired(-1), false);
    assert.equal(isCredentialExpiryDateExpired(Number.NaN), false);
    assert.equal(isCredentialExpiryDateExpired(1), true);
    assert.equal(isCredentialExpiryDateExpired(Date.now() + 60_000), false);
});

test('default CLI usage success marks authentication valid without changing status on failure', () => {
    const provider: CliProviderOption = {
        provider: 'codex',
        displayName: 'Codex CLI',
        isAuthenticated: false,
        cliCommand: 'codex',
        isCliInstalled: true,
        statusDetail: 'Credentials expired.',
        oauthCredentials: []
    };

    applyDefaultCliUsage(provider, { loading: true }, 'Valid', 'Authentication rejected');
    assert.equal(provider.isAuthenticated, false);
    assert.equal(provider.statusDetail, 'Credentials expired.');

    applyDefaultCliUsage(
        provider,
        { loading: false, credentialAuthenticated: true, summary: '80%' },
        'Valid',
        'Authentication rejected'
    );
    assert.equal(provider.isAuthenticated, true);
    assert.equal(provider.statusDetail, 'Valid');
    assert.equal(provider.usage?.summary, '80%');

    applyDefaultCliUsage(
        provider,
        { loading: false, error: 'network unavailable', authenticationRejected: false },
        'Valid',
        'Authentication rejected'
    );
    assert.equal(provider.isAuthenticated, true);
    assert.equal(provider.statusDetail, 'Valid');

    applyDefaultCliUsage(
        provider,
        { loading: false, error: 'authorization rejected', authenticationRejected: true },
        'Valid',
        'Authentication rejected'
    );
    assert.equal(provider.isAuthenticated, false);
    assert.equal(provider.statusDetail, 'Authentication rejected');

    applyDefaultCliUsage(
        provider,
        { loading: false, error: 'network unavailable' },
        'Valid',
        'Authentication rejected'
    );
    assert.equal(provider.isAuthenticated, false);
    assert.equal(provider.statusDetail, 'Authentication rejected');

    applyDefaultCliUsage(
        provider,
        { loading: false, credentialAuthenticated: true, summary: '80%' },
        'Valid',
        'Authentication rejected'
    );
    assert.equal(provider.isAuthenticated, true);
    assert.equal(provider.statusDetail, 'Valid');
});

test('named-account authorization rejection persists through loading and network errors until success', () => {
    const rejected = { loading: false, authenticationRejected: true, error: 'Authorization rejected' };
    const loading = mergeCliUsageState(rejected, { loading: true });
    assert.equal(loading.authenticationRejected, true);

    const networkError = mergeCliUsageState(loading, { loading: false, error: 'Network unavailable' });
    assert.equal(networkError.authenticationRejected, true);

    const authenticated = mergeCliUsageState(networkError, { loading: false, credentialAuthenticated: true });
    assert.equal(authenticated.authenticationRejected, undefined);
    assert.equal(authenticated.credentialAuthenticated, true);
});

test('validates CLI OAuth account management and usage messages', () => {
    assert.deepEqual(sanitizeWebViewMessage({ command: 'importCliCredential', provider: 'codex' }), {
        command: 'importCliCredential',
        provider: 'codex'
    });
    assert.deepEqual(
        sanitizeWebViewMessage({ command: 'activateCliCredential', provider: 'codex', credentialName: 'work' }),
        { command: 'activateCliCredential', provider: 'codex', credentialName: 'work' }
    );
    assert.deepEqual(
        sanitizeWebViewMessage({ command: 'refreshCliUsage', provider: 'codex', credentialName: 'work' }),
        { command: 'refreshCliUsage', provider: 'codex', credentialName: 'work' }
    );
    assert.equal(sanitizeWebViewMessage({ command: 'deleteCliCredential', provider: 'codex' }), undefined);
    assert.equal(
        sanitizeWebViewMessage({ command: 'activateCliCredential', provider: 'codex', credentialName: '' }),
        undefined
    );
    assert.equal(
        sanitizeWebViewMessage({ command: 'refreshCliUsage', provider: 'codex', credentialName: 42 }),
        undefined
    );
});
