/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 配置集 CRUD 与 CLI 操作
 *  从 index.ts 抽出：add / apply / edit / remove / setupCli / openCliTerminal。
 *  通过 PanelContext 调用 sendStates / refreshCliProviders / refreshCliUsage。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ApiKeyManager } from '../../utils/config/apiKeyManager';
import { ConfigSetItem, ConfigSetStore } from '../../utils/config/configSetStore';
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
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
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

    private async restoreActiveState(snapshot: ActiveStateSnapshot): Promise<void> {
        if (snapshot.siteProvider) {
            await applySiteSetting(snapshot.siteProvider, snapshot.currentSite);
        }

        if (snapshot.currentKey === undefined) {
            await ApiKeyManager.deleteApiKey(snapshot.slot);
        } else {
            await ApiKeyManager.setApiKey(snapshot.slot, snapshot.currentKey);
        }

        if (snapshot.activeId) {
            await ConfigSetStore.setActive(snapshot.slot, snapshot.activeId);
        } else {
            await ConfigSetStore.clearActive(snapshot.slot);
        }

        notifySlotProviderChanged(snapshot.slot);
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
        apiKey: string
    ): Promise<void> {
        try {
            const result = await enqueueConfigSetMutation(async () => {
                const siteProvider = getSiteOwnerProvider(slot);
                await ConfigSetStore.ensureMigrated(slot, siteProvider ? readCurrentSite(siteProvider) : undefined);
                const item: ConfigSetItem = { id: newId(), label, site, note };
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
            const snapshots = new Map<string, ActiveStateSnapshot>();
            await enqueueConfigSetMutation(async () => {
                try {
                    for (const action of actions) {
                        if (!snapshots.has(action.slot)) {
                            snapshots.set(action.slot, await this.snapshotActiveState(action.slot));
                        }

                        if (action.activateId) {
                            const item = ConfigSetStore.list(action.slot).find(i => i.id === action.activateId);
                            if (!item) {
                                continue;
                            }
                            const applied = await applyConfigSetUnlocked(action.slot, item);
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
                            await deactivateConfigSetUnlocked(action.slot, shouldDeleteCurrentKey);
                            changedSlots.push(action.slot);
                            Logger.info(`[ConfigSet] ${action.slot}: deactivated via active keys management`);
                        }
                    }
                } catch (error) {
                    let rollbackFailed = false;
                    for (const slot of [...changedSlots].reverse()) {
                        try {
                            const snapshot = snapshots.get(slot);
                            if (snapshot) {
                                await this.restoreActiveState(snapshot);
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
        apiKey: string | undefined
    ): Promise<void> {
        const item = ConfigSetStore.list(slot).find(i => i.id === id);
        if (!item) {
            this.ctx.post({ command: 'editResult', ok: false, error: t('Configuration not found', '配置不存在') });
            return;
        }

        try {
            const wasActive = await enqueueConfigSetMutation(async () => {
                const currentItem = ConfigSetStore.list(slot).find(i => i.id === id);
                if (!currentItem) {
                    throw new Error(t('Configuration not found', '配置不存在'));
                }

                const active = await this.isActuallyActive(slot, id);
                const shouldApplyKey = active && apiKey !== undefined;
                const previousSavedKey = shouldApplyKey ? await ConfigSetStore.getApiKey(slot, id) : undefined;
                const previousRuntimeKey = shouldApplyKey ? await ApiKeyManager.getApiKey(slot) : undefined;

                await ConfigSetStore.updateMeta(slot, id, { label, note }, apiKey);

                if (shouldApplyKey) {
                    try {
                        await ApiKeyManager.setApiKey(slot, apiKey);
                    } catch (error) {
                        let rollbackFailed = false;
                        try {
                            await ConfigSetStore.updateMeta(
                                slot,
                                id,
                                { label: currentItem.label, note: currentItem.note ?? '' },
                                previousSavedKey ?? null
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
                                    await ApiKeyManager.deleteApiKey(slot);
                                } else {
                                    await ApiKeyManager.setApiKey(slot, previousRuntimeKey);
                                }
                            }
                        } catch (rollbackError) {
                            rollbackFailed = true;
                            Logger.error('[ConfigSet] Failed to roll back active API key after edit:', rollbackError);
                        }

                        if (rollbackFailed) {
                            try {
                                await ConfigSetStore.clearActive(slot);
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
            const isActive = await this.isActuallyActive(slot, id);
            const item = await enqueueConfigSetMutation(async () => {
                const item = ConfigSetStore.list(slot).find(i => i.id === id);
                if (!item) {
                    return undefined;
                }
                await ConfigSetStore.remove(slot, id);
                return item;
            });
            if (!item) {
                this.ctx.post({
                    command: 'removeResult',
                    ok: false,
                    error: t('Configuration not found', '配置不存在')
                });
                return;
            }
            Logger.info(`[ConfigSet] ${slot}: configuration "${item.label}" removed`);
            await this.sendStatesAfterCommit('removing a configuration');
            this.ctx.post({
                command: 'removeResult',
                ok: true,
                note:
                    isActive ?
                        t(
                            'Removed. The current key stays in effect until the next switch.',
                            '已删除，当前 Key 将继续生效直至下次切换。'
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
        let credentials = await CliAuthFactory.loadCredentials(provider);
        if (!credentials || CliAuthFactory.isCredentialExpired(provider, credentials)) {
            // 凭证缺失或已过期，触发刷新流程（含跨实例协调）
            credentials = await CliAuthFactory.ensureAuthenticated(provider, true);
        }

        if (credentials?.access_token) {
            await ApiKeyManager.setApiKey(provider, credentials.access_token);
            vscode.window.showInformationMessage(t('{0} authenticated successfully.', '{0} 认证成功。', cli.name));
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
        // 认证是用户主动发起的强动作：成功后顺带刷新该 CLI 的余量（如 codex 限频窗口），
        // 避免用户停留在详情区时余量仍是旧值，需手动点刷新或切出切入。
        void this.ctx.refreshCliUsage(provider);
        this.ctx.post({ command: 'syncStatus', busy: false });
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
