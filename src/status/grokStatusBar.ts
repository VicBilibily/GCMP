/*---------------------------------------------------------------------------------------------
 *  Grok 用量查询状态栏项
 *  使用 Grok CLI OAuth 登录态显示 SuperGrok/Grok 订阅剩余额度
 *  查询逻辑已下沉到 ../quota/grokQuota，本文件只保留 UI 渲染。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { OAuthCredentialStore } from '../cli/auth/oauthCredentialStore';
import { t } from '../utils/runtime/l10n';
import { GrokStatusData, queryGrokUsage } from '../quota/grokQuota';
import { formatDateTimeSlash } from '../quota/format';
import { cacheRequestBalanceByKeyHash } from '../quota/requestBalance';
import {
    collectCliOAuthQuotaStatus,
    isCliOAuthQuotaEnabled,
    isCliOAuthQuotaStatusCurrent,
    renderCliOAuthQuotaSection,
    type CliOAuthQuotaSource,
    type CliOAuthQuotaStatus
} from './cliOAuthQuotaTracker';

export type { GrokStatusData } from '../quota/grokQuota';

interface GrokStatusBarData extends GrokStatusData {
    cliOAuthQuota?: CliOAuthQuotaStatus<GrokStatusData>;
}

const grokQuotaQuery = {
    query: (credentialName: string) =>
        queryGrokUsage(
            new Date().toLocaleString(vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'),
            credentialName
        ),
    summary: (data: GrokStatusData) => `${data.usage.remainingPercent.toFixed(0)}%`
};

const grokQuotaSource: CliOAuthQuotaSource = {
    getRoutingSettings: () => OAuthCredentialStore.getRoutingSettings('grok'),
    listCredentials: () => CliAuthFactory.listOAuthCredentials('grok'),
    getActiveSelection: () => CliAuthFactory.getActiveCredentialSelection('grok')
};

export class GrokStatusBar extends BaseStatusBarItem<GrokStatusBarData> {
    private failedCliOAuthQuota: CliOAuthQuotaStatus<GrokStatusData> | undefined;

    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.grok',
            name: 'GCMP: Grok Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 14,
            refreshCommand: 'gcmp.grok.refreshUsage',
            apiKeyProvider: 'grok',
            cacheKeyPrefix: 'grok',
            logPrefix: 'Grok Status Bar',
            icon: '$(gcmp-grok)'
        };
        super(config);
    }

    protected getDisplayText(data: GrokStatusBarData): string {
        return `${this.config.icon} ${data.usage.remainingPercent.toFixed(0)}%`;
    }

    protected generateTooltip(data: GrokStatusBarData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        const tier = data.usage.subscriptionTier ? ` ${data.usage.subscriptionTier}` : '';
        const windowLabel =
            data.usage.type === 'weekly' ? t('Weekly quota', '每周额度') : t('Monthly quota', '每月额度');
        const countdown = this.formatCountdown(data.usage.resetAt);
        const resetTime = data.usage.resetAt ? formatDateTimeSlash(new Date(data.usage.resetAt)) : '—';

        md.appendMarkdown(`#### Grok${tier}\n\n`);
        md.appendMarkdown(
            `| ${t('Window', '限频类型')} | ${t('Remaining', '剩余量')} | ${t('Countdown', '倒计时')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :----: | ----: | ----: | :------: |\n');
        md.appendMarkdown(
            `| **${windowLabel}** | **${data.usage.remainingPercent.toFixed(0)}%** | ${countdown} | ${resetTime} |\n`
        );
        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        const quotaSection = renderCliOAuthQuotaSection(
            this.getCurrentCliOAuthQuota(data.cliOAuthQuota),
            grokQuotaSource,
            grokQuotaQuery,
            {
                nameColumn: t('Account', '账号'),
                usageColumn: t('Usage', '使用情况'),
                notConfigured: t('Credential unavailable.', '凭证不可用。'),
                queryFailed: t('Query failed.', '查询失败。'),
                staleResult: t('Result expired; refreshing.', '结果已过期，正在刷新。')
            }
        );
        if (quotaSection) {
            md.appendMarkdown('\n---\n\n');
            md.appendMarkdown(quotaSection);
        }
        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    protected override getApiQueryErrorTooltip(error: string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(t('Failed to fetch: {0}', '获取失败: {0}', error));
        const quotaSection = renderCliOAuthQuotaSection(
            this.getCurrentCliOAuthQuota(this.failedCliOAuthQuota),
            grokQuotaSource,
            grokQuotaQuery,
            {
                nameColumn: t('Account', '账号'),
                usageColumn: t('Usage', '使用情况'),
                notConfigured: t('Credential unavailable.', '凭证不可用。'),
                queryFailed: t('Query failed.', '查询失败。'),
                staleResult: t('Result expired; refreshing.', '结果已过期，正在刷新。')
            }
        );
        if (quotaSection) {
            md.appendMarkdown('\n---\n\n');
            md.appendMarkdown(quotaSection);
        }
        return md;
    }

    protected shouldHighlightWarning(data: GrokStatusBarData): boolean {
        return data.usage.usedPercent >= this.HIGH_USAGE_THRESHOLD;
    }

    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
        }
        return super.shouldRefresh();
    }

    protected async performApiQuery(): Promise<{ success: boolean; data?: GrokStatusBarData; error?: string }> {
        const lastUpdated = new Date().toLocaleString(
            vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
        );
        const routingSettings = grokQuotaSource.getRoutingSettings();
        const activeSelection = grokQuotaSource.getActiveSelection();
        const multiAccountBalance = isCliOAuthQuotaEnabled(grokQuotaSource);
        const result = await queryGrokUsage(lastUpdated, multiAccountBalance ? activeSelection.name : undefined);
        if (!result.success || !result.data) {
            this.failedCliOAuthQuota = undefined;
            if (multiAccountBalance && sameSelection(activeSelection, grokQuotaSource.getActiveSelection())) {
                const cliOAuthQuota = await collectCliOAuthQuotaStatus(grokQuotaSource, grokQuotaQuery, {
                    credentialName: activeSelection.name,
                    result
                });
                if (
                    cliOAuthQuota &&
                    cliOAuthQuota.routingGeneration === routingSettings.generation &&
                    sameSelection(activeSelection, grokQuotaSource.getActiveSelection())
                ) {
                    this.failedCliOAuthQuota = cliOAuthQuota;
                    this.cacheCliOAuthRequestStatuses(cliOAuthQuota);
                    const previousData = this.lastStatusData?.data;
                    if (previousData) {
                        this.updateStatusBarUI({ ...previousData, cliOAuthQuota });
                    } else if (this.statusBarItem) {
                        this.statusBarItem.tooltip = this.getApiQueryErrorTooltip(
                            result.error || t('Unknown error', '未知错误')
                        );
                    }
                } else if (!sameSelection(activeSelection, grokQuotaSource.getActiveSelection())) {
                    this.onApiKeyChangeDetected();
                }
            } else if (multiAccountBalance) {
                this.onApiKeyChangeDetected();
            }
            return result;
        }
        this.failedCliOAuthQuota = undefined;
        this.cacheRequestStatus(result.data, result.requestBalanceKeyHash, result.queriedAt);
        if (!multiAccountBalance) {
            return result;
        }
        if (!sameSelection(activeSelection, grokQuotaSource.getActiveSelection())) {
            this.onApiKeyChangeDetected();
            return { success: false };
        }
        const cliOAuthQuota = await collectCliOAuthQuotaStatus(grokQuotaSource, grokQuotaQuery, {
            credentialName: activeSelection.name,
            result
        });
        if (!sameSelection(activeSelection, grokQuotaSource.getActiveSelection())) {
            this.onApiKeyChangeDetected();
            return { success: false };
        }
        if (!cliOAuthQuota || cliOAuthQuota.routingGeneration !== routingSettings.generation) {
            return result;
        }
        this.cacheCliOAuthRequestStatuses(cliOAuthQuota);
        return { ...result, data: { ...result.data, cliOAuthQuota } };
    }

    protected override onStatusUpdatedFromEvent(data: GrokStatusBarData, hash?: string, timestamp?: number): void {
        this.cacheRequestStatus(data, hash, timestamp);
    }

    protected override onStatusRestoredFromCache(data: GrokStatusBarData, hash?: string, timestamp?: number): void {
        this.cacheRequestStatus(data, hash, timestamp);
    }

    private cacheRequestStatus(data: GrokStatusBarData, hash?: string, timestamp?: number): void {
        this.failedCliOAuthQuota = undefined;
        if (!hash || timestamp === undefined) {
            return;
        }
        const quotaData = { ...data };
        delete quotaData.cliOAuthQuota;
        cacheRequestBalanceByKeyHash('grok', hash, [], timestamp, {
            provider: 'grok',
            data: quotaData
        });
        if (data.cliOAuthQuota) {
            this.cacheCliOAuthRequestStatuses(data.cliOAuthQuota);
        }
    }

    private cacheCliOAuthRequestStatuses(status: CliOAuthQuotaStatus<GrokStatusData>): void {
        for (const entry of status.entries) {
            if (entry.status === 'success' && entry.data && entry.requestBalanceKeyHash) {
                cacheRequestBalanceByKeyHash('grok', entry.requestBalanceKeyHash, [], entry.timestamp, {
                    provider: 'grok',
                    data: entry.data
                });
            }
        }
    }

    protected override onCachePolled(): void {
        const data = this.lastStatusData?.data;
        if (!data) {
            return;
        }
        const quotaIsCurrent = isCliOAuthQuotaStatusCurrent(data.cliOAuthQuota, grokQuotaSource);
        if (data.cliOAuthQuota && !quotaIsCurrent) {
            this.updateStatusBarUI(data);
        }
        if (isCliOAuthQuotaEnabled(grokQuotaSource) && !quotaIsCurrent && !this.isLoading) {
            this.delayedUpdate(0);
        }
    }

    private getCurrentCliOAuthQuota(
        dataQuota: CliOAuthQuotaStatus<GrokStatusData> | undefined
    ): CliOAuthQuotaStatus<GrokStatusData> | undefined {
        return isCliOAuthQuotaStatusCurrent(this.failedCliOAuthQuota, grokQuotaSource) ?
                this.failedCliOAuthQuota
            :   dataQuota;
    }

    protected async shouldShowStatusBar(): Promise<boolean> {
        const credentials = await CliAuthFactory.loadCredentials('grok');
        return typeof credentials?.access_token === 'string' && credentials.access_token.length > 0;
    }
}

function sameSelection(
    left: { name: string | undefined; generation: number },
    right: { name: string | undefined; generation: number }
): boolean {
    return left.name === right.name && left.generation === right.generation;
}
