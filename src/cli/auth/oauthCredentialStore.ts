/*---------------------------------------------------------------------------------------------
 *  OAuth 命名凭证存储
 *  参照 CLIProxyAPI 的 oauth.auth-dir 形式：
 *  在插件全局目录 oauth/ 文件夹下按 <providerKey>-<凭证名>.json 命名管理多份凭证。
 *  - oauth 文件夹优先：某 provider 存在任一 oauth 凭证即在池内解析活跃项
 *  - 仅当 oauth 无该 provider 凭证时，调用方回退 CLI 默认目录凭证
 *  - 活跃选择持久化在 oauth/active.json，每次解析直接读取以避免同 mtime 更新漏检
 *  - 文件识别仅以第一个 - 前缀判定 provider，其余部分为不透明凭证名：
 *    导入时按账号身份自动命名（同 CLIProxyAPI），手工放置可自由命名，不做结构校验
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/runtime/logger';
import { withDirectoryLock } from '../../usages/persistence/directoryLock';
import { writeJsonFileAtomically } from './jsonFileIO';

/**
 * 凭证名写入侧规则：字母或数字开头，允许字母、数字、.、_、@、-，最长 64 字符。
 * 仅在保存新凭证文件时校验；扫描识别不限制名部分的结构（仅以第一个 - 前缀识别 provider）
 */
const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** 活跃选择持久化文件名（无 provider 前缀，不会被凭证扫描命中） */
const ACTIVE_SELECTION_FILE = 'active.json';
const ACTIVE_SELECTION_LOCK_DIR = 'active.selection.lock';

/**
 * oauth 文件夹中的一份命名凭证
 */
export interface OAuthCredentialEntry {
    /** 凭证名（文件名去掉 <provider>- 前缀与 .json 后缀） */
    name: string;
    /** 文件名，如 codex-work.json */
    fileName: string;
    /** 完整路径 */
    filePath: string;
    /** 文件内可选 label 字段 */
    label?: string;
    /** 文件内 expiry_date（毫秒时间戳） */
    expiryDate?: number;
    /** 是否含非空 access_token */
    hasAccessToken: boolean;
}

export interface OAuthCredentialDeleteResult {
    deleted: boolean;
    wasActive: boolean;
}

export interface OAuthCredentialSelection {
    name: string | undefined;
    generation: number;
}

export class OAuthCredentialDeleteError extends Error {
    readonly credentialDeleted = true;

    constructor(
        readonly wasActive: boolean,
        cause: unknown
    ) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = 'OAuthCredentialDeleteError';
    }
}

interface OAuthCredentialStoreOptions {
    /** oauth 文件夹完整路径（通常为 <globalStorage>/oauth） */
    oauthDir: string;
}

interface CredentialFileSummary {
    name: string;
    fileName: string;
    filePath: string;
}

interface ActiveSelectionState {
    selections: Record<string, string>;
}

export class OAuthCredentialStore {
    private static oauthDir: string | undefined;
    /** 目录扫描缓存：目录 mtime 不变则复用（文件增删改目录 mtime 才会变） */
    private static dirScanCache: { dirMtimeMs: number; entries: CredentialFileSummary[] } | null = null;
    private static selectionGenerations: Record<string, number> = {};

    /**
     * 初始化凭证存储（扩展激活时调用）
     */
    static initialize(options: OAuthCredentialStoreOptions): void {
        this.oauthDir = options.oauthDir;
        this.dirScanCache = null;
    }

    /** 仅测试使用：重置全部状态 */
    static resetForTests(): void {
        this.oauthDir = undefined;
        this.dirScanCache = null;
        this.selectionGenerations = {};
    }

    /**
     * 获取 oauth 文件夹路径（未初始化时返回 undefined）
     */
    static getOAuthDir(): string | undefined {
        return this.oauthDir;
    }

    /**
     * 校验凭证名是否合法（可安全用作文件名片段）
     */
    static isValidCredentialName(name: string): boolean {
        return CREDENTIAL_NAME_PATTERN.test(name);
    }

    /**
     * 列出指定 provider 的全部 oauth 凭证（按凭证名排序，含文件内容信息）
     */
    static listCredentials(providerKey: string): OAuthCredentialEntry[] {
        return this.scanCredentialFiles(providerKey)
            .map(summary => {
                const info = this.readCredentialInfo(summary.filePath);
                return {
                    ...summary,
                    label: info.label,
                    expiryDate: info.expiryDate,
                    hasAccessToken: info.hasAccessToken
                };
            })
            .sort((a, b) =>
                a.name < b.name ? -1
                : a.name > b.name ? 1
                : 0
            );
    }

    /**
     * 解析指定 provider 当前活跃的 oauth 凭证路径。
     * 返回 undefined 表示 oauth 文件夹中没有该 provider 的凭证（调用方回退 CLI 默认目录）。
     * 未手工指定时按凭证名排序取第一份，保证跨窗口/跨实例解析结果确定一致。
     */
    static resolveActiveCredentialPath(providerKey: string): string | undefined {
        const active = this.resolveActiveCredential(providerKey);
        return active?.filePath;
    }

    /** 获取指定命名凭证的路径；名称必须对应目录中已识别的凭证文件 */
    static getCredentialPath(providerKey: string, name: string): string | undefined {
        return this.scanCredentialFiles(providerKey).find(entry => entry.name === name)?.filePath;
    }

    /**
     * 获取指定 provider 当前活跃的 oauth 凭证名（无 oauth 凭证时为 undefined）
     */
    static getActiveCredentialName(providerKey: string): string | undefined {
        return this.resolveActiveCredential(providerKey)?.name;
    }

    static getActiveCredentialSelection(providerKey: string): OAuthCredentialSelection {
        const state = this.readActiveSelection();
        return {
            name: this.resolveActiveCredential(providerKey, state.selections)?.name,
            generation: this.selectionGenerations[providerKey] ?? 0
        };
    }

    /**
     * 设置指定 provider 的活跃凭证并持久化（写入 active.json）
     */
    static async setActiveCredential(providerKey: string, name: string): Promise<OAuthCredentialSelection> {
        const oauthDir = this.requireOAuthDir();
        const selection = await this.withSelectionLock(async () => {
            // 锁内重读并合并其他窗口刚提交的 provider 选择
            const state = this.readActiveSelection();
            state.selections[providerKey] = name;
            const generation = this.nextSelectionGeneration(providerKey);
            await this.writeActiveSelection(state);
            this.selectionGenerations[providerKey] = generation;
            return { name, generation };
        });
        Logger.info(`[OAuthCredentialStore] Active credential for ${providerKey}: ${name} (${oauthDir})`);
        return selection;
    }

    /** 仅当指定凭证仍活跃时，在选择锁内执行与该选择绑定的副作用。 */
    static async runIfActiveCredential(
        providerKey: string,
        expectedSelection: OAuthCredentialSelection,
        action: () => Promise<void>
    ): Promise<boolean> {
        return await this.withSelectionLock(async () => {
            const state = this.readActiveSelection();
            const activeName = this.resolveActiveCredential(providerKey, state.selections)?.name;
            const generation = this.selectionGenerations[providerKey] ?? 0;
            if (activeName !== expectedSelection.name || generation !== expectedSelection.generation) {
                return false;
            }
            await action();
            return true;
        });
    }

    /**
     * 保存一份命名凭证（目录不存在时自动创建），返回完整路径
     */
    static async saveCredentialFile(
        providerKey: string,
        name: string,
        record: Record<string, unknown>
    ): Promise<string> {
        if (!this.isValidCredentialName(name)) {
            throw new Error(`Invalid credential name: ${name}`);
        }
        const oauthDir = this.requireOAuthDir();
        if (!fs.existsSync(oauthDir)) {
            fs.mkdirSync(oauthDir, { recursive: true });
        }
        const filePath = path.join(oauthDir, this.buildFileName(providerKey, name));
        await this.withCredentialFileLock(filePath, async () => {
            await writeJsonFileAtomically(filePath, record);
        });
        this.dirScanCache = null;
        Logger.info(`[OAuthCredentialStore] Credential saved: ${filePath}`);
        return filePath;
    }

    /**
     * 删除一份命名凭证；若它是活跃凭证，同时清除选择记录
     */
    static async deleteCredentialFile(providerKey: string, name: string): Promise<boolean> {
        const result = await this.deleteCredentialFileWithStatus(providerKey, name);
        return result.deleted;
    }

    static async deleteCredentialFileWithStatus(
        providerKey: string,
        name: string
    ): Promise<OAuthCredentialDeleteResult> {
        const oauthDir = this.requireOAuthDir();
        if (!fs.existsSync(oauthDir)) {
            return { deleted: false, wasActive: false };
        }
        const filePath = path.join(oauthDir, this.buildFileName(providerKey, name));
        const result = await this.withCredentialFileLock(filePath, async () => {
            return await this.withSelectionLock(async () => {
                if (!fs.existsSync(filePath)) {
                    return { deleted: false, wasActive: false };
                }
                const state = this.readActiveSelection();
                const wasActive = this.resolveActiveCredential(providerKey, state.selections)?.name === name;
                fs.unlinkSync(filePath);
                this.dirScanCache = null;

                if (wasActive) {
                    if (state.selections[providerKey] === name) {
                        delete state.selections[providerKey];
                    }
                    this.selectionGenerations[providerKey] = this.nextSelectionGeneration(providerKey);
                    try {
                        await this.writeActiveSelection(state);
                    } catch (error) {
                        throw new OAuthCredentialDeleteError(wasActive, error);
                    }
                }
                return { deleted: true, wasActive };
            });
        });
        if (!result.deleted) {
            return result;
        }
        Logger.info(`[OAuthCredentialStore] Credential deleted: ${filePath}`);
        return result;
    }

    /** 串行化同一凭证文件的导入、刷新写回与删除，避免删除后被在途刷新重建。 */
    static async withCredentialFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
        return await withDirectoryLock(
            `${filePath}.lock`,
            {
                waitMs: 10_000,
                retryMs: 25,
                orphanMs: 60_000,
                reclaimOrphanMs: 60_000,
                timeoutMessage: 'Timed out waiting for OAuth credential file lock',
                ownershipLost: () => new Error('OAuth credential file lock ownership lost')
            },
            action
        );
    }

    private static async withSelectionLock<T>(action: () => Promise<T>): Promise<T> {
        const oauthDir = this.requireOAuthDir();
        if (!fs.existsSync(oauthDir)) {
            fs.mkdirSync(oauthDir, { recursive: true });
        }
        return await withDirectoryLock(
            path.join(oauthDir, ACTIVE_SELECTION_LOCK_DIR),
            {
                waitMs: 10_000,
                retryMs: 25,
                orphanMs: 60_000,
                reclaimOrphanMs: 60_000,
                timeoutMessage: 'Timed out waiting for OAuth credential selection lock',
                ownershipLost: () => new Error('OAuth credential selection lock ownership lost')
            },
            action
        );
    }

    private static resolveActiveCredential(
        providerKey: string,
        selection = this.readActiveSelection().selections
    ): CredentialFileSummary | undefined {
        const candidates = this.scanCredentialFiles(providerKey);
        if (candidates.length === 0) {
            return undefined;
        }
        const selected = selection[providerKey];
        const matched = selected ? candidates.find(c => c.name === selected) : undefined;
        if (matched) {
            return matched;
        }
        // 未指定或指定项已不存在：按名称排序取第一份，保证各窗口解析一致
        const sorted = [...candidates].sort((a, b) =>
            a.name < b.name ? -1
            : a.name > b.name ? 1
            : 0
        );
        return sorted[0];
    }

    /** 扫描 oauth 目录中指定 provider 的凭证文件（仅文件名维度，目录 mtime 缓存） */
    private static scanCredentialFiles(providerKey: string): CredentialFileSummary[] {
        const oauthDir = this.oauthDir;
        if (!oauthDir) {
            return [];
        }
        let dirMtimeMs = 0;
        try {
            dirMtimeMs = fs.statSync(oauthDir).mtimeMs;
        } catch {
            return []; // 目录不存在
        }
        if (!this.dirScanCache || this.dirScanCache.dirMtimeMs !== dirMtimeMs) {
            let fileNames: string[] = [];
            try {
                fileNames = fs.readdirSync(oauthDir);
            } catch (error) {
                Logger.warn('[OAuthCredentialStore] Failed to scan oauth directory:', error);
                fileNames = [];
            }
            const entries: CredentialFileSummary[] = [];
            for (const fileName of fileNames) {
                const parsed = this.parseFileName(fileName);
                if (parsed) {
                    entries.push({ ...parsed, filePath: path.join(oauthDir, fileName) });
                }
            }
            this.dirScanCache = { dirMtimeMs, entries };
        }
        return this.dirScanCache.entries
            .filter(entry => entry.name !== undefined && entry.fileName.startsWith(`${providerKey}-`))
            .map(entry => ({
                ...entry,
                name: entry.fileName.slice(providerKey.length + 1, -'.json'.length)
            }));
    }

    /**
     * 解析 <provider>-<name>.json 文件名；不匹配返回 undefined。
     * 仅以第一个 - 为界：前缀为 provider，其余整体作为不透明凭证名，不做结构校验
     */
    private static parseFileName(fileName: string): { name: string; fileName: string } | undefined {
        if (!fileName.endsWith('.json') || fileName === ACTIVE_SELECTION_FILE) {
            return undefined;
        }
        const dashIndex = fileName.indexOf('-');
        if (dashIndex <= 0) {
            return undefined;
        }
        const name = fileName.slice(dashIndex + 1, -'.json'.length);
        if (!name) {
            return undefined;
        }
        return { name, fileName };
    }

    private static buildFileName(providerKey: string, name: string): string {
        return `${providerKey}-${name}.json`;
    }

    /** 读取凭证文件的展示信息（label / expiry_date / access_token 存在性），失败时返回空信息 */
    private static readCredentialInfo(filePath: string): {
        label?: string;
        expiryDate?: number;
        hasAccessToken: boolean;
    } {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content) as Record<string, unknown>;
            return {
                ...(typeof data.label === 'string' && data.label ? { label: data.label } : {}),
                ...(typeof data.expiry_date === 'number' && Number.isFinite(data.expiry_date) ?
                    { expiryDate: data.expiry_date }
                :   {}),
                hasAccessToken: typeof data.access_token === 'string' && data.access_token.length > 0
            };
        } catch (error) {
            Logger.warn(`[OAuthCredentialStore] Failed to parse credential file ${filePath}:`, error);
            return { hasAccessToken: false };
        }
    }

    /** 读取活跃选择（active.json）；文件较小，每次直接读取以确保跨窗口内容变化可见 */
    private static readActiveSelection(): ActiveSelectionState {
        const selectionPath = this.getSelectionFilePath();
        try {
            const content = fs.readFileSync(selectionPath, 'utf-8');
            const parsed = JSON.parse(content) as Record<string, unknown>;
            const selections: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed)) {
                if (typeof value === 'string') {
                    selections[key] = value;
                }
            }
            return { selections };
        } catch {
            return { selections: {} };
        }
    }

    private static async writeActiveSelection(state: ActiveSelectionState): Promise<void> {
        await writeJsonFileAtomically(this.getSelectionFilePath(), state.selections);
    }

    private static nextSelectionGeneration(providerKey: string): number {
        const next = (this.selectionGenerations[providerKey] ?? 0) + 1;
        if (!Number.isSafeInteger(next)) {
            throw new Error(`OAuth active selection generation exhausted for ${providerKey}`);
        }
        return next;
    }

    private static getSelectionFilePath(): string {
        return path.join(this.requireOAuthDir(), ACTIVE_SELECTION_FILE);
    }

    private static requireOAuthDir(): string {
        if (!this.oauthDir) {
            throw new Error('OAuthCredentialStore is not initialized');
        }
        return this.oauthDir;
    }
}
