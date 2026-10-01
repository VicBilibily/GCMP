/*---------------------------------------------------------------------------------------------
 *  提供商配置集存储（per-slot 模型）
 *  每个槽位（主 provider 或变体如 minimax-token）独立管理自己的配置列表与激活状态。
 *  一套配置 = 站点（仅主槽位）+ 一个 API Key。
 *  切换时只覆盖该槽位的 Key，各槽位互不影响。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { ApiKeyManager } from './apiKeyManager';
import { InterInstanceBus } from '../../interInstance';
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
 * 配置集切换模式：
 * - off：关闭自动切换
 * - failover：故障切换（连续失败达阈值后全局轮换激活配置）
 * - balance：负载均衡（按会话/子代理哈希分配 Key，失败 Key 按单元隔离后恢复）
 */
export type ConfigSetSwitchMode = 'off' | 'failover' | 'balance';

/** 负载均衡模式下某平衡单元对请求凭据的隔离记录（TTL 由消费方判定） */
export interface BalanceKeyExclusion {
    /** 平衡键（s:{sessionId} 或 a:{subSessionId}） */
    k: string;
    /** 请求 Key 与站点的不可逆指纹 */
    credentialId: string;
    /** 隔离发生时间戳 */
    at: number;
}

/**
 * 配置集存储（per-slot）
 */
export class ConfigSetStore {
    private static context: vscode.ExtensionContext;

    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    private static readonly INDEX_KEY = 'configSets';
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

    private static autoSwitchKey(slot: string): string {
        return `configSets.autoSwitch.${slot}`;
    }

    private static switchModeKey(slot: string): string {
        return `configSets.switchMode.${slot}`;
    }

    private static balanceExclusionsKey(slot: string): string {
        return `configSets.balanceExclusions.${slot}`;
    }

    private static readonly BALANCE_EXCLUSION_MAX = 500;

    private static applyOperationKey(slot: string): string {
        return `configSets.applyOperation.${slot}`;
    }

    private static secretKey(slot: string, id: string): string {
        return `configSet.${slot}.${id}`;
    }

    private static async markMigrated(slot: string): Promise<void> {
        await this.context.globalState.update(this.migratedKey(slot), true);
    }

    private static readSlotItems(slot: string): ConfigSetItem[] {
        const perSlot = this.context.globalState.get<ConfigSetItem[]>(this.itemsKey(slot));
        if (perSlot !== undefined) {
            return Array.isArray(perSlot) ? perSlot : [];
        }
        const legacy = this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY, {});
        const items = legacy[slot];
        return Array.isArray(items) ? items : [];
    }

    private static async writeSlotItems(slot: string, items: ConfigSetItem[]): Promise<void> {
        await this.context.globalState.update(this.itemsKey(slot), items.length > 0 ? items : undefined);
    }

    private static async migrateSlotIndexUnlocked(slot: string): Promise<void> {
        const legacy = this.context.globalState.get<Record<string, ConfigSetItem[]>>(this.INDEX_KEY);
        if (!legacy || !(slot in legacy)) {
            return;
        }
        const items = legacy[slot];
        const existingPerSlot = this.context.globalState.get<ConfigSetItem[]>(this.itemsKey(slot));
        if (existingPerSlot === undefined && Array.isArray(items) && items.length > 0) {
            await this.context.globalState.update(this.itemsKey(slot), items);
        }
        const rest = { ...legacy };
        delete rest[slot];
        await this.context.globalState.update(this.INDEX_KEY, Object.keys(rest).length > 0 ? rest : undefined);
    }

    private static writeQueue: Promise<unknown> = Promise.resolve();

    private static enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(task, task);
        this.writeQueue = run.catch(() => undefined);
        return run;
    }

    private static async mutateSlot<T>(
        slot: string,
        operationToken: string | undefined,
        task: (operationToken: string) => Promise<T>,
        markOperation = true
    ): Promise<T> {
        if (operationToken) {
            if (this.getApplyOperationToken(slot) !== operationToken) {
                throw new Error(t('Configuration update ownership has changed.', '配置更新所有权已变化。'));
            }
            return await task(operationToken);
        }

        return await this.enqueue(async () => {
            const token = crypto.randomUUID();
            if (markOperation) {
                await this.setApplyOperationToken(slot, token);
            }
            return await task(token);
        });
    }

    /** 列出某槽位的全部配置 */
    static list(slot: string): ConfigSetItem[] {
        return this.readSlotItems(slot);
    }

    static async backfillMissingSite(slot: string, site: string | undefined, operationToken?: string): Promise<void> {
        if (!site) {
            return;
        }
        await this.mutateSlot(
            slot,
            operationToken,
            async token => {
                await this.migrateSlotIndexUnlocked(slot);
                const items = this.readSlotItems(slot);
                if (!items.some(item => !item.site)) {
                    return;
                }
                await this.setApplyOperationToken(slot, token);
                await this.writeSlotItems(
                    slot,
                    items.map(item => (item.site ? item : { ...item, site }))
                );
            },
            false
        );
    }

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

    static isAutoSwitchEnabled(slot: string): boolean {
        if (!this.context) {
            return false;
        }
        return this.getSwitchMode(slot) !== 'off';
    }

    static getSwitchMode(slot: string): ConfigSetSwitchMode {
        if (!this.context) {
            return 'off';
        }
        const mode = this.context.globalState.get<ConfigSetSwitchMode>(this.switchModeKey(slot));
        if (mode === 'failover' || mode === 'balance') {
            return mode;
        }
        // 旧版本仅有布尔开关：启用即等价于故障切换模式
        return this.context.globalState.get<boolean>(this.autoSwitchKey(slot), false) ? 'failover' : 'off';
    }

    static async setSwitchMode(slot: string, mode: ConfigSetSwitchMode, operationToken?: string): Promise<void> {
        const update = async (): Promise<void> => {
            await this.context.globalState.update(this.switchModeKey(slot), mode === 'off' ? undefined : mode);
            // 写入新模式即完成旧布尔键迁移，避免旧实例回读legacy值
            await this.context.globalState.update(this.autoSwitchKey(slot), undefined);
            if (mode !== 'balance') {
                await this.context.globalState.update(this.balanceExclusionsKey(slot), undefined);
            }
        };
        if (operationToken) {
            if (this.getApplyOperationToken(slot) !== operationToken) {
                throw new Error(t('Configuration update ownership has changed.', '配置更新所有权已变化。'));
            }
            await update();
        } else {
            await this.enqueue(update);
        }
        try {
            InterInstanceBus.publish({
                type: 'apiKeyFailoverToggled',
                payload: { slot, enabled: mode !== 'off', mode }
            });
        } catch (error) {
            Logger.warn(`[ConfigSetStore] Failed to publish switch mode change for ${slot}:`, error);
        }
    }

    static async setAutoSwitchEnabled(slot: string, enabled: boolean, operationToken?: string): Promise<void> {
        await this.setSwitchMode(slot, enabled ? 'failover' : 'off', operationToken);
    }

    static getBalanceExclusions(slot: string): BalanceKeyExclusion[] {
        if (!this.context) {
            return [];
        }
        const value = this.context.globalState.get<BalanceKeyExclusion[]>(this.balanceExclusionsKey(slot));
        // 旧记录只有配置 ID，无法还原失败时实际使用的凭据。
        return Array.isArray(value) ? value.filter(entry => typeof entry?.credentialId === 'string') : [];
    }

    static async addBalanceExclusion(
        slot: string,
        balanceKey: string,
        credentialId: string,
        at: number
    ): Promise<void> {
        await this.enqueue(async () => {
            const next = this.getBalanceExclusions(slot).filter(
                entry => !(entry.k === balanceKey && entry.credentialId === credentialId)
            );
            next.push({ k: balanceKey, credentialId, at });
            while (next.length > this.BALANCE_EXCLUSION_MAX) {
                next.shift();
            }
            await this.context.globalState.update(this.balanceExclusionsKey(slot), next.length > 0 ? next : undefined);
        });
    }

    static getApplyOperationToken(slot: string): string | undefined {
        return this.context.globalState.get<string>(this.applyOperationKey(slot));
    }

    static async setApplyOperationToken(slot: string, token: string): Promise<void> {
        await this.context.globalState.update(this.applyOperationKey(slot), token);
    }

    static async getApiKey(slot: string, id: string): Promise<string | undefined> {
        return await this.context.secrets.get(this.secretKey(slot, id));
    }

    static async setApiKey(slot: string, id: string, apiKey: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(slot, operationToken, async () => {
            await this.context.secrets.store(this.secretKey(slot, id), apiKey);
        });
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
        apiKey?: string | null,
        operationToken?: string
    ): Promise<void> {
        await this.mutateSlot(slot, operationToken, async () => {
            await this.migrateSlotIndexUnlocked(slot);
            const previousItems = this.readSlotItems(slot);
            if (!previousItems.length) {
                return;
            }
            if (!previousItems.some(item => item.id === id)) {
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
                    if (apiKey === null || apiKey.trim().length === 0) {
                        // 空串与 null 同义：删除密钥，与 writeAll/消费端判空保持一致
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
        try {
            await this.markMigrated(slot);
        } catch (error) {
            Logger.warn(`[ConfigSetStore] Failed to mark ${slot} as migrated`, error);
        }
    }

    /** 新增一套配置 */
    static async add(slot: string, item: ConfigSetItem, apiKey: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(slot, operationToken, () => this.addUnlocked(slot, item, apiKey));
    }

    /** 删除一套配置 */
    static async remove(slot: string, id: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(slot, operationToken, async () => {
            await this.migrateSlotIndexUnlocked(slot);
            const previousItems = this.readSlotItems(slot);
            const items = previousItems.filter(i => i.id !== id);
            if (items.length === previousItems.length) {
                return;
            }
            const previousActiveId = this.getActiveId(slot);
            const secretKey = this.secretKey(slot, id);
            const previousKey = await this.context.secrets.get(secretKey);
            await this.writeSlotItems(slot, items);
            try {
                await this.context.secrets.delete(secretKey);
                if (previousActiveId === id) {
                    await this.clearActiveUnlocked(slot);
                }
            } catch (error) {
                let rollbackFailed = false;
                try {
                    await this.writeSlotItems(slot, previousItems);
                } catch (rollbackError) {
                    rollbackFailed = true;
                    Logger.error('[ConfigSetStore] Failed to roll back removed items:', rollbackError);
                }
                try {
                    if (previousKey === undefined) {
                        await this.context.secrets.delete(secretKey);
                    } else {
                        await this.context.secrets.store(secretKey, previousKey);
                    }
                } catch (restoreError) {
                    rollbackFailed = true;
                    Logger.error(`[ConfigSetStore] Failed to restore secret ${slot}:${id}`, restoreError);
                }
                try {
                    if (previousActiveId === undefined) {
                        await this.clearActiveUnlocked(slot);
                    } else {
                        await this.setActiveUnlocked(slot, previousActiveId);
                    }
                } catch (rollbackError) {
                    rollbackFailed = true;
                    Logger.error('[ConfigSetStore] Failed to roll back active configuration:', rollbackError);
                }
                if (rollbackFailed) {
                    Logger.error('[ConfigSetStore] remove rollback was incomplete');
                }
                throw error;
            }
            try {
                await this.markMigrated(slot);
            } catch (error) {
                Logger.warn(`[ConfigSetStore] Failed to mark ${slot} as migrated`, error);
            }
        });
    }

    /** 覆盖写入某槽位的整套配置集（同步下载用） */
    static async writeAll(
        slot: string,
        items: ConfigSetItem[],
        keys: Record<string, string | undefined>,
        activeId?: string,
        operationToken?: string
    ): Promise<void> {
        await this.mutateSlot(slot, operationToken, async () => {
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
                // 多键写入无跨键事务：进程崩溃可能停在中间留"有列表无密钥"的不一致（下次上传/下载可自愈）。
                // 先写 items 后写 secrets，使崩溃残留偏向用户可感知的缺密钥形态而非泄漏面更大的孤儿 secret
                await this.writeSlotItems(slot, items);
                for (const item of items) {
                    const key = keys[item.id];
                    if (key === undefined || key.trim().length === 0) {
                        await this.context.secrets.delete(this.secretKey(slot, item.id));
                        continue;
                    }
                    await this.context.secrets.store(this.secretKey(slot, item.id), key);
                }
                const activeKey = activeId ? keys[activeId]?.trim() : undefined;
                if (activeId && incomingIds.has(activeId) && activeKey) {
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

    static async setActive(slot: string, id: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(slot, operationToken, () => this.setActiveUnlocked(slot, id));
    }

    /** 清除激活标记（停用场景） */
    static async clearActive(slot: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(slot, operationToken, () => this.clearActiveUnlocked(slot));
    }

    /**
     * 首次使用迁移：若该槽位无配置且 ApiKeyManager 已有 Key，收编为"默认"配置
     * @param slot 槽位标识（provider 名或变体名）
     * @param currentSite 当前站点设置值（支持站点切换的槽位传入）
     */
    static async ensureMigrated(slot: string, currentSite?: string, operationToken?: string): Promise<void> {
        await this.mutateSlot(
            slot,
            operationToken,
            async token => {
                await this.migrateSlotIndexUnlocked(slot);
                if (this.context.globalState.get<boolean>(this.migratedKey(slot), false)) {
                    return;
                }
                if (this.readSlotItems(slot).length > 0) {
                    try {
                        await this.markMigrated(slot);
                    } catch (error) {
                        Logger.warn(`[ConfigSetStore] Failed to mark ${slot} as migrated`, error);
                    }
                    return;
                }
                const existingKey = await ApiKeyManager.getApiKey(slot);
                if (!existingKey) {
                    return;
                }
                await this.setApplyOperationToken(slot, token);
                const item: ConfigSetItem = { id: 'default', label: t('Default', '默认'), site: currentSite };
                await this.addUnlocked(slot, item, existingKey);
                await this.setActiveUnlocked(slot, item.id);
                try {
                    await this.markMigrated(slot);
                } catch (error) {
                    Logger.warn(`[ConfigSetStore] Failed to mark ${slot} as migrated`, error);
                }
            },
            false
        );
    }
}

/**
 * 构建状态栏 tooltip 中的"点击进入 API Key 管理页"命令链接。
 * 仅当槽位配置了多套配置（多于 1 套）时返回链接，否则返回 undefined。
 * 独立于 status 层，供状态栏在渲染 tooltip 时按需生成可点击链接。
 */
export function buildApiKeySwitchLink(slot: string): string | undefined {
    try {
        if (ConfigSetStore.list(slot).length <= 1) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    const args = JSON.stringify([slot]);
    return `[${t('Click to open API Key manager', '点击进入 API Key 管理页')}](command:gcmp.configSet.switchKey?${args})`;
}
