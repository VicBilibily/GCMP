/*---------------------------------------------------------------------------------------------
 *  Config Set Manager WebView 后端宿主
 *  负责面板生命周期与消息路由；具体业务委托给 StateHost / UsageHost / CrudHost / SyncHost。
 *  用量/余额的查询与格式化逻辑在 ../../quota/providerQuota。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
import { migrateLegacyGistToConfigSets, promptLegacyGistMigrationOnFirstOpen } from '../../sync/legacyGistMigration';
import { buildCliProviderPlaceholders } from './cliHost';
import { buildWebviewHtml } from './webviewHtml';
import { ConfigSetSyncHost } from './syncHost';
import { StateHost } from './stateHost';
import { UsageHost } from './usageHost';
import { CrudHost } from './crudHost';
import type { HostMessage, WebViewMessage, PanelContext } from './types';
import { sanitizeWebViewMessage } from './types';

export class ConfigSetManagerPanel implements PanelContext {
    private static currentPanel: ConfigSetManagerPanel | undefined;
    private panel: vscode.WebviewPanel | undefined;

    private stateHost!: StateHost;
    private usageHost!: UsageHost;
    private crudHost!: CrudHost;
    private syncHost!: ConfigSetSyncHost;

    /** 面板级订阅：随面板 dispose 清理，不挂 context.subscriptions 累积 */
    private panelDisposables: vscode.Disposable[] = [];

    private constructor(private context: vscode.ExtensionContext) {}

    static createAndShow(context: vscode.ExtensionContext): void {
        if (ConfigSetManagerPanel.currentPanel) {
            ConfigSetManagerPanel.currentPanel.panel?.reveal(vscode.ViewColumn.Beside);
            return;
        }
        const instance = new ConfigSetManagerPanel(context);
        instance.show();
    }

    private show(): void {
        this.disposePanelResources();

        this.stateHost = new StateHost(this);
        this.usageHost = new UsageHost(this);
        this.crudHost = new CrudHost(this);
        this.syncHost = new ConfigSetSyncHost({
            post: msg => this.post(msg),
            sendStates: () => this.sendStates()
        });

        this.panel = vscode.window.createWebviewPanel(
            'gcmpConfigSetManager',
            t('Manage API Keys', 'API Key 管理'),
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            this.panelDisposables
        );

        this.panel.webview.html = this.getWebviewContent(this.panel.webview);

        // 面板重新可见时刷新 CLI 认证状态（如用户刚在文件管理器中删除凭证文件）
        this.panel.onDidChangeViewState(
            () => {
                if (this.panel?.visible) {
                    void this.refreshCliProviders();
                    return;
                }

                this.syncHost.discardPreparedRestore();
                this.post({ command: 'clearRestorePrep' });
            },
            undefined,
            this.panelDisposables
        );

        this.panel.onDidDispose(
            () => {
                this.disposePanelResources();
                for (const d of this.panelDisposables) {
                    d.dispose();
                }
                this.panelDisposables = [];
                ConfigSetManagerPanel.currentPanel = undefined;
                this.panel = undefined;
            },
            undefined,
            this.panelDisposables
        );

        ConfigSetManagerPanel.currentPanel = this;
    }

    // ============= PanelContext 实现（委托给各 Host） =============

    post(msg: HostMessage): void {
        this.panel?.webview.postMessage(msg);
    }

    async sendStates(): Promise<void> {
        return this.stateHost.sendStates();
    }

    async refreshCliProviders(): Promise<void> {
        return this.stateHost.refreshCliProviders();
    }

    async refreshCliUsage(provider: string): Promise<void> {
        return this.usageHost.refreshCliUsage(provider);
    }

    isAlive(): boolean {
        return this.panel !== undefined;
    }

    // ============= 生命周期 =============

    private disposePanelResources(): void {
        this.syncHost?.dispose();
        this.stateHost?.dispose();
        this.usageHost?.dispose();
    }

    private getWebviewContent(webview: vscode.Webview): string {
        return buildWebviewHtml(webview, this.context.extensionPath);
    }

    // ============= 消息路由 =============

    private async handleMessage(rawMessage: WebViewMessage): Promise<void> {
        const message = sanitizeWebViewMessage(rawMessage);
        if (!message) {
            Logger.warn('[ConfigSetManager] Ignored malformed webview message');
            return;
        }
        try {
            switch (message.command) {
                case 'ready':
                    await this.sendInit();
                    return;
                case 'add':
                    await this.crudHost.handleAdd(
                        message.slot,
                        message.label,
                        message.note,
                        message.site,
                        message.apiKey
                    );
                    return;
                case 'loadProviderUsage':
                    await this.usageHost.handleLoadProviderUsage(
                        message.provider,
                        this.stateHost.isCustomCompatibleProvider(message.provider)
                    );
                    return;
                case 'refreshConfigUsage':
                    await this.usageHost.handleRefreshConfigUsage(message.slot, message.id);
                    return;
                case 'apply':
                    await this.crudHost.handleApply(message.slot, message.id);
                    return;
                case 'deactivate':
                    await this.crudHost.handleDeactivate(message.slot);
                    return;
                case 'manageActiveKeys':
                    await this.crudHost.handleListActiveKeys();
                    return;
                case 'applyActiveKeys':
                    await this.crudHost.handleApplyActiveKeys(message.actions);
                    return;
                case 'edit':
                    await this.crudHost.handleEdit(
                        message.slot,
                        message.id,
                        message.label,
                        message.note,
                        message.apiKey
                    );
                    return;
                case 'remove':
                    await this.crudHost.handleRemove(message.slot, message.id);
                    return;
                case 'setupCli':
                    await this.crudHost.handleSetupCli(message.provider);
                    return;
                case 'openCliTerminal':
                    await this.crudHost.handleOpenCliTerminal(message.provider);
                    return;
                case 'removeCliCredential':
                    await this.crudHost.handleRemoveCliCredential(message.provider);
                    return;
                case 'refreshCliUsage':
                    await this.usageHost.refreshCliUsage(message.provider);
                    return;
                case 'upload':
                    await this.syncHost.handleUpload();
                    return;
                case 'uploadSelected':
                    await this.syncHost.handleUploadSelected(message.selections);
                    return;
                case 'download':
                    await this.syncHost.handleDownload();
                    return;
                case 'downloadWithPassphrase':
                    await this.syncHost.handleDownloadWithPassphrase(message.passphrase);
                    return;
                case 'discardRestorePrep':
                    this.syncHost.discardPreparedRestore();
                    return;
                case 'restore':
                    await this.syncHost.handleRestore(message.selections);
                    return;
                case 'manageRemoteConfigs':
                    await this.syncHost.handleListRemoteConfigs();
                    return;
                case 'applyRemoteConfigs':
                    await this.syncHost.handleApplyRemoteConfigs(message.remove);
                    return;
                case 'setPassphrase':
                    await this.syncHost.handleSetPassphrase();
                    return;
                case 'clearPassphrase':
                    await this.syncHost.handleClearPassphrase();
                    return;
                case 'openLegacySync':
                    // 旧版 QuickPick 同步界面，保留一个主版本供用户迁移（0.28 移除）
                    await vscode.commands.executeCommand('gcmp.sync.configure');
                    return;
                case 'migrateLegacyGist': {
                    this.post({ command: 'syncStatus', busy: true });
                    try {
                        const migrated = await migrateLegacyGistToConfigSets(this.context);
                        if (migrated !== undefined) {
                            await this.sendStates();
                            // 迁移可能把验证通过的旧口令写入存储，口令状态需同步刷新
                            await this.syncHost.postSyncState();
                            if (migrated > 0) {
                                vscode.window.showInformationMessage(
                                    t('Migrated {0} legacy key(s).', '已迁移 {0} 个旧版 API Key。', String(migrated))
                                );
                            } else {
                                vscode.window.showInformationMessage(
                                    t('No legacy keys were migrated.', '没有可迁移的旧版 API Key。')
                                );
                            }
                        }
                    } finally {
                        this.post({ command: 'syncStatus', busy: false });
                    }
                    return;
                }
            }
        } catch (error) {
            Logger.error('[ConfigSetManager] handleMessage error:', error);
            this.post({ command: 'syncStatus', busy: false });
        }
    }

    private async sendInit(): Promise<void> {
        const providers = this.stateHost.buildProviderOptions();
        const states = await this.stateHost.buildStates();
        const cliProviders = buildCliProviderPlaceholders();
        const syncState = await this.syncHost.buildSyncState();
        this.post({ command: 'init', locale: vscode.env.language, providers, states, cliProviders, syncState });
        void this.refreshCliProviders();
        void this.maybePromptLegacyGistMigration();
    }

    private async maybePromptLegacyGistMigration(): Promise<void> {
        const migrated = await promptLegacyGistMigrationOnFirstOpen(this.context);
        if (migrated !== undefined) {
            await this.sendStates();
            await this.syncHost.postSyncState();
        }
    }
}
