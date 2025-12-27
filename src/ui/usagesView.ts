/*---------------------------------------------------------------------------------------------
 *  Token Usages View
 *  Token 用量详细视图
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { TokenUsageStatsFromFile } from '../usages/fileLogger';
import type { DateSummary } from '../usages/types';
import { ExtendedTokenRequestLog, UsageParser } from '../usages/fileLogger/usageParser';
import { Logger } from '../utils/logger';
import usagesViewCss from './usagesView.css?raw';
import usagesViewJs from './usagesView.js?raw';
import { TokenRequestLog } from '../usages/fileLogger';

/**
 * WebView 消息类型定义
 */
type WebViewMessage =
    | { command: 'refresh'; date?: string; page?: number }
    | { command: 'selectDate'; date: string }
    | { command: 'changePage'; date: string; page: number }
    | { command: 'loadMoreDates'; currentLimit: number }
    | { command: 'openStorageDir' };

/**
 * 格式化后的记录数据类型
 */
interface FormattedRecordData {
    time: string;
    providerName: string;
    modelName: string;
    inputDisplay: string;
    cacheDisplay: string;
    outputDisplay: string;
    statusClass: string;
    statusText: string;
}

/**
 * Token 用量 WebView 视图
 */
export class TokenUsagesView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private datesLimit: number = 30; // 默认显示30天
    private currentSelectedDate: string | undefined; // 当前查看的日期
    private currentPage: number = 1; // 当前页码
    private hasCheckedOutdatedStats: boolean = false; // 是否已检查过过期统计

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    /**
     * 显示 WebView
     */
    show(): void {
        // 如果面板已存在，直接显示
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        // 重置检查标志，每次打开时都检查过期统计
        this.hasCheckedOutdatedStats = false;

        // 获取今日日期作为标题
        const today = this.getTodayDateString();
        this.panel = vscode.window.createWebviewPanel(
            'gcmpTokenStats',
            `GCMP Token 消耗统计 - ${today}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.updateView();

        // 监听消息
        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            this.context.subscriptions
        );

        // 监听统计更新事件，智能刷新视图
        this.updateDisposable = this.usagesManager.onStatsUpdate(() => {
            if (this.panel) {
                this.smartRefresh();
            }
        });

        // 监听关闭
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.updateDisposable?.dispose();
            this.updateDisposable = undefined;
        });
    }

    /**
     * 更新视图内容
     */
    private async updateView(selectedDate?: string, page: number = 1): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            // 检查并重新生成过期的统计数据（仅在首次打开时执行）
            if (!this.hasCheckedOutdatedStats) {
                await this.usagesManager.getFileLogger().regenerateOutdatedStats();
                this.hasCheckedOutdatedStats = true;
            }

            // 获取所有日期摘要
            const dateSummaries = await this.usagesManager.getAllDateSummaries();

            // 确定要显示的日期（默认为今日）
            const today = this.getTodayDateString();
            const displayDate = selectedDate || today;

            // 记录当前查看的日期和页码
            this.currentSelectedDate = displayDate;
            this.currentPage = page;

            // 如果选中的日期不在当前限制范围内,自动扩展限制以包含该日期
            const selectedIndex = dateSummaries.findIndex(s => s.date === displayDate);
            if (selectedIndex >= this.datesLimit) {
                this.datesLimit = Math.ceil((selectedIndex + 1) / 30) * 30;
            }

            // 获取选中日期的详细数据(从文件直接读取,不使用缓存)
            const dateStats = await this.usagesManager.getDateStatsFromFile(displayDate);
            const dateRecords = await this.usagesManager.getDateRecords(displayDate);

            this.panel.webview.html = this.getWebviewContent(
                dateSummaries,
                displayDate,
                dateStats,
                dateStats.hourly,
                dateRecords,
                page
            );
        } catch (err) {
            Logger.error('[TokenUsagesView] 更新视图失败:', err);
        }
    }

    /**
     * 智能刷新 - 根据当前查看的日期决定刷新策略
     * - 如果正在查看今日且在第一页：刷新整个详情（包括请求记录状态）+ 更新日期列表
     * - 如果正在查看其他日期：只刷新左侧日期列表的统计数字
     */
    private async smartRefresh(): Promise<void> {
        if (!this.panel) {
            return;
        }

        const today = this.getTodayDateString();
        const isViewingToday = this.currentSelectedDate === today;
        const isFirstPage = this.currentPage === 1;

        Logger.info(
            `[TokenUsagesView] 智能刷新: 查看日期=${this.currentSelectedDate}, 今日=${today}, 是否查看今日=${isViewingToday}, 是否第一页=${isFirstPage}`
        );

        if (isViewingToday && isFirstPage) {
            // 查看今日且在第一页 - 刷新整个详情 + 更新日期列表
            Logger.info('[TokenUsagesView] 刷新今日详情 + 日期列表');
            await this.updateDateDetails(today);
            await this.updateDateListOnly();
        } else {
            // 查看其他日期 - 只刷新日期列表统计
            Logger.info('[TokenUsagesView] 仅刷新日期列表');
            await this.updateDateListOnly();
        }
    }

    /**
     * 只更新日期列表的统计数字，不刷新右侧详情
     */
    private async updateDateListOnly(): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            const dateSummaries = await this.usagesManager.getAllDateSummaries();
            const today = this.getTodayDateString();

            // 准备更新的日期列表数据
            const dateListData = dateSummaries.map(summary => ({
                date: summary.date,
                total_requests: summary.total_requests,
                totalTokensFormatted: this.formatTokens(summary.total_input + summary.total_output),
                isToday: summary.date === today
            }));

            // 发送消息给 WebView，让它更新日期列表
            this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateListData
            });
        } catch (err) {
            Logger.error('[TokenUsagesView] 更新日期列表失败:', err);
        }
    }

    /**
     * 获取今日日期字符串（YYYY-MM-DD）
     */
    private getTodayDateString(): string {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    /**
     * 处理来自 WebView 的消息
     */
    private async handleMessage(message: WebViewMessage): Promise<void> {
        switch (message.command) {
            case 'refresh':
                await this.updateView(message.date, message.page || 1);
                break;

            case 'selectDate':
                await this.updateDateDetails(message.date);
                break;

            case 'changePage':
                await this.updatePageRecords(message.date, message.page);
                break;

            case 'loadMoreDates':
                await this.loadMoreDates(message.currentLimit);
                break;

            case 'openStorageDir':
                await this.openStorageDir();
                break;
        }
    }

    /**
     * 更新日期详情（动态更新，不重新渲染整个页面）
     */
    private async updateDateDetails(date: string): Promise<void> {
        try {
            const today = this.getTodayDateString();

            // 从文件直接读取,不使用缓存
            const dateStats = await this.usagesManager.getDateStatsFromFile(date);
            const dateRecords = await this.usagesManager.getDateRecords(date);

            const providers = Object.values(dateStats.providers);

            // 更新当前状态
            this.currentSelectedDate = date;
            this.currentPage = 1;

            // 更新面板标题
            if (this.panel) {
                this.panel.title = `GCMP Token 消耗统计 - ${date}`;
            }

            // 发送消息给 WebView，让它更新详情区域
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'updateDateDetails',
                    date,
                    isToday: date === today,
                    providers: this.formatProvidersData(providers),
                    hourlyStats: dateStats.hourly,
                    records: this.formatRecordsData(UsageParser.extendLogs(dateRecords)),
                    currentPage: 1
                });
            }

            Logger.info(`[TokenUsagesView] 已更新日期详情: ${date}, 记录数=${dateRecords.length}`);
        } catch (err) {
            Logger.error('[TokenUsagesView] 更新日期详情失败:', err);
        }
    }

    /**
     * 更新分页记录（动态更新，不重新渲染整个页面）
     */
    private async updatePageRecords(date: string, page: number): Promise<void> {
        try {
            // 更新当前页码和日期
            this.currentPage = page;
            this.currentSelectedDate = date;

            const dateRecords = await this.usagesManager.getDateRecords(date);

            // 发送消息给 WebView，让它更新记录列表
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'updatePageRecords',
                    records: this.formatRecordsData(UsageParser.extendLogs(dateRecords)),
                    page
                });
            }

            Logger.debug(`[TokenUsagesView] 已更新分页记录: ${date}, page=${page}`);
        } catch (err) {
            Logger.error('[TokenUsagesView] 更新分页记录失败:', err);
        }
    }

    /**
     * 加载更多日期
     */
    private async loadMoreDates(currentLimit: number): Promise<void> {
        try {
            const dateSummaries = await this.usagesManager.getAllDateSummaries();
            const today = this.getTodayDateString();

            // 计算新的范围
            const newLimit = currentLimit + 30;
            const startIndex = currentLimit;
            const endIndex = Math.min(newLimit, dateSummaries.length);
            const newDates = dateSummaries.slice(startIndex, endIndex);
            const remainingCount = dateSummaries.length - endIndex;

            // 生成新日期项的 HTML
            const newItemsHtml = newDates.map(summary => {
                const isToday = summary.date === today;
                const displayDate = isToday ? `今日 (${summary.date})` : summary.date;
                return {
                    date: summary.date,
                    isToday,
                    displayDate,
                    totalRequests: summary.total_requests,
                    totalTokens: this.formatTokens(summary.total_input + summary.total_output)
                };
            });

            // 发送消息给 WebView，让它插入新的日期项
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'appendDates',
                    dates: newItemsHtml,
                    newLimit: endIndex,
                    remainingCount
                });
            }
        } catch (err) {
            Logger.error('[TokenUsagesView] 加载更多日期失败:', err);
        }
    }

    /**
     * 打开存储目录
     */
    private async openStorageDir(): Promise<void> {
        try {
            const storageDir = this.usagesManager.getStorageDir();
            await vscode.env.openExternal(vscode.Uri.file(storageDir));
            Logger.info(`[TokenUsagesView] 已打开存储目录: ${storageDir}`);
        } catch (err) {
            Logger.error('[TokenUsagesView] 打开存储目录失败:', err);
            vscode.window.showErrorMessage('打开存储目录失败');
        }
    }

    /**
     * 格式化提供商数据
     */
    private formatProvidersData(
        providers: Array<{
            providerKey: string;
            displayName: string;
            totalInputTokens: number;
            totalCacheReadTokens: number;
            totalOutputTokens: number;
            totalRequests: number;
            models?: Record<
                string,
                {
                    modelId: string;
                    modelName: string;
                    totalInputTokens: number;
                    totalCacheReadTokens: number;
                    totalOutputTokens: number;
                    totalRequests: number;
                }
            >;
        }>
    ): unknown[] {
        const formatModel = (m: {
            modelId: string;
            modelName: string;
            totalInputTokens: number;
            totalCacheReadTokens: number;
            totalOutputTokens: number;
            totalRequests: number;
        }) => {
            const modelTotal = m.totalInputTokens + m.totalOutputTokens;
            return {
                modelId: m.modelId,
                modelName: m.modelName,
                totalInputTokens: m.totalInputTokens,
                totalInputTokensFormatted: this.formatTokens(m.totalInputTokens),
                totalCacheReadTokens: m.totalCacheReadTokens,
                totalCacheReadTokensFormatted: this.formatTokens(m.totalCacheReadTokens),
                totalOutputTokens: m.totalOutputTokens,
                totalOutputTokensFormatted: this.formatTokens(m.totalOutputTokens),
                totalTokensFormatted: this.formatTokens(modelTotal),
                totalRequests: m.totalRequests
            };
        };

        return providers
            .map(p => {
                const total = p.totalInputTokens + p.totalOutputTokens;
                const models = p.models ? Object.values(p.models).map(formatModel) : [];
                return {
                    providerKey: p.providerKey,
                    displayName: p.displayName,
                    totalInputTokens: p.totalInputTokens,
                    totalInputTokensFormatted: this.formatTokens(p.totalInputTokens),
                    totalCacheReadTokens: p.totalCacheReadTokens,
                    totalCacheReadTokensFormatted: this.formatTokens(p.totalCacheReadTokens),
                    totalOutputTokens: p.totalOutputTokens,
                    totalOutputTokensFormatted: this.formatTokens(p.totalOutputTokens),
                    totalTokensFormatted: this.formatTokens(total),
                    totalRequests: p.totalRequests,
                    models: models
                };
            })
            .sort((a, b) => {
                const totalA = a.totalInputTokens + a.totalOutputTokens;
                const totalB = b.totalInputTokens + b.totalOutputTokens;
                return totalB - totalA;
            });
    }

    /**
     * 格式化小时统计数据 - 直接返回原始结构
     */
    private formatHourlyStatsData(
        hourly: Record<string, HourlyStats> | undefined
    ): Record<string, HourlyStats> | undefined {
        return hourly;
    }

    /**
     * 格式化记录数据
     */
    private formatRecordsData(records: ExtendedTokenRequestLog[]): FormattedRecordData[] {
        return records.map(r => {
            const statusMap: Record<string, { class: string; text: string }> = {
                completed: { class: 'status-completed', text: '✅' },
                failed: { class: 'status-failed', text: '❌' },
                estimated: { class: 'status-estimated', text: '⏳' }
            };
            const statusInfo = statusMap[r.status] || statusMap.estimated;
            const statusClass = statusInfo.class;
            const statusText = statusInfo.text;

            const timeStr = new Date(r.timestamp).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });

            // 使用扩展方法获取解析后的值
            const actualInput = r.getActualInput();
            const cacheTokens = r.getCacheReadTokens();
            const outputTokens = r.getOutputTokens();

            // 根据状态决定显示实际值还是预估值
            let inputDisplay: string;
            if (r.status === 'completed') {
                inputDisplay = this.formatTokens(actualInput);
            } else {
                // estimated 或 failed 状态显示预估值（带 ~ 前缀）
                inputDisplay = `~${this.formatTokens(r.estimatedInput)}`;
            }

            const cacheDisplay = r.status === 'completed' && cacheTokens > 0 ? this.formatTokens(cacheTokens) : '-';
            const outputDisplay = r.status === 'completed' && outputTokens > 0 ? this.formatTokens(outputTokens) : '-';

            return {
                time: timeStr,
                providerName: r.providerName,
                modelName: r.modelName,
                inputDisplay,
                cacheDisplay,
                outputDisplay,
                statusClass,
                statusText
            };
        });
    }

    /**
     * 生成 WebView HTML 内容
     */
    private getWebviewContent(
        dateSummaries: DateSummary[],
        selectedDate: string,
        dateStats: TokenUsageStatsFromFile & { date: string; lastUpdated: number },
        hourlyStats: Record<string, HourlyStats> | undefined,
        dateRecords: TokenRequestLog[],
        currentPage: number = 1
    ): string {
        const today = this.getTodayDateString();
        const providers = Object.values(dateStats.providers);
        const cspSource = this.panel?.webview.cspSource || '';

        // 准备初始数据
        const initialData = {
            dateSummaries: dateSummaries.map(summary => ({
                date: summary.date,
                total_requests: summary.total_requests,
                totalTokensFormatted: this.formatTokens(summary.total_input + summary.total_output)
            })),
            selectedDate,
            today,
            currentPage,
            datesLimit: this.datesLimit,
            providers: this.formatProvidersData(providers),
            hourlyStats: this.formatHourlyStatsData(hourlyStats),
            records: this.formatRecordsData(UsageParser.extendLogs(dateRecords))
        };

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>GCMP Token 消耗统计</title>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
	<style>
		${usagesViewCss}
	</style>
</head>
<body>
	<div id="app"></div>
	<script>
		${usagesViewJs}

		// 初始化数据
		const initialData = ${JSON.stringify(initialData)};

		// 启动视图
		document.addEventListener('DOMContentLoaded', function() {
			initializeUsagesView(initialData);
		});
	</script>
</body>
</html>`;
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
     * 销毁视图
     */
    dispose(): void {
        this.updateDisposable?.dispose();
        this.panel?.dispose();
    }
}
