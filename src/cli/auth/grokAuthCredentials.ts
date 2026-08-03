import type { OAuthCredentials } from '../type';

export interface GrokOAuthCredentials extends OAuthCredentials {
    oidc_client_id?: string;
    user_id?: string;
    email?: string;
    team_id?: string;
}

interface BuildRefreshedGrokCredentialsInput {
    previous: GrokOAuthCredentials;
    accessToken: string;
    refreshToken: string;
    expiryDate: number;
    clientId: string;
}

export function buildRefreshedGrokCredentials({
    previous,
    accessToken,
    refreshToken,
    expiryDate,
    clientId
}: BuildRefreshedGrokCredentialsInput): GrokOAuthCredentials {
    return {
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_date: expiryDate,
        oidc_client_id: clientId,
        ...(previous.user_id ? { user_id: previous.user_id } : {}),
        ...(previous.email ? { email: previous.email } : {}),
        ...(previous.team_id ? { team_id: previous.team_id } : {})
    };
}
