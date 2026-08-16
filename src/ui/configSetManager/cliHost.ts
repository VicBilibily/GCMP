/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - CLI 提供商状态构造
 *  从 index.ts 抽出：构造 CLI 提供商占位与实际状态列表的纯逻辑，
 *  Panel 只需调用 buildCliProviderPlaceholders / buildCliProviders 即可拿到数据再 post。
 *---------------------------------------------------------------------------------------------*/

import { CliAuthFactory } from '../../cli/auth/cliAuthFactory';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';
import type { CliProviderOption } from './types';

/** 构造首屏占位的 CLI 提供商列表（loading=true，等异步加载完毕后替换） */
export function buildCliProviderPlaceholders(): CliProviderOption[] {
    return CliAuthFactory.getSupportedCliTypes().map(cli => ({
        provider: cli.id,
        displayName: cli.name,
        loading: true,
        isAuthenticated: false,
        cliCommand: cli.id,
        isCliInstalled: false
    }));
}

/** 异步加载全部 CLI 提供商的真实状态（已安装 / 已认证 / 状态详情） */
export async function buildCliProviders(): Promise<CliProviderOption[]> {
    const cliTypes = CliAuthFactory.getSupportedCliTypes();
    const result: CliProviderOption[] = [];
    for (const cli of cliTypes) {
        try {
            const instance = CliAuthFactory.getInstance(cli.id);
            const isCliInstalled = instance ? await instance.isCliInstalled() : false;
            const credentials = await CliAuthFactory.loadCredentials(cli.id);
            let isAuthenticated = false;
            let statusDetail: string | undefined;
            if (!credentials) {
                statusDetail = t('No credentials found. Run CLI sign-in first.', '未找到凭证，请先运行 CLI 登录。');
            } else if (CliAuthFactory.isCredentialExpired(cli.id, credentials)) {
                statusDetail = t('Credentials expired. Click refresh to renew.', '凭证已过期，点击刷新以续期。');
            } else {
                isAuthenticated = true;
                statusDetail = t('Valid', '有效');
            }
            result.push({
                provider: cli.id,
                displayName: cli.name,
                loading: false,
                isAuthenticated,
                cliCommand: cli.id,
                isCliInstalled,
                statusDetail
            });
        } catch (error) {
            Logger.warn(`[ConfigSetManager] Failed to load CLI status for ${cli.id}:`, error);
            result.push({
                provider: cli.id,
                displayName: cli.name,
                loading: false,
                isAuthenticated: false,
                cliCommand: cli.id,
                isCliInstalled: false,
                statusDetail: t('Unable to check status. Retry refresh later.', '暂时无法检查状态，请稍后重试刷新。')
            });
        }
    }
    return result;
}
