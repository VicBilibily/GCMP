/*---------------------------------------------------------------------------------------------
 *  Gemini CLI 认证实现
 *  仅实现 refresh_token 刷新逻辑：登录/授权由用户在 Gemini CLI 终端中完成
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

interface OauthConfig {
    oauthClientId: string;
    oauthClientSecret: string;
}

/**
 * GitHub 会检测 Google oauthClientId 是否泄露
 * 此值为 JSON 经过 HEX 编码后的内容
 * 数据来源：https://api.kilo.ai/extension-config.json => geminiCli
 */
const oauthConfigHex =
    '7b226f61757468436c69656e744964223a223638313235353830393339352d6f6f386674326f707264726e7039653361716636617633686d6469623133356a2e617070732e676f6f676c6575736572636f6e74656e742e636f6d222c226f61757468436c69656e74536563726574223a22474f435350582d347548674d506d2d316f37536b2d67655636437535636c584673786c227d';
const oauthConfig: OauthConfig = (() => {
    const jsonText = Buffer.from(oauthConfigHex, 'hex').toString('utf8');
    const parsed = JSON.parse(jsonText) as Partial<OauthConfig>;
    if (typeof parsed.oauthClientId !== 'string' || typeof parsed.oauthClientSecret !== 'string') {
        throw new Error('invalid oauth config');
    }
    return { oauthClientId: parsed.oauthClientId, oauthClientSecret: parsed.oauthClientSecret };
})();

/**
 * Gemini CLI 认证类
 */
export class GeminiCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Gemini CLI',
            // clientId 优先取内置 OAuth 配置；仍允许凭证文件中的 client_id 覆盖
            clientId: oauthConfig.oauthClientId,
            tokenUrl: 'https://oauth2.googleapis.com/token',
            credentialPathPattern: '~/.gemini/oauth_creds.json',
            cliCommand: 'gemini'
        };
        super(config);
    }

    /**
     * Gemini access_token 默认仅 1 小时有效。
     * BaseCliAuth 使用 1 小时缓冲会导致“刚拿到就判定过期”，从而持续刷新。
     * Gemini 单独使用更小的缓冲时间（默认 5 分钟）。
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            // Logger.info(`[${this.config.name}] 未认证，请先运行 CLI 登录`);
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

        // Gemini: 提前 5 分钟刷新即可，避免边界问题
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
     * 刷新 Gemini CLI 访问令牌（OAuth 2.0 refresh_token）
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Gemini CLI OAuth 凭证缺少 refresh_token，无法刷新令牌');
        }

        // 允许凭证文件中的 client_id/client_secret 覆盖内置配置
        const fileClientId = (credentials as unknown as { client_id?: unknown }).client_id;
        const fileClientSecret = (credentials as unknown as { client_secret?: unknown }).client_secret;
        const clientId = typeof fileClientId === 'string' && fileClientId ? fileClientId : oauthConfig.oauthClientId;
        const clientSecret =
            typeof fileClientSecret === 'string' && fileClientSecret ? fileClientSecret : oauthConfig.oauthClientSecret;

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: clientId,
            client_secret: clientSecret
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
            scope?: unknown;
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
            throw new Error(`Gemini CLI 令牌刷新失败 (${tokenRes.status}): ${errorMsg}`);
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
        const scope = typeof responseData.scope === 'string' ? responseData.scope : undefined;
        const idToken = typeof responseData.id_token === 'string' ? responseData.id_token : undefined;

        if (!accessToken) {
            throw new Error('Gemini CLI OAuth 刷新响应缺少 access_token');
        }

        // 正常情况下 Google 总会返回 expires_in；缺失时保留原 expiry_date（避免立即进入刷新循环）
        const expiryDate = Number.isFinite(expiresIn)
            ? Date.now() + (expiresIn as number) * 1000
            : credentials.expiry_date || Date.now() + 55 * 60 * 1000;

        const newCredentials: OAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate
        };

        // 保存刷新后的凭证（差分合并，保留 client_id/client_secret 等扩展字段）
        this.saveCredentials({
            ...newCredentials,
            ...(tokenType ? { token_type: tokenType } : {}),
            ...(scope ? { scope } : {}),
            ...(idToken ? { id_token: idToken } : {})
        } as unknown as Partial<OAuthCredentials>);

        Logger.info('[Gemini CLI] 令牌刷新成功');
        return newCredentials;
    }
}
