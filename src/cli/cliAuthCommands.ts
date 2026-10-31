/*---------------------------------------------------------------------------------------------
 *  CLI 认证命令注册
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { OAuthCredentialStore } from './auth/oauthCredentialStore';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';

/**
 * 注册 CLI 认证命令
 */
export function registerCliAuthCommands(context: vscode.ExtensionContext): void {
    const cliAuthCommand = vscode.commands.registerCommand('gcmp.cli.auth', async () => {
        const selected = await pickCliProvider(t('Select the CLI tool to authenticate', '选择要认证的 CLI 工具'));
        if (selected) {
            const selection = OAuthCredentialStore.getActiveCredentialSelection(selected.cliType);
            const credentials = await CliAuthFactory.ensureAuthenticated(selected.cliType);
            if (credentials?.access_token) {
                const applied = await ApiKeyManager.setApiKeyForActiveCliCredential(
                    selected.cliType,
                    selection,
                    credentials.access_token
                );
                if (applied) {
                    vscode.window.showInformationMessage(
                        t('{0} authenticated successfully.', '{0} 认证成功。', selected.label)
                    );
                } else {
                    vscode.window.showWarningMessage(
                        t(
                            'The active account changed in another window. The stale API key update was skipped.',
                            '活跃账号已在另一窗口切换，已跳过过期的 API Key 更新。'
                        )
                    );
                }
            } else {
                vscode.window.showErrorMessage(
                    t(
                        '{0} authentication failed. Run the CLI sign-in flow first.',
                        '{0} 认证失败，请先运行 CLI 登录。',
                        selected.label
                    )
                );
            }
        }
    });

    const importCredentialCommand = vscode.commands.registerCommand(
        'gcmp.cli.importCredential',
        async (providerKey?: string) => {
            await importCliCredential(providerKey);
        }
    );

    const selectCredentialCommand = vscode.commands.registerCommand(
        'gcmp.cli.selectCredential',
        async (providerKey?: string) => {
            await selectActiveCredential(providerKey);
        }
    );

    context.subscriptions.push(cliAuthCommand, importCredentialCommand, selectCredentialCommand);
}

interface CliProviderPick {
    label: string;
    cliType: string;
}

/**
 * 选择 CLI provider；传入 providerKey 时直接解析，跳过选择框
 */
async function pickCliProvider(placeHolder: string, providerKey?: string): Promise<CliProviderPick | undefined> {
    const cliTypes = CliAuthFactory.getSupportedCliTypes();
    if (providerKey) {
        const matched = cliTypes.find(cli => cli.id === providerKey);
        return matched ? { label: matched.name, cliType: matched.id } : undefined;
    }
    return await vscode.window.showQuickPick(
        cliTypes.map(cli => ({
            label: cli.name,
            cliType: cli.id
        })),
        { placeHolder }
    );
}

/**
 * 导入 CLI 默认目录凭证为 oauth 文件夹命名凭证（迁移）：
 * 依据账号身份自动派生凭证名（同 CLIProxyAPI 的命名方式），写入 oauth/<provider>-<name>.json 后
 * 移除 CLI 侧凭证，CLI 本体下次使用需重新登录；同名凭证即同一账号，覆盖更新
 */
async function importCliCredential(providerKey?: string): Promise<void> {
    const selected = await pickCliProvider(
        t('Select the CLI tool to import credential from', '选择要导入凭证的 CLI 工具'),
        providerKey
    );
    if (!selected) {
        return;
    }
    const instance = CliAuthFactory.getInstance(selected.cliType);
    if (!instance) {
        return;
    }

    const nativeCredentials = await instance.loadCliNativeCredentials();
    if (!nativeCredentials?.access_token) {
        await vscode.window.showErrorMessage(
            t(
                'The credential for {0} has no access token. Complete sign-in before importing it.',
                '{0} 的凭证缺少 access_token，请先完成登录后再导入。',
                selected.label
            )
        );
        return;
    }

    let credentials: Awaited<ReturnType<typeof CliAuthFactory.ensureCliNativeAuthenticated>>;
    try {
        credentials = await CliAuthFactory.ensureCliNativeAuthenticated(selected.cliType, true);
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to validate CLI native credential:', error);
        credentials = null;
    }
    if (!credentials?.access_token) {
        await vscode.window.showErrorMessage(
            t(
                'The {0} CLI credential could not be validated, so it was not imported. The original credential was left unchanged. Sign in again and retry.',
                '{0} CLI 凭证验证失败，尚未导入；原凭证保持不变。请重新登录后重试。',
                selected.label
            )
        );
        return;
    }

    // 依据账号身份自动派生凭证名（同 CLIProxyAPI：codex 为 <账号哈希>-<邮箱>-<计划>，grok 为 <邮箱>）；
    // 凭证名由账号身份决定，同名即同一账号，重复导入覆盖更新
    const credentialName = instance.suggestCredentialName(credentials);

    const confirmLabel = t('Import and remove CLI credential', '导入并移除 CLI 凭证');
    const confirmed = await vscode.window.showWarningMessage(
        t(
            'The credential for {0} will be migrated to the oauth folder as "{1}" (an existing credential with the same name will be updated) and removed from its original CLI configuration. Sign in to {0} again the next time you use it.',
            '将把 {0} 的凭证迁移到 oauth 文件夹（按账号命名为「{1}」，同名凭证将被更新），并从原 CLI 配置中移除；下次使用 {0} 时需要重新登录。',
            selected.label,
            credentialName
        ),
        { modal: true },
        confirmLabel
    );
    if (confirmed !== confirmLabel) {
        return;
    }

    const record = instance.toOAuthStoreRecord(credentials);
    let oauthPath: string;
    try {
        oauthPath = await OAuthCredentialStore.saveCredentialFile(selected.cliType, credentialName, record);
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to save oauth credential:', error);
        await vscode.window.showErrorMessage(
            t('Failed to save the oauth credential file.', '保存 oauth 凭证文件失败。')
        );
        return;
    }

    let selection: Awaited<ReturnType<typeof CliAuthFactory.setActiveCredential>>;
    try {
        selection = await CliAuthFactory.setActiveCredential(selected.cliType, credentialName);
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to activate imported oauth credential:', error);
        await vscode.window.showErrorMessage(
            t(
                'The credential was saved to {0}, but could not be activated. The CLI credential was kept at {1}. Retry the import after resolving the selection error.',
                '凭证已保存到 {0}，但无法设为活跃；CLI 原凭证已保留在 {1}。请解决选择错误后重试导入。',
                oauthPath,
                instance.getCliNativeCredentialPath()
            )
        );
        return;
    }

    try {
        const applied = await ApiKeyManager.setApiKeyForActiveCliCredential(
            selected.cliType,
            selection,
            credentials.access_token
        );
        if (!applied) {
            await vscode.window.showWarningMessage(
                t(
                    'The credential was imported, but another window changed the active account. The CLI credential was kept at {0}.',
                    '凭证已导入，但另一窗口已切换活跃账号。CLI 原凭证仍保留在 {0}。',
                    instance.getCliNativeCredentialPath()
                )
            );
            return;
        }
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to sync imported oauth credential to API key storage:', error);
        const cleanup = await clearRuntimeCliApiKey(selected.cliType, 'after import API key sync failure', selection);
        const keyStatusMessage =
            cleanup === 'cleared' ? t('The previous runtime API key was cleared.', '此前的运行时 API Key 已清除。')
            : cleanup === 'stale' ?
                t(
                    'The active account changed in another window, so its runtime API key was left untouched.',
                    '活跃账号已在另一窗口切换，因此未改动其运行时 API Key。'
                )
            :   t(
                    'The previous runtime API key could not be confirmed as cleared and may still be used.',
                    '无法确认此前的运行时 API Key 已清除，请求仍可能使用该 Key。'
                );
        await vscode.window.showErrorMessage(
            t(
                'The credential was saved to {0} and activated, but API key sync failed. {1} The CLI credential was kept at {2}. Retry the import after resolving the storage error.',
                '凭证已保存到 {0} 并设为活跃，但 API Key 同步失败。{1}CLI 原凭证保留在 {2}。请解决存储错误后重试导入。',
                oauthPath,
                keyStatusMessage,
                instance.getCliNativeCredentialPath()
            )
        );
        return;
    }

    try {
        await instance.removeCliNativeCredential();
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to remove CLI native credential:', error);
        await vscode.window.showWarningMessage(
            t(
                'The credential was imported and activated, but removing the CLI-side credential failed. Delete it manually: {0}',
                '凭证已导入并设为活跃，但移除 CLI 侧凭证失败，请手动删除：{0}',
                instance.getCliNativeCredentialPath()
            )
        );
    }

    await vscode.window.showInformationMessage(
        t(
            'Credential imported as "{0}" and activated. The {1} CLI will need to sign in again on next use.',
            '凭证已导入为「{0}」并设为活跃。{1} CLI 本体下次使用时需要重新登录。',
            credentialName,
            selected.label
        )
    );
}

/**
 * 在 oauth 文件夹的命名凭证中选择指定 provider 的活跃凭证
 */
async function selectActiveCredential(providerKey?: string): Promise<void> {
    const selected = await pickCliProvider(
        t('Select the CLI tool to switch credential for', '选择要切换凭证的 CLI 工具'),
        providerKey
    );
    if (!selected) {
        return;
    }

    const entries = CliAuthFactory.listOAuthCredentials(selected.cliType);
    if (entries.length === 0) {
        const openFolderLabel = t('Open oauth Folder', '打开 oauth 文件夹');
        const result = await vscode.window.showInformationMessage(
            t(
                'No oauth credentials for {0} yet. Place <provider>-<name>.json files in the oauth folder, or import the CLI credential.',
                '{0} 在 oauth 文件夹中还没有凭证。可将 <provider>-<name>.json 文件放入 oauth 文件夹，或导入 CLI 凭证。',
                selected.label
            ),
            openFolderLabel
        );
        if (result === openFolderLabel) {
            const oauthDir = CliAuthFactory.getOAuthCredentialDir();
            if (oauthDir) {
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(oauthDir));
            }
        }
        return;
    }

    const usableEntries = entries.filter(entry => entry.hasAccessToken);
    if (usableEntries.length === 0) {
        const selection = OAuthCredentialStore.getActiveCredentialSelection(selected.cliType);
        await ApiKeyManager.deleteApiKeyForActiveCliCredential(selected.cliType, selection);
        await vscode.window.showErrorMessage(
            t(
                'No usable oauth credential for {0}: every file is missing a non-empty access_token.',
                '{0} 的 oauth 凭证均不可用：所有文件都缺少非空 access_token。',
                selected.label
            )
        );
        return;
    }

    const activeName = CliAuthFactory.getCredentialSourceInfo(selected.cliType).name;
    const picked = await vscode.window.showQuickPick(
        usableEntries.map(entry => ({
            label: entry.name,
            description:
                (entry.name === activeName ? t('$(check) current', '$(check) 当前') : '') +
                (entry.label ? ` ${entry.label}` : ''),
            detail: formatCredentialEntryDetail(entry.expiryDate, entry.hasAccessToken),
            credentialName: entry.name
        })),
        {
            title: t('Select active credential for {0}', '选择 {0} 的活跃凭证', selected.label),
            placeHolder: t('Requests will use the selected credential', '请求将使用所选凭证')
        }
    );
    if (!picked || picked.credentialName === activeName) {
        return;
    }

    const selection = await CliAuthFactory.setActiveCredential(selected.cliType, picked.credentialName);
    let credentials: Awaited<ReturnType<typeof CliAuthFactory.ensureAuthenticated>>;
    try {
        credentials = await CliAuthFactory.ensureAuthenticated(selected.cliType);
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to authenticate selected credential:', error);
        credentials = null;
    }
    if (!credentials?.access_token) {
        const deleted = await ApiKeyManager.deleteApiKeyForActiveCliCredential(selected.cliType, selection);
        await vscode.window.showErrorMessage(
            t(
                'Credential "{0}" could not be authenticated. {1}',
                '凭证「{0}」无法完成认证。{1}',
                picked.credentialName,
                deleted ?
                    t('The previous API key was cleared.', '此前的 API Key 已清除。')
                :   t(
                        'The active account changed in another window, so its API key was left untouched.',
                        '活跃账号已在另一窗口切换，因此未改动其 API Key。'
                    )
            )
        );
        return;
    }
    try {
        const applied = await ApiKeyManager.setApiKeyForActiveCliCredential(
            selected.cliType,
            selection,
            credentials.access_token
        );
        if (!applied) {
            await vscode.window.showWarningMessage(
                t(
                    'The active account changed in another window. The stale API key update was skipped.',
                    '活跃账号已在另一窗口切换，已跳过过期的 API Key 更新。'
                )
            );
            return;
        }
    } catch (error) {
        Logger.error('[CliAuthCommands] Failed to sync selected oauth credential to API key storage:', error);
        const cleanup = await clearRuntimeCliApiKey(
            selected.cliType,
            'after credential selection API key sync failure',
            selection
        );
        const cleanupMessage =
            cleanup === 'cleared' ? t('The previous API key was cleared.', '此前的 API Key 已清除。')
            : cleanup === 'stale' ?
                t(
                    'The active account changed in another window; its API key was left untouched.',
                    '活跃账号已在另一窗口切换，未改动其 API Key。'
                )
            :   t(
                    'The previous API key could not be confirmed as cleared and may still be used.',
                    '无法确认此前的 API Key 已清除，请求仍可能使用该 Key。'
                );
        await vscode.window.showErrorMessage(
            t(
                'Credential "{0}" is active, but API key sync failed. {1}',
                '凭证「{0}」已设为活跃，但 API Key 同步失败。{1}',
                picked.credentialName,
                cleanupMessage
            )
        );
        return;
    }
    await vscode.window.showInformationMessage(
        t(
            '{0} now uses oauth credential "{1}".',
            '{0} 已切换为使用 oauth 凭证「{1}」。',
            selected.label,
            picked.credentialName
        )
    );
}

async function clearRuntimeCliApiKey(
    provider: string,
    reason: string,
    selection: ReturnType<typeof OAuthCredentialStore.getActiveCredentialSelection>
): Promise<'cleared' | 'stale' | 'failed'> {
    try {
        const deleted = await ApiKeyManager.deleteApiKeyForActiveCliCredential(provider, selection);
        return deleted ? 'cleared' : 'stale';
    } catch (error) {
        Logger.error(`[CliAuthCommands] Failed to clear stale API key ${reason}:`, error);
        return 'failed';
    }
}

function formatCredentialEntryDetail(expiryDate: number | undefined, hasAccessToken: boolean): string {
    if (!hasAccessToken) {
        return t('Missing access_token', '缺少 access_token');
    }
    if (expiryDate === undefined) {
        return t('Expiration unknown', '有效期未知');
    }
    const remainingMs = expiryDate - Date.now();
    if (remainingMs <= 0) {
        return t('Expired (will refresh on use)', '已过期（使用时会自动刷新）');
    }
    const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
    return t('Valid for about {0}h', '约剩余 {0} 小时', String(remainingHours));
}
