/*---------------------------------------------------------------------------------------------
 *  OpenAI Codex CLI 认证实现
 *  基于 OpenAI Codex OAuth 2.0 流程（ChatGPT Plus/Pro 账号）
 *  登录/授权由用户在 Codex CLI 终端中完成，此处仅实现凭证读取与 refresh_token 刷新
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/runtime/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Codex OAuth 凭证扩展接口
 * 包含 ChatGPT 账户 ID（用于 API 请求头 ChatGPT-Account-Id）与账号身份信息
 */
interface CodexOAuthCredentials extends OAuthCredentials {
    /** ChatGPT 账户 ID */
    account_id?: string;
    /** 账号邮箱（从 id_token 提取，用于凭证命名与展示） */
    email?: string;
    /** 订阅计划类型，如 free / plus / pro / team（从 id_token 提取） */
    plan_type?: string;
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
            providerKey: 'codex',
            name: 'Codex',
            clientId: OPENAI_CODEX_CLIENT_ID,
            tokenUrl: OPENAI_CODEX_TOKEN_URL,
            credentialPathPattern: '~/.codex/auth.json',
            cliCommand: 'codex'
        };
        super(config);
    }

    /**
     * 保存凭证到文件
     * oauth 文件夹命名凭证写归一化平铺格式；CLI 默认目录保持 Codex CLI 官方嵌套格式
     */
    protected async saveCredentials(
        credentials: {
            access_token?: string;
            refresh_token?: string;
            id_token?: string;
            account_id?: string;
            email?: string;
            plan_type?: string;
            expiry_date?: number;
        },
        credentialPath = this.resolveCredentialFilePath(),
        expectedCredentials?: OAuthCredentials
    ): Promise<void> {
        if (this.isOAuthCredentialPath(credentialPath)) {
            await super.saveCredentials({ ...credentials }, credentialPath, expectedCredentials);
            return;
        }

        // 读取现有凭证文件
        let existingData: {
            OPENAI_API_KEY?: string;
            tokens?: {
                id_token?: string;
                account_id?: string;
            };
            last_refresh?: string;
        } = {};

        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                existingData = JSON.parse(content);
            } catch {
                // ignore
            }
        }

        // 构建 tokens 对象
        const tokensUpdate: Record<string, unknown> = {};
        if (credentials.access_token) {
            tokensUpdate.access_token = credentials.access_token;
        }
        if (credentials.refresh_token) {
            tokensUpdate.refresh_token = credentials.refresh_token;
        }
        if (credentials.id_token) {
            tokensUpdate.id_token = credentials.id_token;
        }
        if (credentials.account_id) {
            tokensUpdate.account_id = credentials.account_id;
        }

        // 合并 tokens（保留原有的其他字段）
        const mergedTokens = {
            ...existingData.tokens,
            ...tokensUpdate
        };

        // 构建最终数据
        const mergedData = {
            ...existingData,
            tokens: mergedTokens,
            last_refresh: new Date().toISOString()
        };

        // 确保目录存在
        const dir = path.dirname(credentialPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        await this.writeJsonFileAtomically(credentialPath, mergedData);
    }

    /**
     * 刷新 Codex CLI 访问令牌（OAuth 2.0 refresh_token）
     */
    protected async refreshAccessToken(
        credentials: OAuthCredentials,
        credentialPath: string
    ): Promise<OAuthCredentials> {
        if (!credentials.refresh_token) {
            throw new Error('Codex CLI OAuth credentials are missing refresh_token and cannot refresh the token');
        }

        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: this.config.clientId
        });

        const tokenRes = await this.fetchWithProxy(this.config.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        // 无论成功或失败都先读取文本，便于打印更友好的错误信息
        const rawText = await tokenRes.text();

        /** OAuth 令牌响应 */
        interface TokenResponse {
            access_token?: string;
            expires_in?: number;
            refresh_token?: string;
            token_type?: string;
            id_token?: string;
            error?: {
                type: string;
                code: string;
                param?: string;
                message: string;
            };
        }

        let responseData: TokenResponse = {};
        try {
            responseData = JSON.parse(rawText) as TokenResponse;
        } catch {
            // ignore
        }

        if (!tokenRes.ok) {
            const errorMsg = responseData.error?.message || rawText || 'unknown error';
            throw new Error(`Codex CLI token refresh failed (${tokenRes.status}): ${errorMsg}`);
        }

        const accessToken = responseData.access_token || '';
        const expiresIn = responseData.expires_in ?? 0;
        const refreshToken = responseData.refresh_token || credentials.refresh_token;

        if (!accessToken) {
            throw new Error('Codex CLI OAuth refresh response is missing access_token');
        }

        // 正常情况下 OpenAI 总会返回 expires_in；缺失时保留原 expiry_date（避免立即进入刷新循环）
        const expiryDate =
            expiresIn > 0 ? Date.now() + expiresIn * 1000 : credentials.expiry_date || Date.now() + 23 * 60 * 60 * 1000;

        const previousCredentials = credentials as CodexOAuthCredentials;
        const idTokenClaims = this.extractIdTokenClaims(responseData.id_token);
        // 身份字段优先取刷新响应的新 id_token，缺失时保留原值（避免刷新丢失账号身份）
        const email = idTokenClaims?.email ?? previousCredentials.email;
        const planType = idTokenClaims?.planType ?? previousCredentials.plan_type;
        const newCredentials: CodexOAuthCredentials = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_date: expiryDate,
            account_id: idTokenClaims?.accountId ?? previousCredentials.account_id,
            ...(email ? { email } : {}),
            ...(planType ? { plan_type: planType } : {})
        };

        // 保存刷新后的凭证
        await this.saveCredentials(
            {
                access_token: accessToken,
                refresh_token: refreshToken,
                id_token: responseData.id_token,
                account_id: newCredentials.account_id,
                ...(newCredentials.email ? { email: newCredentials.email } : {}),
                ...(newCredentials.plan_type ? { plan_type: newCredentials.plan_type } : {}),
                expiry_date: expiryDate
            },
            credentialPath,
            credentials
        );

        Logger.info('[Codex] Token refresh succeeded');
        return newCredentials;
    }

    /**
     * 构建 oauth 文件夹归一化凭证记录：附带 ChatGPT 账户 ID 与账号身份信息
     */
    override toOAuthStoreRecord(credentials: OAuthCredentials): Record<string, unknown> {
        const record = super.toOAuthStoreRecord(credentials);
        const extended = credentials as CodexOAuthCredentials;
        for (const key of ['account_id', 'email', 'plan_type'] as const) {
            const value = extended[key];
            if (typeof value === 'string' && value) {
                record[key] = value;
            }
        }
        return record;
    }

    /**
     * 导入迁移后移除 CLI 默认目录中的 OAuth 凭证：
     * 仅删除 tokens 与 last_refresh，保留 OPENAI_API_KEY 等无关字段；无剩余字段时删除整文件
     */
    override async removeCliNativeCredential(): Promise<void> {
        const cliPath = this.getCliNativeCredentialPath();
        if (!fs.existsSync(cliPath)) {
            return;
        }
        const content = fs.readFileSync(cliPath, 'utf-8');
        const data = JSON.parse(content) as Record<string, unknown>;
        delete data.tokens;
        delete data.last_refresh;
        if (Object.keys(data).length === 0) {
            fs.unlinkSync(cliPath);
        } else {
            await this.writeJsonFileAtomically(cliPath, data);
        }
        this.invalidateCredentialCache();
        Logger.info(`[${this.config.name}] CLI native OAuth tokens removed: ${cliPath}`);
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
     * 加载凭证后的额外处理
     * Codex CLI 的 auth.json 把令牌信息存在 tokens 对象中
     */
    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        // 检查是否是 Codex CLI 的嵌套格式
        const rawData = credentials as unknown as {
            tokens?: {
                access_token?: string;
                refresh_token?: string;
                id_token?: string;
                account_id?: string;
            };
            last_refresh?: string;
        };

        // 如果存在 tokens 对象，提取其中的字段
        if (rawData.tokens) {
            const tokens = rawData.tokens;
            const idTokenClaims = this.extractIdTokenClaims(tokens.id_token);
            const result: CodexOAuthCredentials = {
                access_token: tokens.access_token || '',
                refresh_token: tokens.refresh_token || '',
                expiry_date: 0,
                account_id: tokens.account_id || idTokenClaims?.accountId,
                ...(idTokenClaims?.email ? { email: idTokenClaims.email } : {}),
                ...(idTokenClaims?.planType ? { plan_type: idTokenClaims.planType } : {})
            };

            // 尝试从 access_token (JWT) 中解析过期时间
            if (tokens.access_token) {
                const expFromToken = this.extractExpFromIdToken(tokens.access_token);
                if (expFromToken) {
                    result.expiry_date = expFromToken;
                }
            }

            // 如果没有从 JWT 解析到过期时间，尝试从 last_refresh 推断
            if (!result.expiry_date && rawData.last_refresh) {
                const lastRefresh = new Date(rawData.last_refresh).getTime();
                if (!isNaN(lastRefresh)) {
                    // Codex access_token 约 10 天有效，从 last_refresh 推算（预留1小时缓冲）
                    result.expiry_date = lastRefresh + 23 * 60 * 60 * 1000;
                }
            }

            Logger.debug(
                `[${this.config.name}] Loaded credentials from tokens object, account_id: ${result.account_id}`
            );
            return result;
        }

        return credentials;
    }

    /**
     * 从 id_token (JWT) 中提取过期时间
     */
    private extractExpFromIdToken(idToken: string): number | undefined {
        try {
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return undefined;
            }
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: number };
            if (typeof payload.exp === 'number') {
                return payload.exp * 1000; // 转换为毫秒
            }
        } catch {
            // ignore
        }
        return undefined;
    }

    /**
     * 从 id_token (JWT) 中提取账号身份信息：ChatGPT account_id、邮箱与订阅计划类型
     */
    private extractIdTokenClaims(
        idToken: unknown
    ): { accountId?: string; email?: string; planType?: string } | undefined {
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
                email?: string;
                chatgpt_account_id?: string;
                'https://api.openai.com/auth'?: {
                    chatgpt_account_id?: string;
                    chatgpt_plan_type?: string;
                };
                organizations?: Array<{ id: string }>;
            };
            // 优先使用 https://api.openai.com/auth 命名空间下的 chatgpt_account_id
            const authData = payload['https://api.openai.com/auth'];
            let accountId: string | undefined;
            if (typeof authData?.chatgpt_account_id === 'string' && authData.chatgpt_account_id) {
                accountId = authData.chatgpt_account_id;
            } else if (typeof payload.chatgpt_account_id === 'string' && payload.chatgpt_account_id) {
                // 兼容直接放在顶层的 chatgpt_account_id
                accountId = payload.chatgpt_account_id;
            } else if (Array.isArray(payload.organizations) && payload.organizations.length > 0) {
                const firstOrg = payload.organizations[0];
                if (typeof firstOrg?.id === 'string' && firstOrg.id) {
                    accountId = firstOrg.id;
                }
            }
            const email = typeof payload.email === 'string' && payload.email ? payload.email : undefined;
            const planType =
                typeof authData?.chatgpt_plan_type === 'string' && authData.chatgpt_plan_type ?
                    authData.chatgpt_plan_type
                :   undefined;
            return { accountId, email, planType };
        } catch {
            Logger.debug('[Codex] Failed to parse id_token');
        }
        return undefined;
    }

    /**
     * 依据账号身份派生凭证名（同 CLIProxyAPI 的 codex 命名）：
     * <sha256(account_id)前8位>-<email>-<plan>，缺失段逐层省略；
     * 邮箱与 account_id 均不可用时回退基类的令牌哈希命名
     */
    override suggestCredentialName(credentials: OAuthCredentials): string {
        const extended = credentials as CodexOAuthCredentials;
        const accountId = extended.account_id?.trim() ?? '';
        const email = extended.email?.trim() ?? '';
        if (!accountId && !email) {
            return super.suggestCredentialName(credentials);
        }
        const hashPart = accountId ? createHash('sha256').update(accountId).digest('hex').slice(0, 8) : '';
        const planPart = this.normalizePlanTypeForName(extended.plan_type);
        const emailPart = this.sanitizeCredentialSegment(email, 64);
        let name = [hashPart, emailPart, planPart].filter(Boolean).join('-');
        if (name.length > 64 && emailPart) {
            // 超长时截断 email 段，保留账号哈希与计划后缀
            const fixedLength = name.length - emailPart.length;
            const emailBudget = Math.max(1, 64 - fixedLength);
            name = [hashPart, emailPart.slice(0, emailBudget), planPart].filter(Boolean).join('-');
        }
        return name.slice(0, 64);
    }

    /** 归一化计划类型用于凭证名（同 CLIProxyAPI：按非字母数字分段、转小写后以 - 连接） */
    private normalizePlanTypeForName(planType: string | undefined): string {
        const trimmed = planType?.trim() ?? '';
        if (!trimmed) {
            return '';
        }
        return trimmed
            .split(/[^A-Za-z0-9]+/)
            .filter(part => part.length > 0)
            .map(part => part.toLowerCase())
            .join('-');
    }
}
