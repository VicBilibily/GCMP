/*---------------------------------------------------------------------------------------------
 *  Token Usages View
 *  Token 用量详细视图
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsagesManager } from '../../usages/usagesManager';
import { StatusLogger } from '../../utils/runtime/statusLogger';
import { t } from '../../utils/runtime/l10n';
import {
    DetailLoadErrorMessage,
    RecordsPageMessage,
    TrackRecordsMessage,
    UpdateDateDetailsMessage,
    UpdateDateListMessage,
    UpdateLiveMetricsMessage
} from './types';
import type { ExtendedTokenRequestLog, WebViewMessage } from './types';
import { getTodayDateString } from './utils';
import {
    buildNativeCostSplitIndex,
    buildRequestTotals,
    buildSessionGroupSummaries,
    filterRecordsBySession,
    sliceRecordsPage,
    sortRecordsByTimestampDesc,
    summarizeSessionRecords,
    summarizeSessionRecoveryDebugInfo
} from './aggregation';
import { MultiDayView } from '../multiDayView';
import { onLiveMetrics, getActiveMetricsSnapshot, type LiveStreamMetricEvent } from '../../handlers/liveMetrics';
import { InterInstanceBus } from '../../interInstance';
import type { LiveMetricsUpdatedEvent } from '../../interInstance';

/** 明细分页大小（与前端 requestRecords PAGE_SIZE 保持一致） */
const PAGE_SIZE = 20;

/**
 * Token 用量 WebView 视图
 */
export class TokenUsagesView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private crossInstanceUsageUpdateDisposable: vscode.Disposable | undefined;
    private liveMetricsDisposable: vscode.Disposable | undefined;
    private crossInstanceLiveMetricsDisposable: vscode.Disposable | undefined;
    private currentSelectedDate: string | undefined; // 当前查看的日期
    private hasCheckedOutdatedStats: boolean = false; // 是否已检查过过期统计
    // smartRefresh 防抖：合并短时间内的多次刷新请求，避免并发读到不一致中间状态
    private smartRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    private smartRefreshInFlight: Promise<void> | null = null;
    private smartRefreshPending: boolean = false; // 执行期间又有新请求，需再刷一次
    // 单槽明细缓存：聚合与页拉取共用，避免翻页/重拉反复读盘
    private detailsCache: { date: string; records: ExtendedTokenRequestLog[]; seq: number } | null = null;
    // 摘要单调递增序列号，随每次摘要推送递增，页响应携带用于前端防竞态
    private detailSeq: number = 0;

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

        // 监听来自其他实例的统计更新事件，确保 Follower 打开的视图也能刷新今日/日期列表
        this.crossInstanceUsageUpdateDisposable = InterInstanceBus.subscribe('tokenUsageUpdated', () => {
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
            this.crossInstanceUsageUpdateDisposable?.dispose();
            this.crossInstanceUsageUpdateDisposable = undefined;
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
     * 先推送详情摘要（stats 更新先行），再推日期列表，保证两侧口径一致。
     */
    private async sendInitialData(): Promise<void> {
        if (!this.panel) {
            return;
        }

        try {
            const displayDate = getTodayDateString();
            this.currentSelectedDate = displayDate;
            await this.updateDateDetails(displayDate);
            await this.updateDateListOnly();
            StatusLogger.debug('[TokenUsagesView] Initial data sent');
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to send initial data:', err);
        }
    }

    /**
     * 读取当日最新记录并刷新单槽明细缓存（摘要聚合时调用，保证读到最新落盘数据）
     */
    private async readDateRecordsFresh(date: string): Promise<ExtendedTokenRequestLog[]> {
        const records = await this.usagesManager.getDateRecords(date);
        this.detailsCache = { date, records, seq: this.detailSeq };
        return records;
    }

    /**
     * 读取当日记录（页拉取用，命中缓存避免翻页/重拉反复读盘）
     */
    private async readDateRecordsCached(date: string): Promise<ExtendedTokenRequestLog[]> {
        if (this.detailsCache?.date === date) {
            return this.detailsCache.records;
        }
        return this.readDateRecordsFresh(date);
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

            case 'getRecordsPage':
                await this.handleGetRecordsPage(message);
                break;

            case 'getTrackRecords':
                await this.handleGetTrackRecords(message);
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
     * 聚合在扩展侧执行，WebView 只接收轻量摘要；明细由 WebView 按需拉取。
     */
    private async updateDateDetails(date: string): Promise<void> {
        try {
            const today = getTodayDateString();

            // 并行读取 stats 和 records（两者无依赖）；聚合必须读到最新记录，不走缓存
            const [dateStats, dateRecords] = await Promise.all([
                this.usagesManager.getDateStatsFromFile(date),
                this.readDateRecordsFresh(date)
            ]);

            // 聚合计算（与旧前端逻辑一致的口径）
            this.detailSeq += 1;
            this.detailsCache = { date, records: dateRecords, seq: this.detailSeq };
            const sessionGroups = buildSessionGroupSummaries(dateRecords);
            const allSummary = summarizeSessionRecords(dateRecords);
            const allTotals = buildRequestTotals(dateRecords);
            const nativeSplitIndex = buildNativeCostSplitIndex(dateRecords);

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

            // 推送聚合摘要给 WebView
            if (this.panel) {
                await this.panel.webview.postMessage({
                    command: 'updateDateDetails',
                    date,
                    isToday: date === today,
                    isExtensionHostDebugMode: this.context.extensionMode === vscode.ExtensionMode.Development,
                    providers,
                    hourlyStats: dateStats.hourly || {},
                    allSummary,
                    allTotals,
                    nativeSplitIndex,
                    sessionGroups,
                    updateSeq: this.detailSeq
                } as UpdateDateDetailsMessage);
            }

            StatusLogger.debug(`[TokenUsagesView] Updated date details: ${date}, recordCount=${dateRecords.length}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to update date details:', err);
        }
    }

    /**
     * 处理明细分页拉取请求：从缓存切片并返回当前页（附 updateSeq 供前端防竞态）
     */
    private async handleGetRecordsPage(message: Extract<WebViewMessage, { command: 'getRecordsPage' }>): Promise<void> {
        const panel = this.panel;
        if (!panel) {
            return;
        }

        try {
            const records = await this.readDateRecordsCached(message.date);
            const pageSize = message.pageSize ?? PAGE_SIZE;
            // session 模式必须携带 sessionId，缺失时退化为 all，避免响应语义错位
            const effectiveMode = message.mode === 'session' && !message.sessionId ? 'all' : message.mode;
            const source = effectiveMode === 'session' ? filterRecordsBySession(records, message.sessionId!) : records;
            const { records: pageRecords, totalItems } = sliceRecordsPage(source, message.page, pageSize);

            await panel.webview.postMessage({
                command: 'recordsPage',
                date: message.date,
                mode: effectiveMode,
                sessionId: effectiveMode === 'session' ? message.sessionId : undefined,
                page: message.page,
                pageSize,
                totalItems,
                records: pageRecords,
                summary: summarizeSessionRecords(source),
                totals: buildRequestTotals(source),
                recoveryDebug: summarizeSessionRecoveryDebugInfo(source),
                updateSeq: this.detailSeq
            } as RecordsPageMessage);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to get records page:', err);
            await panel.webview.postMessage({
                command: 'detailLoadError',
                date: message.date,
                mode: message.mode === 'session' && message.sessionId ? 'session' : 'all',
                sessionId: message.sessionId,
                page: message.page,
                updateSeq: this.detailSeq
            } as DetailLoadErrorMessage);
        }
    }

    /**
     * 处理多选跟踪明细请求：返回每个会话最新的 limitPerSession 条记录
     */
    private async handleGetTrackRecords(
        message: Extract<WebViewMessage, { command: 'getTrackRecords' }>
    ): Promise<void> {
        const panel = this.panel;
        if (!panel) {
            return;
        }

        try {
            const records = await this.readDateRecordsCached(message.date);
            const groups = message.sessionIds.map(sessionId => ({
                sessionId,
                records: sortRecordsByTimestampDesc(filterRecordsBySession(records, sessionId)).slice(
                    0,
                    message.limitPerSession
                )
            }));

            await panel.webview.postMessage({
                command: 'trackRecords',
                date: message.date,
                updateSeq: this.detailSeq,
                groups
            } as TrackRecordsMessage);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] Failed to get track records:', err);
            await panel.webview.postMessage({
                command: 'detailLoadError',
                date: message.date,
                mode: 'track',
                sessionIds: message.sessionIds,
                updateSeq: this.detailSeq
            } as DetailLoadErrorMessage);
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
        // 释放明细缓存与序列号，避免面板重开后读到旧日期残留数据
        this.detailsCache = null;
        this.detailSeq = 0;
    }
}
