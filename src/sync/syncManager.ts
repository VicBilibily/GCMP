/**
 * 同步管理器
 * 编排基于 GitHub Gist 的 API Key 跨设备同步流程
 * 通过 VS Code 内置 GitHub 认证实现登录，提供上传/下载/查看状态等操作
 */

import * as vscode from 'vscode';
import { GistSyncService, getKeyDisplayName } from './gistSyncService';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';
import { ApiKeyManager } from '../utils/apiKeyManager';

/**
 * 同步管理器
 */
export class SyncManager {
    private static context: vscode.ExtensionContext;

    /**
     * 初始化同步管理器
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
        GistSyncService.initialize(context);
    }

    /**
     * 统一入口：配置 GitHub 同步
     * - 未登录 → 先登录 → 成功后进入同步操作菜单
     * - 已登录 → 直接进入同步操作菜单（上传/下载/管理云端）
     */
    static async configure(): Promise<void> {
        await this.showSyncActions();
    }

    /**
     * 展示同步操作菜单（上传/下载/管理云端）
     * 进入菜单前自动尝试关联已有 Gist
     */
    private static async showSyncActions(): Promise<void> {
        // 尝试自动关联已有 Gist（如果尚未关联）
        const existingGistId = GistSyncService.getGistId();
        if (!existingGistId) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t('Checking for existing Gist...', '正在检查已有 Gist...'),
                    cancellable: false
                },
                async () => {
                    const userInfo = await GistSyncService.getUserInfo(true);
                    if (userInfo) {
                        const gistId = await GistSyncService.findExistingSyncGist(userInfo.token);
                        if (gistId) {
                            await GistSyncService.saveGistId(gistId);
                        }
                    }
                }
            );
        }

        const status = await GistSyncService.getStatus();

        // 同步操作菜单项类型：QuickPickItem + 可选 action
        interface SyncActionItem extends vscode.QuickPickItem {
            action?: () => Promise<void>;
        }

        const items: SyncActionItem[] = [];

        // 第一组：同步操作
        items.push(
            { label: t('Sync Operations', '同步操作'), kind: vscode.QuickPickItemKind.Separator },
            {
                label: `$(cloud-upload) ${t('Upload to Gist', '上传到 Gist')}`,
                description: t(
                    'Encrypt and upload local API keys to GitHub Gist',
                    '加密并将本地 API Key 上传到 GitHub Gist'
                ),
                action: () => this.uploadToGist()
            },
            {
                label: `$(cloud-download) ${t('Download from Gist', '从 Gist 下载')}`,
                description: t(
                    'Download and restore API keys from GitHub Gist to local',
                    '从 GitHub Gist 下载并恢复到本地'
                ),
                action: () => this.downloadFromGist()
            }
        );

        // 第二组：密钥管理
        items.push(
            { label: t('Key Management', '密钥管理'), kind: vscode.QuickPickItemKind.Separator },
            {
                label: `$(symbol-key) ${t('Manage Local Keys', '管理本地密钥')}`,
                description: t('View and remove API keys stored on this device', '查看和删除本机存储的 API Key'),
                action: () => this.manageLocalKeys()
            }
        );

        if (status.isLoggedIn) {
            items.push({
                label: `$(list-tree) ${t('Manage Remote Keys', '管理云端密钥')}`,
                description: t('View and remove API keys stored on GitHub Gist', '查看和删除 GitHub Gist 中的 API Key'),
                action: () => this.manageRemoteKeys()
            });
        }

        // 第三组：安全设置
        items.push(
            { label: t('Security', '安全设置'), kind: vscode.QuickPickItemKind.Separator },
            {
                label: `$(key) ${status.hasCustomPassphrase ? t('Change Passphrase', '更改口令') : t('Set Passphrase', '设置口令')}`,
                description:
                    status.hasCustomPassphrase ?
                        t('Change the custom encryption passphrase', '更改自定义加密口令')
                    :   t('Add a custom passphrase to strengthen key encryption', '添加自定义口令增强密钥加密保护'),
                action: () => this.setEncryptionPassphrase()
            }
        );

        if (status.hasCustomPassphrase) {
            items.push({
                label: `$(trash) ${t('Clear Passphrase', '清除口令')}`,
                description: t(
                    'Remove the custom passphrase — existing encrypted Gist data will become undecryptable',
                    '移除自定义口令，现有加密数据将无法解密'
                ),
                action: () => this.clearEncryptionPassphrase()
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: t('API Key Sync (@{0})', 'API Key 同步（@{0}）', status.githubUser || '')
        });

        if (picked?.action) {
            await picked.action();
        }
    }

    /**
     * 获取带 gist scope 的 token — 先尝试静默获取，失败则弹授权
     */
    private static async ensureGistToken(): Promise<{ login: string; id: number; token: string } | undefined> {
        let userInfo = await GistSyncService.getUserInfo(true);
        if (userInfo) {
            Logger.trace('[SyncManager] Using cached gist scope session');
            return userInfo;
        }
        Logger.info('[SyncManager] No silent session, requesting gist scope authorization');
        userInfo = await GistSyncService.getUserInfo(false);
        return userInfo;
    }

    /**
     * 弹出 QuickPick 让用户选择要同步的提供商（默认全选）
     * 按一致性状态分组显示，使用 Separator 分隔
     * @param availableKeys keyName -> 明文的映射
     * @param direction "upload" 或 "download"（仅用于标题）
     * @param keyStatus 可选，每个 key 的状态（'new' / 'update' / 'unchanged'）
     * @returns 用户选中的 keyName 集合，用户取消返回 undefined
     */
    private static async selectProviders(
        availableKeys: Record<string, string>,
        direction: string,
        keyStatus?: Record<string, 'new' | 'update' | 'unchanged'>
    ): Promise<Set<string> | undefined> {
        type QuickPickItem = vscode.QuickPickItem & { keyName?: string };

        let items: QuickPickItem[];

        if (keyStatus) {
            // 分组：new / update / unchanged
            const groupNew: QuickPickItem[] = [];
            const groupUpdate: QuickPickItem[] = [];
            const groupUnchanged: QuickPickItem[] = [];

            for (const key of Object.keys(availableKeys)) {
                const status = keyStatus[key];
                const item: QuickPickItem = {
                    label: getKeyDisplayName(key),
                    description: key,
                    keyName: key,
                    picked: status !== 'unchanged'
                };
                if (status === 'new') {
                    groupNew.push(item);
                } else if (status === 'update') {
                    groupUpdate.push(item);
                } else {
                    groupUnchanged.push(item);
                }
            }

            items = [];
            if (groupNew.length > 0) {
                items.push({
                    label: t('New keys ({0})', '待新增（{0}）', String(groupNew.length)),
                    kind: vscode.QuickPickItemKind.Separator
                });
                items.push(...groupNew);
            }
            if (groupUpdate.length > 0) {
                items.push({
                    label: t('Update available ({0})', '待更新（{0}）', String(groupUpdate.length)),
                    kind: vscode.QuickPickItemKind.Separator
                });
                items.push(...groupUpdate);
            }
            if (groupUnchanged.length > 0) {
                items.push({
                    label: t('Already in sync ({0})', '无需变更（{0}）', String(groupUnchanged.length)),
                    kind: vscode.QuickPickItemKind.Separator
                });
                items.push(...groupUnchanged);
            }
        } else {
            // 无状态信息时使用平面列表
            items = Object.keys(availableKeys).map(key => ({
                label: getKeyDisplayName(key),
                description: key,
                keyName: key,
                picked: true
            }));
        }

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title:
                direction === 'upload' ?
                    t('Select API Keys to upload to GitHub Gist', '选择要上传到 GitHub Gist 的 API Key')
                :   t('Select API Keys to download from GitHub Gist', '选择要从 GitHub Gist 下载的 API Key'),
            placeHolder:
                direction === 'upload' ?
                    t(
                        'Check to upload, uncheck to skip (new/update checked by default)',
                        '勾选即上传到 Gist，取消勾选则跳过（新增/更新默认勾选）'
                    )
                :   t(
                        'Check to download, uncheck to skip (unchanged unchecked by default)',
                        '勾选即下载到本地，取消勾选则跳过（一致的默认不勾选）'
                    ),
            ignoreFocusOut: true
        });

        if (!picked) {
            return undefined;
        }

        return new Set(
            picked
                .filter(item => item.keyName) // 过滤掉 Separator
                .map(item => item.keyName!)
        );
    }

    /**
     * 上传本地 API Key 到 GitHub Gist
     */
    static async uploadToGist(): Promise<void> {
        // 第一步：认证 + 收集密钥 + 远端比对（网络 + 本地读写）
        interface UploadPrep {
            userInfo: { login: string; id: number; token: string };
            allKeys: Record<string, string>;
            keyStatus?: Record<string, 'new' | 'update' | 'unchanged'>;
        }

        const prep = await vscode.window.withProgress<UploadPrep | undefined>(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Loading API keys and comparing with Gist...', '正在加载 API Key 并与 Gist 比对...'),
                cancellable: false
            },
            async () => {
                const uInfo = await this.ensureGistToken();
                if (!uInfo) {
                    return undefined;
                }
                const keys = await GistSyncService.collectLocalKeys();
                if (Object.keys(keys).length === 0) {
                    return undefined;
                }

                // 预先读取远端 Gist，计算一致性差异用于 QuickPick 显示
                let keyStatus: Record<string, 'new' | 'update' | 'unchanged'> | undefined;
                const existingGistId = GistSyncService.getGistId();
                if (existingGistId) {
                    const remoteSyncData = await GistSyncService.readSyncData(uInfo.token, existingGistId);
                    if (remoteSyncData) {
                        // 对于 common 的 key，尝试解密远端值做值比较
                        const remoteValues: Record<string, string> = {};
                        for (const [keyName, encryptedValue] of Object.entries(remoteSyncData.keys)) {
                            if (encryptedValue && keys[keyName] !== undefined) {
                                try {
                                    const decrypted = await GistSyncService.decrypt(encryptedValue);
                                    if (decrypted !== undefined) {
                                        remoteValues[keyName] = decrypted;
                                    }
                                } catch {
                                    // 解密失败（口令不匹配等），无法比较值，跳过
                                }
                            }
                        }

                        keyStatus = {};
                        for (const key of Object.keys(keys)) {
                            if (remoteValues[key] !== undefined && keys[key] !== remoteValues[key]) {
                                keyStatus[key] = 'update';
                            } else if (remoteValues[key] !== undefined && keys[key] === remoteValues[key]) {
                                keyStatus[key] = 'unchanged';
                            } else if (remoteSyncData.keys[key] !== undefined && remoteValues[key] === undefined) {
                                keyStatus[key] = 'update';
                            } else if (remoteSyncData.keys[key] === undefined) {
                                keyStatus[key] = 'new';
                            }
                        }
                    }
                }

                return { userInfo: uInfo, allKeys: keys, keyStatus };
            }
        );

        if (!prep) {
            const status = await GistSyncService.getStatus();
            if (!status.isLoggedIn) {
                vscode.window.showErrorMessage(
                    t(
                        'Session expired. Please run "Configure GitHub Sync" again.',
                        '会话已过期，请重新执行"配置 GitHub 同步"。'
                    )
                );
            } else {
                vscode.window.showInformationMessage(t('No API keys found to upload.', '没有找到需要上传的 API Key。'));
            }
            return;
        }

        const { userInfo, allKeys, keyStatus } = prep;

        // 让用户选择要上传的提供商（直接附带一致性状态标识）
        const selectedKeys = await this.selectProviders(allKeys, 'upload', keyStatus);
        if (!selectedKeys || selectedKeys.size === 0) {
            return; // 用户取消或无选择
        }

        // 过滤出用户选择的密钥
        const keysToUpload: Record<string, string> = {};
        for (const key of selectedKeys) {
            if (allKeys[key]) {
                keysToUpload[key] = allKeys[key];
            }
        }

        Logger.debug(
            `[SyncManager] Found ${Object.keys(allKeys).length} local key(s), user selected ${selectedKeys.size}`
        );

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Uploading to GitHub Gist...', '正在上传到 GitHub Gist...'),
                cancellable: false
            },
            async () => {
                try {
                    Logger.debug(`[SyncManager] Encrypting ${Object.keys(keysToUpload).length} key(s)...`);
                    // 加密选择的密钥
                    const encryptedKeys: Record<string, string> = {};
                    for (const [keyName, plainValue] of Object.entries(keysToUpload)) {
                        const encrypted = await GistSyncService.encrypt(plainValue);
                        if (encrypted) {
                            encryptedKeys[keyName] = encrypted;
                        } else {
                            Logger.warn(`[SyncManager] Encryption failed for key: ${keyName}, skipping`);
                        }
                    }

                    const uploadGistId = await GistSyncService.uploadKeys(userInfo.token, encryptedKeys);
                    if (!uploadGistId) {
                        vscode.window.showErrorMessage(
                            t(
                                'Failed to create or update the sync Gist. Check the logs for details.',
                                '创建或更新同步 Gist 失败。请查看日志了解详情。'
                            )
                        );
                        return;
                    }

                    const uploadedCount = Object.keys(encryptedKeys).length;
                    vscode.window.showInformationMessage(
                        t(
                            'Successfully uploaded {0} API keys (total {1} on Gist). Download on your other devices to apply.',
                            '成功上传 {0} 个 API Key（Gist 共计 {1} 个）。请在其它设备上执行下载以同步。',
                            String(uploadedCount),
                            String(Object.keys(keysToUpload).length) // 近似展示
                        )
                    );
                    Logger.info(`[SyncManager] Upload complete: ${uploadedCount} keys to gist ${uploadGistId}`);
                } catch (error) {
                    Logger.error('[SyncManager] Upload failed:', error);
                    vscode.window.showErrorMessage(
                        t(
                            'Upload failed: {0}',
                            '上传失败：{0}',
                            error instanceof Error ? error.message : 'Unknown error'
                        )
                    );
                }
            }
        );
    }

    /**
     * 从 GitHub Gist 下载 API Key 并应用到本地
     */
    static async downloadFromGist(): Promise<void> {
        interface DownloadData {
            userInfo: { login: string; id: number; token: string };
            remoteKeys: Record<string, string>;
            downloadKeyStatus: Record<string, 'new' | 'update' | 'unchanged'>;
        }

        const data = await vscode.window.withProgress<DownloadData | undefined>(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Downloading API keys from GitHub Gist...', '正在从 GitHub Gist 下载 API Key...'),
                cancellable: false
            },
            async () => {
                const userInfo = await this.ensureGistToken();
                if (!userInfo) {
                    return undefined;
                }

                let gistId = GistSyncService.getGistId();
                if (!gistId) {
                    gistId = await GistSyncService.findExistingSyncGist(userInfo.token);
                    if (!gistId) {
                        return undefined;
                    }
                    await GistSyncService.saveGistId(gistId);
                }

                const syncData = await GistSyncService.readSyncData(userInfo.token, gistId);
                if (!syncData) {
                    return undefined;
                }

                const encryptedKeys: [string, string][] = Object.entries(syncData.keys).filter(
                    (entry): entry is [string, string] => !!entry[1] && entry[1].trim().length > 0
                );

                if (encryptedKeys.length === 0) {
                    return undefined;
                }

                // 在当前进度内完成解密 + 本地比对
                Logger.debug(`[SyncManager] Decrypting ${encryptedKeys.length} remote key(s)...`);
                const remoteKeys: Record<string, string> = {};

                for (const [keyName, encryptedValue] of encryptedKeys) {
                    const plainValue = await GistSyncService.decrypt(encryptedValue);
                    if (plainValue !== undefined) {
                        remoteKeys[keyName] = plainValue;
                    }
                }

                // 收集本地密钥做值比较
                const localKeys = await GistSyncService.collectLocalKeys();
                const diff = GistSyncService.computeDiff(remoteKeys, localKeys);

                const downloadKeyStatus: Record<string, 'new' | 'update' | 'unchanged'> = {};
                for (const k of diff.localOnly) {
                    downloadKeyStatus[k] = 'new';
                }
                for (const k of diff.common) {
                    downloadKeyStatus[k] = remoteKeys[k] === localKeys[k] ? 'unchanged' : 'update';
                }

                return { userInfo, remoteKeys, downloadKeyStatus };
            }
        );

        if (!data) {
            const status = await GistSyncService.getStatus();
            if (!status.isLoggedIn) {
                vscode.window.showErrorMessage(
                    t(
                        'Session expired. Please run "Configure GitHub Sync" again.',
                        '会话已过期，请重新执行"配置 GitHub 同步"。'
                    )
                );
            } else {
                vscode.window.showWarningMessage(
                    t('No sync data found on GitHub Gist.', 'GitHub Gist 上未找到同步数据。')
                );
            }
            return;
        }

        const { userInfo } = data;
        let { remoteKeys, downloadKeyStatus } = data;

        // 如果一条都没解密成功，可能是口令问题（交互弹框需要留在进度条外）
        if (Object.keys(remoteKeys).length === 0) {
            const hasPassphrase = await GistSyncService.hasCustomPassphrase();
            const tryPassphrase = await vscode.window.showWarningMessage(
                hasPassphrase ?
                    t(
                        'Unable to decrypt data with current passphrase. The passphrase may have been changed. Try entering the previous passphrase?',
                        '无法用当前口令解密数据。口令可能已更改。是否尝试输入之前使用的口令？'
                    )
                :   t(
                        'Unable to decrypt data. The data may have been encrypted with a custom passphrase on another device. Enter the passphrase to decrypt?',
                        '无法解密数据。数据可能已在其他设备上用自定义口令加密。是否输入口令进行解密？'
                    ),
                { modal: true },
                t('Enter passphrase', '输入口令'),
                t('Cancel', '取消')
            );

            if (tryPassphrase === t('Enter passphrase', '输入口令')) {
                Logger.debug('[SyncManager] User attempting to decrypt with custom passphrase');
                const passphrase = await vscode.window.showInputBox({
                    prompt: t('Enter the encryption passphrase used when uploading', '请输入上传时使用的加密口令'),
                    password: true,
                    ignoreFocusOut: true
                });

                if (passphrase && passphrase.trim().length > 0) {
                    const gistId = GistSyncService.getGistId();
                    if (gistId) {
                        const decrypted = await GistSyncService.decryptRemoteKeysWithPassphrase(
                            userInfo.token,
                            gistId,
                            passphrase.trim()
                        );

                        if (decrypted && Object.keys(decrypted).length > 0) {
                            if (!(await GistSyncService.verifyPassphrase(passphrase.trim()))) {
                                Logger.info('[SyncManager] Storing user-provided passphrase for future decryption');
                                await GistSyncService.setCustomPassphrase(passphrase.trim());
                            }

                            remoteKeys = decrypted;
                            // 重新计算本地比对
                            const localKeys = await GistSyncService.collectLocalKeys();
                            const diff = GistSyncService.computeDiff(remoteKeys, localKeys);
                            downloadKeyStatus = {};
                            for (const k of diff.localOnly) {
                                downloadKeyStatus[k] = 'new';
                            }
                            for (const k of diff.common) {
                                downloadKeyStatus[k] = remoteKeys[k] === localKeys[k] ? 'unchanged' : 'update';
                            }
                        }
                    }
                }
            }
        }

        if (Object.keys(remoteKeys).length === 0) {
            vscode.window.showWarningMessage(
                t(
                    'Failed to decrypt any API keys. Please verify your encryption passphrase and try again.',
                    '无法解密任何 API Key。请检查加密口令后重试。'
                )
            );
            return;
        }

        // 第三步：用户选择要下载的提供商（附带一致性状态标识）
        const selectedKeys = await this.selectProviders(remoteKeys, 'download', downloadKeyStatus);
        if (!selectedKeys || selectedKeys.size === 0) {
            return; // 用户取消或无选择
        }

        // 过滤出用户选择的密钥
        const keysToApply: Record<string, string> = {};
        for (const key of selectedKeys) {
            if (remoteKeys[key]) {
                keysToApply[key] = remoteKeys[key];
            }
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Saving API keys locally...', '正在保存 API Key 到本地...'),
                cancellable: false
            },
            async () => {
                try {
                    const appliedKeyCount = await GistSyncService.applyKeysAndNotify(keysToApply);

                    if (appliedKeyCount === 0) {
                        vscode.window.showInformationMessage(
                            t('No new API keys to apply.', '没有需要应用的 API Key。')
                        );
                        return;
                    }

                    const message = t(
                        'Successfully applied {0} API keys from GitHub Gist.',
                        '成功从 GitHub Gist 恢复了 {0} 个 API Key。',
                        String(appliedKeyCount)
                    );

                    vscode.window.showInformationMessage(message);
                    Logger.info(`[SyncManager] Download complete: ${appliedKeyCount} keys applied`);
                } catch (error) {
                    Logger.error('[SyncManager] Download failed:', error);
                    vscode.window.showErrorMessage(
                        t(
                            'Download failed: {0}',
                            '下载失败：{0}',
                            error instanceof Error ? error.message : 'Unknown error'
                        )
                    );
                }
            }
        );
    }

    /**
     * 管理本地 API Key
     * 列出所有本地已配置的 API Key，允许取消勾选以删除
     */
    static async manageLocalKeys(): Promise<void> {
        const allKeys = await GistSyncService.collectLocalKeys();
        if (Object.keys(allKeys).length === 0) {
            vscode.window.showInformationMessage(t('No local API keys found.', '没有找到本地 API Key。'));
            return;
        }

        const items: (vscode.QuickPickItem & { keyName?: string })[] = Object.keys(allKeys).map(key => ({
            label: getKeyDisplayName(key),
            description: key,
            keyName: key,
            picked: true
        }));

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: t('Local API Keys ({0} total)', '本地 API Key（共 {0} 个）', String(Object.keys(allKeys).length)),
            placeHolder: t(
                'Uncheck keys to delete them locally, checked keys will be kept',
                '取消勾选将从本地删除，勾选的保留'
            ),
            ignoreFocusOut: true
        });

        if (!picked) {
            return;
        }

        const keysToRetain = new Set(picked.map(item => item.description));
        const toDelete = Object.keys(allKeys).filter(k => !keysToRetain.has(k));

        if (toDelete.length === 0) {
            vscode.window.showInformationMessage(
                t('No changes made to local API keys.', '未对本地 API Key 做任何更改。')
            );
            return;
        }

        Logger.debug(`[SyncManager] User selected ${keysToRetain.size} key(s) to retain, ${toDelete.length} to delete`);

        const confirm = await vscode.window.showWarningMessage(
            t(
                'Are you sure you want to delete {0} local API key(s)? This cannot be undone.',
                '确定要删除 {0} 个本地 API Key 吗？此操作不可撤销。',
                String(toDelete.length)
            ),
            { modal: true },
            t('Delete', '删除')
        );

        if (!confirm) {
            Logger.trace('[SyncManager] Local keys delete cancelled by user');
            return;
        }

        let deletedCount = 0;
        for (const keyName of toDelete) {
            // keyName 格式如 "deepseek.apiKey" → provider = "deepseek"
            const provider = keyName.replace('.apiKey', '');
            await ApiKeyManager.deleteApiKey(provider);
            deletedCount++;
            Logger.debug(`[SyncManager] Deleted local key: ${keyName}`);
        }

        // 通知被删除密钥对应的提供商刷新模型列表
        GistSyncService.notifyProvidersKeysDeleted(toDelete);

        vscode.window.showInformationMessage(
            t('Deleted {0} local API key(s).', '已删除 {0} 个本地 API Key。', String(deletedCount))
        );
    }

    /**
     * 管理远程密钥
     */
    static async manageRemoteKeys(): Promise<void> {
        // 读取阶段：认证 + 查找 + 读取（网络）
        interface RemotePrep {
            userInfo: { login: string; id: number; token: string };
            gistId: string;
            keyNames: string[];
        }

        const prep = await vscode.window.withProgress<RemotePrep | undefined>(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Loading API keys from GitHub Gist...', '正在从 GitHub Gist 加载 API Key...'),
                cancellable: false
            },
            async () => {
                const userInfo = await this.ensureGistToken();
                if (!userInfo) {
                    return undefined;
                }

                let gistId = GistSyncService.getGistId();
                if (!gistId) {
                    gistId = await GistSyncService.findExistingSyncGist(userInfo.token);
                    if (!gistId) {
                        return undefined;
                    }
                    await GistSyncService.saveGistId(gistId);
                }

                const syncData = await GistSyncService.readSyncData(userInfo.token, gistId);
                if (!syncData || Object.keys(syncData.keys).length === 0) {
                    return undefined;
                }

                return { userInfo, gistId, keyNames: Object.keys(syncData.keys) };
            }
        );

        if (!prep) {
            const status = await GistSyncService.getStatus();
            if (!status.isLoggedIn) {
                vscode.window.showErrorMessage(
                    t(
                        'Session expired. Please run "Configure GitHub Sync" again.',
                        '会话已过期，请重新执行"配置 GitHub 同步"。'
                    )
                );
            } else {
                vscode.window.showInformationMessage(
                    t('No API keys stored on GitHub.', 'GitHub 上没有存储的 API Key。')
                );
            }
            return;
        }

        const { userInfo, gistId, keyNames: remoteKeys } = prep;

        const items = remoteKeys.map(key => ({
            label: getKeyDisplayName(key),
            description: key,
            picked: true
        }));

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title: t('Manage remote API keys ({0} total)', '管理远程 API Key（共 {0} 个）', String(remoteKeys.length)),
            placeHolder: t(
                'Uncheck keys to delete them from Gist, checked keys will be kept',
                '取消勾选将从 Gist 中删除，勾选的保留'
            ),
            ignoreFocusOut: true
        });

        if (!picked) {
            return;
        }

        const keysToRetain = new Set(picked.map(item => item.description));
        const toDelete = remoteKeys.filter(k => !keysToRetain.has(k));

        if (toDelete.length === 0) {
            vscode.window.showInformationMessage(t('No changes made to remote keys.', '未对远程密钥做任何更改。'));
            return;
        }

        Logger.debug(`[SyncManager] User selected ${keysToRetain.size} key(s) to retain, ${toDelete.length} to delete`);

        const confirm = await vscode.window.showWarningMessage(
            t(
                'Are you sure you want to delete {0} key(s) from the Gist?',
                '确定要从 Gist 中删除 {0} 个密钥吗？',
                String(toDelete.length)
            ),
            { modal: true },
            t('Delete', '删除')
        );

        if (!confirm) {
            Logger.trace('[SyncManager] Delete cancelled by user');
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Deleting from GitHub Gist...', '正在从 GitHub Gist 删除...'),
                cancellable: false
            },
            async () => {
                Logger.info(`[SyncManager] Deleting ${toDelete.length} key(s) from gist ${gistId}`);
                const success = await GistSyncService.deleteRemoteKeys(userInfo.token, gistId, keysToRetain);
                if (success) {
                    Logger.info(
                        `[SyncManager] Delete successful: removed ${toDelete.length} key(s) from gist ${gistId}`
                    );
                    vscode.window.showInformationMessage(
                        t(
                            'Deleted {0} key(s) from GitHub Gist.',
                            '已从 GitHub Gist 删除 {0} 个密钥。',
                            String(toDelete.length)
                        )
                    );
                } else {
                    vscode.window.showErrorMessage(t('Failed to update GitHub Gist.', '更新 GitHub Gist 失败。'));
                }
            }
        );
    }

    /**
     * 设置/更改自定义加密口令
     * 口令用于增强 AES-256-GCM 密钥的派生强度，与 GitHub 用户 ID + pepper 共同派生
     * 注意：开源项目的加密方式源码可见，自定义口令可提供额外保护
     */
    private static async setEncryptionPassphrase(): Promise<void> {
        const currentHash = await GistSyncService.hasCustomPassphrase();
        const status = await GistSyncService.getStatus();

        // 跨设备提示：无论设置还是更改，都需告知需多设备同步时口令必须一致
        const crossDeviceInfo =
            currentHash ?
                t(
                    "Note: If you sync across multiple devices, all devices must use the same passphrase to decrypt each other's data. After changing, please update the passphrase on all devices.",
                    '注意：如需多设备同步，所有设备必须使用相同的口令才能互相解密。更改后请在所有设备上同步更新口令。'
                )
            :   t(
                    "Note: If you sync across multiple devices, all devices must use the same passphrase to decrypt each other's data. Remember this passphrase and set it on all devices.",
                    '注意：如需多设备同步，所有设备必须使用相同的口令才能互相解密。请牢记此口令并在所有设备上设置。'
                );

        vscode.window.showInformationMessage(crossDeviceInfo);

        const passphrase = await vscode.window.showInputBox({
            prompt:
                currentHash ?
                    t('Enter a new encryption passphrase', '请输入新的加密口令')
                :   t('Set an encryption passphrase to protect your API keys', '设置加密口令以保护您的 API Key'),
            password: true,
            placeHolder: t('Enter a strong passphrase (at least 8 characters)', '请输入强口令（至少 8 个字符）'),
            validateInput: value => {
                if (value && value.trim().length < 8) {
                    return t('Passphrase must be at least 8 characters', '口令至少需要 8 个字符');
                }
                return null;
            },
            ignoreFocusOut: true
        });

        if (!passphrase || passphrase.trim().length < 8) {
            return; // 用户取消或太短
        }

        const confirm = await vscode.window.showInputBox({
            prompt: t('Confirm the passphrase', '请再次输入口令确认'),
            password: true,
            ignoreFocusOut: true
        });

        if (!confirm || confirm !== passphrase) {
            vscode.window.showWarningMessage(t('Passphrases do not match.', '两次输入的口令不一致。'));
            return;
        }

        // 如果有旧口令且已有 Gist 数据，提示数据不可解密 + 建议重传
        let shouldReupload = false;
        if (currentHash && status.hasGist) {
            const proceed = await vscode.window.showWarningMessage(
                t(
                    'Changing the passphrase will make existing encrypted data on GitHub Gist undecryptable. After changing, you will need to re-upload your API keys. Continue?',
                    '更改口令将导致已存储在 GitHub Gist 中的加密数据无法解密。更改后需要重新上传 API Key。是否继续？'
                ),
                { modal: true },
                t('Change & Re-upload', '更改并重新上传'),
                t('Change Only', '仅更改')
            );
            if (!proceed) {
                return;
            }
            shouldReupload = proceed === t('Change & Re-upload', '更改并重新上传');
        } else if (!currentHash && status.hasGist) {
            const proceed = await vscode.window.showWarningMessage(
                t(
                    'After setting a passphrase, existing data on GitHub Gist will become undecryptable because it was encrypted without a passphrase. You will need to re-upload your API keys. Continue?',
                    '设置口令后，已存储的数据将无法解密（之前未使用口令加密）。需要重新上传 API Key。是否继续？'
                ),
                { modal: true },
                t('Set & Re-upload', '设置并重新上传'),
                t('Set Only', '仅设置')
            );
            if (!proceed) {
                return;
            }
            shouldReupload = proceed === t('Set & Re-upload', '设置并重新上传');
        }

        const success = await GistSyncService.setCustomPassphrase(passphrase.trim());
        if (!success) {
            vscode.window.showErrorMessage(t('Failed to set encryption passphrase.', '设置加密口令失败。'));
            return;
        }

        vscode.window.showInformationMessage(t('Encryption passphrase set successfully.', '加密口令设置成功。'));

        // 提示跨设备同步
        if (!currentHash) {
            vscode.window.showInformationMessage(
                t(
                    'Remember to set the same passphrase on your other devices before downloading.',
                    '请在其他设备上下载前先设置相同的口令。'
                )
            );
        }

        // 如果用户选择重传，直接进入上传流程
        if (shouldReupload) {
            await this.uploadToGist();
        }
    }

    /**
     * 清除自定义加密口令
     */
    private static async clearEncryptionPassphrase(): Promise<void> {
        const proceed = await vscode.window.showWarningMessage(
            t(
                'Clearing the passphrase will make existing encrypted data on GitHub Gist undecryptable? Continue?',
                '清除口令将导致已存储在 GitHub Gist 中的加密数据无法解密。是否继续？'
            ),
            { modal: true },
            t('Clear', '清除')
        );

        if (!proceed) {
            return;
        }

        await GistSyncService.clearCustomPassphrase();
        vscode.window.showInformationMessage(t('Encryption passphrase cleared.', '加密口令已清除。'));
    }
}
