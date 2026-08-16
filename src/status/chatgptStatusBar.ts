/*---------------------------------------------------------------------------------------------
 *  ChatGPT 用量查询状态栏项
 *  显示 ChatGPT (Codex) 账户的使用量和限额信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { ChatGPTStatusData, getWindowType, queryCodexUsage, buildCodexUsageSummary } from '../quota/codexQuota';
import { formatDateTimeSlash } from '../quota/format';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';
import { CodexCliAuth } from '../cli/auth/codexCliAuth';

export type { ChatGPTStatusData } from '../quota/codexQuota';

/**
 * ChatGPT 用量查询状态栏项
 * 显示 ChatGPT 账户的用量信息，包括：
 * - 已使用百分比（状态栏显示）
 * - 计划类型（tooltip显示）
 * - 剩余时间（tooltip显示）
 * - 每5分钟自动刷新一次
 */
export class ChatGPTStatusBar extends BaseStatusBarItem<ChatGPTStatusData> {
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
     * 格式: "$(icon) 85% (92%)" - 括号内是5小时额度，外面是每周额度
     * 只显示 300分钟 和 每周 两种窗口
     */
    protected getDisplayText(data: ChatGPTStatusData): string {
        return `${this.config.icon} ${buildCodexUsageSummary(data)}`;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: ChatGPTStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        const secondaryType = secondaryWindow ? getWindowType(secondaryWindow.limit_window_seconds) : null;

        // 计划类型映射
        const planTypeMap: Record<string, string> = {
            free: 'Free',
            plus: 'Plus',
            pro: 'Pro',
            team: 'Team',
            enterprise: 'Enterprise'
        };
        const planTypeDisplay = planTypeMap[data.planType] || data.planType;

        md.appendMarkdown(`#### ChatGPT ${planTypeDisplay}\n\n`);
        md.appendMarkdown(
            `| ${t('Window', '限频类型')} | ${t('Remaining', '剩余量')} | ${t('Countdown', '倒计时')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :----: | ----: | ----: | :------: |\n');

        // 主窗口
        const primaryRemaining = Math.max(0, 100 - primaryWindow.used_percent);
        const primaryResetDate = new Date(primaryWindow.reset_at * 1000);
        const primaryResetTimeStr = formatDateTimeSlash(primaryResetDate);
        const primaryCountdown = this.formatCountdown(new Date(primaryWindow.reset_at * 1000).toISOString());
        md.appendMarkdown(
            `| **${primaryType.label}** | **${primaryRemaining.toFixed(0)}%** | ${primaryCountdown} | ${primaryResetTimeStr} |\n`
        );

        // 备用窗口（如果是有效类型）
        if (secondaryWindow && secondaryType) {
            const secondaryRemaining = Math.max(0, 100 - secondaryWindow.used_percent);
            const secondaryResetDate = new Date(secondaryWindow.reset_at * 1000);
            const secondaryResetTimeStr = formatDateTimeSlash(secondaryResetDate);
            const secondaryCountdown = this.formatCountdown(new Date(secondaryWindow.reset_at * 1000).toISOString());
            md.appendMarkdown(
                `| **${secondaryType.label}** | **${secondaryRemaining.toFixed(0)}%** | ${secondaryCountdown} | ${secondaryResetTimeStr} |\n`
            );
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);

        return md;
    }

    /**
     * 执行 API 查询
     * 实现 ChatGPT 用量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ChatGPTStatusData; error?: string }> {
        StatusLogger.debug(`[${this.config.logPrefix}] Delegating ChatGPT usage query to shared module`);
        return queryCodexUsage();
    }

    /**
     * 检查是否需要高亮警告
     * 当每周使用率超过 80% 时高亮显示
     */
    protected shouldHighlightWarning(data: ChatGPTStatusData): boolean {
        const primaryWindow = data.rateLimit.primary_window;
        const secondaryWindow = data.rateLimit.secondary_window;

        // 检查每周额度的使用率
        const primaryType = getWindowType(primaryWindow.limit_window_seconds);
        if (primaryType.type === 'weekly') {
            return primaryWindow.used_percent >= this.HIGH_USAGE_THRESHOLD;
        }

        // 如果主窗口不是每周，检查备用窗口
        if (secondaryWindow) {
            const secondaryType = getWindowType(secondaryWindow.limit_window_seconds);
            if (secondaryType.type === 'weekly') {
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
    getLastStatusData(): { data: ChatGPTStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
