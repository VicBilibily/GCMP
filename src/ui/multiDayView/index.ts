/*---------------------------------------------------------------------------------------------
 *  Multi-Day Trend View
 *  多日消耗分析独立 WebView
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsagesManager } from '../../usages/usagesManager';
import { StatusLogger } from '../../utils/statusLogger';
import { t } from '../../utils/l10n';
import { InterInstanceBus } from '../../interInstance';

/**
 * 多日消耗分析 WebView
 */
export class MultiDayView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;
    /** 跨实例统计更新订阅：Leader 完成委托重建后广播 tokenUsageUpdated，驱动本页静默重拉 */
    private usageUpdateSubscription: vscode.Disposable | undefined;
    private refreshDebounceTimer: NodeJS.Timeout | undefined;
    /** 统计更新事件较频繁（每次请求完成都会广播），合并为窗口末尾的一次刷新 */
    private static readonly USAGE_UPDATE_REFRESH_DEBOUNCE_MS = 5000;

    constructor(private context: vscode.ExtensionContext) {
        this.usagesManager = TokenUsagesManager.instance;
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'gcmpMultiDayTrend',
            t('Multi-Day Consumption', '多日消耗分析'),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.webview.html = this.getWebviewContent();

        this.panel.webview.onDidReceiveMessage(
            message => this.handleMessage(message),
            undefined,
            this.context.subscriptions
        );

        // 订阅跨实例统计更新：委托 Leader 重建超时后本页会先展示旧数据，
        // Leader 完成重建广播 tokenUsageUpdated 时通知 webview 按当前范围静默重拉
        this.usageUpdateSubscription = InterInstanceBus.subscribe('tokenUsageUpdated', () => {
            this.scheduleRefresh();
        });

        this.panel.onDidDispose(() => {
            this.disposeRefreshResources();
            this.panel = undefined;
        });
    }

    /**
     * 防抖调度一次后台刷新：窗口内的连续更新只触发末尾一次重拉
     */
    private scheduleRefresh(): void {
        if (!this.panel || this.refreshDebounceTimer) {
            return;
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = undefined;
            void this.panel?.webview.postMessage({ command: 'refreshMultiDayAnalysis' });
        }, MultiDayView.USAGE_UPDATE_REFRESH_DEBOUNCE_MS);
    }

    private disposeRefreshResources(): void {
        this.usageUpdateSubscription?.dispose();
        this.usageUpdateSubscription = undefined;
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = undefined;
        }
    }

    private async handleMessage(message: {
        command: string;
        dateFrom?: string;
        dateTo?: string;
        requestId?: number;
    }): Promise<void> {
        if (message.command === 'getMultiDayAnalysis' && message.dateFrom && message.dateTo) {
            const requestId = message.requestId ?? 0;
            try {
                StatusLogger.debug(`[MultiDayView] Requesting #${requestId}: ${message.dateFrom} → ${message.dateTo}`);
                const data = await this.usagesManager.getMultiDayStats(message.dateFrom, message.dateTo);
                this.panel?.webview.postMessage({
                    command: 'updateMultiDayAnalysis',
                    data,
                    requestId
                });
                StatusLogger.debug(`[MultiDayView] Done #${requestId}: ${data.dayCount} days`);
            } catch (err) {
                StatusLogger.error('[MultiDayView] Failed:', err);
                this.panel?.webview.postMessage({
                    command: 'multiDayError',
                    error: err instanceof Error ? err.message : String(err),
                    requestId
                });
            }
        }
    }

    private getWebviewContent(): string {
        const cspSource = this.panel?.webview.cspSource || '';
        const htmlLang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

        const jsPath = path.join(this.context.extensionPath, 'dist', 'ui', 'multiDayView.js');
        let js = '';
        try {
            js = fs.readFileSync(jsPath, 'utf8');
        } catch (error) {
            StatusLogger.error('[MultiDayView] Failed to load multiDayView.js:', error);
            js = '/* Error loading */';
        }

        return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Multi-Day Consumption', '多日消耗分析')}</title>
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
</head>
<body>
	<div id="app"></div>
	<script>
		const vscode = acquireVsCodeApi();
		window.vscode = vscode;
		${js}
	</script>
</body>
</html>`;
    }

    dispose(): void {
        this.disposeRefreshResources();
        this.panel?.dispose();
        this.panel = undefined;
    }
}
