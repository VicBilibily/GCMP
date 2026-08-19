/*---------------------------------------------------------------------------------------------
 *  提供商配置集 Gist 同步服务（per-slot 模型）
 *  数据写入 Gist 容器中的独立文件 gcmp-configsets.json。
 *  每个槽位（主 provider 或变体如 minimax-token）独立同步。
 *  存储格式为结构化的供应商声明明文（槽位 / 配置项元数据可直接在 Gist 网页端阅读），
 *  仅每个配置项的 apiKey 字段单独加密（AES-256-GCM payload 字符串）。
 *--------------------------------------------------------------------------------------------*/

import { ConfigManager } from '../utils/config/configManager';
import { ConfigSetItem, ConfigSetStore } from '../utils/config/configSetStore';
import { Logger } from '../utils/runtime/logger';
import { GistSyncService } from './gistSyncService';

/** Gist 中存储配置集同步数据的文件名 */
const CONFIGSET_SYNC_FILENAME = 'gcmp-configsets.json';

/** 配置集同步数据格式（结构化明文存储，仅 apiKey 字段加密） */
export interface ConfigSetSyncData {
    version: 1;
    timestamp: string;
    /** 所有槽位的配置集（结构明文，apiKey 为加密 payload） */
    slots: Record<string, SyncedSlotConfigSet>;
}

/** 单个槽位的配置集快照（激活状态不同步，由本地按生效 Key 确认） */
export interface SyncedSlotConfigSet {
    /** 配置项列表；传输/存储态 apiKey 为加密 payload 字符串，业务层调用前已解密为明文 */
    items: (ConfigSetItem & { apiKey: string })[];
}

/** Gist 响应中的文件结构（仅本服务用到的字段） */
interface GistFileEntry {
    filename: string;
    content?: string;
    truncated?: boolean;
    raw_url?: string;
}

interface GistDetail {
    id: string;
    description?: string;
    public?: boolean;
    files?: Record<string, GistFileEntry>;
}

/**
 * 读取远端配置集同步数据的结果状态
 * - 'ok'：成功读取并解密
 * - 'not-found'：Gist 中不存在配置集同步文件（尚未上传过）
 * - 'gist-missing'：Gist 本身已不存在（远端被删除，404）
 * - 'decrypt-failed'：文件存在但解密失败（口令/身份变更）
 * - 'error'：HTTP 错误、网络异常等
 */
export type ReadConfigSetResult =
    | { status: 'ok'; data: ConfigSetSyncData; skipped?: number }
    | { status: 'not-found' }
    | { status: 'gist-missing' }
    | { status: 'decrypt-failed' }
    | { status: 'error' };

/**
 * 收集本地全部槽位的配置集快照
 * @returns 有配置集的槽位映射；全部为空时返回 undefined
 */
export async function collectLocalConfigSets(): Promise<Record<string, SyncedSlotConfigSet> | undefined> {
    const slots: Record<string, SyncedSlotConfigSet> = {};
    for (const slot of ConfigSetStore.listProviders()) {
        const items = ConfigSetStore.list(slot);
        if (items.length === 0) {
            continue;
        }
        const withKeys: (ConfigSetItem & { apiKey: string })[] = [];
        for (const item of items) {
            const apiKey = await ConfigSetStore.getApiKey(slot, item.id);
            if (apiKey) {
                withKeys.push({ ...item, apiKey });
            }
        }
        if (withKeys.length > 0) {
            slots[slot] = { items: withKeys };
        }
    }
    return Object.keys(slots).length > 0 ? slots : undefined;
}

/**
 * 拉取 Gist 中的配置集同步文件内容
 * @returns 'ok' 带文件内容；'not-found' 文件不存在；'gist-missing' Gist 已被删除；'error' HTTP/网络错误
 */
async function fetchRemoteFileContent(
    token: string,
    gistId: string
): Promise<
    { status: 'ok'; content: string } | { status: 'not-found' } | { status: 'gist-missing' } | { status: 'error' }
> {
    try {
        const response = await ConfigManager.fetchWithProxy(
            `https://api.github.com/gists/${gistId}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                }
            },
            { skipHar: true }
        );
        if (response.status === 404) {
            Logger.warn(`[ConfigSetSync] Gist ${gistId} no longer exists (404)`);
            return { status: 'gist-missing' };
        }
        if (!response.ok) {
            Logger.warn(`[ConfigSetSync] Read gist failed: ${response.status}`);
            return { status: 'error' };
        }
        const gist = (await response.json()) as GistDetail;
        const file = gist.files?.[CONFIGSET_SYNC_FILENAME];
        if (!file) {
            return { status: 'not-found' };
        }
        const content = await GistSyncService.resolveGistFileContent(token, file);
        if (content === undefined) {
            return { status: 'error' };
        }
        return { status: 'ok', content };
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to read config set sync data:', error);
        return { status: 'error' };
    }
}

/**
 * 逐个解密 slots 中各配置项的 apiKey 字段
 * @param data 远端读取的同步数据（apiKey 为加密 payload）
 * @param decryptFn 批量解密函数（按 salt 缓存密钥），返回明文或 undefined
 * @returns 解密结果；全部项失败（口令错误/数据损坏）时返回 undefined，部分失败时跳过失败项并计数
 */
async function decryptSlotKeys(
    data: ConfigSetSyncData,
    decryptFn: (encryptedPayload: string) => Promise<string | undefined>
): Promise<{ data: ConfigSetSyncData; skipped: number } | undefined> {
    const slots: Record<string, SyncedSlotConfigSet> = {};
    let total = 0;
    let skipped = 0;
    for (const [slot, set] of Object.entries(data.slots ?? {})) {
        const items: (ConfigSetItem & { apiKey: string })[] = [];
        for (const item of set.items ?? []) {
            total += 1;
            const apiKey = await decryptFn(item.apiKey);
            if (apiKey === undefined) {
                skipped += 1;
                continue;
            }
            items.push({ ...item, apiKey });
        }
        slots[slot] = { ...set, items };
    }
    if (total > 0 && skipped === total) {
        return undefined;
    }
    return { data: { ...data, slots }, skipped };
}

/**
 * 逐个加密 slots 中各配置项的 apiKey 字段（批量加密器共享 salt，整份数据仅派生一次密钥）
 * @param data 本地明文同步数据
 * @returns apiKey 已加密为 payload 的数据副本；任一项加密失败返回 undefined
 */
async function encryptSlotKeys(data: ConfigSetSyncData): Promise<ConfigSetSyncData | undefined> {
    const encrypt = await GistSyncService.createBatchEncryptor();
    if (!encrypt) {
        return undefined;
    }
    try {
        const slots: Record<string, SyncedSlotConfigSet> = {};
        for (const [slot, set] of Object.entries(data.slots)) {
            const items: (ConfigSetItem & { apiKey: string })[] = [];
            for (const item of set.items) {
                const apiKey = encrypt(item.apiKey);
                if (apiKey === undefined) {
                    return undefined;
                }
                items.push({ ...item, apiKey });
            }
            slots[slot] = { ...set, items };
        }
        return { ...data, slots };
    } finally {
        encrypt.dispose();
    }
}

/** 使用指定口令加密配置集，不修改本地已保存口令。 */
async function encryptSlotKeysWithPassphrase(
    data: ConfigSetSyncData,
    passphrase: string | undefined
): Promise<ConfigSetSyncData | undefined> {
    const encrypt = await GistSyncService.createBatchEncryptorWithPassphrase(passphrase);
    if (!encrypt) {
        return undefined;
    }
    try {
        const slots: Record<string, SyncedSlotConfigSet> = {};
        for (const [slot, set] of Object.entries(data.slots)) {
            const items: (ConfigSetItem & { apiKey: string })[] = [];
            for (const item of set.items) {
                const apiKey = encrypt(item.apiKey);
                if (apiKey === undefined) {
                    return undefined;
                }
                items.push({ ...item, apiKey });
            }
            slots[slot] = {
                ...set,
                items
            };
        }
        return { ...data, slots };
    } finally {
        encrypt.dispose();
    }
}

/**
 * 从 Gist 读取配置集同步数据，并逐个解密 apiKey 字段
 * @returns 读取结果状态（见 ReadConfigSetResult）
 */
export async function readRemoteConfigSets(token: string, gistId: string): Promise<ReadConfigSetResult> {
    const file = await fetchRemoteFileContent(token, gistId);
    if (file.status !== 'ok') {
        return file;
    }
    let decryptor: Awaited<ReturnType<typeof GistSyncService.createBatchDecryptor>>;
    try {
        const parsed = JSON.parse(file.content) as ConfigSetSyncData;
        decryptor = await GistSyncService.createBatchDecryptor();
        const result = decryptor ? await decryptSlotKeys(parsed, decryptor) : undefined;
        if (!result) {
            Logger.warn('[ConfigSetSync] Decryption failed (passphrase/identity may have changed since upload)');
            return { status: 'decrypt-failed' };
        }
        if (result.skipped > 0) {
            Logger.warn(`[ConfigSetSync] Skipped ${result.skipped} undecryptable item(s) during download`);
        }
        return { status: 'ok', data: result.data, skipped: result.skipped };
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to parse config set sync data:', error);
        return { status: 'error' };
    } finally {
        decryptor?.dispose();
    }
}

/**
 * 用指定口令解密远端配置集同步数据（不依赖已存储的口令，用于口令变更后的兜底）
 * @returns 读取结果状态（见 ReadConfigSetResult）
 */
export async function readRemoteConfigSetsWithPassphrase(
    token: string,
    gistId: string,
    passphrase: string
): Promise<ReadConfigSetResult> {
    const file = await fetchRemoteFileContent(token, gistId);
    if (file.status !== 'ok') {
        return file;
    }
    const decryptor = GistSyncService.createBatchDecryptorWithPassphrase(passphrase);
    try {
        const parsed = JSON.parse(file.content) as ConfigSetSyncData;
        const result = decryptor ? await decryptSlotKeys(parsed, decryptor) : undefined;
        if (!result) {
            return { status: 'decrypt-failed' };
        }
        if (result.skipped > 0) {
            Logger.warn(`[ConfigSetSync] Skipped ${result.skipped} undecryptable item(s) during download`);
        }
        return { status: 'ok', data: result.data, skipped: result.skipped };
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to read config set sync data with explicit passphrase:', error);
        return { status: 'error' };
    } finally {
        decryptor?.dispose();
    }
}

/**
 * 将配置集同步数据写回 Gist（结构化明文，仅 apiKey 字段逐个加密）
 */
export async function writeRemoteConfigSets(token: string, gistId: string, data: ConfigSetSyncData): Promise<boolean> {
    try {
        const encrypted = await encryptSlotKeys(data);
        if (!encrypted) {
            Logger.error('[ConfigSetSync] Encryption failed: GitHub user ID not available');
            return false;
        }
        const response = await ConfigManager.fetchWithProxy(
            `https://api.github.com/gists/${gistId}`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                },
                body: JSON.stringify({
                    files: { [CONFIGSET_SYNC_FILENAME]: { content: JSON.stringify(encrypted, null, 2) } }
                })
            },
            { skipHar: true }
        );
        if (!response.ok) {
            const errText = await response.text();
            Logger.error(`[ConfigSetSync] Update gist failed: ${response.status} - ${errText}`);
            return false;
        }
        Logger.info(`[ConfigSetSync] Config set sync file updated in gist ${gistId}`);
        return true;
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to write config set sync data:', error);
        return false;
    }
}

/** 使用指定口令完整覆盖配置集同步文件，不修改本地已保存口令。 */
export async function writeRemoteConfigSetsWithPassphrase(
    token: string,
    gistId: string,
    data: ConfigSetSyncData,
    passphrase: string | undefined
): Promise<boolean> {
    try {
        const encrypted = await encryptSlotKeysWithPassphrase(
            { ...data, timestamp: new Date().toISOString() },
            passphrase
        );
        if (!encrypted) {
            return false;
        }
        const response = await ConfigManager.fetchWithProxy(
            `https://api.github.com/gists/${gistId}`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                },
                body: JSON.stringify({
                    files: { [CONFIGSET_SYNC_FILENAME]: { content: JSON.stringify(encrypted, null, 2) } }
                })
            },
            { skipHar: true }
        );
        return response.ok;
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to write config sets with explicit passphrase:', error);
        return false;
    }
}

/**
 * 查找已存在的配置集专用 Gist（跨设备首次使用时定位旧设备创建的 Gist）
 * 匹配条件：Secret Gist + description 以 'GCMP ConfigSets' 开头 + 包含配置集同步文件
 * @returns 找到的 Gist ID；未找到或出错返回 undefined
 */
export async function findExistingConfigSetGist(token: string): Promise<string | undefined> {
    try {
        let decryptFailedGistId: string | undefined;
        for (let page = 1; ; page++) {
            const response = await ConfigManager.fetchWithProxy(
                `https://api.github.com/gists?per_page=100&page=${page}`,
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
                Logger.warn(`[ConfigSetSync] List gists failed: ${response.status}`);
                return undefined;
            }

            const gists = (await response.json()) as GistDetail[];
            const candidates = gists
                .filter(g => !g.public && g.files?.[CONFIGSET_SYNC_FILENAME])
                .sort((a, b) => {
                    const aDedicated = a.description?.startsWith('GCMP ConfigSets') ? 1 : 0;
                    const bDedicated = b.description?.startsWith('GCMP ConfigSets') ? 1 : 0;
                    return bDedicated - aDedicated;
                });

            for (const gist of candidates) {
                const result = await readRemoteConfigSets(token, gist.id);
                if (result.status === 'ok') {
                    Logger.info(`[ConfigSetSync] Found valid config set gist: ${gist.id}`);
                    return gist.id;
                }
                if (result.status === 'decrypt-failed' && !decryptFailedGistId) {
                    decryptFailedGistId = gist.id;
                }
            }

            if (gists.length < 100) {
                break;
            }
        }

        if (decryptFailedGistId) {
            Logger.info(`[ConfigSetSync] Found encrypted config set gist: ${decryptFailedGistId}`);
            return decryptFailedGistId;
        }

        Logger.warn('[ConfigSetSync] No valid config set gist found among candidates');
        return undefined;
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to find existing config set gist:', error);
        return undefined;
    }
}

/**
 * 创建包含配置集同步文件的 Secret Gist（M2：配置集同步可独立首次使用，不依赖 API Key 同步先创建 Gist）
 * @returns 创建成功的 Gist ID；失败返回 undefined
 */
export async function createGistForConfigSets(token: string, data: ConfigSetSyncData): Promise<string | undefined> {
    try {
        const encrypted = await encryptSlotKeys(data);
        if (!encrypted) {
            Logger.error('[ConfigSetSync] Encryption failed: GitHub user ID not available');
            return undefined;
        }
        const response = await ConfigManager.fetchWithProxy(
            'https://api.github.com/gists',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'GCMP-VSCode-Extension'
                },
                body: JSON.stringify({
                    description: 'GCMP ConfigSets - Provider configuration backup',
                    public: false,
                    files: {
                        [CONFIGSET_SYNC_FILENAME]: { content: JSON.stringify(encrypted, null, 2) }
                    }
                })
            },
            { skipHar: true }
        );
        if (!response.ok) {
            const errText = await response.text();
            Logger.error(`[ConfigSetSync] Create gist failed: ${response.status} - ${errText}`);
            return undefined;
        }
        const gist = (await response.json()) as GistDetail;
        Logger.info(`[ConfigSetSync] Created config set sync gist: ${gist.id}`);
        return gist.id;
    } catch (error) {
        Logger.error('[ConfigSetSync] Failed to create config set sync gist:', error);
        return undefined;
    }
}

/** 规范化单个配置项：固定字段顺序，忽略键顺序与 undefined 缺失差异 */
function itemFingerprint(item: SyncedSlotConfigSet['items'][number]): string {
    return JSON.stringify([item.id, item.label, item.site ?? null, item.note ?? null, item.apiKey]);
}

/** 对比本地与远端，得出每个槽位的同步状态（items 按 id 排序后逐项指纹比对，顺序/字段差异不误报） */
export function diffConfigSets(
    local: Record<string, SyncedSlotConfigSet> | undefined,
    remote: Record<string, SyncedSlotConfigSet>
): Record<string, 'new' | 'update' | 'unchanged'> {
    const fingerprints = (items: SyncedSlotConfigSet['items']) =>
        [...items]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(itemFingerprint)
            .join('\n');
    const status: Record<string, 'new' | 'update' | 'unchanged'> = {};
    for (const [slot, remoteSet] of Object.entries(remote)) {
        const localSet = local?.[slot];
        if (!localSet) {
            status[slot] = 'new';
            continue;
        }
        status[slot] = fingerprints(localSet.items) === fingerprints(remoteSet.items) ? 'unchanged' : 'update';
    }
    return status;
}
