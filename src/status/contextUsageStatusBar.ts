/*---------------------------------------------------------------------------------------------
 *  模型上下文窗口占用情况状态栏（简化版）
 *  显示最近一次请求的模型上下文窗口占用情况，不含细分类别拆解。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StatusLogger } from '../utils/runtime/statusLogger';
import { t } from '../utils/runtime/l10n';
import { getRequestKindDisplayName, RequestKind } from '../handlers/requestClassifier';

/**
 * 模型上下文窗口占用情况状态栏
 */
export class ContextUsageStatusBar {
    private static instance: ContextUsageStatusBar | undefined;

    private statusBarItem: vscode.StatusBarItem | undefined;

    constructor() {
        ContextUsageStatusBar.instance = this;
    }

    static getInstance(): ContextUsageStatusBar | undefined {
        return ContextUsageStatusBar.instance;
    }

    async initialize(context: vscode.ExtensionContext): Promise<void> {
        this.statusBarItem = vscode.window.createStatusBarItem(
            'gcmp.statusBar.contextUsage',
            vscode.StatusBarAlignment.Right,
            12
        );
        this.statusBarItem.name = 'GCMP: Context Usage';
        this.statusBarItem.text = '$(gcmp-tokens)';
        this.statusBarItem.tooltip = this.buildTooltip({
            modelName: t('No requests yet', '暂无请求'),
            inputTokens: 0,
            maxInputTokens: 0
        });
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);
        StatusLogger.debug('[ContextUsageStatusBar] Initialization complete');
    }

    /**
     * 更新上下文占用显示
     */
    updateContextUsage(
        modelName: string,
        maxInputTokens: number,
        inputTokens: number,
        requestKind?: string,
        timestamp?: number
    ): void {
        if (!this.statusBarItem) {
            return;
        }

        const percentage = maxInputTokens > 0 ? (inputTokens / maxInputTokens) * 100 : 0;
        const icon = this.getPieChartIcon(percentage);
        this.statusBarItem.text = icon;

        this.statusBarItem.tooltip = this.buildTooltip({
            modelName,
            inputTokens,
            maxInputTokens,
            requestKind,
            timestamp
        });
        this.statusBarItem.show();
    }

    private getPieChartIcon(percentage: number): string {
        if (percentage === 0) {
            return '$(gcmp-tokens)';
        }
        if (percentage <= 25) {
            return '$(gcmp-token1)';
        }
        if (percentage <= 35) {
            return '$(gcmp-token2)';
        }
        if (percentage <= 45) {
            return '$(gcmp-token3)';
        }
        if (percentage <= 55) {
            return '$(gcmp-token4)';
        }
        if (percentage <= 65) {
            return '$(gcmp-token5)';
        }
        if (percentage <= 75) {
            return '$(gcmp-token6)';
        }
        if (percentage <= 85) {
            return '$(gcmp-token7)';
        }
        return '$(gcmp-token8)';
    }

    private formatTokens(tokens: number): string {
        if (tokens >= 1000000) {
            return (tokens / 1000000).toFixed(1) + 'M';
        }
        if (tokens >= 1000) {
            return (tokens / 1000).toFixed(1) + 'K';
        }
        return tokens.toString();
    }

    private buildTooltip(data: {
        modelName: string;
        inputTokens: number;
        maxInputTokens: number;
        requestKind?: string;
        timestamp?: number;
    }): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown(`#### ${t('Model Context Window Usage', '模型上下文窗口占用情况')}\n\n`);

        if (data.inputTokens === 0 && data.maxInputTokens === 0) {
            md.appendMarkdown(
                `💡 ${t('Shown after any GCMP model request is sent.', '发送任意 GCMP 提供的模型请求后显示')}\n`
            );
            return md;
        }

        md.appendMarkdown('\n---\n');
        md.appendMarkdown('|        |          |\n');
        md.appendMarkdown('| ------ | :------- |\n');
        if (data.requestKind) {
            md.appendMarkdown(
                `| **${t('Request Source', '请求来源')}** | ${getRequestKindDisplayName(data.requestKind as RequestKind)} |\n`
            );
        }
        if (data.timestamp) {
            const timeStr = new Date(data.timestamp).toLocaleString(
                vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
            );
            md.appendMarkdown(`| **${t('Request Time', '请求时间')}** | ${timeStr} |\n`);
        }
        md.appendMarkdown(`| **${t('Model Name', '模型名称')}** | ${data.modelName} |\n`);
        const usageStr = `${this.formatTokens(data.inputTokens)}/${this.formatTokens(data.maxInputTokens)}`;
        const pct = data.maxInputTokens > 0 ? ((data.inputTokens / data.maxInputTokens) * 100).toFixed(1) : '0';
        md.appendMarkdown(`| **${t('Usage', '占用情况')}** | **${pct}%** \t ${usageStr} |\n`);
        return md;
    }

    dispose(): void {
        this.statusBarItem?.dispose();
        ContextUsageStatusBar.instance = undefined;
    }

    async checkAndShowStatus(): Promise<void> {
        // 无额外检查逻辑
    }

    delayedUpdate(_delayMs?: number): void {
        // 不需要定时更新
    }
}
