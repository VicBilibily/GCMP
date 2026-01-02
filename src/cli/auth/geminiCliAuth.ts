/*---------------------------------------------------------------------------------------------
 *  Gemini CLI 认证实现
 *  Google OAuth 2.0 流程
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Gemini CLI 认证类
 */
export class GeminiCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Gemini CLI',
            clientId: 'your-gemini-client-id',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            credentialPathPattern: '~/.gemini/oauth_creds.json',
            cliCommand: 'gemini'
        };
        super(config);
    }

    /**
     * 刷新 Gemini 令牌（Google OAuth 2.0 流程）
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        const response = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.config.clientId,
                refresh_token: credentials.refresh_token
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Gemini 令牌刷新失败 (${response.status}): ${errorText}`);
        }

        const responseData = (await response.json()) as OAuthCredentials & { expires_in?: number };
        // 计算新的过期时间
        const newCredentials: OAuthCredentials = {
            access_token: responseData.access_token,
            refresh_token: responseData.refresh_token,
            expiry_date: responseData.expires_in
                ? Date.now() + responseData.expires_in * 1000
                : responseData.expiry_date
        };

        // 保存刷新后的凭证
        this.saveCredentials(newCredentials);
        Logger.info('[Gemini] 令牌刷新成功');
        return newCredentials;
    }
}
