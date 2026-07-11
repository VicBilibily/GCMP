/**
 * GitHub Gist 同步服务
 * 负责通过 GitHub Gist API 实现加密配置的云端存储与同步
 * 通过 VS Code 内置的 GitHub 认证获取 access token，使用 AES-256-GCM 对 API Key 数据进行加密
 * 密钥派生：使用 scrypt
 */

import * as vscode from 'vscode';
import { CompatibleModelManager } from '../utils/compatibleModelManager';
import { Logger } from '../utils/logger';
import { registeredProviders } from '../utils/providerRegistry';
import { KnownProviders } from '../utils/knownProviders';
import { ConfigManager } from '../utils/configManager';
import {
    decrypt as cryptoDecrypt,
    decryptWithPassphrase as cryptoDecryptWithPassphrase,
    encrypt as cryptoEncrypt
} from './syncCrypto';

/**
 * Gist 中存储的同步数据格式
 */
export interface SyncData {
    /** 数据格式版本 */
    version: number;
    /** 上次更新时间 (ISO 8601) */
    timestamp: string;
    /** 所有同步的密钥: key -> 加密后的值 */
    keys: Record<string, string>;
}

/**
 * Gist API 响应中的文件结构
 */
interface GistFile {
    filename: string;
    type: string;
    language: string;
    raw_url: string;
    size: number;
    truncated: boolean;
    content?: string;
}

interface GistResponse {
    id: string;
    description: string;
    public: boolean;
    html_url: string;
    files: Record<string, GistFile>;
    created_at: string;
    updated_at: string;
}

/**
 * 同步状态
 */
export interface SyncStatus {
    /** 是否已登录 GitHub */
    isLoggedIn: boolean;
    /** 是否已关联 Gist */
    hasGist: boolean;
    /** 是否已设置自定义加密口令 */
    hasCustomPassphrase: boolean;
    /** GitHub 用户名（如果有） */
    githubUser?: string;
}

/** Gist 中存储同步数据的文件名 */
const SYNC_FILENAME = 'gcmp-sync.json';

/** GlobalState 中存储 Gist ID 的键名 */
const GIST_ID_KEY = 'gcmp-sync.gistId';

/** GlobalState 中存储 GitHub 用户名的键名 */
const GITHUB_USER_KEY = 'gcmp-sync.githubUser';

/** GlobalState 中存储 GitHub 用户数字 ID 的键名（用于派生加密密钥） */
const GITHUB_ID_KEY = 'gcmp-sync.githubId';

/** SecretStorage 中存储用户自定义加密口令的键名 */
const USER_PASSPHRASE_KEY = 'gcmp-sync.passphrase';

/** CLI 专用提供商，同步时排除 */
const CLI_ONLY_PROVIDERS = new Set(['codex', 'gemini', 'grok']);

/** 所有已知密钥的显示名（主 key + 多密钥变体，英文名与 ConfigProvider.displayName 一致） */
const KNOWN_KEY_LABELS: Record<string, string> = {
    // ── 主 key ──
    zhipu: 'ZhipuAI',
    moonshot: 'MoonshotAI',
    kimi: 'Kimi',
    deepseek: 'DeepSeek',
    streamlake: 'StreamLake',
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
    'dashscope-token': 'DashScope Token Plan',
    'tencent-coding': 'Tencent Cloud Coding Plan',
    'tencent-token': 'Tencent Cloud Token Plan',
    'tencent-deepseek': 'Tencent Cloud DeepSeek',
    'tencent-tokenhub': 'Tencent Cloud TokenHub',
    'tencent-token-enterprise': 'Tencent Cloud Token Plan Enterprise',
    'volcengine-agent': 'Volcengine Agent Plan',
    'xiaomimimo-token': 'Xiaomi MiMo Token Plan',
    'baidu-coding': 'Baidu Qianfan Coding Plan',
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
            const response = await ConfigManager.fetchWithProxy('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                }
            });

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

    /**
     * 一键登录 + 关联已有 Gist（首次配置入口）
     * @returns 登录成功返回用户信息，失败或取消返回 undefined
     */
    static async signIn(): Promise<{ login: string; id: number; token: string } | undefined> {
        const userInfo = await this.getUserInfo(false);
        if (!userInfo) {
            return undefined;
        }
        const gistId = await this.findExistingSyncGist(userInfo.token);
        if (gistId) {
            await this.saveGistId(gistId);
        }
        return userInfo;
    }

    // ==================== Gist ID 管理 ====================

    /**
     * 获取已存储的 Gist ID
     */
    static getGistId(): string | undefined {
        return this.context.globalState.get<string>(GIST_ID_KEY);
    }

    /**
     * 获取 GitHub 用户名
     */
    static getGithubUser(): string | undefined {
        return this.context.globalState.get<string>(GITHUB_USER_KEY);
    }

    // ==================== GitHub API 调用 ====================

    /**
     * 获取当前用户的 Gist 列表，查找已有的同步 Gist
     * 先按文件名和描述匹配候选 Gist，再读取内容校验 version 以过滤陈旧/测试数据
     */
    static async findExistingSyncGist(token: string): Promise<string | undefined> {
        try {
            const response = await ConfigManager.fetchWithProxy('https://api.github.com/gists', {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                }
            });

            if (!response.ok) {
                Logger.warn(`[GistSync] List gists failed: ${response.status}`);
                return undefined;
            }

            const gists = (await response.json()) as GistResponse[];

            // 找出所有候选 Gist（description 匹配 + 包含同步文件）
            const candidates = gists.filter(
                g => !g.public && g.description?.startsWith('GCMP Sync') && g.files?.[SYNC_FILENAME]
            );

            if (candidates.length === 0) {
                return undefined;
            }

            // 逐条读取完整内容，校验是否为有效同步数据
            for (const gist of candidates) {
                try {
                    // Gist 列表接口不保证返回文件内容，需单独请求详情
                    const syncData = await this.readSyncData(token, gist.id);
                    if (syncData?.version === 1 && syncData.keys && typeof syncData.keys === 'object') {
                        Logger.info(`[GistSync] Found valid sync gist: ${gist.id}`);
                        return gist.id;
                    }
                    Logger.debug(`[GistSync] Skipping gist ${gist.id}: invalid content`);
                } catch {
                    Logger.debug(`[GistSync] Skipping gist ${gist.id}: unreadable content`);
                    continue;
                }
            }

            Logger.warn('[GistSync] No valid sync gist found among candidates');
            return undefined;
        } catch (error) {
            Logger.error('[GistSync] Failed to list gists:', error);
            return undefined;
        }
    }

    /**
     * 从 Gist 读取同步数据
     */
    static async readSyncData(token: string, gistId: string): Promise<SyncData | undefined> {
        try {
            const response = await ConfigManager.fetchWithProxy(`https://api.github.com/gists/${gistId}`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                }
            });

            if (!response.ok) {
                Logger.warn(`[GistSync] Read gist failed: ${response.status}`);
                return undefined;
            }

            const gist = (await response.json()) as GistResponse;
            const file = gist.files?.[SYNC_FILENAME];
            if (!file?.content) {
                Logger.warn('[GistSync] Sync file not found in gist');
                return undefined;
            }

            return JSON.parse(file.content) as SyncData;
        } catch (error) {
            Logger.error('[GistSync] Failed to read sync data:', error);
            return undefined;
        }
    }

    /**
     * 创建新的同步 Gist（Secret Gist）
     */
    static async createGist(token: string, syncData: SyncData): Promise<string | undefined> {
        try {
            const body = {
                description: 'GCMP Sync - API Key configuration backup',
                public: false,
                files: {
                    [SYNC_FILENAME]: {
                        content: JSON.stringify(syncData, null, 2)
                    }
                }
            };

            const response = await ConfigManager.fetchWithProxy('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                Logger.error(`[GistSync] Create gist failed: ${response.status} - ${errText}`);
                return undefined;
            }

            const gist = (await response.json()) as GistResponse;
            Logger.info(`[GistSync] Created sync gist: ${gist.id}`);
            return gist.id;
        } catch (error) {
            Logger.error('[GistSync] Failed to create gist:', error);
            return undefined;
        }
    }

    /**
     * 更新已有 Gist 的内容
     */
    static async updateGist(token: string, gistId: string, syncData: SyncData): Promise<boolean> {
        try {
            const body = {
                description: 'GCMP Sync - API Key configuration backup',
                files: {
                    [SYNC_FILENAME]: {
                        content: JSON.stringify(syncData, null, 2)
                    }
                }
            };

            const response = await ConfigManager.fetchWithProxy(`https://api.github.com/gists/${gistId}`, {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                Logger.error(`[GistSync] Update gist failed: ${response.status} - ${errText}`);
                return false;
            }

            Logger.info(`[GistSync] Updated sync gist: ${gistId}`);
            return true;
        } catch (error) {
            Logger.error('[GistSync] Failed to update gist:', error);
            return false;
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
    private static async getPassphrase(): Promise<string | undefined> {
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
     * 加密明文数据
     * @param plaintext 明文
     * @returns 加密后的数据包（JSON 序列化后的字符串），加密失败返回 undefined
     */
    static async encrypt(plaintext: string): Promise<string | undefined> {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.error('[GistSync] GitHub user ID not available for encryption');
            return undefined;
        }
        const passphrase = await this.getPassphrase();
        return cryptoEncrypt(githubId, plaintext, passphrase);
    }

    /**
     * 使用指定口令解密密文数据包（不依赖已存储的口令）
     * 用于口令验证：尝试用用户输入的口令解密，判断口令是否正确
     * @param encryptedPayload JSON 序列化后的加密数据包
     * @param passphrase 要尝试的口令
     * @returns 明文，解密失败返回 undefined
     */
    static decryptWithPassphrase(encryptedPayload: string, passphrase: string): string | undefined {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.debug('[GistSync] decryptWithPassphrase: GitHub user ID not available');
            return undefined;
        }
        const result = cryptoDecryptWithPassphrase(githubId, encryptedPayload, passphrase);
        if (result !== undefined) {
            Logger.debug('[GistSync] decryptWithPassphrase: success');
        } else {
            Logger.debug('[GistSync] decryptWithPassphrase: auth tag mismatch (wrong passphrase?)');
        }
        return result;
    }

    /**
     * 解密密文数据包
     * @param encryptedPayload JSON 序列化后的加密数据包
     * @returns 明文，解密失败返回 undefined
     */
    static async decrypt(encryptedPayload: string): Promise<string | undefined> {
        const githubId = this.getGithubId();
        if (!githubId) {
            Logger.warn('[GistSync] Decryption failed: GitHub user ID not available');
            return undefined;
        }

        const passphrase = await this.getPassphrase();
        const result = cryptoDecrypt(githubId, encryptedPayload, passphrase);
        if (result === undefined) {
            // AES-256-GCM 认证失败（tag 不匹配）说明密钥/口令已变更，或数据被篡改
            Logger.warn(
                '[GistSync] Decryption failed: auth tag mismatch -- passphrase/identity may have changed since upload'
            );
        }
        return result;
    }

    // ==================== 密钥收集与应用 ====================

    /**
     * 收集本地所有 API Key
     * 先枚举所有待查 key 名，再并行读取 SecretStorage
     * @returns 密钥名 -> 明文的映射（只含本地已配置的密钥）
     */
    static async collectLocalKeys(): Promise<Record<string, string>> {
        const candidateKeys = new Set<string>();
        const providerConfigs = ConfigManager.getConfigProvider();

        // 1) 内置提供商主 key + 多密钥变体
        for (const providerKey of Object.keys(providerConfigs)) {
            if (CLI_ONLY_PROVIDERS.has(providerKey)) {
                continue;
            }
            candidateKeys.add(`${providerKey}.apiKey`);
            for (const labelKey of Object.keys(KNOWN_KEY_LABELS)) {
                if (labelKey.startsWith(providerKey)) {
                    candidateKeys.add(`${labelKey}.apiKey`);
                }
            }
        }

        // 2) KnownProviders
        for (const provider of Object.keys(KnownProviders)) {
            candidateKeys.add(`${provider}.apiKey`);
        }

        // 3) Compatible 自定义 provider
        try {
            for (const provider of CompatibleModelManager.getCustomProviderIds()) {
                candidateKeys.add(`${provider}.apiKey`);
            }
        } catch {
            /* skip */
        }

        // 4) KNOWN_KEY_LABELS 中未被覆盖的子级（如 kimi）
        const covered = new Set(Object.keys(providerConfigs));
        for (const p of Object.keys(KnownProviders)) {
            covered.add(p);
        }
        for (const k of Object.keys(KNOWN_KEY_LABELS)) {
            if (!covered.has(k)) {
                candidateKeys.add(`${k}.apiKey`);
            }
        }

        // 并行读取
        const entries = await Promise.all(
            Array.from(candidateKeys).map(async key => {
                const value = await this.context.secrets.get(key);
                return value?.trim() ? ([key, value.trim()] as const) : undefined;
            })
        );

        const keys: Record<string, string> = {};
        for (const e of entries) {
            if (e) {
                keys[e[0]] = e[1];
            }
        }
        return keys;
    }

    /**
     * 将远程密钥应用到本地 SecretStorage
     * @param keys 密钥名 -> 明文的映射
     * @returns 成功应用的密钥数量
     */
    static async applyRemoteKeys(keys: Record<string, string>): Promise<number> {
        let appliedCount = 0;

        for (const [keyName, plainValue] of Object.entries(keys)) {
            if (!plainValue || plainValue.trim().length === 0) {
                continue;
            }
            await this.context.secrets.store(keyName, plainValue.trim());
            appliedCount++;
            Logger.debug(`[GistSync] Applied key: ${keyName}`);
        }

        return appliedCount;
    }

    /**
     * 应用远程密钥并通知相关提供商刷新模型列表
     * 合并了 applyRemoteKeys + notifyProvidersKeyChanged
     */
    static async applyKeysAndNotify(keys: Record<string, string>): Promise<number> {
        const count = await this.applyRemoteKeys(keys);
        if (count === 0) {
            return 0;
        }

        this.notifyProviders(Object.keys(keys));
        return count;
    }

    /**
     * 通知相关提供商刷新模型列表（用于本地密钥删除后）
     * @param keyNames 密钥名列表（格式如 "deepseek.apiKey"）
     */
    static notifyProvidersKeysDeleted(keyNames: string[]): void {
        this.notifyProviders(keyNames);
    }

    /**
     * 按密钥名通知对应提供商刷新模型列表。
     * 仅对完整命中的已知多密钥变体做映射（如 dashscope-coding → dashscope），
     * kimi 特殊映射到 moonshot；其他未命中的自定义 provider 密钥定向到 compatible。
     * 模型缓存由主 provider 统一管理，映射到 moonshot 后一并刷新。
     */
    private static notifyProviders(keyNames: string[]): void {
        const providerConfigs = ConfigManager.getConfigProvider();
        const builtinKeyNames = new Set(Object.keys(providerConfigs));

        const knownVariantKeyToProvider = Object.fromEntries(
            Object.keys(KNOWN_KEY_LABELS)
                .filter(key => key.includes('-'))
                .map(key => [key, key.split('-')[0]])
                .filter(([, provider]) => builtinKeyNames.has(provider))
        ) as Record<string, string>;

        // 已知子级映射（如 kimi → moonshot）
        const knownKeyToProvider: Record<string, string> = {
            kimi: 'moonshot'
        };

        const providerKeys = new Set<string>();
        for (const keyName of keyNames) {
            const name = keyName.replace('.apiKey', '');

            // 跳过 CLI 专用
            if (CLI_ONLY_PROVIDERS.has(name)) {
                continue;
            }

            // 1) 精确匹配内置 provider
            if (builtinKeyNames.has(name)) {
                providerKeys.add(name);
                continue;
            }

            // 2) 子级映射（kimi → moonshot）
            if (knownKeyToProvider[name]) {
                providerKeys.add(knownKeyToProvider[name]);
                continue;
            }

            // 3) 已知多密钥变体（minimax-token → minimax）
            const variantProvider = knownVariantKeyToProvider[name];
            if (variantProvider) {
                providerKeys.add(variantProvider);
                continue;
            }

            // 4) 其他 → compatible
            providerKeys.add('compatible');
        }
        for (const providerKey of providerKeys) {
            registeredProviders[providerKey]?.invalidateAndNotify();
            Logger.debug(`[GistSync] Notified ${providerKey} of key change`);
        }
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

    // ==================== 查询状态 ====================

    /**
     * 从 SyncData 中删除指定密钥并写回 Gist
     * @param token GitHub token
     * @param gistId Gist ID
     * @param keysToRetain 要保留的密钥名集合
     * @returns 是否成功
     */
    static async deleteRemoteKeys(token: string, gistId: string, keysToRetain: Set<string>): Promise<boolean> {
        const syncData = await this.readSyncData(token, gistId);
        if (!syncData) {
            return false;
        }

        const newKeys: Record<string, string> = {};
        for (const [keyName, value] of Object.entries(syncData.keys)) {
            if (keysToRetain.has(keyName)) {
                newKeys[keyName] = value;
            }
        }

        syncData.keys = newKeys;
        syncData.timestamp = new Date().toISOString();

        return await this.updateGist(token, gistId, syncData);
    }

    /**
     * 上传加密密钥到 Gist（一站式：读 → 合并 → 更新/创建）
     * @param token GitHub token
     * @param encryptedKeys 加密后的密钥映射
     * @returns 上传后的 Gist ID，失败返回 undefined
     */
    static async uploadKeys(token: string, encryptedKeys: Record<string, string>): Promise<string | undefined> {
        let gistId = this.getGistId();

        // 读取已有 Gist，合并密钥（不覆盖未上传的远端 key）
        let mergedKeys = encryptedKeys;
        if (gistId) {
            const existing = await this.readSyncData(token, gistId);
            if (existing) {
                mergedKeys = { ...existing.keys, ...encryptedKeys };
            }
        }

        // 尝试更新
        if (gistId) {
            const ok = await this.updateGist(token, gistId, {
                version: 1,
                timestamp: new Date().toISOString(),
                keys: mergedKeys
            });
            if (ok) {
                await this.saveGistId(gistId);
                return gistId;
            }
            // 更新失败，fallback 到创建
            Logger.warn('[GistSync] Update failed, falling back to create');
            gistId = undefined;
        }

        // 尝试查找已有 Gist 后更新
        gistId = await this.findExistingSyncGist(token);
        if (gistId) {
            const existing = await this.readSyncData(token, gistId);
            if (existing) {
                mergedKeys = { ...existing.keys, ...encryptedKeys };
            }
            const ok = await this.updateGist(token, gistId, {
                version: 1,
                timestamp: new Date().toISOString(),
                keys: mergedKeys
            });
            if (ok) {
                await this.saveGistId(gistId);
                return gistId;
            }
        }

        // 创建新 Gist
        gistId = await this.createGist(token, {
            version: 1,
            timestamp: new Date().toISOString(),
            keys: mergedKeys
        });
        if (gistId) {
            await this.saveGistId(gistId);
        }
        return gistId;
    }

    /**
     * 用指定口令解密远端 Gist 中的全部密钥
     * @returns 解密后的密钥映射，全部失败返回 undefined
     */
    static async decryptRemoteKeysWithPassphrase(
        token: string,
        gistId: string,
        passphrase: string
    ): Promise<Record<string, string> | undefined> {
        const syncData = await this.readSyncData(token, gistId);
        if (!syncData) {
            return undefined;
        }

        const githubId = this.getGithubId();
        if (!githubId) {
            return undefined;
        }

        const remoteKeys: Record<string, string> = {};
        for (const [keyName, encryptedValue] of Object.entries(syncData.keys)) {
            if (!encryptedValue || encryptedValue.trim().length === 0) {
                continue;
            }
            const plainValue = cryptoDecryptWithPassphrase(githubId, encryptedValue, passphrase);
            if (plainValue !== undefined) {
                remoteKeys[keyName] = plainValue;
            }
        }

        return Object.keys(remoteKeys).length > 0 ? remoteKeys : undefined;
    }

    /**
     * 计算本地密钥与远端密钥的差异
     * 返回值表示当前操作方向下远端与本地的关系
     */
    static computeDiff(
        localKeys: Record<string, string>,
        remoteKeys: Record<string, string>
    ): {
        /** 仅存在于本地的密钥名 */
        localOnly: string[];
        /** 仅存在于远端的密钥名 */
        remoteOnly: string[];
        /** 两边都有的密钥名 */
        common: string[];
    } {
        const localSet = new Set(Object.keys(localKeys));
        const remoteSet = new Set(Object.keys(remoteKeys));

        const localOnly: string[] = [];
        const remoteOnly: string[] = [];
        const common: string[] = [];

        for (const key of localSet) {
            if (remoteSet.has(key)) {
                common.push(key);
            } else {
                localOnly.push(key);
            }
        }
        for (const key of remoteSet) {
            if (!localSet.has(key)) {
                remoteOnly.push(key);
            }
        }

        return { localOnly, remoteOnly, common };
    }

    /**
     * 获取当前同步状态
     */
    static async getStatus(): Promise<SyncStatus> {
        const isLoggedIn = await this.isLoggedIn();
        const gistId = this.getGistId();
        const githubUser = this.getGithubUser();
        const hasCustomPassphrase = await this.hasCustomPassphrase();

        return {
            isLoggedIn,
            hasGist: !!gistId,
            hasCustomPassphrase,
            githubUser
        };
    }

    // ==================== 元数据存储 ====================

    /**
     * 保存 Gist ID
     */
    static async saveGistId(gistId: string): Promise<void> {
        await this.context.globalState.update(GIST_ID_KEY, gistId);
    }
}
