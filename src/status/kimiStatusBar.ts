/*---------------------------------------------------------------------------------------------
 *  Kimi For Coding 状态栏项
 *  继承 ProviderStatusBarItem，显示 Kimi For Coding 使用量信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderStatusBarItem, StatusBarItemConfig } from './providerStatusBarItem';
import { StatusLogger } from '../utils/statusLogger';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';

/**
 * Kimi 使用量窗口数据
 */
export interface KimiUsageWindow {
    /** 持续时间 */
    duration: number;
    /** 时间单位 */
    timeUnit: string;
    /** 详细信息 */
    detail: {
        /** 限制百分比 */
        limit: number;
        /** 已使用百分比 */
        used: number;
        /** 剩余百分比 */
        remaining: number;
        /** 重置时间 */
        resetTime?: string;
    };
}

/**
 * Kimi 使用量摘要数据
 */
export interface KimiUsageSummary {
    /** 总百分比（100%） */
    limit: number;
    /** 已使用百分比 */
    used: number;
    /** 剩余百分比 */
    remaining: number;
    /** 重置时间 */
    resetTime: string;
}

/**
 * Kimi 状态数据
 */
export interface KimiStatusData {
    /** 总体用量信息 */
    summary: KimiUsageSummary;
    /** 详细使用限制 */
    windows: KimiUsageWindow[];
}

/**
 * Kimi For Coding 状态栏项
 * 显示 Kimi For Coding 的使用量信息，包括：
 * - 剩余/总量
 * - 已使用百分比
 * - 支持多时间窗口展示
 */
export class KimiStatusBar extends ProviderStatusBarItem<KimiStatusData> {
    constructor() {
        const config: StatusBarItemConfig = {
            id: 'gcmp.statusBar.kimi',
            name: 'GCMP: Kimi For Coding',
            alignment: vscode.StatusBarAlignment.Right,
            priority: 90,
            refreshCommand: 'gcmp.kimi.refreshUsage',
            apiKeyProvider: 'kimi',
            cacheKeyPrefix: 'kimi',
            logPrefix: 'Kimi状态栏',
            icon: '$(gcmp-kimi)'
        };
        super(config);
    }

    /**
     * 获取显示文本
     */
    protected getDisplayText(data: KimiStatusData): string {
        const remaining = data.summary.remaining;
        let displayText = `${this.config.icon} ${remaining}%`;

        // 如果有窗口数据，添加每个窗口的剩余
        if (data.windows.length > 0) {
            const windowTexts = data.windows.map(window => {
                return `${window.detail.remaining}%`;
            });
            displayText += ` (${windowTexts.join(',')})`;
        }

        return displayText;
    }

    /**
     * 生成 Tooltip 内容
     */
    protected generateTooltip(data: KimiStatusData): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const { summary } = data;
        md.appendMarkdown('#### Kimi For Coding 使用情况\n\n');
        md.appendMarkdown('| 频限类型 | 余量 | 重置时间 |\n');
        md.appendMarkdown('| :----: | ----: | :----: |\n');

        // 添加每周额度
        const resetTime = new Date(summary.resetTime);
        const resetTimeStr = this.formatDateTime(resetTime);
        md.appendMarkdown(`| **每周额度** | ${summary.remaining}% | ${resetTimeStr} |\n`);

        // 添加窗口限制
        if (data.windows.length > 0) {
            for (const window of data.windows) {
                const timeUnit = this.translateTimeUnit(window.timeUnit);
                const { detail, duration } = window;
                const windowResetTime = detail.resetTime ? new Date(detail.resetTime) : undefined;
                const windowResetTimeStr = windowResetTime ? this.formatDateTime(windowResetTime) : 'N/A';
                md.appendMarkdown(`| **${duration} ${timeUnit}** | ${detail.remaining}% | ${windowResetTimeStr} |\n`);
            }
        }

        md.appendMarkdown('\n');
        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     * 直接实现 Kimi For Coding 余量查询逻辑
     */
    protected async performApiQuery(): Promise<{ success: boolean; data?: KimiStatusData; error?: string }> {
        const REMAIN_QUERY_URL = 'https://api.kimi.com/coding/v1/usages';
        const KIMI_KEY = 'kimi';

        try {
            // 检查 Kimi For Coding 密钥是否存在
            const hasCodingKey = await ApiKeyManager.hasValidApiKey(KIMI_KEY);
            if (!hasCodingKey) {
                return {
                    success: false,
                    error: 'Kimi For Coding 专用密钥未配置，请先设置 Kimi For Coding API 密钥'
                };
            }

            // 获取 Kimi For Coding 密钥
            const apiKey = await ApiKeyManager.getApiKey(KIMI_KEY);
            if (!apiKey) {
                return {
                    success: false,
                    error: '无法获取 Kimi For Coding 专用密钥'
                };
            }

            Logger.debug('触发查询 Kimi For Coding 余量');
            StatusLogger.debug(`[${this.config.logPrefix}] 开始查询 Kimi For Coding 余量...`);

            // 构建请求
            const requestOptions: RequestInit = {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': VersionManager.getUserAgent('Kimi'),
                    Authorization: `Bearer ${apiKey}`
                }
            };

            // 发送请求
            const response = await fetch(REMAIN_QUERY_URL, requestOptions);
            const responseText = await response.text();

            StatusLogger.debug(
                `[${this.config.logPrefix}] 余量查询响应状态: ${response.status} ${response.statusText}`
            );

            // 解析响应
            interface KimiBillingResponse {
                user?: {
                    userId: string;
                    region: string;
                    membership: {
                        level: string;
                    };
                };
                usage?: {
                    limit: number;
                    used?: number;
                    remaining?: number;
                    resetTime: string;
                };
                limits?: {
                    window: {
                        duration: number;
                        timeUnit: string;
                    };
                    detail: {
                        limit: number;
                        used?: number;
                        remaining?: number;
                        resetTime?: string;
                    };
                }[];
                code?: string;
                details?: {
                    type: string;
                    value: string;
                    debug?: {
                        reason: string;
                        localizedMessage?: {
                            locale: string;
                            message: string;
                        };
                    };
                }[];
            }

            let parsedResponse: KimiBillingResponse;
            try {
                parsedResponse = JSON.parse(responseText);
            } catch (parseError) {
                Logger.error(`解析响应 JSON 失败: ${parseError}`);
                return {
                    success: false,
                    error: `响应格式错误: ${responseText.substring(0, 200)}`
                };
            }

            // 检查响应状态
            if (!response.ok) {
                const errorMessage = `HTTP ${response.status}`;
                Logger.error(`余量查询失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `查询失败: ${errorMessage}`
                };
            }

            // 检查具体的认证错误
            if (parsedResponse.code === 'unauthenticated') {
                const errorMessage = 'API密钥无效或已过期，请检查您的Kimi API密钥';
                Logger.error(`认证失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `认证失败: ${errorMessage}`
                };
            }

            // 检查其他 API 错误
            if (parsedResponse.code !== undefined && parsedResponse.code !== 'unauthenticated') {
                const errorMessage = `API错误: ${parsedResponse.code}`;
                Logger.error(`余量查询API失败: ${errorMessage}`);
                return {
                    success: false,
                    error: `API查询失败: ${errorMessage}`
                };
            }

            // 解析成功响应
            StatusLogger.debug(`[${this.config.logPrefix}] 余量查询成功`);

            // 计算格式化信息
            if (!parsedResponse.usage) {
                return {
                    success: false,
                    error: '未获取到用量数据'
                };
            }

            const usage = parsedResponse.usage;

            // 解析百分比数值
            const used = typeof usage.used === 'string' ? parseInt(usage.used, 10) : (usage.used ?? 0);
            const limit = typeof usage.limit === 'string' ? parseInt(usage.limit, 10) : usage.limit;
            const remaining =
                typeof usage.remaining === 'string' ? parseInt(usage.remaining, 10) : (usage.remaining ?? 0);

            // 总体用量信息（limit、used、remaining 都是百分比）
            const summary: KimiUsageSummary = {
                limit,
                used,
                remaining,
                resetTime: usage.resetTime
            };

            // 详细使用限制
            const windows: KimiUsageWindow[] = [];
            if (parsedResponse.limits && parsedResponse.limits.length > 0) {
                for (const limitItem of parsedResponse.limits) {
                    const detail = limitItem.detail;
                    const detailUsed = typeof detail.used === 'string' ? parseInt(detail.used, 10) : (detail.used ?? 0);
                    const detailLimit = typeof detail.limit === 'string' ? parseInt(detail.limit, 10) : detail.limit;
                    const detailRemaining =
                        typeof detail.remaining === 'string' ? parseInt(detail.remaining, 10) : (detail.remaining ?? 0);

                    windows.push({
                        duration: limitItem.window.duration,
                        timeUnit: limitItem.window.timeUnit,
                        detail: {
                            limit: detailLimit,
                            used: detailUsed,
                            remaining: detailRemaining,
                            resetTime: detail.resetTime
                        }
                    });
                }
            }

            return {
                success: true,
                data: {
                    summary,
                    windows
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '未知错误';
            Logger.error(`余量查询异常: ${errorMessage}`);
            return {
                success: false,
                error: `查询异常: ${errorMessage}`
            };
        }
    }

    /**
     * 检查是否需要高亮警告（剩余百分比低于阈值或任意窗口剩余百分比低于阈值）
     */
    protected shouldHighlightWarning(data: KimiStatusData): boolean {
        const { summary, windows } = data;

        // 检查总体剩余百分比是否低于阈值（已使用百分比高于阈值）
        const usedPercentage = summary.used;
        if (usedPercentage >= this.HIGH_USAGE_THRESHOLD) {
            return true;
        }

        // 检查是否存在任意窗口剩余百分比低于阈值
        if (windows.length > 0) {
            for (const window of windows) {
                const windowUsedPercentage = window.detail.used;
                if (windowUsedPercentage >= this.HIGH_USAGE_THRESHOLD) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 检查是否需要刷新缓存
     * 缓存超过5分钟固定过期时间则刷新
     */
    protected shouldRefresh(): boolean {
        if (!this.lastStatusData) {
            return false;
        }

        const dataAge = Date.now() - this.lastStatusData.timestamp;
        const CACHE_EXPIRY_THRESHOLD = (5 * 60 - 10) * 1000; // 缓存过期阈值 5 分钟

        // 检查缓存是否超过5分钟固定过期时间
        if (dataAge > CACHE_EXPIRY_THRESHOLD) {
            StatusLogger.debug(
                `[${this.config.logPrefix}] 缓存时间(${(dataAge / 1000).toFixed(1)}秒)超过5分钟固定过期时间，触发API刷新`
            );
            return true;
        }

        return false;
    }

    /**
     * 将时间单位转换为中文
     */
    private translateTimeUnit(timeUnit: string): string {
        const unitMap: Record<string, string> = {
            TIME_UNIT_SECOND: '秒',
            TIME_UNIT_MINUTE: '分钟',
            TIME_UNIT_HOUR: '小时',
            TIME_UNIT_DAY: '天',
            TIME_UNIT_MONTH: '月',
            TIME_UNIT_YEAR: '年'
        };
        return unitMap[timeUnit] || timeUnit;
    }

    /**
     * 格式化日期时间为 MM/DD HH:mm 格式
     */
    private formatDateTime(date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${month}/${day} ${hours}:${minutes}`;
    }

    /**
     * 访问器：获取最后的状态数据（用于测试和调试）
     */
    getLastStatusData(): { data: KimiStatusData; timestamp: number } | null {
        return this.lastStatusData;
    }
}
