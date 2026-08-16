/*---------------------------------------------------------------------------------------------
 *  Grok 用量查询状态栏项
 *  使用 Grok CLI OAuth 登录态显示 SuperGrok/Grok 订阅剩余额度
 *  查询逻辑已下沉到 ../quota/grokQuota，本文件只保留 UI 渲染。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { t } from '../utils/runtime/l10n';
import { GrokStatusData, queryGrokUsage } from '../quota/grokQuota';
import { formatDateTimeSlash } from '../quota/format';

export type { GrokStatusData } from '../quota/grokQuota';

export class GrokStatusBar extends BaseStatusBarItem<GrokStatusData> {
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

    protected getDisplayText(data: GrokStatusData): string {
        return `${this.config.icon} ${data.usage.remainingPercent.toFixed(0)}%`;
    }

    protected generateTooltip(data: GrokStatusData): vscode.MarkdownString {
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
        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    protected shouldHighlightWarning(data: GrokStatusData): boolean {
        return data.usage.usedPercent >= this.HIGH_USAGE_THRESHOLD;
    }

    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
        }
        return super.shouldRefresh();
    }

    protected async performApiQuery(): Promise<{ success: boolean; data?: GrokStatusData; error?: string }> {
        const lastUpdated = new Date().toLocaleString(
            vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
        );
        return queryGrokUsage(lastUpdated);
    }

    protected async shouldShowStatusBar(): Promise<boolean> {
        const credentials = await CliAuthFactory.loadCredentials('grok');
        return typeof credentials?.access_token === 'string' && credentials.access_token.length > 0;
    }
}
