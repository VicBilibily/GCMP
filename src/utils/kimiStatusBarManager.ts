/*---------------------------------------------------------------------------------------------
 *  Kimi 状态栏管理器
 *  在 VS Code 状态栏显示 Kimi 使用量信息
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from './statusLogger';
import { KimiRemainQuery, KimiUsage } from './kimiRemainQuery';
import { ApiKeyManager } from './apiKeyManager';

/**
 * Kimi 状态栏管理器
 *
 * 功能特性：
 * - 在 VS Code 状态栏显示 Kimi 使用量信息
 * - 支持周期和时间窗口的多维度使用量展示
 * - 防抖机制：API 请求后延时更新，避免频繁调用
 * - 动态显示：仅在设置了 API 密钥时显示状态栏
 *
 * 初始化：在 KimiProvider.createAndActivate() 中调用 initialize()
 *
 * 刷新机制：
 * 1. 手动刷新：点击状态栏或执行命令
 * 2. 延时刷新：API 请求后 2 秒执行，带 30 秒防抖
 */
export class KimiStatusBarManager {
    private static statusBarItem: vscode.StatusBarItem | undefined;
    private static lastRemaining = 0; // 存储上一次的剩余可用次数
    private static updateDebouncer: NodeJS.Timeout | undefined; // 防抖定时器
    private static lastDelayedUpdateTime = 0; // 上次延时更新时间
    private static readonly MIN_DELAYED_UPDATE_INTERVAL = 30000; // 最小延时更新间隔 30 秒
    private static context: vscode.ExtensionContext | undefined; // 存储扩展上下文
    private static isLoading = false; // 加载状态标志
    private static cacheUpdateTimer: NodeJS.Timeout | undefined; // 缓存定时器
    private static readonly CACHE_UPDATE_INTERVAL = 10000; // 缓存加载间隔 10 秒
    private static readonly CACHE_EXPIRY_THRESHOLD = 12 * 60 * 60 * 1000; // 缓存过期阈值 12 小时

    private static lastStatusData: { data: KimiUsage; timestamp: number } | null = null;

    /**
     * 初始化状态栏项
     */
    static async initialize(context: vscode.ExtensionContext) {
        // 保存扩展上下文
        this.context = context;

        // 1. 创建 StatusBarItem（始终创建，以便后续可以动态显示/隐藏）
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        this.statusBarItem.name = 'Kimi Usage';
        this.statusBarItem.text = '$(gcmp-kimi)';
        this.statusBarItem.command = 'gcmp.kimi.refreshUsage';

        // 检查是否设置了 API Key，决定是否显示
        const hasKey = await ApiKeyManager.hasValidApiKey('kimi');
        if (hasKey) {
            this.statusBarItem.show();
        } else {
            StatusLogger.trace('[Kimi状态栏] 未设置 API Key，隐藏 Kimi 状态栏');
        }

        // 初始更新
        this.performInitialUpdate();

        // 启动缓存定时器，每10秒更新一次
        this.startCacheUpdateTimer();

        // 注册清理逻辑
        context.subscriptions.push({
            dispose: () => {
                if (this.updateDebouncer) {
                    clearTimeout(this.updateDebouncer);
                    this.updateDebouncer = undefined;
                }
                if (this.cacheUpdateTimer) {
                    clearInterval(this.cacheUpdateTimer);
                    this.cacheUpdateTimer = undefined;
                }
                this.statusBarItem?.dispose();
                this.statusBarItem = undefined;
            }
        });
    }

    /**
     * 检查并显示状态栏（在设置 API Key 后调用）
     */
    static async checkAndShowStatus() {
        if (this.statusBarItem) {
            const hasKey = await ApiKeyManager.hasValidApiKey('kimi');
            if (hasKey) {
                this.statusBarItem.show();
                this.performInitialUpdate();
            } else {
                this.statusBarItem.hide();
            }
        }
    }

    /**
     * 延时更新状态栏（在 API 请求后调用）
     * 包含防抖机制，避免频繁请求
     */
    static delayedUpdate(delayMs = 2000) {
        // 清除之前的防抖定时器
        if (this.updateDebouncer) {
            clearTimeout(this.updateDebouncer);
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastDelayedUpdateTime;

        // 如果距离上次更新不足 30 秒，则等到满 30 秒再执行
        // 否则使用默认的延时时间
        const finalDelayMs =
            timeSinceLastUpdate < this.MIN_DELAYED_UPDATE_INTERVAL
                ? this.MIN_DELAYED_UPDATE_INTERVAL - timeSinceLastUpdate
                : delayMs;

        StatusLogger.debug(`[Kimi状态栏] 设置延时更新，将在 ${finalDelayMs / 1000} 秒后执行`);

        // 设置新的防抖定时器
        this.updateDebouncer = setTimeout(async () => {
            try {
                StatusLogger.debug('[Kimi状态栏] 执行延时更新');
                this.lastDelayedUpdateTime = Date.now();
                await this.performInitialUpdate();
            } catch (error) {
                StatusLogger.error('[Kimi状态栏] 延时更新失败', error);
            } finally {
                this.updateDebouncer = undefined;
            }
        }, finalDelayMs);
    }

    /**
     * 执行初始更新（背景加载）
     */
    private static async performInitialUpdate() {
        // 检查是否设置了 API Key
        const hasKey = await ApiKeyManager.hasValidApiKey('kimi');

        // 如果没有设置 API Key，隐藏状态栏并返回
        if (!hasKey) {
            if (this.statusBarItem) {
                this.statusBarItem.hide();
            }
            return;
        }

        // 确保状态栏显示
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }

        // 执行 API 查询
        await this.performApiQuery();
    }

    /**
     * 执行用户刷新（带加载状态）
     */
    static async performRefresh() {
        this.isLoading = true;

        try {
            // 显示加载中状态，保持之前的剩余次数（如果有的话）
            if (this.statusBarItem) {
                this.statusBarItem.text = `$(loading~spin) ${this.lastRemaining}`;
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.tooltip = '加载中...';
            }

            // 检查是否设置了 API Key
            const hasKey = await ApiKeyManager.hasValidApiKey('kimi');

            if (!hasKey) {
                if (this.statusBarItem) {
                    this.statusBarItem.hide();
                }
                return;
            }

            // 确保状态栏显示
            if (this.statusBarItem) {
                this.statusBarItem.show();
            }

            // 执行 API 查询
            await this.performApiQuery();
        } finally {
            this.isLoading = false;
        }
    }

    /**
     * 从缓存读取并更新状态信息
     */
    private static updateFromCache() {
        if (!this.context || !this.statusBarItem || this.isLoading) {
            return;
        }

        try {
            // 从全局状态读取缓存数据
            const cachedStatusData = this.context.globalState.get<{
                data: KimiUsage;
                timestamp: number;
            }>('kimi.statusData');

            if (cachedStatusData && cachedStatusData.data) {
                const dataAge = Date.now() - cachedStatusData.timestamp;

                // 检查缓存是否超过12小时，如果超过则自动刷新加载
                if (dataAge > this.CACHE_EXPIRY_THRESHOLD) {
                    StatusLogger.debug(
                        `[Kimi状态栏] 缓存数据已超过12小时 (${(dataAge / 1000 / 60 / 60).toFixed(1)}小时前)，自动刷新加载`
                    );
                    // 触发自动刷新
                    this.performRefresh().catch(error => {
                        StatusLogger.error('[Kimi状态栏] 自动刷新失败', error);
                    });
                    return;
                }

                // 检查基础过期（30秒）
                if (dataAge > 30000) {
                    if (dataAge < 60000) {
                        StatusLogger.debug(
                            `[Kimi状态栏] 缓存数据已过期 (${(dataAge / 1000).toFixed(1)}秒前)，跳过更新`
                        );
                    }
                    return;
                }

                // 更新内存中的数据
                const { summary } = cachedStatusData.data;
                const percentage = summary.usage_percentage;
                const remaining = summary.remaining;
                this.lastRemaining = remaining;
                this.lastStatusData = cachedStatusData;

                // 更新状态栏显示 - 显示剩余可用次数
                this.statusBarItem.text = `$(gcmp-kimi) ${remaining}`;
                // 检查是否需要高亮警告
                if (this.shouldHighlightWarning(cachedStatusData.data)) {
                    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                } else {
                    this.statusBarItem.backgroundColor = undefined;
                }

                // 更新 Tooltip
                this.statusBarItem.tooltip = this.generateTooltip(cachedStatusData.data);

                StatusLogger.debug(
                    `[Kimi状态栏] 从缓存更新状态: ${remaining}次 (${percentage}%, 缓存时间: ${(dataAge / 1000).toFixed(1)}秒前)`
                );
            }
        } catch (error) {
            StatusLogger.warn('[Kimi状态栏] 从缓存更新状态失败', error);
        }
    }

    /**
     * 启动缓存更新定时器
     */
    private static startCacheUpdateTimer() {
        if (this.cacheUpdateTimer) {
            clearInterval(this.cacheUpdateTimer);
        }

        this.cacheUpdateTimer = setInterval(() => {
            this.updateFromCache();
        }, this.CACHE_UPDATE_INTERVAL);

        StatusLogger.debug(`[Kimi状态栏] 缓存更新定时器已启动，间隔: ${this.CACHE_UPDATE_INTERVAL}ms`);
    }

    /**
     * 生成 Tooltip 内容
     */
    private static generateTooltip(data: KimiUsage) {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        const { summary } = data;
        md.appendMarkdown('#### Kimi For Coding 使用情况\n\n');
        md.appendMarkdown('|  类型  | 配额上限 | 剩余额度 |\n');
        md.appendMarkdown('| :----: | ----: | ----: |\n');
        md.appendMarkdown(`| **每周额度** | ${summary.limit} | ${summary.remaining} |\n`);

        if (data.windows.length > 0) {
            for (const window of data.windows) {
                const timeUnit = this.translateTimeUnit(window.timeUnit);
                const { detail, duration } = window;
                md.appendMarkdown(`| **${duration}${timeUnit}** | ${detail.limit} | ${detail.remaining} |\n`);
            }
        }

        md.appendMarkdown('\n');
        if (summary.resetTime) {
            md.appendMarkdown('---\n');
            const resetTime = new Date(summary.resetTime);
            const resetTimeStr = resetTime.toLocaleString('zh-CN');
            md.appendMarkdown(`**重置时间** ${resetTimeStr}\n`);
            md.appendMarkdown('\n');
        }

        md.appendMarkdown('---\n');
        md.appendMarkdown('点击状态栏可手动刷新\n');
        return md;
    }

    /**
     * 执行 API 查询
     */
    private static async performApiQuery() {
        try {
            StatusLogger.debug('[Kimi状态栏] 开始执行 Kimi 用量查询...');

            const result = await KimiRemainQuery.queryRemain();

            if (result.success && result.formatted) {
                if (this.statusBarItem) {
                    const { summary } = result.formatted;
                    const percentage = summary.usage_percentage;
                    const remaining = summary.remaining;

                    // 更新存储的剩余次数
                    this.lastRemaining = remaining;

                    // 保存完整的用量数据
                    this.lastStatusData = {
                        data: result.formatted,
                        timestamp: Date.now()
                    };

                    // 保存到全局状态
                    if (this.context) {
                        this.context.globalState.update('kimi.lastRemaining', remaining);
                        this.context.globalState.update('kimi.statusData', this.lastStatusData);
                    }

                    // 更新状态栏 UI - 显示剩余可用次数
                    this.statusBarItem.text = `$(gcmp-kimi) ${remaining}`;
                    // 检查是否需要高亮警告
                    if (this.shouldHighlightWarning(result.formatted)) {
                        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    } else {
                        this.statusBarItem.backgroundColor = undefined;
                    }

                    // 更新 Tooltip
                    this.statusBarItem.tooltip = this.generateTooltip(result.formatted);

                    StatusLogger.info(`[Kimi状态栏] Kimi 用量查询成功: ${remaining}次 (${percentage}%)`);
                }
            } else {
                // 错误处理
                const errorMsg = result.error || '未知错误';

                if (this.statusBarItem) {
                    this.statusBarItem.text = '$(gcmp-kimi) ERR';
                    this.statusBarItem.tooltip = `获取失败: ${errorMsg}`;
                }

                StatusLogger.warn(`[Kimi状态栏] Kimi 用量查询失败: ${errorMsg}`);
            }
        } catch (error) {
            StatusLogger.error('[Kimi状态栏] 更新状态栏失败', error);

            if (this.statusBarItem) {
                this.statusBarItem.text = '$(gcmp-kimi) ERR';
                this.statusBarItem.tooltip = `获取失败: ${error instanceof Error ? error.message : '未知错误'}`;
            }
        } finally {
            // 清除加载状态标志
            this.isLoading = false;
        }
    }

    /**
     * 检查是否需要高亮警告（百分比低于10%或任意窗口可用额度低于10%）
     */
    private static shouldHighlightWarning(data: KimiUsage): boolean {
        const { summary, windows } = data;

        // 检查总体百分比是否低于10%
        if (summary.usage_percentage < 10) {
            return true;
        }

        // 检查是否存在任意窗口可用额度低于10%
        if (windows.length > 0) {
            for (const window of windows) {
                const windowPercentage = window.detail.limit > 0 ? (window.detail.used / window.detail.limit) * 100 : 0;
                if (windowPercentage >= 90) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 将时间单位转换为中文
     */
    private static translateTimeUnit(timeUnit: string): string {
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
}
