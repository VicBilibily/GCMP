/*---------------------------------------------------------------------------------------------
 *  CLI 认证基类
 *  提供通用的 CLI 认证功能
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { Logger } from '../../utils/logger';
import { ConfigManager } from '../../utils/configManager';
import { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * CLI 认证基类
 * 提供通用的认证功能，具体提供商实现继承此类
 */
export abstract class BaseCliAuth {
    private cachedCredentials: { data: OAuthCredentials; timestamp: number } | null = null;

    constructor(protected config: CliAuthConfig) {}

    /**
     * 获取 API 访问令牌
     */
    async getApiKey(forceRefresh = false): Promise<string | null> {
        const credentials = await this.ensureAuthenticated();
        if (credentials) {
            if (forceRefresh) {
                const refreshedCredentials = await this.refreshAccessToken(credentials);
                return refreshedCredentials.access_token;
            }
            return credentials.access_token;
        }
        return null;
    }

    /**
     * 加载 CLI OAuth 凭证
     */
    async loadCredentials(): Promise<OAuthCredentials | null> {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);
        try {
            if (!fs.existsSync(credentialPath)) {
                Logger.trace(`[${this.config.name}] Credential file does not exist: ${credentialPath}`);
                return null;
            }

            const stat = fs.statSync(credentialPath);
            if (this.cachedCredentials && this.cachedCredentials.timestamp >= stat.mtimeMs) {
                return this.cachedCredentials.data;
            }

            const content = fs.readFileSync(credentialPath, 'utf-8');
            const credentials = JSON.parse(content) as OAuthCredentials;
            // 允许子类在加载凭证后进行额外处理
            const processedCredentials = await this.afterLoadCredentials(credentials);
            Logger.info(`[${this.config.name}] Credentials loaded`);

            this.cachedCredentials = {
                data: processedCredentials,
                timestamp: stat.mtimeMs
            };
            return processedCredentials;
        } catch (error) {
            Logger.error(`[${this.config.name}] Failed to load credentials:`, error);
            return null;
        }
    }

    /**
     * 确保认证有效（自动刷新过期令牌）
     */
    async ensureAuthenticated(): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            // Logger.info(`[${this.config.name}] 未认证，请先运行 CLI 登录`);
            return null;
        }

        // 检查令牌是否过期（提前 1 小时刷新，避免临界点）
        const expiryBuffer = 60 * 60 * 1000; // 1 小时缓冲
        const isExpired = credentials.expiry_date ? credentials.expiry_date < Date.now() + expiryBuffer : false;
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

    /**
     * 刷新访问令牌（由子类实现）
     */
    protected abstract refreshAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

    /**
     * 加载凭证后的额外处理（由子类可选实现）
     */
    protected async afterLoadCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
    }

    /**
     * 检查 CLI 是否已安装
     */
    async isCliInstalled(): Promise<boolean> {
        try {
            execSync(`${this.config.cliCommand} --version`, {
                stdio: 'ignore',
                env: this.getCliProcessEnv()
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 获取当前 CLI provider 对应的代理地址
     */
    protected getProxyUrl(): string | undefined {
        return ConfigManager.resolveProxyForModel(undefined, this.config.providerKey);
    }

    /**
     * 通过当前 provider 对应的代理配置发送请求
     */
    protected fetchWithProxy(input: string | URL | Request, init?: RequestInit): Promise<Response> {
        return ConfigManager.fetchWithProxy(input, init, { proxyUrl: this.getProxyUrl() });
    }

    /**
     * 获取 CLI 子进程环境变量（注入代理设置）
     */
    getCliProcessEnv(): NodeJS.ProcessEnv {
        const proxyUrl = this.getProxyUrl();
        if (!proxyUrl) {
            return { ...process.env };
        }

        return {
            ...process.env,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            ALL_PROXY: proxyUrl,
            all_proxy: proxyUrl
        };
    }

    /**
     * 获取凭证文件的完整路径
     */
    getCredentialPath(): string {
        return this.resolvePath(this.config.credentialPathPattern);
    }

    /**
     * 解析路径模式，支持 ~ 展开
     */
    protected resolvePath(pattern: string): string {
        if (pattern.startsWith('~')) {
            return path.join(os.homedir(), pattern.slice(1));
        }
        return pattern;
    }

    /**
     * 保存凭证到文件（差分更新，保留文件中已有的其他字段）
     */
    protected saveCredentials(credentials: Partial<OAuthCredentials>): void {
        const credentialPath = this.resolvePath(this.config.credentialPathPattern);

        // 读取现有凭证文件，保留已有字段
        let existingData: Record<string, unknown> = {};
        if (fs.existsSync(credentialPath)) {
            try {
                const content = fs.readFileSync(credentialPath, 'utf-8');
                existingData = JSON.parse(content);
            } catch (error) {
                Logger.warn(
                    `[${this.config.name}] Failed to read existing credential file, it will be overwritten:`,
                    error
                );
            }
        }

        // 过滤掉 null/undefined 的值，只保留有效值
        const validCredentials: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(credentials)) {
            if (value !== null && value !== undefined) {
                validCredentials[key] = value;
            }
        }

        // 合并新凭证和现有数据
        const mergedData = { ...existingData, ...validCredentials };
        // 确保目录存在
        const dir = path.dirname(credentialPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(credentialPath, JSON.stringify(mergedData, null, 2));
    }
}
