/*---------------------------------------------------------------------------------------------
 *  Gist 加密口令用户流程（公共）
 *  SyncManager（API Key 同步）与配置集面板共用，避免两处复制同一套输入/确认/重传逻辑
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { t } from '../utils/runtime/l10n';
import {
    findExistingConfigSetGist,
    readRemoteConfigSets,
    writeRemoteConfigSetsWithPassphrase,
    type ConfigSetSyncData
} from './configSetSyncService';
import { GistSyncService } from './gistSyncService';

interface PassphraseReuploadSnapshot {
    token: string;
    legacy?: { gistId: string; data: Awaited<ReturnType<typeof GistSyncService.readDecryptedSyncData>> };
    configSets?: { gistId: string; data: ConfigSetSyncData };
}

async function prepareReuploadSnapshot(): Promise<PassphraseReuploadSnapshot | undefined> {
    const userInfo = (await GistSyncService.getUserInfo(true)) ?? (await GistSyncService.getUserInfo(false));
    if (!userInfo) {
        return undefined;
    }

    const legacyGistId = GistSyncService.getGistId() ?? (await GistSyncService.findExistingSyncGist(userInfo.token));
    const snapshot: PassphraseReuploadSnapshot = { token: userInfo.token };

    if (legacyGistId) {
        const data = await GistSyncService.readDecryptedSyncData(userInfo.token, legacyGistId);
        if (!data) {
            return undefined;
        }
        snapshot.legacy = { gistId: legacyGistId, data };
    }

    const configSetCandidates = new Set<string>();
    const savedConfigSetGistId = GistSyncService.getConfigSetGistId();
    if (savedConfigSetGistId) {
        configSetCandidates.add(savedConfigSetGistId);
    }
    if (legacyGistId) {
        configSetCandidates.add(legacyGistId);
    }

    for (const gistId of configSetCandidates) {
        const result = await readRemoteConfigSets(userInfo.token, gistId);
        if (result.status === 'ok') {
            snapshot.configSets = { gistId, data: result.data };
            await GistSyncService.saveConfigSetGistId(gistId);
            break;
        }
        if (result.status === 'decrypt-failed' || result.status === 'error') {
            return undefined;
        }
    }

    if (!snapshot.configSets) {
        const discoveredGistId = await findExistingConfigSetGist(userInfo.token);
        if (discoveredGistId && !configSetCandidates.has(discoveredGistId)) {
            const result = await readRemoteConfigSets(userInfo.token, discoveredGistId);
            if (result.status !== 'ok') {
                return undefined;
            }
            snapshot.configSets = { gistId: discoveredGistId, data: result.data };
            await GistSyncService.saveConfigSetGistId(discoveredGistId);
        }
    }
    return snapshot;
}

async function writeSnapshot(
    snapshot: PassphraseReuploadSnapshot,
    passphrase: string | undefined
): Promise<{ success: boolean; legacyWritten: boolean; configSetsWritten: boolean }> {
    let legacyAttempted = false;
    let configSetsAttempted = false;
    if (snapshot.legacy?.data) {
        legacyAttempted = true;
        const legacyWritten = await GistSyncService.writeSyncDataWithPassphrase(
            snapshot.token,
            snapshot.legacy.gistId,
            snapshot.legacy.data,
            passphrase
        );
        if (!legacyWritten) {
            return { success: false, legacyWritten: legacyAttempted, configSetsWritten: configSetsAttempted };
        }
    }
    if (snapshot.configSets) {
        configSetsAttempted = true;
        const configSetsWritten = await writeRemoteConfigSetsWithPassphrase(
            snapshot.token,
            snapshot.configSets.gistId,
            snapshot.configSets.data,
            passphrase
        );
        if (!configSetsWritten) {
            return { success: false, legacyWritten: legacyAttempted, configSetsWritten: configSetsAttempted };
        }
    }
    return { success: true, legacyWritten: legacyAttempted, configSetsWritten: configSetsAttempted };
}

async function rollbackSnapshot(
    snapshot: PassphraseReuploadSnapshot,
    oldPassphrase: string | undefined,
    written: { legacyWritten: boolean; configSetsWritten: boolean }
): Promise<boolean> {
    const legacyOk =
        !written.legacyWritten ||
        (!!snapshot.legacy?.data &&
            (await GistSyncService.writeSyncDataWithPassphrase(
                snapshot.token,
                snapshot.legacy.gistId,
                snapshot.legacy.data,
                oldPassphrase
            )));
    const configSetsOk =
        !written.configSetsWritten ||
        (!!snapshot.configSets &&
            (await writeRemoteConfigSetsWithPassphrase(
                snapshot.token,
                snapshot.configSets.gistId,
                snapshot.configSets.data,
                oldPassphrase
            )));
    return legacyOk && configSetsOk;
}

/**
 * 设置/更改加密口令流程（原生输入框）
 * @param hasGist 调用入口额外探测到的远端数据
 */
export async function runSetPassphraseFlow(hasGist?: boolean): Promise<void> {
    const currentHash = await GistSyncService.hasCustomPassphrase();
    const status = await GistSyncService.getStatus();
    let hasExistingData = !!hasGist || status.hasGist || !!GistSyncService.getConfigSetGistId();
    if (!hasExistingData && status.isLoggedIn) {
        const userInfo = await GistSyncService.getUserInfo(true);
        if (userInfo) {
            const legacyGistId = await GistSyncService.findExistingSyncGist(userInfo.token);
            const configSetGistId = await findExistingConfigSetGist(userInfo.token);
            if (legacyGistId) {
                await GistSyncService.saveGistId(legacyGistId);
            }
            if (configSetGistId) {
                await GistSyncService.saveConfigSetGistId(configSetGistId);
            }
            hasExistingData = !!legacyGistId || !!configSetGistId;
        }
    }

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
    if (currentHash && hasExistingData) {
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
    } else if (!currentHash && hasExistingData) {
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

    const newPassphrase = passphrase.trim();
    if (shouldReupload) {
        const oldPassphrase = await GistSyncService.getCustomPassphrase();
        const snapshot = await prepareReuploadSnapshot();
        if (!snapshot) {
            vscode.window.showErrorMessage(
                t(
                    'Unable to read all existing Gist data. The passphrase was not changed.',
                    '无法完整读取现有 Gist 数据，口令未更改。'
                )
            );
            return;
        }

        const written = await writeSnapshot(snapshot, newPassphrase);
        if (!written.success) {
            const rolledBack = await rollbackSnapshot(snapshot, oldPassphrase, written);
            vscode.window.showErrorMessage(
                rolledBack ?
                    t(
                        'Failed to re-encrypt all Gist data. The previous passphrase remains active.',
                        '无法重加密全部 Gist 数据，原口令仍然有效。'
                    )
                :   t(
                        'Passphrase rotation failed and remote rollback was incomplete. Restore the affected Gist before retrying.',
                        '口令轮换失败，且远端回滚不完整。请先恢复受影响的 Gist 再重试。'
                    )
            );
            return;
        }

        const success = await GistSyncService.setCustomPassphrase(newPassphrase);
        if (!success) {
            const rolledBack = await rollbackSnapshot(snapshot, oldPassphrase, written);
            vscode.window.showErrorMessage(
                rolledBack ?
                    t(
                        'Failed to save the new passphrase. Remote data was restored.',
                        '新口令保存失败，远端数据已恢复。'
                    )
                :   t(
                        'Failed to save the new passphrase and remote rollback was incomplete.',
                        '新口令保存失败，且远端回滚不完整。'
                    )
            );
            return;
        }
    } else {
        const success = await GistSyncService.setCustomPassphrase(newPassphrase);
        if (!success) {
            vscode.window.showErrorMessage(t('Failed to set encryption passphrase.', '设置加密口令失败。'));
            return;
        }
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
}

/**
 * 清除自定义加密口令流程（原生确认框）
 */
export async function runClearPassphraseFlow(): Promise<void> {
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
