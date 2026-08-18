/*---------------------------------------------------------------------------------------------
 *  旧版 Gist 同步数据迁移（首次打开面板时引导 + 手动入口）
 *  仅迁移"旧版按 provider 同步的单个 API Key"到当前 per-slot 配置集模型
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { GistSyncService } from './gistSyncService';
import { ConfigSetStore } from '../utils/config/configSetStore';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { configProviders } from '../providers/config';
import { CompatibleModelManager } from '../utils/config/compatibleModelManager';
import { listSlots, readCurrentSite, getSiteOwnerProvider } from '../utils/config/configSetCommands';
import { Logger } from '../utils/runtime/logger';
import { t } from '../utils/runtime/l10n';

const MIGRATION_DONE_KEY = 'configSets.legacyGistMigration.done';
const MIGRATION_DISMISSED_KEY = 'configSets.legacyGistMigration.dismissed';

interface MigrationCandidate {
    keyName: string;
    plainKey: string;
}

function isMigrationDone(context: vscode.ExtensionContext): boolean {
    return context.globalState.get<boolean>(MIGRATION_DONE_KEY, false);
}

function isMigrationDismissed(context: vscode.ExtensionContext): boolean {
    return context.globalState.get<boolean>(MIGRATION_DISMISSED_KEY, false);
}

async function markMigrationDone(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(MIGRATION_DONE_KEY, true);
}

async function markMigrationDismissed(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update(MIGRATION_DISMISSED_KEY, true);
}

/** 本地已缓存旧版 Gist，或能静默探测到远端旧版 Gist（探测到则回填缓存） */
async function hasLegacyGistData(): Promise<boolean> {
    if (GistSyncService.getGistId()) {
        return true;
    }
    const userInfo = await GistSyncService.getUserInfo(true);
    if (!userInfo) {
        return false;
    }
    const gistId = await GistSyncService.findExistingSyncGist(userInfo.token);
    if (gistId) {
        await GistSyncService.saveGistId(gistId);
        return true;
    }
    return false;
}

function newConfigId(): string {
    return randomUUID();
}

function mapLegacyKeyToSlot(keyName: string): string | undefined {
    if (!keyName.endsWith('.apiKey')) {
        return undefined;
    }
    const provider = keyName.replace(/\.apiKey$/, '');
    if (!provider || CliAuthFactory.getSupportedCliTypes().some(cli => cli.id === provider)) {
        return undefined;
    }
    if (configProviders[provider as keyof typeof configProviders]) {
        return provider;
    }
    for (const builtin of Object.keys(configProviders)) {
        if (listSlots(builtin).some(slot => slot.slot === provider)) {
            return provider;
        }
    }
    if (CompatibleModelManager.getCustomProviderIds().includes(provider)) {
        return provider;
    }
    return undefined;
}

async function resolveLegacyGist(token: string): Promise<{ gistId: string; keys: Record<string, string> } | undefined> {
    let gistId = GistSyncService.getGistId();
    if (!gistId) {
        // 本地未缓存旧版 Gist（新设备 / 先开面板）：静默探测远端旧版 Gist 并回填
        gistId = await GistSyncService.findExistingSyncGist(token);
        if (gistId) {
            await GistSyncService.saveGistId(gistId);
        }
    }
    if (!gistId) {
        return undefined;
    }
    const syncData = await GistSyncService.readSyncData(token, gistId);
    if (!syncData?.keys || Object.keys(syncData.keys).length === 0) {
        return undefined;
    }
    return { gistId, keys: syncData.keys };
}

async function decryptLegacyKeys(
    encryptedKeys: Record<string, string>,
    passphrase?: string
): Promise<{ keys: Record<string, string>; failed: string[] }> {
    const remoteKeys: Record<string, string> = {};
    const failed: string[] = [];
    for (const [keyName, encryptedValue] of Object.entries(encryptedKeys)) {
        if (!encryptedValue?.trim()) {
            continue;
        }
        const plainValue =
            passphrase !== undefined ?
                await GistSyncService.decryptWithPassphrase(encryptedValue, passphrase)
            :   await GistSyncService.decrypt(encryptedValue);
        if (plainValue !== undefined) {
            remoteKeys[keyName] = plainValue;
        } else {
            failed.push(keyName);
        }
    }
    return { keys: remoteKeys, failed };
}

async function promptForPassphraseIfNeeded(): Promise<string | undefined | null> {
    const hasPassphrase = await GistSyncService.hasCustomPassphrase();
    const choice = await vscode.window.showWarningMessage(
        hasPassphrase ?
            t(
                'Legacy Gist data could not be decrypted with the current passphrase. Enter the previous passphrase to continue migration?',
                '旧版 Gist 数据无法用当前口令解密。是否输入之前使用的口令继续迁移？'
            )
        :   t(
                'Legacy Gist data may have been encrypted with a custom passphrase. Enter the passphrase to continue migration?',
                '旧版 Gist 数据可能使用了自定义口令加密。是否输入口令继续迁移？'
            ),
        { modal: true },
        t('Enter passphrase', '输入口令'),
        t('Cancel', '取消')
    );
    if (choice !== t('Enter passphrase', '输入口令')) {
        return null;
    }
    const passphrase = await vscode.window.showInputBox({
        prompt: t(
            'Enter the encryption passphrase used for the legacy Gist data',
            '请输入旧版 Gist 数据使用的加密口令'
        ),
        password: true,
        ignoreFocusOut: true
    });
    return passphrase?.trim() ? passphrase.trim() : undefined;
}

/**
 * 执行旧版 Gist → 配置集迁移
 * @returns 迁移数量；用户取消返回 undefined
 */
export async function migrateLegacyGistToConfigSets(
    context: vscode.ExtensionContext,
    options?: { silentIfNoLegacyData?: boolean }
): Promise<number | undefined> {
    const userInfo = await GistSyncService.getUserInfo(true);
    if (!userInfo) {
        if (!options?.silentIfNoLegacyData) {
            vscode.window.showWarningMessage(
                t('Sign in to GitHub first, then retry legacy migration.', '请先登录 GitHub，再重试旧版迁移。')
            );
        }
        return undefined;
    }

    const legacy = await resolveLegacyGist(userInfo.token);
    if (!legacy) {
        if (!options?.silentIfNoLegacyData) {
            vscode.window.showInformationMessage(
                t('No legacy Gist sync data found to migrate.', '未找到可迁移的旧版 Gist 同步数据。')
            );
        }
        return undefined;
    }

    const initial = await decryptLegacyKeys(legacy.keys);
    let decrypted = initial.keys;
    let failed = initial.failed;
    if (failed.length > 0) {
        const passphrase = await promptForPassphraseIfNeeded();
        if (passphrase === null) {
            return undefined;
        }
        if (passphrase) {
            const retryEntries = Object.fromEntries(failed.map(keyName => [keyName, legacy.keys[keyName]]));
            const retry = await decryptLegacyKeys(retryEntries, passphrase);
            decrypted = { ...decrypted, ...retry.keys };
            failed = retry.failed;
        }
    }
    if (Object.keys(decrypted).length === 0) {
        if (!options?.silentIfNoLegacyData) {
            vscode.window.showWarningMessage(
                t(
                    'Failed to decrypt all legacy Gist data. Migration was not performed.',
                    '无法解密旧版 Gist 数据，未执行迁移。'
                )
            );
        }
        return undefined;
    }

    const candidates: MigrationCandidate[] = Object.entries(decrypted)
        .map(([keyName, plainKey]) => ({ keyName, plainKey }))
        .filter(candidate => mapLegacyKeyToSlot(candidate.keyName) !== undefined);
    if (candidates.length === 0) {
        // 仅全部解密成功时才标记完成；存在失败项时保留标记以便重试
        if (failed.length === 0) {
            await markMigrationDone(context);
        }
        if (!options?.silentIfNoLegacyData) {
            vscode.window.showInformationMessage(
                t(
                    'No legacy keys can be mapped to the new API key management UI.',
                    '旧版数据中没有可迁移到新管理界面的 API Key。'
                )
            );
        }
        return 0;
    }

    let migrated = 0;
    for (const candidate of candidates) {
        const slot = mapLegacyKeyToSlot(candidate.keyName);
        if (!slot) {
            continue;
        }
        // 跳过该 Key 已存在于当前槽位的情形（如本机已自动收编同一 Key 为默认配置）
        let alreadyExists = false;
        for (const existing of ConfigSetStore.list(slot)) {
            if ((await ConfigSetStore.getApiKey(slot, existing.id)) === candidate.plainKey) {
                alreadyExists = true;
                break;
            }
        }
        if (alreadyExists) {
            continue;
        }
        const siteOwner = getSiteOwnerProvider(slot);
        const site = siteOwner ? readCurrentSite(siteOwner) : undefined;
        const item = { id: newConfigId(), label: t('Migrated from legacy Gist', '旧版 Gist 迁移'), site };
        await ConfigSetStore.add(slot, item, candidate.plainKey);
        const currentKey = await ApiKeyManager.getApiKey(slot);
        if (currentKey === candidate.plainKey) {
            await ConfigSetStore.setActive(slot, item.id);
        }
        migrated++;
        Logger.info(`[LegacyGistMigration] Migrated ${candidate.keyName} -> ${slot}`);
    }

    if (failed.length === 0) {
        await markMigrationDone(context);
    } else {
        // 失败项保留在远端 Gist 中，不标记完成，下次提示时可凭口令重试
        Logger.warn(
            `[LegacyGistMigration] ${failed.length} legacy key(s) skipped (undecryptable): ${failed.join(', ')}`
        );
        if (!options?.silentIfNoLegacyData) {
            vscode.window.showWarningMessage(
                t(
                    '{0} legacy key(s) could not be decrypted and were skipped. The source Gist is unchanged; you can retry the migration later.',
                    '{0} 个旧版 API Key 无法解密已跳过。源 Gist 数据未改动，可稍后重试迁移。',
                    failed.length
                )
            );
        }
    }
    return migrated;
}

/**
 * 首次打开面板时按需提示迁移
 * @returns 已迁移数量；未迁移/取消返回 undefined
 */
export async function promptLegacyGistMigrationOnFirstOpen(
    context: vscode.ExtensionContext
): Promise<number | undefined> {
    if (isMigrationDone(context) || isMigrationDismissed(context)) {
        return undefined;
    }
    // 本地未缓存旧版 Gist 时，静默探测远端（新设备 / 先开面板路径）
    if (!(await hasLegacyGistData())) {
        return undefined;
    }

    const choice = await vscode.window.showInformationMessage(
        t(
            'Legacy Gist sync data was detected. Migrate it to the new API key management UI now?',
            '检测到旧版 Gist 同步数据。是否现在迁移到新的 API Key 管理界面？'
        ),
        t('Migrate now', '立即迁移'),
        t('Not now', '暂不'),
        t("Don't ask again", '不再提示')
    );

    if (choice === t('Migrate now', '立即迁移')) {
        const migrated = await migrateLegacyGistToConfigSets(context, { silentIfNoLegacyData: true });
        if (migrated !== undefined) {
            vscode.window.showInformationMessage(
                t(
                    'Migrated {0} legacy key(s) into the new API key management UI.',
                    '已迁移 {0} 个旧版 API Key 到新的管理界面。',
                    migrated
                )
            );
        }
        return migrated;
    }
    if (choice === t("Don't ask again", '不再提示')) {
        await markMigrationDismissed(context);
    }
    return undefined;
}
