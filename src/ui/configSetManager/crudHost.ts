/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 配置集 CRUD 与 CLI 操作
 *  从 index.ts 抽出：add / apply / edit / remove / setupCli / openCliTerminal。
 *  通过 PanelContext 调用 sendStates / refreshCliProviders / refreshCliUsage。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigSetItem, ConfigSetStore } from '../../utils/config/configSetStore';
import { getBalanceWeight } from '../../utils/config/balanceWeight';
import {
    applyConfigSetUnlocked,
    applySiteSetting,
    applyConfigSet,
    deactivateConfigSet,
    deactivateConfigSetUnlocked,
    enqueueConfigSetMutation,
    getSiteOwnerProvider,
    notifySlotProviderChanged,
    readCurrentSite,
    siteLabel
} from '../../utils/config/configSetCommands';
import { CliAuthFactory } from '../../cli/auth/cliAuthFactory';
import { OAuthCredentialStore } from '../../cli/auth/oauthCredentialStore';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
import { ApiKeyFailoverManager } from '../../utils/config/failover/apiKeyFailoverManager';
import { BalanceAffinityCache } from '../../utils/config/failover/balanceAffinityCache';
import { collectManagedSlots } from './stateHost';
import type { ActiveConfigItemSnapshot, ActiveKeyAction, ActiveSlotSnapshot, PanelContext } from './types';

/** 生成新配置 ID */
function newId(): string {
    return randomUUID();
}

interface ActiveStateSnapshot {
    slot: string;
    activeId?: string;
    currentKey?: string;
    currentSite?: string;
    siteProvider?: string;
}

/**
 * 配置集 CRUD 与 CLI 操作宿主
 * 负责：handleAdd / handleApply / handleEdit / handleRemove / handleSetupCli / handleOpenCliTerminal。
 */
export class CrudHost {
    constructor(private readonly ctx: PanelContext) {}

    private async sendStatesAfterCommit(action: string): Promise<void> {
        if (!this.ctx.isAlive()) {
            return;
        }
        try {
            await this.ctx.sendStates();
        } catch (error) {
            Logger.warn(`[ConfigSet] Failed to refresh panel after ${action}:`, error);
            void vscode.window.showWarningMessage(
                t(
                    'The operation succeeded, but the configuration panel could not be refreshed. Reopen the panel to verify the latest state.',
                    '操作已生效，但配置面板刷新失败。请重新打开面板确认最新状态。'
                )
            );
        }
    }

    private async clearRuntimeCliApiKey(
        provider: string,
        reason: string,
        selection: ReturnType<typeof CliAuthFactory.getActiveCredentialSelection>
    ): Promise<'cleared' | 'stale' | 'failed'> {
        try {
            const deleted = await ApiKeyManager.deleteApiKeyForActiveCliCredential(provider, selection);
            return deleted ? 'cleared' : 'stale';
        } catch (error) {
            Logger.error(`[ConfigSet] Failed to clear stale API key ${reason}:`, error);
            return 'failed';
        }
    }

    private async snapshotActiveState(slot: string): Promise<ActiveStateSnapshot> {
        const siteProvider = getSiteOwnerProvider(slot);
        return {
            slot,
            activeId: ConfigSetStore.getActiveId(slot),
            currentKey: await ApiKeyManager.getApiKey(slot),
            currentSite: siteProvider ? readCurrentSite(siteProvider) : undefined,
            siteProvider
        };
    }

    private async restoreActiveState(snapshot: ActiveStateSnapshot, expectedOperationToken: string): Promise<boolean> {
        if (ConfigSetStore.getApplyOperationToken(snapshot.slot) !== expectedOperationToken) {
            return false;
        }
        const rollbackToken = randomUUID();
        await ConfigSetStore.setApplyOperationToken(snapshot.slot, rollbackToken);

        if (snapshot.siteProvider) {
            await applySiteSetting(snapshot.siteProvider, snapshot.currentSite);
        }

        if (snapshot.currentKey === undefined) {
            await ApiKeyManager.deleteApiKey(snapshot.slot, rollbackToken);
        } else {
            await ApiKeyManager.setApiKey(snapshot.slot, snapshot.currentKey, rollbackToken);
        }

        if (snapshot.activeId) {
            await ConfigSetStore.setActive(snapshot.slot, snapshot.activeId, rollbackToken);
        } else {
            await ConfigSetStore.clearActive(snapshot.slot, rollbackToken);
        }

        notifySlotProviderChanged(snapshot.slot);
        return true;
    }

    private async isActuallyActive(slot: string, id: string): Promise<boolean> {
        const currentKey = await ApiKeyManager.getApiKey(slot);
        if (!currentKey) {
            return false;
        }
        const item = ConfigSetStore.list(slot).find(entry => entry.id === id);
        if (!item || (await ConfigSetStore.getApiKey(slot, id)) !== currentKey) {
            return false;
        }
        const siteProvider = getSiteOwnerProvider(slot);
        if (!siteProvider) {
            return true;
        }
        const currentSite = readCurrentSite(siteProvider);
        return (item.site ?? currentSite) === currentSite;
    }

    async handleAdd(
        slot: string,
        label: string,
        note: string | undefined,
        site: string | undefined,
        apiKey: string,
        balanceWeight?: number
    ): Promise<void> {
        try {
            getBalanceWeight({ balanceWeight });
            const result = await enqueueConfigSetMutation(async () => {
                const siteProvider = getSiteOwnerProvider(slot);
                await ConfigSetStore.ensureMigrated(slot, siteProvider ? readCurrentSite(siteProvider) : undefined);
                const item: ConfigSetItem = { id: newId(), label, site, note, balanceWeight };
                await ConfigSetStore.add(slot, item, apiKey.trim());
                Logger.info(`[ConfigSet] ${slot}: configuration "${item.label}" added`);

                let autoApplyFailed = false;

                if (!(await ApiKeyManager.getApiKey(slot))) {
                    try {
                        autoApplyFailed = !(await applyConfigSetUnlocked(slot, item));
                    } catch (error) {
                        autoApplyFailed = true;
                        Logger.error(
                            `[ConfigSet] ${slot}: failed to auto-activate configuration "${item.label}":`,
                            error
                        );
                    }
                }

                return { item, autoApplyFailed };
            });

            await this.sendStatesAfterCommit('adding a configuration');
            this.ctx.post({
                command: 'addResult',
                ok: true,
                note:
                    result.autoApplyFailed ?
                        t(
                            'Added, but automatic activation failed. Please activate it manually.',
                            '已添加，但自动激活失败，请手动激活。'
                        )
                    :   t('Added', '已添加')
            });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to add configuration "${label}":`, error);
            this.ctx.post({
                command: 'addResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async handleApply(slot: string, id: string): Promise<void> {
        try {
            const item = ConfigSetStore.list(slot).find(i => i.id === id);
            if (!item) {
                this.ctx.post({
                    command: 'applyResult',
                    ok: false,
                    error: t('Configuration not found', '配置不存在')
                });
                return;
            }
            const ok = await applyConfigSet(slot, item);
            if (ok) {
                await this.sendStatesAfterCommit('applying a configuration');
                this.ctx.post({ command: 'applyResult', ok: true });
                return;
            }
            this.ctx.post({
                command: 'applyResult',
                ok: false,
                error: t(
                    'Configuration has no API key. Please remove and re-add it.',
                    '配置缺少 API Key，请删除后重新添加。'
                )
            });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to apply configuration ${id}:`, error);
            this.ctx.post({
                command: 'applyResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /**
     * 停用当前激活配置：清除 ApiKeyManager 中生效的 Key 与 ConfigSetStore.activeId，
     * 但 ConfigSetStore 中的配置项与 secrets 中的 Key 保留（可重新激活）。
     */
    async handleDeactivate(slot: string): Promise<void> {
        try {
            const activeId = ConfigSetStore.getActiveId(slot);
            const activeLabel = activeId ? ConfigSetStore.list(slot).find(i => i.id === activeId)?.label : undefined;
            await deactivateConfigSet(slot);
            Logger.info(`[ConfigSet] ${slot}: deactivated${activeLabel ? ` (was "${activeLabel}")` : ''}`);
            await this.sendStatesAfterCommit('deactivating a configuration');
            this.ctx.post({
                command: 'deactivateResult',
                ok: true,
                note: t('Deactivated. Saved configuration is kept.', '已停用。已保存的配置仍保留。')
            });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to deactivate configuration:`, error);
            this.ctx.post({
                command: 'deactivateResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async handleSetSwitchMode(slot: string, mode: 'off' | 'failover' | 'balance'): Promise<void> {
        if (!collectManagedSlots().some(entry => entry.slot === slot)) {
            this.ctx.post({
                command: 'switchModeResult',
                ok: false,
                error: t('Provider slot not found', '提供商槽位不存在')
            });
            return;
        }

        try {
            const updated = await enqueueConfigSetMutation(async () => {
                if (mode !== 'off' && !(await ApiKeyFailoverManager.canEnableAutoSwitch(slot, mode))) {
                    return false;
                }
                await ConfigSetStore.setSwitchMode(slot, mode);
                ApiKeyFailoverManager.handleBalanceModeChanged(slot);
                return true;
            });
            if (!updated) {
                this.ctx.post({
                    command: 'switchModeResult',
                    ok: false,
                    error:
                        mode === 'balance' ?
                            t(
                                'A saved API Key configuration is required, and the current key must match one of them.',
                                '需要已保存的 API Key 配置，且当前 Key 必须匹配其中一套。'
                            )
                        :   t(
                                'At least two saved API Key configurations are required, and the current key must match one of them.',
                                '至少需要两套已保存的 API Key 配置，且当前 Key 必须匹配其中一套。'
                            )
                });
                return;
            }
            Logger.info(`[ConfigSet] ${slot}: switch mode set to ${mode}`);
            await this.sendStatesAfterCommit('updating switch mode');
            this.ctx.post({ command: 'switchModeResult', ok: true, mode });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to update switch mode:`, error);
            this.ctx.post({
                command: 'switchModeResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    /** 收集各受管槽位的配置与当前激活状态（含面板外直接设置的 Key），供激活管理对话框 */
    async handleListActiveKeys(): Promise<void> {
        const snapshots: ActiveSlotSnapshot[] = [];
        for (const { slot, displayName } of collectManagedSlots()) {
            const items = ConfigSetStore.list(slot);
            const currentKey = await ApiKeyManager.getApiKey(slot);
            if (items.length === 0 && !currentKey) {
                continue;
            }
            const siteProvider = getSiteOwnerProvider(slot);
            const currentSite = siteProvider ? readCurrentSite(siteProvider) : undefined;
            // 生效配置匹配：Key 相同且（支持站点的槽位）站点与当前 endpoint 一致；
            // activeId 优先，其次首个匹配项；Key 或站点被面板外改动导致不匹配时视为面板外设置
            const matchesCurrent = async (item: ConfigSetItem): Promise<boolean> => {
                if (!currentKey || (await ConfigSetStore.getApiKey(slot, item.id)) !== currentKey) {
                    return false;
                }
                return !siteProvider || (item.site ?? currentSite) === currentSite;
            };
            let activeId: string | undefined;
            const marked = items.find(i => i.id === ConfigSetStore.getActiveId(slot));
            if (marked && (await matchesCurrent(marked))) {
                activeId = marked.id;
            } else {
                for (const item of items) {
                    if (await matchesCurrent(item)) {
                        activeId = item.id;
                        break;
                    }
                }
            }
            const itemSnapshots: ActiveConfigItemSnapshot[] = [];
            for (const item of items) {
                itemSnapshots.push({
                    id: item.id,
                    label: item.label,
                    siteLabel: siteProvider ? siteLabel(siteProvider, item.site ?? currentSite) : undefined,
                    hasKey: !!(await ConfigSetStore.getApiKey(slot, item.id))
                });
            }
            snapshots.push({
                slot,
                displayName,
                activeId,
                outsideActive: !!currentKey && !activeId,
                items: itemSnapshots
            });
        }
        this.ctx.post({ command: 'activeKeysPrep', snapshots });
    }

    /** 应用激活管理动作：activateId 有值 = 激活该配置，缺省 = 撤销该槽位激活（删 Key + 清激活标记） */
    async handleApplyActiveKeys(actions: ActiveKeyAction[]): Promise<void> {
        try {
            const changedSlots: string[] = [];
            const touchedSlots: string[] = [];
            const touchedSlotSet = new Set<string>();
            const snapshots = new Map<string, ActiveStateSnapshot>();
            const operationTokens = new Map<string, string>();
            const markTouched = (slot: string): void => {
                if (!touchedSlotSet.has(slot)) {
                    touchedSlotSet.add(slot);
                    touchedSlots.push(slot);
                }
            };
            await enqueueConfigSetMutation(async () => {
                try {
                    for (const action of actions) {
                        const hooks = {
                            onStarted: async (operationToken: string): Promise<void> => {
                                operationTokens.set(action.slot, operationToken);
                                if (!snapshots.has(action.slot)) {
                                    snapshots.set(action.slot, await this.snapshotActiveState(action.slot));
                                }
                            }
                        };

                        if (action.activateId) {
                            const item = ConfigSetStore.list(action.slot).find(i => i.id === action.activateId);
                            if (!item) {
                                continue;
                            }
                            markTouched(action.slot);
                            const applied = await applyConfigSetUnlocked(action.slot, item, undefined, hooks);
                            if (!applied) {
                                throw new Error(
                                    t(
                                        'Configuration has no API key. Please remove and re-add it.',
                                        '配置缺少 API Key，请删除后重新添加。'
                                    )
                                );
                            }
                            changedSlots.push(action.slot);
                            Logger.info(
                                `[ConfigSet] ${action.slot}: activated "${item.label}" via active keys management`
                            );
                            continue;
                        }

                        const hadKey = !!(await ApiKeyManager.getApiKey(action.slot));
                        const hadActive = !!ConfigSetStore.getActiveId(action.slot);
                        const shouldDeleteCurrentKey = hadKey && (hadActive || action.clearOutsideKey);
                        if (shouldDeleteCurrentKey || hadActive) {
                            markTouched(action.slot);
                            await deactivateConfigSetUnlocked(action.slot, shouldDeleteCurrentKey, hooks);
                            changedSlots.push(action.slot);
                            Logger.info(`[ConfigSet] ${action.slot}: deactivated via active keys management`);
                        }
                    }
                } catch (error) {
                    let rollbackFailed = false;
                    for (const slot of [...touchedSlots].reverse()) {
                        try {
                            const snapshot = snapshots.get(slot);
                            const operationToken = operationTokens.get(slot);
                            if (snapshot && operationToken) {
                                const restored = await this.restoreActiveState(snapshot, operationToken);
                                if (!restored) {
                                    Logger.info(
                                        `[ConfigSet] Skipped rollback for ${slot} because a newer update owns the slot`
                                    );
                                }
                            }
                        } catch (rollbackError) {
                            rollbackFailed = true;
                            Logger.error(
                                `[ConfigSet] Failed to roll back active key changes for ${slot}:`,
                                rollbackError
                            );
                        }
                    }
                    if (rollbackFailed) {
                        throw new Error(
                            t(
                                'Applying active key changes failed, and rollback was incomplete. Please review the current configurations before retrying.',
                                '应用生效配置变更失败，且回滚未完整完成。请检查当前配置后再重试。'
                            )
                        );
                    }
                    throw error;
                }
            });
            await this.sendStatesAfterCommit('applying active key changes');
            this.ctx.post({ command: 'activeKeysResult', ok: true, changedCount: changedSlots.length });
        } catch (error) {
            Logger.error('[ConfigSet] Failed to apply active key changes:', error);
            this.ctx.post({
                command: 'activeKeysResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async handleEdit(
        slot: string,
        id: string,
        label: string,
        note: string | undefined,
        apiKey: string | undefined,
        balanceWeight?: number
    ): Promise<void> {
        const item = ConfigSetStore.list(slot).find(i => i.id === id);
        if (!item) {
            this.ctx.post({ command: 'editResult', ok: false, error: t('Configuration not found', '配置不存在') });
            return;
        }

        try {
            getBalanceWeight({ balanceWeight });
            const wasActive = await enqueueConfigSetMutation(async () => {
                const currentItem = ConfigSetStore.list(slot).find(i => i.id === id);
                if (!currentItem) {
                    throw new Error(t('Configuration not found', '配置不存在'));
                }
                const operationToken = randomUUID();
                await ConfigSetStore.setApplyOperationToken(slot, operationToken);

                const active = await this.isActuallyActive(slot, id);
                const shouldApplyKey = active && apiKey !== undefined;
                const previousSavedKey = shouldApplyKey ? await ConfigSetStore.getApiKey(slot, id) : undefined;
                const previousRuntimeKey = shouldApplyKey ? await ApiKeyManager.getApiKey(slot) : undefined;

                await ConfigSetStore.updateMeta(
                    slot,
                    id,
                    { label, note, ...(balanceWeight === undefined ? {} : { balanceWeight }) },
                    apiKey,
                    operationToken
                );

                if (shouldApplyKey) {
                    try {
                        await ApiKeyManager.setApiKey(slot, apiKey, operationToken);
                    } catch (error) {
                        let rollbackFailed = false;
                        try {
                            await ConfigSetStore.updateMeta(
                                slot,
                                id,
                                {
                                    label: currentItem.label,
                                    note: currentItem.note ?? '',
                                    balanceWeight: currentItem.balanceWeight
                                },
                                previousSavedKey ?? null,
                                operationToken
                            );
                        } catch (rollbackError) {
                            rollbackFailed = true;
                            Logger.error(
                                '[ConfigSet] Failed to roll back saved configuration after edit:',
                                rollbackError
                            );
                        }

                        try {
                            const currentRuntimeKey = await ApiKeyManager.getApiKey(slot);
                            if (currentRuntimeKey !== previousRuntimeKey) {
                                if (previousRuntimeKey === undefined) {
                                    await ApiKeyManager.deleteApiKey(slot, operationToken);
                                } else {
                                    await ApiKeyManager.setApiKey(slot, previousRuntimeKey, operationToken);
                                }
                            }
                        } catch (rollbackError) {
                            rollbackFailed = true;
                            Logger.error('[ConfigSet] Failed to roll back active API key after edit:', rollbackError);
                        }

                        if (rollbackFailed) {
                            try {
                                await ConfigSetStore.clearActive(slot, operationToken);
                            } catch (clearError) {
                                Logger.error('[ConfigSet] Failed to clear stale active marker after edit:', clearError);
                            }
                        }

                        if (rollbackFailed) {
                            throw new Error(
                                t(
                                    'Failed to apply the updated API key, and rollback was incomplete. Check the saved configuration before retrying.',
                                    '应用更新后的 API Key 失败，且回滚未完整完成。请检查已保存配置后重试。'
                                )
                            );
                        }
                        throw error;
                    }
                    notifySlotProviderChanged(slot);
                }

                return active;
            });

            await this.sendStatesAfterCommit('editing a configuration');
            this.ctx.post({
                command: 'editResult',
                ok: true,
                note:
                    wasActive && apiKey ?
                        t('Configuration updated and applied immediately.', '配置已更新，并已立即应用。')
                    :   t('Configuration updated.', '配置已更新。')
            });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to edit configuration "${item.label}":`, error);
            this.ctx.post({
                command: 'editResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async handleRemove(slot: string, id: string): Promise<void> {
        try {
            const removed = await enqueueConfigSetMutation(async () => {
                const items = ConfigSetStore.list(slot);
                const item = items.find(i => i.id === id);
                if (!item) {
                    return undefined;
                }
                const operationToken = randomUUID();
                await ConfigSetStore.setApplyOperationToken(slot, operationToken);
                const previousActiveId = ConfigSetStore.getActiveId(slot);
                const marked = items.find(entry => entry.id === previousActiveId);
                const candidates = marked ? [marked, ...items.filter(entry => entry !== marked)] : items;
                let isActive = false;
                for (const candidate of candidates) {
                    if (await this.isActuallyActive(slot, candidate.id)) {
                        isActive = candidate.id === id;
                        break;
                    }
                }
                const previousKey = isActive ? await ApiKeyManager.getApiKey(slot) : undefined;
                try {
                    if (isActive) {
                        await ApiKeyManager.deleteApiKey(slot, operationToken);
                        await ConfigSetStore.clearActive(slot, operationToken);
                    }
                    await ConfigSetStore.remove(slot, id, operationToken);
                } catch (error) {
                    if (
                        isActive &&
                        previousKey !== undefined &&
                        ConfigSetStore.getApplyOperationToken(slot) === operationToken
                    ) {
                        try {
                            await ApiKeyManager.setApiKey(slot, previousKey, operationToken);
                            if (previousActiveId) {
                                await ConfigSetStore.setActive(slot, previousActiveId, operationToken);
                            } else {
                                await ConfigSetStore.clearActive(slot, operationToken);
                            }
                        } catch (rollbackError) {
                            Logger.error('[ConfigSet] Failed to restore active API key after removal:', rollbackError);
                        }
                    }
                    throw error;
                }
                if (isActive) {
                    notifySlotProviderChanged(slot);
                }
                return { item, isActive };
            });
            if (!removed) {
                this.ctx.post({
                    command: 'removeResult',
                    ok: false,
                    error: t('Configuration not found', '配置不存在')
                });
                return;
            }
            const { item, isActive } = removed;
            const autoSwitchDisabled = await ApiKeyFailoverManager.disableIfUnavailable(slot);
            Logger.info(`[ConfigSet] ${slot}: configuration "${item.label}" removed`);
            await this.sendStatesAfterCommit('removing a configuration');
            this.ctx.post({
                command: 'removeResult',
                ok: true,
                note:
                    isActive ? t('Removed. The active API key was cleared.', '已删除，当前生效的 API Key 已清除。')
                    : autoSwitchDisabled ?
                        t(
                            'Removed. Automatic failover was disabled because fewer than two usable configurations remain.',
                            '已删除。由于剩余可用配置不足两套，自动故障切换已关闭。'
                        )
                    :   t('Removed', '已删除')
            });
        } catch (error) {
            Logger.error(`[ConfigSet] ${slot}: failed to remove configuration ${id}:`, error);
            this.ctx.post({
                command: 'removeResult',
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }

    async handleSetupCli(provider: string): Promise<void> {
        const cli = CliAuthFactory.getSupportedCliTypes().find(c => c.id === provider);
        if (!cli) {
            this.ctx.post({ command: 'syncStatus', busy: false });
            return;
        }

        // 先尝试加载已有凭证（首次认证可能已有 CLI 登录但未导入）
        const selection = CliAuthFactory.getActiveCredentialSelection(provider);
        let credentials = await CliAuthFactory.loadCredentials(provider);
        if (!credentials || CliAuthFactory.isCredentialExpired(provider, credentials)) {
            // 凭证缺失或已过期，触发刷新流程（含跨实例协调）
            credentials = await CliAuthFactory.ensureAuthenticated(provider, true);
        }

        if (credentials?.access_token) {
            const keyApplied = await ApiKeyManager.setApiKeyForActiveCliCredential(
                provider,
                selection,
                credentials.access_token
            );
            if (!keyApplied) {
                vscode.window.showInformationMessage(
                    t(
                        'The active account changed in another window. The stale API key update was skipped.',
                        '活跃账号已在另一窗口切换，已跳过过期的 API Key 更新。'
                    )
                );
            } else {
                vscode.window.showInformationMessage(t('{0} authenticated successfully.', '{0} 认证成功。', cli.name));
            }
        } else {
            vscode.window.showErrorMessage(
                t(
                    '{0} authentication failed. Run the CLI sign-in flow first.',
                    '{0} 认证失败，请先运行 CLI 登录。',
                    cli.name
                )
            );
        }

        await this.ctx.refreshCliProviders();
        // WebView 收到更新后的账号列表后，会为当前显示的 CLI provider 刷新余量。
        this.ctx.post({ command: 'syncStatus', busy: false });
    }

    async handleImportCliCredential(provider: string): Promise<void> {
        if (!CliAuthFactory.getSupportedCliTypes().some(cli => cli.id === provider)) {
            return;
        }
        try {
            await vscode.commands.executeCommand('gcmp.cli.importCredential', provider);
        } catch (error) {
            Logger.error(`[ConfigSet] Failed to import ${provider} CLI credential:`, error);
            vscode.window.showErrorMessage(
                t('Failed to start the CLI credential import flow.', '无法启动 CLI 凭证导入流程。')
            );
        } finally {
            await this.ctx.refreshCliProviders();
            this.ctx.post({ command: 'syncStatus', busy: false });
        }
    }

    async handleOpenOAuthFolder(): Promise<void> {
        const oauthDir = CliAuthFactory.getOAuthCredentialDir();
        if (!oauthDir) {
            vscode.window.showErrorMessage(t('OAuth credential storage is not available.', 'OAuth 凭证目录不可用。'));
            return;
        }
        try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(oauthDir));
        } catch (error) {
            Logger.error('[ConfigSet] Failed to open oauth credential folder:', error);
            vscode.window.showErrorMessage(t('Failed to open the oauth folder.', '无法打开 oauth 文件夹。'));
        }
    }

    async handleSetCliOAuthSwitchMode(provider: string, mode: 'off' | 'failover' | 'balance'): Promise<void> {
        if (!CliAuthFactory.getSupportedCliTypes().some(cli => cli.id === provider)) {
            return;
        }
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const routingSettings = OAuthCredentialStore.getRoutingSettings(provider);
            const eligibleCount = OAuthCredentialStore.listCredentials(provider).filter(
                entry =>
                    entry.hasAccessToken &&
                    (Object.hasOwn(routingSettings.weights, entry.name) ?
                        (routingSettings.weights[entry.name] ?? 1)
                    :   1) > 0
            ).length;
            if ((mode === 'failover' && eligibleCount < 2) || (mode === 'balance' && eligibleCount < 1)) {
                throw new Error(
                    mode === 'failover' ?
                        t(
                            'Failover requires at least two OAuth accounts with access tokens and positive weights.',
                            '故障转移至少需要两个含 access_token 且权重大于 0 的 OAuth 账号。'
                        )
                    :   t(
                            'Load balancing requires at least one OAuth account with an access token and positive weight.',
                            '负载均衡至少需要一个含 access_token 且权重大于 0 的 OAuth 账号。'
                        )
                );
            }
            await OAuthCredentialStore.setRoutingMode(provider, mode);
            BalanceAffinityCache.instance.clear(provider);
        } catch (error) {
            Logger.error(`[ConfigSet] Failed to set ${provider} OAuth routing mode:`, error);
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
            try {
                await this.ctx.refreshCliProviders();
            } catch (error) {
                Logger.warn(`[ConfigSet] Failed to refresh ${provider} OAuth routing state:`, error);
            }
            this.ctx.post({ command: 'syncStatus', busy: false });
        }
    }

    async handleSetCliOAuthWeight(provider: string, credentialName: string, weight: number): Promise<void> {
        if (!CliAuthFactory.getSupportedCliTypes().some(cli => cli.id === provider)) {
            return;
        }
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const settings = OAuthCredentialStore.getRoutingSettings(provider);
            const mode = settings.mode;
            const eligibleCount = OAuthCredentialStore.listCredentials(provider).filter(entry => {
                const currentWeight =
                    entry.name === credentialName ? weight
                    : Object.hasOwn(settings.weights, entry.name) ? (settings.weights[entry.name] ?? 1)
                    : 1;
                return entry.hasAccessToken && currentWeight > 0;
            }).length;
            if ((mode === 'failover' && eligibleCount < 2) || (mode === 'balance' && eligibleCount < 1)) {
                throw new Error(
                    t(
                        'This weight would leave the selected routing mode without enough eligible OAuth accounts.',
                        '此权重会导致当前路由模式没有足够的可用 OAuth 账号。'
                    )
                );
            }
            await OAuthCredentialStore.setCredentialWeight(provider, credentialName, weight);
            BalanceAffinityCache.instance.clear(provider);
        } catch (error) {
            Logger.error(`[ConfigSet] Failed to set ${provider}/${credentialName} OAuth weight:`, error);
            vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        } finally {
            try {
                await this.ctx.refreshCliProviders();
            } catch (error) {
                Logger.warn(`[ConfigSet] Failed to refresh ${provider} OAuth account state:`, error);
            }
            this.ctx.post({ command: 'syncStatus', busy: false });
        }
    }

    async handleActivateCliCredential(provider: string, credentialName: string): Promise<void> {
        let activeSelectionChanged = false;
        let runtimeKeyClearFailed = false;
        let activationSelection: ReturnType<typeof CliAuthFactory.getActiveCredentialSelection> | undefined;
        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const credential = CliAuthFactory.listOAuthCredentials(provider).find(
                entry => entry.name === credentialName && entry.hasAccessToken
            );
            if (!credential) {
                throw new Error(
                    t('The selected credential is missing an access token.', '所选凭证缺少 access_token。')
                );
            }

            activationSelection = await CliAuthFactory.setActiveCredential(provider, credentialName);
            activeSelectionChanged = true;
            const credentials = await CliAuthFactory.ensureAuthenticated(provider);
            if (!credentials?.access_token) {
                throw new Error(t('The selected credential could not be authenticated.', '所选凭证无法完成认证。'));
            }
            const keyApplied = await ApiKeyManager.setApiKeyForActiveCliCredential(
                provider,
                activationSelection,
                credentials.access_token
            );
            if (!keyApplied) {
                vscode.window.showInformationMessage(
                    t(
                        'The active account changed in another window. The stale API key update was skipped.',
                        '活跃账号已在另一窗口切换，已跳过过期的 API Key 更新。'
                    )
                );
                return;
            }
            vscode.window.showInformationMessage(
                t('Now using OAuth account "{0}".', '当前已切换为 OAuth 账号「{0}」。', credentialName)
            );
        } catch (error) {
            if (activeSelectionChanged) {
                runtimeKeyClearFailed =
                    (await this.clearRuntimeCliApiKey(
                        provider,
                        `after activating ${provider}`,
                        activationSelection!
                    )) === 'failed';
            }
            Logger.error(`[ConfigSet] Failed to activate ${provider} OAuth credential ${credentialName}:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
                runtimeKeyClearFailed ?
                    t(
                        '{0} The previous runtime API key could not be confirmed as cleared and may still be used.',
                        '{0} 无法确认此前的运行时 API Key 已清除，请求仍可能使用该 Key。',
                        errorMessage
                    )
                :   errorMessage
            );
        } finally {
            await this.ctx.refreshCliProviders();
            this.ctx.post({ command: 'syncStatus', busy: false });
        }
    }

    async handleDeleteCliCredential(provider: string, credentialName: string): Promise<void> {
        let wasActive = false;
        let credentialDeleteCompleted = false;
        let partialDeleteDetected = false;
        let activeCredentialDeleted = false;
        let runtimeKeyClearStatus: 'cleared' | 'stale' | 'failed' = 'stale';
        let synchronizationSelection: ReturnType<typeof CliAuthFactory.getActiveCredentialSelection> | undefined;
        const credential = CliAuthFactory.listOAuthCredentials(provider).find(entry => entry.name === credentialName);
        if (!credential) {
            vscode.window.showErrorMessage(t('OAuth credential not found.', '未找到 OAuth 凭证。'));
            return;
        }
        const confirmLabel = t('Delete account', '删除账号');
        const confirmed = await vscode.window.showWarningMessage(
            t(
                'Delete OAuth account "{0}"? This removes its credential file and cannot be undone.',
                '确认删除 OAuth 账号「{0}」？这会移除凭证文件且无法撤销。',
                credential.label || credentialName
            ),
            { modal: true },
            confirmLabel
        );
        if (confirmed !== confirmLabel) {
            return;
        }

        this.ctx.post({ command: 'syncStatus', busy: true });
        try {
            const deletion = await OAuthCredentialStore.deleteCredentialFileWithStatus(provider, credentialName);
            if (!deletion.deleted) {
                throw new Error(t('OAuth credential not found.', '未找到 OAuth 凭证。'));
            }
            wasActive = deletion.wasActive;
            credentialDeleteCompleted = true;

            if (wasActive) {
                activeCredentialDeleted = true;
                synchronizationSelection = CliAuthFactory.getActiveCredentialSelection(provider);
                const nextCredentials = await CliAuthFactory.ensureAuthenticated(provider);
                let keyApplied: boolean;
                if (nextCredentials?.access_token) {
                    keyApplied = await ApiKeyManager.setApiKeyForActiveCliCredential(
                        provider,
                        synchronizationSelection,
                        nextCredentials.access_token
                    );
                } else {
                    keyApplied = await ApiKeyManager.deleteApiKeyForActiveCliCredential(
                        provider,
                        synchronizationSelection
                    );
                }
                if (!keyApplied) {
                    vscode.window.showInformationMessage(
                        t(
                            'OAuth account deleted. The active account changed in another window, so its API key was left untouched.',
                            'OAuth 账号已删除。活跃账号已在另一窗口切换，因此未改动其 API Key。'
                        )
                    );
                    return;
                }
            }
            vscode.window.showInformationMessage(t('OAuth account deleted.', 'OAuth 账号已删除。'));
        } catch (error) {
            const deletionError = error as Error & { credentialDeleted?: boolean; wasActive?: boolean };
            if (deletionError.credentialDeleted) {
                wasActive = deletionError.wasActive === true;
                activeCredentialDeleted = wasActive;
                partialDeleteDetected = wasActive && !credentialDeleteCompleted;
            }
            if (activeCredentialDeleted) {
                synchronizationSelection ??= CliAuthFactory.getActiveCredentialSelection(provider);
                runtimeKeyClearStatus = await this.clearRuntimeCliApiKey(
                    provider,
                    `after deleting ${provider} OAuth account`,
                    synchronizationSelection
                );
            }
            Logger.error(`[ConfigSet] Failed to delete ${provider} OAuth credential ${credentialName}:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const keyRecoveryMessage =
                runtimeKeyClearStatus === 'failed' ?
                    t(
                        'The previous runtime API key could not be confirmed as cleared and may still be used.',
                        '无法确认此前的运行时 API Key 已清除，请求仍可能使用该 Key。'
                    )
                : runtimeKeyClearStatus === 'stale' ?
                    t(
                        'The active account changed in another window, so its runtime API key was left untouched.',
                        '活跃账号已在另一窗口切换，因此未改动其运行时 API Key。'
                    )
                :   t('The previous runtime API key was cleared.', '此前的运行时 API Key 已清除。');
            vscode.window.showErrorMessage(
                partialDeleteDetected ?
                    t(
                        '{0} The credential file was removed, but the delete operation did not fully complete. {1}',
                        '{0} 凭证文件已删除，但删除操作未完整完成。{1}',
                        errorMessage,
                        keyRecoveryMessage
                    )
                : activeCredentialDeleted ?
                    t(
                        '{0} The account was deleted, but follow-up authentication or API key synchronization failed. {1}',
                        '{0} 账号已删除，但后续认证或 API Key 同步失败。{1}',
                        errorMessage,
                        keyRecoveryMessage
                    )
                :   errorMessage
            );
        } finally {
            await this.ctx.refreshCliProviders();
            this.ctx.post({ command: 'syncStatus', busy: false });
        }
    }

    async handleOpenCliTerminal(provider: string): Promise<void> {
        const instance = CliAuthFactory.getInstance(provider);
        if (!instance) {
            return;
        }
        const cliCommand = instance.getCliCommand();
        // 与 CLI 向导一致：携带进程环境变量启动 CLI 交互界面，由用户在 CLI 内完成 OAuth 登录
        const terminal = vscode.window.createTerminal({
            name: cliCommand,
            env: CliAuthFactory.getProcessEnv(provider)
        });
        terminal.show();
        terminal.sendText(cliCommand);
    }

    /**
     * 处理移除 CLI 凭证：在文件管理器中定位凭证文件，由用户手动删除
     * （GCMP 不直接删除 CLI 官方凭证文件，避免与 CLI 并发读写冲突）
     */
    async handleRemoveCliCredential(provider: string): Promise<void> {
        const credentialPath = CliAuthFactory.getCredentialPath(provider);
        if (!credentialPath) {
            vscode.window.showErrorMessage(
                t('Failed to resolve the credential file path for {0}.', '无法获取 {0} 的凭证文件路径。', provider)
            );
            return;
        }
        try {
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(credentialPath));
        } catch {
            vscode.window.showErrorMessage(
                t('Failed to open the credential file location.', '无法打开凭证文件所在位置。')
            );
        }
    }
}
