/*---------------------------------------------------------------------------------------------
 *  提供商配置集存储（per-slot 模型）
 *  每个槽位（主 provider 或变体如 minimax-token）独立管理自己的配置列表与激活状态。
 *  一套配置 = 站点（仅主槽位）+ 一个 API Key。
 *  切换时只覆盖该槽位的 Key，各槽位互不影响。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyManager } from './apiKeyManager';
import { t } from '../runtime/l10n';
import { Logger } from '../runtime/logger';

/**
 * 一套配置（绑定单个槽位）
 */
export interface ConfigSetItem {
    /** 配置唯一标识 */
    id: string;
    /** 用户命名的配置名 */
    label: string;
    /** 站点标识（支持站点切换的槽位使用） */
    site?: string;
    /** 备注描述（可选） */
    note?: string;
}

/**
 * 配置集存储（per-slot）
 */
export class ConfigSetStore {
    private static context: vscode.ExtensionContext;

    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /** 旧版整表索引键：Record<slot, ConfigSetItem[]>（仅迁移期读取，新数据按槽位分键存储） */
    private static readonly INDEX_KEY = 'configSets';

    /** per-slot 索引键前缀：按槽位分键存储，避免跨窗口整表覆盖互相丢更新 */
    private static readonly ITEMS_KEY_PREFIX = 'configSets.items.';

    private static itemsKey(slot: string): string {
        return `${this.ITEMS_KEY_PREFIX}${slot}`;
    }

    private static migratedKey(slot: string): string {
        return `configSets.migrated.${slot}`;
    }

    private static activeKey(slot: string): string {
        return `configSets.active.${slot}`;
    }

    private static secretKey(slot: string, id: string): string {
        return `configSet.${slot}.${id}`;
    }

    private static async markMigrated(slot: string): Promise<void> {
        await this.context.globalState.update(this.migratedKey(slot), true);
    }

    /** 读取槽位配置列表：per-slot 键优先，回退旧版整表索引（懒迁移前的兼容读） */
    private static readSlotItems(slot: string): ConfigSetItem[] {
        const perSlot = this.context.globalState.get<ConfigSetItem[]>(this.itemsKey(slot));
        if (perSlot !== undefined) {
            return Array.isArray(perSlot) ? perSlot : [];
        }
        const legacy = this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY, {});
        const items = legacy[slot];
        return Array.isArray(items) ? items : [];
    }

    /** 写入槽位配置列表（空列表删除该键） */
    private static async writeSlotItems(slot: string, items: ConfigSetItem[]): Promise<void> {
        await this.context.globalState.update(this.itemsKey(slot), items.length > 0 ? items : undefined);
    }

    /** enqueue 内调用：把该槽位从旧版整表索引迁入 per-slot 键（幂等，旧表搬空后删除） */
    private static async migrateSlotIndexUnlocked(slot: string): Promise<void> {
        const legacy = this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY);
        if (!legacy || !(slot in legacy)) {
            return;
        }
        const items = legacy[slot];
        if (Array.isArray(items) && items.length > 0) {
            await this.context.globalState.update(this.itemsKey(slot), items);
        }
        const rest = { ...legacy };
        delete rest[slot];
        await this.context.globalState.update(this.INDEX_KEY, Object.keys(rest).length > 0 ? rest : undefined);
    }

    /**
     * 串行化"读-改-写"临界区：避免同实例内并发操作互相覆盖。
     * 跨窗口按槽位分键后仅同槽位并发仍为 last-write-wins（globalState 无 CAS 原语）。
     */
    private static writeQueue: Promise<unknown> = Promise.resolve();

    private static enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(task, task);
        this.writeQueue = run.catch(() => undefined);
        return run;
    }

    /** 列出某槽位的全部配置 */
    static list(slot: string): ConfigSetItem[] {
        return this.readSlotItems(slot);
    }

    static async backfillMissingSite(slot: string, site: string | undefined): Promise<void> {
        await this.enqueue(async () => {
            if (!site) {
                return;
            }
            await this.migrateSlotIndexUnlocked(slot);
            const items = this.readSlotItems(slot);
            if (!items.some(item => !item.site)) {
                return;
            }
            await this.writeSlotItems(
                slot,
                items.map(item => (item.site ? item : { ...item, site }))
            );
        });
    }

    /** 列出所有存在配置集的槽位（合并 per-slot 键与旧版整表索引） */
    static listProviders(): string[] {
        const fromKeys = this.context.globalState
            .keys()
            .filter(key => key.startsWith(this.ITEMS_KEY_PREFIX))
            .map(key => key.slice(this.ITEMS_KEY_PREFIX.length));
        const legacy = this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY, {});
        const slots = new Set([...fromKeys, ...Object.keys(legacy)]);
        return [...slots].filter(slot => this.readSlotItems(slot).length > 0);
    }

    static getActiveId(slot: string): string | undefined {
        return this.context.globalState.get<string>(this.activeKey(slot));
    }

    static async getApiKey(slot: string, id: string): Promise<string | undefined> {
        return await this.context.secrets.get(this.secretKey(slot, id));
    }

    static async setApiKey(slot: string, id: string, apiKey: string): Promise<void> {
        await this.context.secrets.store(this.secretKey(slot, id), apiKey);
    }

    private static async setActiveUnlocked(slot: string, id: string): Promise<void> {
        await this.context.globalState.update(this.activeKey(slot), id);
    }

    private static async clearActiveUnlocked(slot: string): Promise<void> {
        await this.context.globalState.update(this.activeKey(slot), undefined);
    }

    /** 更新配置元数据（label / note） */
    static async updateMeta(
        slot: string,
        id: string,
        patch: { label?: string; note?: string },
        apiKey?: string | null
    ): Promise<void> {
        await this.enqueue(async () => {
            await this.migrateSlotIndexUnlocked(slot);
            const previousItems = this.readSlotItems(slot);
            if (!previousItems.length) {
                return;
            }

            const nextItems = previousItems.map(item => {
                if (item.id !== id) {
                    return item;
                }

                const nextItem: ConfigSetItem = {
                    ...item,
                    ...(patch.label !== undefined ? { label: patch.label } : {})
                };

                if (patch.note !== undefined) {
                    const normalizedNote = patch.note.trim();
                    if (normalizedNote) {
                        nextItem.note = normalizedNote;
                    } else {
                        delete nextItem.note;
                    }
                }

                return nextItem;
            });

            const previousKey =
                apiKey !== undefined ? await this.context.secrets.get(this.secretKey(slot, id)) : undefined;

            try {
                if (apiKey !== undefined) {
                    if (apiKey === null) {
                        await this.context.secrets.delete(this.secretKey(slot, id));
                    } else {
                        await this.context.secrets.store(this.secretKey(slot, id), apiKey);
                    }
                }
                await this.writeSlotItems(slot, nextItems);
            } catch (error) {
                if (apiKey !== undefined) {
                    if (previousKey === undefined) {
                        await this.context.secrets.delete(this.secretKey(slot, id));
                    } else {
                        await this.context.secrets.store(this.secretKey(slot, id), previousKey);
                    }
                }
                await this.writeSlotItems(slot, previousItems);
                throw error;
            }
        });
    }

    /** 新增一套配置（enqueue 内部实现，供入队上下文复用，避免嵌套入队死锁） */
    private static async addUnlocked(slot: string, item: ConfigSetItem, apiKey: string): Promise<void> {
        await this.migrateSlotIndexUnlocked(slot);
        const items = this.readSlotItems(slot);
        items.push(item);
        await this.context.secrets.store(this.secretKey(slot, item.id), apiKey);
        try {
            await this.writeSlotItems(slot, items);
        } catch (error) {
            await this.context.secrets.delete(this.secretKey(slot, item.id));
            throw error;
        }
        await this.markMigrated(slot);
    }

    /** 新增一套配置 */
    static async add(slot: string, item: ConfigSetItem, apiKey: string): Promise<void> {
        await this.enqueue(() => this.addUnlocked(slot, item, apiKey));
    }

    /** 删除一套配置 */
    static async remove(slot: string, id: string): Promise<void> {
        await this.enqueue(async () => {
            await this.migrateSlotIndexUnlocked(slot);
            const items = this.readSlotItems(slot).filter(i => i.id !== id);
            await this.writeSlotItems(slot, items);
            await this.context.secrets.delete(this.secretKey(slot, id));
            await this.markMigrated(slot);
            if (this.getActiveId(slot) === id) {
                await this.clearActiveUnlocked(slot);
            }
        });
    }

    /** 覆盖写入某槽位的整套配置集（同步下载用） */
    static async writeAll(
        slot: string,
        items: ConfigSetItem[],
        keys: Record<string, string | undefined>,
        activeId?: string
    ): Promise<void> {
        await this.enqueue(async () => {
            await this.migrateSlotIndexUnlocked(slot);
            const previousItems = this.readSlotItems(slot);
            const previousActiveId = this.getActiveId(slot);
            const incomingIds = new Set(items.map(item => item.id));
            const touchedIds = new Set(items.map(item => item.id));
            const previousKeys = new Map<string, string | undefined>();
            for (const id of touchedIds) {
                previousKeys.set(id, await this.context.secrets.get(this.secretKey(slot, id)));
            }

            try {
                for (const item of items) {
                    const key = keys[item.id];
                    if (key === undefined) {
                        await this.context.secrets.delete(this.secretKey(slot, item.id));
                        continue;
                    }
                    await this.context.secrets.store(this.secretKey(slot, item.id), key);
                }
                await this.writeSlotItems(slot, items);
                if (activeId) {
                    await this.setActiveUnlocked(slot, activeId);
                } else {
                    await this.clearActiveUnlocked(slot);
                }
            } catch (error) {
                let rollbackFailed = false;
                try {
                    await this.writeSlotItems(slot, previousItems);
                } catch (rollbackError) {
                    rollbackFailed = true;
                    Logger.error('[ConfigSetStore] Failed to roll back config index:', rollbackError);
                }
                try {
                    if (previousActiveId) {
                        await this.setActiveUnlocked(slot, previousActiveId);
                    } else {
                        await this.clearActiveUnlocked(slot);
                    }
                } catch (rollbackError) {
                    rollbackFailed = true;
                    Logger.error('[ConfigSetStore] Failed to roll back active configuration:', rollbackError);
                }
                for (const id of touchedIds) {
                    try {
                        const previousKey = previousKeys.get(id);
                        if (previousKey === undefined) {
                            await this.context.secrets.delete(this.secretKey(slot, id));
                        } else {
                            await this.context.secrets.store(this.secretKey(slot, id), previousKey);
                        }
                    } catch (rollbackError) {
                        rollbackFailed = true;
                        Logger.error(`[ConfigSetStore] Failed to roll back secret ${slot}:${id}:`, rollbackError);
                    }
                }
                if (rollbackFailed) {
                    Logger.error('[ConfigSetStore] writeAll rollback was incomplete');
                }
                throw error;
            }

            for (const old of previousItems) {
                if (incomingIds.has(old.id)) {
                    continue;
                }
                try {
                    await this.context.secrets.delete(this.secretKey(slot, old.id));
                } catch (error) {
                    Logger.warn(`[ConfigSetStore] Failed to clean stale secret ${slot}:${old.id}`, error);
                }
            }
            try {
                await this.markMigrated(slot);
            } catch (error) {
                Logger.warn(`[ConfigSetStore] Failed to mark ${slot} as migrated`, error);
            }
        });
    }

    static async setActive(slot: string, id: string): Promise<void> {
        await this.enqueue(() => this.setActiveUnlocked(slot, id));
    }

    /** 清除激活标记（停用场景）：globalState.update(key, undefined) 即删除该键 */
    static async clearActive(slot: string): Promise<void> {
        await this.enqueue(() => this.clearActiveUnlocked(slot));
    }

    /**
     * 首次使用迁移：若该槽位无配置且 ApiKeyManager 已有 Key，收编为"默认"配置
     * @param slot 槽位标识（provider 名或变体名）
     * @param currentSite 当前站点设置值（支持站点切换的槽位传入）
     */
    static async ensureMigrated(slot: string, currentSite?: string): Promise<void> {
        await this.enqueue(async () => {
            await this.migrateSlotIndexUnlocked(slot);
            if (this.context.globalState.get<boolean>(this.migratedKey(slot), false)) {
                return;
            }
            if (this.readSlotItems(slot).length > 0) {
                await this.markMigrated(slot);
                return;
            }
            const existingKey = await ApiKeyManager.getApiKey(slot);
            if (!existingKey) {
                return;
            }
            const item: ConfigSetItem = { id: 'default', label: t('Default', '默认'), site: currentSite };
            await this.addUnlocked(slot, item, existingKey);
            await this.setActiveUnlocked(slot, item.id);
            await this.markMigrated(slot);
        });
    }
}
