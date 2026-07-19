/*---------------------------------------------------------------------------------------------
 *  ClinePass 用量查询状态栏项
 *  继承 ProviderStatusBarItem，显示 ClinePass 计划用量信息
 *  - 显示每周限额（weekly）/ 月度限额（monthly）/ 5小时限额（five_hour）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { Logger } from '../utils/runtime/logger';
import { ApiKeyManager } from '../utils/config/apiKeyManager';
import { VersionManager } from '../utils/runtime/versionManager';
import { t } from '../utils/runtime/l10n';
import { ConfigManager } from '../utils/config/configManager';

/**
 * ClinePass 单条用量限制
 */
export interface ClinePassLimit {
    /** 限频类型: five_hour / weekly / monthly */
    type: 'five_hour' | 'weekly' | 'monthly';
    /** 已使用百分比 (0-100) */
    percentUsed: number;
    /** 重置时间（ISO 格式，使用时为 0 时不存在） */
    resetsAt?: string;
}

/**
 * ClinePass usage-limits API 响应格式
 */
export interface ClinePassUsageResponse {
    data: {
        limits: ClinePassLimit[];
    };
    success: boolean;
}

/**
 * ClinePass 状态数据
 */
export interface ClinePassStatusData {
    /** 用量限制列表 */
    limits: ClinePassLimit[];
    /** 最后更新时间 */
    lastUpdated: string;
}

/**
 * ClinePass 用量查询状态栏项
 * 显示格式: icon min(周剩余%,月剩余%) (5h剩余%)
 * 5小时无使用时不展示
 */
export class ClinePassStatusBar extends ProviderStatusBarItem<ClinePassStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.clinepass',
            name: 'GCMP: ClinePass Usage',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 16,
            refreshCommand: 'gcmp.clinepass.refreshUsage',
            apiKeyProvider: 'clinepass',
            cacheKeyPrefix: 'clinepass',
            logPrefix: 'ClinePass Status Bar',
            icon: '$(gcmp-cline)'
        };
        super(config);
    }

    /**
     * 获取窗口标签
     */
    private getLimitLabel(type: string): string {
        switch (type) {
            case 'five_hour':
                return t('5 Hours', '300 分钟');
            case 'weekly':
                return t('Weekly limit', '每周限额');
            case 'monthly':
                return t('Monthly limit', '每月限额');
            default:
                return type;
        }
    }

    /**
     * 格式化日期时间为本地字符串
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}-${day} ${hours}:${minutes}`;
    }

    /**
     * 获取显示文本
     * 格式: icon min(周剩余%,月剩余%) (5h剩余%)
     */
    protected getDisplayText(data: ClinePassStatusData): string {
        // API 契约：ClinePass 固定返回 weekly / monthly / five_hour 三种窗口，
        // 当前仅 resetsAt 允许为空，因此这里保留非空断言以简化渲染路径。
        const weekly = data.limits.find(l => l.type === 'weekly')!;
        const monthly = data.limits.find(l => l.type === 'monthly')!;
        const fiveHour = data.limits.find(l => l.type === 'five_hour')!;

        const weeklyRemain = 100 - weekly.percentUsed;
        const monthlyRemain = 100 - monthly.percentUsed;
        const minRemain = Math.min(weeklyRemain, monthlyRemain);

        const fiveHourRemain = 100 - fiveHour.percentUsed;
        const isFiveHourUsed = fiveHour.percentUsed > 0;

        let text = `${this.config.icon} ${minRemain}%`;
        if (isFiveHourUsed) {
            text += ` (${fiveHourRemain}%)`;
        }
        return text;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: ClinePassStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown(`#### ${t('ClinePass Usage', 'ClinePass 使用情况')}\n\n`);

        // 用量限制表
        md.appendMarkdown(
            `| ${t('Window', '限频类型')} | ${t('Remaining', '剩余量')} | ${t('Countdown', '倒计时')} | ${t('Reset Time', '重置时间')} |\n`
        );
        md.appendMarkdown('| :---: | ---: | :---: | :---: |\n');

        for (const limit of data.limits) {
            const label = this.getLimitLabel(limit.type);
            const countdownStr = this.formatCountdown(limit.resetsAt);
            const resetTimeStr = limit.resetsAt ? this.formatDateTime(new Date(limit.resetsAt)) : '—';
            md.appendMarkdown(`| **${label}** | ${100 - limit.percentUsed}% | ${countdownStr} | ${resetTimeStr} |\n`);
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown(`**${t('Last updated', '最后更新')}** ${data.lastUpdated}\n`);
        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown(`${t('Click the status bar to refresh manually', '点击状态栏可手动刷新')}\n`);
        return md;
    }

    /**
     * 检查是否需要高亮警告（任一项超出阈值）
     */
    protected shouldHighlightWarning(data: ClinePassStatusData): boolean {
        return data.limits.some(l => l.percentUsed >= this.HIGH_USAGE_THRESHOLD);
    }

    /**
     * 检查是否需要刷新缓存
     * 若缓存生成时间早于最近重置时间且当前已过重置点，则刷新；兜底 5 分钟
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000;

        // 找最近的重置时间
        const resetTimestamps = this.lastStatusData.data.limits
            .map(l => (l.resetsAt ? new Date(l.resetsAt).getTime() : 0))
            .filter(t => t > 0);

        if (resetTimestamps.length > 0) {
            const minResetMs = Math.min(...resetTimestamps);
            const cacheBeforeReset = this.lastStatusData.timestamp < minResetMs;
            const nowPastReset = Date.now() >= minResetMs;

            if (cacheBeforeReset && nowPastReset) {
                StatusLogger.debug(`[${this.config.logPrefix}] 缓存生成于重置点之前且当前已过重置时间，触发刷新`);
                return true;
            }
        }

        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过 5 分钟，触发刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 执行 API 查询
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: ClinePassStatusData; error?: string }> {
        const USAGE_QUERY_URL = 'https://api.cline.bot/api/v1/users/me/plan/usage-limits';
        const PROVIDER_KEY = 'clinepass';

        try {
            const hasApiKey = await ApiKeyManager.hasValidApiKey(PROVIDER_KEY);
            if (!hasApiKey) {
                return {
                    success: false,
                    error: t(
                        'ClinePass API key is not configured. Set the ClinePass API key first.',
                        'ClinePass API 密钥未配置，请先设置 ClinePass API 密钥'
                    )
                };
            }

            const apiKey = await ApiKeyManager.getApiKey(PROVIDER_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: t('Unable to get the ClinePass API key.', '无法获取 ClinePass API 密钥')
                };
            }

            Logger.debug('Triggering ClinePass usage query');
            StatusLogger.debug(`[${this.config.logPrefix}] Starting ClinePass usage query...`);

            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('ClinePass')
                }
            };

            const response = await ConfigManager.fetchWithProxy(USAGE_QUERY_URL, requestOptions, {
                providerKey: 'clinepass'
            });
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] Usage query response status: ${response.status} ${response.statusText}`
            );

            let parsedResponse: ClinePassUsageResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`Failed to parse response JSON: ${parseError}`);
                return {
                    success: false,
                    error: t('Invalid response format: {0}', '响应格式错误: {0}', responseText.substring(0, 200))
                };
            }

            if (!response.ok) {
                let errorMessage = `HTTP ${response.status}`;
                try {
                    const errorData = JSON.parse(responseText);
                    if (errorData.error) {
                        errorMessage = errorData.error.message || errorData.error;
                    }
                } catch {
                    // ignore parse failure
                }
                Logger.error(`Usage query failed: ${errorMessage}`);
                return {
                    success: false,
                    error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
                };
            }

            if (!parsedResponse.success) {
                Logger.error('API returned success: false');
                return {
                    success: false,
                    error: t('API query failed.', 'API 查询失败')
                };
            }

            // API 契约要求三种 limit 始终存在；此处仅校验是否返回了非空 limits，
            // 不重复逐项校验 weekly/monthly/five_hour，避免把契约层问题扩散到渲染逻辑。
            if (!parsedResponse.data?.limits || parsedResponse.data.limits.length === 0) {
                return {
                    success: false,
                    error: t('No usage data was returned.', '未获取到用量数据')
                };
            }

            StatusLogger.debug(`[${this.config.logPrefix}] Usage query succeeded`);

            return {
                success: true,
                data: {
                    limits: parsedResponse.data.limits,
                    lastUpdated: new Date().toLocaleString()
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            Logger.error(`Unexpected error during ClinePass usage query: ${errorMessage}`);
            return {
                success: false,
                error: t('Query failed: {0}', '查询失败: {0}', errorMessage)
            };
        }
    }
}
