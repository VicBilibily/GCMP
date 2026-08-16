/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - WebView HTML 模板构造
 *  从 index.ts 抽出：读取打包后的 JS、拼接 CSP、组装最终 HTML 字符串。
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../utils/runtime/logger';
import { t } from '../../utils/runtime/l10n';

/**
 * 读取打包后的前端入口 JS 并拼装出 Webview HTML
 * @param webview 当前 Webview 实例（用于 cspSource）
 * @param extensionPath 扩展根目录，定位 dist/ui/configSetManager.js
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionPath: string): string {
    const cspSource = webview.cspSource;
    const jsPath = path.join(extensionPath, 'dist', 'ui', 'configSetManager.js');
    let js = '';
    try {
        js = fs.readFileSync(jsPath, 'utf8');
    } catch (error) {
        Logger.error('[ConfigSetManager] Failed to load configSetManager.js:', error);
        js = '/* Error loading */';
    }
    const htmlLang = vscode.env.language || 'en';
    return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${t('Manage API Keys', 'API Key 管理')}</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
</head>
<body>
    <div id="app"><div class="csp-loading">${t('Loading...', '加载中...')}</div></div>
    <script>
        const vscode = acquireVsCodeApi();
        window.vscode = vscode;
        ${js}
    </script>
</body>
</html>`;
}
