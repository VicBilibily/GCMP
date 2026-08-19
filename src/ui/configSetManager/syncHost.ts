/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - Gist 同步流程
 *  从 index.ts 抽出：上传 / 下载 / 口令解密 / 恢复等同步业务流程。
 *  通过构造注入 post 与 sendStates 回调与 Panel 解耦；口令下载上下文在内部维护。
 *---------------------------------------------------------------------------------------------*/

import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigSetStore, type ConfigSetItem } from '../../utils/config/configSetStore';
import {
    enqueueConfigSetMutation,
    getSiteOwnerProvider,
    readCurrentSite,
    siteLabel
} from '../../utils/config/configSetCommands';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
import {
    collectLocalConfigSets,
    createGistForConfigSets,
    diffConfigSets,
    findExistingConfigSetGist,
    readRemoteConfigSets,
    readRemoteConfigSetsWithPassphrase,
    writeRemoteConfigSets,
    SyncedSlotConfigSet,
    type ReadConfigSetResult
} from '../../sync/configSetSyncService';
import { getKeyDisplayName, GistSyncService } from '../../sync/gistSyncService';
import { runClearPassphraseFlow, runSetPassphraseFlow } from '../../sync/passphraseFlow';
import { collectManagedSlots } from './stateHost';
import * as vscode from 'vscode';
import type {
    GistSyncState,
    HostMessage,
    LocalItemSnapshot,
    RemoteManageSlotSnapshot,
    RemoteSlotSnapshot,
    SlotItemSelection,
    UploadSlotSnapshot
} from './types';

/** Panel 提供给同步流程的回调接口 */
export interface SyncHostContext {
    post(msg: HostMessage): void;
    sendStates(): Promise<void>;
}

/**
 * 配置集 Gist 同步流程宿主
 * 负责：上传本地配置集、读取远端、口令解密、应用恢复。
 */
export class ConfigSetSyncHost {
    private pendingPassphraseDownload: { token: string; gistId: string } | undefined;
    /** 当前恢复对话框对应的已解密快照；优先使用它恢复，避免再次依赖网络/口令状态。 */
    private preparedDownloadSlots: Record<string, SyncedSlotConfigSet> | undefined;

    private async maybePersistDownloadedPassphrase(passphrase: string): Promise<void> {
        const storedPassphrase = await GistSyncService.getCustomPassphrase();
        if (storedPassphrase === passphrase) {
            return;
        }
        if (!storedPassphrase) {
            const saveChoice = t('Save passphrase', '保存口令');
            const choice = await vscode.window.showInformationMessage(
                t(
                    'Decryption succeeded. Save this passphrase for future uploads and downloads on this device?',
                    '解密成功。是否把这个口令保存到当前设备，供以后上传和下载使用？'
                ),
                saveChoice,
                t('Not now', '暂不保存')
            );
            if (choice !== saveChoice) {
                return;
            }
        }
        const saved = await GistSyncService.setCustomPassphrase(passphrase);
        if (!saved) {
            Logger.warn('[ConfigSetManager] Failed to persist passphrase, using in-memory restore snapshot only');
            void vscode.window.showWarningMessage(
                t(
                    'The passphrase could not be saved. This restore will use the decrypted snapshot already loaded in memory only.',
                    '口令未能保存。本次恢复将仅使用当前已解密到内存中的快照。'
                )
            );
        }
    }

    private buildUnreadableRemoteUploadError(skipped?: number): string {
        return skipped && skipped > 0 ?
                t(
                    'Remote sync data still contains {0} undecryptable configuration(s). Upload is blocked until all remote items can be read safely.',
                    '远端同步数据仍有 {0} 项配置无法解密。为避免覆盖不可读的远端配置，当前已阻止上传。',
                    skipped
                )
            :   t(
                    'Remote sync data is currently unreadable. Upload is blocked until the remote data can be read safely.',
                    '远端同步数据暂不可读（网络异常或口令不匹配），为避免覆盖未知远端配置，当前已阻止上传。'
                );
    }

    private buildUnreadableRemoteManageError(skipped?: number): string {
        return skipped && skipped > 0 ?
                t(
                    'Remote sync data still contains {0} undecryptable configuration(s). Remote management is blocked until all remote items can be read safely.',
                    '远端同步数据仍有 {0} 项配置无法解密。为避免误删不可读的远端配置，当前已阻止远端管理。',
                    skipped
                )
            :   t(
                    'Remote sync data is currently unreadable. Remote management is blocked until the remote data can be read safely.',
                    '远端同步数据暂不可读（网络异常或口令不匹配），为避免误删未知远端配置，当前已阻止远端管理。'
                );
    }

    private clearPreparedDownloadState(clearPendingContext = false): void {
        this.preparedDownloadSlots = undefined;
        if (clearPendingContext) {
            this.pendingPassphraseDownload = undefined;
        }
    }

    dispose(): void {
        this.clearPreparedDownloadState(true);
    }

    discardPreparedRestore(): void {
        this.clearPreparedDownloadState();
    }

    constructor(private readonly ctx: SyncHostContext) {}

    private async snapshotSlotState(slot: string): Promise<{
        items: ConfigSetItem[];
        keys: Record<string, string | undefined>;
        activeId?: string;
    }> {
        const items = ConfigSetStore.list(slot).map(item => ({ ...item }));
        const keyEntries = await Promise.all(
            items.map(async item => [item.id, await ConfigSetStore.getApiKey(slot, item.id)] as const)
        );
        return {
            items,
            keys: Object.fromEntries(keyEntries),
            activeId: ConfigSetStore.getActiveId(slot)
        };
    }

    private async rollbackRestoreSlots(
        snapshots: Array<{
            slot: string;
            items: ConfigSetItem[];
            keys: Record<string, string | undefined>;
            activeId?: string;
        }>
    ): Promise<boolean> {
        let rollbackFailed = false;
        for (const snapshot of [...snapshots].reverse()) {
            try {
                await ConfigSetStore.writeAll(snapshot.slot, snapshot.items, snapshot.keys, snapshot.activeId);
            } catch (error) {
                rollbackFailed = true;
                Logger.error(`[ConfigSetManager] Failed to roll back restored slot ${snapshot.slot}:`, error);
            }
        }
        return !rollbackFailed;
    }

    private buildSkippedRemoteWarning(skipped: number | undefined): string | undefined {
        return skipped && skipped > 0 ?
                t(
                    'Skipped {0} undecryptable remote configuration(s). Only readable items are shown.',
                    '有 {0} 项远端配置无法解密，当前仅显示可读取项。',
                    skipped
                )
            :   undefined;
    }

    /** 上传入口：只做预检（收集本地 + 读远端 diff），实际写入由 handleUploadSelected 完成 */
    async handleUpload(): Promise<void> {
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const local = await collectLocalConfigSets();
            if (!local) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: t('No switchable API keys to sync.', '暂无可切换的 API Key。')
                });
                return;
            }
            const userInfo = await this.ensureGistToken();
            if (!userInfo) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                });
                return;
            }
            // 读取远端用于增量对比；不可读（网络异常/口令不匹配）时阻止上传
            let remoteSlots: Record<string, SyncedSlotConfigSet> | undefined;
            let remoteWarning: string | undefined;
            const gistId = await this.resolveGistId(userInfo.token);
            if (gistId) {
                const { result } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
                if (result.status === 'ok' && (result.skipped ?? 0) > 0) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'uploadResult',
                        ok: false,
                        error: this.buildUnreadableRemoteUploadError(result.skipped)
                    });
                    return;
                }
                if (result.status === 'ok' || result.status === 'not-found') {
                    remoteSlots = result.status === 'ok' ? (result.data.slots ?? {}) : {};
                    remoteWarning = result.status === 'ok' ? this.buildSkippedRemoteWarning(result.skipped) : undefined;
                }
            } else {
                remoteSlots = {};
            }
            // diffConfigSets(A, B) 产出 B 各槽位相对 A 的状态，此处取本地槽位相对远端的状态
            const status = remoteSlots ? diffConfigSets(remoteSlots, local) : undefined;
            await this.sendUploadPrep(status, remoteSlots !== undefined, remoteSlots, remoteWarning);
        } catch (error) {
            Logger.error('[ConfigSetManager] upload prep failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'uploadResult', ok: false, error: String(error) });
        } finally {
            await this.postSyncState();
        }
    }

    /** 逐项上传：选中项与远端按 id 合并，未选中的远端槽位/配置保留 */
    async handleUploadSelected(selections: SlotItemSelection[]): Promise<void> {
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const userInfo = await this.ensureGistToken();
            if (!userInfo) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                });
                return;
            }
            const local = await collectLocalConfigSets();
            if (!local) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: t('No switchable API keys to sync.', '暂无可切换的 API Key。')
                });
                return;
            }
            let gistId: string | undefined = await this.resolveGistId(userInfo.token);
            // 重新读取远端作为合并基（预检后远端可能已变化）
            let remoteSlots: Record<string, SyncedSlotConfigSet> | undefined;
            if (gistId) {
                const { result, usedGistId } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
                // 远端 Gist 已被删除时 usedGistId 为空：按无远端数据处理，后续写入走新建 Gist
                gistId = usedGistId;
                if (result.status === 'ok' && (result.skipped ?? 0) > 0) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'uploadResult',
                        ok: false,
                        error: this.buildUnreadableRemoteUploadError(result.skipped)
                    });
                    return;
                }
                if (result.status === 'ok' || result.status === 'not-found') {
                    remoteSlots = result.status === 'ok' ? (result.data.slots ?? {}) : {};
                }
            } else {
                remoteSlots = {};
            }

            const picked: Array<{
                slot: string;
                items: SyncedSlotConfigSet['items'];
                removeItemIds: string[];
            }> = [];
            for (const { slot, itemIds, removeItemIds } of selections) {
                const localItems = ConfigSetStore.list(slot);
                const localSet = local[slot];
                if (!localSet) {
                    continue;
                }
                const wanted = new Set(itemIds);
                const items = localSet.items.filter(item => wanted.has(item.id));
                if (items.length === 0) {
                    continue;
                }
                const normalizedRemoveItemIds = removeItemIds ?? [];
                const isFullLocalSelection =
                    localItems.length === localSet.items.length &&
                    items.length === localSet.items.length &&
                    wanted.size === localSet.items.length;
                if (normalizedRemoveItemIds.length > 0 && !isFullLocalSelection) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'uploadResult',
                        ok: false,
                        error: t(
                            'The upload selection is outdated. Reopen the upload dialog and retry.',
                            '上传选择已过期，请重新打开上传对话框后重试。'
                        )
                    });
                    return;
                }
                picked.push({ slot, items, removeItemIds: normalizedRemoveItemIds });
            }
            if (picked.length === 0) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: t('No uploadable configuration was selected.', '未选择任何可上传的配置。')
                });
                return;
            }

            if (remoteSlots === undefined) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'uploadResult',
                    ok: false,
                    error: this.buildUnreadableRemoteUploadError()
                });
                return;
            }

            const totalPicked = picked.reduce((sum, p) => sum + p.items.length, 0);

            // 激活状态不同步：合并只按 id 维护配置项
            const merged: Record<string, SyncedSlotConfigSet> = { ...(remoteSlots ?? {}) };
            for (const p of picked) {
                const existing = merged[p.slot];
                if (!existing) {
                    merged[p.slot] = { items: p.items };
                } else {
                    const byId = new Map(existing.items.map(item => [item.id, item]));
                    for (const id of p.removeItemIds) {
                        byId.delete(id);
                    }
                    for (const item of p.items) {
                        byId.set(item.id, item);
                    }
                    merged[p.slot] = { ...existing, items: Array.from(byId.values()) };
                }
            }

            const data = { version: 1 as const, timestamp: new Date().toISOString(), slots: merged };
            let ok = false;
            if (gistId) {
                ok = await writeRemoteConfigSets(userInfo.token, gistId, data);
                if (ok) {
                    await GistSyncService.saveConfigSetGistId(gistId);
                }
            } else {
                const newGistId = await createGistForConfigSets(userInfo.token, data);
                if (newGistId) {
                    await GistSyncService.saveConfigSetGistId(newGistId);
                    ok = true;
                }
            }
            const warning = this.buildKeylessWarning(local);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({
                command: 'uploadResult',
                ok,
                warning,
                uploadedCount: ok ? totalPicked : undefined,
                error:
                    ok ? undefined : (
                        t('Failed to write config set sync data to Gist.', '配置集同步数据写入 Gist 失败。')
                    )
            });
            if (ok) {
                this.clearPreparedDownloadState();
            }
        } catch (error) {
            Logger.error('[ConfigSetManager] upload failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'uploadResult', ok: false, error: String(error) });
        } finally {
            await this.postSyncState();
        }
    }

    /** 缺 Key 警告：覆盖整个槽位未上传，以及槽位内部分配置因缺 Key 被跳过两种情形 */
    private buildKeylessWarning(local: Record<string, SyncedSlotConfigSet>): string | undefined {
        const keyless: string[] = [];
        for (const slot of ConfigSetStore.listProviders()) {
            const items = ConfigSetStore.list(slot);
            if (items.length === 0) {
                continue;
            }
            const missing = items.length - (local[slot]?.items.length ?? 0);
            if (missing === items.length) {
                keyless.push(slot);
            } else if (missing > 0) {
                keyless.push(`${slot} (${missing}/${items.length})`);
            }
        }
        return keyless.length > 0 ?
                t(
                    'Configurations missing API keys (not uploaded): {0}',
                    '缺少 API Key 的配置（未上传）：{0}',
                    keyless.join(', ')
                )
            :   undefined;
    }

    async handleDownload(): Promise<void> {
        this.pendingPassphraseDownload = undefined;
        this.clearPreparedDownloadState();
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const userInfo = await this.ensureGistToken();
            if (!userInfo) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                });
                return;
            }
            const gistId = await this.resolveGistId(userInfo.token);
            if (!gistId) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t('No sync Gist found. Upload first.', '未找到同步 Gist，请先上传。')
                });
                return;
            }
            const { result, usedGistId } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
            if (result.status === 'error') {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t(
                        'Failed to read from Gist. Check network and GitHub authentication.',
                        '从 Gist 读取失败，请检查网络与 GitHub 认证。'
                    )
                });
                return;
            }
            if (result.status === 'not-found') {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error:
                        usedGistId ?
                            t('No provider configuration sync data found on Gist.', 'Gist 上未找到配置集同步数据。')
                        :   t('No sync Gist found. Upload first.', '未找到同步 Gist，请先上传。')
                });
                return;
            }
            if (result.status === 'decrypt-failed') {
                this.pendingPassphraseDownload = { token: userInfo.token, gistId: usedGistId ?? gistId };
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({ command: 'requestPassphrase' });
                return;
            }
            // result.status === 'ok'
            if (!result.data.slots || Object.keys(result.data.slots).length === 0) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t('No provider configuration sync data found on Gist.', 'Gist 上未找到配置集同步数据。')
                });
                return;
            }
            const local = await collectLocalConfigSets();
            const remote = result.data.slots;
            this.preparedDownloadSlots = remote;
            const status = diffConfigSets(local, remote);
            await this.sendDownloadPrep(remote, status, this.buildSkippedRemoteWarning(result.skipped));
        } catch (error) {
            Logger.error('[ConfigSetManager] download failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'downloadResult', ok: false, error: String(error) });
        } finally {
            await this.postSyncState();
        }
    }

    async handleDownloadWithPassphrase(passphrase: string): Promise<void> {
        try {
            const context = this.pendingPassphraseDownload;
            this.clearPreparedDownloadState();
            if (!context) {
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t(
                        'No pending download request. Please retry restore.',
                        '没有待处理的恢复请求，请重新发起恢复。'
                    )
                });
                return;
            }

            this.ctx.post({ command: 'syncStatus', busy: true });
            const retry = await readRemoteConfigSetsWithPassphrase(context.token, context.gistId, passphrase.trim());
            if (retry.status === 'error') {
                this.pendingPassphraseDownload = undefined;
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t('Failed to read from Gist.', '从 Gist 读取失败。')
                });
                return;
            }
            if (retry.status === 'not-found' || retry.status === 'gist-missing') {
                this.pendingPassphraseDownload = undefined;
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'downloadResult',
                    ok: false,
                    error: t('No sync data found.', '未找到同步数据。')
                });
                return;
            }
            if (retry.status === 'decrypt-failed' || !retry.data.slots || Object.keys(retry.data.slots).length === 0) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'requestPassphrase',
                    error: t('Decryption failed. Please verify the passphrase.', '解密失败，请确认口令是否正确。')
                });
                return;
            }
            const normalizedPassphrase = passphrase.trim();
            this.preparedDownloadSlots = retry.data.slots;
            if ((retry.skipped ?? 0) > 0) {
                void vscode.window.showWarningMessage(
                    t(
                        'The passphrase was not saved because {0} remote configuration(s) are still undecryptable. You can restore the readable items from the current snapshot, but upload and remote management stay blocked until every remote item can be read.',
                        '由于仍有 {0} 项远端配置无法解密，当前不会保存该口令。你仍可先从当前快照恢复可读项，但在全部远端项可读取前，上传和远端管理仍会被阻止。',
                        retry.skipped
                    )
                );
            } else {
                await this.maybePersistDownloadedPassphrase(normalizedPassphrase);
            }
            this.pendingPassphraseDownload = undefined;
            await this.sendDownloadPrep(retry.data.slots, undefined, this.buildSkippedRemoteWarning(retry.skipped));
        } catch (error) {
            this.pendingPassphraseDownload = undefined;
            Logger.error('[ConfigSetManager] download with passphrase failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'downloadResult', ok: false, error: String(error) });
        } finally {
            await this.postSyncState();
        }
    }

    async handleRestore(selections: SlotItemSelection[]): Promise<void> {
        this.ctx.post({ command: 'syncStatus', busy: true });
        const appliedSnapshots: Array<{
            slot: string;
            items: ConfigSetItem[];
            keys: Record<string, string | undefined>;
            activeId?: string;
        }> = [];
        try {
            let remote = this.preparedDownloadSlots;
            if (!remote) {
                const userInfo = await this.ensureGistToken();
                if (!userInfo) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'downloadResult',
                        ok: false,
                        error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                    });
                    return;
                }
                const gistId = await this.resolveGistId(userInfo.token);
                if (!gistId) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'downloadResult',
                        ok: false,
                        error: t('No sync Gist found.', '未找到同步 Gist。')
                    });
                    return;
                }
                const { result } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
                if (result.status !== 'ok' || !result.data.slots) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'downloadResult',
                        ok: false,
                        error: t('Remote data unavailable. Retry download.', '远端数据不可用，请重试下载。')
                    });
                    return;
                }
                remote = result.data.slots;
            }

            const restoreSelections: Array<{
                slot: string;
                selectedItems: (ConfigSetItem & { apiKey: string })[];
                selectedCount: number;
            }> = [];
            let applied = 0;
            for (const { slot, itemIds } of selections) {
                const set = remote[slot];
                if (!set) {
                    continue;
                }
                const wanted = new Set(itemIds);
                const selectedItems = set.items.filter(item => wanted.has(item.id));
                if (selectedItems.length === 0) {
                    continue;
                }
                restoreSelections.push({
                    slot,
                    selectedItems,
                    selectedCount: selectedItems.length
                });
            }

            // 提交与失败回滚必须占用同一条变更队列，避免恢复半途中被其他本地变更插队。
            await enqueueConfigSetMutation(async () => {
                try {
                    for (const selection of restoreSelections) {
                        const previous = await this.snapshotSlotState(selection.slot);
                        const mergedItems = new Map(previous.items.map(item => [item.id, item] as const));
                        const mergedKeys: Record<string, string | undefined> = { ...previous.keys };
                        for (const item of selection.selectedItems) {
                            const { apiKey, ...meta } = item;
                            mergedItems.set(item.id, meta);
                            mergedKeys[item.id] = apiKey;
                        }
                        await ConfigSetStore.writeAll(
                            selection.slot,
                            Array.from(mergedItems.values()),
                            mergedKeys,
                            previous.activeId
                        );
                        appliedSnapshots.push({ slot: selection.slot, ...previous });
                        // 激活状态由本地确认：生效 Key 匹配恢复项时补登激活标记，不改动当前生效 Key
                        await this.confirmLocalActive(selection.slot);
                        applied += selection.selectedCount;
                        Logger.info(
                            `[ConfigSetSync] Restored ${selection.selectedCount} config set(s) for ${selection.slot}`
                        );
                    }
                } catch (error) {
                    let restoreError = error instanceof Error ? error : new Error(String(error));
                    if (appliedSnapshots.length > 0) {
                        const rollbackOk = await this.rollbackRestoreSlots(appliedSnapshots);
                        if (!rollbackOk) {
                            restoreError = new Error(
                                t(
                                    'Restore failed and local rollback was incomplete. Please review the local configurations before retrying.',
                                    '恢复失败，且本地回滚未完整完成。请检查当前本地配置后再重试。'
                                )
                            );
                        }
                    }
                    throw restoreError;
                }
            });
            await this.ctx.sendStates();
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'downloadResult', ok: true, appliedCount: applied });
        } catch (error) {
            Logger.error('[ConfigSetManager] restore failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({
                command: 'downloadResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        } finally {
            this.clearPreparedDownloadState();
            await this.postSyncState();
        }
    }

    /**
     * 激活状态本地确认（恢复后调用）：生效 Key + 当前站点匹配到某配置项时补登激活标记，
     * 均不匹配时清除残留标记；不改动当前生效的 Key（激活是本地运行时状态，不随同步强制变更）
     */
    private async confirmLocalActive(slot: string): Promise<void> {
        const currentKey = await ApiKeyManager.getApiKey(slot);
        if (!currentKey) {
            if (ConfigSetStore.getActiveId(slot)) {
                await ConfigSetStore.clearActive(slot);
            }
            return;
        }
        const siteProvider = getSiteOwnerProvider(slot);
        const currentSite = siteProvider ? readCurrentSite(siteProvider) : undefined;
        for (const item of ConfigSetStore.list(slot)) {
            if ((await ConfigSetStore.getApiKey(slot, item.id)) !== currentKey) {
                continue;
            }
            if (siteProvider && (item.site ?? currentSite) !== currentSite) {
                continue;
            }
            if (ConfigSetStore.getActiveId(slot) !== item.id) {
                await ConfigSetStore.setActive(slot, item.id);
            }
            return;
        }
        if (ConfigSetStore.getActiveId(slot)) {
            await ConfigSetStore.clearActive(slot);
        }
    }

    /** 远端配置管理入口：读取远端配置集快照，供勾选保留项（未勾选的将被删除） */
    async handleListRemoteConfigs(): Promise<void> {
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const userInfo = await this.ensureGistToken();
            if (!userInfo) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                });
                return;
            }
            const gistId = await this.resolveGistId(userInfo.token);
            if (!gistId) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: t('No sync Gist found. Upload first.', '未找到同步 Gist，请先上传。')
                });
                return;
            }
            const { result } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
            if (result.status === 'ok') {
                if ((result.skipped ?? 0) > 0) {
                    this.ctx.post({ command: 'syncStatus', busy: false });
                    this.ctx.post({
                        command: 'remoteConfigsResult',
                        ok: false,
                        error: this.buildUnreadableRemoteManageError(result.skipped)
                    });
                    return;
                }
                const ordering = this.managedSlotOrdering();
                const sortedEntries = Object.entries(result.data.slots ?? {}).sort((a, b) =>
                    ordering.compare(a[0], b[0])
                );
                const snapshots: RemoteManageSlotSnapshot[] = [];
                for (const [slot, set] of sortedEntries) {
                    const siteProvider = getSiteOwnerProvider(slot);
                    snapshots.push({
                        slot,
                        displayName: ordering.displayName(slot),
                        items: set.items.map(item => ({
                            id: item.id,
                            label: item.label,
                            siteLabel: siteProvider ? siteLabel(siteProvider, item.site) : undefined,
                            note: item.note
                        }))
                    });
                }
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsPrep',
                    snapshots,
                    warning: this.buildSkippedRemoteWarning(result.skipped)
                });
                return;
            }
            if (result.status === 'not-found') {
                // 远端尚无配置数据：下发空快照，由前端提示无可管理内容
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({ command: 'remoteConfigsPrep', snapshots: [] });
                return;
            }
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({
                command: 'remoteConfigsResult',
                ok: false,
                error:
                    result.status === 'decrypt-failed' ?
                        t(
                            'Remote data could not be decrypted. Restore with the correct passphrase first.',
                            '远端数据无法解密，请先通过正确口令完成恢复。'
                        )
                    :   t(
                            'Failed to read from Gist. Check network and GitHub authentication.',
                            '从 Gist 读取失败，请检查网络与 GitHub 认证。'
                        )
            });
        } catch (error) {
            Logger.error('[ConfigSetManager] list remote configs failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'remoteConfigsResult', ok: false, error: String(error) });
        }
    }

    /** 应用远端删除清单：删除指定配置项；槽位被清空时整体移除，激活项被删时清除激活标记 */
    async handleApplyRemoteConfigs(remove: SlotItemSelection[]): Promise<void> {
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const userInfo = await this.ensureGistToken();
            if (!userInfo) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: t('GitHub authentication failed.', 'GitHub 认证失败。')
                });
                return;
            }
            const gistId = await this.resolveGistId(userInfo.token);
            if (!gistId) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: t('No sync Gist found.', '未找到同步 Gist。')
                });
                return;
            }
            // 重新读取远端作为改写基（对话框打开期间远端可能已变化）
            const { result, usedGistId } = await this.readConfigSetsWithFallback(userInfo.token, gistId);
            if (result.status === 'ok' && (result.skipped ?? 0) > 0) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: this.buildUnreadableRemoteManageError(result.skipped)
                });
                return;
            }
            if (result.status !== 'ok' || !result.data.slots) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({
                    command: 'remoteConfigsResult',
                    ok: false,
                    error: t('Remote data unavailable. Retry download.', '远端数据不可用，请重试下载。')
                });
                return;
            }
            const removeMap = new Map(remove.map(sel => [sel.slot, new Set(sel.itemIds)]));
            const slots: Record<string, SyncedSlotConfigSet> = {};
            let removed = 0;
            for (const [slot, set] of Object.entries(result.data.slots)) {
                const removeIds = removeMap.get(slot);
                // 只删显式移除项；对话框打开期间远端新增的项不在清单内，予以保留
                const items = removeIds ? set.items.filter(item => !removeIds.has(item.id)) : set.items;
                removed += set.items.length - items.length;
                if (items.length === 0) {
                    continue;
                }
                slots[slot] = { ...set, items };
            }
            if (removed === 0) {
                this.ctx.post({ command: 'syncStatus', busy: false });
                this.ctx.post({ command: 'remoteConfigsResult', ok: true, removedCount: 0 });
                return;
            }
            const data = { version: 1 as const, timestamp: new Date().toISOString(), slots };
            const ok = await writeRemoteConfigSets(userInfo.token, usedGistId ?? gistId, data);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({
                command: 'remoteConfigsResult',
                ok,
                removedCount: ok ? removed : undefined,
                error:
                    ok ? undefined : (
                        t('Failed to write config set sync data to Gist.', '配置集同步数据写入 Gist 失败。')
                    )
            });
            if (ok) {
                this.clearPreparedDownloadState();
            }
        } catch (error) {
            Logger.error('[ConfigSetManager] apply remote configs failed:', error);
            this.ctx.post({ command: 'syncStatus', busy: false });
            this.ctx.post({ command: 'remoteConfigsResult', ok: false, error: String(error) });
        }
    }

    /** 构建当前 Gist 同步状态（静默探测，不触发授权弹窗） */
    async buildSyncState(): Promise<GistSyncState> {
        const status = await GistSyncService.getStatus();
        return {
            isLoggedIn: status.isLoggedIn,
            githubUser: status.githubUser,
            hasGist: !!GistSyncService.getConfigSetGistId(),
            hasCustomPassphrase: status.hasCustomPassphrase
        };
    }

    /** 设置/更改加密口令（复用公共原生输入流程，"更改并重传"走配置集全量覆盖重写） */
    async handleSetPassphrase(): Promise<void> {
        try {
            const hasGist = await this.detectConfigSetGist();
            await runSetPassphraseFlow(hasGist);
            this.clearPreparedDownloadState();
        } finally {
            // 口令流程异常/取消也要刷新同步状态（口令哈希可能已变化）
            await this.postSyncState();
        }
    }

    /** 清除自定义加密口令 */
    async handleClearPassphrase(): Promise<void> {
        try {
            await runClearPassphraseFlow();
            this.clearPreparedDownloadState();
        } finally {
            await this.postSyncState();
        }
    }

    /**
     * 探测是否已有关联配置集数据的远端 Gist（含解析并缓存），
     * 供口令流程正确识别"已有远端数据"，避免误判为首次设置而不提示数据不可解密；
     * 未登录时尝试弹出授权，用户取消则视为无远端数据（口令流程继续、但不提示重传）。
     */
    private async detectConfigSetGist(): Promise<boolean> {
        if (GistSyncService.getConfigSetGistId()) {
            return true;
        }
        const silent = await GistSyncService.getUserInfo(true);
        const userInfo = silent ?? (await GistSyncService.getUserInfo(false));
        if (!userInfo) {
            return false;
        }
        return !!(await this.resolveGistId(userInfo.token));
    }

    /** 推送最新同步状态到前端（旧版迁移等外部流程也可能改变口令状态，需可外部调用） */
    async postSyncState(): Promise<void> {
        this.ctx.post({ command: 'syncState', syncState: await this.buildSyncState() });
    }

    private async ensureGistToken(): Promise<{ login: string; id: number; token: string } | undefined> {
        const silent = await GistSyncService.getUserInfo(true);
        if (silent) {
            return silent;
        }
        return await GistSyncService.getUserInfo(false);
    }

    private async resolveGistId(token: string): Promise<string | undefined> {
        const gistId = GistSyncService.getConfigSetGistId();
        if (gistId) {
            return gistId;
        }
        const discoveredGistId = await findExistingConfigSetGist(token);
        if (discoveredGistId) {
            await GistSyncService.saveConfigSetGistId(discoveredGistId);
            return discoveredGistId;
        }
        return undefined;
    }

    /**
     * 读取远端配置集：先用传入的 gistId，若该 Gist 无配置集文件或已被删除则回退查找现有配置集 Gist。
     * @returns 读取结果与实际使用的 gistId；Gist 已被删除且无可回退时 usedGistId 为 undefined（调用方走新建）
     */
    private async readConfigSetsWithFallback(
        token: string,
        gistId: string
    ): Promise<{ result: Exclude<ReadConfigSetResult, { status: 'gist-missing' }>; usedGistId: string | undefined }> {
        const result = await readRemoteConfigSets(token, gistId);
        if (result.status === 'ok') {
            await GistSyncService.saveConfigSetGistId(gistId);
            return { result, usedGistId: gistId };
        }
        if (result.status === 'decrypt-failed') {
            const configSetGistId = await findExistingConfigSetGist(token);
            if (configSetGistId && configSetGistId !== gistId) {
                await GistSyncService.saveConfigSetGistId(configSetGistId);
                const fallbackResult = await readRemoteConfigSets(token, configSetGistId);
                if (fallbackResult.status === 'ok' || fallbackResult.status === 'decrypt-failed') {
                    return { result: fallbackResult, usedGistId: configSetGistId };
                }
            }
            await GistSyncService.saveConfigSetGistId(gistId);
            return { result, usedGistId: gistId };
        }
        if (result.status === 'not-found' || result.status === 'gist-missing') {
            if (result.status === 'gist-missing' && GistSyncService.getConfigSetGistId() === gistId) {
                // 本地保存的配置集 Gist 已在远端被删除，清除失效 ID 避免后续流程继续命中
                await GistSyncService.clearConfigSetGistId();
            }
            const configSetGistId = await findExistingConfigSetGist(token);
            if (configSetGistId && configSetGistId !== gistId) {
                await GistSyncService.saveConfigSetGistId(configSetGistId);
                const fallbackResult = await readRemoteConfigSets(token, configSetGistId);
                if (fallbackResult.status !== 'gist-missing') {
                    return { result: fallbackResult, usedGistId: configSetGistId };
                }
            }
            if (result.status === 'gist-missing') {
                // Gist 已删除且无可回退：视为无远端数据，上传走新建、下载报未找到
                return { result: { status: 'not-found' }, usedGistId: undefined };
            }
        }
        return { result, usedGistId: gistId };
    }

    /** 受管槽位的默认排序比较与友好名称解析（顺序同面板管理）；未受管槽位排最后，名称回退 getKeyDisplayName */
    private managedSlotOrdering(): { compare(a: string, b: string): number; displayName(slot: string): string } {
        const managed = collectManagedSlots();
        const order = new Map(managed.map((m, index) => [m.slot, index] as const));
        const displayNames = new Map(managed.map(m => [m.slot, m.displayName] as const));
        return {
            compare: (a, b) => (order.get(a) ?? managed.length) - (order.get(b) ?? managed.length),
            displayName: slot => displayNames.get(slot) ?? getKeyDisplayName(`${slot}.apiKey`)
        };
    }

    /** 构建并下发上传预检快照（含缺 Key 项，供逐项选择；缺 Key 项在前端禁用；远端可读时附远端独有项提示） */
    private async sendUploadPrep(
        status: Record<string, 'new' | 'update' | 'unchanged'> | undefined,
        remoteReadable: boolean,
        remoteSlots?: Record<string, SyncedSlotConfigSet>,
        warning?: string
    ): Promise<void> {
        const ordering = this.managedSlotOrdering();
        const snapshots: UploadSlotSnapshot[] = [];
        for (const slot of ConfigSetStore.listProviders().sort(ordering.compare)) {
            const items = ConfigSetStore.list(slot);
            if (items.length === 0) {
                continue;
            }
            const activeId = ConfigSetStore.getActiveId(slot);
            const siteProvider = getSiteOwnerProvider(slot);
            const itemSnapshots: LocalItemSnapshot[] = [];
            for (const item of items) {
                const apiKey = await ConfigSetStore.getApiKey(slot, item.id);
                itemSnapshots.push({
                    id: item.id,
                    label: item.label,
                    siteLabel: siteProvider ? siteLabel(siteProvider, item.site) : undefined,
                    note: item.note,
                    hasKey: !!apiKey,
                    isActive: item.id === activeId
                });
            }
            const localIds = new Set(items.map(item => item.id));
            const remoteOnlyItems = (remoteSlots?.[slot]?.items ?? []).filter(item => !localIds.has(item.id));
            const remoteOnlyLabels = remoteOnlyItems.map(item => item.label);
            snapshots.push({
                slot,
                displayName: ordering.displayName(slot),
                status: status?.[slot],
                remoteOnlyLabels: remoteOnlyLabels.length > 0 ? remoteOnlyLabels : undefined,
                remoteOnlyIds: remoteOnlyItems.length > 0 ? remoteOnlyItems.map(item => item.id) : undefined,
                items: itemSnapshots
            });
        }
        this.ctx.post({ command: 'syncStatus', busy: false });
        this.ctx.post({ command: 'uploadPrep', snapshots, remoteReadable, warning });
    }

    private async sendDownloadPrep(
        remote: Record<string, SyncedSlotConfigSet>,
        status?: Record<string, 'new' | 'update' | 'unchanged'>,
        warning?: string
    ): Promise<void> {
        const local = await collectLocalConfigSets();
        const computedStatus = status ?? diffConfigSets(local, remote);
        const ordering = this.managedSlotOrdering();
        const snapshots: RemoteSlotSnapshot[] = [];
        for (const [slot, set] of Object.entries(remote).sort((a, b) => ordering.compare(a[0], b[0]))) {
            const siteProvider = getSiteOwnerProvider(slot);
            snapshots.push({
                slot,
                displayName: ordering.displayName(slot),
                itemCount: set.items.length,
                status: computedStatus[slot] ?? 'update',
                items: set.items.map(item => ({
                    id: item.id,
                    label: item.label,
                    siteLabel: siteProvider ? siteLabel(siteProvider, item.site) : undefined,
                    note: item.note
                }))
            });
        }
        this.ctx.post({ command: 'syncStatus', busy: false });
        this.ctx.post({ command: 'downloadPrep', snapshots, warning });
    }
}
