/*---------------------------------------------------------------------------------------------
 *  Grok 用量查询状态栏项
 *  使用 Grok CLI OAuth 登录态显示 SuperGrok/Grok 订阅剩余额度
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { ConfigManager } from '../utils/config/configManager';
import { Logger } from '../utils/runtime/logger';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { GrokBillingParseResult, GrokUsageLimit, parseGrokBillingUsage, resolveGrokBillingBaseUrl } from './grokUsage';

interface GrokCredentials {
    access_token: string;
    user_id?: string;
}

export interface GrokStatusData {
    usage: GrokUsageLimit;
    lastUpdated: string;
}

type BillingRequestResult = { kind: 'parsed'; result: GrokBillingParseResult } | { kind: 'error'; error: string };

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
            icon: '𝕏'
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
        const resetTime = data.usage.resetAt ? this.formatDateTime(new Date(data.usage.resetAt)) : '—';

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
        try {
            const credentials = (await CliAuthFactory.ensureAuthenticated('grok')) as GrokCredentials | null;
            if (!credentials?.access_token) {
                return {
                    success: false,
                    error: t(
                        'Grok CLI authentication is invalid. Sign in to Grok CLI first.',
                        'Grok CLI 认证无效，请先完成 Grok CLI 登录'
                    )
                };
            }

            StatusLogger.debug(`[${this.config.logPrefix}] Starting Grok usage query...`);
            const creditsResult = await this.requestBillingUsage(credentials, '?format=credits', 'credits');
            if (creditsResult.kind === 'error') {
                return { success: false, error: creditsResult.error };
            }

            let parsedResult = creditsResult.result;
            const creditsSubscriptionTier =
                parsedResult.kind === 'unavailable' ? parsedResult.subscriptionTier : undefined;
            if (parsedResult.kind === 'unavailable') {
                const monthlyResult = await this.requestBillingUsage(credentials, '', 'billing');
                if (monthlyResult.kind === 'error') {
                    return { success: false, error: monthlyResult.error };
                }
                parsedResult = monthlyResult.result;
            }

            if (parsedResult.kind === 'invalid') {
                return {
                    success: false,
                    error: t('Invalid Grok usage response: {0}', 'Grok 用量响应无效: {0}', parsedResult.error)
                };
            }
            if (parsedResult.kind === 'unavailable') {
                return {
                    success: false,
                    error: t(
                        'No Grok subscription quota was returned for this account.',
                        '当前 Grok 账户未返回订阅额度'
                    )
                };
            }

            const usage =
                !parsedResult.usage.subscriptionTier && creditsSubscriptionTier ?
                    { ...parsedResult.usage, subscriptionTier: creditsSubscriptionTier }
                :   parsedResult.usage;
            return {
                success: true,
                data: {
                    usage,
                    lastUpdated: new Date().toLocaleString(
                        vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
                    )
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`Grok usage query failed: ${errorMessage}`);
            return {
                success: false,
                error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
            };
        }
    }

    protected async shouldShowStatusBar(): Promise<boolean> {
        const credentials = await CliAuthFactory.loadCredentials('grok');
        return typeof credentials?.access_token === 'string' && credentials.access_token.length > 0;
    }

    private async requestBillingUsage(
        credentials: GrokCredentials,
        query: string,
        source: 'credits' | 'billing'
    ): Promise<BillingRequestResult> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${credentials.access_token}`,
            'X-XAI-Token-Auth': 'xai-grok-cli',
            Accept: 'application/json'
        };
        if (credentials.user_id) {
            headers['x-userid'] = credentials.user_id;
        }

        try {
            const baseUrl = resolveGrokBillingBaseUrl(process.env);
            const response = await ConfigManager.fetchWithProxy(
                `${baseUrl}/billing${query}`,
                {
                    method: 'GET',
                    headers,
                    signal: controller.signal
                },
                {
                    providerKey: 'grok'
                }
            );
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Usage query response status: ${response.status} ${response.statusText}`
            );

            if (!response.ok) {
                const authorizationMessage =
                    response.status === 401 || response.status === 403 ?
                        t('Grok CLI authorization was rejected. Sign in again.', 'Grok CLI 授权被拒绝，请重新登录')
                    :   t('Grok usage query failed with HTTP {0}.', 'Grok 用量查询失败，HTTP {0}', response.status);
                return { kind: 'error', error: authorizationMessage };
            }

            let payload: unknown;
            try {
                payload = JSON.parse(responseText);
            } catch {
                return {
                    kind: 'error',
                    error: t('Grok usage response is not valid JSON.', 'Grok 用量响应不是有效 JSON')
                };
            }

            return { kind: 'parsed', result: parseGrokBillingUsage(payload, source) };
        } finally {
            clearTimeout(timeout);
        }
    }

    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${minutes}`;
    }
}
