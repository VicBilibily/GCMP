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

/**
 * 多日消耗分析 WebView
 */
export class MultiDayView {
    private panel: vscode.WebviewPanel | undefined;
    private usagesManager: TokenUsagesManager;

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

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
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
        this.panel?.dispose();
        this.panel = undefined;
    }
}
