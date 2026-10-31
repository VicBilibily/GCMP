/*---------------------------------------------------------------------------------------------
 *  ChatGPT 用量查询状态栏项
 *  显示 ChatGPT (Codex) 账户的使用量和限额信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import {
    ChatGPTStatusData,
    getResetDate,
    getRemainingPercent,
    getWindowType,
    hasValidRateLimitWindow,
    queryCodexUsage,
    buildCodexUsageSummary
} from '../quota/codexQuota';
import { formatChatGPTPlanType } from '../quota/parsers/chatgptPlanType';
import { formatDateTimeSlash } from '../quota/format';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';
import { OAuthCredentialStore } from '../cli/auth/oauthCredentialStore';
import { cacheRequestBalanceByKeyHash } from '../quota/requestBalance';
import {
    collectCliOAuthQuotaStatus,
    isCliOAuthQuotaEnabled,
    isCliOAuthQuotaStatusCurrent,
    renderCliOAuthQuotaSection,
    type CliOAuthQuotaSource,
    type CliOAuthQuotaStatus
} from './cliOAuthQuotaTracker';

export type { ChatGPTStatusData } from '../quota/codexQuota';

interface ChatGPTStatusBarData extends ChatGPTStatusData {
    cliOAuthQuota?: CliOAuthQuotaStatus<ChatGPTStatusData>;
}

const codexQuotaQuery = {
    query: (credentialName: string) => queryCodexUsage(credentialName),
    summary: buildCodexUsageSummary
};

const codexQuotaSource: CliOAuthQuotaSource = {
    getRoutingSettings: () => OAuthCredentialStore.getRoutingSettings('codex'),
    listCredentials: () => CliAuthFactory.listOAuthCredentials('codex'),
    getActiveSelection: () => CliAuthFactory.getActiveCredentialSelection('codex')
};

/**
 * ChatGPT 用量查询状态栏项
 * 显示 ChatGPT 账户的用量信息，包括：
 * - 已使用百分比（状态栏显示）
 * - 计划类型（tooltip显示）
 * - 剩余时间（tooltip显示）
 * - 每5分钟自动刷新一次
 */
export class ChatGPTStatusBar extends BaseStatusBarItem<ChatGPTStatusBarData> {
    private failedCliOAuthQuota: CliOAuthQuotaStatus<ChatGPTStatusData> | undefined;

    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.chatgpt',
            name: 'GCMP: ChatGPT Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 15,
            refreshCommand: 'gcmp.chatgpt.refreshUsage',
            apiKeyProvider: 'codex',
            cacheKeyPrefix: 'chatgpt',
            logPrefix: 'ChatGPT Status Bar',
            icon: '$(gcmp-openai)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     * 格式: "$(icon) 85% (92%)" - 括号内是5小时额度，外面是主额度窗口
     * 主额度窗口支持 每日/每周/每月/每年
     */
    protected getDisplayText(data: ChatGPTStatusBarData): string {
        return `${this.config.icon} ${buildCodexUsageSummary(data)}`;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: ChatGPTStatusBarData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow =
            hasValidRateLimitWindow(data.rateLimit.secondary_window) ? data.rateLimit.secondary_window : undefined;

        const primaryType = getWindowType(
            hasValidRateLimitWindow(primaryWindow) ? primaryWindow.limit_window_seconds : 0
        );
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds, true) : null;

        const planTypeDisplay = formatChatGPTPlanType(data.planType);

        md.appendMarkdown(`#### ChatGPT ${planTypeDisplay}\n\n`);
        md.appendMarkdown(
            `| ${t('Window', '限频类型')} | ${t('Remaining', '剩余量')} | ${t('Countdown', '倒计时')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :----: | ----: | ----: | :------: |\n');

        // 主窗口
        const primaryRemaining = getRemainingPercent(primaryWindow);
        const primaryResetDate = getResetDate(primaryWindow);
        const primaryResetTimeStr = primaryResetDate ? formatDateTimeSlash(primaryResetDate) : '—';
        const primaryCountdown = this.formatCountdown(primaryResetDate?.toISOString());
        md.appendMarkdown(
            `| **${primaryType.label}** | **${primaryRemaining.toFixed(0)}%** | ${primaryCountdown} | ${primaryResetTimeStr} |\n`
        );

        // 备用窗口（如果是有效类型）
        if (secondaryWindow && secondaryType) {
            const secondaryRemaining = getRemainingPercent(secondaryWindow);
            const secondaryResetDate = getResetDate(secondaryWindow);
            const secondaryResetTimeStr = secondaryResetDate ? formatDateTimeSlash(secondaryResetDate) : '—';
            const secondaryCountdown = this.formatCountdown(secondaryResetDate?.toISOString());
            md.appendMarkdown(
                `| **${secondaryType.label}** | **${secondaryRemaining.toFixed(0)}%** | ${secondaryCountdown} | ${secondaryResetTimeStr} |\n`
            );
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        const quotaSection = renderCliOAuthQuotaSection(
            this.getCurrentCliOAuthQuota(data.cliOAuthQuota),
            codexQuotaSource,
            codexQuotaQuery,
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
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);

        return md;
    }

    protected override getApiQueryErrorTooltip(error: string): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(t('Failed to fetch: {0}', '获取失败: {0}', error));
        const quotaSection = renderCliOAuthQuotaSection(
            this.getCurrentCliOAuthQuota(this.failedCliOAuthQuota),
            codexQuotaSource,
            codexQuotaQuery,
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

    /**
     * 执行 API 查询
     * 实现 ChatGPT 用量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ChatGPTStatusBarData; error?: string }> {
        StatusLogger.debug(`[${this.config.logPrefix}] Delegating ChatGPT usage query to shared module`);
        const routingSettings = codexQuotaSource.getRoutingSettings();
        const activeSelection = codexQuotaSource.getActiveSelection();
        const multiAccountBalance = isCliOAuthQuotaEnabled(codexQuotaSource);
        const result = await queryCodexUsage(multiAccountBalance ? activeSelection.name : undefined);
        if (!result.success || !result.data) {
            this.failedCliOAuthQuota = undefined;
            if (multiAccountBalance && sameSelection(activeSelection, codexQuotaSource.getActiveSelection())) {
                const cliOAuthQuota = await collectCliOAuthQuotaStatus(codexQuotaSource, codexQuotaQuery, {
                    credentialName: activeSelection.name,
                    result
                });
                if (
                    cliOAuthQuota &&
                    cliOAuthQuota.routingGeneration === routingSettings.generation &&
                    sameSelection(activeSelection, codexQuotaSource.getActiveSelection())
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
                } else if (!sameSelection(activeSelection, codexQuotaSource.getActiveSelection())) {
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
        if (!sameSelection(activeSelection, codexQuotaSource.getActiveSelection())) {
            this.onApiKeyChangeDetected();
            return { success: false };
        }
        const cliOAuthQuota = await collectCliOAuthQuotaStatus(codexQuotaSource, codexQuotaQuery, {
            credentialName: activeSelection.name,
            result
        });
        if (!sameSelection(activeSelection, codexQuotaSource.getActiveSelection())) {
            this.onApiKeyChangeDetected();
            return { success: false };
        }
        if (!cliOAuthQuota || cliOAuthQuota.routingGeneration !== routingSettings.generation) {
            return result;
        }
        this.cacheCliOAuthRequestStatuses(cliOAuthQuota);
        return { ...result, data: { ...result.data, cliOAuthQuota } };
    }

    protected override onStatusUpdatedFromEvent(data: ChatGPTStatusBarData, hash?: string, timestamp?: number): void {
        this.cacheRequestStatus(data, hash, timestamp);
    }

    protected override onStatusRestoredFromCache(data: ChatGPTStatusBarData, hash?: string, timestamp?: number): void {
        this.cacheRequestStatus(data, hash, timestamp);
    }

    private cacheRequestStatus(data: ChatGPTStatusBarData, hash?: string, timestamp?: number): void {
        this.failedCliOAuthQuota = undefined;
        if (!hash || timestamp === undefined) {
            return;
        }
        const quotaData = { ...data };
        delete quotaData.cliOAuthQuota;
        cacheRequestBalanceByKeyHash('codex', hash, [], timestamp, {
            provider: 'codex',
            data: quotaData
        });
        if (data.cliOAuthQuota) {
            this.cacheCliOAuthRequestStatuses(data.cliOAuthQuota);
        }
    }

    private cacheCliOAuthRequestStatuses(status: CliOAuthQuotaStatus<ChatGPTStatusData>): void {
        for (const entry of status.entries) {
            if (entry.status === 'success' && entry.data && entry.requestBalanceKeyHash) {
                cacheRequestBalanceByKeyHash('codex', entry.requestBalanceKeyHash, [], entry.timestamp, {
                    provider: 'codex',
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
        const quotaIsCurrent = isCliOAuthQuotaStatusCurrent(data.cliOAuthQuota, codexQuotaSource);
        if (data.cliOAuthQuota && !quotaIsCurrent) {
            this.updateStatusBarUI(data);
        }
        if (isCliOAuthQuotaEnabled(codexQuotaSource) && !quotaIsCurrent && !this.isLoading) {
            this.delayedUpdate(0);
        }
    }

    private getCurrentCliOAuthQuota(
        dataQuota: CliOAuthQuotaStatus<ChatGPTStatusData> | undefined
    ): CliOAuthQuotaStatus<ChatGPTStatusData> | undefined {
        return isCliOAuthQuotaStatusCurrent(this.failedCliOAuthQuota, codexQuotaSource) ?
                this.failedCliOAuthQuota
            :   dataQuota;
    }

    /**
     * 检查是否需要高亮警告
     * 主额度窗口（5h 之外的长期窗口）使用率超过阈值时高亮显示
     */
    protected shouldHighlightWarning(data: ChatGPTStatusBarData): boolean {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow =
            hasValidRateLimitWindow(data.rateLimit.secondary_window) ? data.rateLimit.secondary_window : undefined;

        // 检查主额度窗口（每日/每周/每月/每年）的使用率
        const primaryType = getWindowType(
            hasValidRateLimitWindow(primaryWindow) ? primaryWindow.limit_window_seconds : 0
        );
        if (primaryType.type !== 'hourly' && hasValidRateLimitWindow(primaryWindow)) {
            return primaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
        }

        // 主窗口是 5h 短窗时，检查备用长期窗口
        if (secondaryWindow) {
            const secondaryType = getWindowType(secondaryWindow.limit_window_seconds, true);
            if (secondaryType.type !== 'hourly') {
                return secondaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
            }
        }

        return false;
    }

    /**
     * 检查是否需要刷新缓存
     * 每5分钟固定刷新一次
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return true;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const REFRESH_INTERVAL = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        // 检查是否超过5分钟刷新间隔
        if (dataAge > REFRESH_INTERVAL) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟刷新间隔，触发API刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 检查是否应该显示状态栏
     * 通过检查 Codex CLI 认证是否存在
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        try {
            const codexAuth = CliAuthFactory.getInstance('codex') as CodexCliAuth | null;
            if (!codexAuth) {
                return false;
            }
            const credentials = await codexAuth.loadCredentials();
            return credentials !== null && credentials.access_token !== undefined;
        } catch {
            return false;
        }
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: ChatGPTStatusBarData; timestamp: number } | null {
        return this.lastStatusData;
    }
}

function sameSelection(
    left: { name: string | undefined; generation: number },
    right: { name: string | undefined; generation: number }
): boolean {
    return left.name === right.name && left.generation === right.generation;
}
