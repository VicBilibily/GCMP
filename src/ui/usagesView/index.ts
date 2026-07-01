/*---------------------------------------------------------------------------------------------
 *  Token Usages View
 *  Token 用量详细视图
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsagesManager } from '../../usages/usagesManager';
import { StatusLogger } from '../../utils/statusLogger';
import { t } from '../../utils/l10n';
import { UpdateDateDetailsMessage, UpdateDateListMessage, UpdateLiveMetricsMessage } from './types';
import type { WebViewMessage } from './types';
import { getTodayDateString } from './utils';
import { MultiDayView } from '../multiDayView';
import { onLiveMetrics, getActiveMetricsSnapshot, type LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import { InterInstanceBus } from '../../interInstance';
import type { LiveMetricsUpdatedEvent } from '../../interInstance';

/**
 * Token 用量 WebView 视图
 */
export class TokenUsagesView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private liveMetricsDisposable: vscode.Disposable | undefined;
    private crossInstanceLiveMetricsDisposable: vscode.Disposable | undefined;
    private currentSelectedDate: string | undefined; // 当前查看的日期
    private hasCheckedOutdatedStats: boolean = false; // 是否已检查过过期统计
    // smartRefresh 防抖：合并短时间内的多次刷新请求，避免并发读到不一致中间状态
    private smartRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private smartRefreshInFlight: Promise<void> | null = null;
    private smartRefreshPending: boolean = false; // 执行期间又有新请求，需再刷一次

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
        const today = getTodayDateString();
        this.panel = vscode.window.createWebviewPanel(
            'gcmpTokenStats',
            `${t('GCMP Token Usage', 'GCMP Token 消耗统计')} - ${today}`,
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

        // 监听统计更新事件，智能刷新视图（带防抖）
        this.updateDisposable = this.usagesManager.onStatsUpdate(() => {
            if (this.panel) {
                this.smartRefresh();
            }
        });

        // 监听实时流式指标事件（retainContextWhenHidden 下隐藏面板仍可接收消息）
        // 仅在查看今天时转发给 WebView，非今天直接跳过 postMessage（IPC 序列化开销）
        // requestStarted / streamEnd 会触发请求记录立即刷新，避免状态长时间停留在 estimated
        this.liveMetricsDisposable = onLiveMetrics((event: LiveStreamMetricEvent) => {
            this.handleLiveMetricsEvent(event);
        });

        // 监听来自其他实例的实时流式指标事件（IPC-only，高频事件不走 fallback）
        this.crossInstanceLiveMetricsDisposable = InterInstanceBus.subscribe('liveMetricsUpdated', event => {
            this.handleLiveMetricsEvent((event as LiveMetricsUpdatedEvent).payload.event);
        });

        // 监听关闭
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.updateDisposable?.dispose();
            this.updateDisposable = undefined;
            this.liveMetricsDisposable?.dispose();
            this.liveMetricsDisposable = undefined;
            this.crossInstanceLiveMetricsDisposable?.dispose();
            this.crossInstanceLiveMetricsDisposable = undefined;
        });
    }

    /**
     * 更新视图内容
     */
    private async updateView(selectedDate?: string): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            // 确定要显示的日期（默认为今日）
            const today = getTodayDateString();
            const displayDate = selectedDate || today;

            // 记录当前查看的日期
            this.currentSelectedDate = displayDate;

            // 先把 HTML 设置好，让 WebView 立即可见，避免 regenerateOutdatedStats 阻塞加载
            this.panel.webview.html = this.getWebviewContent();

            // 异步检查并重新生成过期的统计数据（仅在首次打开时执行，不阻塞 HTML 渲染）
            if (!this.hasCheckedOutdatedStats) {
                this.hasCheckedOutdatedStats = true;
                this.usagesManager
                    .getFileLogger()
                    .regenerateOutdatedStats()
                    .then(regenerated => {
                        // 后台重建会更新 stats.json / index.json，但不会触发 onStatsUpdate。
                        // 若确实重建了统计，主动刷新一次当前视图，避免首次打开后历史统计停留在旧值。
                        if (this.panel && Object.keys(regenerated).length > 0) {
                            void this.refreshAfterOutdatedStatsRegenerated(new Set(Object.keys(regenerated)));
                        }
                    })
                    .catch(err => StatusLogger.warn('[TokenUsagesView] Failed to regenerate outdated stats:', err));
            }
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update view:', err);
        }
    }

    /**
     * 后台重建过期统计后刷新当前视图。
     * 若当前正在查看的日期刚被重建，需要刷新右侧详情；否则只刷新左侧日期列表。
     */
    private async refreshAfterOutdatedStatsRegenerated(regeneratedDates: Set<string>): Promise<void> {
        if (!this.panel) {
            return;
        }

        const today = getTodayDateString();
        const selectedDate = this.currentSelectedDate || today;
        if (regeneratedDates.has(selectedDate)) {
            await this.updateDateDetails(selectedDate);
        }
        await this.updateDateListOnly();
    }

    /**
     * 智能刷新 - 数据变更时通知页面更新（带防抖 + 去重）
     *
     * 防抖理由：recordEstimatedTokens 和 updateActualTokens 都会触发 notifyUpdate，
     * 短时间内多次刷新会并发读到不一致中间状态（estimated 写入但 completed 未写入等），
     * 且后发的可能先到 webview 造成闪烁/错乱。
     * 合并为 50ms 窗口内的一次刷新，确保读到一致状态。
     * 执行期间若有新请求，会在当前完成后再刷一次（避免漏掉最新数据）。
     */
    private smartRefresh(): void {
        // 已有待执行的任务（在防抖窗口内），新请求会被它覆盖，无需再加
        if (this.smartRefreshTimer) {
            return;
        }
        this.smartRefreshTimer = setTimeout(() => {
            this.smartRefreshTimer = null;
            void this.runSmartRefresh();
        }, 50);
    }

    private async runSmartRefresh(): Promise<void> {
        // 已有刷新在执行：标记需要在完成后追加一次
        if (this.smartRefreshInFlight) {
            this.smartRefreshPending = true;
            return;
        }
        this.smartRefreshInFlight = this.doSmartRefresh();
        try {
            await this.smartRefreshInFlight;
        } finally {
            this.smartRefreshInFlight = null;
            // 执行期间有新请求到来，再刷一次
            if (this.smartRefreshPending) {
                this.smartRefreshPending = false;
                void this.runSmartRefresh();
            }
        }
    }

    private async doSmartRefresh(): Promise<void> {
        if (!this.panel) {
            return;
        }

        const today = getTodayDateString();
        const isViewingToday = this.currentSelectedDate === today;

        if (isViewingToday) {
            StatusLogger.debug("[TokenUsagesView] Refreshing today's details + date list");
            // 顺序执行：updateDateDetails 内部 getDateStatsFromFile 会触发 saveDateStats →
            // indexManager.updateIndex 更新日期索引；先完成详情刷新，updateDateListOnly 才能读到最新索引，
            // 避免左侧日期列表统计比右侧详情慢一拍。
            await this.updateDateDetails(today);
            await this.updateDateListOnly();
        } else {
            StatusLogger.debug('[TokenUsagesView] Refreshing date list only');
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
            const today = getTodayDateString();
            // 直接发送原始数据，让组件自己处理格式化
            this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateSummaries,
                selectedDate: this.currentSelectedDate || today,
                today
            } as UpdateDateListMessage);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update date list:', err);
        }
    }

    /**
     * 发送初始数据给 WebView
     */
    private async sendInitialData(): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            const today = getTodayDateString();
            const displayDate = today;

            // 先获取选中日期的详细数据：getDateStatsFromFile 可能触发 stats.json / index.json 更新。
            // 完成后再读取日期摘要，确保初始左侧日期列表和右侧详情口径一致。
            const dateStats = await this.usagesManager.getDateStatsFromFile(displayDate);
            const [dateSummaries, dateRecords] = await Promise.all([
                this.usagesManager.getAllDateSummaries(),
                this.usagesManager.getDateRecords(displayDate)
            ]);

            // 转换 providers 为数组，同时添加 providerKey 字段（因为 Object.values 会丢失 key）
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // 更新当前状态
            this.currentSelectedDate = displayDate;

            // 发送日期列表（直接发送原始数据，全量）
            await this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateSummaries,
                selectedDate: displayDate,
                today
            } as UpdateDateListMessage);

            // 发送日期详情（直接发送原始数据）
            await this.panel.webview.postMessage({
                command: 'updateDateDetails',
                date: displayDate,
                isToday: displayDate === today,
                providers: providers,
                hourlyStats: dateStats.hourly || {},
                records: dateRecords // getDateRecords 已经返回扩展后的记录
            } as UpdateDateDetailsMessage);

            StatusLogger.debug('[TokenUsagesView] Initial data sent');
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to send initial data:', err);
        }
    }

    /**
     * 处理来自 WebView 的消息
     */
    private async handleMessage(message: WebViewMessage): Promise<void> {
        switch (message.command) {
            case 'getInitialData':
                await this.sendInitialData();
                this.pushActiveLiveMetricsSnapshot();
                break;

            case 'selectDate':
                await this.updateDateDetails(message.date);
                this.pushActiveLiveMetricsSnapshot();
                break;

            case 'openStorageDir':
                await this.openStorageDir();
                break;

            case 'openMultiDayTrend':
                this.showMultiDayTrend();
                break;
        }
    }

    /**
     * 统一处理实时流式指标事件：转发给 WebView，并在请求开始/结束时立即刷新请求记录
     */
    private handleLiveMetricsEvent(event: LiveStreamMetricEvent): void {
        if (!this.shouldForwardLiveMetrics()) {
            return;
        }
        this.postLiveMetricEvent(event);
        if (event.type === 'requestStarted' || event.type === 'streamEnd') {
            this.smartRefresh();
        }
    }

    /**
     * 判断是否应转发实时流式指标给 WebView（面板已打开且正在查看今天）
     */
    private shouldForwardLiveMetrics(): boolean {
        return !!this.panel && this.currentSelectedDate === getTodayDateString();
    }

    /**
     * 将单个实时流式指标事件发送给 WebView
     */
    private postLiveMetricEvent(event: LiveStreamMetricEvent): void {
        const panel = this.panel;
        if (!panel) {
            return;
        }

        try {
            void panel.webview
                .postMessage({
                    command: 'updateLiveMetrics',
                    event
                } as UpdateLiveMetricsMessage)
                .then(
                    delivered => {
                        if (!delivered) {
                            StatusLogger.trace('[TokenUsagesView] live metric message dropped');
                        }
                    },
                    err => {
                        StatusLogger.warn('[TokenUsagesView] failed to post live metric message:', err);
                    }
                );
        } catch (err) {
            StatusLogger.warn('[TokenUsagesView] failed to post live metric message:', err);
        }
    }

    /**
     * 推送当前活跃请求的最新事件快照给 WebView。
     * 用于面板打开（getInitialData）和日期切换（selectDate）后补发实时状态。
     */
    private pushActiveLiveMetricsSnapshot(): void {
        if (!this.shouldForwardLiveMetrics()) {
            return;
        }
        for (const event of getActiveMetricsSnapshot()) {
            this.postLiveMetricEvent(event);
        }
    }

    /**
     * 打开多日消耗分析 WebView
     */
    private multiDayView: MultiDayView | undefined;
    private showMultiDayTrend(): void {
        if (!this.multiDayView) {
            this.multiDayView = new MultiDayView(this.context);
        }
        this.multiDayView.show();
    }

    /**
     * 更新日期详情（动态更新）
     */
    private async updateDateDetails(date: string): Promise<void> {
        try {
            const today = getTodayDateString();

            // 并行读取 stats 和 records（两者无依赖），一次性发送避免闪屏
            const [dateStats, dateRecords] = await Promise.all([
                this.usagesManager.getDateStatsFromFile(date),
                this.usagesManager.getDateRecords(date)
            ]);

            // 转换 providers 为数组，同时添加 providerKey 字段（因为 Object.values 会丢失 key）
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // 更新当前状态
            this.currentSelectedDate = date;

            // 更新面板标题
            if (this.panel) {
                this.panel.title = `${t('GCMP Token Usage', 'GCMP Token 消耗统计')} - ${date}`;
            }

            // 发送消息给 WebView，让它更新详情区域
            if (this.panel) {
                await this.panel.webview.postMessage({
                    command: 'updateDateDetails',
                    date,
                    isToday: date === today,
                    providers,
                    hourlyStats: dateStats.hourly || {},
                    records: dateRecords
                } as UpdateDateDetailsMessage);
            }

            StatusLogger.debug(`[TokenUsagesView] Updated date details: ${date}, recordCount=${dateRecords.length}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update date details:', err);
        }
    }

    /**
     * 打开存储目录
     */
    private async openStorageDir(): Promise<void> {
        try {
            const storageDir = this.usagesManager.getStorageDir();
            await vscode.env.openExternal(vscode.Uri.file(storageDir));
            StatusLogger.debug(`[TokenUsagesView] Opened storage directory: ${storageDir}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to open storage directory:', err);
            vscode.window.showErrorMessage(t('Failed to open the storage directory.', '打开存储目录失败'));
        }
    }

    /**
     * 生成 WebView HTML 内容
     */
    private getWebviewContent(): string {
        const cspSource = this.panel?.webview.cspSource || '';
        const htmlLang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

        // 读取编译后的应用 JS 文件（已包含框架和应用代码）
        const usagesViewJsPath = path.join(this.context.extensionPath, 'dist', 'ui', 'usagesView.js');
        let usagesViewJs = '';
        try {
            usagesViewJs = fs.readFileSync(usagesViewJsPath, 'utf8');
        } catch (error) {
            StatusLogger.error('[TokenUsagesView] Failed to load usagesView.js:', error);
            usagesViewJs = '/* Error loading usagesView.js */';
        }

        const htmlContent = `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('GCMP Token Usage', 'GCMP Token 消耗统计')}</title>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
</head>
<body>
	<div id="app"></div>
	<script>
		// 注入 VSCode API（必须在其他脚本之前）
		const vscode = acquireVsCodeApi();
		window.vscode = vscode;

		// 加载应用（IIFE，已包含框架和应用代码）
		${usagesViewJs}
	</script>
</body>
</html>`;

        return htmlContent;
    }

    /**
     * 销毁视图
     */
    dispose(): void {
        if (this.smartRefreshTimer) {
            clearTimeout(this.smartRefreshTimer);
            this.smartRefreshTimer = null;
        }
        this.updateDisposable?.dispose();
        this.panel?.dispose();
        this.multiDayView?.dispose();
        this.multiDayView = undefined;
    }
}
