/*---------------------------------------------------------------------------------------------
 *  CLI 认证基类
 *  提供通用的 CLI 认证功能
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { Logger } from '../../utils/runtime/logger';
import { ConfigManager } from '../../utils/config/configManager';
import { isNoProxyValue } from '../../utils/net/proxyAgent';
import { CliAuthConfig, OAuthCredentials } from '../type';
import { OAuthCredentialStore } from './oauthCredentialStore';
import { writeJsonFileAtomically } from './jsonFileIO';

const proxyEnvKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const;

/**
 * CLI 认证基类
 * 提供通用的认证功能，具体提供商实现继承此类
 */
export abstract class BaseCliAuth {
    private cachedCredentials: { data: OAuthCredentials; timestamp: number; path: string } | null = null;
    private readonly credentialPaths = new WeakMap<OAuthCredentials, string>();
    private readonly refreshPromises = new Map<string, Promise<OAuthCredentials>>();

    constructor(protected config: CliAuthConfig) {}

    /**
     * 获取 API 访问令牌
     */
    async getApiKey(forceRefresh = false): Promise<string | null> {
        const credentials = await this.ensureAuthenticated(forceRefresh);
        return credentials?.access_token ?? null;
    }

    /**
     * 加载 CLI OAuth 凭证
     * 路径按优先级解析：oauth 文件夹活跃凭证 > CLI 默认目录；
     * 缓存绑定解析路径，切换活跃凭证后自动重载
     */
    async loadCredentials(): Promise<OAuthCredentials | null> {
        return await this.loadCredentialsFromPath(this.resolveCredentialFilePath());
    }

    /** 按指定文件路径加载凭证；由工厂仅对已识别的命名凭证路径调用 */
    async loadCredentialsFromPath(credentialPath: string): Promise<OAuthCredentials | null> {
        try {
            if (!fs.existsSync(credentialPath)) {
                Logger.trace(`[${this.config.name}] Credential file does not exist: ${credentialPath}`);
                return null;
            }

            const stat = fs.statSync(credentialPath);
            if (
                this.cachedCredentials &&
                this.cachedCredentials.path === credentialPath &&
                this.cachedCredentials.timestamp >= stat.mtimeMs
            ) {
                return this.cachedCredentials.data;
            }

            const processedCredentials = await this.readCredentialsFile(credentialPath);
            Logger.info(`[${this.config.name}] Credentials loaded`);

            this.credentialPaths.set(processedCredentials, credentialPath);
            this.cachedCredentials = {
                data: processedCredentials,
                timestamp: stat.mtimeMs,
                path: credentialPath
            };
            return processedCredentials;
        } catch (error) {
            Logger.error(`[${this.config.name}] Failed to load credentials:`, error);
            return null;
        }
    }

    /**
     * 读取并解析凭证文件（不含缓存），子类经 afterLoadCredentials 归一化
     */
    protected async readCredentialsFile(credentialPath: string): Promise<OAuthCredentials> {
        const content = fs.readFileSync(credentialPath, 'utf-8');
        const credentials = JSON.parse(content) as OAuthCredentials;
        // 允许子类在加载凭证后进行额外处理
        return await this.afterLoadCredentials(credentials);
    }

    /**
     * 读取 CLI 默认目录凭证（导入迁移用），不受 oauth 文件夹影响
     */
    async loadCliNativeCredentials(): Promise<OAuthCredentials | null> {
        const cliPath = this.getCliNativeCredentialPath();
        try {
            if (!fs.existsSync(cliPath)) {
                return null;
            }
            const credentials = await this.readCredentialsFile(cliPath);
            this.credentialPaths.set(credentials, cliPath);
            return credentials;
        } catch (error) {
            Logger.error(`[${this.config.name}] Failed to load CLI native credentials:`, error);
            return null;
        }
    }

    /**
     * 确保认证有效（自动刷新过期令牌）
     */
    async ensureAuthenticated(forceRefresh = false): Promise<OAuthCredentials | null> {
        let credentials = await this.loadCredentials();
        if (!credentials) {
            // Logger.info(`[${this.config.name}] 未认证，请先运行 CLI 登录`);
            return null;
        }

        const needsRefresh = forceRefresh || this.isExpired(credentials);
        if (needsRefresh && credentials.refresh_token) {
            try {
                credentials = await this.refreshCredentials(credentials, forceRefresh);
                Logger.info(`[${this.config.name}] Token refreshed`);
            } catch (error) {
                Logger.error(`[${this.config.name}] Failed to refresh token:`, error);
                return null;
            }
        }

        if (forceRefresh && !credentials.refresh_token) {
            Logger.warn(`[${this.config.name}] Credentials are missing refresh_token and cannot be force refreshed`);
            return null;
        }

        return credentials;
    }

    /** 按指定凭证路径确保认证，不因活跃账号变化而改查其他账号 */
    async ensureAuthenticatedFromPath(credentialPath: string, forceRefresh = false): Promise<OAuthCredentials | null> {
        const credentials = await this.loadCredentialsFromPath(credentialPath);
        if (!credentials) {
            return null;
        }

        const needsRefresh = forceRefresh || this.isExpired(credentials);
        if (needsRefresh && credentials.refresh_token) {
            return await this.refreshCredentials(credentials, forceRefresh, false);
        }
        if (forceRefresh && !credentials.refresh_token) {
            return null;
        }
        return credentials;
    }

    /**
     * 刷新访问令牌（当前进程内单飞）
     * @param credentials 可选的已知凭证；缺省时从文件加载
     * @param forceRefresh 强制走网络刷新，跳过写前双检
     */
    async refreshCredentials(
        credentials?: OAuthCredentials,
        forceRefresh = false,
        followActiveCredential = true
    ): Promise<OAuthCredentials> {
        const currentCredentials = credentials ?? (await this.loadCredentials());
        if (!currentCredentials?.refresh_token) {
            throw new Error(`${this.config.name} credentials are missing refresh_token and cannot refresh`);
        }

        const credentialPath = this.credentialPaths.get(currentCredentials) ?? this.resolveCredentialFilePath();
        this.credentialPaths.set(currentCredentials, credentialPath);
        const inFlightRefresh = this.refreshPromises.get(credentialPath);
        let refreshPromise = inFlightRefresh;
        if (!refreshPromise) {
            refreshPromise = (async () => {
                // 写前双检：跨窗口并发时另一窗口可能已完成刷新并落盘，此时直接复用文件里的新 token，
                // 避免用旧 refresh_token 重复 POST（服务端轮换/重放防护可能使整族凭证失效）
                let effectiveCredentials = currentCredentials;
                if (!forceRefresh) {
                    this.invalidateCredentialCache();
                    const latest =
                        fs.existsSync(credentialPath) ? await this.readCredentialsFile(credentialPath) : null;
                    if (latest) {
                        this.credentialPaths.set(latest, credentialPath);
                    }
                    if (latest && !this.isExpired(latest)) {
                        return latest;
                    }
                    if (latest?.refresh_token) {
                        effectiveCredentials = latest;
                    }
                }
                const refreshedCredentials = await this.refreshAccessToken(effectiveCredentials, credentialPath);
                this.credentialPaths.set(refreshedCredentials, credentialPath);
                this.invalidateCredentialCache();
                if (!fs.existsSync(credentialPath)) {
                    if (this.isOAuthCredentialPath(credentialPath)) {
                        throw new Error('OAuth credential was deleted during token refresh');
                    }
                    return refreshedCredentials;
                }

                const stat = fs.statSync(credentialPath);
                const reloadedCredentials = await this.readCredentialsFile(credentialPath);
                this.credentialPaths.set(reloadedCredentials, credentialPath);
                this.cachedCredentials = { data: reloadedCredentials, timestamp: stat.mtimeMs, path: credentialPath };
                return reloadedCredentials;
            })();
            this.refreshPromises.set(credentialPath, refreshPromise);
        }

        try {
            const refreshedCredentials = await refreshPromise;
            return await this.followActiveCredentialAfterRefresh(
                refreshedCredentials,
                credentialPath,
                followActiveCredential
            );
        } finally {
            if (this.refreshPromises.get(credentialPath) === refreshPromise) {
                this.refreshPromises.delete(credentialPath);
            }
        }
    }

    private async followActiveCredentialAfterRefresh(
        refreshedCredentials: OAuthCredentials,
        credentialPath: string,
        followActiveCredential: boolean
    ): Promise<OAuthCredentials> {
        if (!followActiveCredential || this.resolveCredentialFilePath() === credentialPath) {
            return refreshedCredentials;
        }

        const activeCredentials = await this.loadCredentials();
        if (!activeCredentials) {
            throw new Error('Active credential changed during token refresh and could not be loaded');
        }
        if (activeCredentials.refresh_token && this.isExpired(activeCredentials)) {
            return await this.refreshCredentials(activeCredentials);
        }
        return activeCredentials;
    }

    /**
     * 使凭证缓存失效，强制下次从文件重新加载
     */
    invalidateCredentialCache(): void {
        this.cachedCredentials = null;
    }

    /**
     * 判断凭证是否已过期（只读，不触发网络刷新）
     * 各子类按自身 token 有效期覆写缓冲时间
     * 默认提前 1 小时刷新
     */
    isExpired(credentials: OAuthCredentials): boolean {
        return credentials.expiry_date ? credentials.expiry_date < Date.now() + this.getExpiryBufferMs() : false;
    }

    /**
     * 过期缓冲时间（毫秒），子类可按需覆写
     */
    protected getExpiryBufferMs(): number {
        return 60 * 60 * 1000; // 默认 1 小时
    }

    /**
     * 刷新访问令牌（由子类实现）
     */
    protected abstract refreshAccessToken(
        credentials: OAuthCredentials,
        credentialPath: string
    ): Promise<OAuthCredentials>;

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
                timeout: 5000,
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
        return ConfigManager.fetchWithProxy(input, init, { proxyUrl: this.getProxyUrl(), skipHar: true });
    }

    /**
     * 获取 CLI 子进程环境变量（注入代理设置）
     */
    getCliProcessEnv(): NodeJS.ProcessEnv {
        const proxyUrl = this.getProxyUrl();
        const env = { ...process.env };

        if (!proxyUrl) {
            return env;
        }

        if (isNoProxyValue(proxyUrl)) {
            for (const key of proxyEnvKeys) {
                delete env[key];
            }

            return {
                ...env,
                NO_PROXY: '*',
                no_proxy: '*'
            };
        }

        return {
            ...env,
            HTTP_PROXY: proxyUrl,
            HTTPS_PROXY: proxyUrl,
            http_proxy: proxyUrl,
            https_proxy: proxyUrl,
            ALL_PROXY: proxyUrl,
            all_proxy: proxyUrl
        };
    }

    /**
     * 获取当前生效凭证文件的完整路径（oauth 文件夹优先，其次 CLI 默认目录）
     */
    getCredentialPath(): string {
        return this.resolveCredentialFilePath();
    }

    /**
     * 获取 CLI 默认目录的凭证文件路径（不受 oauth 文件夹影响）
     */
    getCliNativeCredentialPath(): string {
        return this.resolvePath(this.config.credentialPathPattern);
    }

    /**
     * 当前是否使用 oauth 文件夹中的命名凭证
     */
    isOAuthCredentialActive(): boolean {
        return (
            !BaseCliAuth.credentialPathOverride &&
            OAuthCredentialStore.resolveActiveCredentialPath(this.config.providerKey) !== undefined
        );
    }

    /** 判断路径是否为当前 provider 在 oauth 文件夹下的命名凭证文件 */
    protected isOAuthCredentialPath(credentialPath: string): boolean {
        const oauthDir = OAuthCredentialStore.getOAuthDir();
        if (!oauthDir) {
            return false;
        }
        const resolvedPath = path.resolve(credentialPath);
        const fileName = path.basename(resolvedPath);
        return (
            path.dirname(resolvedPath) === path.resolve(oauthDir) &&
            fileName.startsWith(`${this.config.providerKey}-`) &&
            fileName.endsWith('.json')
        );
    }

    /**
     * 构建用于导入 oauth 文件夹的归一化凭证记录，子类可追加扩展字段（如 account_id）
     */
    toOAuthStoreRecord(credentials: OAuthCredentials): Record<string, unknown> {
        return {
            type: this.config.providerKey,
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token,
            expiry_date: credentials.expiry_date
        };
    }

    /**
     * 依据凭证中的账号身份派生 oauth 文件夹凭证名（同 CLIProxyAPI 的命名方式）。
     * 子类按 provider 的身份字段（email、账户 ID 等）覆写；
     * 默认以令牌哈希兜底，保证同一凭证重复导入得到相同的名字（同名覆盖即更新）。
     */
    suggestCredentialName(credentials: OAuthCredentials): string {
        const digestSource = credentials.refresh_token || credentials.access_token || '';
        const hash = createHash('sha256').update(digestSource).digest('hex').slice(0, 8);
        return `account-${hash}`;
    }

    /** 清理凭证名片段：不允许的字符替换为 _，并截断到 maxLength */
    protected sanitizeCredentialSegment(raw: string, maxLength: number): string {
        return raw.replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, maxLength);
    }

    /**
     * 导入迁移后移除 CLI 默认目录中的 OAuth 凭证。
     * 默认实现删除整个凭证文件；子类可按文件格式选择性删除，保留无关字段。
     */
    async removeCliNativeCredential(): Promise<void> {
        const cliPath = this.getCliNativeCredentialPath();
        if (fs.existsSync(cliPath)) {
            fs.unlinkSync(cliPath);
            Logger.info(`[${this.config.name}] CLI native credential removed: ${cliPath}`);
        }
        this.invalidateCredentialCache();
    }

    /**
     * 获取 CLI 命令名（如 codex / grok），供面板等外部调用打开终端登录
     */
    getCliCommand(): string {
        return this.config.cliCommand;
    }

    /** 测试注入用：覆盖所有 CLI 凭证文件的解析路径 */
    private static credentialPathOverride: string | undefined;

    /** 仅测试使用：固定凭证文件路径，避免读写真实 ~/.codex/auth.json 等文件 */
    static setCredentialPathOverride(path: string | undefined): void {
        BaseCliAuth.credentialPathOverride = path;
    }

    /**
     * 解析当前生效的凭证文件路径：
     * 1. 测试注入的固定路径；2. oauth 文件夹活跃凭证；3. CLI 默认目录
     */
    protected resolveCredentialFilePath(): string {
        if (BaseCliAuth.credentialPathOverride) {
            return BaseCliAuth.credentialPathOverride;
        }
        const oauthPath = OAuthCredentialStore.resolveActiveCredentialPath(this.config.providerKey);
        if (oauthPath) {
            return oauthPath;
        }
        return this.resolvePath(this.config.credentialPathPattern);
    }

    /**
     * 解析路径模式，支持 ~ 展开
     */
    protected resolvePath(pattern: string): string {
        if (BaseCliAuth.credentialPathOverride) {
            return BaseCliAuth.credentialPathOverride;
        }
        if (pattern.startsWith('~')) {
            return path.join(os.homedir(), pattern.slice(1));
        }
        return pattern;
    }

    /**
     * 保存凭证到当前生效文件（差分更新，保留文件中已有的其他字段）。
     * oauth 文件夹命名凭证使用归一化平铺格式，子类原生格式分支前应先判断 isOAuthCredentialActive。
     */
    protected async saveCredentials(
        credentials: Partial<OAuthCredentials> & Record<string, unknown>,
        credentialPath = this.resolveCredentialFilePath(),
        expectedCredentials?: OAuthCredentials
    ): Promise<void> {
        const save = async (): Promise<void> => {
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
            await this.writeJsonFileAtomically(credentialPath, mergedData);
        };

        if (this.isOAuthCredentialPath(credentialPath)) {
            await OAuthCredentialStore.withCredentialFileLock(credentialPath, async () => {
                if (!fs.existsSync(credentialPath)) {
                    throw new Error('OAuth credential was deleted before refreshed credentials could be saved');
                }
                if (expectedCredentials) {
                    const currentCredentials = await this.readCredentialsFile(credentialPath);
                    const versionKeys = [
                        'access_token',
                        'refresh_token',
                        'expiry_date',
                        'account_id',
                        'email',
                        'plan_type',
                        'oidc_client_id',
                        'user_id',
                        'team_id'
                    ] as const;
                    const currentValues = currentCredentials as OAuthCredentials & Record<string, unknown>;
                    const expectedValues = expectedCredentials as OAuthCredentials & Record<string, unknown>;
                    const changed = versionKeys.some(key => currentValues[key] !== expectedValues[key]);
                    if (changed) {
                        throw new Error('OAuth credential changed while refreshed credentials were in flight');
                    }
                }
                await save();
            });
            return;
        }
        await save();
    }

    /**
     * 原子写入 JSON 文件（委托共享实现），成功后使凭证缓存失效
     */
    protected async writeJsonFileAtomically(filePath: string, data: unknown): Promise<void> {
        await writeJsonFileAtomically(filePath, data);
        this.invalidateCredentialCache();
    }
}
