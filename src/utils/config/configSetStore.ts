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

    /** 索引键：Record<slot, ConfigSetItem[]>，slot = provider 名或变体名 */
    private static readonly INDEX_KEY = 'configSets';

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

    private static readIndex(): Record<string, ConfigSetItem[]> {
        return this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY, {});
    }

    private static async writeIndex(all: Record<string, ConfigSetItem[]>): Promise<void> {
        await this.context.globalState.update(this.INDEX_KEY, all);
    }

    /**
     * 串行化"读-改-写"临界区：避免同实例内并发操作互相覆盖。
     * （跨窗口仍为 last-write-wins，属 VS Code globalState 存储的固有局限）
     */
    private static writeQueue: Promise<unknown> = Promise.resolve();

    private static enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(task, task);
        this.writeQueue = run.catch(() => undefined);
        return run;
    }

    /** 列出某槽位的全部配置 */
    static list(slot: string): ConfigSetItem[] {
        const items = this.readIndex()[slot];
        return Array.isArray(items) ? items : [];
    }

    static async backfillMissingSite(slot: string, site: string | undefined): Promise<void> {
        await this.enqueue(async () => {
            if (!site) {
                return;
            }
            const all = this.readIndex();
            const items = all[slot];
            if (!Array.isArray(items) || !items.some(item => !item.site)) {
                return;
            }
            all[slot] = items.map(item => (item.site ? item : { ...item, site }));
            await this.writeIndex(all);
        });
    }

    /** 列出所有存在配置集的槽位 */
    static listProviders(): string[] {
        const all = this.readIndex();
        return Object.entries(all)
            .filter(([, items]) => Array.isArray(items) && items.length > 0)
            .map(([slot]) => slot);
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
            const previousIndex = this.readIndex();
            const items = previousIndex[slot];
            if (!Array.isArray(items)) {
                return;
            }

            const nextIndex = { ...previousIndex };
            nextIndex[slot] = items.map(item => {
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
                await this.writeIndex(nextIndex);
            } catch (error) {
                if (apiKey !== undefined) {
                    if (previousKey === undefined) {
                        await this.context.secrets.delete(this.secretKey(slot, id));
                    } else {
                        await this.context.secrets.store(this.secretKey(slot, id), previousKey);
                    }
                }
                await this.writeIndex(previousIndex);
                throw error;
            }
        });
    }

    /** 新增一套配置（enqueue 内部实现，供入队上下文复用，避免嵌套入队死锁） */
    private static async addUnlocked(slot: string, item: ConfigSetItem, apiKey: string): Promise<void> {
        const all = this.readIndex();
        const items = Array.isArray(all[slot]) ? all[slot]! : [];
        items.push(item);
        all[slot] = items;
        await this.context.secrets.store(this.secretKey(slot, item.id), apiKey);
        try {
            await this.writeIndex(all);
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
            const all = this.readIndex();
            const items = (all[slot] ?? []).filter(i => i.id !== id);
            if (items.length > 0) {
                all[slot] = items;
            } else {
                delete all[slot];
            }
            await this.writeIndex(all);
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
        keys: Record<string, string>,
        activeId?: string
    ): Promise<void> {
        await this.enqueue(async () => {
            const previousIndex = this.readIndex();
            const previousItems = Array.isArray(previousIndex[slot]) ? previousIndex[slot]! : [];
            const previousActiveId = this.getActiveId(slot);
            const incomingIds = new Set(items.map(item => item.id));
            const touchedIds = new Set(items.map(item => item.id));
            const previousKeys = new Map<string, string | undefined>();
            for (const id of touchedIds) {
                previousKeys.set(id, await this.context.secrets.get(this.secretKey(slot, id)));
            }

            const nextIndex = { ...previousIndex };
            if (items.length === 0) {
                delete nextIndex[slot];
            } else {
                nextIndex[slot] = items;
            }

            try {
                for (const item of items) {
                    const key = keys[item.id];
                    if (!key) {
                        throw new Error(`Missing API key for restored configuration ${slot}:${item.id}`);
                    }
                    await this.context.secrets.store(this.secretKey(slot, item.id), key);
                }
                await this.writeIndex(nextIndex);
                if (activeId) {
                    await this.setActiveUnlocked(slot, activeId);
                } else {
                    await this.clearActiveUnlocked(slot);
                }
            } catch (error) {
                let rollbackFailed = false;
                try {
                    await this.writeIndex(previousIndex);
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

    /** 合并写入部分配置项（逐项恢复用）：同 id 覆盖元数据与 Key，未选中的本地配置保留 */
    static async upsert(slot: string, items: ConfigSetItem[], keys: Record<string, string>): Promise<void> {
        await this.enqueue(async () => {
            const previousIndex = this.readIndex();
            const existing = Array.isArray(previousIndex[slot]) ? previousIndex[slot]! : [];
            const byId = new Map(existing.map(item => [item.id, item] as const));
            for (const item of items) {
                byId.set(item.id, item);
            }
            const nextIndex = { ...previousIndex, [slot]: Array.from(byId.values()) };
            const previousKeys = new Map<string, string | undefined>();

            for (const item of items) {
                previousKeys.set(item.id, await this.context.secrets.get(this.secretKey(slot, item.id)));
            }

            try {
                for (const item of items) {
                    const key = keys[item.id];
                    if (key) {
                        await this.context.secrets.store(this.secretKey(slot, item.id), key);
                    }
                }

                await this.writeIndex(nextIndex);
            } catch (error) {
                for (const item of items) {
                    const previousKey = previousKeys.get(item.id);
                    if (previousKey === undefined) {
                        await this.context.secrets.delete(this.secretKey(slot, item.id));
                    } else {
                        await this.context.secrets.store(this.secretKey(slot, item.id), previousKey);
                    }
                }
                await this.writeIndex(previousIndex);
                throw error;
            }

            await this.markMigrated(slot);
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
            if (this.context.globalState.get<boolean>(this.migratedKey(slot), false)) {
                return;
            }
            if (this.list(slot).length > 0) {
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
