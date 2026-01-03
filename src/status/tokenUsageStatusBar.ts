/*---------------------------------------------------------------------------------------------
 *  Token Usage Status Bar
 *  Token 用量状态栏 - 显示今日 Token 用量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import { StatusLogger } from '../utils/statusLogger';
import { DateUtils } from '../usages/fileLogger/dateUtils';
import { UserActivityService } from './userActivityService';
import type { TokenUsageStatsFromFile } from '../usages/fileLogger/types';

/**
 * Token 用量状态栏
 * 显示今日 Token 用量，点击打开详细视图
 */
export class TokenUsageStatusBar {
    private statusBarItem: vscode.StatusBarItem | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private updateTimer: NodeJS.Timeout | undefined;
    private lastUpdateTime = 0;
    private readonly UPDATE_INTERVAL = 30000; // 30秒更新一次
    private readonly UPDATE_COOLDOWN = 10000; // 最近更新后10秒内不重复更新

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * 初始化状态栏
     */
    async initialize(): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.tokenUsage',
            vscode.StatusBarAlignment.Right,
            11 // 优先级设置在 contextUsage(12) 之前
        );

        this.statusBarItem.name = 'GCMP: Token Usage';
        this.statusBarItem.command = 'gcmp.tokenUsage.showDetails';

        // 初始更新显示
        this.updateDisplay().then(() => {
            this.statusBarItem?.show();
        });

        // 监听文件日志系统的统计更新事件
        const fileLogger = this.usagesManager.getFileLogger();
        this.updateDisposable = fileLogger.onStatsUpdate(async () => {
            await this.updateDisplay();
        });

        // 启动定时更新
        this.startPeriodicUpdate();

        this.context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[Token统计状态栏] 初始化完成');
    }

    /**
     * 启动定时更新
     */
    private startPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }

        this.updateTimer = setInterval(async () => {
            await this.periodicUpdate();
        }, this.UPDATE_INTERVAL);

        StatusLogger.debug(`[Token统计状态栏] 启动定时更新，间隔: ${this.UPDATE_INTERVAL}ms`);
    }

    /**
     * 停止定时更新
     */
    private stopPeriodicUpdate(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = undefined;
            StatusLogger.debug('[Token统计状态栏] 停止定时更新');
        }
    }

    /**
     * 周期性更新回调
     */
    private async periodicUpdate(): Promise<void> {
        // 检查用户是否活跃
        if (!UserActivityService.isUserActive()) {
            StatusLogger.trace('[Token统计状态栏] 用户不活跃，跳过更新');
            return;
        }

        // 检查是否在冷却期内
        const now = Date.now();
        const timeSinceLastUpdate = now - this.lastUpdateTime;
        if (timeSinceLastUpdate < this.UPDATE_COOLDOWN) {
            StatusLogger.trace(`[Token统计状态栏] 距离上次更新仅 ${timeSinceLastUpdate}ms，等待下个周期`);
            return;
        }

        // 执行更新
        await this.updateDisplay();
    }

    /**
     * 更新显示
     */
    async updateDisplay(): Promise<void> {
        if (!this.statusBarItem) {
            return;
        }

        try {
            const today = DateUtils.getTodayDateString();
            const todayStats = await this.usagesManager.getDateStats(today);

            // 计算今日总 token
            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            let totalRequests = 0;

            for (const stats of Object.values(todayStats.providers)) {
                totalInputTokens += stats.actualInput;
                totalOutputTokens += stats.outputTokens;
                totalRequests += stats.requests;
            }

            const totalTokens = totalInputTokens + totalOutputTokens;

            // 更新状态栏文本
            if (totalRequests === 0) {
                this.statusBarItem.text = '$(pulse)';
            } else {
                this.statusBarItem.text = `$(pulse) ${this.formatTokens(totalTokens)}`;
            }

            // 更新 Tooltip (异步生成)
            this.statusBarItem.tooltip = await this.generateTooltip(todayStats);

            // 更新最后更新时间
            this.lastUpdateTime = Date.now();
        } catch (err) {
            StatusLogger.error('[Token统计状态栏] 更新显示失败:', err);
            this.statusBarItem.text = '$(pulse)';
        }
    }

    /**
     * 生成 Tooltip（显示今日分提供商统计 + 最近历史记录）
     */
    private async generateTooltip(stats: TokenUsageStatsFromFile): Promise<vscode.MarkdownString> {
        const md = new vscode.MarkdownString();
        md.supportHtml = false;
        md.isTrusted = true;

        md.appendMarkdown('**GCMP: 今日 Token 消耗统计**\n\n');
        md.appendMarkdown('\n---\n');

        const providers = Object.values(stats.providers);
        if (providers.length === 0) {
            md.appendMarkdown('暂无使用记录');
            md.appendMarkdown('\n\n---\n\n点击查看详情');
            return md;
        }

        // ========== 今日用量表格 ==========
        // 按提供商统计（按总 token 排序）
        const sortedProviders = providers.sort((a, b) => {
            const totalA = a.actualInput + a.outputTokens;
            const totalB = b.actualInput + b.outputTokens;
            return totalB - totalA;
        });
        // 创建提供商统计表格
        md.appendMarkdown('| 提供商        | 输入Tokens | 缓存命中 | 输出Tokens | 消耗Tokens | 请求次数 |\n');
        md.appendMarkdown('| :------------ | ------: | ------: | ------: | ------: | ----: |\n');
        for (const stats of sortedProviders) {
            const providerTotal = stats.actualInput + stats.outputTokens;
            md.appendMarkdown(
                `| ${stats.providerName} | ${this.formatTokens(stats.actualInput)} | ` +
                    `${this.formatTokens(stats.cacheTokens)} | ` +
                    `${this.formatTokens(stats.outputTokens)} | ` +
                    `**${this.formatTokens(providerTotal)}** | ${stats.requests} |\n`
            );
        }
        // 合计行（仅当有多个提供商时显示）
        if (providers.length > 1) {
            const total = stats.total.actualInput + stats.total.outputTokens;
            md.appendMarkdown(
                `| **合计** | **${this.formatTokens(stats.total.actualInput)}** | ` +
                    `**${this.formatTokens(stats.total.cacheTokens)}** | ` +
                    `**${this.formatTokens(stats.total.outputTokens)}** | ` +
                    `**${this.formatTokens(total)}** | **${stats.total.requests}** |\n`
            );
        }

        // ========== 最近请求记录表格 ==========
        try {
            const recentRequests = await this.usagesManager.getRecentRecords(3); // 获取最近 3 条

            if (recentRequests.length > 0) {
                md.appendMarkdown('\n\n ---- \n\n\n\n');
                // 创建表格标题
                md.appendMarkdown('| 提供商      | 请求时间 | 消耗量 | 状态 | 输入Tokens | 缓存命中 | 输出Tokens |\n');
                md.appendMarkdown('| :----------- | :-----: | -----: | :----: | -----: | -----: | -----: |\n');

                // 反转数组，让最近的请求在最下方显示
                const reversedRequests = [...recentRequests].reverse();
                for (const req of reversedRequests) {
                    const startTime = new Date(req.timestamp);
                    // 确定状态图标：仅当有 rawUsage 且状态为 completed 时才显示 ✅
                    let statusIcon = '⏳'; // 默认为进行中
                    if (req.status === 'completed' && req.rawUsage) {
                        statusIcon = '✅'; // 真正完成
                    } else if (req.status === 'failed') {
                        statusIcon = '❌'; // 失败
                    } else if (req.status === 'estimated') {
                        statusIcon = '⏳'; // 预估中
                    }
                    const timeStr = startTime.toLocaleTimeString('zh-CN');

                    // 直接访问扩展属性
                    const actualInput = req.actualInput;
                    const cacheTokens = req.cacheReadTokens;
                    const outputTokens = req.outputTokens;
                    const totalTokens = req.totalTokens;

                    // 根据状态决定显示实际值还是预估值
                    let inputStr = '-';
                    let cacheStr = '-';
                    let outputStr = '-';
                    let totalStr = '-';
                    if (req.status === 'completed' && req.rawUsage && totalTokens > 0) {
                        // 完成状态且有实际值：显示实际值
                        inputStr = this.formatTokens(actualInput);
                        cacheStr = cacheTokens > 0 ? this.formatTokens(cacheTokens) : '-';
                        outputStr = outputTokens > 0 ? this.formatTokens(outputTokens) : '-';
                        totalStr = this.formatTokens(totalTokens);
                    } else {
                        // 预估或失败状态或无实际值：显示预估值（带 ~ 前缀）
                        if (req.estimatedInput !== undefined && req.estimatedInput > 0) {
                            totalStr = inputStr = `~${this.formatTokens(req.estimatedInput)}`;
                        }
                    }

                    md.appendMarkdown(
                        `| ${req.providerName} | ${timeStr} | ${totalStr} | ${statusIcon} | ${inputStr} | ${cacheStr} | ${outputStr} |\n`
                    );
                }
            }
        } catch (err) {
            // 忽略错误，不影响基本功能
            StatusLogger.debug('[Token统计状态栏] 获取请求记录失败:', err);
        }

        md.appendMarkdown('\n---\n\n点击查看详情');

        return md;
    }

    /**
     * 格式化 token 数量
     */
    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        } else if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'K';
        } else {
            return tokens.toString();
        }
    }

    /**
     * 检查并显示状态
     */
    async checkAndShowStatus(): Promise<void> {
        if (this.statusBarItem) {
            this.statusBarItem.show();
        }
    }

    /**
     * 延迟更新
     */
    delayedUpdate(delayMs: number = 1000): void {
        setTimeout(() => {
            this.updateDisplay();
        }, delayMs);
    }

    /**
     * 销毁状态栏
     */
    dispose(): void {
        this.stopPeriodicUpdate();
        this.updateDisposable?.dispose();
        this.statusBarItem?.dispose();
    }
}
