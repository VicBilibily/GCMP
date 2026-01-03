/*---------------------------------------------------------------------------------------------
 *  Qwen Code CLI 认证实现
 *  标准 OAuth 2.0 流程
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Qwen Code CLI 认证类
 */
export class QwenCodeCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            name: 'Qwen Code',
            clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
            tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
            credentialPathPattern: '~/.qwen/oauth_creds.json',
            cliCommand: 'qwen'
        };
        super(config);
    }

    /**
     * 刷新 Qwen Code 令牌（标准 OAuth 2.0 流程）
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
            throw new Error(`Qwen Code 令牌刷新失败 (${response.status}): ${errorText}`);
        }

        const responseData = (await response.json()) as OAuthCredentials & { expires_in?: number };
        if (responseData.access_token && responseData.expires_in) {
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
            Logger.info('[Qwen Code] 令牌刷新成功');
            return newCredentials;
        } else {
            throw new Error(responseData?.toString() || 'Qwen OAuth 刷新响应缺少 access_token 或 expires_in');
        }
    }
}
