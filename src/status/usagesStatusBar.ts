/*---------------------------------------------------------------------------------------------
 *  Token Usages Status Bar
 *  Token 用量状态栏 - 显示今日 Token 使用量
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import { StatusLogger } from '../utils/statusLogger';
import { ProviderStats } from '../usages/types';

/**
 * Token 用量状态栏
 * 显示今日 Token 使用量，点击打开详细视图
 */
export class TokenUsagesStatusBar {
    private statusBarItem: vscode.StatusBarItem | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * 初始化状态栏
     */
    async initialize(): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.tokenStats',
            vscode.StatusBarAlignment.Right,
            11 // 优先级设置在 tokenUsage(12) 之前
        );

        this.statusBarItem.name = 'GCMP: Token 消耗统计';
        this.statusBarItem.command = 'gcmp.tokenStats.showDetails';

        // 初始更新显示
        await this.updateDisplay();
        this.statusBarItem.show();

        // 监听文件日志系统的统计更新事件
        const fileLogger = this.usagesManager.getFileLogger();
        this.updateDisposable = fileLogger.onStatsUpdate(async () => {
            await this.updateDisplay();
        });

        this.context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[Token统计状态栏] 初始化完成');
    }

    /**
     * 更新显示
     */
    async updateDisplay(): Promise<void> {
        if (!this.statusBarItem) {
            return;
        }

        try {
            const todayStats = await this.usagesManager.getTodayStats();
            const providers = Object.values(todayStats.providers);

            // 计算今日总 token
            let totalInputTokens = 0;
            let totalCacheReadTokens = 0;
            let totalOutputTokens = 0;
            let totalRequests = 0;

            for (const stats of providers) {
                totalInputTokens += stats.totalInputTokens;
                totalCacheReadTokens += stats.totalCacheReadTokens;
                totalOutputTokens += stats.totalOutputTokens;
                totalRequests += stats.totalRequests;
            }

            const totalTokens = totalInputTokens + totalOutputTokens;

            // 更新状态栏文本
            if (totalRequests === 0) {
                this.statusBarItem.text = '$(pulse)';
            } else {
                this.statusBarItem.text = `$(pulse) ${this.formatTokens(totalTokens)}`;
            }

            // 更新 Tooltip (异步生成)
            this.statusBarItem.tooltip = await this.generateTooltip(
                providers,
                totalInputTokens,
                totalCacheReadTokens,
                totalOutputTokens,
                totalRequests,
                todayStats.date
            );
        } catch (err) {
            StatusLogger.error('[Token统计状态栏] 更新显示失败:', err);
            this.statusBarItem.text = '$(pulse)';
        }
    }

    /**
     * 生成 Tooltip（显示今日分提供商统计 + 最近历史记录）
     */
    private async generateTooltip(
        providers: ProviderStats[],
        totalInput: number,
        totalCacheRead: number,
        totalOutput: number,
        totalRequests: number,
        date: string
    ): Promise<vscode.MarkdownString> {
        const md = new vscode.MarkdownString();
        md.supportHtml = false;
        md.isTrusted = true;

        if (providers.length === 0) {
            md.appendMarkdown(`**今日 Token 消耗统计** (${date})\n\n`);
            md.appendMarkdown('暂无使用记录');
            md.appendMarkdown('\n\n---\n\n点击查看详情');
            return md;
        }

        // ========== 今日用量表格 ==========
        md.appendMarkdown(`**今日 Token 消耗统计** (${date})\n\n`);

        // 按提供商统计（按总 token 排序）
        const sortedProviders = providers.sort((a, b) => {
            const totalA = a.totalInputTokens + a.totalOutputTokens;
            const totalB = b.totalInputTokens + b.totalOutputTokens;
            return totalB - totalA;
        });

        // 创建提供商统计表格
        md.appendMarkdown('| 提供商 | 输入Tokens | 缓存命中 | 输出Tokens | 消耗Tokens | 请求数 |\n');
        md.appendMarkdown('| :---- | ----: | ----: | ----: | ----: | ----: |\n');

        for (const stats of sortedProviders) {
            const providerTotal = stats.totalInputTokens + stats.totalOutputTokens;
            md.appendMarkdown(
                `| ${stats.displayName} | ${this.formatTokens(stats.totalInputTokens)} | ` +
                    `${this.formatTokens(stats.totalCacheReadTokens)} | ` +
                    `${this.formatTokens(stats.totalOutputTokens)} | ` +
                    `${this.formatTokens(providerTotal)} | ${stats.totalRequests} |\n`
            );
        }

        // 合计行
        const total = totalInput + totalOutput;
        md.appendMarkdown(
            `| **合计** | **${this.formatTokens(totalInput)}** | ` +
                `**${this.formatTokens(totalCacheRead)}** | ` +
                `**${this.formatTokens(totalOutput)}** | ` +
                `**${this.formatTokens(total)}** | **${totalRequests}** |\n`
        );

        // ========== 最近历史记录表格 ==========
        try {
            const recentRequests = await this.usagesManager.getRecentRecords(3); // 获取最近 3 条

            if (recentRequests.length > 0) {
                md.appendMarkdown('\n---\n**最近的请求 Token 使用信息**\n\n');
                // 创建表格标题
                md.appendMarkdown('| 提供商 | 请求时间 | 状态 | 输入/预估 | 缓存命中 | 输出Tokens |\n');
                md.appendMarkdown('| :---- | :----: | :----: | ----: | ----: | ----: |\n');

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

                    // 使用扩展方法获取解析后的值
                    const actualInput = req.getActualInput();
                    const cacheTokens = req.getCacheReadTokens();
                    const outputTokens = req.getOutputTokens();

                    // 根据状态决定显示实际值还是预估值
                    let inputStr: string;
                    let cacheStr: string;
                    let outputStr: string;

                    if (req.status === 'completed' && req.rawUsage) {
                        // 真正完成状态：显示实际值
                        inputStr = this.formatTokens(actualInput);
                        cacheStr = cacheTokens > 0 ? this.formatTokens(cacheTokens) : '-';
                        outputStr = outputTokens > 0 ? this.formatTokens(outputTokens) : '-';
                    } else {
                        // estimated 或 failed 状态：显示预估值（带 ~ 前缀）
                        if (req.estimatedInput !== undefined && req.estimatedInput > 0) {
                            inputStr = `~${this.formatTokens(req.estimatedInput)}`;
                        } else {
                            inputStr = '-';
                        }
                        cacheStr = '-';
                        outputStr = '-';
                    }

                    md.appendMarkdown(
                        `| ${req.providerName} | ${timeStr} | ${statusIcon} | ${inputStr} | ${cacheStr} | ${outputStr} |\n`
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
        this.updateDisposable?.dispose();
        this.statusBarItem?.dispose();
    }
}
