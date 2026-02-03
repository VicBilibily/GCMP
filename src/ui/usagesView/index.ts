/*---------------------------------------------------------------------------------------------
 *  Token Usages View
 *  Token 用量详细视图
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsagesManager } from '../../usages/usagesManager';
import { StatusLogger } from '../../utils/statusLogger';
import { UpdateDateDetailsMessage, UpdateDateListMessage } from './types';
import { getTodayDateString } from './utils';

/**
 * WebView 消息类型定义
 */
type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'refresh'; date?: string }
    | { command: 'selectDate'; date: string }
    | { command: 'openStorageDir' };

/**
 * Token 用量 WebView 视图
 */
export class TokenUsagesView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    private updateDisposable: vscode.Disposable | undefined;
    private currentSelectedDate: string | undefined; // 当前查看的日期
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
        const today = getTodayDateString();
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
    private async updateView(selectedDate?: string): Promise<void> {
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
            await this.usagesManager.getAllDateSummaries();

            // 确定要显示的日期（默认为今日）
            const today = getTodayDateString();
            const displayDate = selectedDate || today;

            // 记录当前查看的日期
            this.currentSelectedDate = displayDate;

            this.panel.webview.html = this.getWebviewContent();
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] 更新视图失败:', err);
        }
    }

    /**
     * 智能刷新 - 数据变更时总是通知页面更新
     * - 如果正在查看今日：刷新整个详情（包括请求记录）+ 更新日期列表
     * - 如果正在查看其他日期：只刷新左侧日期列表的统计数字
     */
    private async smartRefresh(): Promise<void> {
        if (!this.panel) {
            return;
        }

        const today = getTodayDateString();
        const isViewingToday = this.currentSelectedDate === today;

        StatusLogger.debug(
            `[TokenUsagesView] 智能刷新: 查看日期=${this.currentSelectedDate}, 今日=${today}, 是否查看今日=${isViewingToday}`
        );

        if (isViewingToday) {
            // 查看今日 - 刷新整个详情（包括请求记录）+ 更新日期列表
            StatusLogger.debug('[TokenUsagesView] 刷新今日详情 + 日期列表');
            await this.updateDateDetails(today);
            await this.updateDateListOnly();
        } else {
            // 查看其他日期 - 只刷新日期列表统计
            StatusLogger.debug('[TokenUsagesView] 仅刷新日期列表');
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
            StatusLogger.error('[TokenUsagesView] 更新日期列表失败:', err);
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
            const dateSummaries = await this.usagesManager.getAllDateSummaries();
            const today = getTodayDateString();
            const displayDate = today;

            // 获取选中日期的详细数据
            const dateStats = await this.usagesManager.getDateStatsFromFile(displayDate);
            const dateRecords = await this.usagesManager.getDateRecords(displayDate);

            // 转换 providers 为数组，同时添加 providerKey 字段（因为 Object.values 会丢失 key）
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // 更新当前状态
            this.currentSelectedDate = displayDate;

            // 发送日期列表（直接发送原始数据，全量）
            this.panel.webview.postMessage({
                command: 'updateDateList',
                dateList: dateSummaries,
                selectedDate: displayDate,
                today
            } as UpdateDateListMessage);

            // 发送日期详情（直接发送原始数据）
            this.panel.webview.postMessage({
                command: 'updateDateDetails',
                date: displayDate,
                isToday: displayDate === today,
                providers: providers,
                hourlyStats: dateStats.hourly || {},
                records: dateRecords // getDateRecords 已经返回扩展后的记录
            } as UpdateDateDetailsMessage);

            StatusLogger.debug('[TokenUsagesView] 已发送初始数据');
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] 发送初始数据失败:', err);
        }
    }

    /**
     * 处理来自 WebView 的消息
     */
    private async handleMessage(message: WebViewMessage): Promise<void> {
        switch (message.command) {
            case 'getInitialData':
                await this.sendInitialData();
                break;

            case 'refresh':
                await this.updateView(message.date);
                break;

            case 'selectDate':
                await this.updateDateDetails(message.date);
                break;

            case 'openStorageDir':
                await this.openStorageDir();
                break;
        }
    }

    /**
     * 更新日期详情（动态更新）
     */
    private async updateDateDetails(date: string): Promise<void> {
        try {
            const today = getTodayDateString();

            // 从文件直接读取,不使用缓存
            const dateStats = await this.usagesManager.getDateStatsFromFile(date);
            const dateRecords = await this.usagesManager.getDateRecords(date);

            // 转换 providers 为数组，同时添加 providerKey 字段（因为 Object.values 会丢失 key）
            const providers = Object.entries(dateStats.providers).map(([key, value]) => ({
                ...value,
                providerKey: key
            }));

            // 更新当前状态
            this.currentSelectedDate = date;

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
                    providers: providers,
                    hourlyStats: dateStats.hourly || {},
                    records: dateRecords // getDateRecords 已经返回扩展后的记录
                } as UpdateDateDetailsMessage);
            }

            StatusLogger.debug(`[TokenUsagesView] 已更新日期详情: ${date}, 记录数=${dateRecords.length}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] 更新日期详情失败:', err);
        }
    }

    /**
     * 打开存储目录
     */
    private async openStorageDir(): Promise<void> {
        try {
            const storageDir = this.usagesManager.getStorageDir();
            await vscode.env.openExternal(vscode.Uri.file(storageDir));
            StatusLogger.debug(`[TokenUsagesView] 已打开存储目录: ${storageDir}`);
        } catch (err) {
            StatusLogger.error('[TokenUsagesView] 打开存储目录失败:', err);
            vscode.window.showErrorMessage('打开存储目录失败');
        }
    }

    /**
     * 生成 WebView HTML 内容
     */
    private getWebviewContent(): string {
        const cspSource = this.panel?.webview.cspSource || '';

        // 读取编译后的应用 JS 文件（已包含框架和应用代码）
        const usagesViewJsPath = path.join(this.context.extensionPath, 'dist', 'ui', 'usagesView.js');
        let usagesViewJs = '';
        try {
            usagesViewJs = fs.readFileSync(usagesViewJsPath, 'utf8');
        } catch (error) {
            StatusLogger.error('[TokenUsagesView] 读取 usagesView.js 失败:', error);
            usagesViewJs = '/* Error loading usagesView.js */';
        }

        const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>GCMP Token 消耗统计</title>
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
        this.updateDisposable?.dispose();
        this.panel?.dispose();
    }
}
