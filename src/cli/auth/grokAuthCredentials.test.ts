import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRefreshedGrokCredentials } from './grokAuthCredentials';

test('Grok token refresh preserves account metadata required by billing requests', () => {
    const credentials = buildRefreshedGrokCredentials({
        previous: {
            access_token: 'old-access-token',
            refresh_token: 'old-refresh-token',
            expiry_date: 1,
            oidc_client_id: 'client-id',
            user_id: 'user-123',
            email: 'dev@example.com',
            team_id: 'team-456'
        },
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiryDate: 2,
        clientId: 'client-id'
    });

    assert.deepEqual(credentials, {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expiry_date: 2,
        oidc_client_id: 'client-id',
        user_id: 'user-123',
        email: 'dev@example.com',
        team_id: 'team-456'
    });
});

test('Grok token refresh does not synthesize missing account metadata', () => {
    const credentials = buildRefreshedGrokCredentials({
        previous: {
            access_token: 'old-access-token',
            refresh_token: 'old-refresh-token',
            expiry_date: 1
        },
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiryDate: 2,
        clientId: 'client-id'
    });

    assert.deepEqual(credentials, {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expiry_date: 2,
        oidc_client_id: 'client-id'
    });
});
