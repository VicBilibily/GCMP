/*---------------------------------------------------------------------------------------------
 *  Grok Build 认证实现
 *  仅实现 refresh_token 刷新逻辑：登录/授权由用户在 Grok Build 终端中完成
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/runtime/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';
import { buildRefreshedGrokCredentials, type GrokOAuthCredentials } from './grokAuthCredentials';

interface GrokAuthRecord {
    key?: string;
    refresh_token?: string;
    expires_at?: string;
    oidc_client_id?: string;
    [key: string]: unknown;
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
            providerKey: 'grok',
            name: 'Grok Build',
            clientId: GROK_CLIENT_ID,
            tokenUrl: GROK_TOKEN_URL,
            credentialPathPattern: '~/.grok/auth.json',
            cliCommand: 'grok'
        };
        super(config);
    }

    /**
     * 保存凭证到文件
     * oauth 文件夹命名凭证写归一化平铺格式；CLI 默认目录保持 Grok 按域名::clientId 为 key 的字典格式
     */
    protected async saveCredentials(
        credentials: Partial<GrokOAuthCredentials>,
        credentialPath = this.resolveCredentialFilePath(),
        expectedCredentials?: OAuthCredentials
    ): Promise<void> {
        if (this.isOAuthCredentialPath(credentialPath)) {
            await super.saveCredentials({ ...credentials }, credentialPath, expectedCredentials);
            return;
        }
        const { data, recordKey, record } = this.readAuthFile();
        const canonicalKey = `https://auth.x.ai::${this.config.clientId}`;
        // 仅当 recordKey 明确在 https://auth.x.ai:: 命名空间下时才沿用，否则强制使用 canonical key
        const finalRecordKey =
            (recordKey && recordKey.startsWith('https://auth.x.ai::') ? recordKey : undefined) ||
            (this.recordKey && this.recordKey.startsWith('https://auth.x.ai::') ? this.recordKey : undefined) ||
            canonicalKey;

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
        await this.writeJsonFileAtomically(credentialPath, data);
        this.recordKey = finalRecordKey;
    }

    /**
     * Grok access_token 有效期较短，使用 5 分钟缓冲避免频繁刷新。
     */
    protected getExpiryBufferMs(): number {
        return 5 * 60 * 1000;
    }

    protected async refreshAccessToken(
        credentials: OAuthCredentials,
        credentialPath: string
    ): Promise<OAuthCredentials> {
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

        const tokenRes = await this.fetchWithProxy(this.config.tokenUrl, {
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

        const newCredentials = buildRefreshedGrokCredentials({
            previous: extendedCredentials,
            accessToken,
            refreshToken,
            expiryDate,
            clientId
        });

        await this.saveCredentials(newCredentials, credentialPath, credentials);
        Logger.info('[Grok Build] Token refresh succeeded');
        return newCredentials;
    }

    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        // oauth 文件夹归一化平铺格式：根级即 access_token，无需按 CLI 原生字典格式提取
        if (typeof credentials.access_token === 'string' && credentials.access_token) {
            return credentials;
        }
        const rawData = credentials as unknown as Record<string, GrokAuthRecord>;
        const { recordKey, record } = this.findPreferredGrokRecord(rawData);

        if (!recordKey || !record || Object.keys(record).length === 0) {
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
            ...(typeof record.user_id === 'string' && record.user_id ? { user_id: record.user_id } : {}),
            ...(typeof record.email === 'string' && record.email ? { email: record.email } : {}),
            ...(typeof record.team_id === 'string' && record.team_id ? { team_id: record.team_id } : {}),
            ...(typeof record.oidc_client_id === 'string' && record.oidc_client_id ?
                { oidc_client_id: record.oidc_client_id }
            :   {})
        } as GrokOAuthCredentials;
    }

    /**
     * 构建 oauth 文件夹归一化凭证记录：附带 xAI 扩展身份字段
     */
    override toOAuthStoreRecord(credentials: OAuthCredentials): Record<string, unknown> {
        const record = super.toOAuthStoreRecord(credentials);
        const extended = credentials as GrokOAuthCredentials;
        for (const key of ['oidc_client_id', 'user_id', 'email', 'team_id'] as const) {
            const value = extended[key];
            if (typeof value === 'string' && value) {
                record[key] = value;
            }
        }
        return record;
    }

    /**
     * 依据账号身份派生凭证名（同 CLIProxyAPI 的 xai 命名）：
     * 优先 email，其次 user_id，均不可用时回退基类的令牌哈希命名
     */
    override suggestCredentialName(credentials: OAuthCredentials): string {
        const extended = credentials as GrokOAuthCredentials;
        const identity = extended.email?.trim() || extended.user_id?.trim() || '';
        if (!identity) {
            return super.suggestCredentialName(credentials);
        }
        return this.sanitizeCredentialSegment(identity, 64);
    }

    /**
     * 导入迁移后移除 CLI 默认目录中的 OAuth 凭证：
     * 仅删除当前使用的认证记录，保留文件内其他记录；无剩余记录时删除整文件
     */
    override async removeCliNativeCredential(): Promise<void> {
        const cliPath = this.getCliNativeCredentialPath();
        if (!fs.existsSync(cliPath)) {
            return;
        }
        const content = fs.readFileSync(cliPath, 'utf-8');
        const data = JSON.parse(content) as Record<string, GrokAuthRecord>;
        const { recordKey } = this.findPreferredGrokRecord(data);
        if (recordKey) {
            delete data[recordKey];
        }
        if (Object.keys(data).length === 0) {
            fs.unlinkSync(cliPath);
        } else {
            await this.writeJsonFileAtomically(cliPath, data);
        }
        this.recordKey = undefined;
        this.invalidateCredentialCache();
        Logger.info(`[${this.config.name}] CLI native OAuth record removed: ${cliPath}`);
    }

    private readAuthFile(): { data: Record<string, GrokAuthRecord>; recordKey?: string; record: GrokAuthRecord } {
        const credentialPath = this.getCliNativeCredentialPath();
        let data: Record<string, GrokAuthRecord> = {};

        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                data = JSON.parse(content) as Record<string, GrokAuthRecord>;
            } catch (error) {
                Logger.warn(`[${this.config.name}] Failed to read existing credential file:`, error);
            }
        }

        const { recordKey, record } = this.findPreferredGrokRecord(data);
        return { data, recordKey, record };
    }

    /**
     * 按优先级选择 Grok 认证记录，避免多记录时误选错凭证。
     * 优先级：canonical key > this.recordKey > https://auth.x.ai:: 命名空间 > 首个对象记录
     */
    private findPreferredGrokRecord(data: Record<string, GrokAuthRecord>): {
        recordKey?: string;
        record: GrokAuthRecord;
    } {
        const entries = Object.entries(data).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) as [
            string,
            GrokAuthRecord
        ][];

        if (entries.length === 0) {
            return { recordKey: undefined, record: {} };
        }

        const canonicalKey = `https://auth.x.ai::${GROK_CLIENT_ID}`;

        // 1. 精确匹配 canonical key（推荐）
        const canonical = entries.find(([k]) => k === canonicalKey);
        if (canonical) {
            return { recordKey: canonical[0], record: canonical[1] };
        }

        // 2. 内存中已有 recordKey 且仍存在于文件中，优先沿用（会话连续性）
        if (this.recordKey && data[this.recordKey]) {
            return { recordKey: this.recordKey, record: data[this.recordKey] };
        }

        // 3. 优先选择 https://auth.x.ai:: 命名空间下的记录
        const authXaiEntries = entries.filter(([k]) => k.startsWith('https://auth.x.ai::'));
        if (authXaiEntries.length > 0) {
            // 如果命名空间下有多个，优先包含当前 clientId 的那一条
            const withOurClient = authXaiEntries.find(([k]) => k.includes(GROK_CLIENT_ID));
            if (withOurClient) {
                return { recordKey: withOurClient[0], record: withOurClient[1] };
            }
            // 否则取命名空间下的第一条
            return { recordKey: authXaiEntries[0][0], record: authXaiEntries[0][1] };
        }

        // 4. 兜底：首个对象记录（兼容旧版单记录文件）
        const [recordKey, record] = entries[0];
        return { recordKey, record };
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
