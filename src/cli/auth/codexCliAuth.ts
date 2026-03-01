/*---------------------------------------------------------------------------------------------
 *  OpenAI Codex CLI 认证实现
 *  基于 OpenAI Codex OAuth 2.0 流程（ChatGPT Plus/Pro 账号）
 *  登录/授权由用户在 Codex CLI 终端中完成，此处仅实现凭证读取与 refresh_token 刷新
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Codex OAuth 凭证扩展接口
 * 包含 ChatGPT 账户 ID（用于 API 请求头 ChatGPT-Account-Id）
 */
interface CodexOAuthCredentials extends OAuthCredentials {
    /** ChatGPT 账户 ID */
    account_id?: string;
}

/** OpenAI Codex OAuth 客户端 ID */
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** OpenAI OAuth 令牌端点 */
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * OpenAI Codex CLI 认证类
 */
export class CodexCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Codex',
            clientId: OPENAI_CODEX_CLIENT_ID,
            tokenUrl: OPENAI_CODEX_TOKEN_URL,
            credentialPathPattern: '~/.codex/oauth_creds.json',
            cliCommand: 'codex'
        };
        super(config);
    }

    /**
     * Codex access_token 默认仅 1 小时有效。
     * 使用 5 分钟缓冲时间，避免"刚拿到就判定过期"的情况。
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            return null;
        }

        // 兼容凭证文件里 expiry_date 可能为字符串的情况
        const rawExpiry = (credentials as unknown as { expiry_date?: unknown }).expiry_date;
        if (typeof rawExpiry === 'string') {
            const parsed = Number(rawExpiry);
            if (Number.isFinite(parsed)) {
                credentials.expiry_date = parsed;
            }
        }

        // Codex: 提前 5 分钟刷新，避免边界问题
        const expiryBufferMs = 5 * 60 * 1000;
        const isExpired =
            typeof credentials.expiry_date === 'number' ? credentials.expiry_date < Date.now() + expiryBufferMs : false;

        if (isExpired && credentials.refresh_token) {
            try {
                credentials = await this.refreshAccessToken(credentials);
                Logger.info(`[${this.config.name}] 令牌已刷新`);
            } catch (error) {
                Logger.error(`[${this.config.name}] 令牌刷新失败:`, error);
                return null;
            }
        }

        return credentials;
    }

    /**
     * 刷新 Codex CLI 访问令牌（OAuth 2.0 refresh_token）
     * Codex 使用 PKCE 公共客户端，不需要 client_secret
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Codex CLI OAuth 凭证缺少 refresh_token，无法刷新令牌');
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: this.config.clientId
        });

        const tokenRes = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        // 无论成功或失败都先读取文本，便于打印更友好的错误信息
        const rawText = await tokenRes.text();
        let responseData: {
            access_token?: unknown;
            expires_in?: unknown;
            refresh_token?: unknown;
            token_type?: unknown;
            id_token?: unknown;
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
            throw new Error(`Codex CLI 令牌刷新失败 (${tokenRes.status}): ${errorMsg}`);
        }

        const accessToken = typeof responseData.access_token === 'string' ? responseData.access_token : '';
        const expiresIn = (() => {
            const value = responseData.expires_in;
            if (typeof value === 'number') {
                return value;
            }
            if (typeof value === 'string') {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            }
            return undefined;
        })();
        const refreshToken =
            typeof responseData.refresh_token === 'string' && responseData.refresh_token
                ? responseData.refresh_token
                : credentials.refresh_token;
        const tokenType = typeof responseData.token_type === 'string' ? responseData.token_type : undefined;

        if (!accessToken) {
            throw new Error('Codex CLI OAuth 刷新响应缺少 access_token');
        }

        // 正常情况下 OpenAI 总会返回 expires_in；缺失时保留原 expiry_date（避免立即进入刷新循环）
        const expiryDate = Number.isFinite(expiresIn)
            ? Date.now() + (expiresIn as number) * 1000
            : credentials.expiry_date || Date.now() + 55 * 60 * 1000;

        const newCredentials: OAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate
        };

        // 从 id_token 中提取 account_id（如果存在）
        const accountId = this.extractAccountIdFromIdToken(responseData.id_token);

        // 保存刷新后的凭证（差分合并，保留 account_id 等扩展字段）
        this.saveCredentials({
            ...newCredentials,
            ...(tokenType ? { token_type: tokenType } : {}),
            ...(accountId ? { account_id: accountId } : {})
        } as unknown as Partial<OAuthCredentials>);

        Logger.info('[Codex] 令牌刷新成功');
        return newCredentials;
    }

    /**
     * 获取 ChatGPT 账户 ID
     * 用于 API 请求头 ChatGPT-Account-Id
     */
    async getAccountId(): Promise<string | null> {
        const credentials = (await this.loadCredentials()) as CodexOAuthCredentials | null;
        return credentials?.account_id ?? null;
    }

    /**
     * 从 id_token (JWT) 中提取 ChatGPT account_id
     */
    private extractAccountIdFromIdToken(idToken: unknown): string | undefined {
        if (typeof idToken !== 'string' || !idToken) {
            return undefined;
        }
        try {
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return undefined;
            }
            // 解码 JWT payload（第二部分）
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
                chatgpt_account_id?: string;
                organizations?: Array<{ id: string }>;
            };
            // 优先使用 chatgpt_account_id，然后取第一个 organization id
            if (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id) {
                return payload.chatgpt_account_id;
            }
            if (Array.isArray(payload.organizations) && payload.organizations.length > 0) {
                const firstOrg = payload.organizations[0];
                if (typeof firstOrg?.id === 'string' && firstOrg.id) {
                    return firstOrg.id;
                }
            }
        } catch {
            Logger.debug('[Codex] 解析 id_token 失败');
        }
        return undefined;
    }
}
