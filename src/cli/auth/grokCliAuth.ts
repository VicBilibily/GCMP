/*---------------------------------------------------------------------------------------------
 *  Grok Build 认证实现
 *  仅实现 refresh_token 刷新逻辑：登录/授权由用户在 Grok Build 终端中完成
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

interface GrokAuthRecord {
    key?: string;
    refresh_token?: string;
    expires_at?: string;
    oidc_client_id?: string;
    [key: string]: unknown;
}

interface GrokOAuthCredentials extends OAuthCredentials {
    oidc_client_id?: string;
}

const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_TOKEN_URL = 'https://auth.x.ai/oauth2/token';

/**
 * Grok Build 认证类
 */
export class GrokCliAuth extends BaseCliAuth {
    private recordKey?: string;

    constructor() {
        const config: CliAuthConfig = {
            name: 'Grok Build',
            clientId: GROK_CLIENT_ID,
            tokenUrl: GROK_TOKEN_URL,
            credentialPathPattern: '~/.grok/auth.json',
            cliCommand: 'grok'
        };
        super(config);
    }

    protected saveCredentials(credentials: {
        access_token?: string;
        refresh_token?: string;
        expiry_date?: number;
        oidc_client_id?: string;
    }): void {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);
        const { data, recordKey, record } = this.readAuthFile();
        const finalRecordKey = recordKey || this.recordKey || `https://auth.x.ai::${this.config.clientId}`;

        const nextExpiryDate =
            typeof credentials.expiry_date === 'number' && Number.isFinite(credentials.expiry_date) ?
                credentials.expiry_date
            :   this.parseExpiryDate(record.expires_at);

        data[finalRecordKey] = {
            ...record,
            ...(credentials.access_token ? { key: credentials.access_token } : {}),
            ...(credentials.refresh_token ? { refresh_token: credentials.refresh_token } : {}),
            ...(credentials.oidc_client_id ? { oidc_client_id: credentials.oidc_client_id } : {}),
            ...(typeof nextExpiryDate === 'number' && Number.isFinite(nextExpiryDate) ?
                { expires_at: new Date(nextExpiryDate).toISOString() }
            :   {})
        };

        const dir = path.dirname(credentialPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(credentialPath, JSON.stringify(data, null, 2));
        this.recordKey = finalRecordKey;
    }

    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            return null;
        }

        const expiryBufferMs = 5 * 60 * 1000;
        const isExpired =
            typeof credentials.expiry_date === 'number' ? credentials.expiry_date < Date.now() + expiryBufferMs : false;

        if (isExpired && credentials.refresh_token) {
            try {
                credentials = await this.refreshAccessToken(credentials);
                Logger.info(`[${this.config.name}] Token refreshed`);
            } catch (error) {
                Logger.error(`[${this.config.name}] Failed to refresh token:`, error);
                return null;
            }
        }

        return credentials;
    }

    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Grok Build OAuth credentials are missing refresh_token and cannot refresh the token');
        }

        const extendedCredentials = credentials as GrokOAuthCredentials;
        const clientId = extendedCredentials.oidc_client_id || this.config.clientId;
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: clientId
        });

        const tokenRes = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            },
            body
        });

        const rawText = await tokenRes.text();
        let responseData: {
            access_token?: unknown;
            expires_in?: unknown;
            refresh_token?: unknown;
            token_type?: unknown;
            error?: unknown;
            error_description?: unknown;
        } = {};
        try {
            responseData = JSON.parse(rawText) as typeof responseData;
        } catch {
            // ignore
        }

        if (!tokenRes.ok) {
            const errorMsg =
                (typeof responseData.error_description === 'string' && responseData.error_description) ||
                (typeof responseData.error === 'string' && responseData.error) ||
                rawText ||
                'unknown error';
            throw new Error(`Grok Build token refresh failed (${tokenRes.status}): ${errorMsg}`);
        }

        const accessToken = typeof responseData.access_token === 'string' ? responseData.access_token : '';
        const expiresIn = this.parseExpiresInSeconds(responseData.expires_in);
        const refreshToken =
            typeof responseData.refresh_token === 'string' && responseData.refresh_token ?
                responseData.refresh_token
            :   credentials.refresh_token;

        if (!accessToken) {
            throw new Error('Grok Build OAuth refresh response is missing access_token');
        }

        const expiryDate =
            Number.isFinite(expiresIn) ?
                Date.now() + (expiresIn as number) * 1000
            :   this.extractExpFromJwt(accessToken) || credentials.expiry_date || Date.now() + 55 * 60 * 1000;

        const newCredentials: GrokOAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate,
            oidc_client_id: clientId
        };

        this.saveCredentials(newCredentials);
        Logger.info('[Grok Build] Token refresh succeeded');
        return newCredentials;
    }

    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const rawData = credentials as unknown as Record<string, GrokAuthRecord>;
        const [recordKey, record] =
            Object.entries(rawData).find(([, value]) => value && typeof value === 'object' && !Array.isArray(value)) ||
            [];

        if (!recordKey || !record) {
            return credentials;
        }

        this.recordKey = recordKey;
        const accessToken = typeof record.key === 'string' ? record.key : '';
        const expiryFromToken = this.extractExpFromJwt(accessToken);
        const expiryFromFile = this.parseExpiryDate(record.expires_at);

        return {
            access_token: accessToken,
            refresh_token: typeof record.refresh_token === 'string' ? record.refresh_token : '',
            expiry_date: expiryFromToken || expiryFromFile || 0,
            ...(typeof record.oidc_client_id === 'string' && record.oidc_client_id ?
                { oidc_client_id: record.oidc_client_id }
            :   {})
        } as GrokOAuthCredentials;
    }

    private readAuthFile(): { data: Record<string, GrokAuthRecord>; recordKey?: string; record: GrokAuthRecord } {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);
        let data: Record<string, GrokAuthRecord> = {};

        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                data = JSON.parse(content) as Record<string, GrokAuthRecord>;
            } catch (error) {
                Logger.warn(`[${this.config.name}] Failed to read existing credential file:`, error);
            }
        }

        const [recordKey, record] =
            Object.entries(data).find(([, value]) => value && typeof value === 'object' && !Array.isArray(value)) || [];

        return { data, recordKey, record: record || {} };
    }

    private parseExpiryDate(expiresAt: unknown): number | undefined {
        if (typeof expiresAt !== 'string' || !expiresAt) {
            return undefined;
        }
        const parsed = new Date(expiresAt).getTime();
        return Number.isFinite(parsed) ? parsed : undefined;
    }

    private parseExpiresInSeconds(value: unknown): number | undefined {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? value : undefined;
        }
        if (typeof value === 'string') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    private extractExpFromJwt(token: unknown): number | undefined {
        if (typeof token !== 'string' || !token) {
            return undefined;
        }
        try {
            const parts = token.split('.');
            if (parts.length !== 3) {
                return undefined;
            }
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
            if (typeof payload.exp === 'number') {
                return payload.exp * 1000;
            }
        } catch {
            // ignore
        }
        return undefined;
    }
}
