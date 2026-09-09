/**
 * GitHub Gist 同步服务
 * 为配置集同步提供 GitHub 认证、Gist IO 与加密原语等基础设施
 * 通过 VS Code 内置的 GitHub 认证获取 access token，使用 AES-256-GCM 对 API Key 数据进行加密
 * 密钥派生：使用 scrypt
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/runtime/logger';
import { ConfigManager } from '../utils/config/configManager';
import { KnownProviders } from '../utils/config/knownProviders';
import {
    createBatchEncryptor as cryptoCreateBatchEncryptor,
    createBatchDecryptor as cryptoCreateBatchDecryptor,
    type BatchDecryptor,
    type BatchEncryptor
} from './syncCrypto';

/** GlobalState 中存储配置集同步 Gist ID 的键名 */
const CONFIGSET_GIST_ID_KEY = 'gcmp-configsets.gistId';

/** GlobalState 中存储 GitHub 用户名的键名 */
const GITHUB_USER_KEY = 'gcmp-sync.githubUser';

/** GlobalState 中存储 GitHub 用户数字 ID 的键名（用于派生加密密钥） */
const GITHUB_ID_KEY = 'gcmp-sync.githubId';

/** SecretStorage 中存储用户自定义加密口令的键名 */
const USER_PASSPHRASE_KEY = 'gcmp-sync.passphrase';

/** 允许的 Gist 原始域名 */
const ALLOWED_GIST_RAW_HOSTS = new Set(['gist.githubusercontent.com', 'api.github.com']);

/** 所有已知密钥的显示名（主 key + 多密钥变体，英文名与 ConfigProvider.displayName 一致） */
export const KNOWN_KEY_LABELS: Record<string, string> = {
    // ── 主 key ──
    zhipu: 'ZhipuAI',
    moonshot: 'MoonshotAI',
    kimi: 'Kimi',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    dashscope: 'AliDashScope',
    tencent: 'Tencent',
    volcengine: 'Volcengine',
    xiaomimimo: 'Xiaomi MiMo',
    baidu: 'Baidu Qianfan',
    antling: 'AntLing',
    stepfun: 'StepFun',
    opencode: 'OpenCode',
    hyper: 'Charm Hyper',
    clinepass: 'ClinePass',
    // ── 多密钥变体 ──
    'minimax-token': 'MiniMax Token Plan',
    'dashscope-coding': 'DashScope Coding Plan',
    'dashscope-token': 'DashScope Token Plan (Team)',
    'dashscope-token-personal': 'DashScope Token Plan (Personal)',
    'tencent-token': 'Tencent Cloud Token Plan',
    'tencent-tokenhub': 'Tencent Cloud TokenHub',
    'tencent-token-enterprise': 'Tencent Cloud Token Plan Enterprise',
    'volcengine-agent': 'Volcengine Agent Plan',
    'xiaomimimo-token': 'Xiaomi MiMo Token Plan',
    'baidu-token': 'Baidu Qianfan Token Plan',
    'baidu-token-enterprise': 'Baidu Qianfan Token Plan Enterprise',
    'xfyun-coding': 'XunFei Astron Coding Plan',
    'xfyun-token': 'XunFei Astron Token Plan'
};

/**
 * 获取密钥对应的友好显示名
 * 优先级：KNOWN_KEY_LABELS 覆盖 > ConfigProvider.displayName > KnownProviders.displayName > providerKey
 */
export function getKeyDisplayName(key: string): string {
    const provider = key.replace('.apiKey', '');

    // 1) 覆盖名称
    const label = KNOWN_KEY_LABELS[provider];
    if (label) {
        return label;
    }

    // 2) ConfigProvider 名称
    const providerConfigs = ConfigManager.getConfigProvider();
    const cfg = providerConfigs[provider as keyof typeof providerConfigs];
    if (cfg?.displayName) {
        return cfg.displayName;
    }

    // 3) KnownProviders 名称
    const known = KnownProviders[provider]?.displayName;
    if (known) {
        return known;
    }

    return provider;
}

/**
 * Gist 同步服务
 */
export class GistSyncService {
    private static context: vscode.ExtensionContext;

    /**
     * 初始化同步服务
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    // ==================== GitHub 认证 ====================

    /**
     * 获取 GitHub 认证 session（带 gist scope）
     * @param silent 静默模式：true 仅返回已有 session，false 会弹出授权框
     */
    private static async getSession(
        silent: boolean
    ): Promise<{ token: string; account: vscode.AuthenticationSessionAccountInformation } | undefined> {
        try {
            const session = await vscode.authentication.getSession('github', ['gist'], {
                silent,
                createIfNone: !silent
            });
            if (session) {
                return { token: session.accessToken, account: session.account };
            }
            return undefined;
        } catch (error) {
            Logger.error(`[GistSync] Failed to get GitHub session (silent=${silent}):`, error);
            return undefined;
        }
    }

    /**
     * 获取用户身份信息（登录名 + 数字 ID）
     * @param silent 静默模式：true 仅返回已有 session，false 会弹出授权框
     */
    static async getUserInfo(silent: boolean): Promise<{ login: string; id: number; token: string } | undefined> {
        const result = await this.getSession(silent);
        if (!result) {
            return undefined;
        }
        return await this.fetchAndSaveUserInfo(result.token);
    }

    /**
     * 检查用户当前是否已登录 GitHub（不弹出界面）
     */
    static async isLoggedIn(): Promise<boolean> {
        const result = await this.getSession(true);
        return result !== undefined;
    }

    /**
     * 用 token 调用 GitHub API 获取用户信息并存为加密密钥凭据
     */
    private static async fetchAndSaveUserInfo(
        token: string
    ): Promise<{ login: string; id: number; token: string } | undefined> {
        try {
            const response = await ConfigManager.fetchWithProxy(
                'https://api.github.com/user',
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github.v3+json',
                        'User-Agent': 'GCMP-VSCode-Extension'
                    }
                },
                { skipHar: true }
            );

            if (!response.ok) {
                Logger.warn(`[GistSync] GitHub API user call failed: ${response.status}`);
                return undefined;
            }

            const data = (await response.json()) as { login: string; id: number };
            await this.context.globalState.update(GITHUB_USER_KEY, data.login);
            await this.context.globalState.update(GITHUB_ID_KEY, String(data.id));

            return { login: data.login, id: data.id, token };
        } catch (error) {
            Logger.error('[GistSync] Failed to get GitHub user info:', error);
            return undefined;
        }
    }

    // ==================== Gist ID 管理 ====================

    /** 获取配置集同步使用的 Gist ID */
    static getConfigSetGistId(): string | undefined {
        return this.context.globalState.get<string>(CONFIGSET_GIST_ID_KEY);
    }

    /**
     * 获取 GitHub 用户名
     */
    static getGithubUser(): string | undefined {
        return this.context.globalState.get<string>(GITHUB_USER_KEY);
    }

    // ==================== GitHub API 调用 ====================

    /**
     * 解析 Gist 文件正文：截断或缺 content 时按 raw_url 补拉，失败返回 undefined。
     */
    static async resolveGistFileContent(
        token: string,
        file: { content?: string; truncated?: boolean; raw_url?: string }
    ): Promise<string | undefined> {
        if (file.truncated !== true && typeof file.content === 'string') {
            return file.content;
        }
        if (!file.raw_url) {
            Logger.warn('[GistSync] Gist file is truncated or empty and has no raw_url');
            return undefined;
        }
        let rawUrl: URL;
        try {
            rawUrl = new URL(file.raw_url);
        } catch {
            Logger.warn('[GistSync] Gist raw_url is invalid');
            return undefined;
        }
        if (rawUrl.protocol !== 'https:') {
            Logger.warn(`[GistSync] Refusing to fetch gist raw_url over non-HTTPS scheme: ${rawUrl.protocol}`);
            return undefined;
        }
        if (!ALLOWED_GIST_RAW_HOSTS.has(rawUrl.hostname)) {
            Logger.warn(`[GistSync] Refusing to fetch gist raw_url from unexpected host: ${rawUrl.hostname}`);
            return undefined;
        }
        try {
            const response = await ConfigManager.fetchWithProxy(
                rawUrl.toString(),
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/vnd.github.v3.raw',
                        'User-Agent': 'GCMP-VSCode-Extension'
                    }
                },
                { skipHar: true }
            );
            if (!response.ok) {
                Logger.warn(`[GistSync] Fetch gist raw_url failed: ${response.status}`);
                return undefined;
            }
            return await response.text();
        } catch (error) {
            Logger.error('[GistSync] Failed to fetch gist raw_url:', error);
            return undefined;
        }
    }

    // ==================== 加密 / 解密 ====================

    /**
     * 获取 GitHub 用户数字 ID（用于派生加密密钥）
     * 同一 GitHub 账号在不同设备上返回相同的 ID，确保跨设备可解密
     */
    private static getGithubId(): string | undefined {
        return this.context.globalState.get<string>(GITHUB_ID_KEY);
    }

    /**
     * 获取用户自定义加密口令（如果没有设置返回 undefined）
     */
    static async getCustomPassphrase(): Promise<string | undefined> {
        if (!this.context) {
            return undefined;
        }
        try {
            return (await this.context.secrets.get(USER_PASSPHRASE_KEY)) || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * 创建批量加密器：同一批明文共享 salt，密钥仅派生一次
     * 用于配置集同步等单文件多条目场景；GitHub 用户 ID 缺失时返回 undefined
     * 使用完毕后应调用 dispose() 清零内存中的派生密钥
     */
    static async createBatchEncryptor(): Promise<BatchEncryptor | undefined> {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.error('[GistSync] GitHub user ID not available for encryption');
            return undefined;
        }
        const passphrase = await this.getCustomPassphrase();
        return cryptoCreateBatchEncryptor(githubId, passphrase);
    }

    /**
     * 创建批量解密器（使用已存储口令）：按 salt 缓存派生密钥，同一 salt 仅派生一次
     * 使用完毕后应调用 dispose() 清零缓存的派生密钥
     */
    static async createBatchDecryptor(): Promise<BatchDecryptor | undefined> {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.warn('[GistSync] Decryption failed: GitHub user ID not available');
            return undefined;
        }
        const passphrase = await this.getCustomPassphrase();
        return cryptoCreateBatchDecryptor(githubId, passphrase);
    }

    /** 使用指定口令创建批量加密器，不修改本地已保存口令。 */
    static async createBatchEncryptorWithPassphrase(
        passphrase: string | undefined
    ): Promise<BatchEncryptor | undefined> {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.error('[GistSync] GitHub user ID not available for encryption');
            return undefined;
        }
        return cryptoCreateBatchEncryptor(githubId, passphrase);
    }

    /**
     * 创建批量解密器（指定口令）：不依赖已存储的口令，用于口令变更后的兜底
     * 使用完毕后应调用 dispose() 清零缓存的派生密钥
     */
    static createBatchDecryptorWithPassphrase(passphrase: string): BatchDecryptor | undefined {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.debug('[GistSync] createBatchDecryptorWithPassphrase: GitHub user ID not available');
            return undefined;
        }
        return cryptoCreateBatchDecryptor(githubId, passphrase);
    }

    /**
     * 检查是否已设置自定义加密口令
     */
    static async hasCustomPassphrase(): Promise<boolean> {
        const stored = await this.context.secrets.get(USER_PASSPHRASE_KEY);
        return !!stored;
    }

    /**
     * 设置/更改自定义加密口令
     * 更改口令会导致现有加密数据无法再解密
     * @param passphrase 新口令
     * @returns 是否成功
     */
    static async setCustomPassphrase(passphrase: string): Promise<boolean> {
        try {
            await this.context.secrets.store(USER_PASSPHRASE_KEY, passphrase);
            Logger.info('[GistSync] Custom encryption passphrase set');
            return true;
        } catch (error) {
            Logger.error('[GistSync] Failed to set custom passphrase:', error);
            return false;
        }
    }

    /**
     * 清除自定义加密口令
     */
    static async clearCustomPassphrase(): Promise<void> {
        await this.context.secrets.delete(USER_PASSPHRASE_KEY);
        Logger.info('[GistSync] Custom encryption passphrase cleared');
    }

    /**
     * 验证口令是否与已存储的口令一致
     * @param passphrase 要验证的口令
     */
    static async verifyPassphrase(passphrase: string): Promise<boolean> {
        const stored = await this.context.secrets.get(USER_PASSPHRASE_KEY);
        if (!stored) {
            return false;
        }
        return stored === passphrase;
    }

    // ==================== 元数据存储 ====================

    /** 保存配置集同步的 Gist ID */
    static async saveConfigSetGistId(gistId: string): Promise<void> {
        await this.context.globalState.update(CONFIGSET_GIST_ID_KEY, gistId);
    }

    /** 清除已失效的配置集同步 Gist ID（远端 Gist 被删除时自愈） */
    static async clearConfigSetGistId(): Promise<void> {
        await this.context.globalState.update(CONFIGSET_GIST_ID_KEY, undefined);
    }
}
