/**
 * 同步管理器
 * 编排基于 GitHub Gist 的 API Key 跨设备同步流程
 * 通过 VS Code 内置 GitHub 认证实现登录，提供上传/下载/查看状态等操作
 */

import * as vscode from 'vscode';
import { GistSyncService, getKeyDisplayName, SyncData } from './gistSyncService';
import { Logger } from '../utils/logger';
import { t } from '../utils/l10n';

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
        const status = await GistSyncService.getStatus();

        // 未登录则先登录
        if (!status.isLoggedIn) {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: t('Signing in with GitHub...', '正在通过 GitHub 登录...'),
                    cancellable: false
                },
                async () => {
                    const userInfo = await GistSyncService.authenticateAndGetUserInfo();
                    if (!userInfo) {
                        vscode.window.showErrorMessage(
                            t(
                                'GitHub authentication failed. Please ensure you have a GitHub account and try again.',
                                'GitHub 认证失败。请确保拥有 GitHub 账号后重试。'
                            )
                        );
                        return;
                    }
                    const existingGistId = await GistSyncService.findExistingSyncGist(userInfo.token);
                    if (existingGistId) {
                        await GistSyncService.saveGistId(existingGistId);
                    }
                }
            );

            // 如果登录失败（用户取消），不继续弹菜单
            const afterLogin = await GistSyncService.getStatus();
            if (!afterLogin.isLoggedIn) {
                return;
            }
        }

        // 已登录 → 展示同步操作菜单
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
                    const userInfo = await GistSyncService.getSessionUserInfo();
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

        const items: (vscode.QuickPickItem & { action: () => Promise<void> })[] = [
            {
                label: `$(cloud-upload) ${t('Upload API Keys', '上传 API Key')}`,
                description: t(
                    'Upload API keys to GitHub Gist, keeping them encrypted',
                    '将 API Key 加密上传到 GitHub Gist'
                ),
                action: () => this.uploadToGist()
            },
            {
                label: `$(cloud-download) ${t('Download API Keys', '下载 API Key')}`,
                description: t('Download and restore API keys from GitHub Gist', '从 GitHub Gist 下载并恢复 API Key'),
                action: () => this.downloadFromGist()
            }
        ];

        if (status.isLoggedIn) {
            items.push({
                label: `$(list-tree) ${t('Manage API Keys on GitHub', '管理 GitHub Gist 中的 API Key')}`,
                description: t(
                    'View and delete API keys stored on GitHub Gist',
                    '查看和删除已存储在 GitHub Gist 的 API Key'
                ),
                action: () => this.manageRemoteKeys()
            });
        }

        items.push({
            label: `$(key) ${status.hasCustomPassphrase ? t('Change Encryption Passphrase', '更改加密口令') : t('Set Encryption Passphrase', '设置加密口令')}`,
            description:
                status.hasCustomPassphrase ?
                    t('Encryption passphrase is set (visible in source code)', '已设置加密口令（源码可见加密方式）')
                :   t('Add a custom passphrase to strengthen key encryption', '添加自定义口令增强密钥加密保护'),
            action: () => this.setEncryptionPassphrase()
        });

        if (status.hasCustomPassphrase) {
            items.push({
                label: `$(trash) ${t('Clear Encryption Passphrase', '清除加密口令')}`,
                description: t(
                    'Remove the custom passphrase, existing encrypted data will become undecryptable',
                    '移除自定义口令，现有加密数据将无法解密'
                ),
                action: () => this.clearEncryptionPassphrase()
            });
        }

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: t('API Key Sync (@{0})', 'API Key 同步（@{0}）', status.githubUser || '')
        });

        if (picked) {
            await picked.action();
        }
    }

    /**
     * 获取带 gist scope 的 token — 先尝试静默获取，失败则弹授权
     */
    private static async ensureGistToken(): Promise<{ login: string; id: number; token: string } | undefined> {
        // 先试静默获取（已授权的 session）
        let userInfo = await GistSyncService.getSessionUserInfo();
        if (userInfo) {
            Logger.trace('[SyncManager] Using cached gist scope session');
            return userInfo;
        }
        // 静默没有 → 弹授权框获取 gist scope
        Logger.info('[SyncManager] No silent session, requesting gist scope authorization');
        userInfo = await GistSyncService.authenticateAndGetUserInfo();
        return userInfo;
    }

    /**
     * 弹出 QuickPick 让用户选择要同步的提供商（默认全选）
     * @param availableKeys keyName -> 明文的映射
     * @param direction "upload" 或 "download"（仅用于显示标题）
     * @returns 用户选中的 keyName 集合，用户取消返回 undefined
     */
    private static async selectProviders(
        availableKeys: Record<string, string>,
        direction: string
    ): Promise<Set<string> | undefined> {
        const items = Object.keys(availableKeys).map(key => ({
            label: getKeyDisplayName(key),
            description: key,
            picked: true // 默认全选
        }));

        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            title:
                direction === 'upload' ?
                    t('Select providers to upload', '选择要上传的提供商')
                :   t('Select providers to download', '选择要下载的提供商'),
            placeHolder: t('Select all providers you want to sync (default all)', '选择要同步的提供商（默认全部）'),
            ignoreFocusOut: true
        });

        if (!picked) {
            return undefined; // 用户取消
        }

        return new Set(picked.map(item => item.description));
    }

    /**
     * 上传本地 API Key 到 GitHub Gist
     */
    static async uploadToGist(): Promise<void> {
        // 第一步：认证 + 收集密钥（网络 + 本地读取）
        interface UploadPrep {
            userInfo: { login: string; id: number; token: string };
            allKeys: Record<string, string>;
        }

        const prep = await vscode.window.withProgress<UploadPrep | undefined>(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('Preparing API keys...', '正在准备 API Key...'),
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
                return { userInfo: uInfo, allKeys: keys };
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

        const { userInfo, allKeys } = prep;

        // 让用户选择要上传的提供商
        const selectedKeys = await this.selectProviders(allKeys, 'upload');
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

        const isPartialUpload = selectedKeys.size < Object.keys(allKeys).length;

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

                    // 获取或创建 Gist
                    let gistId = GistSyncService.getGistId();
                    let finalKeys = encryptedKeys;

                    if (gistId && isPartialUpload) {
                        // 部分选择上传：读取已有数据合并，不覆盖未选中的密钥
                        const existing = await GistSyncService.readSyncData(userInfo.token, gistId);
                        if (existing) {
                            finalKeys = { ...existing.keys, ...encryptedKeys };
                        }
                    }

                    const syncData = {
                        version: 1,
                        timestamp: new Date().toISOString(),
                        keys: finalKeys
                    };

                    if (gistId) {
                        const success = await GistSyncService.updateGist(userInfo.token, gistId, syncData);
                        if (!success) {
                            Logger.warn('[SyncManager] Update failed, trying to create a new gist');
                            gistId = undefined;
                        }
                    }

                    if (!gistId) {
                        gistId = await GistSyncService.findExistingSyncGist(userInfo.token);
                        if (gistId) {
                            if (isPartialUpload) {
                                const existing = await GistSyncService.readSyncData(userInfo.token, gistId);
                                if (existing) {
                                    finalKeys = { ...existing.keys, ...encryptedKeys };
                                }
                            }

                            const updateSyncData = {
                                version: 1,
                                timestamp: new Date().toISOString(),
                                keys: finalKeys
                            };

                            const updateOk = await GistSyncService.updateGist(userInfo.token, gistId, updateSyncData);
                            if (!updateOk) {
                                gistId = undefined;
                            }
                        }
                        if (!gistId) {
                            gistId = await GistSyncService.createGist(userInfo.token, {
                                version: 1,
                                timestamp: new Date().toISOString(),
                                keys: finalKeys
                            });
                        }
                    }

                    if (!gistId) {
                        vscode.window.showErrorMessage(
                            t(
                                'Failed to create or update the sync Gist. Check the logs for details.',
                                '创建或更新同步 Gist 失败。请查看日志了解详情。'
                            )
                        );
                        return;
                    }

                    await GistSyncService.saveGistId(gistId);

                    const actualEncrypted = Object.keys(encryptedKeys).length;
                    vscode.window.showInformationMessage(
                        t(
                            'Successfully uploaded {0} API keys to GitHub Gist.',
                            '成功将 {0} 个 API Key 上传到 GitHub Gist。',
                            String(actualEncrypted)
                        )
                    );
                    Logger.info(`[SyncManager] Upload complete: ${actualEncrypted} keys to gist ${gistId}`);
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
        // 第一步：认证 + 查找 + 读取（网络）
        interface DownloadData {
            userInfo: { login: string; id: number; token: string };
            syncData: SyncData;
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

                return { userInfo, syncData };
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

        const { syncData } = data;
        const encryptedKeys: [string, string][] = Object.entries(syncData.keys).filter(
            (entry): entry is [string, string] => !!entry[1] && entry[1].trim().length > 0
        );

        if (encryptedKeys.length === 0) {
            vscode.window.showWarningMessage(
                t('No API keys stored on GitHub Gist.', 'GitHub Gist 上没有存储的 API Key。')
            );
            return;
        }

        // 第二步：解密密钥（可能会因口令不匹配失败）
        Logger.debug(`[SyncManager] Decrypting ${encryptedKeys.length} remote key(s)...`);
        let remoteKeys: Record<string, string> = {};
        let allDecrypted = false;

        // 先用当前配置解密
        Logger.debug(`[SyncManager] Decrypting ${encryptedKeys.length} remote key(s) with current key...`);
        for (const [keyName, encryptedValue] of encryptedKeys) {
            const plainValue = await GistSyncService.decrypt(encryptedValue);
            if (plainValue !== undefined) {
                remoteKeys[keyName] = plainValue;
            } else {
                Logger.debug(`[SyncManager] Failed to decrypt key: ${keyName}`);
            }
        }

        allDecrypted = Object.keys(remoteKeys).length === encryptedKeys.length;

        // 如果一条都没解密成功，可能是口令问题
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
                    remoteKeys = {};
                    let passphraseDecryptCount = 0;
                    for (const [keyName, encryptedValue] of encryptedKeys) {
                        const plainValue = GistSyncService.decryptWithPassphrase(encryptedValue, passphrase.trim());
                        if (plainValue !== undefined) {
                            remoteKeys[keyName] = plainValue;
                            passphraseDecryptCount++;
                        }
                    }

                    // 验证成功 — 将正确的口令存储下来（仅一次）
                    if (passphraseDecryptCount > 0 && !(await GistSyncService.verifyPassphrase(passphrase.trim()))) {
                        Logger.info('[SyncManager] Storing user-provided passphrase for future decryption');
                        await GistSyncService.setCustomPassphrase(passphrase.trim());
                    }
                    Logger.debug(
                        `[SyncManager] Passphrase decryption: ${passphraseDecryptCount}/${encryptedKeys.length} keys`
                    );
                    if (Object.keys(remoteKeys).length > 0) {
                        allDecrypted = Object.keys(remoteKeys).length === encryptedKeys.length;
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

        if (!allDecrypted) {
            const unmatchedCount = encryptedKeys.length - Object.keys(remoteKeys).length;
            vscode.window.showWarningMessage(
                t(
                    'Successfully decrypted {0} key(s), but {1} key(s) could not be decrypted. These may use a different encryption passphrase.',
                    '成功解密 {0} 个密钥，但有 {1} 个密钥无法解密。它们可能使用了不同的加密口令。',
                    String(Object.keys(remoteKeys).length),
                    String(unmatchedCount)
                )
            );
        }

        // 第二步：用户选择要下载的提供商
        const selectedKeys = await this.selectProviders(remoteKeys, 'download');
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
                    const appliedKeyCount = await GistSyncService.applyRemoteKeys(keysToApply);

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
