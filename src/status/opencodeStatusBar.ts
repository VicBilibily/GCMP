import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { Logger } from '../utils/runtime/logger';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { ConfigManager } from '../utils/config/configManager';
import { t } from '../utils/runtime/l10n';
import {
    formatOpenCodeStatusBarText,
    OpenCodeUsageData,
    OpenCodeUsageWindow,
    parseOpenCodeUsage,
    resolveOpenCodeUsageUrl
} from './opencodeUsage';

interface OpenCodeStatusData extends OpenCodeUsageData {
    lastUpdated: string;
}

export class OpenCodeStatusBar extends ProviderStatusBarItem<OpenCodeStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.opencode',
            name: 'GCMP: OpenCode Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 28,
            refreshCommand: 'gcmp.opencode.refreshUsage',
            apiKeyProvider: 'opencode',
            cacheKeyPrefix: 'opencode',
            logPrefix: 'OpenCode Status Bar',
            icon: '$(gcmp-opencode)'
        };
        super(config);
    }

    protected getDisplayText(data: OpenCodeStatusData): string {
        return formatOpenCodeStatusBarText(this.config.icon, data);
    }

    protected generateTooltip(data: OpenCodeStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;
        md.appendMarkdown(`#### ${t('OpenCode Usage', 'OpenCode 使用情况')}\n\n`);
        md.appendMarkdown(
            `| ${t('Window', '限频类型')} | ${t('Remaining', '剩余量')} | ${t('Countdown', '倒计时')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :---: | ---: | :---: | :---: |\n');

        for (const window of data.windows) {
            const label = this.getWindowLabel(window.type);
            const countdown = this.formatCountdown(window.resetAt);
            const resetTime = window.resetAt ? this.formatDateTime(new Date(window.resetAt)) : '—';
            md.appendMarkdown(
                `| **${label}** | ${window.remainingPercent.toFixed(0)}% | ${countdown} | ${resetTime} |\n`
            );
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    protected shouldHighlightWarning(data: OpenCodeStatusData): boolean {
        return data.windows.some(window => window.usedPercent >= this.HIGH_USAGE_THRESHOLD);
    }

    protected async performApiQuery(): Promise<{ success: boolean; data?: OpenCodeStatusData; error?: string }> {
        try {
            const hasApiKey = await ApiKeyManager.hasValidApiKey('opencode');
            if (!hasApiKey) {
                return {
                    success: false,
                    error: t(
                        'OpenCode API key is not configured. Set the API key first.',
                        'OpenCode API 密钥未配置，请先设置 API 密钥'
                    )
                };
            }

            const apiKey = await ApiKeyManager.getApiKey('opencode');
            if (!apiKey) {
                return {
                    success: false,
                    error: t('Unable to get the OpenCode API key.', '无法获取 OpenCode API 密钥')
                };
            }

            StatusLogger.debug(`[${this.config.logPrefix}] Starting OpenCode usage query...`);

            const response = await ConfigManager.fetchWithProxy(
                resolveOpenCodeUsageUrl(process.env),
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        Accept: 'application/json'
                    }
                },
                {
                    providerKey: 'opencode'
                }
            );
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Usage query response status: ${response.status} ${response.statusText}`
            );

            let payload: unknown;
            try {
                payload = JSON.parse(responseText);
            } catch {
                return {
                    success: false,
                    error: t('OpenCode usage response is not valid JSON.', 'OpenCode 用量响应不是有效 JSON')
                };
            }

            if (!response.ok) {
                return {
                    success: false,
                    error: t(
                        'OpenCode usage query failed with HTTP {0}.',
                        'OpenCode 用量查询失败，HTTP {0}',
                        response.status
                    )
                };
            }

            const parsed = parseOpenCodeUsage(payload);
            if (parsed.kind === 'invalid') {
                return {
                    success: false,
                    error: t('Invalid OpenCode usage response: {0}', 'OpenCode 用量响应无效: {0}', parsed.error)
                };
            }

            return {
                success: true,
                data: {
                    windows: parsed.usage.windows,
                    lastUpdated: new Date().toLocaleString(
                        vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
                    )
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`OpenCode usage query failed: ${errorMessage}`);
            return {
                success: false,
                error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
            };
        }
    }

    private getWindowLabel(type: OpenCodeUsageWindow['type']): string {
        switch (type) {
            case 'rolling':
                return t('5 Hours', '300 分钟');
            case 'weekly':
                return t('Weekly quota', '每周额度');
            case 'monthly':
                return t('Monthly quota', '每月额度');
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
