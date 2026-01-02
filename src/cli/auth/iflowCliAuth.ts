/*---------------------------------------------------------------------------------------------
 *  iFlow CLI 认证实现
 *  iFlow 特有的认证逻辑：使用 clientSecret + Basic 认证，有 getUserInfo 接口
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * iFlow CLI 认证类
 */
export class IFlowCliAuth extends BaseCliAuth {
    /** apiKey 缓存 */
    private static apiKeyCache: { accessToken: string; token: string; expireTime: number } | null = null;
    /** token 缓存有效期：2小时（毫秒） */
    private static readonly API_KEY_CACHE_DURATION = 2 * 60 * 60 * 1000;

    constructor() {
        const config: CliAuthConfig = {
            name: 'iFlow',
            clientId: '10009311001',
            clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
            tokenUrl: 'https://iflow.cn/oauth/token',
            credentialPathPattern: '~/.iflow/oauth_creds.json',
            cliCommand: 'iflow'
        };
        super(config);
    }

    /**
     * 获取 iFlow API Key
     * iFlow 需要使用 apiKey 而不是 bearer token
     * @param forceRefresh 是否强制刷新缓存，默认为 false
     */
    async getApiKey(forceRefresh = false): Promise<string | null> {
        const now = Date.now();

        // 缓存过期或不存在，重新获取
        const credentials = await this.loadCredentials();
        if (!credentials) {
            return null;
        }

        // 检查缓存是否有效（除非强制刷新）
        if (
            !forceRefresh &&
            IFlowCliAuth.apiKeyCache &&
            IFlowCliAuth.apiKeyCache.expireTime > now &&
            IFlowCliAuth.apiKeyCache.accessToken === credentials.access_token
        ) {
            const remainingSeconds = Math.ceil((IFlowCliAuth.apiKeyCache.expireTime - now) / 1000);
            Logger.trace(`[iFlow] 使用缓存的 apiKey (剩余 ${remainingSeconds}秒)`);
            return IFlowCliAuth.apiKeyCache.token;
        }

        try {
            const userInfo = await this.fetchUserInfo(credentials.access_token);
            if (userInfo && userInfo.apiKey) {
                // 更新缓存
                IFlowCliAuth.apiKeyCache = {
                    accessToken: credentials.access_token,
                    token: userInfo.apiKey,
                    expireTime: now + IFlowCliAuth.API_KEY_CACHE_DURATION
                };
                Logger.debug(
                    `[iFlow] 已从 getUserInfo 获取最新 apiKey 并缓存 (有效期: ${IFlowCliAuth.API_KEY_CACHE_DURATION / 1000 / 60}分钟)`
                );
                return userInfo.apiKey;
            }
        } catch (error) {
            Logger.warn('[iFlow] 获取用户信息失败:', error);
        }
        return null;
    }

    /**
     * 刷新 iFlow 令牌（使用 clientSecret 和 Basic 认证）
     */
    protected async refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        if (!this.config.clientSecret) {
            throw new Error('iFlow 缺少 clientSecret，无法刷新令牌');
        }

        // 创建 Basic 认证头
        const basicAuth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
        const response = await fetch(this.config.tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${basicAuth}`
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: credentials.refresh_token
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`iFlow OAuth 刷新失败 (${response.status}): ${errorText}`);
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
        Logger.info('[iFlow] 令牌刷新成功');
        return newCredentials;
    }

    /**
     * 获取 iFlow 用户信息（包括 apiKey）
     */
    private async fetchUserInfo(accessToken: string): Promise<{ apiKey?: string } | null> {
        try {
            const url = `https://iflow.cn/api/oauth/getUserInfo?accessToken=${encodeURIComponent(accessToken)}`;
            const response = await fetch(url, { method: 'GET' });
            if (!response.ok) {
                throw new Error(`获取用户信息失败: ${response.status}`);
            }

            const result = await response.json();
            // iFlow API 返回格式: { success: true, data: { apiKey: "sk-..." } }
            if (result.success && result.data && result.data.apiKey) {
                return { apiKey: result.data.apiKey };
            }
            Logger.warn('[iFlow] getUserInfo 返回数据格式异常');
            return null;
        } catch (error) {
            Logger.error('[iFlow] 获取用户信息失败:', error);
            return null;
        }
    }
}
